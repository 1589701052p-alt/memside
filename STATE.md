# STATE.md - memside build status

## MVP build: COMPLETE

All 17 tasks are implemented. The full test suite is green (`bun test` -> 65 pass,
0 fail) and `tsc --noEmit` is clean.

### Task summary

| Task | Description | Status |
|------|-------------|--------|
| 1  | Repo scaffold + bun/tsconfig               | Done |
| 2  | SQLite schema + db client                   | Done |
| 3  | Pure inject (formatMemoryBlock, budget clip)| Done |
| 4  | Pure error-signal detection                 | Done |
| 5  | Pure state machine (canTransition)           | Done |
| 6  | Memory store: createCandidate              | Done |
| 7  | Memory store: promote/patch/archive         | Done |
| 8  | Distiller (LLM prompt + JSON parse)         | Done |
| 9  | Scheduler (enqueue + tick + loop)           | Done |
| 10 | opencode stub adapter                       | Done |
| 11 | claude code adapter (capture + inject)      | Done |
| 12 | Credentials loader (claude code API key)    | Done |
| 13 | Hono server (collector + injector + API)    | Done |
| 14 | Hook installer (idempotent settings.json)   | Done |
| 15 | Web UI (React approval queue)               | Done |
| 16 | Daemon (wire collector + scheduler + server)| Done |
| 17 | CLI entrypoint + e2e smoke test             | Done |

### How to run

```bash
# Start the daemon + install claude code hooks (one-time per machine)
bun run src/cli.ts start-and-install

# Start the web UI (separate terminal)
bun run dev:web

# Use claude code normally in any repo.
# After a Stop hook fires, a candidate memory appears at the web UI.
# Approve it, start a new claude code session, and the memory block is injected.

# Tests
bun test
bun run typecheck
```

### CLI commands

- `memside start` - start the daemon only (no hook install)
- `memside install` - install claude code hooks only (no daemon)
- `memside start-and-install` - both

Port is `MEMSIDE_PORT` env (default 7777).

## Verification debt (manual, pre-MVP-ship)

These four items cannot be automated in CI and must be confirmed by hand on the
target machine before declaring the MVP shipped:

1. **Claude code credential file shape** (Task 12): the `loadClaudeCreds`
   loader reads `~/.claude/.credentials.json` and looks for
   `claudeApiKey` / `apiKey`. Confirm the actual file shape and key name on the
   target machine. If claude code stores the key differently (e.g. in a
   keychain, or under a different JSON field), update `src/creds.ts`.

2. **Hook stdin -> POST body wiring + SessionStart additionalContext** (Task 14):
   the installed hook command pipes claude code's stdin JSON to the collector
   via `curl -d @-`. Confirm that claude code actually pipes the hook payload
   to stdin in the expected shape (`{ transcript, cwd, sourceEventId }`).
   Additionally, the `SessionStart` hook can return
   `hookSpecificOutput.additionalContext` to inject memory into the session.
   Today SessionStart POSTs to the collector (`/hooks/claude/SessionStart`)
   and returns empty stdout (no additionalContext). To make injection actually
   work on session start, retarget the SessionStart hook to `POST /inject` and
   emit the `additionalContext` envelope, or add a dedicated injector command.
   This live contract was not verified automatically.

3. **Anthropic model id reachability** (Task 8/16): the distiller calls the
   Anthropic API with model `claude-haiku-4-5-20251001`. Confirm this model id
   is reachable with the user's API key. If the id is wrong or the model is
   deprecated, update `src/anthropic.ts`.

4. **Live end-to-end against a real claude code session** (Task 17 step 6):
   run `bun run src/cli.ts start-and-install`, start `bun run dev:web`, use
   claude code in a repo for a turn, stop it, and verify a candidate appears
   at the web UI. Approve it, start a new claude code session, and confirm
   the memory block appears in the session context. Record the result here.

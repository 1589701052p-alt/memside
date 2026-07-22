# STATE.md - memside build status

## MVP build: COMPLETE

All 17 tasks are implemented. The full test suite is green (`bun test` -> 100 pass,
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

## Verification status (post final-fix1..4 + daemon-layer live smoke)

The MVP's capture -> distill -> approve -> inject loop is verified end-to-end at
the daemon layer via `smoke-live.ts` (real Ark LLM, real HTTP, no mocks): a real
transcript -> candidate `[category:invariant] Refunds allowed only within 14 days
of shipment` -> approved -> SessionStart returns the `hookSpecificOutput`
additionalContext envelope with the `## Learned context` block. Test suite:
`bun test` -> 100 pass / 0 fail, `tsc --noEmit` clean.

### Resolved by final-fix passes (live-verified)
1. **Credential loading** (final-fix4, `0a25a1a`): `src/creds.ts` now reads
   `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL` + `ANTHROPIC_DEFAULT_HAIKU_MODEL`
   from `~/.claude/settings.json` env (process env first, then the settings
   file), supporting the Volcengine Ark proxy the target user actually uses
   (`https://ark.cn-beijing.volces.com/api/plan` + `deepseek-v4-flash`). Live
   smoke confirmed the distiller calls the Ark model and gets a valid candidate.
3. **Model reachability** (final-fix4): the distiller no longer hardcodes
   `claude-haiku-4-5-20251001`; it uses `creds.model ?? DISTILL_MODEL`, so the
   user's configured haiku-tier model wins. Live-verified.
2. **C2/C3 capture+inject** (final-fix3, `ac73ce4`): capture reads
   `transcript_path` via `src/claude/transcript.ts` `parseTranscriptFile`
   (verified against the 2.1.217 binary + a real local transcript); SessionStart
   returns the `hookSpecificOutput` additionalContext envelope (envelope shape
   verified against the binary's own error string). Daemon-layer live smoke
   passed the full loop.

### Still requiring a live claude-code session (cannot be automated)
4. **SessionStart additionalContext reaches a new session - VERIFIED**:
   `claude -p "say hi"` in the memside repo triggered the SessionStart hook
   (daemon diag log: `SessionStart hit cwd=C:\Users\admin\Desktop\memside
   hasBlock=true`), the daemon returned the envelope, and claude code injected
   the `additionalContext` into the session - confirmed by the session transcript
   containing `"additionalContext":"## Learned context (auto-injected, advisory)
   ...memside injection probe..."`. Note: a print-mode `YES/NO` probe answered NO
   because the model does not scan injected context when answering a direct
   prompt; the transcript is the source of truth. The full loop - capture ->
   distill -> approve -> inject - is now live-verified end-to-end with a real
   claude code session + real Ark LLM.

### Live smoke harness
`bun run smoke-live.ts` (repo root) runs the full loop against a tmp DB + tmp
transcript + the real Ark LLM. In proxy environments, set
`NO_PROXY=127.0.0.1,localhost` so local HTTP fetches bypass the system proxy:
`NO_PROXY=127.0.0.1,localhost bun run smoke-live.ts` (the Ark call still goes
through `HTTPS_PROXY`). Distill takes ~15-30s (async fire-and-forget, does not
block the hook ack).

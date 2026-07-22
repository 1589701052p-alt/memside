# memside

A local memory sidecar for [claude code](https://claude.com/claude-code). It
watches your claude code sessions, distills the recurring lessons / mistakes /
conventions into concise memory items, lets you approve them through a web UI,
and injects the approved ones into future sessions — without blocking your work.

```
   claude code session
        │  hooks (SessionStart / Stop / PostToolUse / SubagentStop)
        ▼
   ┌───────────┐   capture    ┌──────────┐   distill    ┌──────────┐
   │ collector │ ───────────▶ │ sqlite DB │ ──────────▶ │   LLM    │
   │  (<50ms)  │   transcript │  (WAL)    │  transcript │ (haiku)  │
   └───────────┘              └──────────┘              └──────────┘
                                                          │ candidates
                                           approve        ▼
   new session ◀── additionalContext ◀── web UI  ◀── memory store
```

**Non-blocking by design.** Every hook acks in under 50ms — the transcript read,
DB write, and LLM distill all happen in a fire-and-forget background loop. If the
daemon is down, hooks time out after 2s and your session continues normally.

**You stay in control.** Nothing is injected until you approve it in the web UI.
Rejected items are never distilled again.

## What it captures

- **Conversations** — `Stop` / `SubagentStop` hooks capture the session
  transcript; the distiller extracts conventions, invariants, architecture
  decisions.
- **Errors & pitfalls** — `PostToolUse` hooks flag tool failures (`is_error`) and
  user corrections; the distiller tags these as `[category:anti-pattern]` so the
  same mistake isn't repeated.
- **Manual entries** — add a memory yourself via the API / web UI.

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.3
- claude code (the CLI)
- An LLM credential — **either**:
  - a **Volcengine Ark / other Anthropic-compatible proxy** configured in
    `~/.claude/settings.json` (`ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL` +
    `ANTHROPIC_DEFAULT_HAIKU_MODEL`), **or**
  - an official **Anthropic API key** in `ANTHROPIC_API_KEY` (the distiller then
    calls `api.anthropic.com` with `claude-haiku-4-5-20251001`).

memside reads claude code's own settings, so if claude code works, the distiller
works with the same credential.

## Quick start

```bash
git clone <this-repo> memside && cd memside
bun install

# 1. Start the daemon AND install the claude code hooks (one-time per machine)
bun run src/cli.ts start-and-install

# 2. Run the functional demo (verifies the whole loop with the real LLM)
NO_PROXY=127.0.0.1,localhost bun run demo.ts

# 3. Start the approval web UI (separate terminal)
bun run dev:web   # → http://localhost:5173
```

If the demo prints `9/9 steps passed`, memside is fully wired up.

### A note on proxies

If you're behind a system proxy (`HTTP_PROXY` / `HTTPS_PROXY` set, e.g. a clash /
v2ray on `:7897`), the installed hook commands already include
`--noproxy 127.0.0.1,localhost` so the loopback hook calls bypass the proxy
automatically. You only need `NO_PROXY=127.0.0.1,localhost` when running the
demo / `smoke-live.ts` / manual `curl` against the daemon, because those use
Bun's `fetch` (which honors the proxy env). The distill LLM call still goes
through `HTTPS_PROXY` as needed.

## Daily use

1. **Use claude code normally** in any repo. When a session stops, a `Stop` hook
   fires → the transcript is captured and distilled in the background. Tool
   failures fire `PostToolUse` → error-signal capture.
2. **Review candidates** at the web UI (`bun run dev:web` → `http://localhost:5173`).
   Approve the ones worth keeping, reject the noise, edit titles / bodies.
3. **Start your next session** — `SessionStart` fires → approved memories for the
   current project (plus globals) are injected as `additionalContext`. You'll see
   a `## Learned context (auto-injected, advisory)` block prepended to the
   session.

Approved memories are scoped:
- **project** — tied to a cwd, only injected in that project.
- **global** — injected in every session.

## Configuration

| env / source | default | purpose |
|---|---|---|
| `MEMSIDE_PORT` | `7777` | daemon HTTP port (hooks + web UI proxy target) |
| `~/.claude/settings.json` `env` | — | `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL` / `ANTHROPIC_DEFAULT_HAIKU_MODEL` (proxy mode) |
| `ANTHROPIC_API_KEY` | — | official Anthropic key (takes precedence over settings.json) |
| `~/.memside/memside.db` | — | the memory database (WAL mode) |
| `~/.claude/settings.json` `hooks` | — | where the four collector hooks are installed |

### CLI commands

```bash
memside start             # launch the daemon only (no hook install)
memside install           # install claude code hooks only (no daemon)
memside start-and-install # both
```

(`bun run src/cli.ts <cmd>` works the same if you haven't `bun link`ed it.)

## Demo

`demo.ts` runs the full feature matrix against a **throwaway tmp DB** + your real
LLM — it never touches `~/.memside/memside.db`:

```bash
NO_PROXY=127.0.0.1,localhost bun run demo.ts
```

It covers: conversation capture → error-signal capture → distill → list →
approve → reject → edit (PATCH) → inject (SessionStart envelope) → manual
candidate → global-scope injection. Expected: `9/9 steps passed` in ~1-2 min
(most of it is the LLM distill round-trip).

There's also `smoke-live.ts` — a narrower end-to-end smoke (capture → distill →
approve → inject) you can use as a quicker health check.

## Troubleshooting

**`502 Bad Gateway` from hooks / demo.** Your system proxy is intercepting the
loopback call. The installed hooks already bypass it (`--noproxy`); for the demo
or manual `curl`, prefix `NO_PROXY=127.0.0.1,localhost`.

**Sessions feel slow / laggy.** The daemon isn't running, so each hook hits the
2s `--max-time` timeout. Start it: `bun run src/cli.ts start` (or
`start-and-install`). Check it's up: `curl -s http://127.0.0.1:7777/api/memories`.

**No candidates appear.** The distiller can't reach the LLM. Check
`~/.memside/memside.db` → `memory_distill_jobs.last_error`, and confirm your
credential works (`claude code` itself working is a good sign). Common cause: the
`ANTHROPIC_DEFAULT_HAIKU_MODEL` id isn't reachable on your proxy — point it at a
haiku-tier model your proxy supports.

**A memory I rejected came back.** It shouldn't — rejected items stay rejected.
If you see it, file an issue; the dedup is keyed on distilled content.

**Stale daemon process after stopping the task.** On Windows, killing the
background task may leave the bun process alive on port 7777. Reclaim it:
`netstat -ano | findstr :7777` → `taskkill //PID <pid> //F`.

## Development

```bash
bun test              # 100 tests
bun run typecheck     # tsc --noEmit
bun run dev:web       # vite dev server (5173, proxies to :7777)
```

The codebase is TDD-driven; every fix carries a regression test. See `STATE.md`
for build status and `design/` (in the upstream agent-workflow repo) for the
design lineage — memside borrows its storage, distiller, and approval state
machine from that project's RFC-041.

## Known limitations (MVP)

- **claude code only.** The opencode adapter is a stub (`src/adapter/opencode.ts`);
  opencode's hook / injection surface wasn't wired up for the MVP.
- **No archive / unarchive UI yet.** The store implements `archiveMemory` /
  `unarchiveMemory` (and they're unit-tested), but no HTTP route or web UI button
  exposes them. Approved memories can be rejected-edited but not archived from
  the UI. Use the store API directly if you need it.
- **No live WS push.** The web UI polls `/api/memories`; a `/ws/memories` broadcast
  seam is in place but not wired.
- **Single user, local.** No auth, no multi-user — memside runs on your machine
  for your claude code sessions.
- **Injection is advisory.** The block is prepended as soft context; the model
  may not always surface it in its reply (verified present in the session
  transcript regardless).

## How it works under the hood

- **Capture.** claude code pipes each hook's JSON payload (including
  `transcript_path`, a JSONL file path) to the collector via `curl -d @-`.
  `src/claude/transcript.ts` parses the JSONL into structured turns (user
  prompts, assistant text, tool results with `is_error`). The collector acks 202
  immediately and persists the turns to `memory_distill_events` in a
  fire-and-forget IIFE.
- **Distill.** A 1Hz scheduler tick (`src/scheduler.ts`) picks pending jobs,
  loads the stored turns, and calls the LLM with a category-aware system prompt
  (`src/memory/distiller.ts`). The JSON response becomes a `candidate` memory.
  Debounce (5s) + exponential backoff handle bursts and transient LLM failures.
- **Approve.** The web UI hits `POST /api/memories/:id/promote` with
  `{action:'approve'|'reject'|'approve_and_supersede'}`. State transitions are
  guarded by specific-source checks (not the general `canTransition`) so an
  archived memory can't be silently re-approved.
- **Inject.** `SessionStart` calls `adapter.inject({cwd})`, which queries approved
  memories by project + runtime, clips to a token budget (project 1500 / global
  500), renders the markdown block, and returns it wrapped in
  `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":...}}`
  — the envelope claude code reads from the hook's stdout.

## License

Private / WIP.

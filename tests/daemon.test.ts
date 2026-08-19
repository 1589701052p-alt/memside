import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { openDb } from '@/db/client'
import { enqueueDistillJob } from '@/scheduler'
import { runDistillOnce, sweepStuckRunning, makeLoadTranscript } from '@/daemon'
import { memoryDistillJobs, memoryDistillEvents, memorySessionOffsets } from '@/db/schema'
import { saveUiLlmConfig, type UiLlmConfig } from '@/settings'

// EBUSY-safe pattern (same as scheduler.test.ts / server.test.ts): wipe `root`
// once in beforeAll, give each test its own fresh subdir, and close the raw
// bun:sqlite handle in afterEach. The brief's bare `rmSync(tmp)` in beforeEach
// throws EBUSY on Windows because the previous test's Database (plus -wal/-shm
// sidecars) is still locked. Fresh subdirs mean we never delete a dir holding
// an open handle.
const root = join(import.meta.dir, '.tmp-daemon')
let dir = ''
let db: ReturnType<typeof openDb>

beforeAll(() => {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
})

beforeEach(() => {
  dir = join(root, Math.random().toString(36).slice(2))
  mkdirSync(dir, { recursive: true })
  db = openDb(join(dir, 't.db'))
})

afterEach(() => {
  db.$client.close()
})

/**
 * Task 16 integration capstone: locks in the wiring that `runDistillOnce`
 * composes `loadTranscript` (reads `memoryDistillEvents` rows + parses JSON
 * payload into TranscriptTurn[]) + `callLLM` + `createCandidate` and
 * drives `tick` to mark a job `done`.
 *
 * The Anthropic call + creds are mocked so this never touches the network.
 */
test('runDistillOnce wires loadTranscript + callLLM + createCandidate end-to-end (mocked)', async () => {
  const { jobId } = await enqueueDistillJob(db, {
    sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k', debounceMs: 0,
  })
  // force due (enqueueDistillJob set nextRunAt = now + 0 = now, but tick's
  // pending+lte(now) select is time-sensitive on Windows CI; pin to 0 to be safe)
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  // seed a distill event the loader reads. The brief used the unsupported
  // `db.insert({table:...})` shorthand; we use the Drizzle query builder.
  await db.insert(memoryDistillEvents).values({
    distillJobId: jobId, attemptIndex: 0, ts: 1, kind: 'conversation',
    payload: JSON.stringify([{ role: 'user', content: 'refund 14 days' }]),
  })
  await runDistillOnce(db, {
    loadClaudeCreds: () => ({ apiKey: 'sk-test', source: 'test' }),
    // Task 7：judge 失败即 step 失败（回 pending），成功路径按 system 分派。
    callLLM: async (sys: string) => {
      if (sys.includes('memside-distiller')) return JSON.stringify({
        candidates: [{ title: '[category:invariant] refund 14d', bodyMd: '14 days', scope: 'project', runtime: null, distillAction: 'new' }],
      })
      return JSON.stringify({ verdicts: [{ index: 0, category: 'decision' }] })
    },
  })
  const rows = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, jobId))
  expect(rows[0]!.status).toBe('done')
})

/**
 * Task 4 接线回归（feat/llm-settings-ui）：daemon 的 `resolveCallLLM` 必须把
 * db-backed `loadUiConfig` 接进 anthropic 链——UI 设置页写入的凭证要真正到达
 * `loadClaudeCreds(uiConfig)`。若 daemon 漏传 db 第二参，捕获值是 undefined，
 * 本用例变红。
 *
 * 注入的 loadClaudeCreds 返回空 apiKey：makeLLMCall 在构造 SDK client 前抛
 * "no claude credentials"，distillTranscript 内部降级（llm_error），全程零网络。
 */
test('runDistillOnce 的 anthropic 链带 db-backed loadUiConfig（UI 配置进 distill 链路）', async () => {
  // 钉住 anthropic 后端：测试环境若意外有 OPENAI_API_KEY 会走 openai 分支，
  // loadUiConfig 不会出现在该链路上，断言失真。用后恢复原值。
  const prevBackend = process.env.MEMSIDE_LLM_BACKEND
  process.env.MEMSIDE_LLM_BACKEND = 'anthropic'
  try {
    saveUiLlmConfig(db, { token: 'sk-ui-captured-token' })
    const { jobId } = await enqueueDistillJob(db, {
      sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k', debounceMs: 0,
    })
    await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
    await db.insert(memoryDistillEvents).values({
      distillJobId: jobId, attemptIndex: 0, ts: 1, kind: 'conversation',
      payload: JSON.stringify([{ role: 'user', content: 'refund 14 days' }]),
    })
    let captured: UiLlmConfig | null | undefined
    await runDistillOnce(db, {
      loadClaudeCreds: (uiConfig?: UiLlmConfig | null) => {
        captured = uiConfig
        return { apiKey: null, source: 'test' }
      },
    })
    expect(captured).toEqual({ token: 'sk-ui-captured-token' })
  } finally {
    if (prevBackend === undefined) delete process.env.MEMSIDE_LLM_BACKEND
    else process.env.MEMSIDE_LLM_BACKEND = prevBackend
  }
})

/**
 * Daemon-startup hardening (flagged in Task 9's review): a crashed daemon must
 * not leave `memory_distill_jobs` rows stuck in `status='running'` forever.
 * `sweepStuckRunning` resets them to `pending` with `nextRunAt=now` so the
 * scheduler picks them up on the next tick.
 */
test('sweepStuckRunning resets running jobs back to pending with nextRunAt=now', async () => {
  const { jobId } = await enqueueDistillJob(db, {
    sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k', debounceMs: 0,
  })
  // simulate a crashed-mid-run daemon: status=running, stale nextRunAt
  await db.update(memoryDistillJobs).set({ status: 'running', nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  const before = Date.now()
  const swept = sweepStuckRunning(db)
  const after = Date.now()
  expect(swept).toBe(1)
  const rows = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, jobId))
  expect(rows[0]!.status).toBe('pending')
  expect(rows[0]!.nextRunAt).toBeGreaterThanOrEqual(before)
  expect(rows[0]!.nextRunAt).toBeLessThanOrEqual(after)
})

test('sweepStuckRunning leaves pending/done/failed jobs untouched', async () => {
  const { jobId: pendId } = await enqueueDistillJob(db, {
    sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0,
  })
  const { jobId: doneId } = await enqueueDistillJob(db, {
    sourceEventId: 'e2', runtime: 'claude-code', cwd: '/r', debounceKey: 'k2', debounceMs: 0,
  })
  await db.update(memoryDistillJobs).set({ status: 'done', finishedAt: 1 }).where(eq(memoryDistillJobs.id, doneId))
  const swept = sweepStuckRunning(db)
  expect(swept).toBe(0)
  const pend = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, pendId))
  const done = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, doneId))
  expect(pend[0]!.status).toBe('pending')
  expect(done[0]!.status).toBe('done')
})

// spec §动态协议派发器：UI protocol=openai 必须驱动 openai 后端（/chat/completions），
// 且 UI 协议压过 env 的 MEMSIDE_LLM_BACKEND=anthropic。mock fetch 不发真实网络。
test('resolveCallLLM: UI protocol=openai 驱动 openai 后端，压过 env', async () => {
  const prevBackend = process.env.MEMSIDE_LLM_BACKEND
  const prevKey = process.env.OPENAI_API_KEY
  const origFetch = globalThis.fetch
  process.env.MEMSIDE_LLM_BACKEND = 'anthropic' // 证明 UI 协议压过 env
  delete process.env.OPENAI_API_KEY
  const urls: string[] = []
  try {
    saveUiLlmConfig(db, {
      token: 'sk-openai-ui',
      protocol: 'openai',
      baseURL: 'https://ark.cn-beijing.volces.com/api/plan/v3',
      model: 'ark-code-latest',
    })
    const { jobId } = await enqueueDistillJob(db, {
      sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k', debounceMs: 0,
    })
    await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
    await db.insert(memoryDistillEvents).values({
      distillJobId: jobId, attemptIndex: 0, ts: 1, kind: 'conversation',
      payload: JSON.stringify([{ role: 'user', content: 'refund 14 days' }]),
    })
    globalThis.fetch = (async (input: unknown, _init?: RequestInit) => {
      urls.push(String(input))
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ candidates: [] }) } }] }), { status: 200 })
    }) as typeof fetch
    await runDistillOnce(db, {})
    expect(urls.length).toBeGreaterThan(0)
    expect(urls[0]).toBe('https://ark.cn-beijing.volces.com/api/plan/v3/chat/completions')
    expect(urls.every((u) => u.endsWith('/chat/completions'))).toBe(true)
  } finally {
    globalThis.fetch = origFetch
    if (prevBackend === undefined) delete process.env.MEMSIDE_LLM_BACKEND
    else process.env.MEMSIDE_LLM_BACKEND = prevBackend
    if (prevKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = prevKey
  }
})

test('makeLoadTranscript: subagent job (sourceAgentId) returns full turns, ignores session offset', async () => {
  // 即使 subagent job 带 sessionId + 偏移表有记录，也必须返回全量（subagent 一次性，不切片）
  const { jobId } = await enqueueDistillJob(db, {
    sourceEventId: 'sub-lt', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0,
    sessionId: 'sess-lt', sourceAgentId: 'agent-LT',
  })
  await db.insert(memoryDistillEvents).values({
    distillJobId: jobId, attemptIndex: 0, ts: 1, kind: 'conversation',
    payload: JSON.stringify([
      { role: 'user', content: 'A' }, { role: 'user', content: 'B' }, { role: 'user', content: 'C' },
    ]),
  })
  // 预置偏移 = 2（正常会 slice(2) 只给 1 turn）；subagent 必须忽略、返回全量 3
  await db.insert(memorySessionOffsets).values({ sessionId: 'sess-lt', lastTurnOffset: 2, updatedAt: Date.now() })
  const loadTranscript = makeLoadTranscript(db)
  const result = await loadTranscript({ id: jobId, cwd: '/r', sourceEventId: 'sub-lt', sessionId: 'sess-lt', sourceAgentId: 'agent-LT' })
  expect(result.turns.length).toBe(3)
  expect(result.fullLength).toBe(3)
})

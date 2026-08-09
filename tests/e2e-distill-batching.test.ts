// tests/e2e-distill-batching.test.ts
// 核心回归（spec §6.6）：一个 session 三次 Stop——前两次不足阈值零 LLM 调用零候选；
// 第三次跨阈值一次调用 + done + offset 结算正确；SessionEnd flush 尾巴再一次调用（总计第二次）。
//
// 与 task-10 brief 原文的三处有意偏差（均经前序 task 验证确立）：
// 1. openDb(':memory:') 在 bun 下 mkdirSync(dirname(':memory:')) 抛 EEXIST，
//    改用临时文件库（对齐 tests/server-distill-batching.test.ts；Windows 不 rmSync 临时目录）。
// 2. 钉经济模式（loadJudgeConfig = ECONOMY）：默认质量模式下每次成功 distill
//    （含 empty_output）会追加 mergeRollingSummary 的滚动摘要 LLM 调用，llmCalls
//    就不再是纯 distill 计数。经济模式无此追加，0/0/1/1/2 语义成立
//    （对齐 tests/scheduler-distill-batching.test.ts 的钉法）。
// 3. 尾巴内容 .repeat(20)->.repeat(100)（约 1200 字符）：flush/TTL 路径的 sweep
//    只对 < DISTILL_TRIVIAL_FLOOR_CHARS(1000) 的切片判 skipped_trivial 不调 LLM
//    （threshold.ts isTrivial，spec §4.7）；brief 原文约 240 字符会被判琐碎，
//    走不到「sweep 放行 -> 再一次调用」。1200 字符落在 [1000, 8000) 区间——
//    不足 capture 放行阈值（停 waiting）但超琐碎下限（flush 放行），正是
//    spec §6.6 要锁的尾巴语义。
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { openDb, type DbClient } from '@/db/client'
import { createApp } from '@/server'
import { tick, type TickDeps } from '@/scheduler'
import { memoryDistillJobs } from '@/db/schema'
import { createCandidate, getSessionOffset } from '@/memory/store'
import { makeLoadTranscript } from '@/daemon'
import type { JudgeConfig } from '@/memory/judgeConfig'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LLMCall } from '@/llm'

let db: DbClient
let app: ReturnType<typeof createApp>
let llmCalls: number
const llm: LLMCall = async () => { llmCalls += 1; return JSON.stringify({ candidates: [] }) }

// 钉经济模式：quality 模式会在 distill 成功后追加滚动摘要 LLM 调用（见文件头注 2）。
const ECONOMY: JudgeConfig = { mode: 'economy', maxRounds: 5, timeBudgetS: 60 }

// fixture 形状对齐 tests/server-distill-batching.test.ts（{type, message:{role, content}}，
// 经 src/claude/transcript.ts 验证），尾部换行与既有 fixture 一致。
const writeTranscript = (turns: { role: string; content: string }[]): string => {
  const dir = mkdtempSync(join(tmpdir(), 'memside-e2e-'))
  const p = join(dir, 't.jsonl')
  writeFileSync(p, turns.map((t) => JSON.stringify({ type: t.role, message: { role: t.role, content: t.content } })).join('\n') + '\n')
  return p
}

const stop = async (sessionId: string, tp: string) => {
  await app.request('/hooks/claude/Stop', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transcript_path: tp, cwd: '/proj', session_id: sessionId }),
  })
  // fire-and-forget IIFE 落盘等待（对齐 tests/server-distill-batching.test.ts 的 50ms）。
  await new Promise((r) => setTimeout(r, 50))
}

const runTick = () => tick(db, {
  loadTranscript: makeLoadTranscript(db),
  callLLM: llm,
  createCandidate,
  loadJudgeConfig: () => ECONOMY,
} satisfies TickDeps)

beforeEach(() => {
  db = openDb(join(mkdtempSync(join(tmpdir(), 'memside-e2e-db-')), 'test.db'))
  llmCalls = 0
  app = createApp({
    db,
    adapter: { inject: async () => null } as never,
    opencodeAdapter: { inject: async () => null } as never,
    // 注入 throw 是有意的：prove 主路径全程走 accumulateCapture（内部用
    // enqueueWaitingJob），不经 deps.enqueueDistillJob 这条 legacy seam。
    enqueueDistillJob: async () => { throw new Error('e2e 走 accumulateCapture，不应直接 enqueue') },
    broadcast: () => {},
  })
})

afterEach(() => {
  db.$client.close()
})

test('攒量批处理 e2e：三次 Stop + SessionEnd flush（spec §6.6）', async () => {
  const small = (n: number) => Array.from({ length: n }, (_, i) => ({ role: 'user', content: `短消息${i}` }))
  const big = () => [{ role: 'user', content: 'x'.repeat(9000) }]

  // 第 1、2 次 Stop：不足阈值 -> waiting，零 LLM 调用
  await stop('s1', writeTranscript(small(2)))
  await runTick(); expect(llmCalls).toBe(0)
  await stop('s1', writeTranscript(small(4)))
  await runTick(); expect(llmCalls).toBe(0)
  expect((await db.select().from(memoryDistillJobs)).length).toBe(1) // 不变量 A

  // 第 3 次 Stop：跨阈值（9000 >= DISTILL_RELEASE_MIN_CHARS 8000）-> 放行，
  // 一次调用，job done，offset 结算到全量 5 turn。
  await stop('s1', writeTranscript([...small(4), ...big()]))
  await runTick(); expect(llmCalls).toBe(1)
  const [job] = await db.select().from(memoryDistillJobs)
  expect(job!.status).toBe('done')
  expect(await getSessionOffset(db, 's1')).toBe(5)

  // 尾巴：新增 1 turn 约 1200 字符，不足 8000 放行阈值 -> 不放行（仍零新增调用）；
  // 但超 1000 琐碎下限 -> SessionEnd flush 后 sweep 放行，再一次调用（总计第二次）。
  await stop('s1', writeTranscript([...small(4), ...big(), { role: 'user', content: '尾巴消息，有点内容凑字数。'.repeat(100) }]))
  await runTick(); expect(llmCalls).toBe(1) // 未放行
  await app.request('/hooks/claude/SessionEnd', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: 's1', cwd: '/proj', reason: 'prompt_input_exit' }),
  })
  await new Promise((r) => setTimeout(r, 50))
  await runTick() // sweep 放行（同一 tick 内 pending 选择在其后，可直接提炼）
  await runTick() // 兜底：若实现改为次 tick 才提炼，这里接住
  expect(llmCalls).toBe(2) // flush 尾巴一次调用（总计第二次）
})

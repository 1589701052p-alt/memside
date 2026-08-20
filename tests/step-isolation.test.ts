// 锁 spec 2026-08-18 §3.2/§8.6（P4 纠正）：步骤间只传干净结果不传 LLM 对话历史。
// 去重输入=蒸馏候选清单（非蒸馏对话），审查输入=去重后清单（非去重对话）。
//
// Task 7 的步骤隔离是结构保证：每步（distill/dedup/judge/digest）走独立可接续
// 执行器，loadHistory 仅读本 step 的 llm_round（listLlmRounds(db, jobId, step)
// 按 payload.step 过滤），步骤间只传干净结果（candidates/deduped/judged）。
// 本测试注入特征串到前步的 LLM 响应文本（落盘为该 step 的 llm_round response），
// 断言后步的 llm_round request 不含该特征串。若未来 refactor 误把 A 步对话历史
// 传给 B 步，此测试即红。
import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { openDb } from '@/db/client'
import { enqueueDistillJob, tick } from '@/scheduler'
import { listLlmRounds, createCandidate as realCreateCandidate } from '@/memory/store'
import { memories, memoryDistillJobs } from '@/db/schema'
import type { LlmRoundRow } from '@/memory/store'

// 钉经济模式：judgeValue 单发 LLM（system 含 'memside-value-judge'），可控分派；
// digest 阶段经济模式平凡成功，四步链路聚焦在 distill/dedup/judge。
const ECONOMY = { mode: 'economy', maxRounds: 30, timeBudgetS: 300 } as const

// 与 tests/scheduler.test.ts 同款 harness：每用例独立子目录，避免 Windows EBUSY。
const root = join(import.meta.dir, '.tmp-step-iso')
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

/** 跑完整四步 tick（distill→dedup→judge→digest），2 候选保证 dedup 调 LLM。 */
async function runFullPipeline(
  callLLM: (sys: string, user: string) => Promise<string>,
): Promise<string> {
  const { jobId } = await enqueueDistillJob(db, {
    sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0,
    sessionId: 'sess-iso',
  })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId)).run()
  await tick(db, {
    loadTranscript: async () => ({
      turns: [{ role: 'user' as const, content: 'refund within 14 days rule' }],
      fullLength: 1, prefixTurns: [],
    }),
    callLLM,
    createCandidate: realCreateCandidate as never,
    loadJudgeConfig: () => ECONOMY,
  })
  return jobId
}

/** 断言某 step 的所有 llm_round request 不含 marker；并返回该 step 的 rounds。 */
function assertRequestExcludes(rounds: LlmRoundRow[], marker: string): void {
  for (const r of rounds) {
    expect(r.request).not.toContain(marker)
  }
}

test('dedup 收到的 prompt 不含 distill 的 LLM 对话历史', async () => {
  // 1. mock distill 返回合法 candidates + 特征文本 'DISTILL_INTERNAL_TRACE'（落盘为
  //    distill step 的 llm_round response）；dedup/judge 返回合法响应。
  // 2. 跑完四步，读 dedup step 的 llm_round，断言其 request 不含 'DISTILL_INTERNAL_TRACE'
  //    （dedup request 应只含候选清单 renderDedupUserPrompt 的输出）。
  // 3. 正向断言：marker 确实出现在 distill step 的 llm_round response 里——证明特征串
  //    真的在前步对话历史中存在，隔离测试是「有意义的锁」而非 vacuously true。
  const DISTILL_MARKER = 'DISTILL_INTERNAL_TRACE'
  const jobId = await runFullPipeline(async (sys: string) => {
    if (sys.includes('memside-distiller')) {
      // 特征串塞进 distill 的 LLM 响应文本（response 原样落盘为 distill llm_round）。
      // 放在 JSON 之外作为注释式噪声——distiller 的 extractJsonObject 会剥离它，
      // 候选正常解析；但原始 response（含 marker）落盘为 distill llm_round。
      return JSON.stringify({
        candidates: [
          { title: '[category:invariant] refund 14d', bodyMd: '14 days', scope: 'project', runtime: null, distillAction: 'new' },
          { title: '[category:invariant] refund window', bodyMd: '14d', scope: 'project', runtime: null, distillAction: 'new' },
        ],
      }) + ` /* ${DISTILL_MARKER} internal distill conversation trace */`
    }
    if (sys.includes('memside-consolidate')) {
      return JSON.stringify({ groups: [{ action: 'keep', members: ['new-0'] }, { action: 'keep', members: ['new-1'] }] })
    }
    // judge (memside-value-judge)
    return JSON.stringify({ verdicts: [{ index: 0, category: 'decision' }, { index: 1, category: 'decision' }] })
  })

  const dedupRounds = await listLlmRounds(db, jobId, 'dedup')
  expect(dedupRounds.length).toBeGreaterThan(0)  // 合并步确实调了 LLM（2 候选兄弟比较）
  assertRequestExcludes(dedupRounds, DISTILL_MARKER)

  // 正向锚：marker 确实在 distill 的 LLM 对话历史里（response 含它），证明隔离测试有意义。
  const distillRounds = await listLlmRounds(db, jobId, 'distill')
  expect(distillRounds.length).toBeGreaterThan(0)
  expect(distillRounds.some((r) => r.response.includes(DISTILL_MARKER))).toBe(true)

  // 全程完成：候选入库（隔离测试不应破坏正常流程）
  const cands = await db.select().from(memories).where(eq(memories.distillJobId, jobId)).all()
  expect(cands.length).toBe(2)
})

test('judge 收到的 prompt 不含 dedup 的 LLM 对话历史', async () => {
  // 1. mock dedup 返回合法 verdicts + 特征文本 'DEDUP_INTERNAL_TRACE'（落盘为
  //    dedup step 的 llm_round response）；distill/judge 返回合法响应。
  // 2. 跑完四步，读 judge step 的 llm_round，断言其 request 不含 'DEDUP_INTERNAL_TRACE'
  //    （judge request 应只含去重后候选清单 renderJudgeUserPrompt 的输出）。
  // 3. 正向断言：marker 确实出现在 dedup step 的 llm_round response 里。
  const DEDUP_MARKER = 'DEDUP_INTERNAL_TRACE'
  const jobId = await runFullPipeline(async (sys: string) => {
    if (sys.includes('memside-distiller')) {
      return JSON.stringify({
        candidates: [
          { title: '[category:invariant] refund 14d', bodyMd: '14 days', scope: 'project', runtime: null, distillAction: 'new' },
          { title: '[category:invariant] refund window', bodyMd: '14d', scope: 'project', runtime: null, distillAction: 'new' },
        ],
      })
    }
    if (sys.includes('memside-consolidate')) {
      // 特征串塞进合并步的 LLM 响应文本（response 原样落盘为 dedup llm_round）。
      return JSON.stringify({ groups: [{ action: 'keep', members: ['new-0'] }, { action: 'keep', members: ['new-1'] }] })
        + ` /* ${DEDUP_MARKER} internal dedup conversation trace */`
    }
    // judge (memside-value-judge)
    return JSON.stringify({ verdicts: [{ index: 0, category: 'decision' }, { index: 1, category: 'decision' }] })
  })

  const judgeRounds = await listLlmRounds(db, jobId, 'judge')
  expect(judgeRounds.length).toBeGreaterThan(0)  // judge 确实调了 LLM
  assertRequestExcludes(judgeRounds, DEDUP_MARKER)

  // 正向锚：marker 确实在 dedup 的 LLM 对话历史里（response 含它）。
  const dedupRounds = await listLlmRounds(db, jobId, 'dedup')
  expect(dedupRounds.length).toBeGreaterThan(0)
  expect(dedupRounds.some((r) => r.response.includes(DEDUP_MARKER))).toBe(true)

  // 全程完成：候选入库（隔离测试不应破坏正常流程）
  const cands = await db.select().from(memories).where(eq(memories.distillJobId, jobId)).all()
  expect(cands.length).toBe(2)
})

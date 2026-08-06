import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { openDb } from '@/db/client'
import { enqueueDistillJob, tick } from '@/scheduler'
import { createCandidate, promoteDiscard } from '@/memory/store'
import { memories, memoryDiscards, memoryDistillJobs } from '@/db/schema'

// Task 7 门禁：出处驱动价值判定端到端回归锁。
//
// 锁两件事：
// 1. 2026-07-30 误杀事故回归锁 -- 用户确认的凭证链决策（origin=user-confirmed +
//    非空 evidence）被 valueFilter LLM 违规判 derivable（Q2 ban 失效）时，
//    valueFilter 代码兜底（spec §R2，src/memory/valueFilter.ts:179）改判 keep+decision，
//    候选仍入库、不进 discards。
// 2. fleeting 丢弃进审计表且可 promoteDiscard 捞回 -- agent-observed 琐事被判 fleeting
//    -> 丢弃入 memory_discards；promoteDiscard 把 discard 提升回 candidate 行。
//
// 复用 tests/scheduler.test.ts 的 tick harness：openDb(tmp) -> enqueueDistillJob ->
// nextRunAt=0 -> tick(db, deps)。deps.createCandidate 用真实 store.createCandidate
// （非 mock），才能断言入库行。callLLM 按 system prompt 内容分发（distiller/dedup/
// value-judge 三选一）：1 候选 + 无 existing -> dedup 短路（src/memory/dedup.ts:100，
// judgeDuplicates 不调 LLM），仅 distill + judgeValue 两路触发。

const root = join(import.meta.dir, '.tmp-ovj')
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

test('门禁：user-confirmed 候选被 judge 误判 derivable -> 仍入库 valueClass=decision、无 discards 行', async () => {
  // 2026-07-30 误杀事故回归锁。distill 产出的候选必须带非空 evidence：distiller
  // 贴金防护（src/memory/distiller.ts:217）对 stated/confirmed 但 evidence 空的候选
  // 把 origin 降级 agent-observed，会让 valueFilter 兜底不触发（derivable +
  // agent-observed -> 丢弃）。这里 evidence='凭证链 UI 优先' 保住 origin=user-confirmed。
  const { jobId } = await enqueueDistillJob(db, {
    sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0,
  })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  let callCount = 0
  await tick(db, {
    loadTranscript: async () => ({ turns: [{ role: 'user', content: '凭证链优先级 UI>settings>env，因为 env 残留曾致 401' }], fullLength: 1 }),
    callLLM: async (sys) => {
      callCount++
      if (sys.includes('memside-distiller')) {
        return JSON.stringify({
          candidates: [{
            title: '[category:architecture] 凭证链优先级 UI>settings>env',
            bodyMd: '用户确认，因 env 残留曾致 401',
            scope: 'project', runtime: 'claude-code', distillAction: 'new',
            origin: 'user-confirmed', evidence: '凭证链 UI 优先',
          }],
        })
      }
      if (sys.includes('memside-value-judge')) {
        // 模拟 LLM 违规：user-confirmed 候选被判 derivable（违反 prompt 的 HARD RULE
        // "never assign derivable to a candidate whose origin is user-stated or user-confirmed"）。
        // 代码兜底必须改判 keep+decision。
        return JSON.stringify({ verdicts: [{ index: 0, category: 'derivable' }] })
      }
      // dedup：1 候选 + 无 existing -> judgeDuplicates 短路不调 LLM，此分支不会触发；
      // 兜底返回 keep，万一条数变化导致 dedup 调用也不误丢。
      return JSON.stringify({ verdicts: [{ index: 0, isDuplicate: false }] })
    },
    createCandidate,
    // Task 5 起 tick 默认质量模式(agent 判定器);本测试锁的是单发 judgeValue 的
    // stated 免疫兜底,显式钉 economy 模式。
    loadJudgeConfig: () => ({ mode: 'economy', maxRounds: 30, timeBudgetS: 300 }),
  })
  expect(callCount).toBe(2) // distill + judgeValue；dedup 短路不调 LLM

  // 入库 1 行 candidate，出处与价值类正确（兜底改判 keep+decision）
  const rows = await db.select().from(memories)
  expect(rows.length).toBe(1)
  expect(rows[0]!.origin).toBe('user-confirmed')
  expect(rows[0]!.valueClass).toBe('decision')
  expect(rows[0]!.status).toBe('candidate')
  expect(rows[0]!.evidence).toBe('凭证链 UI 优先')

  // 未进审计表：兜底改判 keep，不入 discards（事故根因是进 discards 被丢）
  const discards = await db.select().from(memoryDiscards)
  expect(discards.length).toBe(0)
})

test('门禁：agent-observed 琐事被判 fleeting -> 进 memory_discards，promoteDiscard 可捞回', async () => {
  // agent 自行总结的琐事（origin=agent-observed）被判 fleeting -> 丢弃入审计表。
  // fleeting 不受 stated 免疫保护（Q3 是 AI 对用户话语的判断权，"今天先到这吧" 该丢），
  // agent-observed 也不在 derivable 兜底范围。丢弃后 promoteDiscard 可提升回 candidate。
  const { jobId } = await enqueueDistillJob(db, {
    sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0,
  })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  let callCount = 0
  await tick(db, {
    loadTranscript: async () => ({ turns: [{ role: 'user', content: '今天先到这吧，收工' }], fullLength: 1 }),
    callLLM: async (sys) => {
      callCount++
      if (sys.includes('memside-distiller')) {
        return JSON.stringify({
          candidates: [{
            title: '[category:convention] 今天先到这吧',
            bodyMd: '收工',
            scope: 'project', runtime: 'claude-code', distillAction: 'new',
            origin: 'agent-observed', evidence: null,
          }],
        })
      }
      if (sys.includes('memside-value-judge')) {
        return JSON.stringify({ verdicts: [{ index: 0, category: 'fleeting' }] })
      }
      return JSON.stringify({ verdicts: [{ index: 0, isDuplicate: false }] })
    },
    createCandidate,
    // 同上:锁单发 judgeValue 的 fleeting 丢弃路径,钉 economy 模式(Task 5 默认 quality)。
    loadJudgeConfig: () => ({ mode: 'economy', maxRounds: 30, timeBudgetS: 300 }),
  })
  expect(callCount).toBe(2) // distill + judgeValue；dedup 短路

  // 未入库
  const rows = await db.select().from(memories)
  expect(rows.length).toBe(0)

  // 进审计表，reason=fleeting
  const discards = await db.select().from(memoryDiscards)
  expect(discards.length).toBe(1)
  expect(discards[0]!.reason).toBe('fleeting')

  // promoteDiscard 捞回：返回 candidate 行
  const promoted = await promoteDiscard(db, discards[0]!.id)
  expect(promoted.status).toBe('candidate')
  expect(promoted.title).toBe('[category:convention] 今天先到这吧')

  // memories 现在有 1 行（提升出的 candidate），id 对应
  const rowsAfter = await db.select().from(memories)
  expect(rowsAfter.length).toBe(1)
  expect(rowsAfter[0]!.id).toBe(promoted.id)

  // discard 行的 promotedMemoryId 已回填（审计保留 + 提升闭环）
  const discardsAfter = await db.select().from(memoryDiscards)
  expect(discardsAfter[0]!.promotedMemoryId).toBe(promoted.id)
})

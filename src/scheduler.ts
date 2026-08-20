import { and, asc, eq, lte } from 'drizzle-orm'
import { ulid } from 'ulid'
import { existsSync } from 'node:fs'
import { basename, parse as parsePath } from 'node:path'
import type { DbClient } from '@/db/client'
import { memories, memoryDistillJobs, memoryDistillEvents } from '@/db/schema'
import { distillTranscript, type DistillCandidate } from '@/memory/distiller'
import {
  listForDedupByScope, listApprovedByScope, listSubjectSlugs, logDiscards, setSessionOffset,
  saveSourceInput, saveDistillRun, getSessionDigest, upsertSessionDigest, listWaitingJobs,
  consumeFlush, releaseWaitingJob, logDegradation, getSessionOffset, updateDistillRunDigestMs,
  getJobCheckpoint, setJobCheckpoint, saveLlmRound, listLlmRounds, markJobPaused,
  logStepFailureNotification, saveStepOutput, getStepOutput, deleteCandidatesForJob,
  type DiscardRecord,
} from '@/memory/store'
import { advanceStep, nextStep, type DistillStep } from '@/memory/stepState'
import { exactDedupCandidates } from '@/memory/exactDedup'
import { judgeDuplicates } from '@/memory/dedup'
import { consolidateCandidates, type ConsolidatedCandidate } from '@/memory/consolidate'
import { judgeValue, type ValueClass, type ValueVerdict, type JudgeSessionOpts } from '@/memory/valueFilter'
import { judgeValueAgentic } from '@/memory/agentJudge'
import { DEFAULT_JUDGE_CONFIG, type JudgeConfig } from '@/memory/judgeConfig'
import { computeSliceSignal, isTrivial, isStale } from '@/memory/threshold'
import { buildDeterministicDigest } from '@/memory/contextDigest'
import { updateSessionLedger } from '@/memory/rollingSummary'
import type { AgentStep } from '@/memory/agentLoop'
import type { MemoryInput, Memory } from '@/memory/store'
import type { TranscriptTurn } from '@/memory/pure'
import { capRawText, filterTranscriptForDistill } from '@/memory/pure'
import type { LLMCall } from '@/llm'
import type { ActivityTracker, LlmPhase } from '@/activity'

export const DISTILL_DEBOUNCE_MS = 5_000
export const DISTILL_BATCH_LIMIT = 5
export const DISTILL_MAX_ATTEMPTS = 3
export const DISTILL_BACKOFF_BASE_MS = 30_000
// 已审批标题清单预算（spec §1 决策 4）：上限 100 条 / 总 2K 字符，双上限先到先截。
export const DISTILL_APPROVED_TITLES_MAX_COUNT = 100
export const DISTILL_APPROVED_TITLES_MAX_CHARS = 2_000

/**
 * 已审批标题双上限裁剪（spec §1 决策 4）：按传入顺序（project 先于 global）逐条累加，
 * 条数达 100 或「再加入下一条会使总字符超 2000」即截断；绝不切半条标题（整条取舍）。
 * 单条标题自身超 2000 字符时同样整条舍弃（清单可能为空）。
 */
export function clipTitlesByBudget(titles: string[]): string[] {
  const out: string[] = []
  let total = 0
  for (const t of titles) {
    if (out.length >= DISTILL_APPROVED_TITLES_MAX_COUNT) break
    if (total + t.length > DISTILL_APPROVED_TITLES_MAX_CHARS) break
    out.push(t)
    total += t.length
  }
  return out
}

export interface EnqueueInput {
  sourceEventId: string
  runtime: 'claude-code' | 'opencode'
  cwd: string
  debounceKey: string
  debounceMs?: number
  sessionId?: string  // 第五轮：会话键，用于增量偏移
  sourceAgentId?: string | null  // subagent 蒸馏任务的 agent_id；主会话任务为 null/不传
}

export async function enqueueDistillJob(db: DbClient, input: EnqueueInput) {
  const id = ulid()
  const now = Date.now()
  const nextRunAt = now + (input.debounceMs ?? DISTILL_DEBOUNCE_MS)
  await db.insert(memoryDistillJobs).values({
    id, debounceKey: input.debounceKey, sourceEventId: input.sourceEventId,
    runtime: input.runtime, cwd: input.cwd, sessionId: input.sessionId ?? null,
    sourceAgentId: input.sourceAgentId ?? null,
    status: 'pending', attempts: 0, nextRunAt, createdAt: now, finishedAt: null,
  })
  return { jobId: id, nextRunAt }
}

/**
 * 累加 job（spec §4.8）：与 enqueueDistillJob 同字段，status='waiting'，
 * lastCaptureAt=now。waiting 不进 tick 的 pending 选择；放行由
 * releaseWaitingJob（capture 阈值）或 sweep（flush/TTL）做。
 */
export async function enqueueWaitingJob(db: DbClient, input: EnqueueInput) {
  const id = ulid()
  const now = Date.now()
  await db.insert(memoryDistillJobs).values({
    id, debounceKey: input.debounceKey, sourceEventId: input.sourceEventId,
    runtime: input.runtime, cwd: input.cwd, sessionId: input.sessionId ?? null,
    sourceAgentId: input.sourceAgentId ?? null, status: 'waiting', attempts: 0,
    nextRunAt: now, createdAt: now, finishedAt: null, lastCaptureAt: now,
  })
  return { jobId: id, nextRunAt: now }
}

export interface TickDeps {
  loadTranscript: (job: {
    id: string; cwd: string | null; sourceEventId: string; sessionId: string | null
    sourceAgentId: string | null
  }) => Promise<{ turns: TranscriptTurn[]; fullLength: number; prefixTurns: TranscriptTurn[] }>
  callLLM: LLMCall
  /** Signature matches store.createCandidate(db, MemoryInput): Promise<Memory>. */
  createCandidate: (db: DbClient, input: MemoryInput) => Promise<Memory>
  /** 判定配置(模式+预算);缺省 DEFAULT_JUDGE_CONFIG(质量模式)。Task 6 daemon 接 app_settings。 */
  loadJudgeConfig?: () => JudgeConfig
  /** LLM 阶段活动跟踪（spec 2026-08-12 §5.6）；不传 = 不跟踪（测试/runDistillOnce 不受影响）。 */
  tracker?: ActivityTracker
}

/**
 * Derive the scopeId a candidate/job resolves to, matching the rule used by
 * `createCandidate` (project -> cwd, global -> null). Centralizing it here
 * keeps the dedup grouping and the createCandidate input in lockstep so the
 * two cannot drift on scopeId derivation.
 */
function resolveScopeId(scopeType: DistillCandidate['scopeType'], cwd: string | null): string | null {
  return scopeType === 'project' ? (cwd ?? 'unknown') : null
}

/**
 * Filter semantic duplicates out of a distill batch. Groups candidates by
 * (scopeType, scopeId) - scopeId derived the same way createCandidate does
 * (project -> jobCwd, global -> null) - and for each group asks judgeDuplicates
 * to compare against same-scope existing memories. Returns the subset to keep,
 * or `{failed:true,reasons}` when任一 scope 组的 dedup 会话失败（Task 7：不再
 * 保守全保留吞错，spec P1——由 tick 走 step 失败分支）。
 *
 * judgeDuplicates handles per-verdict hallucination fallback (invalid
 * duplicateOfId -> keep) WITHIN a successful response. listForDedupByScope DB
 * errors DO bubble to tick's catch (infrastructure fault -> job retry), per spec §8.
 */
export async function dedupCandidates(
  db: DbClient,
  callLLM: LLMCall,
  candidates: DistillCandidate[],
  jobCwd: string | null,
  session?: JudgeSessionOpts,
): Promise<DistillCandidate[] | { failed: true; reasons: string[] }> {
  if (candidates.length === 0) return []
  const groups = new Map<string, { scopeType: DistillCandidate['scopeType']; scopeId: string | null; items: { c: DistillCandidate; globalIndex: number }[] }>()
  candidates.forEach((c, i) => {
    const scopeId = resolveScopeId(c.scopeType, jobCwd)
    const key = `${c.scopeType}:${scopeId ?? ''}`
    if (!groups.has(key)) groups.set(key, { scopeType: c.scopeType, scopeId, items: [] })
    groups.get(key)!.items.push({ c, globalIndex: i })
  })
  const keepFlags = new Array(candidates.length).fill(false)
  for (const g of groups.values()) {
    const existing = await listForDedupByScope(db, { scopeType: g.scopeType, scopeId: g.scopeId })
    const verdicts = await judgeDuplicates({
      newCandidates: g.items.map((it) => it.c),
      existing,
      callLLM,
      jobId: session?.jobId,
      persistRound: session?.persistRound,
      loadHistory: session?.loadHistory,
    })
    if ('failed' in verdicts) return verdicts
    for (const v of verdicts) {
      if (!v.duplicate) keepFlags[g.items[v.index]!.globalIndex] = true
    }
  }
  return candidates.filter((_, i) => keepFlags[i])
}

/**
 * 合并步（spec 2026-08-19 §3）：替换旧二元丢弃 dedup。按 (scopeType, scopeId)
 * 分组，每组调 consolidateCandidates（1 LLM）：同主题碎片熔合、纯重复 drop、对既有
 * approved 的精炼 update_of。返回合并后候选 + drop 的全局下标（走 logDiscards
 * reason='duplicate'）。LLM 失败 → {failed:true,reasons}（P1 不吞错）。existing 按
 * subjectSlug 预筛（§3.3，Task 2 listForDedupByScope 新签名）。
 *
 * 步骤名仍为 'dedup'（stepState 四步不动，断点续跑历史兼容；consolidateCandidates
 * 走 runLlmSession step='dedup'）。dropIndices 指向 exact.kept（exact dedup 后幸存
 * 候选）的下标，调用方据此走 logDiscards。
 */
export async function consolidateBatch(
  db: DbClient,
  callLLM: LLMCall,
  candidates: DistillCandidate[],
  jobCwd: string | null,
  session?: JudgeSessionOpts,
): Promise<{ kept: ConsolidatedCandidate[]; dropIndices: number[] } | { failed: true; reasons: string[] }> {
  if (candidates.length === 0) return { kept: [], dropIndices: [] }
  const groups = new Map<string, { scopeType: DistillCandidate['scopeType']; scopeId: string | null; items: { c: DistillCandidate; globalIndex: number }[] }>()
  candidates.forEach((c, i) => {
    const scopeId = resolveScopeId(c.scopeType, jobCwd)
    const key = `${c.scopeType}:${scopeId ?? ''}`
    if (!groups.has(key)) groups.set(key, { scopeType: c.scopeType, scopeId, items: [] })
    groups.get(key)!.items.push({ c, globalIndex: i })
  })
  const kept: ConsolidatedCandidate[] = []
  const dropGlobal: number[] = []
  for (const g of groups.values()) {
    const slugs = [...new Set(g.items.map((it) => it.c.subjectSlug).filter((s): s is string => !!s))]
    const existing = await listForDedupByScope(db, { scopeType: g.scopeType, scopeId: g.scopeId, slugs })
    const res = await consolidateCandidates({
      newCandidates: g.items.map((it) => it.c),
      existing, callLLM,
      jobId: session?.jobId, persistRound: session?.persistRound, loadHistory: session?.loadHistory,
    })
    if ('failed' in res) return res
    kept.push(...res.candidates)
    for (const localIdx of res.dropIndices) {
      dropGlobal.push(g.items[localIdx]!.globalIndex)
    }
  }
  return { kept, dropIndices: dropGlobal.sort((a, b) => a - b) }
}

/**
 * Sweep 累加中的 waiting job（spec §4.7）：SessionEnd flush 标记或 TTL 过期
 * （lastCaptureAt 超 SESSION_FLUSH_TTL_MS）触发结算——切片信号低于琐碎下限
 * （DISTILL_TRIVIAL_FLOOR_CHARS，不调 LLM）记 skipped_trivial 收场；足量则
 * releaseWaitingJob 放行 pending，进 tick 的 due 选择。
 *
 * 只动 status='waiting' 的 conversation job（listWaitingJobs 已排除 subagent 与
 * running/done）；lastCaptureAt === null 的 legacy 行跳过（无 TTL 判据）。
 * flush/TTL 路径不适用 capture 侧的 8000 字放行阈值——只由 1000 字琐碎下限决定
 * skipped_trivial vs 放行（spec §4.7）。返回处理的 waiting job 数。
 */
export async function sweepWaitingJobs(db: DbClient, now: number): Promise<number> {
  let handled = 0
  const waiting = await listWaitingJobs(db)
  for (const job of waiting) {
    if (!job.sessionId) continue
    if (job.lastCaptureAt === null) continue // legacy 行无 TTL 判据，不走 sweep
    const flushed = await consumeFlush(db, job.sessionId)
    const stale = isStale(job.lastCaptureAt, now)
    if (!flushed && !stale) continue
    // flush/TTL 触发：琐碎 -> skipped_trivial 收场；足量 -> 放行。
    const rows = await db.select().from(memoryDistillEvents)
      .where(eq(memoryDistillEvents.distillJobId, job.id))
    let turns: TranscriptTurn[] = []
    for (const r of rows) {
      try { const p = JSON.parse(r.payload); if (Array.isArray(p)) turns = p as TranscriptTurn[] } catch { /* skip */ }
    }
    let offset = 0
    try { offset = await getSessionOffset(db, job.sessionId) } catch { /* 全量判定 */ }
    const signal = computeSliceSignal(turns, offset)
    if (isTrivial(signal)) {
      try {
        await saveDistillRun(db, job.id, {
          outcome: 'skipped_trivial', rawOutput: null, rawCount: 0,
          acceptedCount: 0, dedupedCount: 0, filteredCount: 0, storedCount: 0,
          discardedCount: 0, durationMs: 0, errorMessage: null,
        })
      } catch (e) { console.warn('memside: saveDistillRun failed', e) }
      // done 落库守卫（终审修复）：status='waiting' 条件与 releaseWaitingJob 同款——
      // 若 capture 在 sweep 读事件与本 update 之间放行了该 job，此处不得把含新内容
      // 的 job 标成 done（竞态下 update 0 行，job 继续走 pending 真蒸馏）。
      await db.update(memoryDistillJobs).set({ status: 'done', finishedAt: now })
        .where(and(eq(memoryDistillJobs.id, job.id), eq(memoryDistillJobs.status, 'waiting'))).run()
    } else {
      await releaseWaitingJob(db, job.id)
    }
    handled += 1
  }
  return handled
}

/**
 * digest 步的 LLM 接缝（spec 2026-08-18 §5，Task 7）：把 updateSessionLedger 的
 * 裸 callLLM 包成「带历史留底的单轮接续」——每轮请求/响应落 llm_round；末轮已
 * 成功则直接复用落盘响应（崩溃窗口不重算）；上轮失败则附一句追问重发；空产出
 * 记失败轮后抛错（由 tick 走 digest step 失败分支）。digest 产出是纯文本行
 * （非 JSON），故不走 runLlmSession 的 JSON 解析路径，追问措辞也不提 JSON。
 */
function makeDigestRoundLlm(db: DbClient, jobId: string, inner: LLMCall): LLMCall {
  return async (sys, user) => {
    const rounds = await listLlmRounds(db, jobId, 'digest')
    const last = rounds.length > 0 ? rounds[rounds.length - 1]! : null
    if (last && last.result.ok) return last.response
    const round = rounds.length + 1
    const conversation = last
      ? user + '\n\n[系统] 上次请求未获有效结果，请重新输出完整结果。'
      : user
    let persisted = false
    try {
      const raw = await inner(sys, conversation)
      if (!raw || !raw.trim()) {
        persisted = true
        await saveLlmRound(db, { jobId, step: 'digest', round, request: conversation, response: '', result: { ok: false, reason: 'format' } })
        throw new Error('ledger digest: empty LLM output')
      }
      await saveLlmRound(db, { jobId, step: 'digest', round, request: conversation, response: raw, result: { ok: true } })
      return raw
    } catch (e) {
      if (!persisted) {
        try {
          await saveLlmRound(db, { jobId, step: 'digest', round, request: conversation, response: '', result: { ok: false, reason: 'aborted' } })
        } catch { /* best-effort 留底 */ }
      }
      throw e
    }
  }
}

/** 步骤失败信息（tick 内部传递）。reasons 每轮一条，前缀 aborted/format/incomplete。 */
interface StepFailure { step: DistillStep; reasons: string[] }

const STEP_FAIL_REASONS = ['aborted', 'format', 'incomplete'] as const

/** 从 session reasons 首条推导失败分类（advanceStep 需要 StepFailReason）。 */
function classifyStepReason(reasons: string[]): 'aborted' | 'format' | 'incomplete' {
  const head = reasons[0] ?? ''
  return STEP_FAIL_REASONS.find((r) => head.startsWith(r)) ?? 'aborted'
}

/**
 * Single pass over due jobs. Selects only `pending` jobs whose `nextRunAt <= now`
 * (limit DISTILL_BATCH_LIMIT), marks each `running`, then runs the checkpointed
 * step machine (spec 2026-08-18 §5，Task 7 断点续跑接线):
 *
 * 1. 读断点（currentStep/stepAttempts），恢复前步干净结果（step_output 落库读回，
 *    不重算已成功步骤、不传对话历史——P3/P4）。
 * 2. 四步（distill→dedup→judge→digest）各走可接续会话执行器，每步成功即推进断点
 *    并在**同 tick 内继续下一步**（§5.4 锁定决断：正常路径一个 tick 跑完，与现状
 *    体验一致）；失败则回 pending + 指数退避，下次 tick 带历史接续（每 tick 单轮）。
 * 3. 单步累计 3 次失败 → markJobPaused + 汇总一条任务级通知，job 停在 paused 等
 *    用户处置（重试/放弃，Task 9 UI）；judge 步暂停时候选标 pending_review，不进
 *    审批队列也不丢弃。
 * 4. offset（setSessionOffset）**仅四步全成时推进**（P5）；删除旧「无条件标 done +
 *    失败也推 offset」路径（用户最初「内容永久跳过」的 bug）。
 *
 * 步骤机器之外的异常（loadTranscript / DB 等基础设施故障）仍走外层 catch：
 * attempts+1，达 DISTILL_MAX_ATTEMPTS 标 failed，否则回 pending 退避（spec §8）。
 *
 * Filtering on `status='pending'` (rather than any status) is deliberate: a job
 * just marked `done`/`failed`/`paused` keeps its old due `nextRunAt`, so without
 * the status filter it would be re-selected and reprocessed on every subsequent
 * tick forever.
 */
export async function tick(db: DbClient, deps: TickDeps): Promise<number> {
  const now = Date.now()
  // waiting 结算（spec §4.7）：sweep 异常不得阻塞 pending 处理（spec §5 #9），落表可见。
  try { await sweepWaitingJobs(db, now) }
  catch (e) {
    await logDegradation(db, { kind: 'sweep_error', detail: String(e) })
  }
  const due = await db.select().from(memoryDistillJobs)
    .where(and(eq(memoryDistillJobs.status, 'pending'), lte(memoryDistillJobs.nextRunAt, now)))
    .orderBy(asc(memoryDistillJobs.nextRunAt))
    .limit(DISTILL_BATCH_LIMIT)
  let processed = 0
  for (const job of due) {
    // Defensive guard against overlapping ticks (setInterval does not await the
    // previous callback). With the pending-only select this is already closed in
    // practice, but keep the check as a zero-cost belt-and-suspenders.
    if (job.status === 'running') continue
    await db.update(memoryDistillJobs).set({ status: 'running' }).where(eq(memoryDistillJobs.id, job.id)).run()
    try {
      const jobDetail = job.cwd ? basename(job.cwd) : null
      const tracker = deps.tracker ?? null
      const tracked = (tracker
        ? tracker.wrapCall(deps.callLLM)
        : deps.callLLM)
      const phase = (p: LlmPhase): { end(): { calls: number; ms: number } } =>
        tracker ? tracker.begin(p, jobDetail) : { end: () => ({ calls: 0, ms: 0 }) }
      const { turns: newTurns, fullLength, prefixTurns } = await deps.loadTranscript({
        id: job.id, cwd: job.cwd, sourceEventId: job.sourceEventId,
        sessionId: job.sessionId ?? null, sourceAgentId: (job.sourceAgentId as string | null) ?? null,
      })
      // 第五轮增量切片：newTurns 为空 = 该 session 自上次蒸馏后无新增 turn，跳过蒸馏。
      // 标 done（消费 job），不 distill / createCandidate / setSessionOffset（偏移不变）。
      if (newTurns.length === 0) {
        // skipped_no_new_turns：未调 LLM，记一条空 run（透明化），再 done。
        try {
          await saveDistillRun(db, job.id, {
            outcome: 'skipped_no_new_turns', rawOutput: null, rawCount: 0,
            acceptedCount: 0, dedupedCount: 0, filteredCount: 0, storedCount: 0,
            discardedCount: 0, durationMs: 0, errorMessage: null,
          })
        } catch (e) { console.warn('memside: saveDistillRun failed', e) }
        await db.update(memoryDistillJobs).set({ status: 'done', finishedAt: Date.now() })
          .where(eq(memoryDistillJobs.id, job.id)).run()
        processed += 1
        continue
      }
      // subagent trivial（spec §4.8）：一次性 job 低于琐碎下限 -> skipped_trivial 不调 LLM。
      if (job.sourceAgentId && isTrivial(computeSliceSignal(newTurns, 0))) {
        try {
          await saveDistillRun(db, job.id, {
            outcome: 'skipped_trivial', rawOutput: null, rawCount: 0,
            acceptedCount: 0, dedupedCount: 0, filteredCount: 0, storedCount: 0,
            discardedCount: 0, durationMs: 0, errorMessage: null,
          })
        } catch (e) { console.warn('memside: saveDistillRun failed', e) }
        // done 落库守卫（终审修复）：此处 job 已被本 tick 标 running（capture 放行只
        // 触 waiting 行，不会并发改 running），条件 eq(status,'running') 是零成本
        // belt-and-suspenders——并发下若状态已变，宁可不标 done 也不盖掉新状态。
        await db.update(memoryDistillJobs).set({ status: 'done', finishedAt: Date.now() })
          .where(and(eq(memoryDistillJobs.id, job.id), eq(memoryDistillJobs.status, 'running'))).run()
        processed += 1
        continue
      }
      const judgeCfg = deps.loadJudgeConfig?.() ?? DEFAULT_JUDGE_CONFIG
      const sourceKind = job.sourceAgentId ? 'subagent' as const : 'conversation' as const
      const t0 = Date.now()

      // -------------------------------------------------------------------
      // 断点恢复（spec 2026-08-18 §5）：读断点 + 恢复前步干净结果（step_output）。
      // step_output 先于断点推进落库，故「断点已推进但产出缺失」仅理论可达（外部
      // 改库/损坏）；此时记 degradation 并保守回退重跑该步，绝不带错数据前进。
      // -------------------------------------------------------------------
      let cp = getJobCheckpoint(db, job.id)
      let candidates: DistillCandidate[] = []
      let rawOutput: unknown = null
      let rawCount = 0
      if (cp.currentStep !== 'distill') {
        const saved = await getStepOutput<{ candidates: DistillCandidate[]; rawOutput: unknown; rawCount: number }>(db, job.id, 'distill')
        if (saved) {
          candidates = Array.isArray(saved.candidates) ? saved.candidates : []
          rawOutput = saved.rawOutput ?? null
          rawCount = typeof saved.rawCount === 'number' ? saved.rawCount : 0
        } else {
          await logDegradation(db, { kind: 'checkpoint_corrupt', detail: `distill step_output missing at step=${cp.currentStep}; resetting to distill`, distillJobId: job.id })
          await setJobCheckpoint(db, job.id, { currentStep: 'distill', stepAttempts: 0, stepError: null })
          cp = { currentStep: 'distill', stepAttempts: 0, stepError: null }
        }
      }
      let deduped: ConsolidatedCandidate[] | null = null
      let dedupExactDrops = 0
      if (cp.currentStep === 'judge' || cp.currentStep === 'digest') {
        const saved = await getStepOutput<{ deduped: ConsolidatedCandidate[]; exactDrops: number; consolidatedDrops?: number }>(db, job.id, 'dedup')
        if (saved && Array.isArray(saved.deduped)) {
          deduped = saved.deduped
          dedupExactDrops = typeof saved.exactDrops === 'number' ? saved.exactDrops : 0
        } else {
          await logDegradation(db, { kind: 'checkpoint_corrupt', detail: `dedup step_output missing at step=${cp.currentStep}; resetting to dedup`, distillJobId: job.id })
          await setJobCheckpoint(db, job.id, { currentStep: 'dedup', stepAttempts: 0, stepError: null })
          cp = { currentStep: 'dedup', stepAttempts: 0, stepError: null }
        }
      }
      let judged: { filteredCount: number; storedCount: number; discardedCount: number } | null = null
      if (cp.currentStep === 'digest') {
        const saved = await getStepOutput<{ filteredCount: number; storedCount: number; discardedCount: number }>(db, job.id, 'judge')
        if (saved) judged = saved
        else {
          await logDegradation(db, { kind: 'checkpoint_corrupt', detail: 'judge step_output missing at step=digest; resetting to judge', distillJobId: job.id })
          await setJobCheckpoint(db, job.id, { currentStep: 'judge', stepAttempts: 0, stepError: null })
          cp = { currentStep: 'judge', stepAttempts: 0, stepError: null }
        }
      }
      let currentStep: DistillStep = cp.currentStep
      // 当前步骤的失败计数：成功推进即归零（advanceStep 同款语义）。
      let stepAttempts = cp.stepAttempts

      // run 记录累积量（跨步骤；恢复 tick 只含本 tick 实测耗时）
      let dedupMs: number | null = null
      let judgeMs: number | null = null
      let agentTrace: AgentStep[] | null = null
      let judgeFallback: string | null = null
      let failed: StepFailure | null = null

      // -------------------------------------------------------------------
      // 步骤 1：蒸馏（distill）——走可接续执行器，单 tick 单轮（§5.4）。
      // -------------------------------------------------------------------
      if (currentStep === 'distill') {
        // distiller 上下文接线（spec §4.7）：priorContext（前文 digest）+ 已审批
        // 标题 + subject slug 清单。切片起点在全量中的位置 =
        // fullLength - newTurns.length（loadTranscript 已切好；真实 loader 下恒等于
        // session offset，>= 0）。
        const offset = fullLength - newTurns.length
        let priorContext: string | null = null
        if (job.sessionId && offset > 0) {
          if (judgeCfg.mode === 'quality') {
            try {
              const d = await getSessionDigest(db, job.sessionId)
              priorContext = d?.digest ?? buildDeterministicDigest(prefixTurns) // legacy 兜底（spec §5 #7）
            } catch (e) {
              await logDegradation(db, { kind: 'digest_read_failed', detail: String(e), distillJobId: job.id, sessionId: job.sessionId })
              priorContext = null
            }
          } else {
            priorContext = buildDeterministicDigest(prefixTurns)
          }
        }
        // 已审批标题清单（上限 100 条 / 总 2K 字符，spec §1 决策 4）：查询失败 ->
        // 空清单降级 + titles_query_failed 落表，distill 照常（spec §6）。
        let approvedTitles: string[] = []
        try {
          const set = await listApprovedByScope(db, { projectId: job.cwd ?? 'unknown' })
          approvedTitles = clipTitlesByBudget([...set.byScope.project, ...set.byScope.global].map((m) => m.title))
        } catch (e) {
          await logDegradation(db, { kind: 'titles_query_failed', detail: String(e), distillJobId: job.id, sessionId: job.sessionId ?? undefined })
        }
        // subject-keyed 聚合（spec §4.6）：查询失败 -> 空清单，distill 照常（spec §6）。
        let existingSlugs: string[] = []
        try {
          const [projSlugs, globalSlugs] = await Promise.all([
            listSubjectSlugs(db, { scopeType: 'project', scopeId: job.cwd ?? 'unknown' }),
            listSubjectSlugs(db, { scopeType: 'global', scopeId: null }),
          ])
          existingSlugs = [...new Set([...projSlugs, ...globalSlugs])].sort()
        } catch (e) {
          console.warn('memside: listSubjectSlugs failed', e)
        }
        const pDistill = phase('distill')
        let distillOut: Awaited<ReturnType<typeof distillTranscript>>
        try {
          distillOut = await distillTranscript({
            turns: newTurns,  // 只喂新增 turn，不再全量
            runtime: job.runtime as 'claude-code' | 'opencode',
            cwd: job.cwd ?? '',
            existingSlugs,
            callLLM: tracked,
            sourceKind,
            priorContext,      // spec §4.7：前文 digest（经济=确定性，质量=滚动摘要/兜底）
            approvedTitles,    // spec §4.7：已审批标题清单（禁止重复提炼）
            // Task 7 断点续跑接线（spec §5）：历史落盘/读回 + 单 tick 单轮接续。
            jobId: job.id,
            persistRound: (r) => saveLlmRound(db, { jobId: job.id, step: 'distill', round: r.round, request: r.request, response: r.response, result: r.result }),
            loadHistory: () => listLlmRounds(db, job.id, 'distill'),
          })
        } finally { pDistill.end() }
        if (distillOut.sessionFailed) {
          failed = { step: 'distill', reasons: distillOut.reasons }
        } else {
          candidates = distillOut.candidates
          rawOutput = distillOut.rawOutput
          rawCount = distillOut.rawCount
          // 干净结果落库（P3/P4）→ 断点推进到 dedup → 同 tick 继续下一步（§5.4）。
          await saveStepOutput(db, job.id, 'distill', { candidates, rawOutput, rawCount })
          await setJobCheckpoint(db, job.id, { currentStep: 'dedup', stepAttempts: 0, stepError: null })
          currentStep = 'dedup'
          stepAttempts = 0
        }
      }

      // -------------------------------------------------------------------
      // 步骤 2：去重（dedup）。逐字去重(spec §4.1)先于 LLM（省调用），drops 不进
      // 后续任何 LLM 判定（既有不变量）；随后合并步（consolidateBatch，spec
      // 2026-08-19 §3）：同主题碎片熔合 / 纯重复 drop / 对既有 approved 精炼 update_of。
      // 合并步 drop 的候选走 logDiscards reason='duplicate'（旧二元丢弃不落审计表，
      // 合并步补审计）。合并步失败 → step 失败（不再保守全保留吞错，P1）。
      // -------------------------------------------------------------------
      if (!failed && currentStep === 'dedup') {
        const exact = await exactDedupCandidates(db, candidates, job.cwd ?? null)
        dedupExactDrops = exact.drops.length
        if (exact.drops.length > 0) {
          try {
            await logDiscards(db, job.id, exact.drops.map((d) => ({
              title: d.cand.title, bodyMd: d.cand.bodyMd, reason: 'exact-duplicate',
              scopeType: d.cand.scopeType,
              scopeId: resolveScopeId(d.cand.scopeType, job.cwd ?? null),
              sourceCwd: job.cwd ?? null,
              runtime: d.cand.runtime,
              sourceKind,
            })))
          } catch (e) { console.warn('memside: logDiscards failed', e) }
        }
        const pDedup = phase('dedup')
        let dedupPhase = { calls: 0, ms: 0 }
        let dedupOut: { kept: ConsolidatedCandidate[]; dropIndices: number[] } | { failed: true; reasons: string[] }
        try {
          dedupOut = await consolidateBatch(db, tracked, exact.kept, job.cwd ?? null, {
            jobId: job.id,
            persistRound: (r) => saveLlmRound(db, { jobId: job.id, step: 'dedup', round: r.round, request: r.request, response: r.response, result: r.result }),
            loadHistory: () => listLlmRounds(db, job.id, 'dedup'),
          })
        } finally { dedupPhase = pDedup.end() }
        dedupMs = dedupPhase.calls > 0 ? dedupPhase.ms : null
        if ('failed' in dedupOut) {
          failed = { step: 'dedup', reasons: dedupOut.reasons }
        } else {
          // 合并步 drop 的候选走 logDiscards reason='duplicate'（审计可见，可捞回）
          if (dedupOut.dropIndices.length > 0) {
            const dropRecords = dedupOut.dropIndices.map((i) => {
              const c = exact.kept[i]!
              return {
                title: c.title, bodyMd: c.bodyMd, reason: 'duplicate' as const,
                scopeType: c.scopeType,
                scopeId: resolveScopeId(c.scopeType, job.cwd ?? null),
                sourceCwd: job.cwd ?? null,
                runtime: c.runtime,
                sourceKind,
              }
            })
            try { await logDiscards(db, job.id, dropRecords) } catch (e) { console.warn('memside: logDiscards failed', e) }
          }
          deduped = dedupOut.kept
          await saveStepOutput(db, job.id, 'dedup', { deduped, exactDrops: exact.drops.length, consolidatedDrops: dedupOut.dropIndices.length })
          await setJobCheckpoint(db, job.id, { currentStep: 'judge', stepAttempts: 0, stepError: null })
          currentStep = 'judge'
          stepAttempts = 0
        }
      }

      // -------------------------------------------------------------------
      // 步骤 3：审查（judge）。模式分发(spec §4.6)：economy = 九分类单发 judgeValue
      // （走执行器，带历史接续）；quality = agent 终审(judgeValueAgentic)。两路径
      // 失败都返回 failed 标识 → step 失败分支（3 次暂停 + pending_review），绝不
      // 静默全保留（spec §缺陷2/D4，Task 6 废兜底、Task 7 接正式暂停）。
      // 项目目录已删除/是盘根 -> 该批降级经济模式（蒸馏记录注明降级）；绝不让
      // agent 在 rootDir=null 下跑（makeRepoTools('/') 会把沙箱放宽到盘根）。
      // -------------------------------------------------------------------
      if (!failed && currentStep === 'judge') {
        if (deduped === null) deduped = []
        let verdicts: ValueVerdict[] = []
        if (deduped.length > 0) {
          const pJudge = phase('judge')
          let judgePhase = { calls: 0, ms: 0 }
          try {
            const agentRootDir = job.cwd && existsSync(job.cwd) && parsePath(job.cwd).root !== job.cwd ? job.cwd : null
            if (judgeCfg.mode === 'economy' || agentRootDir === null) {
              if (judgeCfg.mode !== 'economy') judgeFallback = 'economy:no-root-dir'
              const r = await judgeValue(deduped, tracked, {
                jobId: job.id,
                persistRound: (rr) => saveLlmRound(db, { jobId: job.id, step: 'judge', round: rr.round, request: rr.request, response: rr.response, result: rr.result }),
                loadHistory: () => listLlmRounds(db, job.id, 'judge'),
              })
              if (Array.isArray(r)) verdicts = r
              else failed = { step: 'judge', reasons: r.reasons }
            } else {
              // 质量模式(spec §4.5)：agent 终审。approvedTitles 复用 distiller 接线的
              // 同一份清单（查询失败落 titles_query_failed 降级）。
              let approvedTitles: string[] = []
              try {
                const set = await listApprovedByScope(db, { projectId: job.cwd ?? 'unknown' })
                approvedTitles = clipTitlesByBudget([...set.byScope.project, ...set.byScope.global].map((m) => m.title))
              } catch (e) {
                await logDegradation(db, { kind: 'titles_query_failed', detail: String(e), distillJobId: job.id, sessionId: job.sessionId ?? undefined })
              }
              const r = await judgeValueAgentic(deduped, {
                callLLM: tracked, rootDir: agentRootDir, approvedTitles,
                sourceKind, maxRounds: judgeCfg.maxRounds, timeBudgetMs: judgeCfg.timeBudgetS * 1000,
              })
              if ('failed' in r) {
                failed = { step: 'judge', reasons: r.reasons }
              } else {
                verdicts = r.verdicts
                agentTrace = r.trace
              }
            }
          } finally { judgePhase = pJudge.end() }
          judgeMs = judgePhase.calls > 0 ? judgePhase.ms : null
        }
        if (!failed) {
          const keepWithClass: { cand: ConsolidatedCandidate; valueClass: ValueClass | null }[] = []
          const discarded: DiscardRecord[] = []
          verdicts.forEach((v, i) => {
            const c = deduped![i]
            if (!c) return
            if (v.keep) keepWithClass.push({ cand: c, valueClass: v.valueClass })
            else discarded.push({
              title: c.title, bodyMd: c.bodyMd, reason: v.reason,
              scopeType: c.scopeType,
              scopeId: resolveScopeId(c.scopeType, job.cwd ?? null),
              sourceCwd: job.cwd ?? null,
              runtime: c.runtime,
              sourceKind,
            })
          })
          if (discarded.length > 0) {
            // Best-effort audit log: a DB failure here must not block distill.
            try { await logDiscards(db, job.id, discarded) } catch (e) { console.warn('memside: logDiscards failed', e) }
          }
          // final-fix-1（judge 幂等重跑）：插入新裁决前先清掉本 job 旧 candidate 行。
          // 若 createCandidate 循环与 setJobCheckpoint('digest') 之间崩溃 → job 回 pending
          // → 下 tick loadHistory 复放同一裁决（零 LLM 调用）再次入库 → 重复候选行。
          // 仅清 candidate（不动 approved/rejected/pending_review）。
          try { await deleteCandidatesForJob(db, job.id) }
          catch (e) { console.warn('memside: judge candidate cleanup failed', e) }
          for (const k of keepWithClass) {
            await deps.createCandidate(db, {
              scopeType: k.cand.scopeType,
              scopeId: resolveScopeId(k.cand.scopeType, job.cwd ?? null),
              title: k.cand.title,
              bodyMd: k.cand.bodyMd,
              tags: [],
              sourceKind,
              sourceCwd: job.cwd ?? null,
              runtime: k.cand.runtime,
              distillJobId: job.id,
              distillAction: k.cand.distillAction,        // 合并步产物覆盖（merge→new, update_of→update_of）
              supersedesId: k.cand.supersedesId ?? null,  // update_of 透传 targetId（spec §3）
              sourceEventId: job.sourceEventId,
              valueClass: k.valueClass,
              subjectSlug: k.cand.subjectSlug,
              origin: k.cand.origin,      // spec §模块改动点 3：出处随候选入库
              evidence: k.cand.evidence,  // 出处原句摘抄
            })
          }
          judged = { filteredCount: keepWithClass.length, storedCount: keepWithClass.length, discardedCount: discarded.length }
          // judge 暂停后的重试成功：本批已有正式归宿（入库/审计），退役暂停期间的
          // pending_review 占位行（spec §6.4：审查成功自动进正常队列）。
          try {
            await db.delete(memories).where(and(eq(memories.distillJobId, job.id), eq(memories.status, 'pending_review'))).run()
          } catch (e) { console.warn('memside: pending_review cleanup failed', e) }
          await saveStepOutput(db, job.id, 'judge', judged)
          // 去门（spec §5）：0 产出 job 也存过滤版输入，让用户看到「模型看到了什么
          // 却返回 0」。best-effort：失败只 warn。
          try { await saveSourceInput(db, job.id, filterTranscriptForDistill(newTurns)) }
          catch (e) { console.warn('memside: saveSourceInput failed', e) }
          await setJobCheckpoint(db, job.id, { currentStep: 'digest', stepAttempts: 0, stepError: null })
          currentStep = 'digest'
          stepAttempts = 0
        }
      }

      // -------------------------------------------------------------------
      // 步骤 4：摘要（digest）+ 收官。仅质量模式 + 会话 job（非 subagent）跑滚动
      // 账本；经济模式 / subagent / 无 sessionId 时此步平凡成功。digest 失败 →
      // step 失败分支（旧「降级落表 + 仍标 done + 推 offset」已废——P5 失败不冒进）。
      // -------------------------------------------------------------------
      let digestPhase = { calls: 0, ms: 0 }
      if (!failed && currentStep === 'digest') {
        if (judgeCfg.mode === 'quality' && job.sessionId && !job.sourceAgentId) {
          // 滚动账本维护（spec 2026-08-11-digest-ledger-redesign §4.1）：把本次切片
          // 并入会话事实账本。LLM 调用经 makeDigestRoundLlm 留底/接续；LLM/写库
          // 失败落 digest_llm_failed 并走 step 失败（offset 不动）。切片压缩超配额
          // 由代码按行裁剪并落 digest_truncated；全局预算由 trimOldestLines 丢最旧
          // 整行强制，属设计内留存，不记降级。
          try {
            const prior = await getSessionDigest(db, job.sessionId)
            const pDigest = phase('digest')
            try {
              const { digest: merged, truncated, overshoot } = await updateSessionLedger(prior?.digest ?? null, newTurns, makeDigestRoundLlm(db, job.id, tracked))
              if (merged !== (prior?.digest ?? '')) {
                await upsertSessionDigest(db, job.sessionId, merged, 'llm')
              }
              if (truncated && overshoot) {
                await logDegradation(db, { kind: 'digest_truncated', detail: `切片压缩产出 ${overshoot.actual} 字超配额 ${overshoot.budget} 字，按行裁剪保留最新`, distillJobId: job.id, sessionId: job.sessionId })
              }
            } finally { digestPhase = pDigest.end() }
          } catch (e) {
            await logDegradation(db, { kind: 'digest_llm_failed', detail: String(e), distillJobId: job.id, sessionId: job.sessionId })
            failed = { step: 'digest', reasons: [e instanceof Error ? e.message : String(e)] }
          }
        }
      }

      if (!failed && currentStep === 'digest' && nextStep(currentStep) === null) {
        // 四步全成（nextStep('digest')===null，spec §5.1）：唯一推 offset 处（P5）
        // + 唯一标 done 处（删除旧无条件标 done）。
        const durationMs = Date.now() - t0
        const outcome = candidates.length === 0 ? 'empty_output' : 'produced'
        try {
          await saveDistillRun(db, job.id, {
            outcome,
            // agent 运行(质量模式)把 trace 并入 rawOutput;rootDir 缺失降级经济模式时
            // 注明 judgeFallback。形状向后兼容:既有 `.candidates` 键不动,只加可选键。
            rawOutput: agentTrace || judgeFallback
              ? {
                  ...(rawOutput && typeof rawOutput === 'object' ? rawOutput as Record<string, unknown> : { raw: rawOutput ?? null }),
                  ...(agentTrace ? { agentTrace } : {}),
                  ...(judgeFallback ? { judgeFallback } : {}),
                }
              : rawOutput,
            rawCount, acceptedCount: candidates.length, dedupedCount: deduped?.length ?? 0,
            filteredCount: judged?.filteredCount ?? 0, storedCount: judged?.storedCount ?? 0,
            discardedCount: (judged?.discardedCount ?? 0) + dedupExactDrops, durationMs,
            errorMessage: null, rawText: null, dedupMs, judgeMs,
          })
        } catch (e) { console.warn('memside: saveDistillRun failed', e) }
        await db.update(memoryDistillJobs).set({ status: 'done', finishedAt: Date.now() }).where(eq(memoryDistillJobs.id, job.id)).run()
        // 第五轮：本次蒸馏到 fullLength，下次该 session 从此处切。仅 job 有 sessionId
        // 且非 subagent 时更新；失败只 warn（四步已全成，偏移是优化非正确性依赖）。
        if (job.sessionId && !job.sourceAgentId) {
          try { await setSessionOffset(db, job.sessionId, fullLength) }
          catch (e) { console.warn('memside: setSessionOffset failed', e) }
        }
        if (digestPhase.calls > 0) {
          try { await updateDistillRunDigestMs(db, job.id, digestPhase.ms) }
          catch (e) { console.warn('memside: updateDistillRunDigestMs failed', e) }
        }
      }

      // -------------------------------------------------------------------
      // 步骤失败处理（spec §5.1）：未到 3 次 → 回 pending + 指数退避（D1），下次
      // tick 带历史接续；满 3 次 → markJobPaused + 汇总通知（D2），judge 步暂停时
      // 候选标 pending_review（§6.4）。offset 一律不动（P5）。
      // -------------------------------------------------------------------
      if (failed) {
        const failStep = failed.step
        const reasons = failed.reasons.length > 0 ? failed.reasons : ['aborted:unknown']
        const failReason = classifyStepReason(reasons)
        const lastErrorText = reasons.join(' | ')
        const adv = advanceStep(failStep, { ok: false, reason: failReason }, stepAttempts)
        try {
          await db.update(memoryDistillJobs).set({ lastError: lastErrorText })
            .where(eq(memoryDistillJobs.id, job.id)).run()
        } catch (e) { console.warn('memside: set lastError failed', e) }
        if (adv.paused === 'paused') {
          // 3 次失败：暂停等人处置，绝不标 failed 丢内容（D2/P8）。
          const isAbort = failReason === 'aborted'
          let rawText: string | null = null
          if (!isAbort) {
            try {
              const rounds = await listLlmRounds(db, job.id, failStep)
              const last = rounds.length > 0 ? rounds[rounds.length - 1]! : null
              rawText = capRawText(last?.response ?? null)
            } catch { /* best-effort */ }
          }
          try {
            await saveDistillRun(db, job.id, {
              outcome: isAbort ? 'llm_error' : 'parse_error',
              rawOutput: null, rawCount, acceptedCount: 0,
              dedupedCount: deduped?.length ?? 0,
              filteredCount: 0, storedCount: 0, discardedCount: dedupExactDrops,
              durationMs: Date.now() - t0, errorMessage: lastErrorText,
              rawText, dedupMs, judgeMs,
            })
          } catch (e) { console.warn('memside: saveDistillRun failed', e) }
          await markJobPaused(db, job.id, failStep)  // 落 pausedStep（run 行已写）
          await logStepFailureNotification(db, { jobId: job.id, step: failStep, reasons })
          if (failStep === 'judge' && deduped && deduped.length > 0) {
            // judge 暂停期间候选标 pending_review（spec §6.4）：不进审批队列（非
            // candidate）、不丢弃（不进 discards）；重试成功后自动退役，暂停期间
            // 可手动接管审批。先清掉上一轮暂停留下的占位行（重试又失败的场景）。
            try {
              await db.delete(memories).where(and(eq(memories.distillJobId, job.id), eq(memories.status, 'pending_review'))).run()
            } catch (e) { console.warn('memside: pending_review cleanup failed', e) }
            for (const c of deduped) {
              try {
                const m = await deps.createCandidate(db, {
                  scopeType: c.scopeType,
                  scopeId: resolveScopeId(c.scopeType, job.cwd ?? null),
                  title: c.title,
                  bodyMd: c.bodyMd,
                  tags: [],
                  sourceKind,
                  sourceCwd: job.cwd ?? null,
                  runtime: c.runtime,
                  distillJobId: job.id,
                  distillAction: c.distillAction,
                  supersedesId: c.supersedesId ?? null,
                  sourceEventId: job.sourceEventId,
                  valueClass: null,       // 未评估：等 judge 重试或人工接管
                  subjectSlug: c.subjectSlug,
                  origin: c.origin,
                  evidence: c.evidence,
                })
                await db.update(memories).set({ status: 'pending_review' }).where(eq(memories.id, m.id)).run()
              } catch (e) { console.warn('memside: pending_review insert failed', e) }
            }
            // 暂停也保留 source-input 快照（用户能在 UI 看到模型看到了什么）。
            try { await saveSourceInput(db, job.id, filterTranscriptForDistill(newTurns)) }
            catch (e) { console.warn('memside: saveSourceInput failed', e) }
          }
        } else {
          // 未到 3 次：断点留当前步骤 + 计数，回 pending + 指数退避（下次接续跑）。
          await setJobCheckpoint(db, job.id, { currentStep: failStep, stepAttempts: adv.attempts, stepError: reasons[0]! })
          const backoff = DISTILL_BACKOFF_BASE_MS * 2 ** (adv.attempts - 1)
          await db.update(memoryDistillJobs).set({ status: 'pending', nextRunAt: Date.now() + backoff }).where(eq(memoryDistillJobs.id, job.id)).run()
        }
      }
      processed += 1
    } catch (err) {
      const attempts = (job.attempts as number) + 1
      if (attempts >= DISTILL_MAX_ATTEMPTS) {
        await db.update(memoryDistillJobs).set({ status: 'failed', attempts, lastError: String(err) }).where(eq(memoryDistillJobs.id, job.id)).run()
      } else {
        const backoff = DISTILL_BACKOFF_BASE_MS * 2 ** (attempts - 1)
        await db.update(memoryDistillJobs).set({ status: 'pending', attempts, nextRunAt: Date.now() + backoff, lastError: String(err) }).where(eq(memoryDistillJobs.id, job.id)).run()
      }
    }
  }
  return processed
}
/**
 * Start the 1Hz distill loop. Returns a stop function that clears the interval.
 * Each tick is fire-and-forget (`void tick`); overlapping ticks are guarded by
 * the pending-only select + running-mark inside `tick`.
 */
export function startMemoryDistillLoop(db: DbClient, deps: TickDeps): () => void {
  const handle = setInterval(() => { void tick(db, deps) }, 1000)
  return () => clearInterval(handle)
}

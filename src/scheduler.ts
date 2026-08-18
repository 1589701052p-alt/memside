import { and, asc, eq, lte } from 'drizzle-orm'
import { ulid } from 'ulid'
import { existsSync } from 'node:fs'
import { basename, parse as parsePath } from 'node:path'
import type { DbClient } from '@/db/client'
import { memoryDistillJobs, memoryDistillEvents } from '@/db/schema'
import { distillTranscript, type DistillCandidate } from '@/memory/distiller'
import { listForDedupByScope, listApprovedByScope, listSubjectSlugs, logDiscards, setSessionOffset, saveSourceInput, saveDistillRun, getSessionDigest, upsertSessionDigest, listWaitingJobs, consumeFlush, releaseWaitingJob, logDegradation, getSessionOffset, logLlmErrorNotification, logParseErrorNotification, updateDistillRunDigestMs, type DiscardRecord } from '@/memory/store'
import { exactDedupCandidates } from '@/memory/exactDedup'
import { judgeDuplicates } from '@/memory/dedup'
import { judgeValue, type ValueClass, type ValueVerdict } from '@/memory/valueFilter'
import { judgeValueAgentic } from '@/memory/agentJudge'
import { DEFAULT_JUDGE_CONFIG, type JudgeConfig } from '@/memory/judgeConfig'
import { computeSliceSignal, isTrivial, isStale } from '@/memory/threshold'
import { buildDeterministicDigest } from '@/memory/contextDigest'
import { updateSessionLedger } from '@/memory/rollingSummary'
import type { AgentStep } from '@/memory/agentLoop'
import type { MemoryInput, Memory } from '@/memory/store'
import type { TranscriptTurn } from '@/memory/pure'
import { capRawText } from '@/memory/pure'
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
 * to compare against same-scope existing memories. Returns the subset to keep.
 *
 * judgeDuplicates handles its own LLM-error fallback (all-new), so this never
 * throws on dedup failure. listForDedupByScope DB errors DO bubble to tick's
 * catch (infrastructure fault -> job retry), per spec §8.
 */
export async function dedupCandidates(
  db: DbClient,
  callLLM: LLMCall,
  candidates: DistillCandidate[],
  jobCwd: string | null,
): Promise<DistillCandidate[]> {
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
    })
    for (const v of verdicts) {
      if (!v.duplicate) keepFlags[g.items[v.index]!.globalIndex] = true
    }
  }
  return candidates.filter((_, i) => keepFlags[i])
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
 * Single pass over due jobs. Selects only `pending` jobs whose `nextRunAt <= now`
 * (limit DISTILL_BATCH_LIMIT), marks each `running`, calls the distiller, persists
 * candidates, then marks `done`. On error: bumps attempts; if attempts >=
 * DISTILL_MAX_ATTEMPTS -> `failed`, else back to `pending` with exponential backoff
 * (DISTILL_BACKOFF_BASE_MS * 2^(attempts-1)) and lastError recorded.
 *
 * Filtering on `status='pending'` (rather than any status) is deliberate: a job
 * just marked `done`/`failed` keeps its old due `nextRunAt`, so without the status
 * filter it would be re-selected and reprocessed on every subsequent tick forever.
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
      // distiller 上下文接线（spec §4.7）：priorContext（前文 digest）+ 已审批标题。
      // 切片起点在全量中的位置 = fullLength - newTurns.length（loadTranscript 已切好；
      // 真实 loader 下恒等于 session offset，>= 0）。
      const offset = fullLength - newTurns.length
      const judgeCfg = deps.loadJudgeConfig?.() ?? DEFAULT_JUDGE_CONFIG
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
      // 已审批标题清单（上限 100 条 / 总 2K 字符，spec §1 决策 4）：查询失败 -> 空清单
      // 降级 + titles_query_failed 落表，distill 照常（spec §6）。distiller 与质量模式
      // judgeValueAgentic 共用同一份清单。
      let approvedTitles: string[] = []
      try {
        const set = await listApprovedByScope(db, { projectId: job.cwd ?? 'unknown' })
        approvedTitles = clipTitlesByBudget([...set.byScope.project, ...set.byScope.global].map((m) => m.title))
      } catch (e) {
        await logDegradation(db, { kind: 'titles_query_failed', detail: String(e), distillJobId: job.id, sessionId: job.sessionId ?? undefined })
      }
      // subject-keyed 聚合（spec §4.6）：取 project(job.cwd) ∪ global 的现有
      // slug 清单喂 distiller 促复用。查询失败 -> 空清单，distill 照常（spec §6）。
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
      const t0 = Date.now()
      const pDistill = phase('distill')
      let distillOut: Awaited<ReturnType<typeof distillTranscript>>
      try {
        distillOut = await distillTranscript({
          turns: newTurns,  // 只喂新增 turn，不再全量
          runtime: job.runtime as 'claude-code' | 'opencode',
          cwd: job.cwd ?? '',
          existingSlugs,
          callLLM: tracked,
          sourceKind: job.sourceAgentId ? 'subagent' : 'conversation',
          priorContext,      // spec §4.7：前文 digest（经济=确定性，质量=滚动摘要/兜底）
          approvedTitles,    // spec §4.7：已审批标题清单（禁止重复提炼）
        })
      } finally { pDistill.end() }
      const { candidates, filteredTurns, rawOutput, rawCount, callThrew, errorMessage, parseError, lastRawText } = distillOut
      const durationMs = Date.now() - t0
      // 逐字去重(spec §4.1):规范化逐字相同才合并,零语义判断;合并项走审计表。
      // 先于 LLM dedup,省调用;drops 不进后续任何 LLM 判定。
      const exact = await exactDedupCandidates(db, candidates, job.cwd ?? null)
      if (exact.drops.length > 0) {
        try {
          await logDiscards(db, job.id, exact.drops.map((d) => ({
            title: d.cand.title, bodyMd: d.cand.bodyMd, reason: 'exact-duplicate',
            scopeType: d.cand.scopeType,
            scopeId: resolveScopeId(d.cand.scopeType, job.cwd ?? null),
            sourceCwd: job.cwd ?? null,
            runtime: d.cand.runtime,
            sourceKind: job.sourceAgentId ? 'subagent' : 'conversation',
          })))
        } catch (e) { console.warn('memside: logDiscards failed', e) }
      }
      // Dedup FIRST (same-batch siblings + cross-batch existing), so valueFilter
      // only runs on survivors (no wasted calls, no per-dupe mis-classification).
      const pDedup = phase('dedup')
      let dedupPhase = { calls: 0, ms: 0 }
      let deduped: DistillCandidate[]
      try {
        deduped = await dedupCandidates(db, tracked, exact.kept, job.cwd ?? null)
      } finally { dedupPhase = pDedup.end() }
      const dedupMs = dedupPhase.calls > 0 ? dedupPhase.ms : null
      // Value filter: 模式分发(spec §4.6)。economy = 九分类单发 judgeValue;
      // quality = agent 终审(judgeValueAgentic,第 10 类 duplicate + 仓库工具查验)。
      // 两路径都吞自身 LLM 错误(stated->decision / observed->null),never bubbles。
      // spec 失败矩阵:项目目录已删除 -> 该批降级经济模式(蒸馏记录注明降级)。
      // 绝不让 agent 在 rootDir=null 下跑(makeRepoTools('/') 会把沙箱放宽到盘根)。
      // 文件系统根('/' / 'C:\')同理:existsSync 为真但等于盘根沙箱,一并降级。
      const pJudge = phase('judge')
      let judgePhase = { calls: 0, ms: 0 }
      let verdicts: ValueVerdict[]
      let agentTrace: AgentStep[] | null = null
      let judgeFallback: string | null = null
      try {
        const agentRootDir = job.cwd && existsSync(job.cwd) && parsePath(job.cwd).root !== job.cwd ? job.cwd : null
        if (judgeCfg.mode === 'economy' || deduped.length === 0) {
          // WIP 过渡（Task 6）：judgeValue 失败现在返回 {failed:true,reasons} 而非全保留
          // verdicts。本调用点暂把 failed 当空 verdicts 过渡——Task 7 接正式暂停 + 通知。
          const r = await judgeValue(deduped, tracked)
          verdicts = Array.isArray(r) ? r : []
        } else if (agentRootDir === null) {
          judgeFallback = 'economy:no-root-dir'
          // WIP 过渡（Task 6）：同上，failed -> 空 verdicts，Task 7 改正式暂停。
          const r = await judgeValue(deduped, tracked)
          verdicts = Array.isArray(r) ? r : []
        } else {
          // 质量模式(spec §4.5):agent 终审。approvedTitles 复用 distiller 接线的
          // 同一份清单（查询失败已在上方落 titles_query_failed 降级）。
          const r = await judgeValueAgentic(deduped, {
            callLLM: tracked, rootDir: agentRootDir, approvedTitles,
            sourceKind: job.sourceAgentId ? 'subagent' : 'conversation',
            maxRounds: judgeCfg.maxRounds, timeBudgetMs: judgeCfg.timeBudgetS * 1000,
          })
          // WIP 过渡（Task 6）：agent 失败现在返回 {failed:true,reasons}。暂当空
          // verdicts + null trace 过渡；Task 7 改正式暂停 + 通知。
          if ('failed' in r) {
            verdicts = []
            agentTrace = null
          } else {
            verdicts = r.verdicts
            agentTrace = r.trace
          }
        }
      } finally { judgePhase = pJudge.end() }
      const judgeMs = judgePhase.calls > 0 ? judgePhase.ms : null
      const keepWithClass: { cand: DistillCandidate; valueClass: ValueClass | null }[] = []
      const discarded: DiscardRecord[] = []
      verdicts.forEach((v, i) => {
        const c = deduped[i]
        if (!c) return
        if (v.keep) keepWithClass.push({ cand: c, valueClass: v.valueClass })
        else discarded.push({
          title: c.title, bodyMd: c.bodyMd, reason: v.reason,
          scopeType: c.scopeType,
          scopeId: resolveScopeId(c.scopeType, job.cwd ?? null),
          sourceCwd: job.cwd ?? null,
          runtime: c.runtime,
          sourceKind: job.sourceAgentId ? 'subagent' : 'conversation',
        })
      })
      if (discarded.length > 0) {
        // Best-effort audit log: a DB failure here must not block distill.
        try { await logDiscards(db, job.id, discarded) } catch (e) { console.warn('memside: logDiscards failed', e) }
      }
      for (const k of keepWithClass) {
        await deps.createCandidate(db, {
          scopeType: k.cand.scopeType,
          scopeId: resolveScopeId(k.cand.scopeType, job.cwd ?? null),
          title: k.cand.title,
          bodyMd: k.cand.bodyMd,
          tags: [],
          sourceKind: job.sourceAgentId ? 'subagent' : 'conversation',
          sourceCwd: job.cwd ?? null,
          runtime: k.cand.runtime,
          distillJobId: job.id,
          distillAction: k.cand.distillAction,
          sourceEventId: job.sourceEventId,
          valueClass: k.valueClass,
          subjectSlug: k.cand.subjectSlug,
          origin: k.cand.origin,      // spec §模块改动点 3：出处随候选入库
          evidence: k.cand.evidence,  // 出处原句摘抄
        })
      }
      // 去门（spec §5）：0 产出 job 也存过滤版输入，让用户看到「模型看到了什么却返回 0」。
      // skipped 分支已 continue，此处恒非 skipped。best-effort：失败只 warn，不阻塞 done。
      try { await saveSourceInput(db, job.id, filteredTurns) }
      catch (e) { console.warn('memside: saveSourceInput failed', e) }
      // 运行记录：outcome + 计数链 + LLM 原始产出 + 错误描述。best-effort，与 logDiscards/saveSourceInput 同级。
      // spec 2026-08-15 §4 真值表：candidates 优先；callThrew -> llm_error；
      // 未抛错但解析耗尽 -> parse_error；合法空 -> empty_output。
      const outcome = candidates.length === 0
        ? (callThrew ? 'llm_error' : parseError ? 'parse_error' : 'empty_output')
        : 'produced'
      const runErrorMessage = outcome === 'llm_error' ? errorMessage
        : outcome === 'parse_error' ? parseError : null
      try {
        await saveDistillRun(db, job.id, {
          // spec §4: produced = accepted_count > 0 regardless of transient LLM
          // errors during retry. Check candidates.length===0 FIRST so a retry-
          // success (callThrew=true from attempt 0 but candidates produced on
          // attempt 1) is classified 'produced', not 'llm_error'.
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
          rawCount, acceptedCount: candidates.length, dedupedCount: deduped.length,
          filteredCount: keepWithClass.length, storedCount: keepWithClass.length,
          discardedCount: discarded.length + exact.drops.length, durationMs, errorMessage: runErrorMessage,
          rawText: outcome === 'parse_error' ? capRawText(lastRawText) : null,
          dedupMs, judgeMs,
        })
      } catch (e) { console.warn('memside: saveDistillRun failed', e) }
      // /api/status 修复（spec §scheduler）：llm_error / parse_error 都把错误写进
      // job.last_error 并发通知（spec 2026-08-15 §5.5），顶部状态栏的 lastError 才能
      // 看到 LLM 错误（既有 lastError 查 j.lastError 非空）。
      // best-effort：失败只 warn，不阻塞 done。
      if ((outcome === 'llm_error' || outcome === 'parse_error') && runErrorMessage) {
        try {
          await db.update(memoryDistillJobs).set({ lastError: runErrorMessage })
            .where(eq(memoryDistillJobs.id, job.id)).run()
          if (outcome === 'parse_error') {
            await logParseErrorNotification(db, { jobId: job.id, message: runErrorMessage })
          } else {
            await logLlmErrorNotification(db, { jobId: job.id, message: runErrorMessage })
          }
        } catch (e) { console.warn('memside: set lastError failed', e) }
      }
      await db.update(memoryDistillJobs).set({ status: 'done', finishedAt: Date.now() }).where(eq(memoryDistillJobs.id, job.id)).run()
      // 第五轮：本次蒸馏到 fullLength，下次该 session 从此处切。仅 job 有 sessionId 时
      // 更新；无 sessionId（历史 job）不更新，保持全量向后兼容。失败只 warn，不阻塞 done。
      if (job.sessionId && !job.sourceAgentId) {
        try { await setSessionOffset(db, job.sessionId, fullLength) }
        catch (e) { console.warn('memside: setSessionOffset failed', e) }
      }
      // 滚动账本维护（spec 2026-08-11-digest-ledger-redesign §4.1）：distill 成功（未抛错）+
      // 质量模式 + 会话 job（非 subagent）才把本次切片并入会话事实账本。LLM/写库失败只降级
      // 落表（digest_llm_failed），不影响 job 已 done 的事实。切片压缩超配额由代码按行裁剪并
      // 落 digest_truncated；全局预算由 trimOldestLines 丢最旧整行强制，属设计内留存，不记降级。
      if (!callThrew && judgeCfg.mode === 'quality' && job.sessionId && !job.sourceAgentId) {
        let digestPhase = { calls: 0, ms: 0 }
        try {
          const prior = await getSessionDigest(db, job.sessionId)
          const pDigest = phase('digest')
          try {
            const { digest: merged, truncated, overshoot } = await updateSessionLedger(prior?.digest ?? null, newTurns, tracked)
            if (merged !== (prior?.digest ?? '')) {
              await upsertSessionDigest(db, job.sessionId, merged, 'llm')
            }
            if (truncated && overshoot) {
              await logDegradation(db, { kind: 'digest_truncated', detail: `切片压缩产出 ${overshoot.actual} 字超配额 ${overshoot.budget} 字，按行裁剪保留最新`, distillJobId: job.id, sessionId: job.sessionId })
            }
          } finally { digestPhase = pDigest.end() }
        } catch (e) {
          await logDegradation(db, { kind: 'digest_llm_failed', detail: String(e), distillJobId: job.id, sessionId: job.sessionId })
        }
        if (digestPhase.calls > 0) {
          try { await updateDistillRunDigestMs(db, job.id, digestPhase.ms) }
          catch (e) { console.warn('memside: updateDistillRunDigestMs failed', e) }
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

import { and, asc, eq, lte } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import { memoryDistillJobs } from '@/db/schema'
import { distillTranscript, type DistillCandidate } from '@/memory/distiller'
import { listForDedupByScope, listSubjectSlugs, logDiscards, setSessionOffset, saveSourceInput, saveDistillRun, type DiscardRecord } from '@/memory/store'
import { judgeDuplicates } from '@/memory/dedup'
import { judgeValue, type ValueClass } from '@/memory/valueFilter'
import type { MemoryInput, Memory } from '@/memory/store'
import type { TranscriptTurn } from '@/memory/pure'
import type { LLMCall } from '@/llm'

export const DISTILL_DEBOUNCE_MS = 5_000
export const DISTILL_BATCH_LIMIT = 5
export const DISTILL_MAX_ATTEMPTS = 3
export const DISTILL_BACKOFF_BASE_MS = 30_000

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

export interface TickDeps {
  loadTranscript: (job: {
    id: string; cwd: string | null; sourceEventId: string; sessionId: string | null
    sourceAgentId: string | null
  }) => Promise<{ turns: TranscriptTurn[]; fullLength: number }>
  callLLM: LLMCall
  /** Signature matches store.createCandidate(db, MemoryInput): Promise<Memory>. */
  createCandidate: (db: DbClient, input: MemoryInput) => Promise<Memory>
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
      const { turns: newTurns, fullLength } = await deps.loadTranscript({
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
      const { candidates, filteredTurns, rawOutput, rawCount, callThrew, errorMessage } = await distillTranscript({
        turns: newTurns,  // 只喂新增 turn，不再全量
        runtime: job.runtime as 'claude-code' | 'opencode',
        cwd: job.cwd ?? '',
        existingSlugs,
        callLLM: deps.callLLM,
      })
      const durationMs = Date.now() - t0
      // Dedup FIRST (same-batch siblings + cross-batch existing), so valueFilter
      // only runs on survivors (no wasted calls, no per-dupe mis-classification).
      const deduped = await dedupCandidates(db, deps.callLLM, candidates, job.cwd ?? null)
      // Value filter: classify each survivor. public-knowledge/derivable =>
      // discard (audit-logged); decision/convention/trap/topology => keep with
      // valueClass; protected categories (invariant/integration/compliance) are
      // force-kept with valueClass='decision' inside judgeValue. judgeValue
      // swallows its own LLM errors (all keep+null/decision), never bubbles.
      const verdicts = await judgeValue(deduped, deps.callLLM)
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
        })
      }
      // 去门（spec §5）：0 产出 job 也存过滤版输入，让用户看到「模型看到了什么却返回 0」。
      // skipped 分支已 continue，此处恒非 skipped。best-effort：失败只 warn，不阻塞 done。
      try { await saveSourceInput(db, job.id, filteredTurns) }
      catch (e) { console.warn('memside: saveSourceInput failed', e) }
      // 运行记录：outcome + 计数链 + LLM 原始产出 + 错误描述。best-effort，与 logDiscards/saveSourceInput 同级。
      const outcome = candidates.length === 0 ? (callThrew ? 'llm_error' : 'empty_output') : 'produced'
      try {
        await saveDistillRun(db, job.id, {
          // spec §4: produced = accepted_count > 0 regardless of transient LLM
          // errors during retry. Check candidates.length===0 FIRST so a retry-
          // success (callThrew=true from attempt 0 but candidates produced on
          // attempt 1) is classified 'produced', not 'llm_error'.
          outcome,
          rawOutput, rawCount, acceptedCount: candidates.length, dedupedCount: deduped.length,
          filteredCount: keepWithClass.length, storedCount: keepWithClass.length,
          discardedCount: discarded.length, durationMs, errorMessage,
        })
      } catch (e) { console.warn('memside: saveDistillRun failed', e) }
      // /api/status 修复（spec §scheduler）：llm_error 时把错误也写进 job.last_error，
      // 顶部状态栏的 lastError 才能看到 LLM 错误（既有 lastError 查 j.lastError 非空）。
      // best-effort：失败只 warn，不阻塞 done。
      if (outcome === 'llm_error' && errorMessage) {
        try {
          await db.update(memoryDistillJobs).set({ lastError: errorMessage })
            .where(eq(memoryDistillJobs.id, job.id)).run()
        } catch (e) { console.warn('memside: set lastError failed', e) }
      }
      await db.update(memoryDistillJobs).set({ status: 'done', finishedAt: Date.now() }).where(eq(memoryDistillJobs.id, job.id)).run()
      // 第五轮：本次蒸馏到 fullLength，下次该 session 从此处切。仅 job 有 sessionId 时
      // 更新；无 sessionId（历史 job）不更新，保持全量向后兼容。失败只 warn，不阻塞 done。
      if (job.sessionId && !job.sourceAgentId) {
        try { await setSessionOffset(db, job.sessionId, fullLength) }
        catch (e) { console.warn('memside: setSessionOffset failed', e) }
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

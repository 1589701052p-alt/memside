import { and, asc, eq, lte } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import { memoryDistillJobs } from '@/db/schema'
import { distillTranscript, type DistillCandidate } from '@/memory/distiller'
import { listForDedupByScope, logDiscards, type DiscardRecord } from '@/memory/store'
import { judgeDuplicates } from '@/memory/dedup'
import { judgeValue, type ValueClass } from '@/memory/valueFilter'
import type { MemoryInput, Memory } from '@/memory/store'
import type { TranscriptTurn } from '@/memory/pure'

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
}

export async function enqueueDistillJob(db: DbClient, input: EnqueueInput) {
  const id = ulid()
  const now = Date.now()
  const nextRunAt = now + (input.debounceMs ?? DISTILL_DEBOUNCE_MS)
  await db.insert(memoryDistillJobs).values({
    id, debounceKey: input.debounceKey, sourceEventId: input.sourceEventId,
    runtime: input.runtime, cwd: input.cwd, status: 'pending',
    attempts: 0, nextRunAt, createdAt: now, finishedAt: null,
  })
  return { jobId: id, nextRunAt }
}

export interface TickDeps {
  loadTranscript: (job: { id: string; cwd: string | null; sourceEventId: string }) => Promise<TranscriptTurn[]>
  callAnthropic: (systemPrompt: string, userPrompt: string) => Promise<string>
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
  callAnthropic: TickDeps['callAnthropic'],
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
      callAnthropic,
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
      const turns = await deps.loadTranscript({ id: job.id, cwd: job.cwd, sourceEventId: job.sourceEventId })
      const candidates: DistillCandidate[] = await distillTranscript({
        turns,
        runtime: job.runtime as 'claude-code' | 'opencode',
        cwd: job.cwd ?? '',
        callAnthropic: deps.callAnthropic,
      })
      // Value filter: classify each candidate (rules 1-6). public-knowledge/
      // derivable => discard (audit-logged); decision/convention/trap/topology
      // => keep with valueClass; no valid classification => keep valueClass=null.
      // judgeValue swallows its own LLM errors (all keep+null), never bubbles.
      const verdicts = await judgeValue(candidates, deps.callAnthropic)
      const keepWithClass: { cand: DistillCandidate; valueClass: ValueClass | null }[] = []
      const discarded: DiscardRecord[] = []
      verdicts.forEach((v, i) => {
        const c = candidates[i]
        if (!c) return
        if (v.keep) keepWithClass.push({ cand: c, valueClass: v.valueClass })
        else discarded.push({ title: c.title, bodyMd: c.bodyMd, reason: v.reason })
      })
      if (discarded.length > 0) {
        // Best-effort audit log: a DB failure here must not block distill or
        // retry the job (audit is side-effect, not load-bearing).
        try { await logDiscards(db, job.id, discarded) } catch (e) { console.warn('memside: logDiscards failed', e) }
      }
      // Dedup survivors against same-scope existing (existing behavior).
      const keepCandidates = keepWithClass.map((k) => k.cand)
      const deduped = await dedupCandidates(db, deps.callAnthropic, keepCandidates, job.cwd ?? null)
      // Re-attach valueClass by reference: dedupCandidates returns a same-reference
      // subset of keepCandidates (candidates.filter(...)), so the cand object
      // identity survives dedup and we can map back to its valueClass.
      const classByCand = new Map(keepWithClass.map((k) => [k.cand, k.valueClass]))
      for (const c of deduped) {
        await deps.createCandidate(db, {
          scopeType: c.scopeType,
          scopeId: resolveScopeId(c.scopeType, job.cwd ?? null),
          title: c.title,
          bodyMd: c.bodyMd,
          tags: [],
          sourceKind: 'conversation',
          sourceCwd: job.cwd ?? null,
          runtime: c.runtime,
          distillJobId: job.id,
          distillAction: c.distillAction,
          sourceEventId: job.sourceEventId,
          valueClass: classByCand.get(c) ?? null,
        })
      }
      await db.update(memoryDistillJobs).set({ status: 'done', finishedAt: Date.now() }).where(eq(memoryDistillJobs.id, job.id)).run()
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

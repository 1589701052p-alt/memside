import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, like, lt, notInArray, or, sql } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import { memories, memoryDiscards, memorySessionOffsets, memoryDistillInputs, memoryDistillRuns, memoryDistillJobs, memoryDistillEvents, memorySessionFlushes, memorySessionDigests, memoryDegradations, notifications, memoryTrash } from '@/db/schema'
import { snapshotMemory, restoreFromSnapshot } from './trash'
import {
  canTransition,
  categoryFromTitle,
  normalizeSubjectSlug,
  type InjectableMemorySet,
  type MemoryScope,
  type MemoryStatus,
  type RuntimeTag,
  type TranscriptTurn,
} from './pure'

import type { ExistingMemoryForDedup } from './dedup'
import type { DistillOrigin } from './distiller'
import type { DiscardReason, ValueClass } from './valueFilter'
import type { DistillStep, StepAttemptResult } from './stepState'

export interface MemoryInput {
  scopeType: MemoryScope
  scopeId: string | null
  title: string
  bodyMd: string
  tags: string[]
  sourceKind: 'conversation' | 'error' | 'manual' | 'subagent'
  runtime: RuntimeTag
  sourceCwd?: string | null
  sourceEventId?: string | null
  distillJobId?: string | null
  distillAction?: 'new' | 'update_of' | 'duplicate_of' | 'conflict_with' | null
  valueClass?: ValueClass | null
  /** 主题归组键（spec §4.4）；缺省/null = 未分组。 */
  subjectSlug?: string | null
  /** 出处（spec §R1）；缺省/null = 未标注（老行迁移/手动记忆/promoteDiscard 提升行）。 */
  origin?: DistillOrigin | null
  /** 出处原句摘抄；缺省/null = 无。 */
  evidence?: string | null
  /** 合并步 update_of 产物：被精炼的既有 approved 记忆 id（spec 2026-08-19 §3）。
   *  缺省/null = 非 update_of（new/普通候选）。schema memories.supersedes_id 透传。 */
  supersedesId?: string | null
}

export interface Memory {
  id: string
  scopeType: MemoryScope
  scopeId: string | null
  runtime: RuntimeTag
  title: string
  bodyMd: string
  tags: string[]
  status: MemoryStatus
  sourceKind: string
  sourceCwd: string | null
  sourceEventId: string | null
  distillJobId: string | null
  distillAction: string | null
  supersedesId: string | null
  supersededById: string | null
  approvedAt: number | null
  createdAt: number
  version: number
  valueClass: ValueClass | null
  subjectSlug: string | null
  origin: DistillOrigin | null
  evidence: string | null
}

function parseTags(s: string): string[] {
  try {
    const p = JSON.parse(s)
    return Array.isArray(p) ? p.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function rowToMemory(r: any): Memory {
  return {
    id: r.id, scopeType: r.scopeType, scopeId: r.scopeId, runtime: r.runtime ?? null,
    title: r.title, bodyMd: r.bodyMd, tags: parseTags(r.tags), status: r.status,
    sourceKind: r.sourceKind, sourceCwd: r.sourceCwd ?? null,
    sourceEventId: r.sourceEventId ?? null,
    distillJobId: r.distillJobId ?? null, distillAction: r.distillAction ?? null,
    supersedesId: r.supersedesId ?? null, supersededById: r.supersededById ?? null,
    approvedAt: r.approvedAt ?? null, createdAt: r.createdAt, version: r.version,
    valueClass: (r.valueClass ?? null) as ValueClass | null,
    subjectSlug: r.subjectSlug ?? null,
    origin: (r.origin ?? null) as DistillOrigin | null,
    evidence: r.evidence ?? null,
  }
}

export async function createCandidate(db: DbClient, input: MemoryInput): Promise<Memory> {
  const id = ulid()
  const now = Date.now()
  await db.insert(memories).values({
    id, scopeType: input.scopeType, scopeId: input.scopeId, runtime: input.runtime,
    title: input.title, bodyMd: input.bodyMd, tags: JSON.stringify(input.tags),
    status: 'candidate', sourceKind: input.sourceKind,
    sourceCwd: input.sourceCwd ?? null,
    sourceEventId: input.sourceEventId ?? null, distillJobId: input.distillJobId ?? null,
    distillAction: input.distillAction ?? null, supersedesId: input.supersedesId ?? null, supersededById: null,
    approvedAt: null, createdAt: now, version: 1, valueClass: input.valueClass ?? null,
    subjectSlug: input.subjectSlug ?? null,
    origin: input.origin ?? null, evidence: input.evidence ?? null,
  })
  return rowToMemory({ id, scopeType: input.scopeType, scopeId: input.scopeId, runtime: input.runtime,
    title: input.title, bodyMd: input.bodyMd, tags: JSON.stringify(input.tags), status: 'candidate',
    sourceKind: input.sourceKind, sourceCwd: input.sourceCwd ?? null,
    sourceEventId: input.sourceEventId ?? null, distillJobId: input.distillJobId ?? null,
    distillAction: input.distillAction ?? null, supersedesId: input.supersedesId ?? null, supersededById: null, approvedAt: null,
    createdAt: now, version: 1, valueClass: input.valueClass ?? null,
    subjectSlug: input.subjectSlug ?? null, origin: input.origin ?? null, evidence: input.evidence ?? null })
}

/**
 * 删除某 job 的候选行（status='candidate'）——让 judge 重跑幂等（spec 2026-08-18 §5
 * final-fix-1）：judge 成功后若在 createCandidate 循环与 setJobCheckpoint('digest')
 * 之间崩溃，job 回 pending 重跑时 loadHistory 复放上一轮裁决（零 LLM 调用）并再次
 * 入库 → 重复候选行。本 helper 在插入新裁决前先清掉旧 candidate 行，仅清 candidate
 * （不动 approved/rejected/pending_review 等用户已处置的行）。
 */
export async function deleteCandidatesForJob(db: DbClient, jobId: string): Promise<void> {
  await db.delete(memories).where(and(eq(memories.distillJobId, jobId), eq(memories.status, 'candidate'))).run()
}

export async function getMemoryById(db: DbClient, id: string): Promise<{ memory: Memory } | null> {
  const rows = await db.select().from(memories).where(eq(memories.id, id)).limit(1)
  if (rows.length === 0) return null
  return { memory: rowToMemory(rows[0]) }
}

/**
 * Load approved memories for injection. project scope = exact projectId match;
 * global = all. runtime 不参与匹配（跨 runtime 共享，spec §5）：runtime 列仅作来源
 * 标记（createCandidate 写入不变），claude-code 与 opencode 在同 cwd 互相注入 project
 * 记忆；global 记忆本就全共享。老记忆 runtime=null 本就全共享，行为不变。
 */
export async function listApprovedByScope(
  db: DbClient,
  opts: { projectId: string },
): Promise<InjectableMemorySet> {
  const projectRows = await db.select().from(memories).where(
    and(eq(memories.scopeType, 'project'), eq(memories.scopeId, opts.projectId), eq(memories.status, 'approved')),
  ).orderBy(desc(memories.createdAt))
  const globalRows = await db.select().from(memories).where(
    and(eq(memories.scopeType, 'global'), eq(memories.status, 'approved')),
  ).orderBy(desc(memories.createdAt))
  const toRow = (r: any) => ({
    id: r.id, scopeType: r.scopeType as MemoryScope, scopeId: r.scopeId, runtime: (r.runtime ?? null) as RuntimeTag,
    title: r.title, bodyMd: r.bodyMd, createdAt: r.createdAt, version: r.version, tags: parseTags(r.tags),
    subjectSlug: r.subjectSlug ?? null,
  })
  return {
    byScope: {
      project: projectRows.map(toRow),
      global: globalRows.map(toRow),
    },
  }
}

/** 无 slug fallback 上限（slug 预筛路径不限条数）。spec §3.3 合并步按 subjectSlug
 *  预筛 existing：本批 slugs 非空 → inArray(subjectSlug, slugs) 不限条数，解除
 *  旧 50 条盲区；slugs 空 → fallback 最近 N 防爆 prompt（保留旧行为）。 */
export const DEDUP_EXISTING_LIMIT = 50

export const SUBJECT_SLUG_LIST_LIMIT = 50

/**
 * 列出某 scope 下候选+已审批记忆已用的 subject slug（去重、字母序、LIMIT 50）。
 * scheduler 蒸馏前注入 distiller prompt，促进模型复用既有主题、对抗同义碎裂
 * （spec D3）。project = 精确 scopeId；global = scopeId IS NULL
 * （与 listForDedupByScope 同规则）。
 */
export async function listSubjectSlugs(
  db: DbClient,
  opts: { scopeType: MemoryScope; scopeId: string | null },
): Promise<string[]> {
  const scopeClause = opts.scopeId === null ? isNull(memories.scopeId) : eq(memories.scopeId, opts.scopeId)
  const rows = await db.selectDistinct({ slug: memories.subjectSlug }).from(memories).where(
    and(
      eq(memories.scopeType, opts.scopeType),
      scopeClause,
      inArray(memories.status, ['candidate', 'approved']),
      isNotNull(memories.subjectSlug),
    ),
  ).orderBy(asc(memories.subjectSlug)).limit(SUBJECT_SLUG_LIST_LIMIT).all()
  return rows.map((r) => r.slug).filter((s): s is string => typeof s === 'string')
}

/**
 * Load same-scope candidate + approved memories for dedup comparison. project =
 * exact scopeId match; global = scopeId IS NULL. Returns approved (all) + candidate
 * (spec §3.3：本批 slugs 非空 → inArray(subjectSlug, slugs) 不限条数，解除 50 条盲区；
 * slugs 空 → fallback createdAt DESC LIMIT DEDUP_EXISTING_LIMIT), de-duped by id,
 * projecting {id,title,bodyMd,scopeType,scopeId,status,subjectSlug} (no runtime;
 * bodyMd + subjectSlug now included so cross-batch dedup sees full context per
 * spec §3.4 / §3.3). Other statuses (archived/rejected/superseded) excluded.
 */
export async function listForDedupByScope(
  db: DbClient,
  opts: { scopeType: MemoryScope; scopeId: string | null; slugs?: string[] },
): Promise<ExistingMemoryForDedup[]> {
  const scopeClause = opts.scopeId === null ? isNull(memories.scopeId) : eq(memories.scopeId, opts.scopeId)
  const cols = { id: memories.id, title: memories.title, bodyMd: memories.bodyMd, scopeType: memories.scopeType, scopeId: memories.scopeId, status: memories.status, subjectSlug: memories.subjectSlug }
  // approved 全量（不变）
  const approvedRows = await db.select(cols).from(memories).where(
    and(eq(memories.scopeType, opts.scopeType), scopeClause, eq(memories.status, 'approved')),
  ).orderBy(desc(memories.createdAt)).all()
  // candidate：本批有 slug → 只取同 slug（不限条数）；无 slug → fallback 最近 50
  const slugs = opts.slugs ?? []
  let candidateRows
  if (slugs.length > 0) {
    candidateRows = await db.select(cols).from(memories).where(
      and(eq(memories.scopeType, opts.scopeType), scopeClause, eq(memories.status, 'candidate'), inArray(memories.subjectSlug, slugs)),
    ).orderBy(desc(memories.createdAt)).all()
  } else {
    candidateRows = await db.select(cols).from(memories).where(
      and(eq(memories.scopeType, opts.scopeType), scopeClause, eq(memories.status, 'candidate')),
    ).orderBy(desc(memories.createdAt)).limit(DEDUP_EXISTING_LIMIT).all()
  }
  const seen = new Set<string>()
  const out: ExistingMemoryForDedup[] = []
  for (const r of [...approvedRows, ...candidateRows]) {
    if (seen.has(r.id)) continue
    seen.add(r.id)
    out.push({ id: r.id, title: r.title, bodyMd: r.bodyMd, scopeType: r.scopeType as MemoryScope, scopeId: r.scopeId, status: r.status as MemoryStatus, subjectSlug: r.subjectSlug as string | null })
  }
  return out
}

// canTransition (defined in pure.ts) is the authoritative state-machine
// definition. The store's write paths use SPECIFIC source-status checks above
// (promote must come from 'candidate', archive from 'approved', unarchive from
// 'archived') because each function's semantics require a specific source, not
// just any legal transition - see I3 regression. canTransition is re-exported
// here for downstream tasks and stays covered by pure-statemachine.test.ts.
export { canTransition }

// ---------------------------------------------------------------------------
// Write path: promote (approve / approve_and_supersede / reject) + patch + archive.
//
// All write paths run inside a SYNCHRONOUS `db.transaction((tx) => { ... })`.
// bun:sqlite is synchronous, so `tx.select()...all()` and `tx.update()...run()`
// return their values directly - do NOT `await` inside the callback. The
// transaction guarantees atomicity of the promote -> mark-superseded pair: if
// any guard throws, the whole transaction rolls back and no partial state is
// committed.
// ---------------------------------------------------------------------------

export class MemoryConflictError extends Error {}
export class MemoryNotFoundError extends Error {}

export type PromoteAction =
  | { action: 'approve'; tagsOverride?: string[] }
  | { action: 'approve_and_supersede'; supersedeIds: string[]; tagsOverride?: string[] }
  | { action: 'reject' }

export async function promoteCandidate(db: DbClient, id: string, body: PromoteAction): Promise<Memory> {
  return db.transaction((tx) => {
    const rows = tx.select().from(memories).where(eq(memories.id, id)).limit(1).all()
    if (rows.length === 0) throw new MemoryNotFoundError(`memory ${id} not found`)
    const cand = rows[0]!
    // Specific-source guard (I3): promoteCandidate must only accept
    // status === 'candidate' (or 'pending_review' — spec §6.4 用户手动接管审批)。
    // The general canTransition('archived','approved') is also true, so a general
    // check would silently promote an ARCHIVED memory (resetting version to 1,
    // overwriting approvedAt) instead of throwing.
    if (cand.status !== 'candidate' && cand.status !== 'pending_review') {
      throw new MemoryConflictError(`memory ${id} is '${cand.status}', not 'candidate'`)
    }
    if (body.action === 'reject') {
      tx.update(memories).set({ status: 'rejected' }).where(eq(memories.id, id)).run()
    } else {
      const supersedeIds = body.action === 'approve_and_supersede' ? body.supersedeIds : []
      let nextVersion = 1
      if (supersedeIds.length > 0) {
        const targets = tx.select().from(memories).where(inArray(memories.id, supersedeIds)).all()
        if (targets.length !== supersedeIds.length) throw new MemoryNotFoundError('supersede target not found')
        for (const t of targets) {
          if (t.status !== 'approved') throw new MemoryConflictError(`target ${t.id} not approved`)
          if (t.scopeType !== cand.scopeType || t.scopeId !== cand.scopeId) {
            throw new MemoryConflictError(`target ${t.id} scope mismatch`)
          }
        }
        nextVersion = targets.reduce((mx, t) => ((t.version as number) > mx ? (t.version as number) : mx), 0) + 1
        tx.update(memories).set({ status: 'superseded', supersededById: id }).where(inArray(memories.id, supersedeIds)).run()
      }
      const tagsForRow = body.tagsOverride !== undefined ? JSON.stringify(body.tagsOverride) : cand.tags
      tx.update(memories).set({
        status: 'approved', approvedAt: Date.now(), version: nextVersion,
        supersedesId: supersedeIds[0] ?? null, tags: tagsForRow,
      }).where(eq(memories.id, id)).run()
    }
    const after = tx.select().from(memories).where(eq(memories.id, id)).limit(1).all()
    return rowToMemory(after[0]!)
  })
}

export interface PatchInput {
  scopeType?: MemoryScope
  scopeId?: string | null
  title?: string
  bodyMd?: string
  tags?: string[]
  /** 传 string 校验格式（非法抛 MemoryConflictError）；传 null 移出分组；不传不改。 */
  subjectSlug?: string | null
}

export async function patchMemory(
  db: DbClient, id: string, input: PatchInput,
): Promise<{ memory: Memory; changedFields: string[] }> {
  return db.transaction((tx) => {
    const rows = tx.select().from(memories).where(eq(memories.id, id)).limit(1).all()
    if (rows.length === 0) throw new MemoryNotFoundError(`memory ${id} not found`)
    const row = rows[0]!
    // Editability guard (not a transition): terminal statuses (superseded,
    // rejected) have no outgoing transitions in the state machine and cannot be
    // edited. This is intentionally a "can this row be mutated at all" check,
    // not a specific from->to transition - see canTransition in pure.ts.
    if (row.status === 'superseded' || row.status === 'rejected') {
      throw new MemoryConflictError(`memory ${id} is terminal ('${row.status}')`)
    }
    const changed: string[] = []
    const set: Record<string, unknown> = {}
    if (input.scopeType !== undefined && input.scopeType !== row.scopeType) {
      changed.push('scopeType')
      set.scopeType = input.scopeType
      if (input.scopeType === 'global') {
        // global ⇒ scopeId must be null (CHECK invariant); auto-clear so a
        // scopeType-only patch can't leave a stale scopeId that violates it.
        if (row.scopeId !== null) { changed.push('scopeId'); set.scopeId = null }
      } else {
        // project ⇒ scopeId must be non-null; fall back to the memory's
        // source cwd (origin project), else require an explicit scopeId.
        const desired = input.scopeId !== undefined ? input.scopeId : (row.sourceCwd ?? null)
        if (desired === null) {
          throw new MemoryConflictError('project scope requires a sourceCwd or explicit scopeId')
        }
        if (desired !== (row.scopeId ?? null)) { changed.push('scopeId'); set.scopeId = desired }
      }
    } else if (input.scopeId !== undefined && input.scopeId !== (row.scopeId ?? null)) {
      // scopeId-only change (pre-existing capability): enforce the CHECK
      // invariant for the unchanged scopeType.
      if (row.scopeType === 'global' && input.scopeId !== null) {
        throw new MemoryConflictError('global scope requires null scopeId')
      }
      if (row.scopeType === 'project' && input.scopeId === null) {
        throw new MemoryConflictError('project scope requires non-null scopeId')
      }
      changed.push('scopeId')
      set.scopeId = input.scopeId
    }
    if (input.title !== undefined && input.title !== row.title) { changed.push('title'); set.title = input.title }
    if (input.bodyMd !== undefined && input.bodyMd !== row.bodyMd) { changed.push('bodyMd'); set.bodyMd = input.bodyMd }
    if (input.tags !== undefined) {
      const cur = parseTags(row.tags as string)
      const same = input.tags.length === cur.length && [...input.tags].sort().join() === [...cur].sort().join()
      if (!same) { changed.push('tags'); set.tags = JSON.stringify(input.tags) }
    }
    if (input.subjectSlug !== undefined) {
      if (input.subjectSlug !== null && normalizeSubjectSlug(input.subjectSlug) === null) {
        throw new MemoryConflictError(`invalid subjectSlug: ${JSON.stringify(input.subjectSlug)}`)
      }
      const nextSlug = input.subjectSlug === null ? null : normalizeSubjectSlug(input.subjectSlug)
      if (nextSlug !== (row.subjectSlug ?? null)) {
        changed.push('subjectSlug')
        set.subjectSlug = nextSlug
      }
    }
    // Idempotent no-op: return unchanged row, no version bump, no write, no WS.
    if (changed.length === 0) return { memory: rowToMemory(row), changedFields: [] }
    set.version = (row.version as number) + 1
    tx.update(memories).set(set as Partial<typeof memories.$inferInsert>).where(eq(memories.id, id)).run()
    const after = tx.select().from(memories).where(eq(memories.id, id)).limit(1).all()
    return { memory: rowToMemory(after[0]!), changedFields: changed }
  })
}

export async function archiveMemory(db: DbClient, id: string): Promise<Memory> {
  return db.transaction((tx) => {
    const rows = tx.select().from(memories).where(eq(memories.id, id)).limit(1).all()
    if (rows.length === 0) throw new MemoryNotFoundError(`memory ${id} not found`)
    // Specific-source guard (I3): archive must only accept status === 'approved'.
    // canTransition(status,'archived') happens to only be true for approved, but
    // keep the specific check for consistency with promote/unarchive semantics.
    if (rows[0]!.status !== 'approved') {
      throw new MemoryConflictError(`memory ${id} is '${rows[0]!.status}', not 'approved'`)
    }
    tx.update(memories).set({ status: 'archived' }).where(eq(memories.id, id)).run()
    return rowToMemory(tx.select().from(memories).where(eq(memories.id, id)).limit(1).all()[0]!)
  })
}

export async function unarchiveMemory(db: DbClient, id: string): Promise<Memory> {
  return db.transaction((tx) => {
    const rows = tx.select().from(memories).where(eq(memories.id, id)).limit(1).all()
    if (rows.length === 0) throw new MemoryNotFoundError(`memory ${id} not found`)
    // Specific-source guard (I3): unarchive must only accept status === 'archived'.
    // canTransition('candidate','approved') is true, so a general check would
    // silently approve a CANDIDATE (bypassing the promote flow). Lock the source.
    if (rows[0]!.status !== 'archived') {
      throw new MemoryConflictError(`memory ${id} is '${rows[0]!.status}', not 'archived'`)
    }
    tx.update(memories).set({ status: 'approved' }).where(eq(memories.id, id)).run()
    return rowToMemory(tx.select().from(memories).where(eq(memories.id, id)).limit(1).all()[0]!)
  })
}

export async function restoreMemory(db: DbClient, id: string): Promise<Memory> {
  return db.transaction((tx) => {
    const rows = tx.select().from(memories).where(eq(memories.id, id)).limit(1).all()
    if (rows.length === 0) throw new MemoryNotFoundError(`memory ${id} not found`)
    // Specific-source guard (I3): restore must only accept status === 'rejected'.
    // canTransition('rejected','candidate') is now true, but keep the specific
    // check for consistency with archive/unarchive semantics.
    if (rows[0]!.status !== 'rejected') {
      throw new MemoryConflictError(`memory ${id} is '${rows[0]!.status}', not 'rejected'`)
    }
    tx.update(memories).set({ status: 'candidate', approvedAt: null }).where(eq(memories.id, id)).run()
    return rowToMemory(tx.select().from(memories).where(eq(memories.id, id)).limit(1).all()[0]!)
  })
}

export interface DiscardRecord {
  title: string
  bodyMd: string
  reason: DiscardReason
  scopeType: 'project' | 'global'
  scopeId: string | null
  sourceCwd: string | null
  runtime: RuntimeTag
  sourceKind: 'conversation' | 'subagent'
}

/**
 * Persist value-filter-discarded candidates to the memory_discards audit table.
 * Best-effort: caller (scheduler.tick) swallows thrown errors so an audit-log
 * failure never blocks distill or retries the job. No-op on empty list.
 */
export async function logDiscards(
  db: DbClient,
  distillJobId: string,
  discards: DiscardRecord[],
): Promise<void> {
  if (discards.length === 0) return
  const ts = Date.now()
  await db.insert(memoryDiscards).values(
    discards.map((d) => ({
      id: ulid(), distillJobId, title: d.title, bodyMd: d.bodyMd, reason: d.reason, ts,
      scopeType: d.scopeType, scopeId: d.scopeId, sourceCwd: d.sourceCwd,
      runtime: d.runtime, sourceKind: d.sourceKind, promotedMemoryId: null,
    })),
  )
}

/**
 * Promote a discarded candidate back into a memory candidate row.
 *
 * 读 discard -> 已提升守卫(MemoryConflictError) -> scope 缺失守卫(MemoryConflictError，
 * 老行迁移前 scope 字段全 NULL，不反查 job 回填，spec 非目标) -> createCandidate(自带事务)
 * -> 回填 promoted_memory_id。不删 discard 行（审计保留）。幂等：并发两次提升只有一次能
 * 回填（UPDATE … WHERE promoted_memory_id IS NULL）；落败方查到的 candidate 仍在，但下次
 * promote 会被开头的 promotedMemoryId 守卫挡住。not found 抛 MemoryNotFoundError。
 */
export async function promoteDiscard(db: DbClient, id: string): Promise<Memory> {
  // 1. 读 discard 行 + 守卫（单次 select）
  const rows = await db.select().from(memoryDiscards).where(eq(memoryDiscards.id, id)).limit(1)
  if (rows.length === 0) throw new MemoryNotFoundError(`discard ${id} not found`)
  const d = rows[0]!
  if (d.promotedMemoryId !== null) {
    throw new MemoryConflictError(`discard ${id} already promoted to ${d.promotedMemoryId}`)
  }
  // 老行（迁移前）scope 字段全 NULL -> 无法提升（不反查 job 回填，spec 非目标）
  if (d.scopeType === null || (d.scopeType === 'project' && d.scopeId === null)) {
    throw new MemoryConflictError(`discard ${id} missing scope info; cannot promote`)
  }
  // 2. createCandidate（自带事务）
  const mem = await createCandidate(db, {
    scopeType: d.scopeType as 'project' | 'global',
    scopeId: d.scopeId,
    title: d.title,
    bodyMd: d.bodyMd,
    tags: [],
    sourceKind: (d.sourceKind ?? 'conversation') as 'conversation' | 'error' | 'manual' | 'subagent',
    runtime: (d.runtime ?? null) as RuntimeTag,
    sourceCwd: d.sourceCwd,
    distillJobId: d.distillJobId,
    valueClass: null,
    subjectSlug: null,
  })
  // 3. 回填 promoted_memory_id（WHERE promoted_memory_id IS NULL 闭环幂等：
  //    并发两次提升只有一次能回填；落败方查到的 candidate 仍在，但 discard 状态已变，
  //    下次 promote 会被上面的 promotedMemoryId 守卫挡住）
  await db.update(memoryDiscards).set({ promotedMemoryId: mem.id })
    .where(and(eq(memoryDiscards.id, id), isNull(memoryDiscards.promotedMemoryId))).run()
  return mem
}

/** 回扫用:全部候选(createdAt 升序,先老后新)。 */
export async function listAllCandidatesForRescan(db: DbClient): Promise<Memory[]> {
  const rows = await db.select().from(memories).where(eq(memories.status, 'candidate'))
    .orderBy(asc(memories.createdAt)).all()
  return rows.map(rowToMemory)
}

/** 回扫判留回填:只填 NULL 字段(value_class/origin),不覆盖已有值。 */
export async function updateJudgedFields(
  db: DbClient, id: string, patch: { valueClass?: ValueClass | null; origin?: string | null },
): Promise<void> {
  const rows = await db.select().from(memories).where(eq(memories.id, id)).limit(1).all()
  const m = rows[0]
  if (!m) return
  const set: Record<string, unknown> = {}
  if (m.valueClass === null && patch.valueClass !== undefined) set.valueClass = patch.valueClass
  if (m.origin === null && patch.origin) set.origin = patch.origin
  if (Object.keys(set).length > 0) await db.update(memories).set(set).where(eq(memories.id, id)).run()
}

export const DISCARDS_LIST_LIMIT = 200

export interface DiscardRow {
  id: string
  distillJobId: string
  title: string
  bodyMd: string
  reason: string
  ts: number
  scopeType: string | null
  scopeId: string | null
  sourceCwd: string | null
  runtime: string | null
  sourceKind: string | null
  promotedMemoryId: string | null
}

function rowToDiscard(r: any): DiscardRow {
  return {
    id: r.id, distillJobId: r.distillJobId, title: r.title, bodyMd: r.bodyMd, reason: r.reason,
    ts: r.ts, scopeType: r.scopeType ?? null, scopeId: r.scopeId ?? null, sourceCwd: r.sourceCwd ?? null,
    runtime: r.runtime ?? null, sourceKind: r.sourceKind ?? null, promotedMemoryId: r.promotedMemoryId ?? null,
  }
}

export async function listDiscards(
  db: DbClient,
  opts: { limit?: number } = {},
): Promise<DiscardRow[]> {
  const limit = opts.limit ?? DISCARDS_LIST_LIMIT
  const rows = await db.select().from(memoryDiscards).orderBy(desc(memoryDiscards.ts)).limit(limit).all()
  return rows.map(rowToDiscard)
}

// ---------------------------------------------------------------------------
// 第五轮：会话级 turn 偏移（增量蒸馏）。getSessionOffset 无记录返回 0（首次全量）；
// setSessionOffset UPSERT（同 session 二次写覆盖）。偏移是优化非正确性依赖：
// 读写失败由调用方（loadTranscript / tick）catch 降级，不阻塞蒸馏。
// ---------------------------------------------------------------------------

export async function getSessionOffset(db: DbClient, sessionId: string): Promise<number> {
  const rows = await db.select().from(memorySessionOffsets)
    .where(eq(memorySessionOffsets.sessionId, sessionId)).limit(1)
  return rows.length > 0 ? (rows[0]!.lastTurnOffset as number) : 0
}

export async function setSessionOffset(db: DbClient, sessionId: string, offset: number): Promise<void> {
  const now = Date.now()
  await db.insert(memorySessionOffsets).values({ sessionId, lastTurnOffset: offset, updatedAt: now })
    .onConflictDoUpdate({ target: memorySessionOffsets.sessionId, set: { lastTurnOffset: offset, updatedAt: now } })
}

// ---------------------------------------------------------------------------
// 原始输入溯源：蒸馏时把喂给模型的过滤版 turns 快照存 memory_distill_inputs
// （按 distill_job_id，无 FK，与 events 清理债务解耦）。saveSourceInput 是
// best-effort 写（调用方 tick 吞错）；getSourceInput 反序列化失败返回 null。
// ---------------------------------------------------------------------------

export async function saveSourceInput(
  db: DbClient, distillJobId: string, turns: TranscriptTurn[],
): Promise<void> {
  const turnsJson = JSON.stringify(turns)
  const turnCount = turns.length
  const charCount = turns.reduce((s, t) => s + t.content.length, 0)
  const now = Date.now()
  await db.insert(memoryDistillInputs).values({
    distillJobId, turnsJson, turnCount, charCount, ts: now,
  }).onConflictDoUpdate({
    target: memoryDistillInputs.distillJobId,
    set: { turnsJson, turnCount, charCount, ts: now },
  })
}

export async function getSourceInput(
  db: DbClient, distillJobId: string,
): Promise<{ turns: TranscriptTurn[]; turnCount: number; charCount: number } | null> {
  const rows = await db.select().from(memoryDistillInputs)
    .where(eq(memoryDistillInputs.distillJobId, distillJobId)).limit(1)
  if (rows.length === 0) return null
  const r = rows[0]!
  try {
    const parsed = JSON.parse(r.turnsJson)
    if (!Array.isArray(parsed)) return null
    return { turns: parsed as TranscriptTurn[], turnCount: r.turnCount, charCount: r.charCount }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 蒸馏工作记录透明化：每个 distill job 一条 run 记录（outcome + LLM 原始产出 +
// 四道闸计数 + 耗时）。saveDistillRun best-effort 写（调用方 tick 吞错）；
// getDistillRun 反序列化 raw_output_json 失败 -> rawOutput=null（不崩）。
// listRecentDistillRuns 不含 rawOutput（走专用详情端点），JOIN job 元数据。
// ---------------------------------------------------------------------------

export type DistillOutcome = 'skipped_no_new_turns' | 'skipped_trivial' | 'empty_output' | 'llm_error' | 'parse_error' | 'produced'

export interface DistillRunRecord {
  outcome: DistillOutcome
  rawOutput: unknown | null
  rawCount: number
  acceptedCount: number
  dedupedCount: number
  filteredCount: number
  storedCount: number
  discardedCount: number
  durationMs: number
  errorMessage: string | null
  rawText?: string | null
  dedupMs?: number | null
  judgeMs?: number | null
}

export interface DistillRunRow {
  distillJobId: string
  outcome: DistillOutcome
  rawOutput: unknown | null
  rawCount: number
  acceptedCount: number
  dedupedCount: number
  filteredCount: number
  storedCount: number
  discardedCount: number
  durationMs: number
  errorMessage: string | null
  rawText: string | null
  ts: number
  digestMs: number | null
  dedupMs: number | null
  judgeMs: number | null
  /** 暂停在哪步（spec §4.1）；非暂停 NULL。run 行由 markJobPaused best-effort 写入。 */
  pausedStep: string | null
}

export async function saveDistillRun(
  db: DbClient, distillJobId: string, record: DistillRunRecord,
): Promise<void> {
  const now = Date.now()
  const rawOutputJson = record.rawOutput == null ? null : JSON.stringify(record.rawOutput)
  await db.insert(memoryDistillRuns).values({
    distillJobId, outcome: record.outcome, rawOutputJson,
    distilledCount: record.rawCount, acceptedCount: record.acceptedCount,
    dedupedCount: record.dedupedCount, filteredCount: record.filteredCount,
    storedCount: record.storedCount, discardedCount: record.discardedCount,
    durationMs: record.durationMs, errorMessage: record.errorMessage, ts: now,
    rawText: record.rawText ?? null,
    dedupMs: record.dedupMs ?? null, judgeMs: record.judgeMs ?? null,
  }).onConflictDoUpdate({
    target: memoryDistillRuns.distillJobId,
    set: { outcome: record.outcome, rawOutputJson, distilledCount: record.rawCount,
      acceptedCount: record.acceptedCount, dedupedCount: record.dedupedCount,
      filteredCount: record.filteredCount, storedCount: record.storedCount,
      discardedCount: record.discardedCount, durationMs: record.durationMs,
      errorMessage: record.errorMessage, ts: now,
      rawText: record.rawText ?? null,
      dedupMs: record.dedupMs ?? null, judgeMs: record.judgeMs ?? null },
  })
}

function rowToRun(r: any): DistillRunRow {
  let rawOutput: unknown = null
  if (r.rawOutputJson != null) {
    try { rawOutput = JSON.parse(r.rawOutputJson) } catch { rawOutput = null }
  }
  return {
    distillJobId: r.distillJobId, outcome: r.outcome as DistillOutcome, rawOutput,
    rawCount: r.distilledCount, acceptedCount: r.acceptedCount, dedupedCount: r.dedupedCount,
    filteredCount: r.filteredCount, storedCount: r.storedCount, discardedCount: r.discardedCount,
    durationMs: r.durationMs, errorMessage: r.errorMessage ?? null, ts: r.ts,
    rawText: r.rawText ?? null,
    digestMs: r.digestMs ?? null, dedupMs: r.dedupMs ?? null, judgeMs: r.judgeMs ?? null,
    pausedStep: r.pausedStep ?? null,
  }
}

export async function getDistillRun(db: DbClient, distillJobId: string): Promise<DistillRunRow | null> {
  const rows = await db.select().from(memoryDistillRuns)
    .where(eq(memoryDistillRuns.distillJobId, distillJobId)).limit(1)
  return rows.length === 0 ? null : rowToRun(rows[0])
}

export const DISTILL_RUNS_LIST_LIMIT = 200

export interface DistillRunListRow {
  distillJobId: string
  outcome: DistillOutcome
  rawCount: number
  acceptedCount: number
  dedupedCount: number
  filteredCount: number
  storedCount: number
  discardedCount: number
  durationMs: number
  errorMessage: string | null
  ts: number
  cwd: string | null
  runtime: string
  createdAt: number
  sourceAgentId: string | null
  /** spec §4.9 runs 行降级徽标：该 job 在 memory_degradations 有行（明细走 modal 懒加载）。 */
  hasDegradations: boolean
  /** spec §4.1 暂停在哪步；非暂停 NULL（runs 表 paused_step 列）。 */
  pausedStep: string | null
  /** job 整体尝试轮次（attempts 列，spec §6 重试轮次显示）。孤儿 run=0。 */
  attempts: number
  /** 当前步骤失败计数（step_attempts 列，final-fix-3：暂停徽标读真实步骤重试轮次，
   *  非 attempts——后者仅外层 catch 累加，LLM 步骤失败不动）。孤儿 run=0。 */
  stepAttempts: number
  /** 当前断点步骤（current_step 列，final-fix-3：状态栏「某步骤第 N 轮重试中」用）。
   *  孤儿 run=null（新任务语义同 'distill'，但 UI 仅在非空时显示）。 */
  currentStep: string | null
}

const RUN_LIST_COLS = {
  distillJobId: memoryDistillRuns.distillJobId, outcome: memoryDistillRuns.outcome,
  rawCount: memoryDistillRuns.distilledCount, acceptedCount: memoryDistillRuns.acceptedCount,
  dedupedCount: memoryDistillRuns.dedupedCount, filteredCount: memoryDistillRuns.filteredCount,
  storedCount: memoryDistillRuns.storedCount, discardedCount: memoryDistillRuns.discardedCount,
  durationMs: memoryDistillRuns.durationMs, errorMessage: memoryDistillRuns.errorMessage,
  ts: memoryDistillRuns.ts,
  pausedStep: memoryDistillRuns.pausedStep,
}

interface RunListBaseRow {
  distillJobId: string
  outcome: string
  rawCount: number
  acceptedCount: number
  dedupedCount: number
  filteredCount: number
  storedCount: number
  discardedCount: number
  durationMs: number
  errorMessage: string | null
  ts: number
  pausedStep: string | null
}

/** run 行（已按 ts/id 排好序、已截页）拼 job 元数据；孤儿 run（job 已删）-> cwd=null / createdAt=0。 */
async function attachRunJobMeta(
  db: DbClient,
  runRows: RunListBaseRow[],
): Promise<DistillRunListRow[]> {
  if (runRows.length === 0) return []
  const jobIds = runRows.map((r) => r.distillJobId)
  const jobRows = await db.select().from(memoryDistillJobs)
    .where(inArray(memoryDistillJobs.id, jobIds)).all()
  const jobById = new Map(jobRows.map((j) => [j.id, j]))
  // hasDegradations（spec §4.9）：inArray 二次查询带出（同 job 元数据模式，
  // 查询数 O(1)，走 idx_degradations_job），Set 去重。null distillJobId 行不参与匹配。
  const degRows = await db.select({ distillJobId: memoryDegradations.distillJobId })
    .from(memoryDegradations)
    .where(inArray(memoryDegradations.distillJobId, jobIds)).all()
  const degJobIds = new Set(degRows.map((d) => d.distillJobId))
  return runRows.map((r) => {
    const j = jobById.get(r.distillJobId)
    return {
      distillJobId: r.distillJobId, outcome: r.outcome as DistillOutcome,
      rawCount: r.rawCount, acceptedCount: r.acceptedCount, dedupedCount: r.dedupedCount,
      filteredCount: r.filteredCount, storedCount: r.storedCount, discardedCount: r.discardedCount,
      durationMs: r.durationMs, errorMessage: r.errorMessage ?? null, ts: r.ts,
      cwd: j?.cwd ?? null, runtime: j?.runtime ?? '', createdAt: j?.createdAt ?? 0,
      sourceAgentId: j?.sourceAgentId ?? null,
      hasDegradations: degJobIds.has(r.distillJobId),
      pausedStep: r.pausedStep ?? null,
      attempts: j?.attempts ?? 0,
      stepAttempts: j?.stepAttempts ?? 0,
      currentStep: j?.currentStep ?? null,
    }
  })
}

/**
 * 最近 N 条 run（ts DESC，默认 200）。不含 rawOutput（走 GET /api/distill-runs/:jobId）。
 * job 元数据（cwd/runtime/createdAt/sourceAgentId）与 hasDegradations（spec §4.9 行徽标）
 * 通过 inArray 二次查询带出，避免 drizzle JOIN 结果键名不确定性。
 * 孤儿 run（job 已删）-> cwd=null / createdAt=0。
 */
export async function listRecentDistillRuns(
  db: DbClient, opts: { limit?: number } = {},
): Promise<DistillRunListRow[]> {
  const limit = opts.limit ?? DISTILL_RUNS_LIST_LIMIT
  const runRows = await db.select(RUN_LIST_COLS).from(memoryDistillRuns)
    .orderBy(desc(memoryDistillRuns.ts)).limit(limit).all()
  return attachRunJobMeta(db, runRows)
}

// ---------------------------------------------------------------------------
// 五 tab 无限滚动分页（spec 2026-08-07）：复合游标 (sortTs, id) + limit+1 探测
// hasMore。schema created_at/ts 均 notNull，无需 COALESCE。旧全量/LIMIT-200
// 函数保留（无 limit 参数的兼容路径继续用），分页函数并列新增。
// ---------------------------------------------------------------------------

export interface PageCursor { ts: number; id: string }
export interface Page<T> { items: T[]; hasMore: boolean; nextCursor: PageCursor | null }

/** 带全表匹配计数的分页（memories/discards 筛选用；distill runs 不带）。 */
export interface PageWithTotal<T> extends Page<T> { total: number }

export const MEMORY_PAGE_DEFAULT_LIMIT = 20
export const MEMORY_PAGE_MAX_LIMIT = 200

/** limit clamp 到 [1, 200]；undefined/NaN -> 默认 50。 */
export function clampPageLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return MEMORY_PAGE_DEFAULT_LIMIT
  return Math.min(Math.max(Math.floor(limit), 1), MEMORY_PAGE_MAX_LIMIT)
}

// ---------------------------------------------------------------------------
// 四维服务端筛选（spec 2026-08-11-web-memory-filters §4.1）
// ---------------------------------------------------------------------------

/** valueClass 筛「未评估」的哨兵值（= value_class IS NULL）。六个合法
 *  value_class 里没有这个词，URL/接口层无歧义。 */
export const VALUE_CLASS_UNEVALUATED = 'unevaluated'

/** origin 筛「未标注」的哨兵值（= origin IS NULL）。三个合法 origin 值里
 *  没有这个词，URL/接口层无歧义；与 VALUE_CLASS_UNEVALUATED 同款模式。 */
export const ORIGIN_UNLABELED = 'unlabeled'

/** 3 个保护类 origin（= schema memories.origin 的合法枚举；spec §接口契约）。
 *  其余 origin 值视为非法，筛选取宽松策略忽略该条件（不报错不空列表）。 */
export const PROTECTED_ORIGINS: readonly string[] = [
  'user-stated', 'user-confirmed', 'agent-observed',
]

export interface MemoryListFilter {
  /** memories.source_cwd / discards.source_cwd 精确匹配。 */
  sourceCwd?: string
  /** memories.subject_slug 精确匹配（discards 无此列，忽略）。 */
  subjectSlug?: string
  /** instr(title, '[category:X]') > 0（带闭括号精确子串）。 */
  category?: string
  /** 'unevaluated' 哨兵 -> IS NULL；合法六值 -> eq；其余值忽略（宽松）。 */
  valueClass?: string
  /** 'unlabeled' 哨兵 -> IS NULL；合法三值（PROTECTED_ORIGINS）-> eq；
   *  其余值忽略（宽松，与 valueClass 同策略；discards 无 origin 列，静默忽略）。 */
  origin?: string
}

function memoryFilterConds(filter?: MemoryListFilter) {
  const conds: any[] = []
  if (!filter) return conds
  if (filter.sourceCwd) conds.push(eq(memories.sourceCwd, filter.sourceCwd))
  if (filter.subjectSlug) conds.push(eq(memories.subjectSlug, filter.subjectSlug))
  if (filter.category) {
    conds.push(sql`instr(${memories.title}, ${'[category:' + filter.category + ']'}) > 0`)
  }
  if (filter.valueClass) {
    if (filter.valueClass === VALUE_CLASS_UNEVALUATED) conds.push(isNull(memories.valueClass))
    else if ((PROTECTED_VALUE_CLASSES as readonly string[]).includes(filter.valueClass)) {
      conds.push(eq(memories.valueClass, filter.valueClass))
    }
    // 其余值 -> 忽略该条件（白名单宽松策略，与非法 status 同风格，spec §4.2）
  }
  if (filter.origin) {
    if (filter.origin === ORIGIN_UNLABELED) conds.push(isNull(memories.origin))
    else if ((PROTECTED_ORIGINS as readonly string[]).includes(filter.origin)) {
      conds.push(eq(memories.origin, filter.origin))
    }
    // 其余值 -> 忽略该条件（白名单宽松策略，与 valueClass 同款）
  }
  return conds
}

function discardFilterConds(filter?: MemoryListFilter) {
  const conds: any[] = []
  if (!filter) return conds
  if (filter.sourceCwd) conds.push(eq(memoryDiscards.sourceCwd, filter.sourceCwd))
  if (filter.category) {
    conds.push(sql`instr(${memoryDiscards.title}, ${'[category:' + filter.category + ']'}) > 0`)
  }
  return conds
}

export async function listMemoriesPage(
  db: DbClient,
  opts: { statuses: MemoryStatus[]; limit?: number; before?: PageCursor; filter?: MemoryListFilter },
): Promise<PageWithTotal<Memory>> {
  const limit = clampPageLimit(opts.limit)
  const baseConds = []
  if (opts.statuses.length > 0) baseConds.push(inArray(memories.status, opts.statuses))
  baseConds.push(...memoryFilterConds(opts.filter))
  const conds = [...baseConds]
  if (opts.before) {
    conds.push(or(
      lt(memories.createdAt, opts.before.ts),
      and(eq(memories.createdAt, opts.before.ts), lt(memories.id, opts.before.id)),
    ))
  }
  const rows = await db.select().from(memories)
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(desc(memories.createdAt), desc(memories.id))
    .limit(limit + 1).all()
  // total 与筛选条件同 WHERE、不含游标（游标只切页不切计数）
  const countRows = await db.select({ n: sql<number>`COUNT(*)` }).from(memories)
    .where(baseConds.length > 0 ? and(...baseConds) : undefined).all()
  const hasMore = rows.length > limit
  const pageRows = rows.slice(0, limit)
  const last = pageRows[pageRows.length - 1]
  return {
    items: pageRows.map(rowToMemory),
    hasMore,
    nextCursor: hasMore && last ? { ts: last.createdAt, id: last.id } : null,
    total: Number(countRows[0]?.n ?? 0),
  }
}

export async function listDiscardsPage(
  db: DbClient,
  opts: { limit?: number; before?: PageCursor; filter?: MemoryListFilter } = {},
): Promise<PageWithTotal<DiscardRow>> {
  const limit = clampPageLimit(opts.limit)
  const baseConds = discardFilterConds(opts.filter)
  const conds = [...baseConds]
  if (opts.before) {
    conds.push(or(
      lt(memoryDiscards.ts, opts.before.ts),
      and(eq(memoryDiscards.ts, opts.before.ts), lt(memoryDiscards.id, opts.before.id)),
    ))
  }
  const rows = await db.select().from(memoryDiscards)
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(desc(memoryDiscards.ts), desc(memoryDiscards.id))
    .limit(limit + 1).all()
  const countRows = await db.select({ n: sql<number>`COUNT(*)` }).from(memoryDiscards)
    .where(baseConds.length > 0 ? and(...baseConds) : undefined).all()
  const hasMore = rows.length > limit
  const pageRows = rows.slice(0, limit)
  const last = pageRows[pageRows.length - 1]
  return {
    items: pageRows.map(rowToDiscard),
    hasMore,
    nextCursor: hasMore && last ? { ts: last.ts, id: last.id } : null,
    total: Number(countRows[0]?.n ?? 0),
  }
}

export async function listDistillRunsPage(
  db: DbClient,
  opts: { limit?: number; before?: PageCursor } = {},
): Promise<Page<DistillRunListRow>> {
  const limit = clampPageLimit(opts.limit)
  const conds = opts.before
    ? [or(
        lt(memoryDistillRuns.ts, opts.before.ts),
        and(eq(memoryDistillRuns.ts, opts.before.ts), lt(memoryDistillRuns.distillJobId, opts.before.id)),
      )]
    : []
  const runRows = await db.select(RUN_LIST_COLS).from(memoryDistillRuns)
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(desc(memoryDistillRuns.ts), desc(memoryDistillRuns.distillJobId))
    .limit(limit + 1).all()
  const hasMore = runRows.length > limit
  const pageRows = runRows.slice(0, limit)
  const last = pageRows[pageRows.length - 1]
  return {
    items: await attachRunJobMeta(db, pageRows),
    hasMore,
    nextCursor: hasMore && last ? { ts: last.ts, id: last.distillJobId } : null,
  }
}

// ---------------------------------------------------------------------------
// 四维筛选下拉选项，按 tab scope（spec 2026-08-11-per-tab-memory-filters §4.1）
// ---------------------------------------------------------------------------

export interface FacetValue { value: string; count: number }
export interface Facets {
  projects: FacetValue[]
  categories: FacetValue[]
  slugs: FacetValue[]
  valueClasses: FacetValue[]
  /** memories scope: origin 分组（NULL → ORIGIN_UNLABELED 桶）；discards scope: []（无 origin 列）。 */
  origins: FacetValue[]
}
export const FACET_LIST_CAP = 200

/**
 * facets 统计范围：kind='memories' 只统计给定 statuses 的行；kind='discards'
 * 只查 memory_discards 表（该表无 slug/value_class 列，两组返回空）。
 * 推翻 2026-08-11-web-memory-filters 决策 D2 的全局口径（两表 UNION）：
 * 每个 tab 的下拉只列本 tab 数据里真实存在的值。
 */
export type FacetScope =
  | { kind: 'memories'; statuses: MemoryStatus[] }
  | { kind: 'discards' }

function sortFacets(m: Map<string, number>): FacetValue[] {
  return [...m.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0))
    .slice(0, FACET_LIST_CAP)
}

/**
 * 四维筛选的下拉选项（按 scope）：value_class NULL 聚成 VALUE_CLASS_UNEVALUATED 桶；
 * 各组 count 降序、同 count 按 value 字母序，截 FACET_LIST_CAP。
 * 调用方保证 memories scope 的 statuses 非空（server 层校验非法/缺失 tab -> 400）。
 */
export async function listFacets(db: DbClient, scope: FacetScope): Promise<Facets> {
  const bump = (m: Map<string, number>, v: string, n: number) => m.set(v, (m.get(v) ?? 0) + n)

  if (scope.kind === 'discards') {
    const projects = new Map<string, number>()
    const disProj = await db.select({ v: memoryDiscards.sourceCwd, n: sql<number>`COUNT(*)` })
      .from(memoryDiscards).where(isNotNull(memoryDiscards.sourceCwd)).groupBy(memoryDiscards.sourceCwd).all()
    for (const r of disProj) if (r.v) bump(projects, r.v, Number(r.n))
    const cats = new Map<string, number>()
    const disTitles = await db.select({ t: memoryDiscards.title }).from(memoryDiscards).all()
    for (const r of disTitles) {
      const c = categoryFromTitle(r.t)
      if (c) bump(cats, c, 1)
    }
    return { projects: sortFacets(projects), categories: sortFacets(cats), slugs: [], valueClasses: [], origins: [] }
  }

  const statusCond = inArray(memories.status, scope.statuses)
  const projects = new Map<string, number>()
  const memProj = await db.select({ v: memories.sourceCwd, n: sql<number>`COUNT(*)` })
    .from(memories).where(and(isNotNull(memories.sourceCwd), statusCond)).groupBy(memories.sourceCwd).all()
  for (const r of memProj) if (r.v) bump(projects, r.v, Number(r.n))

  const cats = new Map<string, number>()
  const memTitles = await db.select({ t: memories.title }).from(memories).where(statusCond).all()
  for (const r of memTitles) {
    const c = categoryFromTitle(r.t)
    if (c) bump(cats, c, 1)
  }

  const slugs = new Map<string, number>()
  const slugRows = await db.select({ v: memories.subjectSlug, n: sql<number>`COUNT(*)` })
    .from(memories).where(and(isNotNull(memories.subjectSlug), statusCond)).groupBy(memories.subjectSlug).all()
  for (const r of slugRows) if (r.v) bump(slugs, r.v, Number(r.n))

  const vcs = new Map<string, number>()
  const vcRows = await db.select({ v: memories.valueClass, n: sql<number>`COUNT(*)` })
    .from(memories).where(statusCond).groupBy(memories.valueClass).all()
  for (const r of vcRows) bump(vcs, r.v ?? VALUE_CLASS_UNEVALUATED, Number(r.n))

  const origins = new Map<string, number>()
  const originRows = await db.select({ v: memories.origin, n: sql<number>`COUNT(*)` })
    .from(memories).where(statusCond).groupBy(memories.origin).all()
  for (const r of originRows) bump(origins, r.v ?? ORIGIN_UNLABELED, Number(r.n))

  return {
    projects: sortFacets(projects),
    categories: sortFacets(cats),
    slugs: sortFacets(slugs),
    valueClasses: sortFacets(vcs),
    origins: sortFacets(origins),
  }
}

/** 6 个保护类 valueClass（= 前端 valueClassInfo 的 6 个标准筐）；其余候选视为「未评估」。 */
export const PROTECTED_VALUE_CLASSES: readonly string[] = [
  'user-rule', 'decision', 'preference', 'convention', 'trap', 'topology',
]

/**
 * 服务端按条件批量拒绝「未评估」候选（spec 2026-08-07 决策 4）：分页后前端只加载
 * 第一页，批量拒绝必须覆盖整个尾队。逐行走既有 promoteCandidate 路径（状态机 +
 * 审计一致）；not-found/终态竞态跳过继续（与 server bulk-promote 同款容错）。
 */
export async function bulkRejectUnevaluated(db: DbClient): Promise<{ rejected: number }> {
  const rows = await db.select({ id: memories.id }).from(memories)
    .where(and(
      eq(memories.status, 'candidate'),
      or(isNull(memories.valueClass), notInArray(memories.valueClass, [...PROTECTED_VALUE_CLASSES])),
    )).all()
  let rejected = 0
  for (const r of rows) {
    try {
      await promoteCandidate(db, r.id, { action: 'reject' })
      rejected += 1
    } catch {
      // 并发下已被处置的行跳过，继续其余
    }
  }
  return { rejected }
}

// ---------------------------------------------------------------------------
// 攒量批处理（spec §4.4）：waiting job / event upsert / flush / digest / degradations。
// ---------------------------------------------------------------------------

export interface DistillJobRow {
  id: string
  runtime: string
  sessionId: string | null
  status: string
  lastCaptureAt: number | null
  cwd: string | null
  sourceAgentId: string | null
}

export interface DegradationRow {
  id: string
  ts: number
  kind: string
  detail: string | null
  distillJobId: string | null
  sessionId: string | null
}

const JOB_COLS = {
  id: memoryDistillJobs.id,
  runtime: memoryDistillJobs.runtime,
  sessionId: memoryDistillJobs.sessionId,
  status: memoryDistillJobs.status,
  lastCaptureAt: memoryDistillJobs.lastCaptureAt,
  cwd: memoryDistillJobs.cwd,
  sourceAgentId: memoryDistillJobs.sourceAgentId,
} as const

/** 累加中的 job（不变量 A：同 session 最多一个）。排除 subagent（一次性语义）。 */
export async function findWaitingJob(
  db: DbClient, runtime: 'claude-code' | 'opencode', sessionId: string,
): Promise<DistillJobRow | null> {
  const rows = await db.select(JOB_COLS).from(memoryDistillJobs)
    .where(and(
      eq(memoryDistillJobs.status, 'waiting'),
      eq(memoryDistillJobs.runtime, runtime),
      eq(memoryDistillJobs.sessionId, sessionId),
      isNull(memoryDistillJobs.sourceAgentId),
    )).limit(1)
  return rows[0] ?? null
}

export async function listWaitingJobs(db: DbClient): Promise<DistillJobRow[]> {
  return db.select(JOB_COLS).from(memoryDistillJobs)
    .where(and(eq(memoryDistillJobs.status, 'waiting'), isNull(memoryDistillJobs.sourceAgentId)))
}

/** 不变量 D：一 job 一行 event（最新全量快照）。同事务 delete+insert。 */
export async function upsertSessionEvent(db: DbClient, jobId: string, payloadJson: string): Promise<void> {
  db.$client.exec('BEGIN')
  try {
    db.$client.prepare('DELETE FROM memory_distill_events WHERE distill_job_id = ?').run(jobId)
    db.$client.prepare(
      "INSERT INTO memory_distill_events (distill_job_id, attempt_index, ts, kind, payload) VALUES (?, 0, ?, 'conversation', ?)",
    ).run(jobId, Date.now(), payloadJson)
    db.$client.exec('COMMIT')
  } catch (e) {
    db.$client.exec('ROLLBACK')
    throw e
  }
}

/** 不变量 B：waiting -> pending 单向放行，nextRunAt=now 立即参与 tick 选择。 */
export async function releaseWaitingJob(db: DbClient, jobId: string): Promise<void> {
  await db.update(memoryDistillJobs)
    .set({ status: 'pending', nextRunAt: Date.now() })
    .where(and(eq(memoryDistillJobs.id, jobId), eq(memoryDistillJobs.status, 'waiting'))).run()
}

export async function touchLastCapture(db: DbClient, jobId: string, ts: number): Promise<void> {
  await db.update(memoryDistillJobs).set({ lastCaptureAt: ts })
    .where(eq(memoryDistillJobs.id, jobId)).run()
}

export async function markFlush(db: DbClient, sessionId: string): Promise<void> {
  const now = Date.now()
  await db.insert(memorySessionFlushes).values({ sessionId, ts: now })
    .onConflictDoUpdate({ target: memorySessionFlushes.sessionId, set: { ts: now } }).run()
}

/** 一次性消费：有则删并返 true。 */
export async function consumeFlush(db: DbClient, sessionId: string): Promise<boolean> {
  const rows = await db.delete(memorySessionFlushes)
    .where(eq(memorySessionFlushes.sessionId, sessionId))
    .returning({ sessionId: memorySessionFlushes.sessionId })
  return rows.length > 0
}

export async function getSessionDigest(
  db: DbClient, sessionId: string,
): Promise<{ digest: string; mode: string } | null> {
  const rows = await db.select().from(memorySessionDigests)
    .where(eq(memorySessionDigests.sessionId, sessionId)).limit(1)
  return rows[0] ? { digest: rows[0].digest, mode: rows[0].mode } : null
}

export async function upsertSessionDigest(
  db: DbClient, sessionId: string, digest: string, mode: 'llm' | 'deterministic-fallback',
): Promise<void> {
  const now = Date.now()
  await db.insert(memorySessionDigests).values({ sessionId, digest, mode, updatedAt: now })
    .onConflictDoUpdate({ target: memorySessionDigests.sessionId, set: { digest, mode, updatedAt: now } }).run()
}

/**
 * 降级可见化（spec §5）：所有降级必须落表，UI 经 /api/status + 蒸馏记录呈现。
 * 本函数自身写表失败是唯一允许的 console-only 路径（审计系统自身故障）。
 */
export async function logDegradation(
  db: DbClient,
  entry: { kind: string; detail?: string; distillJobId?: string; sessionId?: string },
): Promise<void> {
  try {
    await db.insert(memoryDegradations).values({
      id: ulid(), ts: Date.now(), kind: entry.kind,
      detail: entry.detail ?? null, distillJobId: entry.distillJobId ?? null,
      sessionId: entry.sessionId ?? null,
    })
  } catch (e) {
    console.warn('memside: logDegradation failed (audit self-failure, console-only by design)', e)
    return
  }
  // 消息双写（spec 2026-08-12 §5.2）：审计表 + 用户收件箱各一条。
  // 与审计同契约：失败只 warn，不炸调用方。
  try {
    await insertNotification(db, {
      kind: 'degradation', title: entry.kind, body: entry.detail ?? null,
      refType: entry.distillJobId ? 'distill_job' : null,
      refId: entry.distillJobId ?? null,
    })
  } catch (e) {
    console.warn('memside: degradation notification insert failed', e)
  }
}

export async function listRecentDegradations(db: DbClient, sinceTs: number): Promise<DegradationRow[]> {
  return db.select().from(memoryDegradations)
    .where(gt(memoryDegradations.ts, sinceTs))
    .orderBy(desc(memoryDegradations.ts)).limit(100)
}

export async function listDegradationsForJob(db: DbClient, jobId: string): Promise<DegradationRow[]> {
  return db.select().from(memoryDegradations)
    .where(eq(memoryDegradations.distillJobId, jobId))
    .orderBy(desc(memoryDegradations.ts)).limit(50)
}

// ---------------------------------------------------------------------------
// 消息中心（spec 2026-08-12 §5.1-5.3）：notifications 收件箱
// ---------------------------------------------------------------------------

export const NOTIFICATION_RETENTION_CAP = 500
export const NOTIFICATION_BODY_CAP_CHARS = 2000
export const NOTIFICATION_KINDS = ['degradation', 'llm_error', 'parse_error', 'hook_missing'] as const
export type NotificationKind = typeof NOTIFICATION_KINDS[number]

export interface NotificationRow {
  id: string; ts: number; kind: NotificationKind; title: string
  body: string | null; refType: string | null; refId: string | null; readAt: number | null
}

export class NotificationNotFoundError extends Error {}
export class InvalidNotificationFilterError extends Error {}

/**
 * 写一条消息并执行保留裁剪（spec §5.2）：超过 NOTIFICATION_RETENTION_CAP
 * 删最旧。裁剪失败只 warn，不影响插入结果。
 *
 * 同内容折叠（spec 2026-08-14 §3.3 + 2026-08-15 §5.4）：插入前查最新一条未读
 * 同内容通知——llm_error/parse_error 按裁剪后 body 匹配，degradation 按 title
 * 匹配；命中则不新插，只把该行 ts 刷新为 MAX(Date.now(), 全表 MAX(ts)+1)（防同
 * 毫秒撞车保证浮顶）并返回原 id（跳过保留裁剪）。已读的相同
 * 内容不折叠（用户已处置，新的发生是新事件）。折叠路径不吞错：DB 失败沿
 * 调用方（logDegradation / logLlmErrorNotification / logParseErrorNotification）
 * 的 try/catch 契约 warn。
 */
export async function insertNotification(
  db: DbClient,
  input: { kind: NotificationKind; title: string; body?: string | null; refType?: string | null; refId?: string | null },
): Promise<string> {
  const body = input.body == null ? null : input.body.slice(0, NOTIFICATION_BODY_CAP_CHARS)
  const foldConds = (input.kind === 'llm_error' || input.kind === 'parse_error')
    ? and(
        eq(notifications.kind, input.kind),
        isNull(notifications.readAt),
        body === null ? isNull(notifications.body) : eq(notifications.body, body),
      )
    : and(
        eq(notifications.kind, input.kind),
        isNull(notifications.readAt),
        eq(notifications.title, input.title),
      )
  const dup = await db.select({ id: notifications.id }).from(notifications)
    .where(foldConds).orderBy(desc(notifications.ts), desc(notifications.id)).limit(1).all()
  if (dup[0]) {
    // 刷新 ts 必须保证目标行成为全表最新（spec §3.3「浮在列表顶部」）：
    // 快速连插时 Date.now() 可能与既有行撞同毫秒，ORDER BY ts DESC, id DESC
    // 下 ULID 更大的填充行会压在折叠行之上，故按 MAX(ts)+1 决胜。
    // SQLite 多参 MAX 是标量取大函数；表非空（目标行本身在表里），MAX(ts) 不为 NULL。
    await db.run(sql`UPDATE notifications SET ts = MAX(${Date.now()}, (SELECT MAX(ts) FROM notifications) + 1) WHERE id = ${dup[0].id}`)
    return dup[0].id
  }
  const id = ulid()
  await db.insert(notifications).values({
    id, ts: Date.now(), kind: input.kind, title: input.title, body,
    refType: input.refType ?? null, refId: input.refId ?? null, readAt: null,
  }).run()
  try {
    await db.run(sql`DELETE FROM notifications WHERE id NOT IN (SELECT id FROM notifications ORDER BY ts DESC, id DESC LIMIT ${NOTIFICATION_RETENTION_CAP})`)
  } catch (e) { console.warn('memside: notification retention trim failed', e) }
  return id
}

/** scheduler llm_error 路径专用（spec §5.2）：自身吞错只 warn，不炸蒸馏。 */
export async function logLlmErrorNotification(db: DbClient, input: { jobId: string; message: string }): Promise<void> {
  try {
    await insertNotification(db, { kind: 'llm_error', title: 'llm_error', body: input.message, refType: 'distill_job', refId: input.jobId })
  } catch (e) { console.warn('memside: llm_error notification insert failed', e) }
}

/** scheduler parse_error 路径专用（spec 2026-08-15 §5.4）：自身吞错只 warn，不炸蒸馏。 */
export async function logParseErrorNotification(db: DbClient, input: { jobId: string; message: string }): Promise<void> {
  try {
    await insertNotification(db, { kind: 'parse_error', title: 'parse_error', body: input.message, refType: 'distill_job', refId: input.jobId })
  } catch (e) { console.warn('memside: parse_error notification insert failed', e) }
}

export interface NotificationListOpts {
  limit?: number
  before?: PageCursor
  kind?: NotificationKind
  unreadOnly?: boolean
  q?: string
}

/** 消息分页（spec §5.3）：游标/排序/total 与 listDiscardsPage 同模式。 */
export async function listNotificationsPage(
  db: DbClient, opts: NotificationListOpts = {},
): Promise<PageWithTotal<NotificationRow>> {
  if (opts.kind && !(NOTIFICATION_KINDS as readonly string[]).includes(opts.kind)) {
    throw new InvalidNotificationFilterError(`invalid notification kind: ${opts.kind}`)
  }
  const limit = clampPageLimit(opts.limit)
  const baseConds: any[] = []
  if (opts.kind) baseConds.push(eq(notifications.kind, opts.kind))
  if (opts.unreadOnly) baseConds.push(isNull(notifications.readAt))
  if (opts.q) baseConds.push(or(like(notifications.title, `%${opts.q}%`), like(notifications.body, `%${opts.q}%`)))
  const conds = [...baseConds]
  if (opts.before) {
    conds.push(or(
      lt(notifications.ts, opts.before.ts),
      and(eq(notifications.ts, opts.before.ts), lt(notifications.id, opts.before.id)),
    ))
  }
  const rows = await db.select().from(notifications)
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(desc(notifications.ts), desc(notifications.id))
    .limit(limit + 1).all()
  const countRows = await db.select({ n: sql<number>`COUNT(*)` }).from(notifications)
    .where(baseConds.length > 0 ? and(...baseConds) : undefined).all()
  const hasMore = rows.length > limit
  const pageRows = rows.slice(0, limit)
  const last = pageRows[pageRows.length - 1]
  return {
    items: pageRows as NotificationRow[],
    hasMore,
    nextCursor: hasMore && last ? { ts: last.ts, id: last.id } : null,
    total: Number(countRows[0]?.n ?? 0),
  }
}

/** 标已读（spec §5.3）：已读行幂等成功；不存在抛 NotificationNotFoundError（server 404）。 */
export async function markNotificationRead(db: DbClient, id: string): Promise<void> {
  const rows = await db.update(notifications).set({ readAt: Date.now() })
    .where(and(eq(notifications.id, id), isNull(notifications.readAt)))
    .returning({ id: notifications.id })
  if (rows.length === 0) {
    const exists = await db.select({ id: notifications.id }).from(notifications)
      .where(eq(notifications.id, id)).limit(1)
    if (exists.length === 0) throw new NotificationNotFoundError(`notification ${id} not found`)
  }
}

/** 全部已读（spec §5.3）：返回本次标记条数。 */
export async function markAllNotificationsRead(db: DbClient): Promise<number> {
  const rows = await db.update(notifications).set({ readAt: Date.now() })
    .where(isNull(notifications.readAt)).returning({ id: notifications.id })
  return rows.length
}

/** 把指定 kind 的所有未读消息标记已读（spec 2026-08-19 §3.3）。返回本次标记条数。 */
export async function markNotificationsReadByKind(db: DbClient, kind: NotificationKind): Promise<number> {
  const rows = await db.update(notifications).set({ readAt: Date.now() })
    .where(and(eq(notifications.kind, kind), isNull(notifications.readAt)))
    .returning({ id: notifications.id })
  return rows.length
}

/** digest 耗时回填（spec §5.4）：run 行在 saveDistillRun 时已写，此处二次 UPDATE；无行 no-op。 */
export async function updateDistillRunDigestMs(db: DbClient, jobId: string, ms: number): Promise<void> {
  await db.update(memoryDistillRuns).set({ digestMs: ms })
    .where(eq(memoryDistillRuns.distillJobId, jobId)).run()
}

// ---------------------------------------------------------------------------
// 断点续跑（spec 2026-08-18 §4.1）：jobs 断点读写、对话历史 llm_round 落盘/读回、
// 暂停/重试/放弃 job、3 次失败汇总通知、pending_review 候选。
// ---------------------------------------------------------------------------

/** 断点快照（spec §4.1）。currentStep 为 NULL → 'distill'（新任务语义）。 */
export interface JobCheckpoint {
  currentStep: DistillStep
  stepAttempts: number
  stepError: string | null
}

/** 一轮 LLM 对话历史（落 memory_distill_events kind='llm_round'）。 */
export interface LlmRoundRow {
  step: DistillStep
  round: number
  request: string
  response: string
  result: StepAttemptResult
}

/** 读 job 断点（spec §4.1）。job 不存在或 currentStep NULL → 'distill'/0/null。 */
export function getJobCheckpoint(db: DbClient, jobId: string): JobCheckpoint {
  const rows = db.select({
    currentStep: memoryDistillJobs.currentStep,
    stepAttempts: memoryDistillJobs.stepAttempts,
    stepError: memoryDistillJobs.stepError,
  }).from(memoryDistillJobs).where(eq(memoryDistillJobs.id, jobId)).limit(1).all()
  const r = rows[0]
  const currentStep = (r?.currentStep ?? null) as DistillStep | null
  return {
    currentStep: currentStep ?? 'distill',
    stepAttempts: r?.stepAttempts ?? 0,
    stepError: r?.stepError ?? null,
  }
}

/** 写 job 断点（spec §4.1）。无 job 行 no-op（调用方应已建 job）。 */
export async function setJobCheckpoint(
  db: DbClient, jobId: string, cp: JobCheckpoint,
): Promise<void> {
  await db.update(memoryDistillJobs).set({
    currentStep: cp.currentStep,
    stepAttempts: cp.stepAttempts,
    stepError: cp.stepError,
  }).where(eq(memoryDistillJobs.id, jobId)).run()
}

/**
 * 落盘一轮 LLM 对话历史（spec §4.1）。存 memory_distill_events kind='llm_round'，
 * payload JSON 含 {step, round, request, response, result}；attemptIndex 复用为 round。
 */
export async function saveLlmRound(
  db: DbClient,
  input: { jobId: string; step: DistillStep; round: number; request: string; response: string; result: StepAttemptResult },
): Promise<void> {
  const payload = JSON.stringify({
    step: input.step, round: input.round, request: input.request,
    response: input.response, result: input.result,
  })
  await db.insert(memoryDistillEvents).values({
    distillJobId: input.jobId, attemptIndex: input.round, ts: Date.now(),
    kind: 'llm_round', payload,
  }).run()
}

/**
 * 读回某 step 的对话历史（spec §4.1）。按 kind='llm_round' 过滤后 payload.step===入参 step
 * 再过滤（防 payload 与查询 step 漂移），round 升序。
 */
export async function listLlmRounds(
  db: DbClient, jobId: string, step: DistillStep,
): Promise<LlmRoundRow[]> {
  const rows = await db.select().from(memoryDistillEvents)
    .where(and(eq(memoryDistillEvents.distillJobId, jobId), eq(memoryDistillEvents.kind, 'llm_round')))
    .orderBy(asc(memoryDistillEvents.attemptIndex), asc(memoryDistillEvents.id))
    .all()
  const out: LlmRoundRow[] = []
  for (const r of rows) {
    let p: any = null
    try { p = JSON.parse(r.payload) } catch { continue }
    if (p == null || p.step !== step) continue
    out.push({
      step: p.step as DistillStep,
      round: typeof p.round === 'number' ? p.round : r.attemptIndex,
      request: typeof p.request === 'string' ? p.request : '',
      response: typeof p.response === 'string' ? p.response : '',
      result: p.result as StepAttemptResult,
    })
  }
  return out
}

/**
 * 落盘某步骤的干净结果（spec 2026-08-18 §3.2 P3/P4：步骤间只传干净结果，
 * 落库 + 断点续跑读回，不传 LLM 对话历史）。存 memory_distill_events
 * kind='step_output'，payload JSON 含 {step, output}；同 step 重复保存追加行，
 * 读回取最新一条（成功推进后旧快照不再被读）。
 */
export async function saveStepOutput(
  db: DbClient, jobId: string, step: DistillStep, output: unknown,
): Promise<void> {
  const payload = JSON.stringify({ step, output })
  await db.insert(memoryDistillEvents).values({
    distillJobId: jobId, attemptIndex: 0, ts: Date.now(),
    kind: 'step_output', payload,
  }).run()
}

/**
 * 读回某步骤最新干净结果（spec 2026-08-18 §3.2）。无该 step 的产出行返回 null
 * （调用方据此判定断点损坏，保守回退重跑该步）。
 */
export async function getStepOutput<T>(
  db: DbClient, jobId: string, step: DistillStep,
): Promise<T | null> {
  const rows = await db.select().from(memoryDistillEvents)
    .where(and(eq(memoryDistillEvents.distillJobId, jobId), eq(memoryDistillEvents.kind, 'step_output')))
    .orderBy(desc(memoryDistillEvents.ts), desc(memoryDistillEvents.id))
    .all()
  for (const r of rows) {
    let p: any = null
    try { p = JSON.parse(r.payload) } catch { continue }
    if (p == null || p.step !== step) continue
    return (p.output ?? null) as T | null
  }
  return null
}

/**
 * 标记 job 暂停（spec §4.1 §5.2）。jobs.status='paused'、stepError=step（暂停位置标记）；
 * runs.pausedStep=step（best-effort UPDATE，无 run 行 no-op）。
 */
export async function markJobPaused(db: DbClient, jobId: string, step: DistillStep): Promise<void> {
  await db.update(memoryDistillJobs).set({ status: 'paused', stepError: step })
    .where(eq(memoryDistillJobs.id, jobId)).run()
  try {
    await db.update(memoryDistillRuns).set({ pausedStep: step })
      .where(eq(memoryDistillRuns.distillJobId, jobId)).run()
  } catch (e) { console.warn('memside: markJobPaused run pausedStep update failed', e) }
}

/** 重置 job 供重试（spec §4.1）：stepAttempts=0、stepError=null、status='pending'、nextRunAt=now。 */
export async function resetJobForRetry(db: DbClient, jobId: string): Promise<void> {
  await db.update(memoryDistillJobs).set({
    stepAttempts: 0, stepError: null, status: 'pending', nextRunAt: Date.now(),
  }).where(eq(memoryDistillJobs.id, jobId)).run()
}

/** 放弃 job（spec §4.1）：status='done' + finishedAt=now。offset 推进由 scheduler 调 setSessionOffset，不在此处。 */
export async function abandonJob(db: DbClient, jobId: string): Promise<void> {
  await db.update(memoryDistillJobs).set({
    status: 'done', finishedAt: Date.now(),
  }).where(eq(memoryDistillJobs.id, jobId)).run()
}

/**
 * 3 次失败汇总一条任务级通知（spec §5.2）。复用 insertNotification 同内容折叠：
 * 同 job+step+reasons 重复调用不刷屏。title=`${step}_failed`，body=reasons.join(' | ')，
 * refType='distill_job'，refId=jobId。自身吞错只 warn，不炸蒸馏。
 */
export async function logStepFailureNotification(
  db: DbClient,
  input: { jobId: string; step: DistillStep; reasons: string[] },
): Promise<void> {
  try {
    await insertNotification(db, {
      kind: 'llm_error',
      title: `${input.step}_failed`,
      body: input.reasons.join(' | '),
      refType: 'distill_job',
      refId: input.jobId,
    })
  } catch (e) { console.warn('memside: step failure notification insert failed', e) }
}

/**
 * 列出某项目的待审查候选（spec §6.4）。status='pending_review' 且 sourceCwd=projectId。
 * 用 sourceCwd 过滤（非 scopeId）：judge 暂停期间候选来自该项目的 distill job，
 * 含 project-scoped 与 global-scoped（同一 job 的 cwd 即 sourceCwd），一条查全。
 * projectId 空串 = 不按项目过滤（返回全部 pending_review）。
 */
export async function listPendingReviewCandidates(
  db: DbClient, opts: { projectId: string },
): Promise<Memory[]> {
  const cond = opts.projectId
    ? and(eq(memories.status, 'pending_review'), eq(memories.sourceCwd, opts.projectId))
    : eq(memories.status, 'pending_review')
  const rows = await db.select().from(memories)
    .where(cond)
    .orderBy(desc(memories.createdAt), desc(memories.id))
    .all()
  return rows.map(rowToMemory)
}

/** pending_review → candidate 进审批队列（spec §6.4）。无行/状态不符 no-op。 */
export async function promotePendingReviewToCandidate(db: DbClient, candidateId: string): Promise<void> {
  await db.update(memories).set({ status: 'candidate' })
    .where(and(eq(memories.id, candidateId), eq(memories.status, 'pending_review'))).run()
}

// ---------------------------------------------------------------------------
// 回收站 + 批量删除 + 导入 + 导出查询（spec 2026-08-16）
// ---------------------------------------------------------------------------

export interface TrashRow {
  id: string
  originalMemoryId: string
  scopeType: string
  scopeId: string | null
  sourceCwd: string | null
  runtime: string | null
  deletedAt: number
  title: string
  valueClass: string | null
  subjectSlug: string | null
}

const TRASH_COLS = {
  id: memoryTrash.id, originalMemoryId: memoryTrash.originalMemoryId,
  scopeType: memoryTrash.scopeType, scopeId: memoryTrash.scopeId,
  sourceCwd: memoryTrash.sourceCwd, runtime: memoryTrash.runtime,
  deletedAt: memoryTrash.deletedAt, title: memoryTrash.title,
  valueClass: memoryTrash.valueClass, subjectSlug: memoryTrash.subjectSlug,
} as const

function rowToTrash(r: any): TrashRow {
  return {
    id: r.id, originalMemoryId: r.originalMemoryId,
    scopeType: r.scopeType, scopeId: r.scopeId ?? null, sourceCwd: r.sourceCwd ?? null,
    runtime: r.runtime ?? null, deletedAt: r.deletedAt, title: r.title,
    valueClass: r.valueClass ?? null, subjectSlug: r.subjectSlug ?? null,
  }
}

/**
 * 批量删除：逐条事务内 DELETE memory + INSERT memory_trash 快照。吞错计 skipped
 * （含 not-found / 重复删）。幂等：同 id 第二次删 memory 已不在 -> 计 skipped，不写第二条 trash。
 */
export async function bulkDeleteMemories(db: DbClient, ids: string[]): Promise<{ deleted: number; skipped: number }> {
  let deleted = 0, skipped = 0
  for (const id of ids) {
    try {
      await db.transaction((tx) => {
        const rows = tx.select().from(memories).where(eq(memories.id, id)).limit(1).all()
        if (rows.length === 0) throw new MemoryNotFoundError(`memory ${id} not found`)
        const m = rowToMemory(rows[0]!)
        tx.delete(memories).where(eq(memories.id, id)).run()
        tx.insert(memoryTrash).values({
          id: ulid(), memorySnapshot: snapshotMemory(m), originalMemoryId: m.id,
          scopeType: m.scopeType, scopeId: m.scopeId, sourceCwd: m.sourceCwd,
          runtime: m.runtime, deletedAt: Date.now(), title: m.title,
          valueClass: m.valueClass, subjectSlug: m.subjectSlug,
        }).run()
      })
      deleted += 1
    } catch {
      skipped += 1
    }
  }
  return { deleted, skipped }
}

/** 清空回收站：物理删全部 memory_trash 行（快照没了 -> 不可恢复，spec §数据模型）。 */
export async function emptyTrash(db: DbClient): Promise<{ emptied: number }> {
  const rows = await db.select({ n: sql<number>`COUNT(*)` }).from(memoryTrash).all()
  await db.delete(memoryTrash).run()
  return { emptied: Number(rows[0]?.n ?? 0) }
}

/**
 * 高保真导入 seam（恢复 + JSON 文件导入共用，spec §导入/恢复共享 seam）。
 * 绕过 createCandidate 的 status:'candidate' 硬编码，按记录 status 直接写入。
 * 冲突策略：skip（已存在跳过）/ overwrite（删旧写新保留 id）/ newid（生成新 ULID 新增）。
 * 非法记录跳过计 errors，不整批失败。subjectSlug 经 normalizeSubjectSlug 校验。
 */
export async function importMemories(
  db: DbClient,
  records: Memory[],
  opts: { conflict: 'skip' | 'overwrite' | 'newid' },
): Promise<{ imported: number; skipped: number; overwritten: number; errors: string[] }> {
  let imported = 0, skipped = 0, overwritten = 0
  const errors: string[] = []
  for (const rec of records) {
    try {
      if (!rec.id || !rec.title || !rec.bodyMd) { errors.push(`invalid record: ${rec.id ?? '(no id)'}`); continue }
      const slug = rec.subjectSlug !== null && rec.subjectSlug !== undefined
        ? normalizeSubjectSlug(rec.subjectSlug) : rec.subjectSlug ?? null
      const existing = await db.select({ id: memories.id }).from(memories).where(eq(memories.id, rec.id)).limit(1).all()
      const exists = existing.length > 0
      if (exists && opts.conflict === 'skip') { skipped += 1; continue }
      // newid: 总是生成新 ULID（spec §new ULID 新增，即便 id 不冲突也换 id）。
      // skip/overwrite: 保留 rec.id（overwrite 删旧写新同 id；restoreFromTrash 据此按
      // snap.id 取回恢复行）。
      const writeId = opts.conflict === 'newid' ? ulid() : rec.id
      const values: typeof memories.$inferInsert = {
        id: writeId, scopeType: rec.scopeType, scopeId: rec.scopeId, runtime: rec.runtime,
        title: rec.title, bodyMd: rec.bodyMd, tags: JSON.stringify(rec.tags), status: rec.status,
        sourceKind: (rec.sourceKind || 'manual') as 'conversation' | 'error' | 'manual' | 'subagent', sourceCwd: rec.sourceCwd ?? null,
        sourceEventId: rec.sourceEventId ?? null, distillJobId: rec.distillJobId ?? null,
        distillAction: (rec.distillAction ?? null) as 'new' | 'update_of' | 'duplicate_of' | 'conflict_with' | null, supersedesId: rec.supersedesId ?? null,
        supersededById: rec.supersededById ?? null, approvedAt: rec.approvedAt ?? null,
        createdAt: rec.createdAt || Date.now(), version: rec.version || 1,
        valueClass: rec.valueClass ?? null, subjectSlug: slug,
        origin: rec.origin ?? null, evidence: rec.evidence ?? null,
      }
      if (exists && opts.conflict === 'overwrite') {
        // 原子化 delete+insert（spec §失败模式 #4）：两条语句分立时若 insert 抛错，
        // 旧行已删 -> 记忆丢失。包进单事务，任一失败整体回滚（与 bulkDeleteMemories
        // 同模式：同步回调，无 await）。
        db.transaction((tx) => {
          tx.delete(memories).where(eq(memories.id, rec.id)).run()
          tx.insert(memories).values(values).run()
        })
        overwritten += 1
      } else {
        await db.insert(memories).values(values).run()
        imported += 1
      }
    } catch (e) {
      errors.push(`failed record ${rec.id}: ${(e as Error).message}`)
    }
  }
  return { imported, skipped, overwritten, errors }
}

/**
 * 恢复回收站条目：反序列化 snapshot -> importMemories(skip) -> 删 trash 行。
 * trash 不存在抛 MemoryNotFoundError。恢复默认 skip（安全：不暴露 overwrite，spec §失败模式 #4）。
 */
export async function restoreFromTrash(
  db: DbClient, id: string, opts: { conflict: 'skip' | 'overwrite' | 'newid' } = { conflict: 'skip' },
): Promise<Memory> {
  const rows = await db.select().from(memoryTrash).where(eq(memoryTrash.id, id)).limit(1).all()
  if (rows.length === 0) throw new MemoryNotFoundError(`trash ${id} not found`)
  const snap = restoreFromSnapshot(rows[0]!.memorySnapshot)
  if (!snap) throw new MemoryConflictError(`trash ${id} snapshot corrupt`)
  const r = await importMemories(db, [snap], opts)
  // 只在实际写入了恢复行时删 trash 行（spec §失败模式 #4）：conflict='skip' 且
  // snap.id 已存在时 importMemories 计 skipped、不写库，此时删 trash 会让快照
  // 无端消失、无法再次恢复。保留 trash 行，下方按 snap.id 取回已存在的行返回。
  if (r.imported > 0 || r.overwritten > 0) {
    await db.delete(memoryTrash).where(eq(memoryTrash.id, id)).run()
  }
  // 返回恢复的记忆（按 snap.id 取回；skip 时库内既有行仍在）
  const restored = await db.select().from(memories).where(eq(memories.id, snap.id)).limit(1).all()
  if (restored.length === 0) throw new MemoryConflictError(`restore reported ${JSON.stringify(r)} but memory not found`)
  return rowToMemory(restored[0]!)
}

/**
 * 无分页导出查询（spec §导出三档作用域）。selected 按 ids；filter 按 statuses+filter；
 * all 全部 statuses。不受 cursor 限制（导出量级可控，YAGNI 不流式）。
 */
export async function listMemoriesForExport(
  db: DbClient,
  opts: { scope: 'selected' | 'filter' | 'all'; ids?: string[]; statuses?: MemoryStatus[]; filter?: MemoryListFilter },
): Promise<Memory[]> {
  if (opts.scope === 'selected') {
    const ids = (opts.ids ?? []).filter((x): x is string => typeof x === 'string')
    if (ids.length === 0) return []
    const rows = await db.select().from(memories).where(inArray(memories.id, ids)).orderBy(desc(memories.createdAt)).all()
    return rows.map(rowToMemory)
  }
  const conds: any[] = []
  if (opts.scope === 'filter' && opts.statuses && opts.statuses.length > 0) {
    conds.push(inArray(memories.status, opts.statuses))
  }
  conds.push(...memoryFilterConds(opts.filter))
  const rows = await db.select().from(memories)
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(desc(memories.createdAt)).all()
  return rows.map(rowToMemory)
}

/** 回收站分页（与 listMemoriesPage 同模式，复合游标 deletedAt+id DESC）。 */
export async function listTrashPage(
  db: DbClient,
  opts: { limit?: number; before?: PageCursor; filter?: MemoryListFilter } = {},
): Promise<PageWithTotal<TrashRow>> {
  const limit = clampPageLimit(opts.limit)
  const baseConds: any[] = []
  if (opts.filter?.sourceCwd) baseConds.push(eq(memoryTrash.sourceCwd, opts.filter.sourceCwd))
  if (opts.filter?.category) baseConds.push(sql`instr(${memoryTrash.title}, ${'[category:' + opts.filter.category + ']'}) > 0`)
  if (opts.filter?.subjectSlug) baseConds.push(eq(memoryTrash.subjectSlug, opts.filter.subjectSlug))
  if (opts.filter?.valueClass) {
    if (opts.filter.valueClass === VALUE_CLASS_UNEVALUATED) baseConds.push(isNull(memoryTrash.valueClass))
    else if ((PROTECTED_VALUE_CLASSES as readonly string[]).includes(opts.filter.valueClass)) baseConds.push(eq(memoryTrash.valueClass, opts.filter.valueClass))
  }
  const conds = [...baseConds]
  if (opts.before) {
    conds.push(or(
      lt(memoryTrash.deletedAt, opts.before.ts),
      and(eq(memoryTrash.deletedAt, opts.before.ts), lt(memoryTrash.id, opts.before.id)),
    ))
  }
  const rows = await db.select(TRASH_COLS).from(memoryTrash)
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(desc(memoryTrash.deletedAt), desc(memoryTrash.id))
    .limit(limit + 1).all()
  const countRows = await db.select({ n: sql<number>`COUNT(*)` }).from(memoryTrash)
    .where(baseConds.length > 0 ? and(...baseConds) : undefined).all()
  const hasMore = rows.length > limit
  const pageRows = rows.slice(0, limit)
  const last = pageRows[pageRows.length - 1]
  return {
    items: pageRows.map(rowToTrash),
    hasMore,
    nextCursor: hasMore && last ? { ts: last.deletedAt, id: last.id } : null,
    total: Number(countRows[0]?.n ?? 0),
  }
}

/** 回收站详情（含反序列化 snapshot，恢复前预览）。 */
export async function getTrash(db: DbClient, id: string): Promise<{ trash: TrashRow & { memory: Memory | null } } | null> {
  const rows = await db.select().from(memoryTrash).where(eq(memoryTrash.id, id)).limit(1).all()
  if (rows.length === 0) return null
  const t = rowToTrash(rows[0]!)
  return { trash: { ...t, memory: restoreFromSnapshot(rows[0]!.memorySnapshot) } }
}

/** 回收站四维筛选下拉（slugs/valueClasses 恒空——表无对应列，与 discards 同模式）。 */
export async function listTrashFacets(db: DbClient): Promise<Facets> {
  const projects = new Map<string, number>()
  const projRows = await db.select({ v: memoryTrash.sourceCwd, n: sql<number>`COUNT(*)` })
    .from(memoryTrash).where(isNotNull(memoryTrash.sourceCwd)).groupBy(memoryTrash.sourceCwd).all()
  for (const r of projRows) if (r.v) projects.set(r.v, (projects.get(r.v) ?? 0) + Number(r.n))
  const cats = new Map<string, number>()
  const titleRows = await db.select({ t: memoryTrash.title }).from(memoryTrash).all()
  for (const r of titleRows) {
    const c = categoryFromTitle(r.t)
    if (c) cats.set(c, (cats.get(c) ?? 0) + 1)
  }
  return { projects: sortFacets(projects), categories: sortFacets(cats), slugs: [], valueClasses: [], origins: [] }
}

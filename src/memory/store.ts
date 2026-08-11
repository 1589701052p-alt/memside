import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, notInArray, or, sql } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import { memories, memoryDiscards, memorySessionOffsets, memoryDistillInputs, memoryDistillRuns, memoryDistillJobs, memorySessionFlushes, memorySessionDigests, memoryDegradations } from '@/db/schema'
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
    distillAction: input.distillAction ?? null, supersedesId: null, supersededById: null,
    approvedAt: null, createdAt: now, version: 1, valueClass: input.valueClass ?? null,
    subjectSlug: input.subjectSlug ?? null,
    origin: input.origin ?? null, evidence: input.evidence ?? null,
  })
  return rowToMemory({ id, scopeType: input.scopeType, scopeId: input.scopeId, runtime: input.runtime,
    title: input.title, bodyMd: input.bodyMd, tags: JSON.stringify(input.tags), status: 'candidate',
    sourceKind: input.sourceKind, sourceCwd: input.sourceCwd ?? null,
    sourceEventId: input.sourceEventId ?? null, distillJobId: input.distillJobId ?? null,
    distillAction: input.distillAction ?? null, supersedesId: null, supersededById: null, approvedAt: null,
    createdAt: now, version: 1, valueClass: input.valueClass ?? null,
    subjectSlug: input.subjectSlug ?? null, origin: input.origin ?? null, evidence: input.evidence ?? null })
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
 * (createdAt DESC LIMIT DEDUP_EXISTING_LIMIT), de-duped by id, projecting
 * {id,title,bodyMd,scopeType,scopeId,status} (no runtime; bodyMd now included so
 * cross-batch dedup sees full context per spec §3.4). Other statuses
 * (archived/rejected/superseded) excluded.
 */
export async function listForDedupByScope(
  db: DbClient,
  opts: { scopeType: MemoryScope; scopeId: string | null },
): Promise<ExistingMemoryForDedup[]> {
  const scopeClause = opts.scopeId === null ? isNull(memories.scopeId) : eq(memories.scopeId, opts.scopeId)
  const cols = { id: memories.id, title: memories.title, bodyMd: memories.bodyMd, scopeType: memories.scopeType, scopeId: memories.scopeId, status: memories.status }
  const approvedRows = await db.select(cols).from(memories).where(
    and(eq(memories.scopeType, opts.scopeType), scopeClause, eq(memories.status, 'approved')),
  ).orderBy(desc(memories.createdAt)).all()
  const candidateRows = await db.select(cols).from(memories).where(
    and(eq(memories.scopeType, opts.scopeType), scopeClause, eq(memories.status, 'candidate')),
  ).orderBy(desc(memories.createdAt)).limit(DEDUP_EXISTING_LIMIT).all()
  const seen = new Set<string>()
  const out: ExistingMemoryForDedup[] = []
  for (const r of [...approvedRows, ...candidateRows]) {
    if (seen.has(r.id)) continue
    seen.add(r.id)
    out.push({ id: r.id, title: r.title, bodyMd: r.bodyMd, scopeType: r.scopeType as MemoryScope, scopeId: r.scopeId, status: r.status as MemoryStatus })
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
    // status === 'candidate'. The general canTransition('archived','approved')
    // is also true, so a general check would silently promote an ARCHIVED memory
    // (resetting version to 1, overwriting approvedAt) instead of throwing.
    if (cand.status !== 'candidate') {
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

export type DistillOutcome = 'skipped_no_new_turns' | 'skipped_trivial' | 'empty_output' | 'llm_error' | 'produced'

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
  ts: number
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
  }).onConflictDoUpdate({
    target: memoryDistillRuns.distillJobId,
    set: { outcome: record.outcome, rawOutputJson, distilledCount: record.rawCount,
      acceptedCount: record.acceptedCount, dedupedCount: record.dedupedCount,
      filteredCount: record.filteredCount, storedCount: record.storedCount,
      discardedCount: record.discardedCount, durationMs: record.durationMs,
      errorMessage: record.errorMessage, ts: now },
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
}

const RUN_LIST_COLS = {
  distillJobId: memoryDistillRuns.distillJobId, outcome: memoryDistillRuns.outcome,
  rawCount: memoryDistillRuns.distilledCount, acceptedCount: memoryDistillRuns.acceptedCount,
  dedupedCount: memoryDistillRuns.dedupedCount, filteredCount: memoryDistillRuns.filteredCount,
  storedCount: memoryDistillRuns.storedCount, discardedCount: memoryDistillRuns.discardedCount,
  durationMs: memoryDistillRuns.durationMs, errorMessage: memoryDistillRuns.errorMessage,
  ts: memoryDistillRuns.ts,
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

export interface MemoryListFilter {
  /** memories.source_cwd / discards.source_cwd 精确匹配。 */
  sourceCwd?: string
  /** memories.subject_slug 精确匹配（discards 无此列，忽略）。 */
  subjectSlug?: string
  /** instr(title, '[category:X]') > 0（带闭括号精确子串）。 */
  category?: string
  /** 'unevaluated' 哨兵 -> IS NULL；合法六值 -> eq；其余值忽略（宽松）。 */
  valueClass?: string
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
// 四维筛选下拉选项（spec 2026-08-11-web-memory-filters §4.1）
// ---------------------------------------------------------------------------

export interface FacetValue { value: string; count: number }
export interface Facets {
  projects: FacetValue[]
  categories: FacetValue[]
  slugs: FacetValue[]
  valueClasses: FacetValue[]
}
export const FACET_LIST_CAP = 200

function sortFacets(m: Map<string, number>): FacetValue[] {
  return [...m.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0))
    .slice(0, FACET_LIST_CAP)
}

/**
 * 四维筛选的下拉选项：全局口径（不按 tab/status 切分，决策 D2）；项目与分类
 * UNION memories+discards 两表（决策 D1：discard 行不在 memories 表）；
 * value_class NULL 聚成 VALUE_CLASS_UNEVALUATED 桶。各组 count 降序、
 * 同 count 按 value 字母序，截 FACET_LIST_CAP。
 */
export async function listFacets(db: DbClient): Promise<Facets> {
  const bump = (m: Map<string, number>, v: string, n: number) => m.set(v, (m.get(v) ?? 0) + n)

  const projects = new Map<string, number>()
  const memProj = await db.select({ v: memories.sourceCwd, n: sql<number>`COUNT(*)` })
    .from(memories).where(isNotNull(memories.sourceCwd)).groupBy(memories.sourceCwd).all()
  const disProj = await db.select({ v: memoryDiscards.sourceCwd, n: sql<number>`COUNT(*)` })
    .from(memoryDiscards).where(isNotNull(memoryDiscards.sourceCwd)).groupBy(memoryDiscards.sourceCwd).all()
  for (const r of [...memProj, ...disProj]) if (r.v) bump(projects, r.v, Number(r.n))

  const cats = new Map<string, number>()
  const memTitles = await db.select({ t: memories.title }).from(memories).all()
  const disTitles = await db.select({ t: memoryDiscards.title }).from(memoryDiscards).all()
  for (const r of [...memTitles, ...disTitles]) {
    const c = categoryFromTitle(r.t)
    if (c) bump(cats, c, 1)
  }

  const slugs = new Map<string, number>()
  const slugRows = await db.select({ v: memories.subjectSlug, n: sql<number>`COUNT(*)` })
    .from(memories).where(isNotNull(memories.subjectSlug)).groupBy(memories.subjectSlug).all()
  for (const r of slugRows) if (r.v) bump(slugs, r.v, Number(r.n))

  const vcs = new Map<string, number>()
  const vcRows = await db.select({ v: memories.valueClass, n: sql<number>`COUNT(*)` })
    .from(memories).groupBy(memories.valueClass).all()
  for (const r of vcRows) bump(vcs, r.v ?? VALUE_CLASS_UNEVALUATED, Number(r.n))

  return {
    projects: sortFacets(projects),
    categories: sortFacets(cats),
    slugs: sortFacets(slugs),
    valueClasses: sortFacets(vcs),
  }
}

/** 6 个保护类 valueClass（= 前端 priorityRank < 2 的全集）；其余候选视为「未评估」。 */
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

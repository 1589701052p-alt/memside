import { and, asc, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import { memories, memoryDiscards, memorySessionOffsets, memoryDistillInputs, memoryDistillRuns, memoryDistillJobs } from '@/db/schema'
import {
  canTransition,
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
  /** 出处（spec §R1）；缺省/null = 未标注（老行/手动记忆/promoteDiscard 提升行）。 */
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
 * global = all. runtime filter: current-runtime-tagged + untagged (null) pass;
 * other-runtime-tagged excluded.
 */
export async function listApprovedByScope(
  db: DbClient,
  opts: { projectId: string; runtime: 'claude-code' | 'opencode' },
): Promise<InjectableMemorySet> {
  const projectRows = await db.select().from(memories).where(
    and(eq(memories.scopeType, 'project'), eq(memories.scopeId, opts.projectId), eq(memories.status, 'approved')),
  ).orderBy(desc(memories.createdAt))
  const globalRows = await db.select().from(memories).where(
    and(eq(memories.scopeType, 'global'), eq(memories.status, 'approved')),
  ).orderBy(desc(memories.createdAt))
  const filterRuntime = (r: any) => r.runtime === null || r.runtime === opts.runtime
  const toRow = (r: any) => ({
    id: r.id, scopeType: r.scopeType as MemoryScope, scopeId: r.scopeId, runtime: (r.runtime ?? null) as RuntimeTag,
    title: r.title, bodyMd: r.bodyMd, createdAt: r.createdAt, version: r.version, tags: parseTags(r.tags),
    subjectSlug: r.subjectSlug ?? null,
  })
  return {
    byScope: {
      project: projectRows.filter(filterRuntime).map(toRow),
      global: globalRows.filter(filterRuntime).map(toRow),
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

export async function listDiscards(
  db: DbClient,
  opts: { limit?: number } = {},
): Promise<DiscardRow[]> {
  const limit = opts.limit ?? DISCARDS_LIST_LIMIT
  const rows = await db.select().from(memoryDiscards).orderBy(desc(memoryDiscards.ts)).limit(limit).all()
  return rows.map((r) => ({
    id: r.id, distillJobId: r.distillJobId, title: r.title, bodyMd: r.bodyMd, reason: r.reason,
    ts: r.ts, scopeType: r.scopeType ?? null, scopeId: r.scopeId ?? null, sourceCwd: r.sourceCwd ?? null,
    runtime: r.runtime ?? null, sourceKind: r.sourceKind ?? null, promotedMemoryId: r.promotedMemoryId ?? null,
  }))
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

export type DistillOutcome = 'skipped_no_new_turns' | 'empty_output' | 'llm_error' | 'produced'

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
}

/**
 * 最近 N 条 run（ts DESC，默认 200）。不含 rawOutput（走 GET /api/distill-runs/:jobId）。
 * job 元数据（cwd/runtime/createdAt/sourceAgentId）通过 inArray 二次查询带出，避免
 * drizzle JOIN 结果键名不确定性。孤儿 run（job 已删）-> cwd=null / createdAt=0。
 */
export async function listRecentDistillRuns(
  db: DbClient, opts: { limit?: number } = {},
): Promise<DistillRunListRow[]> {
  const limit = opts.limit ?? DISTILL_RUNS_LIST_LIMIT
  const cols = {
    distillJobId: memoryDistillRuns.distillJobId, outcome: memoryDistillRuns.outcome,
    rawCount: memoryDistillRuns.distilledCount, acceptedCount: memoryDistillRuns.acceptedCount,
    dedupedCount: memoryDistillRuns.dedupedCount, filteredCount: memoryDistillRuns.filteredCount,
    storedCount: memoryDistillRuns.storedCount, discardedCount: memoryDistillRuns.discardedCount,
    durationMs: memoryDistillRuns.durationMs, errorMessage: memoryDistillRuns.errorMessage,
    ts: memoryDistillRuns.ts,
  }
  const runRows = await db.select(cols).from(memoryDistillRuns)
    .orderBy(desc(memoryDistillRuns.ts)).limit(limit).all()
  if (runRows.length === 0) return []
  const jobRows = await db.select().from(memoryDistillJobs)
    .where(inArray(memoryDistillJobs.id, runRows.map((r) => r.distillJobId))).all()
  const jobById = new Map(jobRows.map((j) => [j.id, j]))
  return runRows.map((r) => {
    const j = jobById.get(r.distillJobId)
    return {
      distillJobId: r.distillJobId, outcome: r.outcome as DistillOutcome,
      rawCount: r.rawCount, acceptedCount: r.acceptedCount, dedupedCount: r.dedupedCount,
      filteredCount: r.filteredCount, storedCount: r.storedCount, discardedCount: r.discardedCount,
      durationMs: r.durationMs, errorMessage: r.errorMessage ?? null, ts: r.ts,
      cwd: j?.cwd ?? null, runtime: j?.runtime ?? '', createdAt: j?.createdAt ?? 0,
      sourceAgentId: j?.sourceAgentId ?? null,
    }
  })
}

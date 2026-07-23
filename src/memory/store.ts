import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import { memories, memoryDiscards } from '@/db/schema'
import {
  canTransition,
  type InjectableMemorySet,
  type MemoryScope,
  type MemoryStatus,
  type RuntimeTag,
} from './pure'

import type { ExistingMemoryForDedup } from './dedup'
import type { ValueClass } from './valueFilter'

export interface MemoryInput {
  scopeType: MemoryScope
  scopeId: string | null
  title: string
  bodyMd: string
  tags: string[]
  sourceKind: 'conversation' | 'error' | 'manual'
  runtime: RuntimeTag
  sourceCwd?: string | null
  sourceEventId?: string | null
  distillJobId?: string | null
  distillAction?: 'new' | 'update_of' | 'duplicate_of' | 'conflict_with' | null
  valueClass?: ValueClass | null
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
  })
  return rowToMemory({ id, scopeType: input.scopeType, scopeId: input.scopeId, runtime: input.runtime,
    title: input.title, bodyMd: input.bodyMd, tags: JSON.stringify(input.tags), status: 'candidate',
    sourceKind: input.sourceKind, sourceCwd: input.sourceCwd ?? null,
    sourceEventId: input.sourceEventId ?? null, distillJobId: input.distillJobId ?? null,
    distillAction: input.distillAction ?? null, supersedesId: null, supersededById: null, approvedAt: null,
    createdAt: now, version: 1, valueClass: input.valueClass ?? null })
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
  })
  return {
    byScope: {
      project: projectRows.filter(filterRuntime).map(toRow),
      global: globalRows.filter(filterRuntime).map(toRow),
    },
  }
}

export const DEDUP_EXISTING_LIMIT = 50

/**
 * Load same-scope candidate + approved memories for dedup comparison. project =
 * exact scopeId match; global = scopeId IS NULL. Returns approved (all) + candidate
 * (createdAt DESC LIMIT DEDUP_EXISTING_LIMIT), de-duped by id, projecting only
 * {id,title,scopeType,scopeId,status} (no body/runtime, to keep the dedup prompt
 * small). Other statuses (archived/rejected/superseded) excluded.
 */
export async function listForDedupByScope(
  db: DbClient,
  opts: { scopeType: MemoryScope; scopeId: string | null },
): Promise<ExistingMemoryForDedup[]> {
  const scopeClause = opts.scopeId === null ? isNull(memories.scopeId) : eq(memories.scopeId, opts.scopeId)
  const cols = { id: memories.id, title: memories.title, scopeType: memories.scopeType, scopeId: memories.scopeId, status: memories.status }
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
    out.push({ id: r.id, title: r.title, scopeType: r.scopeType as MemoryScope, scopeId: r.scopeId, status: r.status as MemoryStatus })
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

export interface DiscardRecord {
  title: string
  bodyMd: string
  reason: 'public-knowledge' | 'derivable'
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
    })),
  )
}

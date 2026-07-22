import { and, desc, eq, inArray } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import { memories } from '@/db/schema'
import {
  canTransition,
  type InjectableMemorySet,
  type MemoryScope,
  type MemoryStatus,
  type RuntimeTag,
} from './pure'

export interface MemoryInput {
  scopeType: MemoryScope
  scopeId: string | null
  title: string
  bodyMd: string
  tags: string[]
  sourceKind: 'conversation' | 'error' | 'manual'
  runtime: RuntimeTag
  sourceEventId?: string | null
  distillJobId?: string | null
  distillAction?: 'new' | 'update_of' | 'duplicate_of' | 'conflict_with' | null
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
  sourceEventId: string | null
  distillJobId: string | null
  distillAction: string | null
  supersedesId: string | null
  supersededById: string | null
  approvedAt: number | null
  createdAt: number
  version: number
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
    sourceKind: r.sourceKind, sourceEventId: r.sourceEventId ?? null,
    distillJobId: r.distillJobId ?? null, distillAction: r.distillAction ?? null,
    supersedesId: r.supersedesId ?? null, supersededById: r.supersededById ?? null,
    approvedAt: r.approvedAt ?? null, createdAt: r.createdAt, version: r.version,
  }
}

export async function createCandidate(db: DbClient, input: MemoryInput): Promise<Memory> {
  const id = ulid()
  const now = Date.now()
  await db.insert(memories).values({
    id, scopeType: input.scopeType, scopeId: input.scopeId, runtime: input.runtime,
    title: input.title, bodyMd: input.bodyMd, tags: JSON.stringify(input.tags),
    status: 'candidate', sourceKind: input.sourceKind,
    sourceEventId: input.sourceEventId ?? null, distillJobId: input.distillJobId ?? null,
    distillAction: input.distillAction ?? null, supersedesId: null, supersededById: null,
    approvedAt: null, createdAt: now, version: 1,
  })
  return rowToMemory({ id, scopeType: input.scopeType, scopeId: input.scopeId, runtime: input.runtime,
    title: input.title, bodyMd: input.bodyMd, tags: JSON.stringify(input.tags), status: 'candidate',
    sourceKind: input.sourceKind, sourceEventId: input.sourceEventId ?? null, distillJobId: input.distillJobId ?? null,
    distillAction: input.distillAction ?? null, supersedesId: null, supersededById: null, approvedAt: null,
    createdAt: now, version: 1 })
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

// re-export for downstream tasks
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
    if (row.status === 'superseded' || row.status === 'rejected') {
      throw new MemoryConflictError(`memory ${id} is terminal ('${row.status}')`)
    }
    const changed: string[] = []
    const set: Record<string, unknown> = {}
    if (input.scopeType !== undefined && input.scopeType !== row.scopeType) {
      changed.push('scopeType')
      set.scopeType = input.scopeType
    }
    if (input.scopeId !== undefined && input.scopeId !== (row.scopeId ?? null)) {
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
    if (rows[0]!.status !== 'archived') {
      throw new MemoryConflictError(`memory ${id} is '${rows[0]!.status}', not 'archived'`)
    }
    tx.update(memories).set({ status: 'approved' }).where(eq(memories.id, id)).run()
    return rowToMemory(tx.select().from(memories).where(eq(memories.id, id)).limit(1).all()[0]!)
  })
}

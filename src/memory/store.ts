import { and, desc, eq } from 'drizzle-orm'
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

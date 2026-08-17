import type { Memory } from './store'
import type { MemoryScope, MemoryStatus, RuntimeTag } from './pure'
import type { ValueClass } from './valueFilter'
import type { DistillOrigin } from './distiller'

/** Memory → JSON 字符串快照（写入 memory_trash.memory_snapshot）。 */
export function snapshotMemory(m: Memory): string {
  return JSON.stringify(m)
}

function asString(v: unknown): string { return typeof v === 'string' ? v : '' }
function asStrOrNull(v: unknown): string | null { return typeof v === 'string' ? v : null }
function asNum(v: unknown): number { return typeof v === 'number' && Number.isFinite(v) ? v : 0 }
function asNumOrNull(v: unknown): number | null { return typeof v === 'number' && Number.isFinite(v) ? v : null }
function asStrArray(v: unknown): string[] { return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [] }

const STATUSES: ReadonlySet<MemoryStatus> = new Set(['candidate', 'approved', 'archived', 'superseded', 'rejected'])

/**
 * JSON 字符串 → Memory。解析失败/非对象返回 null；缺失字段回默认（null/0/''/[]），
 * 永不抛（spec §失败模式 #6：未来 Memory 加字段时旧 snapshot 缺字段不崩）。
 *
 * 逐字段用 helper 处理缺字段；不使用 `...EMPTY` 尾部 spread（那会覆盖前面已合法赋值
 * 的字段，把它们变回 null）。
 */
export function restoreFromSnapshot(snapshot: string): Memory | null {
  let p: any
  try { p = JSON.parse(snapshot) } catch { return null }
  if (typeof p !== 'object' || p === null || Array.isArray(p)) return null
  return {
    id: asString(p.id),
    scopeType: (p.scopeType === 'project' || p.scopeType === 'global' ? p.scopeType : 'global') as MemoryScope,
    scopeId: asStrOrNull(p.scopeId),
    runtime: (p.runtime === 'claude-code' || p.runtime === 'opencode' ? p.runtime : null) as RuntimeTag,
    title: asString(p.title),
    bodyMd: asString(p.bodyMd),
    tags: asStrArray(p.tags),
    status: (STATUSES.has(p.status) ? p.status : 'candidate') as MemoryStatus,
    sourceKind: asString(p.sourceKind),
    sourceCwd: asStrOrNull(p.sourceCwd),
    sourceEventId: asStrOrNull(p.sourceEventId),
    distillJobId: asStrOrNull(p.distillJobId),
    distillAction: asStrOrNull(p.distillAction),
    supersedesId: asStrOrNull(p.supersedesId),
    supersededById: asStrOrNull(p.supersededById),
    approvedAt: asNumOrNull(p.approvedAt),
    createdAt: asNum(p.createdAt),
    version: asNum(p.version),
    valueClass: asStrOrNull(p.valueClass) as ValueClass | null,
    subjectSlug: asStrOrNull(p.subjectSlug),
    origin: asStrOrNull(p.origin) as DistillOrigin | null,
    evidence: asStrOrNull(p.evidence),
  }
}

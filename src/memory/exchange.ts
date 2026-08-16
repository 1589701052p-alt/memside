import type { Memory } from './store'
import type { MemoryScope, MemoryStatus, RuntimeTag } from './pure'
import type { ValueClass } from './valueFilter'
import type { DistillOrigin } from './distiller'

export const MEMSIDE_JSON_FORMAT = 'memside-memories'
export const MEMSIDE_JSON_VERSION = 1

export interface ExchangeEnvelope {
  format: string
  version: number
  exportedAt: number
  memories: unknown[]
}

/** Memory[] → memside JSON envelope 字符串（高保真，spec §导出格式 §1）。 */
export function serializeMemoriesJson(memories: Memory[], exportedAt?: number): string {
  const env: ExchangeEnvelope = {
    format: MEMSIDE_JSON_FORMAT,
    version: MEMSIDE_JSON_VERSION,
    exportedAt: exportedAt ?? 0,
    memories,
  }
  return JSON.stringify(env)
}

const VALID_SCOPES = new Set(['project', 'global'])
const VALID_RUNTIMES = new Set(['claude-code', 'opencode', null])
const VALID_STATUSES = new Set(['candidate', 'approved', 'archived', 'superseded', 'rejected'])

function asStr(v: unknown): string { return typeof v === 'string' ? v : '' }
function asStrOrNull(v: unknown): string | null { return typeof v === 'string' ? v : null }
function asNum(v: unknown): number { return typeof v === 'number' && Number.isFinite(v) ? v : 0 }
function asNumOrNull(v: unknown): number | null { return typeof v === 'number' && Number.isFinite(v) ? v : null }
function asStrArray(v: unknown): string[] { return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [] }

/** 单条 Memory 解析；非法返回 null（spec §失败模式 #3 容错）。 */
function parseMemoryRecord(r: unknown): Memory | null {
  if (typeof r !== 'object' || r === null || Array.isArray(r)) return null
  const p = r as Record<string, unknown>
  const scopeType = (VALID_SCOPES.has(p.scopeType as string) ? p.scopeType : null) as MemoryScope | null
  if (!scopeType) return null
  const status = (VALID_STATUSES.has(p.status as string) ? p.status : null) as MemoryStatus | null
  if (!status) return null
  return {
    id: asStr(p.id),
    scopeType,
    scopeId: asStrOrNull(p.scopeId),
    runtime: (VALID_RUNTIMES.has(p.runtime as string) ? p.runtime : null) as RuntimeTag,
    title: asStr(p.title),
    bodyMd: asStr(p.bodyMd),
    tags: asStrArray(p.tags),
    status,
    sourceKind: asStr(p.sourceKind),
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

/**
 * memside JSON envelope → { memories, errors }。envelope 校验失败（format/version/
 * memories）整体拒绝返回空 + 1 条 error；逐条解析失败跳过计 errors，不整批失败。
 */
export function parseMemoriesJson(text: string): { memories: Memory[]; errors: string[] } {
  const errors: string[] = []
  let p: ExchangeEnvelope
  try { p = JSON.parse(text) } catch { return { memories: [], errors: ['invalid JSON'] } }
  if (typeof p !== 'object' || p === null || Array.isArray(p)) return { memories: [], errors: ['envelope not an object'] }
  if (p.format !== MEMSIDE_JSON_FORMAT) return { memories: [], errors: [`unexpected format: ${String(p.format)}`] }
  if (p.version !== MEMSIDE_JSON_VERSION) return { memories: [], errors: [`unexpected version: ${String(p.version)}`] }
  if (!Array.isArray(p.memories)) return { memories: [], errors: ['memories is not an array'] }
  const memories: Memory[] = []
  for (const r of p.memories) {
    const m = parseMemoryRecord(r)
    if (m) memories.push(m)
    else errors.push(`skipped invalid memory record at index ${memories.length + errors.length}`)
  }
  return { memories, errors }
}

/**
 * 自动识别导入格式：JSON.parse 成功且 format===memside-memories → 'json'；
 * 其余（含畸形 JSON、纯 markdown）→ 'markdown' 兜底。spec §格式自动识别。
 */
export function detectExchangeFormat(text: string): 'json' | 'markdown' {
  try {
    const p = JSON.parse(text)
    if (typeof p === 'object' && p !== null && !Array.isArray(p) && p.format === MEMSIDE_JSON_FORMAT) {
      return 'json'
    }
  } catch { /* fall through */ }
  return 'markdown'
}

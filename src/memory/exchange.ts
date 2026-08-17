import type { Memory, MemoryInput } from './store'
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

/** 空值/非字符串 helper（Markdown 序列化用）。 */
function tagsLine(tags: string[]): string | null {
  if (!tags.length) return null
  return `**标签**: ${tags.join(', ')}`
}
function slugLine(slug: string | null): string | null {
  return slug ? `**主题**: ${slug}` : null
}
function cwdLine(cwd: string | null): string | null {
  return cwd ? `**来源项目**: ${cwd}` : null
}
function scopeLine(scopeType: string, runtime: string | null): string {
  const parts = [scopeType]
  if (runtime) parts.push(runtime)
  return `**范围**: ${parts.join(' · ')}`
}

/**
 * Memory[] → markdown 文档（低保真，人类可读，spec §导出格式 §2）。
 * exportedAt 缺省 0（纯函数不用 Date.now）；server 层传真实时间戳。
 */
export function serializeMemoriesMd(memories: Memory[], exportedAt?: number): string {
  const lines: string[] = [
    '# memside 记忆导出',
    '',
    `> 导出于 ${exportedAt ?? 0} · 共 ${memories.length} 条 · 来源:memside`,
    '',
  ]
  for (const m of memories) {
    lines.push('---', '')
    lines.push(`## ${m.title}`, '')
    lines.push(`- ${scopeLine(m.scopeType, m.runtime)}`)
    const cl = cwdLine(m.sourceCwd ?? m.scopeId); if (cl) lines.push(`- ${cl}`)
    const tl = tagsLine(m.tags); if (tl) lines.push(`- ${tl}`)
    const sl = slugLine(m.subjectSlug); if (sl) lines.push(`- ${sl}`)
    lines.push('', m.bodyMd, '')
  }
  return lines.join('\n')
}

const META_RE = /^-\s+\*\*(\S+)\*\*:\s*(.*)$/

/**
 * 解析 `## ` 小节 → MemoryInput（低保真，走 createCandidate，spec §Markdown 导入解析）。
 * 小节边界 = 下一个行首 `## ` 或文档尾；`---` 独占行为元信息→正文过渡分隔符（被消费，
 * 不进 bodyMd），已进入正文后的 `---` 视为普通正文，避免误切含 `---` 的 body。
 */
export function parseMemoriesMd(text: string): { inputs: MemoryInput[]; errors: string[] } {
  const inputs: MemoryInput[] = []
  const errors: string[] = []
  const rawLines = text.split('\n')
  // 跳到第一个 `## ` 小节；之后按小节切分。
  let i = 0
  while (i < rawLines.length && !rawLines[i]!.startsWith('## ')) i++
  while (i < rawLines.length) {
    if (!rawLines[i]!.startsWith('## ')) { i++; continue }
    const title = rawLines[i]!.slice(3).trim()
    i++
    // 收集元信息行 + 正文，直到下一个 `## `
    const meta: Record<string, string> = {}
    const bodyLines: string[] = []
    let inBody = false
    while (i < rawLines.length && !rawLines[i]!.startsWith('## ')) {
      const ln = rawLines[i]!
      if (!inBody) {
        const mm = META_RE.exec(ln)
        if (mm) { meta[mm[1]!] = mm[2]!.trim(); i++; continue }
        // `---` 独占行 = 显式元信息→正文过渡分隔符，消费掉不进 body
        if (ln.trim() === '---') { inBody = true; i++; continue }
        // 元信息之间的空行：跳过，不触发正文过渡（避免 title 后空行误切）
        if (ln.trim() === '') { i++; continue }
        // 非元信息非空行 -> 正文开始
        inBody = true
      }
      bodyLines.push(ln)
      i++
    }
    const scopeParts = (meta['范围'] ?? '').split('·').map((s) => s.trim()).filter(Boolean)
    const scopeType: MemoryScope = scopeParts[0] === 'project' ? 'project' : 'global'
    const runtime: RuntimeTag = scopeParts[1] === 'claude-code' || scopeParts[1] === 'opencode' ? scopeParts[1] : null
    const scopeId = meta['来源项目'] ?? null
    const tags = (meta['标签'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    const subjectSlug = meta['主题'] ?? undefined
    // bodyMd 去掉首尾空行
    const bodyMd = bodyLines.join('\n').replace(/^\n+/, '').replace(/\n+$/, '')
    if (!title && !bodyMd) { errors.push('empty section skipped'); continue }
    inputs.push({
      scopeType, scopeId, title, bodyMd, tags, sourceKind: 'manual', runtime,
      sourceCwd: scopeId, subjectSlug: subjectSlug ?? undefined,
    } as MemoryInput)
  }
  return { inputs, errors }
}

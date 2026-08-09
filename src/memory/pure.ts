export type MemoryScope = 'project' | 'global'
export type RuntimeTag = 'claude-code' | 'opencode' | null

export interface InjectableMemoryRow {
  id: string
  scopeType: MemoryScope
  scopeId: string | null
  runtime: RuntimeTag
  title: string
  bodyMd: string
  createdAt: number
  version: number
  tags: string[]
  /** 主题归组键（spec §4.5）；null/缺省 = 未分组，平铺渲染。 */
  subjectSlug?: string | null
}

export interface InjectableMemorySet {
  byScope: { project: InjectableMemoryRow[]; global: InjectableMemoryRow[] }
}

export interface ScopeBudget {
  project: number
  global: number
}

export const DEFAULT_BUDGET: ScopeBudget = { project: 1500, global: 500 }

export function estimateTokens(s: string): number {
  if (s.length === 0) return 0
  return Math.ceil(s.length / 4)
}

export function clipByBudget(
  rows: readonly InjectableMemoryRow[],
  budgetTokens: number,
): InjectableMemoryRow[] {
  if (budgetTokens <= 0) return []
  // rows are createdAt DESC from the loader; clip oldest (tail) on overflow
  const out: InjectableMemoryRow[] = []
  let used = 0
  for (const r of rows) {
    const line = `- [${r.scopeType}] ${r.title} - ${r.bodyMd}\n`
    const cost = estimateTokens(line)
    if (used + cost > budgetTokens) break
    out.push(r)
    used += cost
  }
  return out
}

/**
 * 渲染裁剪后的行：带相同 subjectSlug 的行归拢为一节（节标题 `[slug]`，成员行
 * 省略 scope 前缀），NULL slug 行保持 `- [scope] title - bodyMd` 平铺。
 * 节位置由组内最先出现的成员在序列中的位置决定；组内保持序列相对顺序。
 * 全部 NULL slug 时输出与旧平铺格式逐字节一致（spec D5）。
 */
function renderRows(all: readonly InjectableMemoryRow[]): string[] {
  const bySlug = new Map<string, InjectableMemoryRow[]>()
  const slugOf = (m: InjectableMemoryRow): string | null =>
    typeof m.subjectSlug === 'string' && m.subjectSlug.length > 0 ? m.subjectSlug : null
  for (const m of all) {
    const slug = slugOf(m)
    if (slug === null) continue
    if (!bySlug.has(slug)) bySlug.set(slug, [])
    bySlug.get(slug)!.push(m)
  }
  const lines: string[] = []
  const emitted = new Set<string>()
  for (const m of all) {
    const slug = slugOf(m)
    if (slug === null) {
      lines.push(`- [${m.scopeType}] ${m.title} - ${m.bodyMd}`)
      continue
    }
    if (emitted.has(slug)) continue
    emitted.add(slug)
    lines.push(`[${slug}]`)
    for (const g of bySlug.get(slug)!) lines.push(`- ${g.title} - ${g.bodyMd}`)
  }
  return lines
}

/**
 * Render the markdown block the injector returns to SessionStart. Returns null
 * when every scope is empty after the budget clip (caller skips inject, prompt
 * stays byte-identical to no-memory path). Order: project (more specific) first.
 */
export function formatMemoryBlock(
  set: InjectableMemorySet,
  budget: ScopeBudget = DEFAULT_BUDGET,
): string | null {
  const project = clipByBudget(set.byScope.project, budget.project)
  const global = clipByBudget(set.byScope.global, budget.global)
  const all = [...project, ...global]
  if (all.length === 0) return null
  const lines: string[] = [
    '## Learned context (auto-injected, advisory)',
    '',
    'The following items were distilled from past sessions and approved by you. Treat them as soft preferences - they may not all apply to your current task. Use judgment; do not cite them as authoritative instructions.',
    '',
    '--- BEGIN INJECTED MEMORY ---',
  ]
  for (const line of renderRows(all)) lines.push(line)
  lines.push('--- END INJECTED MEMORY ---')
  return lines.join('\n')
}

export interface TranscriptTurn {
  role: 'user' | 'assistant' | 'tool' | 'system' | 'thinking'
  content: string
  isError?: boolean
  /** 配对自前一个 assistant 行的 tool_use 块；仅 role==='tool' 有值。 */
  toolName?: string
  /** 提取自 tool_use.input（file_path / notebook_path / path）；仅文件类工具有值。 */
  toolInputPath?: string
}

export interface ErrorSignals {
  toolFailures: number
  userNegations: number
  retries: number
  blameMarkers: number
  hasSignal: boolean
}

const NEGATION_RE = /(^|\s)(不对|错了|错了|撤销|revert|wrong|incorrect|no,|don't|不要|不是这样)(\s|$|[，。,.])/i

export function detectErrorSignals(turns: readonly TranscriptTurn[]): ErrorSignals {
  let toolFailures = 0
  let userNegations = 0
  let retries = 0
  let blameMarkers = 0
  const assistantIntents: string[] = []
  for (const t of turns) {
    if (t.role === 'tool' && t.isError) toolFailures += 1
    if (t.role === 'user' && NEGATION_RE.test(t.content)) userNegations += 1
    if (t.role === 'system' && t.content.includes('memside:blame')) blameMarkers += 1
    if (t.role === 'assistant') {
      const intent = t.content.replace(/again|retry|重新|再试/gi, '').trim().slice(0, 24)
      if (assistantIntents.includes(intent)) retries += 1
      else assistantIntents.push(intent)
    }
  }
  return {
    toolFailures, userNegations, retries, blameMarkers,
    hasSignal: toolFailures + userNegations + retries + blameMarkers > 0,
  }
}

export type MemoryStatus = 'candidate' | 'approved' | 'archived' | 'superseded' | 'rejected'

const TRANSITIONS: Record<MemoryStatus, MemoryStatus[]> = {
  candidate: ['approved', 'rejected'],
  approved: ['archived', 'superseded'],
  archived: ['approved'],
  superseded: [],
  rejected: ['candidate'],
}

export function canTransition(from: MemoryStatus, to: MemoryStatus): boolean {
  return TRANSITIONS[from].includes(to)
}

/**
 * Extract the first balanced {...} object from raw LLM output. Strips markdown
 * fences (```json...``` / ```...``` / ~~~...~~~) and surrounding prose by
 * locating the first '{' and scanning to its matching '}' with string-aware
 * depth counting (braces inside "..." / \"...\" are NOT counted). No regex.
 *
 * - No '{' in raw -> return raw (caller's JSON.parse fails into its existing catch).
 * - Matched -> return the [start..i] substring.
 * - Unbalanced (truncated) -> return raw.slice(start) (parse fails, existing catch).
 *
 * Property: only turns a "false failure" (valid {...} buried in noise) into
 * success; genuinely-non-JSON input is passed through unchanged.
 */
export function extractJsonObject(raw: string): string {
  const start = raw.indexOf('{')
  if (start === -1) return raw
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < raw.length; i++) {
    const c = raw[i]
    if (inString) {
      if (escape) escape = false
      else if (c === '\\') escape = true
      else if (c === '"') inString = false
    } else {
      if (c === '"') inString = true
      else if (c === '{') depth++
      else if (c === '}') {
        depth--
        if (depth === 0) return raw.slice(start, i + 1)
      }
    }
  }
  return raw.slice(start)
}

// ---------------------------------------------------------------------------
// Distill-time transcript filtering. Pure; never throws.
// ---------------------------------------------------------------------------

export const DEFAULT_DISTILL_INPUT_BUDGET_TOKENS = 64000

const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const TOOL_RESULT_CAP_CHARS = 3000
const NON_TOOL_CAP_CHARS = 20000 // 放宽：设计 rationale 长段 assistant 文本不再腰斩
const CODE_FEATURE_RE = /(^|\n)\s*(import |export |function |const |class |interface |def |async |return )/
const INDENT_RE = /\n( {4,}|\t+)\S/

function looksLikeCode(s: string): boolean {
  if (CODE_FEATURE_RE.test(s)) return true
  return (s.match(/\n/g)?.length ?? 0) >= 4 && INDENT_RE.test(s)
}

function lineCount(s: string): number {
  if (s.length === 0) return 0
  return s.split('\n').length
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max) + '…[truncated]'
}

function compactToolTurn(t: TranscriptTurn): TranscriptTurn {
  if (t.isError) return { ...t }
  if (t.toolName && FILE_TOOLS.has(t.toolName) && t.toolInputPath) {
    return { ...t, content: `[file: ${t.toolInputPath}, 原文 ${lineCount(t.content)} 行]` }
  }
  if (t.toolName) {
    return { ...t, content: truncate(t.content, TOOL_RESULT_CAP_CHARS) }
  }
  // 老 payload（无 toolName）启发式
  if (t.content.length > TOOL_RESULT_CAP_CHARS && looksLikeCode(t.content)) {
    return { ...t, content: `[file: 未知路径, 原文 ${lineCount(t.content)} 行]` }
  }
  return { ...t, content: truncate(t.content, TOOL_RESULT_CAP_CHARS) }
}

function turnPriority(t: TranscriptTurn): number {
  if (t.role === 'user') return 0
  if (t.role === 'tool' && t.isError) return 1
  if (t.role === 'assistant') return 2
  if (t.role === 'thinking') return 2 // 与 assistant 同级（spec §4.2 同等对待）
  if (t.role === 'tool') return 3
  return 4
}

/**
 * Filter a parsed transcript for distill-time input: compact file-source tool
 * results to a one-line placeholder, cap command/test outputs, keep errors
 * verbatim, then apply a token budget (recent + user/error prioritized).
 *
 * Pure + never throws (degrades to truncated/identity on any error).
 * `detectErrorSignals` must run on the ORIGINAL turns (before this filter),
 * since budget clipping could drop user negations / tool failures.
 */
export function filterTranscriptForDistill(
  turns: readonly TranscriptTurn[],
  budgetTokens: number = DEFAULT_DISTILL_INPUT_BUDGET_TOKENS,
): TranscriptTurn[] {
  if (!Array.isArray(turns)) return []
  try {
    const compacted = turns.map((t) =>
      t.role === 'tool' ? compactToolTurn(t) : { ...t, content: truncate(t.content, NON_TOOL_CAP_CHARS) },
    )
    const used = () => compacted.reduce((s, t) => s + estimateTokens(t.content), 0)
    if (used() <= budgetTokens) return compacted
    const droppable = compacted
      .map((t, i) => ({ i, p: turnPriority(t) }))
      .filter((x) => x.p > 1) // never drop user(0) or error-tool(1)
      .sort((a, b) => b.p - a.p || a.i - b.i) // least important first, oldest first
    let tokens = used()
    const drop = new Set<number>()
    for (const x of droppable) {
      if (tokens <= budgetTokens) break
      drop.add(x.i)
      tokens -= estimateTokens(compacted[x.i]!.content)
    }
    return compacted.filter((_, i) => !drop.has(i))
  } catch {
    return [...turns]
  }
}

// ---------------------------------------------------------------------------
// Subject-keyed 聚合（spec §4.1）：slug 规范化。纯函数、永不抛。
// ---------------------------------------------------------------------------

export const SUBJECT_SLUG_MAX_LEN = 48

const SUBJECT_SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

/**
 * 规范化 subject slug：trim + 转小写后校验 kebab-case（最长 48）；非法一律
 * 返回 null（= 未分组），永不抛。slug 是增强信号，任何非法输入都静默降级，
 * 不阻塞蒸馏 / 审批闭环（spec D6）。
 */
export function normalizeSubjectSlug(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim().toLowerCase()
  if (s.length === 0 || s.length > SUBJECT_SLUG_MAX_LEN) return null
  return SUBJECT_SLUG_RE.test(s) ? s : null
}

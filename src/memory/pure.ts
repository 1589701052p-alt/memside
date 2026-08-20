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

/** 注入记忆块起始 marker（spec 2026-08-20 §3.3）。与 formatMemoryBlock 的围栏逐字一致。 */
export const INJECTED_MEMORY_MARKER = '--- BEGIN INJECTED MEMORY ---'

/**
 * 判定 content 是否是（或含）memside 注入的记忆块（spec 2026-08-20 §3.3）。
 * claude transcript 里注入块无官方来源字段，marker 是唯一识别信号；
 * opencode 无任何来源字段，marker 是唯一识别信号。永不抛：非 string 一律 false。
 */
export function isInjectedMemoryBlock(content: unknown): boolean {
  try {
    return typeof content === 'string' && content.includes(INJECTED_MEMORY_MARKER)
  } catch {
    return false
  }
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
    INJECTED_MEMORY_MARKER, // 起始 marker 单一事实来源（与 isInjectedMemoryBlock 的检测逐字一致）
  ]
  for (const line of renderRows(all)) lines.push(line)
  // END marker 保持字面量（spec 2026-08-20 §3.3）；起止 marker 成对出现，
  // 起始 marker 已抽常量为 INJECTED_MEMORY_MARKER，此处无第二个事实来源。
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
  /** 工具调用信息（input 紧凑 JSON，捕获时截 TOOL_INPUT_CAP_CHARS 字）。无则缺失（老 payload/无 input）。 */
  toolCall?: string
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

export type MemoryStatus = 'candidate' | 'approved' | 'archived' | 'superseded' | 'rejected' | 'pending_review'

const TRANSITIONS: Record<MemoryStatus, MemoryStatus[]> = {
  candidate: ['approved', 'rejected'],
  approved: ['archived', 'superseded'],
  archived: ['approved'],
  superseded: [],
  rejected: ['candidate'],
  // judge 暂停期间标记的 pending_review：judge 成功 / 用户手动接管可回 candidate；
  // 用户也可在暂停期间直接 approve / reject（spec §6.4 手动接管审批）。
  pending_review: ['candidate', 'approved', 'rejected'],
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

export const TOOL_INPUT_CAP_CHARS = 300

/**
 * 是否在 distill 输入剔除 thinking turn（spec 2026-08-19，数据驱动决策）。
 *
 * distill 输入膨胀根因分析（1222 条真实蒸馏记录）证明 thinking 占输入 50.8%、
 * 在撞预算天花板（>250KB）的输入里占 86.8%，但 529 条已落库记忆的 evidence 里
 * 0 条溯源到 thinking 块——高体积、零实证产出。默认 true 剔除；保留常量开关
 * 供未来 A/B 验证（若需恢复 rationale 通道，flip 为 false 即逐字节回到旧行为）。
 */
export const DROP_THINKING_TURNS = true

/**
 * 把 tool_use 的 input 对象序列化成紧凑 JSON 字符串，截断 TOOL_INPUT_CAP_CHARS 字。
 * 非对象 / 缺失 / 序列化抛错 -> undefined（不设 toolCall，与既有"取不到即跳过"一致）。
 * 一刀切：不做按工具特判（spec §4.1），新工具自动覆盖。
 *
 * 从 src/claude/transcript.ts 抽到 pure.ts 共享（claude + opencode 两条捕获链路
 * 逐字相同的 guard + stringify + 截断逻辑，DRY）。纯函数、永不抛。
 */
export function captureToolCall(input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  try {
    const s = JSON.stringify(input)
    if (typeof s !== 'string') return undefined
    return s.length > TOOL_INPUT_CAP_CHARS ? s.slice(0, TOOL_INPUT_CAP_CHARS) + '…[truncated]' : s
  } catch {
    // 循环引用 / bigint 等 -> 不设 toolCall（永不抛契约）
    return undefined
  }
}

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
  if (t.toolName && FILE_TOOLS.has(t.toolName)) {
    return { ...t, content: `[file: ${t.toolInputPath ?? '未知路径'}, 原文 ${lineCount(t.content)} 行]` }
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

const TASK_NOTIFICATION_MARKER = '<task-notification>'
const COMPACT_CONTINUATION_PREFIX = 'This session is being continued from a previous conversation'

/**
 * 剔除 distiller 输入里的两类 user-role 噪声（spec 2026-08-17 §1.1）：
 *   1. task-notification 块：content 含 `<task-notification>` XML（harness 后台 task 回调，零记忆价值）。
 *   2. compact 续接块：content 以 `This session is being continued from a previous conversation` 开头
 *      （历史压缩摘要，非本会话原话，作 evidence 出处不可靠；distiller 的 priorContext 段已单独提供背景）。
 *
 * 纯函数 + 永不抛：任何异常降级为返回原 turns（保守保留）。只识别 user role。
 * 在 filterTranscriptForDistill 的 compact/budget 之前执行。
 */
export function stripNoiseTurns(turns: readonly TranscriptTurn[]): TranscriptTurn[] {
  if (!Array.isArray(turns)) return []
  try {
    return turns.filter((t) => {
      if (t.role !== 'user') return true
      const c = t.content
      if (typeof c !== 'string') return true
      if (c.includes(TASK_NOTIFICATION_MARKER)) return false
      if (c.trimStart().startsWith(COMPACT_CONTINUATION_PREFIX)) return false
      return true
    })
  } catch {
    return [...turns]
  }
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
    const denoised = stripNoiseTurns(turns)
    const withoutThinking = DROP_THINKING_TURNS
      ? denoised.filter((t) => t.role !== 'thinking')
      : denoised
    const compacted = withoutThinking.map((t) =>
      t.role === 'tool' ? compactToolTurn(t) : { ...t, content: truncate(t.content, NON_TOOL_CAP_CHARS) },
    )
    const used = () => compacted.reduce(
      (s, t) => s + estimateTokens(t.content) + estimateTokens(t.toolCall ?? ''),
      0,
    )
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
      tokens -= estimateTokens(compacted[x.i]!.content) + estimateTokens(compacted[x.i]!.toolCall ?? '')
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

// ---------------------------------------------------------------------------
// 记忆 title 分类前缀提取（spec 2026-08-11-web-memory-filters §4.1）。
// ---------------------------------------------------------------------------

const CATEGORY_PREFIX_RE = /\[category:([^\]]*)\]/i

/**
 * 从记忆 title 提取 [category:xxx] 前缀的分类值（trim + 转小写）。
 * 提取不限定行首（用户可在审批卡片编辑 title 挪动前缀）；无匹配 / 空值 /
 * 非字符串输入一律返回 null，永不抛。与 exactDedup.ts 的剥离正则语义对齐。
 */
export function categoryFromTitle(title: unknown): string | null {
  if (typeof title !== 'string') return null
  const m = CATEGORY_PREFIX_RE.exec(title)
  if (!m) return null
  const v = m[1]!.trim().toLowerCase()
  return v.length > 0 ? v : null
}

// ---------------------------------------------------------------------------
// parse_error 原始输出截断（spec 2026-08-15 §5.6）。尾部权重更大：
// max_tokens 截断的断口在尾部；头部保留以识别围栏/散文。
// ---------------------------------------------------------------------------

export const RAW_TEXT_CAP_CHARS = 24_000
const RAW_TEXT_HEAD_CHARS = 8_000

/** null -> null；空串 -> ''（落盘）；<= cap 原样；超 cap 保留头 8000 + 尾 16000 并标记省略字数。 */
export function capRawText(raw: string | null): string | null {
  if (raw === null) return null
  if (raw.length === 0) return ''   // 空字符串也落盘（spec §3.2），区别于 null
  if (raw.length <= RAW_TEXT_CAP_CHARS) return raw
  const head = raw.slice(0, RAW_TEXT_HEAD_CHARS)
  const tail = raw.slice(-(RAW_TEXT_CAP_CHARS - RAW_TEXT_HEAD_CHARS))
  const omitted = raw.length - RAW_TEXT_CAP_CHARS
  return `${head}\n…[截断 ${omitted} 字]…\n${tail}`
}

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
  for (const m of all) lines.push(`- [${m.scopeType}] ${m.title} - ${m.bodyMd}`)
  lines.push('--- END INJECTED MEMORY ---')
  return lines.join('\n')
}

export interface TranscriptTurn {
  role: 'user' | 'assistant' | 'tool' | 'system'
  content: string
  isError?: boolean
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

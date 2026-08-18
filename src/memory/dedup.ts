import type { DistillCandidate } from '@/memory/distiller'
import type { MemoryScope, MemoryStatus } from '@/memory/pure'
import { runLlmSession, type RoundRecord } from './llmSession'
import { STEP_MAX_ATTEMPTS } from './stepState'
import type { LLMCall } from '@/llm'

export interface ExistingMemoryForDedup {
  id: string
  title: string
  bodyMd: string
  scopeType: MemoryScope
  scopeId: string | null
  status: MemoryStatus
}

export interface DedupInput {
  newCandidates: DistillCandidate[]
  existing: ExistingMemoryForDedup[]
  callLLM: LLMCall
  /**
   * Task 7 断点续跑接线（spec 2026-08-18 §5）：传 loadHistory 即带历史接续，
   * 单次只跑一轮新回合（多 scope 组各有独立对话，历史按「request 以本组 prompt
   * 开头」过滤，组间不串线）。缺省 = 无记忆 3 轮（独立调用语义）。
   */
  jobId?: string
  persistRound?: (r: RoundRecord) => Promise<void>
  loadHistory?: () => Promise<RoundRecord[]>
}

export type DedupVerdict =
  | { index: number; duplicate: false }
  | { index: number; duplicate: true; duplicateOfId: string }

/** Task 7：LLM 失败/重试耗尽返回失败标识（spec P1），scheduler 据此走 step 失败分支。 */
export type DedupJudgeResult = DedupVerdict[] | { failed: true; reasons: string[] }

export const DEDUP_SYSTEM_PROMPT = `You are memside-dedup. Decide whether each new candidate memory is a SEMANTIC DUPLICATE of any other item in the same scope — the same rule or fact, even if worded differently or tagged with a different [category:] prefix.

同一规则从"为什么这么做 / 实现要点 / 触发条件"等不同角度各写一条，仍是重复--只保留最完整的一条。例如以下三条都表达同一规则，只有第一条应保留：
  [category:invariant] 退款须在发货后14天内
  [category:invariant] 退款规则的14天期限不可被LLM以derivable丢弃
  [category:compliance] 14天退款窗口必须强制保留并标记valueClass

Compare each new candidate against BOTH (a) the existing memories listed below, and (b) its same-batch siblings (the other new candidates). A new candidate is a duplicate if it restates the same rule as an existing memory OR as an earlier new candidate (new-j where j < i).

输出格式如下（仅示范结构，勿照抄内容；只输出这一个 JSON 对象，无 markdown 围栏，无解释文字）：
{
  "verdicts": [
    {"index": 0, "isDuplicate": false},
    {"index": 1, "isDuplicate": true, "duplicateOfId": "A"},
    {"index": 2, "isDuplicate": true, "duplicateOfId": "new-0"}
  ]
}
Emit one verdict per new candidate, keyed by its index. duplicateOfId MUST be either an existing memory id or "new-j" with j < i (an earlier new candidate). Keep the earliest member of each duplicate group.`

function renderUserPrompt(newCandidates: DistillCandidate[], existing: ExistingMemoryForDedup[]): string {
  const exLines = existing.length > 0
    ? existing.map((e) => `id=${e.id} | ${e.title}\n${e.bodyMd}`).join('\n')
    : '(none)'
  const newLines = newCandidates.map((c, i) => `id=new-${i} | ${c.title}\n${c.bodyMd}`).join('\n---\n')
  return `Existing memories (same scope):\n${exLines}\n\nNew candidates:\n${newLines}\n\nReturn JSON per the system instructions.`
}

/**
 * Validate parsed dedup output for retry-worthiness. Returns an error message
 * to retry, or null to accept. Checks: parsed has a `verdicts` array, each
 * verdict has a numeric `index`, and any `isDuplicate:true` verdict references
 * a `duplicateOfId` that is either an existing id or a valid `new-j` (j < index). Exhausted retries fall through to the
 * existing per-verdict hallucination->new logic.
 */
function isValidDuplicateOf(id: string, index: number, existingIds: Set<string>): boolean {
  if (existingIds.has(id)) return true
  const m = /^new-(\d+)$/.exec(id)
  if (!m) return false
  const j = Number(m[1])
  return j >= 0 && j < index
}

function dedupShouldRetry(existingIds: Set<string>): (parsed: unknown) => string | null {
  return (parsed) => {
    if (!parsed || typeof parsed !== 'object') return '返回的不是 JSON 对象'
    const p = parsed as { verdicts?: unknown }
    if (!Array.isArray(p.verdicts)) return '缺少 verdicts 数组'
    for (let i = 0; i < p.verdicts.length; i++) {
      const v = p.verdicts[i] as Record<string, unknown> | null
      if (!v || typeof v.index !== 'number') return `verdict ${i} 缺少 index`
      if (v.isDuplicate === true) {
        if (typeof v.duplicateOfId !== 'string') return `verdict ${v.index} 标记重复但缺少 duplicateOfId`
        if (!isValidDuplicateOf(v.duplicateOfId, v.index as number, existingIds)) return `verdict ${v.index} 的 duplicateOfId 非法`
      }
    }
    return null
  }
}

/**
 * Judge each new candidate against same-scope existing memories for semantic
 * duplication. Pure + injectable `callLLM` (same seam as the distiller).
 *
 * Task 7（spec 2026-08-18 P1）：LLM 失败/重试耗尽不再保守全保留（旧 catch 兜底
 * 已废）——返回 `{failed:true, reasons}` 由调用方走 step 失败分支。成功响应内
 * 的单条幻觉（越界 index / 非法 duplicateOfId）仍按原语义保守判 not-duplicate。
 * When `existing` is empty AND `newCandidates` has <= 1 candidate, the LLM is
 * not called; with >= 2 candidates and no existing, it is called to compare siblings.
 */
export async function judgeDuplicates(input: DedupInput): Promise<DedupJudgeResult> {
  const n = input.newCandidates.length
  if (n === 0) return []
  // Skip the LLM only when there is nothing to compare against: no existing
  // AND at most one new candidate (no siblings to compare). With >=2 new
  // candidates and no existing, we still call to compare siblings.
  if (input.existing.length === 0 && input.newCandidates.length <= 1) {
    return input.newCandidates.map((_, i) => ({ index: i, duplicate: false }))
  }
  const existingIds = new Set(input.existing.map((e) => e.id))
  const userPrompt = renderUserPrompt(input.newCandidates, input.existing)
  // 多 scope 组共用 step='dedup' 的历史池：按「request 以本组 prompt 开头」过滤出
  // 本组自己的对话（followup 轮 request = initialUser + 追问，天然以本组 prompt 开头）。
  const rawHistory = input.loadHistory ? await input.loadHistory() : []
  const history = input.loadHistory ? rawHistory.filter((r) => r.request.startsWith(userPrompt)) : rawHistory
  const session = await runLlmSession({
    callLLM: input.callLLM,
    system: DEDUP_SYSTEM_PROMPT,
    initialUser: userPrompt,
    step: 'dedup',
    jobId: input.jobId ?? '',
    persistRound: input.persistRound,
    ...(input.loadHistory
      ? { loadHistory: async () => history, maxAttempts: history.length + 1 }
      : { maxAttempts: STEP_MAX_ATTEMPTS }),
    shouldRetry: dedupShouldRetry(existingIds),
  })
  if (!session.ok) return { failed: true, reasons: session.reasons }
  const parsed = session.parsed as { verdicts?: unknown } | undefined
  if (!parsed || !Array.isArray(parsed.verdicts)) {
    return { failed: true, reasons: ['dedup: 响应缺少 verdicts 数组'] }
  }
  const byIndex = new Map<number, DedupVerdict>()
  for (const v of parsed.verdicts) {
    if (!v || typeof v !== 'object') continue
    const o = v as { index?: unknown; isDuplicate?: unknown; duplicateOfId?: unknown }
    if (typeof o.index !== 'number' || o.index < 0 || o.index >= n) continue
    if (o.isDuplicate === true && typeof o.duplicateOfId === 'string' && isValidDuplicateOf(o.duplicateOfId, o.index, existingIds)) {
      byIndex.set(o.index, { index: o.index, duplicate: true, duplicateOfId: o.duplicateOfId })
    } else {
      // isDuplicate:false OR hallucinated duplicateOfId -> treat as new
      byIndex.set(o.index, { index: o.index, duplicate: false })
    }
  }
  // Any index the LLM omitted -> new (conservative)
  return input.newCandidates.map((_, i) => byIndex.get(i) ?? { index: i, duplicate: false })
}

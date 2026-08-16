import { makeLLMCall } from '@/anthropic'
import { loadClaudeCreds } from '@/creds'
import type { LLMCall } from '@/llm'
import type { TranscriptTurn } from '@/memory/pure'
// 注意：DistillCandidate 实际导出在 src/memory/distiller.ts（brief 原写 '@/memory/pure'，
// 已按 src/ 实际定义修正——grep 核实 pure.ts 不含该类型）。
import type { DistillCandidate } from '@/memory/distiller'

/**
 * Live LLM e2e 门禁共享脚手架（spec 2026-08-16）。
 * 只在 MEMSIDE_RUN_LIVE=1 且有凭证时真打模型；否则 test.skipIf 跳过。
 * 不改任何生产代码，仅复用 makeLLMCall / loadClaudeCreds。
 */

/** 凭证守卫：loadClaudeCreds 返回 apiKey 非 null 才算有凭证。 */
export const hasLiveCreds = loadClaudeCreds().apiKey != null

/** env 守卫：默认 bun test 不设 MEMSIDE_RUN_LIVE -> 全 skip。 */
export const LIVE_GUARD = hasLiveCreds && process.env.MEMSIDE_RUN_LIVE === '1'

/** 真实 callLLM（与生产 daemon 同源 makeLLMCall）。 */
export const realCallLLM: LLMCall = makeLLMCall()

/**
 * AI judge 的 callLLM。默认复用被测 realCallLLM（同源，盲区已知接受）。
 * 设 MEMSIDE_JUDGE_LLM_TOKEN 时走异源端点，消同源盲区。
 * 异源复用 makeLLMCall 的 loadClaudeCreds 注入点：构造一个假 creds loader。
 */
export function judgeCallLLM(): LLMCall {
  const token = process.env.MEMSIDE_JUDGE_LLM_TOKEN
  if (!token) return realCallLLM // 同源
  // 异源：注入自定义 creds loader，走 makeLLMCall
  return makeLLMCall({
    loadClaudeCreds: () => ({
      apiKey: token,
      baseURL: process.env.MEMSIDE_JUDGE_LLM_BASE_URL ?? undefined,
      model: process.env.MEMSIDE_JUDGE_LLM_MODEL ?? undefined,
      source: 'judge-env',
    }),
  })
}

/**
 * 手写固定 fixture（spec §6.2）：含业务规则陈述、thinking、tool_use+result、闲聊。
 * 确保 distill 稳定产出 ≥1 候选（业务规则），并验 thinking/toolCall 经真模型链路抵达。
 */
export function makeFixture(): TranscriptTurn[] {
  return [
    { role: 'user', content: 'Team rule: we only issue refunds within 14 days of shipment. No exceptions. Past that window, deny the request.' },
    { role: 'assistant', content: 'Understood. Refunds are only allowed within 14 days of shipment; after that I will deny the request.' },
    { role: 'thinking', content: 'The 14-day refund window is a hard business rule I must enforce in all refund decisions.' },
    { role: 'assistant', content: 'Let me check the current order to see if it qualifies.' },
    { role: 'assistant', content: '[tool:Bash]', toolName: 'Bash', toolCall: '{"command":"grep -r refund RULES.md"}' },
    { role: 'tool', content: 'no matches found', toolName: 'Bash' },
    { role: 'user', content: 'By the way, how is the weather today?' },
    { role: 'assistant', content: 'I can help with refund policy questions, but weather is outside my scope here.' },
  ]
}

/** Evidence judge system prompt：只判 evidence 摘句是否真出自 transcript 原文。 */
export const JUDGE_SYSTEM_PROMPT_EVIDENCE = `你是 memside 的 evidence 审查员。判断每条候选记忆的 evidence（原话摘句）是否真实出现在给定的 transcript 原文中。
只输出纯 JSON 对象，不要 markdown 围栏，不要解释文字：
{"verdicts":[{"index":0,"isPresent":true}]}
isPresent 为 true 当且仅当 evidence 文本（或其核心内容）确实出现在 transcript 原文中；模型编造的、不存在的原话判 false。`

export interface EvidenceVerdict { index: number; isPresent: boolean }

/**
 * AI judge 验 evidence 真伪（spec §5 检查 ③）。
 * 返回 { verdicts, judgeFailed }：judge 自身失败时 judgeFailed=true（调用方降级 skip 不红）。
 */
export async function judgeEvidence(
  transcript: TranscriptTurn[],
  candidates: DistillCandidate[],
  judgeCall: LLMCall,
): Promise<{ verdicts: EvidenceVerdict[]; judgeFailed: boolean }> {
  const transcriptText = transcript.map((t) => `[${t.role}] ${t.content}`).join('\n')
  const withEvidence = candidates
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => typeof c.evidence === 'string' && c.evidence.length > 0)
  if (withEvidence.length === 0) return { verdicts: [], judgeFailed: false }
  const userPrompt = `Transcript 原文：\n${transcriptText}\n\n候选记忆的 evidence：\n${withEvidence.map(({ c, i }) => `# ${i}\nevidence: ${c.evidence}`).join('\n')}\n\n判断每条 evidence 是否真实出现在 transcript 原文中。`
  try {
    const raw = await judgeCall(JUDGE_SYSTEM_PROMPT_EVIDENCE, userPrompt)
    // 复用 distiller 的 extractJsonObject 思路：扒围栏 + JSON.parse
    const parsed = safeParseJson(raw)
    if (!parsed || !Array.isArray((parsed as { verdicts?: unknown }).verdicts)) {
      return { verdicts: [], judgeFailed: true }
    }
    const verdicts = ((parsed as { verdicts: unknown[] }).verdicts)
      .filter((v): v is EvidenceVerdict =>
        !!v && typeof v === 'object' &&
        typeof (v as { index?: unknown }).index === 'number' &&
        typeof (v as { isPresent?: unknown }).isPresent === 'boolean')
    return { verdicts, judgeFailed: false }
  } catch {
    return { verdicts: [], judgeFailed: true }
  }
}

/** 扒 markdown 围栏 + JSON.parse（与 src/memory/distiller.ts extractJsonObject 同思路，本地副本，避免跨层 import 测试污染）。 */
function safeParseJson(raw: string): unknown | null {
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  const text = fenceMatch ? fenceMatch[1]! : raw
  try { return JSON.parse(text.trim()) } catch { return null }
}

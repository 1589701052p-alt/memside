import { makeLLMCall } from '@/anthropic'
import { loadClaudeCreds } from '@/creds'
import { resolveCallLLM } from '@/daemon'
import { openDb } from '@/db/client'
import { loadUiLlmConfig } from '@/settings'
import type { LLMCall } from '@/llm'
import type { TranscriptTurn } from '@/memory/pure'
// 注意：DistillCandidate 实际导出在 src/memory/distiller.ts（brief 原写 '@/memory/pure'，
// 已按 src/ 实际定义修正——grep 核实 pure.ts 不含该类型）。
import type { DistillCandidate } from '@/memory/distiller'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

/**
 * Live LLM e2e 门禁共享脚手架（spec 2026-08-16）。
 * 只在 MEMSIDE_RUN_LIVE=1 且有凭证时真打模型；否则 test.skipIf 跳过。
 * 不改任何生产代码，仅复用 makeLLMCall / loadClaudeCreds。
 */

/** 用户生产 DB 路径（与 daemon 默认同源：~/.memside/memside.db）。 */
const MEMSIDE_DB = join(homedir(), '.memside', 'memside.db')

/**
 * 真实 callLLM——与生产 daemon 同源组合根 `resolveCallLLM({}, db)`（spec §3.1）。
 * 复刻 daemon 的 db-backed UI 配置注入：每次调用现读 ~/.memside/memside.db 的
 * app_settings（Web UI 设置页写入的凭证整级短路），与生产 daemon 零分歧。
 * DB 不存在时降级为无 UI 级（makeLLMCall 走 ~/.claude/settings.json + env）。
 *
 * 修复背景：原 `makeLLMCall()` 不传 loadUiConfig，读不到 Web UI 配的有效凭证，
 * fallback 到 settings.json 的失效 token → 401。生产 daemon 通过 resolveCallLLM
 * 注入 db-backed loadUiConfig 才用上 UI 配的凭证；live test 必须复刻这步才算
 * 「与生产同源」。
 */
function makeLiveCallLLM(): LLMCall {
  if (existsSync(MEMSIDE_DB)) {
    return resolveCallLLM({}, openDb(MEMSIDE_DB))
  }
  // DB 不存在：退回 makeLLMCall（走 settings.json + env），与原行为一致
  return makeLLMCall()
}

/** 真实 callLLM（与生产 daemon 同源）。 */
export const realCallLLM: LLMCall = makeLiveCallLLM()

/**
 * 凭证守卫：有可用凭证才真跑（与生产 resolveCallLLM 用的同一凭证源）。
 * 优先看 UI 配（~/.memside/memside.db 的 app_settings），无 DB/无 UI token
 * 时兜底看 loadClaudeCreds（settings.json + env）。
 */
function resolveHasLiveCreds(): boolean {
  if (existsSync(MEMSIDE_DB)) {
    const db = openDb(MEMSIDE_DB)
    try {
      const ui = loadUiLlmConfig(db)
      if (ui?.token && ui.token.length > 0) {
        db.$client.close()
        return true
      }
    } catch {
      // DB 读异常 → 降级看 settings.json
    }
    db.$client.close()
  }
  return loadClaudeCreds().apiKey != null
}

/** env + 凭证双守卫：默认 bun test 不设 MEMSIDE_RUN_LIVE -> 全 skip。 */
export const LIVE_GUARD = resolveHasLiveCreds() && process.env.MEMSIDE_RUN_LIVE === '1'

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

/**
 * 大输入 fixture（spec §3.3）：~360 turn / ~12K tokens。
 * 模拟长寿会话：大量 assistant rationale + tool turn + 明确可提炼规则。
 * 用于 live e2e 逼出真实路径（124 tokens 的小 fixture 测不出 empty_output/parse_error）。
 * 含明确业务规则确保模型应产出 ≥1 候选（非 empty_output）。
 */
export function makeLargeFixture(): TranscriptTurn[] {
  const turns: TranscriptTurn[] = []
  // 开场：用户陈述明确规则（必被提炼）
  turns.push({ role: 'user', content: 'Team rule: all deployments must pass the smoke test before promote to production. No exceptions.' })
  turns.push({ role: 'assistant', content: 'Understood. Deployments require a passing smoke test before production promote; I will enforce this gate.' })
  turns.push({ role: 'thinking', content: 'The smoke-test-before-promote rule is a hard deployment invariant the user stated explicitly.' })
  // 中段：大量 rationale + tool（模拟长寿会话，撑大输入）
  for (let i = 0; i < 90; i++) {
    turns.push({ role: 'assistant', content: `Investigating step ${i}: I am checking the deployment config and reviewing the test output to confirm the gate is wired correctly. The smoke test must run against the staging endpoint before any promote action is taken, and the result must be a clean pass.` })
    turns.push({ role: 'assistant', content: '[tool:Bash]', toolName: 'Bash', toolCall: `{"command":"kubectl get deploy -n staging","description":"check staging deploy"}` })
    turns.push({ role: 'tool', content: `NAME READY STATUS\napp-${i} 1/1 Running\ncheck-${i} 1/1 Running`, toolName: 'Bash' })
    turns.push({ role: 'thinking', content: `The staging deploy ${i} is ready. The smoke test gate is in place. Before any promote I must confirm the smoke test passed.` })
  }
  // 收尾：另一条明确规则（确保多候选）
  turns.push({ role: 'user', content: 'Also: the rollback window is 30 minutes after promote. Past that, escalate to on-call instead of auto-rollback.' })
  turns.push({ role: 'assistant', content: 'Noted: rollback allowed within 30 minutes of promote; after that, escalate to on-call rather than auto-rollback.' })
  return turns
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

import type { TranscriptTurn } from '@/memory/pure'
import { captureToolCall, isInjectedMemoryBlock } from '@/memory/pure'

/** opencode message（PluginInput.client.session.messages 返回项的子集）。 */
export interface OpencodeMessage {
  info: { role: 'user' | 'assistant' }
  parts: OpencodePart[]
}

/** opencode Part 的判别联合（按 type 字段）。只列转换关心的形态，其余走 default 过滤。 */
export type OpencodePart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool'; tool?: string; callID?: string; input?: unknown; output?: string; error?: boolean; metadata?: Record<string, unknown> }
  | { type: string; [k: string]: unknown }

/**
 * 把 opencode session 消息转成 memside TranscriptTurn[]。
 * - user/assistant TextPart -> {role, content}
 * - ToolPart 按 callID 配对，tool result error -> isError；output 作为 tool turn content
 * - tool_use.input 经序列化截断作 toolCall 落 tool turn（spec §4.1）
 * - reasoning -> thinking turn（spec 2026-08-09 §4.1）；subtask/step/patch/snapshot/... 一律过滤
 * - user text part 含注入记忆块 marker -> role:"system"（spec 2026-08-20 §3.4）：opencode 无来源字段，
 *   marker 是唯一识别信号；防蒸馏器把已注入旧记忆当真人新规则重复提炼（自我复读）。assistant 不受影响。
 * 纯函数，malformed part 跳过不抛。入参非数组或单条 message 缺 parts 也跳过不抛（final-review Important #1）：
 * 真实 opencode 版本的 message 形态是文档化验证空缺，畸形 payload 不得让 capture 路由 500。
 */
export function parseOpencodeMessages(messages: OpencodeMessage[]): TranscriptTurn[] {
  if (!Array.isArray(messages)) return []
  const turns: TranscriptTurn[] = []
  // 第一遍：收集 tool_use（assistant 发起），按 callID 记 toolName + toolCall
  const toolMeta = new Map<string, { name: string; call?: string }>()
  for (const m of messages) {
    if (!Array.isArray(m.parts)) continue
    for (const p of m.parts) {
      const tp = p as any
      if (tp.type === 'tool' && tp.callID && tp.input !== undefined && tp.output === undefined) {
        const name = tp.tool ?? 'tool'
        toolMeta.set(tp.callID, { name, call: captureToolCall(tp.input) })
      }
    }
  }
  for (const m of messages) {
    if (!Array.isArray(m.parts)) continue
    for (const p of m.parts) {
      if (p.type === 'text') {
        const text = (p as any).text ?? ''
        // 注入记忆块 → system（spec 2026-08-20 §3.4）：opencode 无来源字段，
        // marker 是唯一识别信号；防自我复读。assistant 文本不受影响。
        const role = m.info.role === 'user' && isInjectedMemoryBlock(text) ? 'system' : m.info.role
        turns.push({ role, content: text })
      } else if (p.type === 'reasoning') {
        const rp = p as { text?: unknown }
        if (typeof rp.text === 'string') turns.push({ role: 'thinking', content: rp.text })
      } else if (p.type === 'tool') {
        const tp = p as any
        // tool result（有 output）-> tool turn；tool_use（有 input 无 output）不单独成 turn（input 已在配对 result）
        if (tp.output !== undefined) {
          const meta = tp.callID ? toolMeta.get(tp.callID) : undefined
          turns.push({
            role: 'tool',
            content: typeof tp.output === 'string' ? tp.output : JSON.stringify(tp.output),
            isError: tp.error === true,
            toolName: meta?.name,
            ...(meta?.call ? { toolCall: meta.call } : {}),
          })
        }
      }
      // 其余 part（subtask/step/patch/snapshot/agent/retry/compaction）-> 跳过
    }
  }
  return turns
}

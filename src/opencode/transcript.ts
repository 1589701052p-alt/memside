import type { TranscriptTurn } from '@/memory/pure'

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
 * - reasoning -> thinking turn（spec 2026-08-09 §4.1）；subtask/step/patch/snapshot/... 一律过滤
 * 纯函数，malformed part 跳过不抛。入参非数组或单条 message 缺 parts 也跳过不抛（final-review Important #1）：
 * 真实 opencode 版本的 message 形态是文档化验证空缺，畸形 payload 不得让 capture 路由 500。
 */
export function parseOpencodeMessages(messages: OpencodeMessage[]): TranscriptTurn[] {
  if (!Array.isArray(messages)) return []
  const turns: TranscriptTurn[] = []
  // 第一遍：收集 tool_use（assistant 发起），按 callID 记 toolName
  const toolNames = new Map<string, string>()
  for (const m of messages) {
    if (!Array.isArray(m.parts)) continue
    for (const p of m.parts) {
      const tp = p as any
      if (tp.type === 'tool' && tp.callID && tp.input !== undefined && tp.output === undefined) {
        toolNames.set(tp.callID, tp.tool ?? 'tool')
      }
    }
  }
  for (const m of messages) {
    if (!Array.isArray(m.parts)) continue
    for (const p of m.parts) {
      if (p.type === 'text') {
        turns.push({ role: m.info.role, content: (p as any).text ?? '' })
      } else if (p.type === 'reasoning') {
        const rp = p as { text?: unknown }
        if (typeof rp.text === 'string') turns.push({ role: 'thinking', content: rp.text })
      } else if (p.type === 'tool') {
        const tp = p as any
        // tool result（有 output）-> tool turn；tool_use（有 input 无 output）不单独成 turn（input 已在配对 result）
        if (tp.output !== undefined) {
          turns.push({
            role: 'tool',
            content: typeof tp.output === 'string' ? tp.output : JSON.stringify(tp.output),
            isError: tp.error === true,
            toolName: tp.callID ? toolNames.get(tp.callID) : undefined,
          })
        }
      }
      // 其余 part（subtask/step/patch/snapshot/agent/retry/compaction）-> 跳过
    }
  }
  return turns
}

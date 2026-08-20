import { test, expect } from 'bun:test'
import { parseOpencodeMessages } from '@/opencode/transcript'
import type { OpencodeMessage } from '@/opencode/transcript'

test('user TextPart -> user turn', () => {
  const msgs: OpencodeMessage[] = [{ info: { role: 'user' }, parts: [{ type: 'text', text: 'hello' } as any] }]
  expect(parseOpencodeMessages(msgs)).toEqual([{ role: 'user', content: 'hello' }])
})

test('assistant TextPart -> assistant turn', () => {
  const msgs: OpencodeMessage[] = [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: 'doing it' } as any] }]
  expect(parseOpencodeMessages(msgs)).toEqual([{ role: 'assistant', content: 'doing it' }])
})

test('ToolPart tool_use/tool_result paired by callID, error -> isError', () => {
  const msgs: OpencodeMessage[] = [{
    info: { role: 'assistant' },
    parts: [
      { type: 'tool', tool: 'bash', callID: 'c1', input: { command: 'ls' } } as any,
    ],
  }, {
    info: { role: 'user' },
    parts: [{ type: 'tool', callID: 'c1', output: 'boom', error: true } as any],
  }]
  const turns = parseOpencodeMessages(msgs)
  expect(turns.some(t => t.role === 'tool' && t.isError && t.toolName === 'bash')).toBe(true)
})

test('ReasoningPart -> thinking turn；subtask / StepStart 仍过滤', () => {
  const msgs: OpencodeMessage[] = [{
    info: { role: 'assistant' },
    parts: [
      { type: 'reasoning', text: 'thinking' } as any,
      { type: 'text', text: 'answer' } as any,
      { type: 'subtask', prompt: 'p', description: 'd', agent: 'a' } as any,
    ],
  }]
  const turns = parseOpencodeMessages(msgs)
  expect(turns).toEqual([
    { role: 'thinking', content: 'thinking' },
    { role: 'assistant', content: 'answer' },
  ])
})

test('reasoning part 缺 text 字段 -> 跳过不抛', () => {
  const msgs: OpencodeMessage[] = [{
    info: { role: 'assistant' },
    parts: [{ type: 'reasoning' } as any, { type: 'text', text: 'a' } as any],
  }]
  expect(parseOpencodeMessages(msgs)).toEqual([{ role: 'assistant', content: 'a' }])
})

test('empty messages -> []', () => {
  expect(parseOpencodeMessages([])).toEqual([])
})

test('malformed part skipped, no throw', () => {
  const msgs: OpencodeMessage[] = [{ info: { role: 'user' }, parts: [{ type: 'text' } as any, { type: 'unknown' } as any] }]
  expect(parseOpencodeMessages(msgs)).toEqual([{ role: 'user', content: '' }])
})

test('tool part 带 input -> toolCall；缺 input -> 无', () => {
  const msgs: OpencodeMessage[] = [{
    info: { role: 'assistant' },
    parts: [
      { type: 'tool', tool: 'bash', callID: 'c1', input: { command: 'ls -la' } } as any,
      { type: 'tool', tool: 'grep', callID: 'c2' } as any, // 缺 input
    ],
  }, {
    info: { role: 'user' },
    parts: [
      { type: 'tool', callID: 'c1', output: 'out1' } as any,
      { type: 'tool', callID: 'c2', output: 'out2' } as any,
    ],
  }]
  const turns = parseOpencodeMessages(msgs)
  const t1 = turns.find((t) => t.toolName === 'bash')
  const t2 = turns.find((t) => t.toolName === 'grep')
  expect(t1?.toolCall).toBe('{"command":"ls -la"}')
  expect(t2?.toolCall).toBeUndefined()
})

// ---------------------------------------------------------------------------
// 注入记忆块判定（spec 2026-08-20 §3.4）：opencode 无官方来源字段，marker
// 是唯一识别信号。messages.transform 注入的记忆块泄进 user message 若仍标
// role:"user"，蒸馏器会把已注入旧记忆当真人新规则重复提炼（自我复读）。
// ---------------------------------------------------------------------------

test('user text part 含注入记忆块 marker → role:"system"', () => {
  const messages = [
    {
      info: { role: 'user' as const },
      parts: [{ type: 'text', text: '## Learned context (auto-injected, advisory)\n\n--- BEGIN INJECTED MEMORY ---\n- [x] old memory\n--- END INJECTED MEMORY ---' }],
    },
  ]
  const turns = parseOpencodeMessages(messages)
  expect(turns.length).toBe(1)
  expect(turns[0]!.role).toBe('system')
})

test('user text part 普通文本 → role:"user"（不变）', () => {
  const messages = [
    { info: { role: 'user' as const }, parts: [{ type: 'text', text: 'hello there' }] },
  ]
  const turns = parseOpencodeMessages(messages)
  expect(turns[0]).toEqual({ role: 'user', content: 'hello there' })
})

test('assistant text part 不受注入判定影响', () => {
  const messages = [
    { info: { role: 'assistant' as const }, parts: [{ type: 'text', text: '--- BEGIN INJECTED MEMORY --- mention in reply' }] },
  ]
  const turns = parseOpencodeMessages(messages)
  expect(turns[0]!.role).toBe('assistant')
})

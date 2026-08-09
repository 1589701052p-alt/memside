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

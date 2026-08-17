import { test, expect } from 'bun:test'
import { stripNoiseTurns, filterTranscriptForDistill, type TranscriptTurn } from '@/memory/pure'

const user = (content: string): TranscriptTurn => ({ role: 'user', content })

const TASK_NOTIFICATION = `<task-notification>
<task-id>a71aa2b1cc0a5d290</task-id>
<tool-use-id>call_9379e39e11654219ae5a2b47</tool-use>
<output>some result text</output>
<usage><subagent_tokens>68440</subagent_tokens><tool_uses>12</tool_uses></usage>
</task-notification>`

const COMPACT = `This session is being continued from a previous conversation that ran out of context. The summary below captures the key points: the user wanted X and we decided Y.`

test('stripNoiseTurns: 剔除 task-notification 块', () => {
  const turns = [
    user('hello'),
    user(TASK_NOTIFICATION),
    user('we only issue refunds within 14 days'),
    user(TASK_NOTIFICATION),
  ]
  const out = stripNoiseTurns(turns)
  expect(out.length).toBe(2)
  expect(out.map((t) => t.content)).toEqual(['hello', 'we only issue refunds within 14 days'])
  expect(out.every((t) => !t.content.includes('<task-notification>'))).toBe(true)
})

test('stripNoiseTurns: 剔除 compact 续接块', () => {
  const turns = [user(COMPACT), user('normal user message'), user(COMPACT.slice(0, 50))]
  const out = stripNoiseTurns(turns)
  expect(out.length).toBe(2)
  expect(out[0]!.content).toBe('normal user message')
})

test('stripNoiseTurns: 不误伤其他 role', () => {
  const turns: TranscriptTurn[] = [
    { role: 'assistant', content: 'I will check the file.' },
    { role: 'thinking', content: 'considering the approach' },
    { role: 'tool', content: TASK_NOTIFICATION, toolName: 'Bash' }, // tool role 即使含 <task-notification> 也不剔
    user(TASK_NOTIFICATION),
  ]
  const out = stripNoiseTurns(turns)
  expect(out.length).toBe(3) // assistant + thinking + tool 保留，user-notification 剔
  expect(out.some((t) => t.role === 'assistant')).toBe(true)
  expect(out.some((t) => t.role === 'thinking')).toBe(true)
  expect(out.some((t) => t.role === 'tool')).toBe(true)
})

test('stripNoiseTurns: 不误伤含相似词的正常 user turn', () => {
  // 含 "previous conversation" / "task" 字样但非完整 pattern
  const turns = [
    user('in a previous conversation we discussed refunds'),  // 含相似词但非 compact 开头 -> 保留
    user('finish the task now'),                                // 含 "task" 但非 <task-notification> -> 保留
    user('  This session is being continued from a previous conversation'), // 前导空白 + compact pattern -> 剔
  ]
  const out = stripNoiseTurns(turns)
  expect(out.length).toBe(2) // 第三条剔除
  expect(out.some((t) => t.content === 'in a previous conversation we discussed refunds')).toBe(true)
  expect(out.some((t) => t.content === 'finish the task now')).toBe(true)
  expect(out.every((t) => !t.content.includes('This session is being continued'))).toBe(true)
})

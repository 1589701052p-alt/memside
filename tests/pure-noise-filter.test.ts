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

// ---------------------------------------------------------------------------
// §6.1 #5 永不抛边界（spec 2026-08-17 §6）：stripNoiseTurns 任何异常输入都不抛，
// 降级为返回原 turns 或空数组（保守保留 / 空输入）。
// ---------------------------------------------------------------------------

test('stripNoiseTurns: 非数组输入返回 []', () => {
  expect(stripNoiseTurns(null as unknown as TranscriptTurn[])).toEqual([])
  expect(stripNoiseTurns(undefined as unknown as TranscriptTurn[])).toEqual([])
})

test('stripNoiseTurns: turn content 非字符串时保留（不抛）', () => {
  const weird = [{ role: 'user', content: 123 as unknown as string }] as TranscriptTurn[]
  const out = stripNoiseTurns(weird)
  expect(out.length).toBe(1) // 非 string 走 typeof c !== 'string' -> 保留
})

test('stripNoiseTurns: 空数组返回空数组', () => {
  expect(stripNoiseTurns([])).toEqual([])
})

// ---------------------------------------------------------------------------
// §1.2 关键 bug 回归锁（spec 2026-08-17 §6）：剔除前，task-notification 噪声以
// user priority=0 强留，在超预算裁剪时把 assistant rationale（priority=2）挤掉；
// 剔除后噪声不进 budget 计算，rationale 不再被噪声挤光。budget=500 给 assistant
// 留足空间（去噪后全部 content 远低于预算，什么都不裁），锁定两个核心不变量：
// task-notification 零残留 + 至少 1 条 assistant rationale 保留。
// ---------------------------------------------------------------------------

test('filterTranscriptForDistill: 噪声剔除后 budget 不再挤掉 assistant rationale（§1.2 回归）', () => {
  const turns: TranscriptTurn[] = []
  // 20 条 task-notification 噪声（每条 ~200 字符，若不剔除会以 user priority=0 抢预算）
  for (let i = 0; i < 20; i++) {
    turns.push(user(`<task-notification><task-id>${i}</task-id><output>${'x'.repeat(150)}</output></task-notification>`))
  }
  // 3 条 assistant rationale（有价值）
  turns.push({ role: 'assistant', content: 'The 14-day refund rule is a hard invariant we must enforce.' })
  turns.push({ role: 'assistant', content: 'We decided to use bun test exclusively.' })
  turns.push({ role: 'assistant', content: 'Git push needs openssl backend due to proxy.' })
  // 1 条正常 user
  turns.push(user('refunds within 14 days'))

  const out = filterTranscriptForDistill(turns, 500)
  // task-notification 全部被 stripNoiseTurns 剔除（不进 budget 计算）
  expect(out.every((t) => !t.content.includes('<task-notification>'))).toBe(true)
  // assistant rationale 至少保留一条（噪声不占预算，budget=500 下完整保留）
  expect(out.some((t) => t.role === 'assistant')).toBe(true)
})

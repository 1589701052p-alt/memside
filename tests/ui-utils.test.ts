import { test, expect } from 'bun:test'
import { formatMemoryTime, sortCandidatesByTime, formatSourceTurn, formatOutcome, formatRunCounts } from '@/web/ui-utils'

// 纯函数层测试（CLAUDE.md「首选可断言面」）：覆盖 App.tsx 抽出的时间格式化 +
// 候选倒序排序。React 组件本身不单测，接线兜底见 tests/ui-sort-source.test.ts。
// 设计依据：docs/superpowers/specs/2026-07-27-candidate-time-sort-design.md §7。

type Item = { id: string; createdAt?: number }

// --- formatMemoryTime ---

test('formatMemoryTime: 合法 ts 返回非空本地化字符串，含 4 位年', () => {
  const ts = new Date('2026-07-27T14:32:00').getTime()
  const s = formatMemoryTime(ts)
  expect(s).not.toBe('')
  expect(s).toMatch(/\d{4}/) // 含年份成分（跨 locale 稳健）
})

test('formatMemoryTime: undefined / null -> ""', () => {
  expect(formatMemoryTime(undefined)).toBe('')
  expect(formatMemoryTime(null)).toBe('')
})

test('formatMemoryTime: NaN / Infinity / -Infinity -> ""（绝不返回 Invalid Date）', () => {
  expect(formatMemoryTime(NaN)).toBe('')
  expect(formatMemoryTime(Infinity)).toBe('')
  expect(formatMemoryTime(-Infinity)).toBe('')
})

// --- sortCandidatesByTime ---

test('sortCandidatesByTime: 按 createdAt 倒序（newest first）', () => {
  const items: Item[] = [
    { id: 'a', createdAt: 1000 },
    { id: 'b', createdAt: 3000 },
    { id: 'c', createdAt: 2000 },
  ]
  const sorted = sortCandidatesByTime(items)
  expect(sorted.map((i) => i.id)).toEqual(['b', 'c', 'a'])
})

test('sortCandidatesByTime: 缺值条目排尾', () => {
  const items: Item[] = [
    { id: 'old', createdAt: 1000 },
    { id: 'missing', createdAt: undefined },
    { id: 'new', createdAt: 3000 },
  ]
  const sorted = sortCandidatesByTime(items)
  expect(sorted.map((i) => i.id)).toEqual(['new', 'old', 'missing'])
})

test('sortCandidatesByTime: 全缺值不抛错、返回等长数组', () => {
  const items: Item[] = [{ id: 'a' }, { id: 'b' }]
  const sorted = sortCandidatesByTime(items)
  expect(sorted).toHaveLength(2)
})

test('sortCandidatesByTime: 不 mutate 输入数组', () => {
  const items: Item[] = [
    { id: 'a', createdAt: 1000 },
    { id: 'b', createdAt: 3000 },
  ]
  const snapshot = items.map((i) => i.id)
  sortCandidatesByTime(items)
  expect(items.map((i) => i.id)).toEqual(snapshot)
})

test('sortCandidatesByTime: 负数 ts 按数值大小参与排序', () => {
  const items: Item[] = [
    { id: 'a', createdAt: -100 },
    { id: 'b', createdAt: -300 },
    { id: 'c', createdAt: 100 },
  ]
  const sorted = sortCandidatesByTime(items)
  expect(sorted.map((i) => i.id)).toEqual(['c', 'a', 'b'])
})

// --- formatSourceTurn ---
// 原始输入遮罩层按 role 分色渲染的纯映射。CLAUDE.md「首选可断言面」：抽纯函数层测，
// React 组件不单测，靠 tests/web-ui.test.ts 源码文本兜底。

test('formatSourceTurn: user -> 蓝色标签', () => {
  const r = formatSourceTurn({ role: 'user', content: 'x' })
  expect(r.label).toBe('user')
  expect(r.color).toBe('#1565c0')
})

test('formatSourceTurn: assistant -> 深色标签', () => {
  const r = formatSourceTurn({ role: 'assistant', content: 'x' })
  expect(r.label).toBe('assistant')
  expect(r.color).toBe('#222')
})

test('formatSourceTurn: tool (non-error) -> 灰色标签', () => {
  const r = formatSourceTurn({ role: 'tool', content: 'x' })
  expect(r.label).toBe('tool')
  expect(r.color).toBe('#666')
})

test('formatSourceTurn: tool error -> 红色标签', () => {
  const r = formatSourceTurn({ role: 'tool', content: 'boom', isError: true })
  expect(r.label).toBe('tool')
  expect(r.color).toBe('#c00')
})

test('formatSourceTurn: unknown role -> 灰色 + 原角色名', () => {
  const r = formatSourceTurn({ role: 'system', content: 'x' })
  expect(r.label).toBe('system')
  expect(r.color).toBe('#666')
})

// --- formatOutcome ---
// 蒸馏记录 outcome 四态 -> 徽标 { label, color }。CLAUDE.md「首选可断言面」。
// 设计依据：docs/superpowers/specs/2026-07-29-distill-work-record-design.md §7。

test('formatOutcome maps four outcomes to label + color', () => {
  expect(formatOutcome('produced').color).toBe('#2e7d32')
  expect(formatOutcome('empty_output').color).toBe('#666')
  expect(formatOutcome('llm_error').color).toBe('#c00')
  expect(formatOutcome('skipped_no_new_turns').color).toBe('#999')
  expect(formatOutcome('produced').label).toBe('产出')
})

// --- formatRunCounts ---
// 计数链 distilled->deduped->filtered->stored 渲染为「N->M->K->J」。
// 纯函数，可单测。

test('formatRunCounts renders distilled->deduped->filtered->stored chain', () => {
  expect(formatRunCounts({ distilled: 5, deduped: 3, filtered: 1, stored: 1 })).toBe('5->3->1->1')
  expect(formatRunCounts({ distilled: 0, deduped: 0, filtered: 0, stored: 0 })).toBe('0->0->0->0')
})

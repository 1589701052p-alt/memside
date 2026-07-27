import { test, expect } from 'bun:test'
import { formatMemoryTime, sortCandidatesByTime } from '@/web/ui-utils'

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

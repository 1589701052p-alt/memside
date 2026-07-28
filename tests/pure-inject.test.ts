import { test, expect } from 'bun:test'
import {
  estimateTokens,
  clipByBudget,
  formatMemoryBlock,
  type InjectableMemoryRow,
  type InjectableMemorySet,
} from '@/memory/pure'

const row = (over: Partial<InjectableMemoryRow> = {}): InjectableMemoryRow => ({
  id: 'm1', scopeType: 'project', scopeId: 'p', title: 't', bodyMd: 'b',
  createdAt: 1, version: 1, tags: [], runtime: null, ...over,
})

test('estimateTokens is chars/4 rounded up', () => {
  expect(estimateTokens('')).toBe(0)
  expect(estimateTokens('abcd')).toBe(1)
  expect(estimateTokens('abcde')).toBe(2)
})

test('clipByBudget drops oldest rows that overflow', () => {
  // each line "- [project] t - b\n" = 18 chars = 5 tokens
  const rows = [
    row({ id: 'a', createdAt: 3, bodyMd: 'b' }),
    row({ id: 'b', createdAt: 2, bodyMd: 'b' }),
    row({ id: 'c', createdAt: 1, bodyMd: 'b' }),
  ]
  const clipped = clipByBudget(rows, 12) // 2 fit (10 tokens), oldest (c) overflows
  expect(clipped.length).toBe(2)
  expect(clipped.map((r) => r.id)).toEqual(['a', 'b']) // kept set + order locked
})

test('clipByBudget with budget <= 0 returns empty array', () => {
  const rows = [row({ id: 'a' })]
  expect(clipByBudget(rows, 0)).toEqual([])
})

test('formatMemoryBlock returns null when all scopes empty', () => {
  const empty: InjectableMemorySet = {
    byScope: { project: [], global: [] },
  }
  expect(formatMemoryBlock(empty)).toBeNull()
})

test('formatMemoryBlock renders anchored block with scope prefix', () => {
  const set: InjectableMemorySet = {
    byScope: {
      project: [row({ id: 'p1', title: 'Use ULID', bodyMd: 'ids are ULID' })],
      global: [row({ id: 'g1', scopeType: 'global', scopeId: null, title: 'English only', bodyMd: 'memories in English' })],
    },
  }
  const block = formatMemoryBlock(set)!
  expect(block).toContain('## Learned context (auto-injected, advisory)')
  expect(block).toContain('--- BEGIN INJECTED MEMORY ---')
  expect(block).toContain('--- END INJECTED MEMORY ---')
  expect(block).toContain('- [project] Use ULID - ids are ULID')
  expect(block).toContain('- [global] English only - memories in English')
  // project (more specific) listed before global
  expect(block.indexOf('Use ULID')).toBeLessThan(block.indexOf('English only'))
})

// subject-keyed 聚合（spec §4.5/D5）：裁剪后分组渲染；NULL slug 逐字节兼容。
// 注：复用文件顶部既有 row() 帮助函数（签名兼容 brief 中的用法），避免重复定义。

test('grouped rows render under a [slug] section header', () => {
  const block = formatMemoryBlock({
    byScope: {
      project: [
        row({ id: 'a', title: '退款须14天内', subjectSlug: 'refund-policy', createdAt: 3 }),
        row({ id: 'b', title: 'hook 装进 settings', subjectSlug: 'hook-install', createdAt: 2 }),
        row({ id: 'c', title: '退款期限不可丢弃', subjectSlug: 'refund-policy', createdAt: 1 }),
      ],
      global: [],
    },
  })
  const lines = block!.split('\n')
  const rIdx = lines.indexOf('[refund-policy]')
  const hIdx = lines.indexOf('[hook-install]')
  expect(rIdx).toBeGreaterThan(-1)
  expect(hIdx).toBeGreaterThan(-1)
  // 节位置由组内最先出现的成员决定（a 在 b 前 -> refund 节在 hook 节前）
  expect(rIdx).toBeLessThan(hIdx)
  // 组内成员保持裁剪后序列相对顺序，且省略 [scope] 前缀
  expect(lines[rIdx + 1]).toBe('- 退款须14天内 - b')
  expect(lines[rIdx + 2]).toBe('- 退款期限不可丢弃 - b')
  expect(lines[hIdx + 1]).toBe('- hook 装进 settings - b')
})

test('ungrouped rows keep the flat - [scope] format and stay in sequence position', () => {
  const block = formatMemoryBlock({
    byScope: {
      project: [
        row({ id: 'a', title: '未分组甲', subjectSlug: null, createdAt: 2 }),
        row({ id: 'b', title: '分组乙', subjectSlug: 'topic-x', createdAt: 1 }),
      ],
      global: [],
    },
  })
  expect(block).toContain('- [project] 未分组甲 - b')
  expect(block).toContain('[topic-x]')
  // 未分组行先于 topic-x 节（a 位置在前）
  expect(block!.indexOf('- [project] 未分组甲')).toBeLessThan(block!.indexOf('[topic-x]'))
})

test('all-NULL slugs render byte-identical to the legacy flat format', () => {
  const rows = [
    row({ id: 'a', title: '甲', createdAt: 2 }),
    row({ id: 'b', title: '乙', createdAt: 1 }),
  ]
  const block = formatMemoryBlock({ byScope: { project: rows, global: [] } })
  expect(block).toContain('- [project] 甲 - b\n- [project] 乙 - b')
  expect(block).not.toContain('[]')
})

test('budget-clipped group leaves no orphan section header', () => {
  // 预算只够第一行：分组行被裁掉 -> 不出现 [slug] 空节标题（D5：先裁后分组）
  const block = formatMemoryBlock(
    {
      byScope: {
        project: [
          row({ id: 'a', title: '未分组', subjectSlug: null, createdAt: 2 }),
          row({ id: 'b', title: '分组', subjectSlug: 'gone', createdAt: 1 }),
        ],
        global: [],
      },
    },
    { project: 6, global: 0 }, // 第一行约 5 token；两行约 10 token 超预算 -> 第二行被裁
  )
  expect(block).toContain('- [project] 未分组 - b')
  expect(block).not.toContain('[gone]')
})

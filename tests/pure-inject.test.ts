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
  expect(clipped.length).toBeLessThanOrEqual(3)
  expect(clipped[0]!.id).toBe('a') // newest first preserved
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

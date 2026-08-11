import { test, expect } from 'bun:test'
import { categoryFromTitle } from '@/memory/pure'

// 回归锁定：title 的 [category:xxx] 前缀提取（spec 2026-08-11-web-memory-filters §4.1）。
// 筛选 facets / category 过滤的可测面。提取不限定行首（用户可编辑 title 挪动前缀），
// 输出统一小写，任何输入永不抛。

test('categoryFromTitle: 行首前缀提取', () => {
  expect(categoryFromTitle('[category:invariant] 退款规则')).toBe('invariant')
})

test('categoryFromTitle: 中间前缀也能提取（编辑挪位容错）', () => {
  expect(categoryFromTitle('改过前缀 [category:convention] 规则')).toBe('convention')
})

test('categoryFromTitle: 大小写不敏感，输出转小写', () => {
  expect(categoryFromTitle('[CATEGORY:Invariant] X')).toBe('invariant')
  expect(categoryFromTitle('[Category:Data-Semantics] X')).toBe('data-semantics')
})

test('categoryFromTitle: 无前缀 / 空内部 / 非字符串 -> null（永不抛）', () => {
  expect(categoryFromTitle('没有前缀的标题')).toBeNull()
  expect(categoryFromTitle('[category:] 空')).toBeNull()
  expect(categoryFromTitle('[category:   ] 空白')).toBeNull()
  expect(categoryFromTitle('')).toBeNull()
  expect(categoryFromTitle(null)).toBeNull()
  expect(categoryFromTitle(undefined)).toBeNull()
  expect(categoryFromTitle(42)).toBeNull()
})

test('categoryFromTitle: 取第一个匹配', () => {
  expect(categoryFromTitle('[category:a] 与 [category:b]')).toBe('a')
})
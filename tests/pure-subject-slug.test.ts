import { test, expect } from 'bun:test'
import { normalizeSubjectSlug, SUBJECT_SLUG_MAX_LEN } from '@/memory/pure'

// subject-keyed 聚合（spec §4.1/D6）：slug 校验失败一律静默 null，永不抛。

test('accepts legal kebab-case slugs', () => {
  expect(normalizeSubjectSlug('refund-policy')).toBe('refund-policy')
  expect(normalizeSubjectSlug('a')).toBe('a')
  expect(normalizeSubjectSlug('hook-install-2')).toBe('hook-install-2')
})

test('normalizes case + surrounding whitespace', () => {
  expect(normalizeSubjectSlug('  Refund-Policy ')).toBe('refund-policy')
})

test('rejects illegal shapes -> null', () => {
  expect(normalizeSubjectSlug('refund policy')).toBeNull()   // 空格
  expect(normalizeSubjectSlug('refund_policy')).toBeNull()   // 下划线
  expect(normalizeSubjectSlug('-refund')).toBeNull()         // 前导连字符
  expect(normalizeSubjectSlug('refund-')).toBeNull()         // 尾随连字符
  expect(normalizeSubjectSlug('refund--policy')).toBeNull()  // 双连字符
  expect(normalizeSubjectSlug('退款')).toBeNull()             // 非 ascii
  expect(normalizeSubjectSlug('')).toBeNull()
  expect(normalizeSubjectSlug('   ')).toBeNull()
  expect(normalizeSubjectSlug('x'.repeat(SUBJECT_SLUG_MAX_LEN + 1))).toBeNull() // 超长
  expect(normalizeSubjectSlug('x'.repeat(SUBJECT_SLUG_MAX_LEN))).toBe('x'.repeat(SUBJECT_SLUG_MAX_LEN)) // 边界
})

test('non-string input -> null, never throws', () => {
  expect(normalizeSubjectSlug(undefined)).toBeNull()
  expect(normalizeSubjectSlug(null)).toBeNull()
  expect(normalizeSubjectSlug(42)).toBeNull()
  expect(normalizeSubjectSlug({})).toBeNull()
})

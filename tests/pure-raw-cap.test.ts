import { test, expect } from 'bun:test'
import { capRawText, RAW_TEXT_CAP_CHARS } from '@/memory/pure'

test('capRawText: null -> null；空串 -> 空串（非 null，不丢现场）；不超 cap 原样', () => {
  expect(capRawText(null)).toBeNull()
  expect(capRawText('')).toBe('')   // 空字符串也落盘（spec §3.2），区别于 null（无数据）
  const s = 'x'.repeat(1000)
  expect(capRawText(s)).toBe(s)
})

test('capRawText: 超 cap -> 头 8000 + 标记 + 尾 16000', () => {
  const raw = 'H'.repeat(10_000) + 'M'.repeat(4_000) + 'T'.repeat(16_000)
  const out = capRawText(raw)!
  expect(out.startsWith('H'.repeat(8000))).toBe(true)
  expect(out.endsWith('T'.repeat(16_000))).toBe(true)
  expect(out).toContain('…[截断 6000 字]…')
  expect(out.length).toBe(8000 + `\n…[截断 6000 字]…\n`.length + 16_000)
})

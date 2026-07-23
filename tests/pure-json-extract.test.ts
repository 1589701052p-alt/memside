import { test, expect } from 'bun:test'
import { extractJsonObject } from '@/memory/pure'

test('strips ```json fence', () => {
  expect(extractJsonObject('```json\n{"a":1}\n```')).toBe('{"a":1}')
})

test('strips bare ``` fence', () => {
  expect(extractJsonObject('```\n{"a":1}\n```')).toBe('{"a":1}')
})

test('strips ~~~ fence', () => {
  expect(extractJsonObject('~~~json\n{"a":1}\n~~~')).toBe('{"a":1}')
})

test('extracts object surrounded by prose', () => {
  expect(extractJsonObject('好的，结果如下：\n{"a":1}\n希望有帮助')).toBe('{"a":1}')
})

test('handles braces inside strings', () => {
  expect(extractJsonObject('{"title":"a{b}"}')).toBe('{"title":"a{b}"}')
})

test('handles escaped quote inside string', () => {
  // Locks the `escape` branch of the state machine (pure.ts): a backslash before
  // a quote must NOT close the string, so the `}` after it is counted as a real
  // closer. Regression here would silently mis-extract any JSON with escaped
  // quotes. Reviewer runtime-verified correctness; this test pins it.
  expect(extractJsonObject('{"a":"b\\"c"}')).toBe('{"a":"b\\"c"}')
})

test('handles nested objects', () => {
  expect(extractJsonObject('{"a":{"b":{"c":1}}}')).toBe('{"a":{"b":{"c":1}}}')
})

test('returns first balanced object when multiple', () => {
  expect(extractJsonObject('前缀{"a":1}尾部{"b":2}')).toBe('{"a":1}')
})

test('returns original when no brace (pure text)', () => {
  expect(extractJsonObject('I cannot help with that')).toBe('I cannot help with that')
})

test('returns slice from first brace when truncated', () => {
  expect(extractJsonObject('好的：{"a":1')).toBe('{"a":1')
})

test('returns empty string for empty input', () => {
  expect(extractJsonObject('')).toBe('')
})

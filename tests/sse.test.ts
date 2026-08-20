import { test, expect } from 'bun:test'
import { parseSseChunks } from '@/memory/sse'

test('完整一行一事件：data: {...}\n\n', () => {
  const r = parseSseChunks('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n', '')
  expect(r.events).toHaveLength(1)
  expect(r.events[0]!.data).toBe('{"choices":[{"delta":{"content":"hi"}}]}')
  expect(r.leftover).toBe('')
})

test('跨 chunk 拆断的行正确拼接', () => {
  const r1 = parseSseChunks('data: {"ch', '')
  expect(r1.events).toHaveLength(0)
  expect(r1.leftover).toBe('data: {"ch')
  const r2 = parseSseChunks('oices":[]}\n\n', r1.leftover)
  expect(r2.events).toHaveLength(1)
  expect(r2.events[0]!.data).toBe('{"choices":[]}')
  expect(r2.leftover).toBe('')
})

test('[DONE] 哨兵作为事件返回（payload 仍为 [DONE]）', () => {
  const r = parseSseChunks('data: [DONE]\n\n', '')
  expect(r.events).toHaveLength(1)
  expect(r.events[0]!.data).toBe('[DONE]')
})

test('空行 / :heartbeat 心跳行跳过', () => {
  const r = parseSseChunks(': heartbeat\n\ndata: {"a":1}\n\n', '')
  expect(r.events).toHaveLength(1)
  expect(r.events[0]!.data).toBe('{"a":1}')
})

test('data: 无空格前缀也识别', () => {
  const r = parseSseChunks('data:{"a":1}\n\n', '')
  expect(r.events).toHaveLength(1)
  expect(r.events[0]!.data).toBe('{"a":1}')
})

test('不完整行（无换行结尾）留作 leftover', () => {
  const r = parseSseChunks('data: {"un', '')
  expect(r.events).toHaveLength(0)
  expect(r.leftover).toBe('data: {"un')
})

test('CRLF 行尾正确剥离 \\r', () => {
  const r = parseSseChunks('data: {"a":1}\r\n\r\n', '')
  expect(r.events).toHaveLength(1)
  expect(r.events[0]!.data).toBe('{"a":1}')
  expect(r.leftover).toBe('')
})

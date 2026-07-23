import { test, expect } from 'bun:test'
import { callWithRetry } from '@/memory/retry'

test('returns parsed value on first success, no retry', async () => {
  let calls = 0
  const result = await callWithRetry({
    call: async () => { calls++; return '{"a":1}' },
    system: 'sys', user: 'usr',
    shouldRetry: () => null,
  })
  expect(calls).toBe(1)
  expect(result).toEqual({ a: 1 })
})

test('retries on parse failure and succeeds on retry', async () => {
  let calls = 0
  const result = await callWithRetry({
    call: async () => {
      calls++
      if (calls === 1) return 'not json'
      return '{"a":1}'
    },
    system: 'sys', user: 'usr',
    shouldRetry: () => null,
  })
  expect(calls).toBe(2)
  expect(result).toEqual({ a: 1 })
})

test('retries when shouldRetry returns an error', async () => {
  let calls = 0
  const result = await callWithRetry({
    call: async () => { calls++; return '{"a":1}' },
    system: 'sys', user: 'usr',
    shouldRetry: () => 'always bad',
  })
  expect(calls).toBe(3)
  expect(result).toEqual({ a: 1 })
})

test('returns undefined (lastParsed) when parse never succeeds', async () => {
  let calls = 0
  const result = await callWithRetry({
    call: async () => { calls++; return 'not json' },
    system: 'sys', user: 'usr',
    shouldRetry: () => null,
  })
  expect(calls).toBe(3)
  expect(result).toBeUndefined()
})

test('retries when call throws', async () => {
  let calls = 0
  const result = await callWithRetry({
    call: async () => {
      calls++
      if (calls === 1) throw new Error('api down')
      return '{"a":1}'
    },
    system: 'sys', user: 'usr',
    shouldRetry: () => null,
  })
  expect(calls).toBe(2)
  expect(result).toEqual({ a: 1 })
})

test('error feedback prompt includes last error message', async () => {
  const capturedUsers: string[] = []
  await callWithRetry({
    call: async (_sys, user) => { capturedUsers.push(user); return 'not json' },
    system: 'sys', user: 'original',
    shouldRetry: () => null,
  })
  expect(capturedUsers.length).toBe(3)
  expect(capturedUsers[0]).toBe('original')
  expect(capturedUsers[1]).toContain('original')
  expect(capturedUsers[1]).toContain('[修正]')
  expect(capturedUsers[1]).toMatch(/JSON/i)
})

test('respects maxRetries option', async () => {
  let calls = 0
  await callWithRetry({
    call: async () => { calls++; return 'not json' },
    system: 'sys', user: 'usr',
    shouldRetry: () => null,
    maxRetries: 0,
  })
  expect(calls).toBe(1)
})

test('fence-wrapped output is extracted and parsed without retry', async () => {
  let calls = 0
  const result = await callWithRetry({
    call: async () => { calls++; return '```json\n{"a":1}\n```' },
    system: 'sys', user: 'usr',
    shouldRetry: () => null,
  })
  expect(calls).toBe(1)
  expect(result).toEqual({ a: 1 })
})
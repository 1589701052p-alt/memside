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

test('shouldRetry error is fed back into the next prompt', async () => {
  // Locks the shouldRetry-rejection feedback branch (retry.ts: the path that
  // appends shouldRetry's error message to the next user prompt). The sibling
  // test above only asserts call count; this one asserts the feedback CONTENT
  // actually reaches the model, so a future refactor that drops the shouldRetry
  // error from currentUser goes red.
  const capturedUsers: string[] = []
  await callWithRetry({
    call: async (_sys, user) => { capturedUsers.push(user); return '{"a":1}' },
    system: 'sys', user: 'original',
    shouldRetry: () => 'always bad',
  })
  expect(capturedUsers.length).toBe(3)
  expect(capturedUsers[1]).toContain('always bad')
  expect(capturedUsers[1]).toContain('[修正]')
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

test('returns undefined when call throws on every attempt', async () => {
  // Locks the call-throws exhaustion path: call always throws -> never parses ->
  // returns undefined (lastParsed stays undefined), call count === maxRetries+1.
  // The sibling 'retries when call throws' only tests throw-once-then-succeed;
  // this one pins the all-attempts-thrown exhaustion so a regression that, say,
  // rethrows instead of returning lastParsed goes red.
  let calls = 0
  const result = await callWithRetry({
    call: async () => { calls++; throw new Error('always down') },
    system: 'sys', user: 'usr',
    shouldRetry: () => null,
  })
  expect(calls).toBe(3)
  expect(result).toBeUndefined()
})

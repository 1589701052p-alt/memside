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

test('onAttempt: parse失败/校验失败/通过三触发点 + 抛错不触发 + 回调抛错不影响流程', async () => {
  const { callWithRetry } = await import('@/memory/retry')
  // 三触发点
  const seen: { raw: string; error: string | null }[] = []
  let n = 0
  const call = async () => {
    n++
    if (n === 1) return 'not json at all'
    if (n === 2) return '{"foo":1}'
    return '{"candidates":[]}'
  }
  const r = await callWithRetry({
    call, system: 's', user: 'u',
    shouldRetry: (p) => (p && typeof p === 'object' && Array.isArray((p as any).candidates) ? null : '形状不对'),
    onAttempt: (info) => seen.push(info),
  })
  expect(r).toEqual({ candidates: [] })
  expect(seen.length).toBe(3)
  expect(seen[0].raw).toBe('not json at all')
  expect(seen[0].error).toContain('不是合法 JSON')
  expect(seen[1].raw).toBe('{"foo":1}')
  expect(seen[1].error).toBe('形状不对')
  expect(seen[2].error).toBeNull()

  // 抛错 attempt 不触发
  const seen2: unknown[] = []
  await callWithRetry({
    call: async () => { throw new Error('boom') }, system: 's', user: 'u',
    shouldRetry: () => null, maxRetries: 0,
    onAttempt: (i) => seen2.push(i),
  })
  expect(seen2.length).toBe(0)

  // 回调抛错不影响返回
  const r3 = await callWithRetry({
    call: async () => '{"candidates":[]}', system: 's', user: 'u',
    shouldRetry: () => null,
    onAttempt: () => { throw new Error('observer exploded') },
  })
  expect(r3).toEqual({ candidates: [] })
})

test('onAttempt: 末次 attempt 失败也触发（重试耗尽路径）', async () => {
  // Parse 失败耗尽：默认 3 次 attempt 都应触发 onAttempt，包括最后一次。
  const seen: { raw: string; error: string | null }[] = []
  let calls = 0
  const result = await callWithRetry({
    call: async () => { calls++; return 'not json' },
    system: 's', user: 'u',
    shouldRetry: () => null,
    onAttempt: (info) => seen.push(info),
  })
  expect(result).toBeUndefined()
  expect(calls).toBe(3)
  expect(seen.length).toBe(3)
  seen.forEach((s) => {
    expect(s.raw).toBe('not json')
    expect(s.error).toContain('不是合法 JSON')
  })

  // 校验失败耗尽：每次 shouldRetry 返回错误，末次也应触发。
  const seen2: { raw: string; error: string | null }[] = []
  let calls2 = 0
  const result2 = await callWithRetry({
    call: async () => { calls2++; return '{"foo":1}' },
    system: 's', user: 'u',
    shouldRetry: () => '形状不对',
    onAttempt: (info) => seen2.push(info),
  })
  expect(result2).toEqual({ foo: 1 })
  expect(calls2).toBe(3)
  expect(seen2.length).toBe(3)
  seen2.forEach((s) => {
    expect(s.raw).toBe('{"foo":1}')
    expect(s.error).toBe('形状不对')
  })
})

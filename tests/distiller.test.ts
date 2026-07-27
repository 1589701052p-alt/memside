import { test, expect } from 'bun:test'
import { distillTranscript, DISTILLER_SYSTEM_PROMPT } from '@/memory/distiller'

test('system prompt biases to business/architecture and requires category prefix', () => {
  expect(DISTILLER_SYSTEM_PROMPT).toContain('[category:invariant]')
  expect(DISTILLER_SYSTEM_PROMPT).toContain('business')
})

test('distillTranscript parses candidates from mocked API JSON', async () => {
  const fakeResponse = {
    candidates: [
      {
        title: '[category:invariant] refunds within 14 days',
        bodyMd: 'Refund window is 14 days after shipment.',
        scope: 'project', runtime: null,
        distillAction: 'new',
      },
    ],
  }
  const result = await distillTranscript({
    turns: [{ role: 'user', content: 'we only refund within 14 days' }],
    runtime: 'claude-code',
    cwd: '/repo',
    callLLM: async () => JSON.stringify(fakeResponse),
  })
  expect(result.length).toBe(1)
  expect(result[0]!.title).toContain('[category:')
  expect(result[0]!.scopeType).toBe('project')
})

test('distillTranscript returns [] on malformed response', async () => {
  const result = await distillTranscript({
    turns: [{ role: 'user', content: 'hi' }],
    runtime: 'claude-code', cwd: '/repo',
    callLLM: async () => 'not json',
  })
  expect(result).toEqual([])
})

test('distillTranscript never throws (swallows API errors)', async () => {
  const result = await distillTranscript({
    turns: [{ role: 'user', content: 'hi' }],
    runtime: 'claude-code', cwd: '/repo',
    callLLM: async () => { throw new Error('api down') },
  })
  expect(result).toEqual([])
})

test('distillTranscript parses fence-wrapped JSON (regression)', async () => {
  const result = await distillTranscript({
    turns: [{ role: 'user', content: 'we only refund within 14 days' }],
    runtime: 'claude-code',
    cwd: '/repo',
    callLLM: async () => '```json\n{"candidates":[{"title":"[category:invariant] refunds within 14 days","bodyMd":"14d","scope":"project","runtime":null,"distillAction":"new"}]}\n```',
  })
  expect(result.length).toBe(1)
  expect(result[0]!.title).toContain('[category:')
})

test('distillTranscript retries when candidate lacks [category: prefix', async () => {
  let calls = 0
  const result = await distillTranscript({
    turns: [{ role: 'user', content: 'x' }],
    runtime: 'claude-code', cwd: '/repo',
    callLLM: async () => {
      calls++
      if (calls === 1) return JSON.stringify({ candidates: [{ title: 'no prefix here', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] })
      return JSON.stringify({ candidates: [{ title: '[category:invariant] fixed', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] })
    },
  })
  expect(calls).toBe(2)
  expect(result.length).toBe(1)
  expect(result[0]!.title).toContain('[category:')
})

test('distillTranscript returns [] when retry exhausted', async () => {
  const result = await distillTranscript({
    turns: [{ role: 'user', content: 'x' }],
    runtime: 'claude-code', cwd: '/repo',
    callLLM: async () => 'not json',
  })
  expect(result).toEqual([])
})

test('DISTILLER_SYSTEM_PROMPT contains JSON template with example values', () => {
  expect(DISTILLER_SYSTEM_PROMPT).toContain('[category:')
  expect(DISTILLER_SYSTEM_PROMPT).toContain('"scope": "project"')
  expect(DISTILLER_SYSTEM_PROMPT).toContain('仅示范结构')
})

test('distillTranscript filters file-source Read results out of the LLM prompt', async () => {
  let captured = ''
  await distillTranscript({
    turns: [
      { role: 'user', content: 'read the file' },
      { role: 'tool', content: 'SECRET_SOURCE_CODE_LINE'.repeat(200), toolName: 'Read', toolInputPath: '/a.ts' },
    ],
    runtime: 'claude-code', cwd: '/r',
    callLLM: async (_sys, user) => { captured = user; return JSON.stringify({ candidates: [] }) },
  })
  expect(captured).toContain('[file: /a.ts')
  expect(captured).not.toContain('SECRET_SOURCE_CODE_LINE')
})

test('detectErrorSignals still sees original (unfiltered) tool failure', async () => {
  let captured = ''
  await distillTranscript({
    turns: [
      { role: 'tool', content: 'boom', toolName: 'Bash', isError: true },
    ],
    runtime: 'claude-code', cwd: '/r',
    callLLM: async (_sys, user) => { captured = user; return JSON.stringify({ candidates: [] }) },
  })
  expect(captured).toContain('"toolFailures":1')
  expect(captured).toContain('boom')
})

test('DISTILLER_SYSTEM_PROMPT rejects codebase implementation details', () => {
  expect(DISTILLER_SYSTEM_PROMPT).toContain('被开发仓库自身源码的实现细节')
})

test('distillTranscript defaults missing subject to codebase', async () => {
  // TDD: 第二轮条件门要求 DistillCandidate 带 subject。LLM 漏标时 distiller
  // 必须默认 codebase（精度优先：不保护，走 derivable 判定）。
  const result = await distillTranscript({
    turns: [{ role: 'user', content: 'x' }],
    runtime: 'claude-code', cwd: '/repo',
    callLLM: async () => JSON.stringify({ candidates: [{ title: '[category:invariant] x', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] }),
  })
  expect(result.length).toBe(1)
  expect(result[0]!.subject).toBe('codebase')
})

test('distillTranscript parses explicit subject=domain', async () => {
  const result = await distillTranscript({
    turns: [{ role: 'user', content: 'x' }],
    runtime: 'claude-code', cwd: '/repo',
    callLLM: async () => JSON.stringify({ candidates: [{ title: '[category:invariant] x', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new', subject: 'domain' }] }),
  })
  expect(result.length).toBe(1)
  expect(result[0]!.subject).toBe('domain')
})

test('distillTranscript retries when subject is invalid', async () => {
  // TDD: distillShouldRetry 必须对非法 subject 触发重试；第二次返回合法值。
  let calls = 0
  const result = await distillTranscript({
    turns: [{ role: 'user', content: 'x' }],
    runtime: 'claude-code', cwd: '/repo',
    callLLM: async () => {
      calls++
      if (calls === 1) return JSON.stringify({ candidates: [{ title: '[category:invariant] x', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new', subject: 'bogus' }] })
      return JSON.stringify({ candidates: [{ title: '[category:invariant] x', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new', subject: 'domain' }] })
    },
  })
  expect(calls).toBe(2)
  expect(result[0]!.subject).toBe('domain')
})

test('DISTILLER_SYSTEM_PROMPT contains subject field + DOMAIN-not-codebase invariant def', () => {
  expect(DISTILLER_SYSTEM_PROMPT).toContain('"subject"')
  expect(DISTILLER_SYSTEM_PROMPT).toContain('codebase = ')
  expect(DISTILLER_SYSTEM_PROMPT).toContain('domain = ')
  expect(DISTILLER_SYSTEM_PROMPT).toContain("DOMAIN (NOT about this codebase's own implementation)")
})

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

test('DISTILLER_SYSTEM_PROMPT has subject judgement heuristic (grep-able concrete things)', () => {
  // TDD（第三轮 §B）：dogfood 场景 subject 偏 domain，加判定启发让 LLM 区分
  // "仓库内能 grep 到的具体东西" vs "仓库外业务概念"。
  expect(DISTILLER_SYSTEM_PROMPT).toContain('grep')
  expect(DISTILLER_SYSTEM_PROMPT).toContain('具体东西')
})

test('DISTILLER_SYSTEM_PROMPT has generic placeholder subject examples', () => {
  // TDD（第三轮 §B）：通用占位符示例（X 模块的 Y 函数 / W 配置为值 V 等），
  // 示判定模式而非具体答案。
  expect(DISTILLER_SYSTEM_PROMPT).toContain('X 模块的 Y 函数')
  expect(DISTILLER_SYSTEM_PROMPT).toContain('W 配置为值 V')
  expect(DISTILLER_SYSTEM_PROMPT).toContain('外部系统 X 的 SLA 要求 Y')
})

test('DISTILLER_SYSTEM_PROMPT subject examples do not hardcode real memory symbols (anti-overfitting)', () => {
  // TDD（第三轮 §B 防过拟合硬约束）：示例不得针对已有记忆。断言 prompt 的示例区
  // 不含当前 dogfood 产物的真实符号--否则等于 hardcode 答案，换仓库就失效。
  // 注意：主体 prompt 仍会提到 valueFilter/daemon 等（作为 category 说明），这里只
  // 断言"通用示例"这一段不含这些词。取 subject 示例段（"通用示例"到段尾）校验。
  const prompt = DISTILLER_SYSTEM_PROMPT
  const exampleStart = prompt.indexOf('通用示例')
  expect(exampleStart).toBeGreaterThan(-1)
  const exampleSection = prompt.slice(exampleStart)
  // 真实记忆符号不得出现在示例段
  for (const real of ['valueFilter', 'token 预算', 'dedup', '64k', '条件门']) {
    expect(exampleSection).not.toContain(real)
  }
})

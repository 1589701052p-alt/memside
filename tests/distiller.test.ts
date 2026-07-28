import { test, expect } from 'bun:test'
import { distillTranscript, DISTILLER_SYSTEM_PROMPT } from '@/memory/distiller'
import type { TranscriptTurn } from '@/memory/pure'

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
  expect(result.candidates.length).toBe(1)
  expect(result.candidates[0]!.title).toContain('[category:')
  expect(result.candidates[0]!.scopeType).toBe('project')
})

test('distillTranscript returns [] on malformed response', async () => {
  const result = await distillTranscript({
    turns: [{ role: 'user', content: 'hi' }],
    runtime: 'claude-code', cwd: '/repo',
    callLLM: async () => 'not json',
  })
  expect(result.candidates).toEqual([])
})

test('distillTranscript never throws (swallows API errors)', async () => {
  const result = await distillTranscript({
    turns: [{ role: 'user', content: 'hi' }],
    runtime: 'claude-code', cwd: '/repo',
    callLLM: async () => { throw new Error('api down') },
  })
  expect(result.candidates).toEqual([])
})

test('distillTranscript parses fence-wrapped JSON (regression)', async () => {
  const result = await distillTranscript({
    turns: [{ role: 'user', content: 'we only refund within 14 days' }],
    runtime: 'claude-code',
    cwd: '/repo',
    callLLM: async () => '```json\n{"candidates":[{"title":"[category:invariant] refunds within 14 days","bodyMd":"14d","scope":"project","runtime":null,"distillAction":"new"}]}\n```',
  })
  expect(result.candidates.length).toBe(1)
  expect(result.candidates[0]!.title).toContain('[category:')
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
  expect(result.candidates.length).toBe(1)
  expect(result.candidates[0]!.title).toContain('[category:')
})

test('distillTranscript returns [] when retry exhausted', async () => {
  const result = await distillTranscript({
    turns: [{ role: 'user', content: 'x' }],
    runtime: 'claude-code', cwd: '/repo',
    callLLM: async () => 'not json',
  })
  expect(result.candidates).toEqual([])
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

test('distillTranscript defaults missing ruleObject to codebase', async () => {
  // TDD: 第二轮条件门要求 DistillCandidate 带 ruleObject。LLM 漏标时 distiller
  // 必须默认 codebase（精度优先：不保护，走 derivable 判定）。
  const result = await distillTranscript({
    turns: [{ role: 'user', content: 'x' }],
    runtime: 'claude-code', cwd: '/repo',
    callLLM: async () => JSON.stringify({ candidates: [{ title: '[category:invariant] x', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] }),
  })
  expect(result.candidates.length).toBe(1)
  expect(result.candidates[0]!.ruleObject).toBe('codebase')
})

test('distillTranscript parses explicit ruleObject=domain', async () => {
  const result = await distillTranscript({
    turns: [{ role: 'user', content: 'x' }],
    runtime: 'claude-code', cwd: '/repo',
    callLLM: async () => JSON.stringify({ candidates: [{ title: '[category:invariant] x', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new', ruleObject: 'domain' }] }),
  })
  expect(result.candidates.length).toBe(1)
  expect(result.candidates[0]!.ruleObject).toBe('domain')
})

test('distillTranscript retries when ruleObject is invalid', async () => {
  // TDD: distillShouldRetry 必须对非法 ruleObject 触发重试；第二次返回合法值。
  let calls = 0
  const result = await distillTranscript({
    turns: [{ role: 'user', content: 'x' }],
    runtime: 'claude-code', cwd: '/repo',
    callLLM: async () => {
      calls++
      if (calls === 1) return JSON.stringify({ candidates: [{ title: '[category:invariant] x', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new', ruleObject: 'bogus' }] })
      return JSON.stringify({ candidates: [{ title: '[category:invariant] x', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new', ruleObject: 'domain' }] })
    },
  })
  expect(calls).toBe(2)
  expect(result.candidates[0]!.ruleObject).toBe('domain')
})

test('DISTILLER_SYSTEM_PROMPT contains ruleObject field + DOMAIN-not-codebase invariant def', () => {
  expect(DISTILLER_SYSTEM_PROMPT).toContain('"ruleObject"')
  expect(DISTILLER_SYSTEM_PROMPT).toContain('codebase = ')
  expect(DISTILLER_SYSTEM_PROMPT).toContain('domain = ')
  expect(DISTILLER_SYSTEM_PROMPT).toContain("DOMAIN (NOT about this codebase's own implementation)")
})

test('DISTILLER_SYSTEM_PROMPT has ruleObject judgement heuristic (grep-able concrete things)', () => {
  // TDD（第三轮 §B）：dogfood 场景 ruleObject 偏 domain，加判定启发让 LLM 区分
  // "仓库内能 grep 到的具体东西" vs "仓库外业务概念"。
  expect(DISTILLER_SYSTEM_PROMPT).toContain('grep')
  expect(DISTILLER_SYSTEM_PROMPT).toContain('具体东西')
})

test('DISTILLER_SYSTEM_PROMPT has generic placeholder ruleObject examples', () => {
  // TDD（第三轮 §B）：通用占位符示例（X 模块的 Y 函数 / W 配置为值 V 等），
  // 示判定模式而非具体答案。
  expect(DISTILLER_SYSTEM_PROMPT).toContain('X 模块的 Y 函数')
  expect(DISTILLER_SYSTEM_PROMPT).toContain('W 配置为值 V')
  expect(DISTILLER_SYSTEM_PROMPT).toContain('外部系统 X 的 SLA 要求 Y')
})

test('DISTILLER_SYSTEM_PROMPT ruleObject examples do not hardcode real memory symbols (anti-overfitting)', () => {
  // TDD（第三轮 §B 防过拟合硬约束）：示例不得针对已有记忆。断言 prompt 的示例区
  // 不含当前 dogfood 产物的真实符号--否则等于 hardcode 答案，换仓库就失效。
  // 注意：主体 prompt 仍会提到 valueFilter/daemon 等（作为 category 说明），这里只
  // 断言"通用示例"这一段不含这些词。取 ruleObject 示例段（"通用示例"到段尾）校验。
  const prompt = DISTILLER_SYSTEM_PROMPT
  const exampleStart = prompt.indexOf('通用示例')
  expect(exampleStart).toBeGreaterThan(-1)
  const exampleSection = prompt.slice(exampleStart)
  // 真实记忆符号不得出现在示例段
  for (const real of ['valueFilter', 'token 预算', 'dedup', '64k', '条件门']) {
    expect(exampleSection).not.toContain(real)
  }
})

test('DISTILLER_SYSTEM_PROMPT has [stated] origin discipline with 6 exclusions', () => {
  // 第六轮第 1 项：[stated] 起源判定。distiller 只记用户/领域明确陈述的持久事实，
  // 显式排除六类非陈述内容（推断/前瞻/研究输出/丰富化/道听途说/自己的推理）。
  // 源码层文本断言锁 prompt 契约（LLM 遵循度由 dogfood 验证，非单测范围）。
  expect(DISTILLER_SYSTEM_PROMPT).toContain('Origin discipline')
  expect(DISTILLER_SYSTEM_PROMPT).toContain('推断')
  expect(DISTILLER_SYSTEM_PROMPT).toContain('前瞻')
  expect(DISTILLER_SYSTEM_PROMPT).toContain('研究输出')
  expect(DISTILLER_SYSTEM_PROMPT).toContain('丰富化')
  expect(DISTILLER_SYSTEM_PROMPT).toContain('道听途说')
  expect(DISTILLER_SYSTEM_PROMPT).toContain('推理或建议')
})

test('distillTranscript returns filteredTurns equal to filterTranscriptForDistill output (snapshot fidelity)', async () => {
  // 快照忠实：返回的 filteredTurns 必须等于内部 filterTranscriptForDistill(turns)。
  // 存的就是当时喂给模型的，零偏差。
  const { filterTranscriptForDistill } = await import('@/memory/pure')
  const turns: TranscriptTurn[] = [
    { role: 'user', content: 'read the file' },
    { role: 'tool', content: 'X'.repeat(5000), toolName: 'Read', toolInputPath: '/a.ts' },
    { role: 'assistant', content: 'ok' },
  ]
  const result = await distillTranscript({
    turns, runtime: 'claude-code', cwd: '/r',
    callLLM: async () => JSON.stringify({ candidates: [{ title: '[category:x] t', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] }),
  })
  expect(result.filteredTurns).toEqual(filterTranscriptForDistill(turns))
  // 过滤版里文件类 tool 结果被压成占位，不再含原文
  expect(result.filteredTurns[1]!.content).toContain('[file: /a.ts')
  expect(result.filteredTurns[1]!.content).not.toContain('X'.repeat(100))
})

test('distillTranscript failure degrades to empty filteredTurns', async () => {
  const result = await distillTranscript({
    turns: [{ role: 'user', content: 'hi' }],
    runtime: 'claude-code', cwd: '/r',
    callLLM: async () => { throw new Error('api down') },
  })
  expect(result.candidates).toEqual([])
  expect(result.filteredTurns).toEqual([])
})

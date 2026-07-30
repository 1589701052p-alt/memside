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
    cwd: '/repo', existingSlugs: [],
    callLLM: async () => JSON.stringify(fakeResponse),
  })
  expect(result.candidates.length).toBe(1)
  expect(result.candidates[0]!.title).toContain('[category:')
  expect(result.candidates[0]!.scopeType).toBe('project')
})

test('distillTranscript returns [] on malformed response', async () => {
  const result = await distillTranscript({
    turns: [{ role: 'user', content: 'hi' }],
    runtime: 'claude-code', cwd: '/repo', existingSlugs: [],
    callLLM: async () => 'not json',
  })
  expect(result.candidates).toEqual([])
})

test('distillTranscript never throws (swallows API errors)', async () => {
  const result = await distillTranscript({
    turns: [{ role: 'user', content: 'hi' }],
    runtime: 'claude-code', cwd: '/repo', existingSlugs: [],
    callLLM: async () => { throw new Error('api down') },
  })
  expect(result.candidates).toEqual([])
})

test('distillTranscript parses fence-wrapped JSON (regression)', async () => {
  const result = await distillTranscript({
    turns: [{ role: 'user', content: 'we only refund within 14 days' }],
    runtime: 'claude-code',
    cwd: '/repo', existingSlugs: [],
    callLLM: async () => '```json\n{"candidates":[{"title":"[category:invariant] refunds within 14 days","bodyMd":"14d","scope":"project","runtime":null,"distillAction":"new"}]}\n```',
  })
  expect(result.candidates.length).toBe(1)
  expect(result.candidates[0]!.title).toContain('[category:')
})

test('distillTranscript retries when candidate lacks [category: prefix', async () => {
  let calls = 0
  const result = await distillTranscript({
    turns: [{ role: 'user', content: 'x' }],
    runtime: 'claude-code', cwd: '/repo', existingSlugs: [],
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
    runtime: 'claude-code', cwd: '/repo', existingSlugs: [],
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
    runtime: 'claude-code', cwd: '/r', existingSlugs: [],
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
    runtime: 'claude-code', cwd: '/r', existingSlugs: [],
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
    runtime: 'claude-code', cwd: '/repo', existingSlugs: [],
    callLLM: async () => JSON.stringify({ candidates: [{ title: '[category:invariant] x', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] }),
  })
  expect(result.candidates.length).toBe(1)
  expect(result.candidates[0]!.ruleObject).toBe('codebase')
})

test('distillTranscript parses explicit ruleObject=domain', async () => {
  const result = await distillTranscript({
    turns: [{ role: 'user', content: 'x' }],
    runtime: 'claude-code', cwd: '/repo', existingSlugs: [],
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
    runtime: 'claude-code', cwd: '/repo', existingSlugs: [],
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

test('DISTILLER_SYSTEM_PROMPT has [stated] origin discipline with放宽 + REJECT + hard约束', () => {
  // 第七轮（本 spec）：origin discipline 重平衡。第3/6条放宽（agent 说过且被用户采纳
  // 的设计 rationale 可记）；第1/2/4/5条维持 REJECT；加"必须 transcript 有出处"硬约束
  // 防脑补。源码层文本断言锁 prompt 契约（LLM 遵循度由 dogfood 验证，非单测范围）。
  expect(DISTILLER_SYSTEM_PROMPT).toContain('Origin discipline')
  // 维持 REJECT 的四类关键词仍在
  expect(DISTILLER_SYSTEM_PROMPT).toContain('推断')        // 第1条 脑补闸门
  expect(DISTILLER_SYSTEM_PROMPT).toContain('前瞻')        // 第2条
  expect(DISTILLER_SYSTEM_PROMPT).toContain('研究输出')    // 第3条 研究输出仍 REJECT
  expect(DISTILLER_SYSTEM_PROMPT).toContain('丰富化')      // 第4条
  expect(DISTILLER_SYSTEM_PROMPT).toContain('道听途说')    // 第5条
  // 放宽：agent 给出且被用户采纳的设计 rationale 可记
  expect(DISTILLER_SYSTEM_PROMPT).toContain('被用户采纳')
  expect(DISTILLER_SYSTEM_PROMPT).toContain('rationale')
  // 硬约束：必须 transcript 有出处（防脑补）
  expect(DISTILLER_SYSTEM_PROMPT).toContain('出处')
})

test('agent rationale in transcript reaches distiller prompt unfiltered (layer 2+3 signal survival)', async () => {
  // 正向信号存活：agent 在 transcript 里说的设计 rationale（长段 assistant 文本）
  // 必须能进 distiller 的 user prompt，这样第三层放开的 origin discipline 才有素材可提取。
  // 锁住"过滤不丢 rationale 文本"+"渲染把它拼进 prompt"。
  const rationale = '选 bun 脚本而非 concurrently，因为跨平台、契合 Bun 栈、生产模式只占一个进程一个端口'
  let captured = ''
  await distillTranscript({
    turns: [
      { role: 'assistant', content: `方案 A 推荐：${rationale}` },
      { role: 'user', content: '就 A 吧，两个模式都要' },
    ],
    runtime: 'claude-code', cwd: '/r', existingSlugs: [],
    callLLM: async (_sys, user) => { captured = user; return JSON.stringify({ candidates: [] }) },
  })
  expect(captured).toContain(rationale)
  expect(captured).toContain('就 A 吧')
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
    turns, runtime: 'claude-code', cwd: '/r', existingSlugs: [],
    callLLM: async () => JSON.stringify({ candidates: [{ title: '[category:x] t', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] }),
  })
  expect(result.filteredTurns).toEqual(filterTranscriptForDistill(turns))
  // 过滤版里文件类 tool 结果被压成占位，不再含原文
  expect(result.filteredTurns[1]!.content).toContain('[file: /a.ts')
  expect(result.filteredTurns[1]!.content).not.toContain('X'.repeat(100))
})

test('distillTranscript failure preserves filteredTurns (source input not cleared on llm_error)', async () => {
  // 修复回归（spec 2026-07-29-distill-error-capture §source input 清空修复）：
  // 历史 bug 在 callThrew 时用 `filteredTurns: callThrew ? [] : filtered` 清空，
  // 导致 llm_error job 的 source input 丢失（turnCount:0）。修复后 filteredTurns 恒为
  // 过滤快照（与调用成败无关）。此测试曾断言 filteredTurns=[]，现已更新为期望真实 filtered。
  const { filterTranscriptForDistill } = await import('@/memory/pure')
  const turns: TranscriptTurn[] = [{ role: 'user', content: 'hi' }]
  const result = await distillTranscript({
    turns, runtime: 'claude-code', cwd: '/r', existingSlugs: [],
    callLLM: async () => { throw new Error('api down') },
  })
  expect(result.candidates).toEqual([])
  expect(result.filteredTurns).toEqual(filterTranscriptForDistill(turns))
})

// subject-keyed 聚合（spec §4.3）：subjectSlug 解析 + existingSlugs 清单进 prompt。

test('distillTranscript includes existingSlugs in user prompt', async () => {
  let captured = ''
  await distillTranscript({
    turns: [{ role: 'user', content: 'x' }],
    runtime: 'claude-code', cwd: '/repo',
    existingSlugs: ['refund-policy', 'hook-install'],
    callLLM: async (_sys, user) => { captured = user; return JSON.stringify({ candidates: [] }) },
  })
  expect(captured).toContain('refund-policy')
  expect(captured).toContain('hook-install')
})

test('distillTranscript parses legal subjectSlug', async () => {
  const result = await distillTranscript({
    turns: [{ role: 'user', content: 'x' }],
    runtime: 'claude-code', cwd: '/repo', existingSlugs: [],
    callLLM: async () => JSON.stringify({ candidates: [{ title: '[category:invariant] x', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new', ruleObject: 'domain', subjectSlug: 'refund-policy' }] }),
  })
  expect(result.candidates[0]!.subjectSlug).toBe('refund-policy')
})

test('distillTranscript degrades illegal subjectSlug to null WITHOUT retry', async () => {
  let calls = 0
  const result = await distillTranscript({
    turns: [{ role: 'user', content: 'x' }],
    runtime: 'claude-code', cwd: '/repo', existingSlugs: [],
    callLLM: async () => { calls++; return JSON.stringify({ candidates: [{ title: '[category:invariant] x', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new', subjectSlug: 'refund policy' }] }) },
  })
  expect(calls).toBe(1) // 不重试（spec D6）
  expect(result.candidates[0]!.subjectSlug).toBeNull()
})

test('distillTranscript defaults missing subjectSlug to null', async () => {
  const result = await distillTranscript({
    turns: [{ role: 'user', content: 'x' }],
    runtime: 'claude-code', cwd: '/repo', existingSlugs: [],
    callLLM: async () => JSON.stringify({ candidates: [{ title: '[category:invariant] x', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] }),
  })
  expect(result.candidates[0]!.subjectSlug).toBeNull()
})

test('DISTILLER_SYSTEM_PROMPT documents subjectSlug rules + reuse instruction', () => {
  expect(DISTILLER_SYSTEM_PROMPT).toContain('subjectSlug')
  expect(DISTILLER_SYSTEM_PROMPT).toContain('kebab-case')
})

test('distillTranscript returns rawOutput/rawCount/callThrew on produced', async () => {
  const turns = [{ role: 'user', content: '记一下' }, { role: 'assistant', content: '好' }] as any
  const r = await distillTranscript({
    turns, runtime: 'claude-code', cwd: '/repo', existingSlugs: [],
    callLLM: async () => JSON.stringify({ candidates: [{ title: '[category:convention] x', bodyMd: 'b', scope: 'project', runtime: 'claude-code', distillAction: 'new' }] }),
  })
  expect(r.candidates.length).toBe(1)
  expect(r.rawCount).toBe(1)
  expect(r.callThrew).toBe(false)
  expect((r.rawOutput as any)?.candidates?.length).toBe(1)
})

test('distillTranscript returns callThrew=true + null rawOutput when LLM throws', async () => {
  const turns = [{ role: 'user', content: 'hi' }] as any
  const r = await distillTranscript({
    turns, runtime: 'claude-code', cwd: '/repo', existingSlugs: [],
    callLLM: async () => { throw new Error('api down') },
  })
  expect(r.candidates).toEqual([])
  expect(r.callThrew).toBe(true)
  expect(r.rawOutput).toBeNull()
  expect(r.rawCount).toBe(0)
})

test('distillTranscript resets callThrew after a failed attempt then succeeds (retry-success not misclassified as llm_error)', async () => {
  // 回归（review fix-wave Finding 1）：callThrew 曾是 sticky 的--attempt 0 抛错置 true
  // 后永不复位，导致 attempt 1 成功产出候选时 scheduler 仍判 outcome='llm_error'
  // （spec §4 produced = accepted_count > 0 regardless of transient errors）。
  // callWithRetry 默认 maxRetries=2 = 3 次尝试，throw-once-then-succeed 在预算内。
  // 此测试在 distiller 修复前 FAIL（callThrew===true），修复后 PASS（callThrew===false）。
  let calls = 0
  const turns = [{ role: 'user', content: '记一下' }] as any
  const r = await distillTranscript({
    turns, runtime: 'claude-code', cwd: '/repo', existingSlugs: [],
    callLLM: async () => {
      calls++
      if (calls === 1) throw new Error('transient api down')
      return JSON.stringify({ candidates: [{ title: '[category:convention] x', bodyMd: 'b', scope: 'project', runtime: 'claude-code', distillAction: 'new' }] })
    },
  })
  expect(calls).toBe(2)              // 第一次抛错被重试，第二次成功
  expect(r.callThrew).toBe(false)   // 重试成功后 callThrew 必须复位为 false
  expect(r.candidates.length).toBeGreaterThan(0)
})

test('distillTranscript returns empty_output shape when LLM returns 0 candidates', async () => {
  const turns = [{ role: 'user', content: 'hi' }] as any
  const r = await distillTranscript({
    turns, runtime: 'claude-code', cwd: '/repo', existingSlugs: [],
    callLLM: async () => JSON.stringify({ candidates: [] }),
  })
  expect(r.candidates).toEqual([])
  expect(r.callThrew).toBe(false)
  expect(r.rawCount).toBe(0)
  expect((r.rawOutput as any)?.candidates).toEqual([])
})

test('distillTranscript preserves format-invalid candidates in rawOutput (rawCount > accepted)', async () => {
  const turns = [{ role: 'user', content: 'hi' }] as any
  // 始终返回 1 好 + 1 坏（无 [category: 前缀）-> shouldRetry 重试耗尽 -> 返回 lastParsed
  const r = await distillTranscript({
    turns, runtime: 'claude-code', cwd: '/repo', existingSlugs: [],
    callLLM: async () => JSON.stringify({ candidates: [
      { title: '[category:convention] good', bodyMd: 'b', scope: 'project', runtime: 'claude-code', distillAction: 'new' },
      { title: 'no-prefix bad', bodyMd: 'b' },
    ] }),
  })
  expect(r.candidates.length).toBe(1)            // 坏的被格式校验丢
  expect(r.rawCount).toBe(2)                      // 原始两条都计
  expect((r.rawOutput as any)?.candidates?.length).toBe(2)  // rawOutput 保留被丢的
  expect(r.callThrew).toBe(false)
})

test('distillTranscript captures last LLM error message when all attempts throw', async () => {
  // 3 次 attempt 都抛错：errorMessage 应为最后一次的 message（spec §透传路径）。
  let calls = 0
  const result = await distillTranscript({
    turns: [{ role: 'user', content: 'x' }],
    runtime: 'claude-code', cwd: '/repo', existingSlugs: [],
    callLLM: async () => {
      calls++
      throw new Error(calls <= 2 ? 'timeout' : '500 Internal Server Error')
    },
  })
  expect(result.candidates).toEqual([])
  expect(result.callThrew).toBe(true)
  expect(result.errorMessage).toBe('500 Internal Server Error')
  expect(calls).toBe(3)  // callWithRetry maxRetries=2 -> 3 attempts
})

test('distillTranscript errorMessage is null on retry-success', async () => {
  // attempt 0 抛错（记 lastErrorMessage）、attempt 1 成功产出候选：
  // callThrew=false（最后 attempt 重置并成功）、有候选 -> errorMessage=null（spec §透传路径）。
  let calls = 0
  const result = await distillTranscript({
    turns: [{ role: 'user', content: 'we refund within 14 days' }],
    runtime: 'claude-code', cwd: '/repo', existingSlugs: [],
    callLLM: async () => {
      calls++
      if (calls === 1) throw new Error('timeout')
      return JSON.stringify({ candidates: [{ title: '[category:invariant] refunds 14d', bodyMd: '14d', scope: 'project', runtime: null, distillAction: 'new' }] })
    },
  })
  expect(result.candidates.length).toBe(1)
  expect(result.errorMessage).toBeNull()
})

test('distillTranscript errorMessage is null on parse failure (call did not throw)', async () => {
  // callLLM 成功返回非 JSON：callThrew=false、无候选 -> empty_output，errorMessage=null。
  const result = await distillTranscript({
    turns: [{ role: 'user', content: 'x' }],
    runtime: 'claude-code', cwd: '/repo', existingSlugs: [],
    callLLM: async () => 'not json',
  })
  expect(result.candidates).toEqual([])
  expect(result.callThrew).toBe(false)
  expect(result.errorMessage).toBeNull()
})

test('distillTranscript preserves filteredTurns when callThrew (regression: source input must not be cleared)', async () => {
  // 回归防护：callThrew 时 filteredTurns 必须保留（spec §source input 修复）。
  // 历史 bug：distiller.ts 曾用 `filteredTurns: callThrew ? [] : filtered` 清空，
  // 导致 llm_error job 的 source input 丢失（turnCount:0）。此测试锁住修复。
  const result = await distillTranscript({
    turns: [{ role: 'user', content: 'meaningful turn that must be preserved' }],
    runtime: 'claude-code', cwd: '/repo', existingSlugs: [],
    callLLM: async () => { throw new Error('api down') },
  })
  expect(result.callThrew).toBe(true)
  expect(result.filteredTurns.length).toBeGreaterThan(0)
})

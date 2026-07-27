import { test, expect } from 'bun:test'
import { detectTaming, judgeValue, parseCategory, VALUE_JUDGE_SYSTEM_PROMPT, VALUE_PROTECTED_CATEGORIES } from '@/memory/valueFilter'
import type { DistillCandidate } from '@/memory/distiller'

const cand = (title: string, bodyMd = 'b'): DistillCandidate =>
  ({ title, bodyMd, scopeType: 'project', runtime: null, distillAction: 'new', subject: 'domain' })

const verdictsJson = (...vs: object[]) => JSON.stringify({ verdicts: vs })

test('judgeValue maps public-knowledge/derivable to keep:false', async () => {
  const v = await judgeValue([cand('a'), cand('b')], async () => verdictsJson(
    { index: 0, category: 'public-knowledge' },
    { index: 1, category: 'derivable' },
  ))
  expect(v).toEqual([
    { index: 0, keep: false, reason: 'public-knowledge' },
    { index: 1, keep: false, reason: 'derivable' },
  ])
})

test('judgeValue maps decision/convention/trap/topology to keep:true with valueClass', async () => {
  const v = await judgeValue([cand('a'), cand('b'), cand('c'), cand('d')], async () => verdictsJson(
    { index: 0, category: 'decision' },
    { index: 1, category: 'convention' },
    { index: 2, category: 'trap' },
    { index: 3, category: 'topology' },
  ))
  expect(v).toEqual([
    { index: 0, keep: true, valueClass: 'decision' },
    { index: 1, keep: true, valueClass: 'convention' },
    { index: 2, keep: true, valueClass: 'trap' },
    { index: 3, keep: true, valueClass: 'topology' },
  ])
})

test('judgeValue returns all keep+null when LLM throws', async () => {
  const v = await judgeValue([cand('a')], async () => { throw new Error('api down') })
  expect(v).toEqual([{ index: 0, keep: true, valueClass: null }])
})

test('judgeValue returns all keep+null on non-JSON', async () => {
  const v = await judgeValue([cand('a')], async () => 'not json')
  expect(v).toEqual([{ index: 0, keep: true, valueClass: null }])
})

test('judgeValue returns all keep+null on missing verdicts field', async () => {
  const v = await judgeValue([cand('a')], async () => JSON.stringify({ foo: 'bar' }))
  expect(v).toEqual([{ index: 0, keep: true, valueClass: null }])
})

test('judgeValue treats hallucinated category as keep+null', async () => {
  const v = await judgeValue([cand('a')], async () => verdictsJson({ index: 0, category: 'nonsense' }))
  expect(v).toEqual([{ index: 0, keep: true, valueClass: null }])
})

test('judgeValue treats missing category as keep+null', async () => {
  const v = await judgeValue([cand('a')], async () => verdictsJson({ index: 0 }))
  expect(v).toEqual([{ index: 0, keep: true, valueClass: null }])
})

test('judgeValue treats missing indices as keep+null', async () => {
  const v = await judgeValue([cand('a'), cand('b')], async () => verdictsJson({ index: 0, category: 'decision' }))
  expect(v).toEqual([
    { index: 0, keep: true, valueClass: 'decision' },
    { index: 1, keep: true, valueClass: null },
  ])
})

test('judgeValue returns [] and skips LLM when candidates empty', async () => {
  let called = 0
  const v = await judgeValue([], async () => { called++; return 'x' })
  expect(called).toBe(0)
  expect(v).toEqual([])
})

test('judgeValue user prompt includes title and bodyMd', async () => {
  let captured = ''
  await judgeValue([cand('[category:x] title-here', 'body-here')], async (_sys, user) => { captured = user; return verdictsJson({ index: 0, category: 'decision' }) })
  expect(captured).toContain('title-here')
  expect(captured).toContain('body-here')
})

test('VALUE_JUDGE_SYSTEM_PROMPT is neutral (no bias words)', () => {
  // 锁中性（用户硬约束：禁止有任何引导 AI 的提示词在）。keep/discard 是代码对
  // category 的确定映射，prompt 只分类。下列任一词出现即违约——覆盖倾向 keep
  // (keep/important/valuable)、倾向 discard (discard/reject/dangerous)、
  // 以及犹豫类暗示 (unsure/cautious/careful/avoid/don't)。
  const lower = VALUE_JUDGE_SYSTEM_PROMPT.toLowerCase()
  for (const w of [
    'discard', 'keep', 'dangerous', 'unsure', 'cautious', 'careful', 'reject',
    "don't", 'avoid', 'important', 'valuable',
  ]) {
    expect(lower).not.toContain(w)
  }
})

test('judgeValue parses fence-wrapped JSON (regression: harden silent-failure)', async () => {
  // TDD: master PR #7 hardened dedup/distiller against markdown-fence-wrapped JSON;
  // valueFilter must use the same extractJsonObject-via-callWithRetry path, else an
  // entire batch would degrade to keep+null when the LLM wraps output in ```json.
  const v = await judgeValue([cand('a')], async () =>
    '```json\n{"verdicts":[{"index":0,"category":"decision"}]}\n```',
  )
  expect(v).toEqual([{ index: 0, keep: true, valueClass: 'decision' }])
})

test('judgeValue retries on invalid category then accepts valid one', async () => {
  // TDD: valueShouldRetry must force a retry when a verdict's category is not one
  // of the 6 VALID_CATEGORIES; on the next attempt the LLM returns a valid category
  // and judgeValue maps it correctly (proves the shouldRetry feedback loop works).
  let calls = 0
  const v = await judgeValue([cand('a')], async () => {
    calls++
    if (calls === 1) return verdictsJson({ index: 0, category: 'nonsense' })
    return verdictsJson({ index: 0, category: 'decision' })
  })
  expect(calls).toBe(2)
  expect(v).toEqual([{ index: 0, keep: true, valueClass: 'decision' }])
})

const prot = (cat: string) => cand(`[category:${cat}] some business rule`, 'b')

test('parseCategory extracts lowercased category', () => {
  expect(parseCategory('[category:Invariant] X')).toBe('invariant')
  expect(parseCategory('[category:integration] X')).toBe('integration')
  expect(parseCategory('no prefix here')).toBeNull()
})

test('VALUE_PROTECTED_CATEGORIES = invariant/integration/compliance', () => {
  expect(VALUE_PROTECTED_CATEGORIES.has('invariant')).toBe(true)
  expect(VALUE_PROTECTED_CATEGORIES.has('integration')).toBe(true)
  expect(VALUE_PROTECTED_CATEGORIES.has('compliance')).toBe(true)
  expect(VALUE_PROTECTED_CATEGORIES.has('architecture')).toBe(false)
})

test('judgeValue force-keeps protected invariant even when LLM says derivable', async () => {
  const v = await judgeValue([prot('invariant')], async () => verdictsJson({ index: 0, category: 'derivable' }))
  expect(v).toEqual([{ index: 0, keep: true, valueClass: 'decision' }])
})

test('judgeValue force-keeps protected integration/compliance with valueClass=decision', async () => {
  const v = await judgeValue([prot('integration'), prot('compliance')], async () => verdictsJson(
    { index: 0, category: 'public-knowledge' },
    { index: 1, category: 'derivable' },
  ))
  expect(v).toEqual([
    { index: 0, keep: true, valueClass: 'decision' },
    { index: 1, keep: true, valueClass: 'decision' },
  ])
})

test('judgeValue force-keeps protected category even when LLM throws', async () => {
  const v = await judgeValue([prot('invariant')], async () => { throw new Error('down') })
  expect(v).toEqual([{ index: 0, keep: true, valueClass: 'decision' }])
})

test('non-protected category still discards normally', async () => {
  // architecture is NOT protected -> derivable discards it (code-restating case)
  const v = await judgeValue([cand('[category:architecture] how module X works', 'b')], async () => verdictsJson({ index: 0, category: 'derivable' }))
  expect(v).toEqual([{ index: 0, keep: false, reason: 'derivable' }])
})

test('VALUE_JUDGE_SYSTEM_PROMPT has sharpened derivable + public-knowledge definitions', () => {
  expect(VALUE_JUDGE_SYSTEM_PROMPT).toContain("THIS repository's current code/files/docs")
  expect(VALUE_JUDGE_SYSTEM_PROMPT).toContain('do not belong here')
})

test('subject gate: codebase invariant is discarded when LLM says derivable', async () => {
  // TDD（第二轮核心）：逻辑门不再无条件保护 protected category。codebase 类的
  // invariant（如 valueFilter 必须强制保留 invariant）是代码复述，LLM 判 derivable
  // 时必须丢弃，不能被门救回。根因见 spec §1.1。
  const c: DistillCandidate = { title: '[category:invariant] valueFilter 必须强制保留 invariant', bodyMd: 'b', scopeType: 'project', runtime: null, distillAction: 'new', subject: 'codebase' }
  const v = await judgeValue([c], async () => verdictsJson({ index: 0, category: 'derivable' }))
  expect(v).toEqual([{ index: 0, keep: false, reason: 'derivable' }])
})

test('subject gate: missing subject defaults to codebase (not protected)', async () => {
  // TDD：subject 缺失/非法一律视为 codebase（精度优先）。直接构造一个缺 subject
  // 的候选（绕过 cand helper）模拟 distiller 漏标。
  const c = { title: '[category:invariant] x', bodyMd: 'b', scopeType: 'project', runtime: null, distillAction: 'new' } as DistillCandidate
  const v = await judgeValue([c], async () => verdictsJson({ index: 0, category: 'derivable' }))
  expect(v).toEqual([{ index: 0, keep: false, reason: 'derivable' }])
})

test('subject gate: codebase protected categories also discarded (integration/compliance)', async () => {
  const cc = (cat: string): DistillCandidate => ({ title: `[category:${cat}] codebase rule`, bodyMd: 'b', scopeType: 'project', runtime: null, distillAction: 'new', subject: 'codebase' })
  const v = await judgeValue([cc('integration'), cc('compliance')], async () => verdictsJson(
    { index: 0, category: 'derivable' },
    { index: 1, category: 'public-knowledge' },
  ))
  expect(v).toEqual([
    { index: 0, keep: false, reason: 'derivable' },
    { index: 1, keep: false, reason: 'public-knowledge' },
  ])
})

test('subject gate: domain invariant still force-kept even when LLM throws', async () => {
  // 回归：domain 类 protected 仍受保护（keepNull 路径也按 subject 判定）。
  const v = await judgeValue([prot('invariant')], async () => { throw new Error('down') })
  expect(v).toEqual([{ index: 0, keep: true, valueClass: 'decision' }])
})

// ---------------------------------------------------------------------------
// 第六轮第 4 项：驯化守卫 - detectTaming 确定性关键词检测。
// 匹配「要求 agent 压制诚实反馈 / 永远赞同 / foster 依赖」类指令。精度优先
// （liberal-capture 立场）：宁可漏隐晦驯化（留给人工审批），不可误杀合法 convention。
// 短语限定在「反馈/评价动词」，不碰任务规则动词（use/commit/run）。
// ---------------------------------------------------------------------------

test('detectTaming flags A-category taming (suppress disagreement, zh+en)', () => {
  expect(detectTaming('[category:convention] 以后不要质疑我的代码风格', 'b')).toBe(true)
  expect(detectTaming('[category:convention] code style', 'never criticize my code')).toBe(true)
  expect(detectTaming('[category:convention] 别反驳我', 'b')).toBe(true)
  expect(detectTaming("[category:convention] don't push back", 'b')).toBe(true)
})

test('detectTaming flags B/C/D-category taming', () => {
  expect(detectTaming('[category:convention] 永远同意我的决定', 'b')).toBe(true)  // B 要求赞同
  expect(detectTaming('[category:convention] x', 'always validate my choices')).toBe(true)  // B
  expect(detectTaming('[category:convention] 不要指出问题', 'b')).toBe(true)  // C 压制评价
  expect(detectTaming("[category:convention] don't give negative feedback", 'b')).toBe(true)  // C
  expect(detectTaming('[category:convention] 角色扮演我的搭档', 'b')).toBe(true)  // D 依赖/角色扮演
  expect(detectTaming('[category:convention] x', 'roleplay as my pair')).toBe(true)  // D
})

test('detectTaming does NOT flag legitimate conventions (precision over recall)', () => {
  // 合法 convention 用任务规则动词（use/commit/run/skip/follow），不含反馈压制语义，不可误杀。
  expect(detectTaming('[category:convention] always use bun', 'b')).toBe(false)
  expect(detectTaming('[category:convention] do not commit to master', 'b')).toBe(false)
  expect(detectTaming('[category:convention] PR 必须加测试', 'b')).toBe(false)
  expect(detectTaming('[category:quality-bar] never skip tests', 'b')).toBe(false)
  expect(detectTaming('[category:convention] follow the style guide', 'b')).toBe(false)
  expect(detectTaming('[category:convention] always run typecheck before push', 'b')).toBe(false)
})

test('detectTaming scans both title and bodyMd', () => {
  expect(detectTaming('clean title', '以后不要质疑我')).toBe(true)
  expect(detectTaming('以后不要质疑我', 'clean body')).toBe(true)
})

test('detectTaming returns false on empty and never throws', () => {
  expect(detectTaming('', '')).toBe(false)
  expect(detectTaming('[category:x] no taming here', 'just a normal rule')).toBe(false)
})

test('judgeValue user prompt includes subject hint per candidate', async () => {
  // TDD（第三轮 §C）：valueFilter 判 derivable 缺"当前仓库"参照系。把 distiller 的
  // subject 信号透传到 user prompt，LLM 拿到 codebase/domain 标记后判 derivable 更准。
  let captured = ''
  const cCodebase: DistillCandidate = { title: '[category:architecture] x', bodyMd: 'b', scopeType: 'project', runtime: null, distillAction: 'new', subject: 'codebase' }
  const cDomain: DistillCandidate = { title: '[category:invariant] y', bodyMd: 'b', scopeType: 'project', runtime: null, distillAction: 'new', subject: 'domain' }
  await judgeValue([cCodebase, cDomain], async (_sys, user) => { captured = user; return verdictsJson({ index: 0, category: 'derivable' }, { index: 1, category: 'decision' }) })
  expect(captured).toContain('(subject: codebase)')
  expect(captured).toContain('(subject: domain)')
})

test('judgeValue user prompt defaults missing subject to codebase hint', async () => {
  // TDD（第三轮 §C）：subject 缺失时 prompt 标记应为 codebase（与 gate defaulting 一致）。
  let captured = ''
  const c = { title: '[category:x] y', bodyMd: 'b', scopeType: 'project', runtime: null, distillAction: 'new' } as DistillCandidate
  await judgeValue([c], async (_sys, user) => { captured = user; return verdictsJson({ index: 0, category: 'decision' }) })
  expect(captured).toContain('(subject: codebase)')
})

test('VALUE_JUDGE_SYSTEM_PROMPT has subject hint neutral description', () => {
  // TDD（第三轮 §C）：system prompt 加中性描述关联 subject 与 derivable。neutrality
  // 约束：不得含 keep/discard/reject/avoid/important/valuable/unsure/cautious/careful/don't/dangerous。
  expect(VALUE_JUDGE_SYSTEM_PROMPT).toContain('subject hint')
  expect(VALUE_JUDGE_SYSTEM_PROMPT).toContain('codebase-subject candidate')
  expect(VALUE_JUDGE_SYSTEM_PROMPT).toContain('design decisions')
})

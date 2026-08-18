import { test, expect } from 'bun:test'
import { detectTaming, judgeValue, VALUE_JUDGE_SYSTEM_PROMPT } from '@/memory/valueFilter'
import type { DistillCandidate } from '@/memory/distiller'

const cand = (title: string, origin: 'user-stated' | 'user-confirmed' | 'agent-observed' = 'agent-observed'): DistillCandidate =>
  ({ title, bodyMd: 'b', scopeType: 'project', runtime: null, distillAction: 'new',
     origin, evidence: origin === 'agent-observed' ? null : '原话出处', subjectSlug: null })

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

test('judgeValue maps user-rule/preference to keep:true with valueClass（扩编筐）', async () => {
  const v = await judgeValue([cand('a'), cand('b')], async () => verdictsJson(
    { index: 0, category: 'user-rule' },
    { index: 1, category: 'preference' },
  ))
  expect(v).toEqual([
    { index: 0, keep: true, valueClass: 'user-rule' },
    { index: 1, keep: true, valueClass: 'preference' },
  ])
})

test('judgeValue maps fleeting to keep:false（新丢弃理由）', async () => {
  const v = await judgeValue([cand('a')], async () => verdictsJson({ index: 0, category: 'fleeting' }))
  expect(v).toEqual([{ index: 0, keep: false, reason: 'fleeting' }])
})

test('judgeValue 代码硬兜底：user-stated 被判 derivable -> 改判 keep+decision（7-30 误杀回归锁）', async () => {
  // 回归锁（spec §R2）：2026-07-30 事故--用户确认的「凭证链优先级」等被 LLM 判
  // derivable 全数误杀。prompt 禁考 Q2 之外，代码层必须再兜一道。
  const v = await judgeValue([cand('[category:architecture] 凭证链优先级', 'user-confirmed')],
    async () => verdictsJson({ index: 0, category: 'derivable' }))
  expect(v).toEqual([{ index: 0, keep: true, valueClass: 'decision' }])
})

test('judgeValue：agent-observed 被判 derivable 正常丢弃（兜底不误伤）', async () => {
  const v = await judgeValue([cand('[category:data-semantics] 打码前6后4')],
    async () => verdictsJson({ index: 0, category: 'derivable' }))
  expect(v).toEqual([{ index: 0, keep: false, reason: 'derivable' }])
})

test('judgeValue fleeting 可丢弃 user-stated（Q3 是 AI 对用户话语的判断权）', async () => {
  const v = await judgeValue([cand('今天先到这吧', 'user-stated')],
    async () => verdictsJson({ index: 0, category: 'fleeting' }))
  expect(v).toEqual([{ index: 0, keep: false, reason: 'fleeting' }])
})

test('judgeValue LLM 失败：返回 failed 标识（不再 keepNull 全保留冒充成功）', async () => {
  // Task 6（2026-08-18 spec §缺陷2/§8.4）：旧行为是 keepNull 全保留（stated->decision，
  // observed->null），让"批量拒绝未评估"按钮误杀整批。新行为：失败返回 failed 标识
  // 让 scheduler 暂停。成功路径断言不变。
  const r = await judgeValue(
    [cand('a', 'user-stated'), cand('b', 'user-confirmed'), cand('c')],
    async () => { throw new Error('api down') },
  )
  expect(Array.isArray(r)).toBe(false)
  expect((r as { failed: true; reasons: string[] }).failed).toBe(true)
})

test('judgeValue returns failed 标识 on non-JSON', async () => {
  // Task 6：非 JSON 走 runLlmSession 重试耗尽 -> failed 标识（旧 keep+null 已废）。
  const r = await judgeValue([cand('a')], async () => 'not json')
  expect(Array.isArray(r)).toBe(false)
  expect((r as { failed: true }).failed).toBe(true)
})

test('judgeValue returns failed 标识 on missing verdicts field', async () => {
  // Task 6：verdicts 缺失 -> failed 标识（旧 keep+null 已废）。
  const r = await judgeValue([cand('a')], async () => JSON.stringify({ foo: 'bar' }))
  expect(Array.isArray(r)).toBe(false)
  expect((r as { failed: true }).failed).toBe(true)
})

test('judgeValue 持续幻觉类别 -> failed 标识（旧 keep+null 已废）', async () => {
  // Task 6：LLM 持续返回非法 category，runLlmSession 3 轮重试耗尽 -> failed 标识。
  // 旧 keep+null 全保留会冒充成功；新行为让 scheduler 暂停。
  const r = await judgeValue([cand('a')], async () => verdictsJson({ index: 0, category: 'nonsense' }))
  expect(Array.isArray(r)).toBe(false)
  expect((r as { failed: true }).failed).toBe(true)
})

test('judgeValue 持续幻觉类别（user-stated）-> failed 标识（旧 keep+decision 已废）', async () => {
  // Task 6：幻觉类别免疫兜底（stated->decision）已废——持续幻觉即失败，返回 failed 标识。
  const r = await judgeValue([cand('a', 'user-stated')], async () => verdictsJson({ index: 0, category: 'nonsense' }))
  expect(Array.isArray(r)).toBe(false)
  expect((r as { failed: true }).failed).toBe(true)
})

test('judgeValue 持续缺 category -> failed 标识（旧 keep+null 已废）', async () => {
  // Task 6：持续缺 category，runLlmSession 重试耗尽 -> failed 标识。
  const r = await judgeValue([cand('a')], async () => verdictsJson({ index: 0 }))
  expect(Array.isArray(r)).toBe(false)
  expect((r as { failed: true }).failed).toBe(true)
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
  const c: DistillCandidate = { title: '[category:x] title-here', bodyMd: 'body-here', scopeType: 'project', runtime: null, distillAction: 'new', origin: 'agent-observed', evidence: null, subjectSlug: null }
  await judgeValue([c], async (_sys, user) => { captured = user; return verdictsJson({ index: 0, category: 'decision' }) })
  expect(captured).toContain('title-here')
  expect(captured).toContain('body-here')
})

test('judgeValue user prompt carries origin tag per candidate', async () => {
  let captured = ''
  await judgeValue([cand('[category:x] t', 'user-stated')],
    async (_sys, user) => { captured = user; return verdictsJson({ index: 0, category: 'user-rule' }) })
  expect(captured).toContain('origin: user-stated')
})

test('VALUE_JUDGE_SYSTEM_PROMPT is neutral (no bias words)', () => {
  // 锁中性（用户硬约束：禁止有任何引导 AI 的提示词在）。retain/drop 是代码对
  // category 的确定映射，prompt 只分类。下列任一词出现即违约--覆盖倾向 retain
  // (keep/important/valuable)、倾向 drop (discard/reject/dangerous)、
  // 以及犹豫类暗示 (unsure/cautious/careful/avoid/don't)。
  const lower = VALUE_JUDGE_SYSTEM_PROMPT.toLowerCase()
  for (const w of [
    'discard', 'keep', 'dangerous', 'unsure', 'cautious', 'careful', 'reject',
    "don't", 'avoid', 'important', 'valuable',
  ]) {
    expect(lower).not.toContain(w)
  }
})

test('VALUE_JUDGE_SYSTEM_PROMPT 含三考题 + Q2 禁用规则 + 9 类定义，且无 ruleObject', () => {
  const p = VALUE_JUDGE_SYSTEM_PROMPT
  for (const s of ['user-rule', 'preference', 'fleeting', 'derivable', 'public-knowledge',
    'user-stated', 'user-confirmed', 'agent-observed']) expect(p).toContain(s)
  expect(p).not.toContain('ruleObject')
  // 中性硬约束（沿用既有 banned 词表）
  const lower = p.toLowerCase()
  for (const w of ['discard', 'keep', 'dangerous', 'unsure', 'cautious', 'careful', 'reject',
    "don't", 'avoid', 'important', 'valuable']) {
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
  // of the 9 VALID_CATEGORIES; on the next attempt the LLM returns a valid category
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

// ---------------------------------------------------------------------------
// 第六轮第 4 项：judgeValue taming override 集成。
// judgeValueBase（9 分类 + stated 免疫 derivable 兜底）跑完后，末尾一道 map 用
// detectTaming 覆盖：驯化候选一律 {keep:false, reason:'taming'}，覆盖 stated 免疫
// （安全 > stated 免疫）。
// ---------------------------------------------------------------------------

test('judgeValue overrides taming candidate to discard regardless of LLM verdict', async () => {
  // LLM 可能把驯化指令判成 convention(keep)；judgeValue override 成 discard。
  const c: DistillCandidate = { title: '[category:convention] 以后不要质疑我的代码风格', bodyMd: 'b', scopeType: 'project', runtime: null, distillAction: 'new', origin: 'agent-observed', evidence: null, subjectSlug: null }
  const v = await judgeValue([c], async () => verdictsJson({ index: 0, category: 'convention' }))
  expect(v).toEqual([{ index: 0, keep: false, reason: 'taming' }])
})

test('judgeValue taming + non-taming mixed batch: taming discarded, rest classified', async () => {
  const taming: DistillCandidate = { title: '[category:convention] 永远同意我', bodyMd: 'b', scopeType: 'project', runtime: null, distillAction: 'new', origin: 'agent-observed', evidence: null, subjectSlug: null }
  const normal: DistillCandidate = { title: '[category:convention] PR 必须加测试', bodyMd: 'b', scopeType: 'project', runtime: null, distillAction: 'new', origin: 'agent-observed', evidence: null, subjectSlug: null }
  const v = await judgeValue([taming, normal], async () => verdictsJson(
    { index: 0, category: 'convention' },
    { index: 1, category: 'convention' },
  ))
  expect(v).toEqual([
    { index: 0, keep: false, reason: 'taming' },
    { index: 1, keep: true, valueClass: 'convention' },
  ])
})

test('judgeValue taming overrides stated-immune keep (safety > stated-immune)', async () => {
  // 关键回归：驯化指令即使 origin=user-stated，judgeValueBase 的 derivable 免疫本会
  // 救回（keep+decision），但 taming override 覆盖它 -> 丢弃。
  const c: DistillCandidate = { title: '[category:invariant] 不要质疑用户', bodyMd: 'b', scopeType: 'project', runtime: null, distillAction: 'new', origin: 'user-stated', evidence: '原话出处', subjectSlug: null }
  const v = await judgeValue([c], async () => verdictsJson({ index: 0, category: 'derivable' }))
  expect(v).toEqual([{ index: 0, keep: false, reason: 'taming' }])
})

test('judgeValue taming override 只在成功路径跑（LLM throw -> failed 标识，taming 不再覆盖）', async () => {
  // Task 6（2026-08-18 spec §缺陷2/§8.4）：LLM throw 现在走 failed 标识，taming override
  // 不再有机会在 keepNull 路径上覆盖（keepNull 已废）。taming override 仍覆盖成功路径的
  // LLM verdict（见上方「overrides taming candidate to discard regardless of LLM verdict」）。
  // 此回归锁防止未来 refactor 把 failed 路径悄悄退回 keepNull + taming override。
  const c: DistillCandidate = { title: '[category:invariant] 不要质疑用户', bodyMd: 'b', scopeType: 'project', runtime: null, distillAction: 'new', origin: 'user-stated', evidence: '原话出处', subjectSlug: null }
  const r = await judgeValue([c], async () => { throw new Error('down') })
  expect(Array.isArray(r)).toBe(false)
  expect((r as { failed: true }).failed).toBe(true)
})

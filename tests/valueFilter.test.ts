import { test, expect } from 'bun:test'
import { judgeValue, VALUE_JUDGE_SYSTEM_PROMPT } from '@/memory/valueFilter'
import type { DistillCandidate } from '@/memory/distiller'

const cand = (title: string, bodyMd = 'b'): DistillCandidate =>
  ({ title, bodyMd, scopeType: 'project', runtime: null, distillAction: 'new' })

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

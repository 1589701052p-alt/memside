import { test, expect } from 'bun:test'
import { judgeDuplicates, DEDUP_SYSTEM_PROMPT, type ExistingMemoryForDedup } from '@/memory/dedup'
import type { DistillCandidate } from '@/memory/distiller'

const existing: ExistingMemoryForDedup[] = [
  { id: 'A', title: '[category:invariant] refund within 14 days', bodyMd: '14d refund window', scopeType: 'project', scopeId: '/r', status: 'approved' },
]
const newCand: DistillCandidate = {
  title: '[category:process] 退款必须在发货后14天内', bodyMd: '14天退款窗口',
  scopeType: 'project', runtime: null, distillAction: 'new', subject: 'domain',
}

test('judgeDuplicates marks duplicate with valid duplicateOfId', async () => {
  const v = await judgeDuplicates({
    newCandidates: [newCand], existing,
    callLLM: async () => JSON.stringify({ verdicts: [{ index: 0, isDuplicate: true, duplicateOfId: 'A' }] }),
  })
  expect(v).toEqual([{ index: 0, duplicate: true, duplicateOfId: 'A' }])
})

test('judgeDuplicates marks new when isDuplicate false', async () => {
  const v = await judgeDuplicates({
    newCandidates: [newCand], existing,
    callLLM: async () => JSON.stringify({ verdicts: [{ index: 0, isDuplicate: false }] }),
  })
  expect(v).toEqual([{ index: 0, duplicate: false }])
})

test('judgeDuplicates returns all new when LLM throws', async () => {
  const v = await judgeDuplicates({
    newCandidates: [newCand], existing,
    callLLM: async () => { throw new Error('api down') },
  })
  expect(v).toEqual([{ index: 0, duplicate: false }])
})

test('judgeDuplicates returns all new on non-JSON response', async () => {
  const v = await judgeDuplicates({
    newCandidates: [newCand], existing,
    callLLM: async () => 'not json',
  })
  expect(v).toEqual([{ index: 0, duplicate: false }])
})

test('judgeDuplicates returns all new on missing verdicts field', async () => {
  const v = await judgeDuplicates({
    newCandidates: [newCand], existing,
    callLLM: async () => JSON.stringify({ foo: 'bar' }),
  })
  expect(v).toEqual([{ index: 0, duplicate: false }])
})

test('judgeDuplicates treats hallucinated duplicateOfId as new', async () => {
  const v = await judgeDuplicates({
    newCandidates: [newCand], existing,
    callLLM: async () => JSON.stringify({ verdicts: [{ index: 0, isDuplicate: true, duplicateOfId: 'NONEXISTENT' }] }),
  })
  expect(v).toEqual([{ index: 0, duplicate: false }])
})

test('judgeDuplicates skips LLM when existing empty AND <=1 candidate', async () => {
  let called = 0
  const v = await judgeDuplicates({
    newCandidates: [newCand], existing: [],
    callLLM: async () => { called++; return 'x' },
  })
  expect(called).toBe(0)
  expect(v).toEqual([{ index: 0, duplicate: false }])
})

test('judgeDuplicates returns [] and skips LLM when newCandidates is empty', async () => {
  let called = 0
  const v = await judgeDuplicates({
    newCandidates: [], existing,
    callLLM: async () => { called++; return 'x' },
  })
  expect(called).toBe(0)
  expect(v).toEqual([])
})

test('judgeDuplicates treats missing indices as new', async () => {
  const two: DistillCandidate[] = [newCand, { ...newCand, title: '[category:x] second' }]
  const v = await judgeDuplicates({
    newCandidates: two, existing,
    callLLM: async () => JSON.stringify({ verdicts: [{ index: 0, isDuplicate: false }] }),
  })
  expect(v).toEqual([{ index: 0, duplicate: false }, { index: 1, duplicate: false }])
})

test('user prompt includes existing titles and ids', async () => {
  let captured = ''
  await judgeDuplicates({
    newCandidates: [newCand], existing,
    callLLM: async (_sys, user) => { captured = user; return JSON.stringify({ verdicts: [{ index: 0, isDuplicate: false }] }) },
  })
  expect(captured).toContain('refund within 14 days')
  expect(captured).toContain('id=A')
})

test('judgeDuplicates parses fence-wrapped verdicts (regression)', async () => {
  const v = await judgeDuplicates({
    newCandidates: [newCand], existing,
    callLLM: async () => '```json\n{"verdicts":[{"index":0,"isDuplicate":true,"duplicateOfId":"A"}]}\n```',
  })
  expect(v).toEqual([{ index: 0, duplicate: true, duplicateOfId: 'A' }])
})

test('judgeDuplicates retries when duplicateOfId is hallucinated', async () => {
  let calls = 0
  const v = await judgeDuplicates({
    newCandidates: [newCand], existing,
    callLLM: async () => {
      calls++
      if (calls === 1) return JSON.stringify({ verdicts: [{ index: 0, isDuplicate: true, duplicateOfId: 'NONEXISTENT' }] })
      return JSON.stringify({ verdicts: [{ index: 0, isDuplicate: true, duplicateOfId: 'A' }] })
    },
  })
  expect(calls).toBe(2)
  expect(v).toEqual([{ index: 0, duplicate: true, duplicateOfId: 'A' }])
})

test('judgeDuplicates returns all new when retry exhausted', async () => {
  const v = await judgeDuplicates({
    newCandidates: [newCand], existing,
    callLLM: async () => 'not json',
  })
  expect(v).toEqual([{ index: 0, duplicate: false }])
})

test('DEDUP_SYSTEM_PROMPT contains verdicts template', () => {
  expect(DEDUP_SYSTEM_PROMPT).toContain('"isDuplicate"')
  expect(DEDUP_SYSTEM_PROMPT).toContain('"duplicateOfId"')
  expect(DEDUP_SYSTEM_PROMPT).toContain('仅示范结构')
})

test('DEDUP_SYSTEM_PROMPT is neutral (no unsure tie-breaker)', () => {
  // 锁中性：删 "When unsure, emit isDuplicate:false." 后不得回退
  const lower = DEDUP_SYSTEM_PROMPT.toLowerCase()
  expect(lower).not.toContain('unsure')
})

test('judgeDuplicates merges same-batch sibling (new-j duplicateOf)', async () => {
  const a: DistillCandidate = { title: '[category:invariant] 退款14天', bodyMd: 'b', scopeType: 'project', runtime: null, distillAction: 'new', subject: 'domain' }
  const b: DistillCandidate = { title: '[category:invariant] 退款须在14天内', bodyMd: 'b', scopeType: 'project', runtime: null, distillAction: 'new', subject: 'domain' }
  const v = await judgeDuplicates({
    newCandidates: [a, b], existing: [],
    callLLM: async () => JSON.stringify({ verdicts: [{ index: 0, isDuplicate: false }, { index: 1, isDuplicate: true, duplicateOfId: 'new-0' }] }),
  })
  expect(v).toEqual([{ index: 0, duplicate: false }, { index: 1, duplicate: true, duplicateOfId: 'new-0' }])
})

test('judgeDuplicates calls LLM for sibling comparison when existing empty but >1 candidate', async () => {
  let called = 0
  await judgeDuplicates({
    newCandidates: [newCand, { ...newCand, title: '[category:x] sibling' }], existing: [],
    callLLM: async () => { called++; return JSON.stringify({ verdicts: [{ index: 0, isDuplicate: false }, { index: 1, isDuplicate: false }] }) },
  })
  expect(called).toBe(1)
})

test('judgeDuplicates rejects duplicateOf new-j with j>=i (retry)', async () => {
  let calls = 0
  const v = await judgeDuplicates({
    newCandidates: [newCand, { ...newCand, title: '[category:x] s' }], existing: [],
    callLLM: async () => {
      calls++
      if (calls === 1) return JSON.stringify({ verdicts: [{ index: 0, isDuplicate: true, duplicateOfId: 'new-1' }] }) // j>=i illegal
      return JSON.stringify({ verdicts: [{ index: 0, isDuplicate: false }, { index: 1, isDuplicate: false }] })
    },
  })
  expect(calls).toBe(2)
})

test('user prompt includes new-i ids for sibling comparison', async () => {
  let captured = ''
  await judgeDuplicates({
    newCandidates: [newCand, { ...newCand, title: '[category:x] s' }], existing: [],
    callLLM: async (_sys, user) => { captured = user; return JSON.stringify({ verdicts: [{ index: 0, isDuplicate: false }, { index: 1, isDuplicate: false }] }) },
  })
  expect(captured).toContain('id=new-0')
  expect(captured).toContain('id=new-1')
  expect(captured).toContain('(none)')
})

test('DEDUP_SYSTEM_PROMPT mentions sibling comparison + new-id duplicateOf', () => {
  expect(DEDUP_SYSTEM_PROMPT).toContain('siblings')
  expect(DEDUP_SYSTEM_PROMPT).toContain('new-')
})

test('renderUserPrompt includes existing bodyMd (cross-batch dedup has full context)', async () => {
  // TDD（第二轮）：跨批比对原本只发 title，同义候选 title 强调不同侧面时 LLM 看不出
  // 重复。existing 必须带 bodyMd 让 LLM 有完整上下文。根因见 spec §1.1 第 2 点。
  let captured = ''
  await judgeDuplicates({
    newCandidates: [newCand], existing,
    callLLM: async (_sys, user) => { captured = user; return JSON.stringify({ verdicts: [{ index: 0, isDuplicate: false }] }) },
  })
  expect(captured).toContain('14d refund window') // existing 的 bodyMd
})

test('DEDUP_SYSTEM_PROMPT mentions same-rule-different-facet = duplicate', () => {
  expect(DEDUP_SYSTEM_PROMPT).toContain('不同角度')
  expect(DEDUP_SYSTEM_PROMPT).toContain('只保留最完整的一条')
})

test('judgeDuplicates merges same-rule-different-facet siblings', async () => {
  // TDD：同一规则从"为什么/实现/触发"不同角度各写一条，prompt 指引 + 完整 body
  // 应让 LLM 判为重复，只留第一条。
  const a: DistillCandidate = { title: '[category:invariant] 退款须在发货后14天内', bodyMd: '14天退款窗口', scopeType: 'project', runtime: null, distillAction: 'new', subject: 'domain' }
  const b: DistillCandidate = { title: '[category:invariant] 退款规则的14天期限不可被丢弃', bodyMd: '退款期限是14天', scopeType: 'project', runtime: null, distillAction: 'new', subject: 'domain' }
  const v = await judgeDuplicates({
    newCandidates: [a, b], existing: [],
    callLLM: async () => JSON.stringify({ verdicts: [{ index: 0, isDuplicate: false }, { index: 1, isDuplicate: true, duplicateOfId: 'new-0' }] }),
  })
  expect(v).toEqual([
    { index: 0, duplicate: false },
    { index: 1, duplicate: true, duplicateOfId: 'new-0' },
  ])
})

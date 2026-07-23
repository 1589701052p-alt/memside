import { test, expect } from 'bun:test'
import { judgeDuplicates, type ExistingMemoryForDedup } from '@/memory/dedup'
import type { DistillCandidate } from '@/memory/distiller'

const existing: ExistingMemoryForDedup[] = [
  { id: 'A', title: '[category:invariant] refund within 14 days', scopeType: 'project', scopeId: '/r', status: 'approved' },
]
const newCand: DistillCandidate = {
  title: '[category:process] 退款必须在发货后14天内', bodyMd: '14天退款窗口',
  scopeType: 'project', runtime: null, distillAction: 'new',
}

test('judgeDuplicates marks duplicate with valid duplicateOfId', async () => {
  const v = await judgeDuplicates({
    newCandidates: [newCand], existing,
    callAnthropic: async () => JSON.stringify({ verdicts: [{ index: 0, isDuplicate: true, duplicateOfId: 'A' }] }),
  })
  expect(v).toEqual([{ index: 0, duplicate: true, duplicateOfId: 'A' }])
})

test('judgeDuplicates marks new when isDuplicate false', async () => {
  const v = await judgeDuplicates({
    newCandidates: [newCand], existing,
    callAnthropic: async () => JSON.stringify({ verdicts: [{ index: 0, isDuplicate: false }] }),
  })
  expect(v).toEqual([{ index: 0, duplicate: false }])
})

test('judgeDuplicates returns all new when LLM throws', async () => {
  const v = await judgeDuplicates({
    newCandidates: [newCand], existing,
    callAnthropic: async () => { throw new Error('api down') },
  })
  expect(v).toEqual([{ index: 0, duplicate: false }])
})

test('judgeDuplicates returns all new on non-JSON response', async () => {
  const v = await judgeDuplicates({
    newCandidates: [newCand], existing,
    callAnthropic: async () => 'not json',
  })
  expect(v).toEqual([{ index: 0, duplicate: false }])
})

test('judgeDuplicates returns all new on missing verdicts field', async () => {
  const v = await judgeDuplicates({
    newCandidates: [newCand], existing,
    callAnthropic: async () => JSON.stringify({ foo: 'bar' }),
  })
  expect(v).toEqual([{ index: 0, duplicate: false }])
})

test('judgeDuplicates treats hallucinated duplicateOfId as new', async () => {
  const v = await judgeDuplicates({
    newCandidates: [newCand], existing,
    callAnthropic: async () => JSON.stringify({ verdicts: [{ index: 0, isDuplicate: true, duplicateOfId: 'NONEXISTENT' }] }),
  })
  expect(v).toEqual([{ index: 0, duplicate: false }])
})

test('judgeDuplicates skips LLM and returns all new when existing is empty', async () => {
  let called = 0
  const v = await judgeDuplicates({
    newCandidates: [newCand], existing: [],
    callAnthropic: async () => { called++; return 'x' },
  })
  expect(called).toBe(0)
  expect(v).toEqual([{ index: 0, duplicate: false }])
})

test('judgeDuplicates returns [] and skips LLM when newCandidates is empty', async () => {
  let called = 0
  const v = await judgeDuplicates({
    newCandidates: [], existing,
    callAnthropic: async () => { called++; return 'x' },
  })
  expect(called).toBe(0)
  expect(v).toEqual([])
})

test('judgeDuplicates treats missing indices as new', async () => {
  const two: DistillCandidate[] = [newCand, { ...newCand, title: '[category:x] second' }]
  const v = await judgeDuplicates({
    newCandidates: two, existing,
    callAnthropic: async () => JSON.stringify({ verdicts: [{ index: 0, isDuplicate: false }] }),
  })
  expect(v).toEqual([{ index: 0, duplicate: false }, { index: 1, duplicate: false }])
})

test('user prompt includes existing titles and ids', async () => {
  let captured = ''
  await judgeDuplicates({
    newCandidates: [newCand], existing,
    callAnthropic: async (_sys, user) => { captured = user; return JSON.stringify({ verdicts: [{ index: 0, isDuplicate: false }] }) },
  })
  expect(captured).toContain('refund within 14 days')
  expect(captured).toContain('id=A')
})
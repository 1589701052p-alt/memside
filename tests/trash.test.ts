import { test, expect } from 'bun:test'
import { snapshotMemory, restoreFromSnapshot } from '@/memory/trash'
import type { Memory } from '@/memory/store'

// 回收站快照往返：Memory ↔ JSON 字符串全字段还原（spec §失败模式 #6 schema 演进容错）。
const base: Memory = {
  id: '01ABC', scopeType: 'project', scopeId: '/repo', runtime: 'claude-code',
  title: '[category:convention] x', bodyMd: 'body', tags: ['a', 'b'], status: 'approved',
  sourceKind: 'manual', sourceCwd: '/repo', sourceEventId: null, distillJobId: null,
  distillAction: null, supersedesId: null, supersededById: null, approvedAt: 123, createdAt: 456,
  version: 2, valueClass: 'convention', subjectSlug: 'my-slug', origin: 'user-stated', evidence: '原话',
}

test('snapshotMemory → restoreFromSnapshot 全字段往返', () => {
  const s = snapshotMemory(base)
  const restored = restoreFromSnapshot(s)
  expect(restored).toEqual(base)
})

test('restoreFromSnapshot 解析失败返回 null（不抛）', () => {
  expect(restoreFromSnapshot('not json')).toBeNull()
  expect(restoreFromSnapshot('{')).toBeNull()
  expect(restoreFromSnapshot('null')).toBeNull()
})

test('restoreFromSnapshot 缺字段容错（旧 snapshot 演进）', () => {
  // 旧 snapshot 没有 origin/evidence/valueClass —— 恢复时这些字段应回 null，不崩
  const old = { ...base, origin: undefined, evidence: undefined, valueClass: undefined, subjectSlug: undefined }
  const s = JSON.stringify(old)
  const r = restoreFromSnapshot(s)
  expect(r).not.toBeNull()
  expect(r!.origin).toBeNull()
  expect(r!.evidence).toBeNull()
  expect(r!.valueClass).toBeNull()
  expect(r!.subjectSlug).toBeNull()
})

test('restoreFromSnapshot tags 非数组降级为空数组', () => {
  const s = JSON.stringify({ ...base, tags: 'oops' })
  const r = restoreFromSnapshot(s)
  expect(r).not.toBeNull()
  expect(r!.tags).toEqual([])
})

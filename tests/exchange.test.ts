import { test, expect } from 'bun:test'
import { serializeMemoriesJson, parseMemoriesJson, detectExchangeFormat, MEMSIDE_JSON_FORMAT } from '@/memory/exchange'
import type { Memory } from '@/memory/store'

const mk = (over: Partial<Memory> = {}): Memory => ({
  id: '01A', scopeType: 'global', scopeId: null, runtime: null,
  title: '[category:convention] x', bodyMd: 'b', tags: ['t'], status: 'approved',
  sourceKind: 'manual', sourceCwd: null, sourceEventId: null, distillJobId: null,
  distillAction: null, supersedesId: null, supersededById: null, approvedAt: 100, createdAt: 200,
  version: 1, valueClass: 'convention', subjectSlug: 's', origin: 'user-stated', evidence: 'e',
  ...over,
})

test('serializeMemoriesJson → parseMemoriesJson 全字段往返', () => {
  const ms = [mk({ id: '1' }), mk({ id: '2', tags: ['a', 'b'], status: 'archived', approvedAt: null })]
  const text = serializeMemoriesJson(ms)
  const { memories, errors } = parseMemoriesJson(text)
  expect(errors).toEqual([])
  expect(memories).toEqual(ms)
})

test('serializeMemoriesJson 产出 envelope', () => {
  const text = serializeMemoriesJson([mk()])
  const obj = JSON.parse(text)
  expect(obj.format).toBe(MEMSIDE_JSON_FORMAT)
  expect(obj.version).toBe(1)
  expect(typeof obj.exportedAt).toBe('number')
  expect(Array.isArray(obj.memories)).toBe(true)
})

test('parseMemoriesJson 非法 format 拒绝', () => {
  const text = JSON.stringify({ format: 'something-else', version: 1, exportedAt: 0, memories: [] })
  const { memories, errors } = parseMemoriesJson(text)
  expect(memories).toEqual([])
  expect(errors.length).toBe(1)
})

test('parseMemoriesJson 缺 version 拒绝', () => {
  const text = JSON.stringify({ format: MEMSIDE_JSON_FORMAT, exportedAt: 0, memories: [] })
  const { memories, errors } = parseMemoriesJson(text)
  expect(memories).toEqual([])
  expect(errors.length).toBe(1)
})

test('parseMemoriesJson memories 非数组拒绝', () => {
  const text = JSON.stringify({ format: MEMSIDE_JSON_FORMAT, version: 1, exportedAt: 0, memories: 'nope' })
  const { memories, errors } = parseMemoriesJson(text)
  expect(memories).toEqual([])
  expect(errors.length).toBe(1)
})

test('parseMemoriesJson 非法条目跳过计 errors，不整批失败', () => {
  const obj = {
    format: MEMSIDE_JSON_FORMAT, version: 1, exportedAt: 0,
    memories: [mk({ id: 'ok' }), { id: 'bad', scopeType: 'WRONG', title: '', bodyMd: '' }, 'literal-string'],
  }
  const { memories, errors } = parseMemoriesJson(JSON.stringify(obj))
  expect(memories.length).toBe(1)
  expect(memories[0]!.id).toBe('ok')
  expect(errors.length).toBe(2)
})

test('parseMemoriesJson 畸形 JSON 返回空 + errors', () => {
  const { memories, errors } = parseMemoriesJson('{ not json')
  expect(memories).toEqual([])
  expect(errors.length).toBe(1)
})

test('detectExchangeFormat: memside JSON → json', () => {
  expect(detectExchangeFormat(serializeMemoriesJson([mk()]))).toBe('json')
})

test('detectExchangeFormat: 非法 JSON → markdown 兜底', () => {
  expect(detectExchangeFormat('# not json at all')).toBe('markdown')
  expect(detectExchangeFormat('{ malformed')).toBe('markdown')
})

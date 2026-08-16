import { test, expect } from 'bun:test'
import { serializeMemoriesJson, parseMemoriesJson, detectExchangeFormat, MEMSIDE_JSON_FORMAT, serializeMemoriesMd, parseMemoriesMd } from '@/memory/exchange'
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

test('serializeMemoriesMd 产出 markdown 结构', () => {
  const text = serializeMemoriesMd([mk({ id: '1', scopeType: 'project', scopeId: '/repo', runtime: 'claude-code', subjectSlug: 'slug-a', tags: ['x', 'y'] })])
  expect(text).toContain('# memside 记忆导出')
  expect(text).toContain('## [category:convention] x')
  expect(text).toContain('**范围**: project · claude-code')
  expect(text).toContain('**来源项目**: /repo')
  expect(text).toContain('**标签**: x, y')
  expect(text).toContain('**主题**: slug-a')
  expect(text).toContain('---')
})

test('serializeMemoriesMd 无标签/无 slug 不渲染对应行', () => {
  const text = serializeMemoriesMd([mk({ id: '1', scopeType: 'global', scopeId: null, runtime: null, tags: [], subjectSlug: null, sourceCwd: null })])
  expect(text).not.toContain('**标签**')
  expect(text).not.toContain('**主题**')
  expect(text).not.toContain('**来源项目**')
  expect(text).toContain('**范围**: global')
})

test('parseMemoriesMd 往返基本场景', () => {
  const md = serializeMemoriesMd([mk({ id: '1', scopeType: 'project', scopeId: '/repo', runtime: 'claude-code', subjectSlug: 's1', tags: ['a', 'b'], bodyMd: '正文内容' })])
  const { inputs, errors } = parseMemoriesMd(md)
  expect(errors).toEqual([])
  expect(inputs.length).toBe(1)
  expect(inputs[0]!.title).toBe('[category:convention] x')
  expect(inputs[0]!.bodyMd).toBe('正文内容')
  expect(inputs[0]!.scopeType).toBe('project')
  expect(inputs[0]!.scopeId).toBe('/repo')
  expect(inputs[0]!.runtime).toBe('claude-code')
  expect(inputs[0]!.tags).toEqual(['a', 'b'])
  expect(inputs[0]!.subjectSlug).toBe('s1')
  expect(inputs[0]!.sourceKind).toBe('manual')
})

test('parseMemoriesMd 多条 + 标题无 category 前缀', () => {
  const md = [
    '# memside 记忆导出',
    '> 导出于 ...',
    '',
    '---',
    '',
    '## [category:decision] 标题A',
    '',
    '- **范围**: global',
    '',
    '内容A',
    '',
    '---',
    '',
    '## 标题B（无 category）',
    '',
    '- **范围**: project · opencode',
    '- **来源项目**: /r',
    '',
    '内容B 多行',
    '第二行',
  ].join('\n')
  const { inputs, errors } = parseMemoriesMd(md)
  expect(errors).toEqual([])
  expect(inputs.length).toBe(2)
  expect(inputs[0]!.title).toBe('[category:decision] 标题A')
  expect(inputs[0]!.scopeType).toBe('global')
  expect(inputs[1]!.title).toBe('标题B（无 category）')
  expect(inputs[1]!.scopeType).toBe('project')
  expect(inputs[1]!.runtime).toBe('opencode')
  expect(inputs[1]!.bodyMd).toBe('内容B 多行\n第二行')
})

test('parseMemoriesMd bodyMd 含 --- 不被误切', () => {
  const md = [
    '# memside 记忆导出', '', '---', '',
    '## [category:trap] X', '',
    '- **范围**: global', '',
    '正文',
    '---',  // 独立行分隔
    '正文继续',
    '',
    '## [category:trap] Y', '',
    '- **范围**: global', '',
    'B',
  ].join('\n')
  const { inputs, errors } = parseMemoriesMd(md)
  expect(errors.length).toBe(0)
  expect(inputs.length).toBe(2)
  expect(inputs[0]!.title).toBe('[category:trap] X')
  expect(inputs[1]!.title).toBe('[category:trap] Y')
})

test('parseMemoriesMd 空文档/无小节返回空', () => {
  expect(parseMemoriesMd('').inputs).toEqual([])
  expect(parseMemoriesMd('# memside 记忆导出\n\n无小节').inputs).toEqual([])
})

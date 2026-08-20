// tests/web-origin-filter.test.ts
// 第五维 origin（出处）筛选的 web 层回归锁定。
// 设计依据：docs/superpowers/specs/2026-08-20-origin-filter-design.md
//
// 纯函数层（hasActiveFilter / originName）可断言；App.tsx 巨型组件沿用仓库惯例
// 只留源代码层文本断言兜底（筛选条含「出处」label + ExportTrigger filter 含 origin 映射），
// refactor 删除接线锚点即变红。
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { hasActiveFilter, EMPTY_MEMORY_FILTER } from '@/web/tab-cache'
import { originName } from '@/web/ui-utils'

const src = readFileSync(join(import.meta.dir, '..', 'src', 'web', 'App.tsx'), 'utf8')

describe('hasActiveFilter: origin 维（spec §接口契约 web 层）', () => {
  test('origin 非空 -> true（即使其余四维空）', () => {
    expect(hasActiveFilter({ ...EMPTY_MEMORY_FILTER, origin: 'user-stated' })).toBe(true)
    expect(hasActiveFilter({ ...EMPTY_MEMORY_FILTER, origin: 'unlabeled' })).toBe(true)
  })
  test('全空（含 origin）-> false', () => {
    expect(hasActiveFilter(EMPTY_MEMORY_FILTER)).toBe(false)
  })
  test('origin 空但其余维度非空 -> true（不被 origin 拖回 false）', () => {
    expect(hasActiveFilter({ ...EMPTY_MEMORY_FILTER, project: 'C:/p' })).toBe(true)
  })
})

describe('originName: 下拉措辞单一事实来源（spec §接口契约 web 层）', () => {
  test('哨兵 ORIGIN_UNLABELED -> 未标注', () => {
    expect(originName('unlabeled')).toBe('未标注')
  })
  test('三合法值委托 originBadge 中文名', () => {
    expect(originName('user-stated')).toBe('用户陈述')
    expect(originName('user-confirmed')).toBe('用户采纳')
    expect(originName('agent-observed')).toBe('agent 观察')
  })
  test('未知值原样返回（向后兼容老数据 / 新旧版本值集变化）', () => {
    expect(originName('something-new')).toBe('something-new')
    expect(originName('')).toBe('')
  })
})

describe('App.tsx 第五维 origin 接线（source text 锚点）', () => {
  test('筛选条含「出处」label 的 FilterSelect', () => {
    expect(src).toContain('出处')
  })
  test('ExportTrigger filter 映射含 origin（导出集 = UI 所见）', () => {
    expect(src).toMatch(/origin:\s*filter\.origin/)
  })
  test('筛选条用 originName 渲染选项措辞（不裸写中文名）', () => {
    expect(src).toContain('originName(')
  })
  test('选项来自 facets?.origins ?? []（老 daemon 降级兜底）', () => {
    expect(src).toContain('origins ?? []')
  })
})

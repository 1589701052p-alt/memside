import { test, expect, describe, it } from 'bun:test'
import {
  categoryInfo, categoryFromTitle, stripCategoryPrefix, valueClassInfo,
  originBadge, scopeInfo, runtimeLabel, runtimeTip, SLUG_BADGE_TIP, updateBadge,
} from '@/web/ui-utils'
import { categoryFromTitle as backendCategoryFromTitle } from '@/memory/pure'

// Web UI 可理解性改造（spec 2026-08-11-ui-clarity §10）：语义映射纯函数层全覆盖。
// 为什么存在：卡片徽章/筛选下拉的全部「黑话 -> 人话」翻译锚定在这些纯函数上，
// 措辞回归（幻觉分类兜底、未评估哨兵）必须红。一致性段锁 web 本地副本与
// 后端 @/memory/pure 的正则语义不漂移（spec 决策 D7）。

// --- categoryInfo ---

test('categoryInfo: 10 标准分类 -> 中文名 + 非空 tip', () => {
  const expected: [string, string][] = [
    ['domain-glossary', '领域术语'], ['invariant', '业务铁律'], ['process', '业务流程'],
    ['architecture', '架构决策'], ['integration', '外部集成'], ['compliance', '合规约束'],
    ['data-semantics', '数据语义'], ['anti-pattern', '避坑教训'],
    ['convention', '团队约定'], ['quality-bar', '完成标准'],
  ]
  for (const [value, name] of expected) {
    const info = categoryInfo(value)
    expect(info).not.toBeNull()
    expect(info!.name).toBe(name)
    expect(info!.tip.length).toBeGreaterThan(0)
  }
})

test('categoryInfo: 大小写不敏感 + trim', () => {
  expect(categoryInfo('CONVENTION')!.name).toBe('团队约定')
  expect(categoryInfo('  invariant  ')!.name).toBe('业务铁律')
})

test('categoryInfo: 幻觉值兜底 -> 原值 + 非标准 tip', () => {
  const info = categoryInfo('foo-bar')!
  expect(info.name).toBe('foo-bar')
  expect(info.tip).toContain('非标准分类')
})

test('categoryInfo: null/undefined/空/纯空白 -> null', () => {
  expect(categoryInfo(null)).toBeNull()
  expect(categoryInfo(undefined)).toBeNull()
  expect(categoryInfo('')).toBeNull()
  expect(categoryInfo('   ')).toBeNull()
})

// --- valueClassInfo ---

test('valueClassInfo: 六筐 name/priority/tip', () => {
  const cases: [string, string, '高' | null][] = [
    ['user-rule', '规矩', '高'], ['decision', '决策', '高'],
    ['preference', '偏好', null], ['convention', '约定', null],
    ['trap', '避坑教训', null], ['topology', '结构拓扑', null],
  ]
  for (const [vc, name, priority] of cases) {
    const info = valueClassInfo(vc)
    expect(info.name).toBe(name)
    expect(info.priority).toBe(priority)
    expect(info.tip.length).toBeGreaterThan(0)
  }
})

test('valueClassInfo: null/undefined/未知值 -> 未评估', () => {
  for (const vc of [null, undefined, 'nonsense'] as const) {
    const info = valueClassInfo(vc)
    expect(info.name).toBe('未评估')
    expect(info.priority).toBeNull()
    expect(info.tip).toContain('批量拒绝')
  }
})

// --- originBadge ---

test('originBadge: label/color 逐字回归 + tip 非空', () => {
  const stated = originBadge('user-stated')!
  expect(stated.label).toBe('用户陈述')
  expect(stated.color).toBe('#6a1b9a')
  expect(stated.tip.length).toBeGreaterThan(0)
  const confirmed = originBadge('user-confirmed')!
  expect(confirmed.label).toBe('用户采纳')
  expect(confirmed.color).toBe('#00838f')
  expect(confirmed.tip.length).toBeGreaterThan(0)
  const observed = originBadge('agent-observed')!
  expect(observed.label).toBe('agent 观察')
  expect(observed.color).toBe('#999')
  expect(observed.tip.length).toBeGreaterThan(0)
})

// --- scopeInfo / runtimeLabel ---

test('scopeInfo: project/global/缺失/未知', () => {
  expect(scopeInfo('project').name).toBe('仅本项目')
  expect(scopeInfo('global').name).toBe('所有项目')
  expect(scopeInfo(null).name).toBe('未知')
  expect(scopeInfo(undefined).name).toBe('未知')
  expect(scopeInfo('weird').name).toBe('未知')
  expect(scopeInfo('project').tip.length).toBeGreaterThan(0)
})

test('runtimeLabel: claude-code/opencode/null/未知', () => {
  expect(runtimeLabel('claude-code')).toBe('Claude Code')
  expect(runtimeLabel('opencode')).toBe('opencode')
  expect(runtimeLabel(null)).toBe('任意')
  expect(runtimeLabel(undefined)).toBe('任意')
  expect(runtimeLabel('weird')).toBe('weird')
})

test('runtimeTip: 按值措辞 + 未知值兜底（spec §4.5）', () => {
  expect(runtimeTip('claude-code')).toBe('产生这条记忆的会话来自 Claude Code')
  expect(runtimeTip('opencode')).toBe('产生这条记忆的会话来自 opencode')
  expect(runtimeTip(null)).toBe('未限定来源工具（老数据）')
  expect(runtimeTip(undefined)).toBe('未限定来源工具（老数据）')
  expect(runtimeTip('weird')).toBe('产生这条记忆的会话所用的运行时工具')
})

// --- stripCategoryPrefix / categoryFromTitle(web 副本) ---

test('stripCategoryPrefix: 剥前缀 + trim', () => {
  expect(stripCategoryPrefix('[category:convention] 每个 PR 必须加 CHANGELOG')).toBe('每个 PR 必须加 CHANGELOG')
})

test('stripCategoryPrefix: 大小写不敏感', () => {
  expect(stripCategoryPrefix('[CATEGORY:trap] 标题')).toBe('标题')
})

test('stripCategoryPrefix: 多前缀全剥（病态输入保留内部双空格，浏览器渲染自然折叠）', () => {
  expect(stripCategoryPrefix('[category:a] 中 [category:b] 段')).toBe('中  段')
})

test('stripCategoryPrefix: 无前缀原样返回', () => {
  expect(stripCategoryPrefix('普通标题')).toBe('普通标题')
})

test('stripCategoryPrefix: 仅前缀 -> 返回原标题（不渲染空白）', () => {
  expect(stripCategoryPrefix('[category:only]')).toBe('[category:only]')
})

test('categoryFromTitle(web): 前缀位置任意 + 小写化 + 空值/无前缀 null', () => {
  expect(categoryFromTitle('[category:Convention] x')).toBe('convention')
  expect(categoryFromTitle('x [category:trap]')).toBe('trap')
  expect(categoryFromTitle('[category:] x')).toBeNull()
  expect(categoryFromTitle('无前缀')).toBeNull()
})

// --- 一致性（spec 决策 D7：web 本地副本 vs 后端 pure.ts 不得漂移）---

const CORPUS = [
  '[category:convention] 每个 PR 必须加 CHANGELOG',
  '[CATEGORY:Invariant] 大写前缀',
  'title 中段 [category:trap] 前缀',
  '无前缀的普通标题',
  '[category:a] 多前缀 [category:b]',
  '',
  '[category:] 空值前缀',
]

test('一致性: web categoryFromTitle 与 @/memory/pure 逐例相等', () => {
  for (const t of CORPUS) {
    expect(categoryFromTitle(t)).toBe(backendCategoryFromTitle(t))
  }
})

test('一致性: stripCategoryPrefix 后提不出分类', () => {
  for (const t of CORPUS) {
    expect(categoryFromTitle(stripCategoryPrefix(t))).toBeNull()
  }
})

test('SLUG_BADGE_TIP: 含分组语义', () => {
  expect(SLUG_BADGE_TIP).toContain('主题分组标识')
})

// --- updateBadge（spec 2026-08-19-candidate-consolidation §6.3）---
// 为什么存在：update_of 候选显紫色「更新 #」徽标，提示这是对既有已审批记忆的精炼
// 而非全新条目；批准时会取代原记忆。纯函数层锁 label/color/tip 语义，防措辞回退。

describe('updateBadge', () => {
  it('update_of + supersedesId -> badge with 更新 label + 紫色 + 取代提示', () => {
    const b = updateBadge({ distillAction: 'update_of', supersedesId: '01HXYZ123' })
    expect(b).not.toBeNull()
    expect(b!.label).toContain('更新')
    expect(b!.label).toContain('#01HXYZ')  // short = supersedesId.slice(0,6)
    expect(b!.color).toBe('purple')
    expect(b!.tip).toContain('取代原记忆')
  })

  it('update_of + supersedesId 非空（极短 id，<6 字也安全）', () => {
    const b = updateBadge({ distillAction: 'update_of', supersedesId: 'abc' })
    expect(b).not.toBeNull()
    expect(b!.label).toBe('更新 #abc')
  })

  it('new / null supersedesId -> null (no badge)', () => {
    expect(updateBadge({ distillAction: 'new', supersedesId: null })).toBeNull()
    expect(updateBadge({ distillAction: 'update_of', supersedesId: null })).toBeNull()
    expect(updateBadge({ distillAction: 'update_of', supersedesId: '' })).toBeNull()
  })

  it('null distillAction / 其它 action -> null', () => {
    expect(updateBadge({ distillAction: null, supersedesId: '01HXYZ' })).toBeNull()
    expect(updateBadge({ distillAction: 'duplicate_of', supersedesId: '01HXYZ' })).toBeNull()
    expect(updateBadge({ distillAction: 'conflict_with', supersedesId: '01HXYZ' })).toBeNull()
  })
})
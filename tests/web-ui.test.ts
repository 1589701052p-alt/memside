import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// 源代码层文本断言兜底（CLAUDE.md）：React 组件不便于单测，至少锁住"来源"
// 标注与 scope 编辑入口存在于 App.tsx。一旦被 refactor 删除会立刻变红。
const src = readFileSync(join(import.meta.dir, '..', 'src', 'web', 'App.tsx'), 'utf8')

test('App.tsx annotates source project', () => {
  expect(src).toContain('来源')
  expect(src).toContain('sourceCwd')
})

test('App.tsx exposes a scope edit control', () => {
  expect(src).toContain('scopeType')
})

test('App.tsx surfaces edit errors (spec §8)', () => {
  expect(src).toContain('editError')
})

// Task 8: 价值优先级排序 + valueClass 徽标 + 批量拒绝未评估。
// 派生优先级标签(高·决策 等) + 未评估 占位 + 批量拒绝按钮文案。
// 一旦 refactor 删掉这些 UI 锚点会立刻变红。
test('App.tsx renders valueClass badge labels and bulk-reject button (source text)', () => {
  // 派生优先级标签
  expect(src).toContain('高·决策')
  expect(src).toContain('未评估')
  // 批量拒绝未评估按钮
  expect(src).toContain('批量拒绝未评估')
})

// 原始输入溯源（2026-07-28）：卡片「查看原始输入」按钮 + 遮罩层组件。
// React 组件不单测，源码文本断言锁住 UI 锚点，refactor 删除即变红。
test('App.tsx has source-input view button + modal (source text)', () => {
  expect(src).toContain('查看原始输入')
  expect(src).toContain('SourceInputModal')
})

test('App.tsx source-input modal shows unavailable / loading / error states', () => {
  // 状态可见性（CLAUDE.md 硬规则）：不得静默 stall
  expect(src).toContain('无原始输入快照')
  expect(src).toContain('加载中')
  expect(src).toContain('无法加载原始输入')
})

// subject-keyed 聚合（spec §4.7）：卡片 slug 徽标 + 编辑表单 slug 输入框。
// React 组件不单测，源码文本断言锁住 UI 锚点，refactor 删除即变红。
test('App.tsx shows subject slug badge + edit input (source text)', () => {
  expect(src).toContain('subjectSlug')
  expect(src).toContain('subject slug')
})

// Task 8: 4-tab 审计视图（候选审批 / 已审批 / 已拒绝 / AI自动拒绝）。
// React 组件不单测，源码文本断言锁住 tab 标签 + DiscardCard + 各操作接线 +
// 已提升标注存在性，refactor 删除即变红。
test('App.tsx renders 4 audit-view tabs (source text)', () => {
  expect(src).toContain('候选审批')
  expect(src).toContain('已审批')
  expect(src).toContain('已拒绝')
  expect(src).toContain('AI自动拒绝')
})

test('App.tsx has DiscardCard component (source text)', () => {
  expect(src).toContain('DiscardCard')
})

test('App.tsx wires restore/archive/unarchive/promote actions (source text)', () => {
  expect(src).toContain('restoreMemory')
  expect(src).toContain('archiveMemory')
  expect(src).toContain('unarchiveMemory')
  expect(src).toContain('promoteDiscard')
})

test('App.tsx shows promoted marker on discards (source text)', () => {
  expect(src).toContain('已提升')
})

// Task 8: 第 5 tab「蒸馏记录」+ DistillRunRow + DistillRunModal。
// React 组件不单测，源码文本断言锁住 tab key / label / 行组件 / 遮罩层 /
// refresh 拉取 / 两个纯函数接线，refactor 删除即变红。
test('App.tsx has distill runs tab + row + modal', () => {
  expect(src).toContain("'runs'")          // TabKey 含 runs
  expect(src).toContain('蒸馏记录')         // tab label
  expect(src).toContain('DistillRunRow')   // 列表行组件
  expect(src).toContain('DistillRunModal') // 详情遮罩层
  expect(src).toContain('listDistillRuns') // refresh 拉取
  expect(src).toContain('formatOutcome')   // 徽标纯函数
  expect(src).toContain('formatRunCounts') // 计数链纯函数
})

// distill-error-capture（2026-07-29）：llm_error 时展示错误描述。
// DistillRunModal 产出区从纯文案「LLM 调用失败」改为展示 detail.errorMessage
// （pre 块红色样式），历史 run 无该字段兜底「（无错误描述）」不静默空白。
// DistillRunRow 在 outcome 徽标下加一行截断错误便于逐个查看。
// React 组件不单测，源码文本断言锁住 UI 锚点，refactor 删除即变红。
test('DistillRunModal renders llm_error errorMessage', () => {
  const src = readFileSync(join(import.meta.dir, '..', 'src', 'web', 'App.tsx'), 'utf8')
  // llm_error 分支展示 errorMessage（非空白兜底）
  expect(src).toContain('detail.errorMessage')
  expect(src).toContain('无错误描述')
})

test('DistillRunRow renders truncated errorMessage for llm_error', () => {
  const src = readFileSync(join(import.meta.dir, '..', 'src', 'web', 'App.tsx'), 'utf8')
  // 列表行 llm_error 时显示截断错误
  expect(src).toContain("r.outcome === 'llm_error'")
  expect(src).toContain('r.errorMessage')
  expect(src).toContain('textOverflow')
})

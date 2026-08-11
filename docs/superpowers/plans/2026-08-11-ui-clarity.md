# Web UI 可理解性改造 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 记忆审阅页全部「黑话」自解释化——category/slug/价值筐/出处徽章带字段前缀与悬停解释，title 剥离 `[category:xxx]` 前缀，元信息行字段化，筛选栏加标题与选项中文化。

**Architecture:** 全部语义映射抽为 `src/web/ui-utils.ts` 纯函数（单一事实来源，返回 `{name/label, tip}`），App.tsx 只负责前缀拼接与 `title` 属性挂载；视觉风格（inline style）不动，数据模型/服务端/注入链路零改动。

**Tech Stack:** Bun + React 19（inline style，无新依赖）+ bun:test + tsc --noEmit。

**Spec:** `docs/superpowers/specs/2026-08-11-ui-clarity-design.md`（文案以 spec §4 权威表为准，逐字照抄，不得发挥）。

## Global Constraints

- 测试只能用 `bun test` 运行，**严禁 npm test**（项目规则，npm test 走 Node 会因 Bun 专有 API 失败）。
- commit 前门槛：`bun run typecheck && bun test` 全绿。
- 零数据模型 / 服务端 / 注入链路 / distiller / scheduler / 状态机改动；筛选值仍传英文原值，中文化只在显示层。
- 不引入新依赖、不引入样式框架；沿用 inline style 与既有组件结构。
- 编辑表单 title 输入框保留含前缀原值（`stripCategoryPrefix` 只用于显示路径）。
- 分支 `feat/ui-clarity`（已切好）；严禁在 master 上 commit。
- commit message 末尾带 `Co-Authored-By: Claude <noreply@anthropic.com>`。

## File Structure

| 文件 | 职责 | 动它的 task |
|---|---|---|
| `src/web/ui-utils.ts` | 语义映射纯函数层（新增 6 函数 + 1 常量 + originBadge 加 tip） | Task 1 |
| `tests/ui-clarity.test.ts` | 新文件：语义纯函数全覆盖 + 跨模块一致性锁 | Task 1 |
| `tests/ui-utils.test.ts` | 存量 originBadge 断言更新（tip 字段） | Task 1 |
| `src/web/App.tsx` | MemoryCard 显示层 / DiscardCard / 筛选栏；删 VALUE_LABEL/valueBadge/priorityRank 死代码；加 CHIP_STYLE | Task 2-4 |
| `tests/web-ui.test.ts` | 旧锚点更新 + 新增可理解性回归锁 | Task 2-4 |
| `src/memory/store.ts` | 仅 :987 注释（priorityRank 引用过期） | Task 2 |

---

### Task 1: ui-utils 语义纯函数层 + 测试

**Files:**
- Modify: `src/web/ui-utils.ts`（文件末尾追加 + originBadge 原地扩展）
- Create: `tests/ui-clarity.test.ts`
- Modify: `tests/ui-utils.test.ts:165-170`（originBadge 断言加 tip）

**Interfaces:**
- Consumes: 无（纯函数层，不依赖其他 task）
- Produces（后续 task 依赖的精确签名）：
  - `categoryInfo(value: string | null | undefined): { name: string; tip: string } | null`
  - `categoryFromTitle(title: string): string | null`
  - `stripCategoryPrefix(title: string): string`
  - `valueClassInfo(vc: string | null | undefined): { name: string; priority: '高' | null; tip: string }`
  - `originBadge(origin: string | null | undefined): { label: string; color: string; tip: string } | null`（既有函数加 tip，label/color 逐字不变）
  - `scopeInfo(scopeType: string | null | undefined): { name: string; tip: string }`
  - `runtimeLabel(runtime: string | null | undefined): string`
  - `export const SLUG_BADGE_TIP: string`

- [ ] **Step 1: 写失败测试 `tests/ui-clarity.test.ts`（完整内容）**

```ts
import { test, expect } from 'bun:test'
import {
  categoryInfo, categoryFromTitle, stripCategoryPrefix, valueClassInfo,
  originBadge, scopeInfo, runtimeLabel, SLUG_BADGE_TIP,
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
```

- [ ] **Step 2: 跑测试确认红**

Run: `bun test tests/ui-clarity.test.ts`
Expected: FAIL——`categoryInfo` 等符号在 `@/web/ui-utils` 不存在（import 解析错误 / undefined）。

- [ ] **Step 3: 更新 `tests/ui-utils.test.ts:165-170` 的 originBadge 断言（tip 字段）**

把这段：

```ts
test('originBadge: user-stated/user-confirmed/agent-observed/null 映射', () => {
  expect(originBadge('user-stated')).toEqual({ label: '用户陈述', color: '#6a1b9a' })
  expect(originBadge('user-confirmed')).toEqual({ label: '用户采纳', color: '#00838f' })
  expect(originBadge('agent-observed')).toEqual({ label: 'agent 观察', color: '#999' })
  expect(originBadge(null)).toBeNull()
  expect(originBadge(undefined)).toBeNull()
})
```

替换为（label/color 逐字回归保留，断言方式改逐字段以容纳 tip）：

```ts
test('originBadge: user-stated/user-confirmed/agent-observed/null 映射（label/color 逐字回归 + tip）', () => {
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
  expect(originBadge(null)).toBeNull()
  expect(originBadge(undefined)).toBeNull()
})
```

（改完后此测试会变红——originBadge 还没加 tip，`stated.tip` 是 undefined，`expect(undefined).toBeGreaterThan(0)` 失败。这是预期的 TDD 红信号，Step 4 实现后转绿。）

- [ ] **Step 4: 实现 `src/web/ui-utils.ts`——originBadge 原地扩展**

把现有 originBadge（约 :110-115）替换为（doc 注释末尾补一行 tip 说明）：

```ts
export function originBadge(origin: string | null | undefined): { label: string; color: string; tip: string } | null {
  if (origin === 'user-stated') return { label: '用户陈述', color: '#6a1b9a', tip: '用户在会话里亲口说的，可信度最高' }
  if (origin === 'user-confirmed') return { label: '用户采纳', color: '#00838f', tip: 'agent 提议、被用户采纳的' }
  if (origin === 'agent-observed') return { label: 'agent 观察', color: '#999', tip: 'agent 自己观察总结的，审批时多留个心眼' }
  return null
}
```

- [ ] **Step 5: 实现 `src/web/ui-utils.ts`——文件末尾追加语义映射段（完整内容）**

```ts
// ---------------------------------------------------------------------------
// Web UI 可理解性（spec 2026-08-11-ui-clarity）：黑话 -> 人话语义映射。
// 徽章/筛选下拉全部措辞的单一事实来源；渲染处只拼接「分类：」「价值：」等前缀。
// ---------------------------------------------------------------------------

/** spec §4.1 文案权威表。键为小写分类值。 */
const CATEGORY_INFO: Record<string, { name: string; tip: string }> = {
  'domain-glossary': { name: '领域术语', tip: '本产品/领域特有的概念定义' },
  invariant: { name: '业务铁律', tip: '用户领域里必须永远成立的硬规则' },
  process: { name: '业务流程', tip: '业务流转、状态机、顺序/依赖约束' },
  architecture: { name: '架构决策', tip: '带理由的技术/设计决策（"为什么"是重点）' },
  integration: { name: '外部集成', tip: '外部系统契约、SLA、幂等/重试约定' },
  compliance: { name: '合规约束', tip: '法规/法律层面的限制' },
  'data-semantics': { name: '数据语义', tip: '字段、枚举、状态值的隐含含义' },
  'anti-pattern': { name: '避坑教训', tip: '已知故障模式/不要做的事' },
  convention: { name: '团队约定', tip: '团队/评审者的稳定偏好，后续会话应遵守' },
  'quality-bar': { name: '完成标准', tip: '本项目里什么算"做完了"' },
}

/**
 * category 语义（spec §5）。null/空/纯空白 -> null；标准值 trim+小写后查表；
 * 未知（幻觉）值 -> { name: 原值, tip: 非标准提示 }。never-throw。
 */
export function categoryInfo(value: string | null | undefined): { name: string; tip: string } | null {
  if (typeof value !== 'string') return null
  const v = value.trim().toLowerCase()
  if (v === '') return null
  return CATEGORY_INFO[v] ?? { name: value, tip: '非标准分类（模型自由发挥）' }
}

/**
 * 从 title 提取 [category:xxx] 值。web 本地副本（spec 决策 D7：vite 无 @ alias，
 * web 层不跨层 import）——与 @/memory/pure categoryFromTitle 同语义，
 * tests/ui-clarity.test.ts 一致性段锁定漂移。
 */
export function categoryFromTitle(title: string): string | null {
  if (typeof title !== 'string') return null
  const m = /\[category:([^\]]*)\]/i.exec(title)
  if (!m) return null
  const v = m[1]!.trim().toLowerCase()
  return v.length > 0 ? v : null
}

/**
 * 显示用：剥离 title 的 [category:xxx] 前缀（与 exactDedup.ts 剥离正则同族：
 * 大小写不敏感、剥全部出现、trim）。剥离后为空串 -> 返回原标题，绝不渲染空白。
 * 只用于显示路径；编辑输入框仍用原标题（spec §6.1 规则 4）。
 */
export function stripCategoryPrefix(title: string): string {
  if (typeof title !== 'string') return title
  const stripped = title.replace(/\[category:[^\]]*\]/gi, '').trim()
  return stripped === '' ? title : stripped
}

/** spec §4.2 文案权威表。 */
const VALUE_CLASS_INFO: Record<string, { name: string; priority: '高' | null; tip: string }> = {
  'user-rule': { name: '规矩', priority: '高', tip: '用户明确立下的规矩/约定，审批时最值得优先看' },
  decision: { name: '决策', priority: '高', tip: '用户确认过的重要决策（含理由）' },
  preference: { name: '偏好', priority: null, tip: '用户的个性化偏好' },
  convention: { name: '约定', priority: null, tip: '团队/评审者的稳定约定' },
  trap: { name: '避坑教训', priority: null, tip: '踩过的坑/事故教训' },
  topology: { name: '结构拓扑', priority: null, tip: '系统构成与依赖关系' },
}

/**
 * 价值六筐语义（spec §5）。null/undefined/未知值 -> 未评估（承接旧 valueBadge
 * 兜底语义）。never-throw。
 */
export function valueClassInfo(vc: string | null | undefined): { name: string; priority: '高' | null; tip: string } {
  if (typeof vc === 'string' && VALUE_CLASS_INFO[vc]) return VALUE_CLASS_INFO[vc]!
  return { name: '未评估', priority: null, tip: 'AI 未给出价值判定；候选 tab 可一键批量拒绝未评估项' }
}

/** scope 文案（spec §4.5）。never-throw。 */
export function scopeInfo(scopeType: string | null | undefined): { name: string; tip: string } {
  if (scopeType === 'project') return { name: '仅本项目', tip: '这条记忆只会注入源项目（来源目录）的会话' }
  if (scopeType === 'global') return { name: '所有项目', tip: '这条记忆会注入所有项目的会话' }
  return { name: '未知', tip: '老数据缺少 scope 信息' }
}

/** runtime 文案（spec §4.5）。未知值原样返回兜底。never-throw。 */
export function runtimeLabel(runtime: string | null | undefined): string {
  if (runtime === 'claude-code') return 'Claude Code'
  if (runtime === 'opencode') return 'opencode'
  if (runtime == null) return '任意'
  return runtime
}

/** 主题 slug 徽章固定 tip（spec §4.4）。 */
export const SLUG_BADGE_TIP = '主题分组标识。同主题的记忆共用一个 slug，注入新会话时合并为一节；可在编辑里修改。'
```

- [ ] **Step 6: 跑测试确认绿**

Run: `bun test tests/ui-clarity.test.ts tests/ui-utils.test.ts`
Expected: PASS（全绿）。

- [ ] **Step 7: 全量门槛**

Run: `bun run typecheck && bun test`
Expected: 全绿（存量测试不受影响——originBadge 旧 toEqual 断言已在 Step 3 更新）。

- [ ] **Step 8: Commit**

```bash
git add src/web/ui-utils.ts tests/ui-clarity.test.ts tests/ui-utils.test.ts
git commit -m "feat(web-ui): 可理解性语义纯函数层（categoryInfo/valueClassInfo/scopeInfo 等）

spec: docs/superpowers/specs/2026-08-11-ui-clarity-design.md §5

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: MemoryCard 显示层重构（标题剥离 + 徽章行 + 元信息字段化）

**Files:**
- Modify: `src/web/App.tsx`（import 行 / 删 VALUE_LABEL 块 / 加 CHIP_STYLE / MemoryCard 显示分支 / 筛选栏价值选项行）
- Modify: `src/memory/store.ts:987`（注释）
- Modify: `tests/web-ui.test.ts`（两处旧锚点更新 + 追加新回归锁）

**Interfaces:**
- Consumes: Task 1 的 `categoryInfo / categoryFromTitle / stripCategoryPrefix / valueClassInfo / scopeInfo / runtimeLabel / SLUG_BADGE_TIP`（签名见 Task 1 Produces）
- Produces: App.tsx 模块级 `CHIP_STYLE` 常量（Task 3 DiscardCard 复用）；`tests/web-ui.test.ts` 顶部 `src` 变量（既有，追加测试直接复用）

**注意**：App.tsx 在后续 task 还会被改，本 task 给出的行号仅作定位参考，一律按 old_string 内容匹配，不盲目按行号操作。

- [ ] **Step 1: 更新 `tests/web-ui.test.ts` 两处旧锚点 + 追加新回归锁（先红）**

替换 `tests/web-ui.test.ts` 中这段（约 :22-31）：

```ts
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
```

改为：

```ts
// 价值徽标 + 批量拒绝未评估。2026-08-11 ui-clarity：旧缩写文案（高·决策 等）
// 有意废除，六筐映射迁 ui-utils valueClassInfo；锚点改锁新接线。
test('App.tsx renders value badge via valueClassInfo + bulk-reject button (source text)', () => {
  expect(src).toContain('valueClassInfo(')
  expect(src).toContain('未评估')
  // 批量拒绝未评估按钮
  expect(src).toContain('批量拒绝未评估')
})
```

替换 `tests/web-ui.test.ts` 中这段（约 :152-157）：

```ts
test('App.tsx VALUE_LABEL covers 6 buckets incl user-rule + preference (source text)', () => {
  const src = readFileSync(join(import.meta.dir, '..', 'src', 'web', 'App.tsx'), 'utf8')
  // 6 筐映射必须含 user-rule（高·规矩）与 preference（中·偏好）
  expect(src).toContain("'user-rule'")
  expect(src).toContain('preference')
})
```

改为（映射搬家 → 断言对象换成 ui-utils.ts 源码）：

```ts
test('ui-utils valueClassInfo covers 6 buckets incl user-rule + preference (source text)', () => {
  // 2026-08-11 ui-clarity：六筐映射从 App.tsx VALUE_LABEL 迁到 ui-utils.ts
  const utils = readFileSync(join(import.meta.dir, '..', 'src', 'web', 'ui-utils.ts'), 'utf8')
  expect(utils).toContain("'user-rule'")
  expect(utils).toContain('preference')
  expect(utils).toContain('valueClassInfo')
})
```

在 `tests/web-ui.test.ts` 文件末尾追加：

```ts
// Web UI 可理解性改造（2026-08-11 ui-clarity）：卡片信息架构重构回归锁。
// 标题剥离 + 徽章行（分类/价值/出处/主题）+ 元信息字段化 + 旧缩写退场。
test('App.tsx 卡片可理解性：标题剥离 + 徽章行 + 元信息字段化 (source text)', () => {
  expect(src).toContain('stripCategoryPrefix(')
  expect(src).toContain('categoryInfo(')
  expect(src).toContain('scopeInfo(')
  expect(src).toContain('runtimeLabel(')
  expect(src).toContain('SLUG_BADGE_TIP')
  expect(src).toContain('分类：')
  expect(src).toContain('价值：')
  expect(src).toContain('主题：')
  expect(src).toContain('范围:')
  expect(src).toContain('会话工具:')
  expect(src).toContain('源项目:')
  expect(src).toContain('提炼于:')
})

test('App.tsx 旧缩写文案退场（反向断言：高·/中· 拼接格式不得复活）', () => {
  expect(src).not.toContain('高·')
  expect(src).not.toContain('中·')
})
```

- [ ] **Step 2: 跑测试确认红**

Run: `bun test tests/web-ui.test.ts`
Expected: FAIL——`valueClassInfo(` / `stripCategoryPrefix(` 等锚点缺失；反向断言 `not.toContain('高·')` 失败（VALUE_LABEL 还在）。

- [ ] **Step 3: `src/web/App.tsx` 删 VALUE_LABEL/valueBadge/priorityRank，加 CHIP_STYLE**

删除这整段（约 :17-36，含 doc 注释）：

```tsx
/**
 * valueClass -> 中文徽标 / 优先级排序。模块顶层定义以便 MemoryCard 直接复用
 * valueBadge,不必经 props 透传。
 *
 * 6 筐优先级:user-rule/decision=高(0),preference/convention/trap/topology=中(1),
 * null=未评估(2)。候选队列按此排序,高价值先审;未评估条目可一键批量拒绝。
 * 出处驱动的价值判定（2026-07-30）扩 6 筐。
 */
const VALUE_LABEL: Record<string, string> = {
  'user-rule': '高·规矩', decision: '高·决策',
  preference: '中·偏好', convention: '中·约定', trap: '中·陷阱', topology: '中·拓扑',
}
function valueBadge(vc: string | null | undefined): string {
  return vc && VALUE_LABEL[vc] ? VALUE_LABEL[vc] : '未评估'
}
function priorityRank(vc: string | null | undefined): number {
  if (vc === 'user-rule' || vc === 'decision') return 0
  if (vc && VALUE_LABEL[vc]) return 1
  return 2
}
```

原位替换为：

```tsx
/**
 * 徽章 chip 通用样式（spec 2026-08-11-ui-clarity §6.1 规则 1）。语义映射全部在
 * ui-utils 纯函数（categoryInfo/valueClassInfo/scopeInfo/runtimeLabel），本文件
 * 只负责「分类：」「价值：」等前缀拼接与 title 悬停挂载。
 */
const CHIP_STYLE = {
  background: '#f5f5f5',
  border: '1px solid #e5e5e5',
  borderRadius: 4,
  padding: '2px 8px',
  fontSize: 12,
}
```

（priorityRank 已确认零调用：排序走 sortCandidatesByTime；tests/ui-sort-source.test.ts 只反向断言旧 comparator 模式，与删除兼容。）

- [ ] **Step 4: `src/web/App.tsx` import 行补新纯函数**

把：

```tsx
import { formatMemoryTime, sortCandidatesByTime, formatSourceTurn, formatOutcome, formatRunCounts, llmSourceLabel, originBadge, discardReasonLabel, rescanPercent, degradationKindLabel, formatToolCall, projectDisplayName } from './ui-utils'
```

改为：

```tsx
import { formatMemoryTime, sortCandidatesByTime, formatSourceTurn, formatOutcome, formatRunCounts, llmSourceLabel, originBadge, discardReasonLabel, rescanPercent, degradationKindLabel, formatToolCall, projectDisplayName, categoryInfo, categoryFromTitle, stripCategoryPrefix, valueClassInfo, scopeInfo, runtimeLabel, SLUG_BADGE_TIP } from './ui-utils'
```

- [ ] **Step 5: `src/web/App.tsx` MemoryCard 显示分支重构**

把 MemoryCard 显示分支中这段（`<strong>{m.title}</strong>` 到 `</small>`，约 :1001-1016）：

```tsx
          <strong>{m.title}</strong>
          <span style={{ marginLeft: 8, fontSize: 12, color: '#888' }}>{valueBadge(m.valueClass)}</span>
          {(() => { const ob = originBadge(m.origin); return ob ? (
            <span style={{ marginLeft: 8, fontSize: 12, color: ob.color }}>{ob.label}</span>
          ) : null })()}
          {m.subjectSlug ? (
            <span style={{ marginLeft: 8, fontSize: 12, color: '#36c' }}>[{m.subjectSlug}]</span>
          ) : null}
          {m.evidence ? (
            <p style={{ color: '#6a1b9a', fontSize: 13, margin: '4px 0' }}>出处：{m.evidence}</p>
          ) : null}
          {m.bodyMd && <p style={{ color: '#555' }}>{m.bodyMd}</p>}
          <small>
            {m.scopeType} · {m.runtime ?? '任意 runtime'} · 来源: <span title={m.sourceCwd ?? ''}>{sourceLabel}</span>
            {time ? ` · ${time}` : ''}
          </small>
```

替换为：

```tsx
          <strong>{stripCategoryPrefix(m.title)}</strong>
          {/* 徽章行：分类 -> 价值 -> 出处 -> 主题；各带字段名前缀 + 悬停 tip（spec §6.1） */}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '6px 0' }}>
            {(() => { const cat = categoryInfo(categoryFromTitle(m.title)); return cat ? (
              <span title={cat.tip} style={{ ...CHIP_STYLE, color: '#444' }}>分类：{cat.name}</span>
            ) : null })()}
            {(() => { const v = valueClassInfo(m.valueClass); return (
              <span title={v.tip} style={{ ...CHIP_STYLE, color: '#444' }}>价值：{v.name}{v.priority ? ` · ${v.priority}优先` : ''}</span>
            ) })()}
            {(() => { const ob = originBadge(m.origin); return ob ? (
              <span title={ob.tip} style={{ ...CHIP_STYLE, color: ob.color }}>出处：{ob.label}</span>
            ) : null })()}
            {m.subjectSlug ? (
              <span title={SLUG_BADGE_TIP} style={{ ...CHIP_STYLE, color: '#36c' }}>主题：{m.subjectSlug}</span>
            ) : null}
          </div>
          {m.evidence ? (
            <p style={{ color: '#6a1b9a', fontSize: 13, margin: '4px 0' }}>出处：{m.evidence}</p>
          ) : null}
          {m.bodyMd && <p style={{ color: '#555' }}>{m.bodyMd}</p>}
          <small>
            {(() => { const s = scopeInfo(m.scopeType); return (
              <span title={s.tip}>范围: {s.name}</span>
            ) })()}
            {' · '}
            <span title="产生这条记忆的会话所用的运行时工具">会话工具: {runtimeLabel(m.runtime)}</span>
            {' · '}
            <span>源项目: <span title={m.sourceCwd ?? ''}>{sourceLabel}</span></span>
            {time ? <>{' · '}<span title="AI 从会话提炼出这条记忆的时间">提炼于: {time}</span></> : null}
          </small>
```

（编辑分支 `<input value={title} ...>` 不动——save 链路继续存含前缀原标题。）

- [ ] **Step 6: `src/web/App.tsx` 筛选栏价值选项行改走 valueClassInfo（编译守卫）**

VALUE_LABEL 已删，筛选栏价值下拉（约 :466-471）仍引用它会编译失败。把：

```tsx
                options={(facets?.valueClasses ?? []).map((p) => ({
                  value: p.value,
                  label: `${p.value === UNEVALUATED ? '未评估' : VALUE_LABEL[p.value] ?? p.value} (${p.count})`,
                }))} />
```

替换为：

```tsx
                options={(facets?.valueClasses ?? []).map((p) => {
                  const v = valueClassInfo(p.value === UNEVALUATED ? null : p.value)
                  return { value: p.value, label: `${v.name}${v.priority ? ` · ${v.priority}优先` : ''} (${p.count})` }
                })} />
```

（筛选栏的标题/说明/维度改名/分类选项中文化在 Task 4；此处只保编译绿 + 价值选项中文化顺带落地。）

- [ ] **Step 7: `src/memory/store.ts:987` 注释更新**

把：

```ts
/** 6 个保护类 valueClass（= 前端 priorityRank < 2 的全集）；其余候选视为「未评估」。 */
```

改为：

```ts
/** 6 个保护类 valueClass（= 前端 valueClassInfo 的 6 个标准筐）；其余候选视为「未评估」。 */
```

- [ ] **Step 8: 全量门槛**

Run: `bun run typecheck && bun test`
Expected: 全绿。重点确认：tests/web-ui.test.ts 新锚点全过、反向断言（`高·`/`中·` 退场）过、tests/ui-sort-source.test.ts 不受影响。

- [ ] **Step 9: Commit**

```bash
git add src/web/App.tsx src/memory/store.ts tests/web-ui.test.ts
git commit -m "feat(web-ui): 记忆卡片信息架构重构（标题剥离 + 徽章行 + 元信息字段化）

spec: docs/superpowers/specs/2026-08-11-ui-clarity-design.md §6.1

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: DiscardCard 可理解性同步

**Files:**
- Modify: `src/web/App.tsx`（DiscardCard 组件）
- Modify: `tests/web-ui.test.ts`（追加 DiscardCard 锚点）

**Interfaces:**
- Consumes: Task 1 纯函数 + Task 2 的 `CHIP_STYLE`（App.tsx 模块级常量，同文件直接引用）
- Produces: 无新接口（终态组件改动）

- [ ] **Step 1: `tests/web-ui.test.ts` 末尾追加锚点（先红）**

```ts
test('App.tsx DiscardCard 可理解性：标题剥离 + 拒绝理由前缀 + 元信息字段化 (source text)', () => {
  expect(src).toContain('stripCategoryPrefix(d.title)')
  expect(src).toContain('拒绝理由:')
  expect(src).toContain('拒绝于:')
})
```

- [ ] **Step 2: 跑测试确认红**

Run: `bun test tests/web-ui.test.ts`
Expected: FAIL——三个锚点缺失。

- [ ] **Step 3: `src/web/App.tsx` DiscardCard 重构**

把 DiscardCard 的 return 中这段（`<strong>{d.title}</strong>` 到 `</small>`）：

```tsx
      <strong>{d.title}</strong>
      <span style={{ marginLeft: 8, fontSize: 12, color: '#c00' }}>{discardReasonLabel(d.reason)}</span>
      {d.bodyMd && <p style={{ color: '#555' }}>{d.bodyMd}</p>}
      <small>
        {d.scopeType ?? '未知 scope'} · 来源: <span title={d.sourceCwd ?? ''}>{sourceLabel}</span>
        {time ? ` · ${time}` : ''}
      </small>
```

替换为：

```tsx
      <strong>{stripCategoryPrefix(d.title)}</strong>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '6px 0' }}>
        {(() => { const cat = categoryInfo(categoryFromTitle(d.title)); return cat ? (
          <span title={cat.tip} style={{ ...CHIP_STYLE, color: '#444' }}>分类：{cat.name}</span>
        ) : null })()}
        <span title="AI 自动拒绝候选的理由。想找回可点「提升为候选」。" style={{ ...CHIP_STYLE, color: '#c00' }}>拒绝理由: {discardReasonLabel(d.reason)}</span>
      </div>
      {d.bodyMd && <p style={{ color: '#555' }}>{d.bodyMd}</p>}
      <small>
        {(() => { const s = scopeInfo(d.scopeType ?? null); return (
          <span title={s.tip}>范围: {s.name}</span>
        ) })()}
        {' · '}
        <span>源项目: <span title={d.sourceCwd ?? ''}>{sourceLabel}</span></span>
        {time ? <>{' · '}<span title="AI 自动拒绝这条候选的时间">拒绝于: {time}</span></> : null}
      </small>
```

（已提升标注 / 提升按钮不动。）

- [ ] **Step 4: 全量门槛**

Run: `bun run typecheck && bun test`
Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
git add src/web/App.tsx tests/web-ui.test.ts
git commit -m "feat(web-ui): DiscardCard 可理解性同步（分类徽章 + 拒绝理由前缀 + 元信息字段化）

spec: docs/superpowers/specs/2026-08-11-ui-clarity-design.md §6.2

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: 筛选栏标题/说明 + 维度改名 + 选项中文化

**Files:**
- Modify: `src/web/App.tsx`（筛选条 JSX 区块 + 其上方注释）
- Modify: `tests/web-ui.test.ts`（追加筛选栏锚点）

**Interfaces:**
- Consumes: Task 1 的 `categoryInfo`（分类选项中文化）、Task 2 已落地的价值选项 valueClassInfo 接线
- Produces: 无新接口（终态 JSX 改动）

- [ ] **Step 1: `tests/web-ui.test.ts` 末尾追加锚点（先红）**

```ts
test('App.tsx 筛选栏可理解性：标题/说明 + 维度改名 + 分类选项中文化 (source text)', () => {
  expect(src).toContain('按以下条件缩小列表')
  expect(src).toContain('每个 tab 的筛选相互独立')
  expect(src).toContain('label="源项目"')
  expect(src).toContain('label="主题（slug）"')
  expect(src).toContain('label="价值"')
  expect(src).not.toContain('label="价值筐"')
  expect(src).toContain('categoryInfo(p.value)')
})
```

- [ ] **Step 2: 跑测试确认红**

Run: `bun test tests/web-ui.test.ts`
Expected: FAIL——锚点缺失（`label="价值筐"` 反向断言此刻也失败）。

- [ ] **Step 3: `src/web/App.tsx` 筛选条区块重构**

先把筛选条上方注释末尾补一句（原注释保留）：`2026-08-11 ui-clarity：加标题/说明 + 维度改名 + 分类/价值选项中文化（映射走 ui-utils）。`

然后把整个筛选条区块（`{isFilterTab(tab) ? (` 到对应 `) : null}`，约 :449-481）：

```tsx
      {isFilterTab(tab) ? (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 16, padding: 10, border: '1px solid #e0e0e0', borderRadius: 8, background: '#fafafa' }}>
          <FilterSelect label="项目" disabled={facets === null} value={filter.project}
            onChange={(v) => changeFilter({ ...filter, project: v })}
            options={(facets?.projects ?? []).map((p) => ({
              value: p.value,
              label: `${projectDisplayName(p.value, (facets?.projects ?? []).map((x) => x.value))} (${p.count})`,
              title: p.value,
            }))} />
          <FilterSelect label="分类" disabled={facets === null} value={filter.category}
            onChange={(v) => changeFilter({ ...filter, category: v })}
            options={(facets?.categories ?? []).map((p) => ({ value: p.value, label: `${p.value} (${p.count})` }))} />
          {tab !== 'discards' ? (
            <>
              <FilterSelect label="slug" disabled={facets === null} value={filter.slug}
                onChange={(v) => changeFilter({ ...filter, slug: v })}
                options={(facets?.slugs ?? []).map((p) => ({ value: p.value, label: `${p.value} (${p.count})` }))} />
              <FilterSelect label="价值" disabled={facets === null} value={filter.valueClass}
                onChange={(v) => changeFilter({ ...filter, valueClass: v })}
                options={(facets?.valueClasses ?? []).map((p) => {
                  const v = valueClassInfo(p.value === UNEVALUATED ? null : p.value)
                  return { value: p.value, label: `${v.name}${v.priority ? ` · ${v.priority}优先` : ''} (${p.count})` }
                })} />
            </>
          ) : null}
          {facets === null ? (
            <span style={{ fontSize: 12, color: '#888' }}>筛选选项加载失败，稍后自动重试</span>
          ) : null}
          {hasActiveFilter(filter) ? (
            <button onClick={() => changeFilter(EMPTY_MEMORY_FILTER)}>清除筛选</button>
          ) : null}
        </div>
      ) : null}
```

替换为：

```tsx
      {isFilterTab(tab) ? (
        <div style={{ display: 'flex', flexDirection: 'column', marginBottom: 16, padding: 10, border: '1px solid #e0e0e0', borderRadius: 8, background: '#fafafa' }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>筛选</div>
          <div style={{ fontSize: 12, color: '#888', marginBottom: 8 }}>按以下条件缩小列表。每个 tab 的筛选相互独立。</div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <FilterSelect label="源项目" disabled={facets === null} value={filter.project}
              onChange={(v) => changeFilter({ ...filter, project: v })}
              options={(facets?.projects ?? []).map((p) => ({
                value: p.value,
                label: `${projectDisplayName(p.value, (facets?.projects ?? []).map((x) => x.value))} (${p.count})`,
                title: p.value,
              }))} />
            <FilterSelect label="分类" disabled={facets === null} value={filter.category}
              onChange={(v) => changeFilter({ ...filter, category: v })}
              options={(facets?.categories ?? []).map((p) => ({
                value: p.value,
                label: `${categoryInfo(p.value)?.name ?? p.value} (${p.count})`,
                title: p.value,
              }))} />
            {tab !== 'discards' ? (
              <>
                <FilterSelect label="主题（slug）" disabled={facets === null} value={filter.slug}
                  onChange={(v) => changeFilter({ ...filter, slug: v })}
                  options={(facets?.slugs ?? []).map((p) => ({ value: p.value, label: `${p.value} (${p.count})` }))} />
                <FilterSelect label="价值" disabled={facets === null} value={filter.valueClass}
                  onChange={(v) => changeFilter({ ...filter, valueClass: v })}
                  options={(facets?.valueClasses ?? []).map((p) => {
                    const v = valueClassInfo(p.value === UNEVALUATED ? null : p.value)
                    return { value: p.value, label: `${v.name}${v.priority ? ` · ${v.priority}优先` : ''} (${p.count})` }
                  })} />
              </>
            ) : null}
            {facets === null ? (
              <span style={{ fontSize: 12, color: '#888' }}>筛选选项加载失败，稍后自动重试</span>
            ) : null}
            {hasActiveFilter(filter) ? (
              <button onClick={() => changeFilter(EMPTY_MEMORY_FILTER)}>清除筛选</button>
            ) : null}
          </div>
        </div>
      ) : null}
```

- [ ] **Step 4: 全量门槛 + 验收清单核对**

Run: `bun run typecheck && bun test`
Expected: 全绿。

逐项核对 spec §11 验收清单：卡片无裸 `[category:xxx]`/`[slug]`/`高·陷阱`/裸元信息行（grep App.tsx 确认 `[{m.subjectSlug}]`、`{m.scopeType} ·`、`来源:` 旧模式已消失）；注入链路零改动（`src/memory/pure.ts` 无 diff：`git diff origin/master -- src/memory/pure.ts` 为空）。

- [ ] **Step 5: Commit**

```bash
git add src/web/App.tsx tests/web-ui.test.ts
git commit -m "feat(web-ui): 筛选栏标题/说明 + 维度改名 + 选项中文化

spec: docs/superpowers/specs/2026-08-11-ui-clarity-design.md §7

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## 收尾（orchestrator 职责，非 subagent task）

- 更新 `STATE.md`：按既有格式追加「Web UI 可理解性改造（2026-08-11）」小节（测试结果数、分支、spec/plan 路径、deferred minor）。
- push 分支（本机 git 需 `http.sslBackend=openssl`：`git -c http.sslBackend=openssl push -u origin feat/ui-clarity`）+ 开 PR 到 master。

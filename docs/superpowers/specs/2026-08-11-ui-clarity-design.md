# Web UI 可理解性改造设计 spec（记忆审阅页信息架构重构）

日期：2026-08-11
分支：`feat/ui-clarity`（基线 origin/master `d9c410c`）
状态：设计已获用户逐节批准（映射表 / 卡片布局 / 筛选栏三节）；用户授权 spec → plan → subagent-driven 执行连续进行，不再逐段确认。

## 1. 背景与问题

用户反馈记忆审阅页「非常不直观」，五个具体痛点：

1. **category 不透明**：title 里的 `[category:xxx]` 前缀原样显示，共几类、每类什么含义，用户完全不感知。蒸馏器定义了 10 个标准分类（`src/memory/distiller.ts:11-21`），UI 没有任何解释。
2. **`[grep-path-fallback]` 式标签不透明**：subjectSlug 徽标只是一串英文方括号，用户不知道这是主题分组标识、更不知道它决定注入时的分节合并。
3. **`中·陷阱` / `agent 观察` 式徽章不透明**：价值六筐徽章把优先级（高/中）与筐名缩写拼接（`VALUE_LABEL`，App.tsx:25-28），origin 徽章（用户陈述/用户采纳/agent 观察）无上下文，用户无法理解。
4. **元信息行不透明**：`project · claude-code · 来源: memside · 2026/8/11 15:36:25` 四个裸值一行（App.tsx:1013-1016），没有字段名，用户不知道每段是什么。
5. **筛选栏无标题**：四个下拉浮在灰底区块里（App.tsx:449-481），用户不知道这是干什么的。

根因：UI 直接渲染存储字段（title 原文、scopeType/runtime 裸值、valueClass 内部缩写），呈现层没有做「黑话 → 人话」翻译。

## 2. 目标 / 非目标

**目标**：

- 卡片上每个可见元素自解释：看文字即知是什么，悬停（native `title`）即知详细含义。
- 全部语义映射抽为 `src/web/ui-utils.ts` 纯函数，测试锚定在纯函数层（CLAUDE.md「首选可断言面」）。
- 视觉风格不动：沿用 inline style、既有 chip/卡片结构，不引入样式框架（CLAUDE.md Web UI 约束）。

**非目标**：

- 零数据模型改动：不加列、不改 title 存储格式（`[category:xxx]` 前缀继续存）。
- 零服务端改动：`/api/facets`、筛选参数、分页、status 全部不动；筛选值仍传英文原值，中文化只在显示层。
- 零注入链路改动：`formatMemoryBlock` / `clipByBudget` 不碰。
- 不动 distiller / scheduler / store / 状态机 / valueFilter。
- 不动蒸馏记录 tab、设置 tab、状态栏、SourceInputModal / DistillRunModal。
- 不给 slug 加中文显示名（不加字段）。
- 不做自定义样式化 tooltip（不引入 hover 状态管理）。

## 3. 设计决策（用户裁决记录）

| # | 决策 | 备选与否决理由 |
|---|---|---|
| D1 | **方案 A：纯函数语义层 + native title tooltip** | B（自定义 Badge 组件 + 样式化 tooltip）：组件层可测面薄、hover 状态管理复杂，收益纯装饰；C（卡片精简 + 详情遮罩层）：审批是高频操作，每条多一次点击拖慢核心工作流 |
| D2 | **徽章自解释 + 悬停提示**，不做常驻图例面板 | 图例占空间，熟悉后是噪声 |
| D3 | **slug 保留英文 + 标注用途** | 加中文显示名要动数据模型 + 编辑 + 注入渲染，工作量翻倍；卡片隐藏 slug 失去主题可见性 |
| D4 | **title 显示剥离 `[category:xxx]` 前缀、编辑保留原文** | title 是存储值，服务端分类筛选靠 title 前缀 instr 匹配（store-filter），动存储值会断筛选 |
| D5 | **优先级不做独立徽章**：仅 user-rule/decision 两项在文案带「高优先」 | 排序已改按时间（`sortCandidatesByTime`），优先级只剩参考价值，不值得占独立视觉位 |
| D6 | **筛选值传英文原值，中文化只在显示层** | 服务端按原值匹配，中文值需要服务端映射表，违反零服务端改动 |
| D7 | **category 提取在 web 本地复制纯函数 + 一致性测试锁定**，不跨层 import `@/memory/pure` | vite.config.ts 无 `@` alias（只 tsconfig 有），web bundle 解析不了；相对导入虽可行但破坏 web 层自包含惯例（现状 web 零后端 import）；仓库既有跨层类型重复模式（STATE.md distill-work-record deferred #3）+ 一致性测试防漂移 |

## 4. 文案权威表（徽标与字段的唯一措辞来源）

### 4.1 category 分类徽章（显示格式：`分类：<name>`）

| 值 | name | tip（悬停解释） |
|---|---|---|
| domain-glossary | 领域术语 | 本产品/领域特有的概念定义 |
| invariant | 业务铁律 | 用户领域里必须永远成立的硬规则 |
| process | 业务流程 | 业务流转、状态机、顺序/依赖约束 |
| architecture | 架构决策 | 带理由的技术/设计决策（"为什么"是重点） |
| integration | 外部集成 | 外部系统契约、SLA、幂等/重试约定 |
| compliance | 合规约束 | 法规/法律层面的限制 |
| data-semantics | 数据语义 | 字段、枚举、状态值的隐含含义 |
| anti-pattern | 避坑教训 | 已知故障模式/不要做的事 |
| convention | 团队约定 | 团队/评审者的稳定偏好，后续会话应遵守 |
| quality-bar | 完成标准 | 本项目里什么算"做完了" |

幻觉值兜底：`name = 原值`，`tip = '非标准分类（模型自由发挥）'`。分类值查询前 trim + 转小写（facets 与 title 大小写可能漂移）。

### 4.2 价值六筐徽章（显示格式：`价值：<name>` 或 `价值：<name> · 高优先`）

| valueClass | name | priority | tip |
|---|---|---|---|
| user-rule | 规矩 | 高 | 用户明确立下的规矩/约定，审批时最值得优先看 |
| decision | 决策 | 高 | 用户确认过的重要决策（含理由） |
| preference | 偏好 | — | 用户的个性化偏好 |
| convention | 约定 | — | 团队/评审者的稳定约定 |
| trap | 避坑教训 | — | 踩过的坑/事故教训 |
| topology | 结构拓扑 | — | 系统构成与依赖关系 |
| null / 未知值 | 未评估 | — | AI 未给出价值判定；候选 tab 可一键批量拒绝未评估项 |

### 4.3 出处徽章（显示格式：`出处：<label>`）

| origin | label（不变） | color（不变） | tip（新增） |
|---|---|---|---|
| user-stated | 用户陈述 | #6a1b9a | 用户在会话里亲口说的，可信度最高 |
| user-confirmed | 用户采纳 | #00838f | agent 提议、被用户采纳的 |
| agent-observed | agent 观察 | #999 | agent 自己观察总结的，审批时多留个心眼 |

null/未知 → 不显示徽章（老行行为保持）。

### 4.4 主题 slug 徽章（显示格式：`主题：<slug>`）

tip 固定：`主题分组标识。同主题的记忆共用一个 slug，注入新会话时合并为一节；可在编辑里修改。`

### 4.5 元信息行字段（MemoryCard 四项 / DiscardCard 三项）

| 字段 | 显示 | tip |
|---|---|---|
| scopeType=project | `范围: 仅本项目` | 这条记忆只会注入源项目（来源目录）的会话 |
| scopeType=global | `范围: 所有项目` | 这条记忆会注入所有项目的会话 |
| scopeType 缺失 | `范围: 未知` | 老数据缺少 scope 信息 |
| runtime=claude-code | `会话工具: Claude Code` | 产生这条记忆的会话来自 Claude Code |
| runtime=opencode | `会话工具: opencode` | 产生这条记忆的会话来自 opencode |
| runtime 缺失 | `会话工具: 任意` | 未限定来源工具（老数据） |
| sourceCwd | `源项目: <末段名>` | 产生这条记忆的会话所在目录（title 属性挂完整路径，现状保持） |
| createdAt | `提炼于: <本地时间>` | AI 从会话提炼出这条记忆的时间 |
| discard.ts | `拒绝于: <本地时间>` | AI 自动拒绝这条候选的时间 |

DiscardCard 的 reason 徽章加前缀：`拒绝理由: <discardReasonLabel(reason)>`，tip：`AI 自动拒绝候选的理由。想找回可点「提升为候选」。`

## 5. 纯函数接口契约（src/web/ui-utils.ts 新增 / 扩展）

所有函数 never-throw；非法/缺失输入走兜底，绝不返回 undefined 形状。

```ts
/** category 语义。null/空/纯空白 -> null；10 标准值（trim+小写后匹配）-> 中文名+tip；
 *  未知值 -> { name: 原值, tip: '非标准分类（模型自由发挥）' }。 */
export function categoryInfo(value: string | null | undefined): { name: string; tip: string } | null

/** 从 title 提取 [category:xxx] 值。与 @/memory/pure categoryFromTitle 同语义
 *  （正则 /\[category:([^\]]*)\]/i，trim+小写，无匹配->null）。D7 本地复制 + 一致性测试。 */
export function categoryFromTitle(title: string): string | null

/** 显示用剥离 title 的 [category:xxx] 前缀。与 exactDedup.ts:14 剥离正则同族
 *  （大小写不敏感、剥全部出现、trim）。剥离后为空串 -> 返回原标题（绝不渲染空白）。 */
export function stripCategoryPrefix(title: string): string

/** 价值六筐语义。null/undefined/未知值 -> 未评估。 */
export function valueClassInfo(vc: string | null | undefined): { name: string; priority: '高' | null; tip: string }

/** 既有 originBadge 扩展：返回加 tip 字段；label/color 逐字不变（存量测试同步更新）。 */
export function originBadge(origin: string | null | undefined): { label: string; color: string; tip: string } | null

/** scope 文案。project -> 仅本项目；global -> 所有项目；其余 -> 未知。 */
export function scopeInfo(scopeType: string | null | undefined): { name: string; tip: string }

/** runtime 文案。claude-code -> 'Claude Code'；opencode -> 'opencode'；null/undefined -> '任意'；
 *  未知值原样返回。 */
export function runtimeLabel(runtime: string | null | undefined): string

/** runtime 悬停解释（spec §4.5 按值措辞；未知值兜底通用文案）。never-throw。 */
export function runtimeTip(runtime: string | null | undefined): string
```

徽章文本拼接规则（渲染处组合，非纯函数职责）：

- 分类：`分类：${categoryInfo(v).name}`；价值：`价值：${name}` +（priority ? ` · 高优先`）；出处：`出处：${label}`；主题：`主题：${slug}`。
- 所有徽章元素带 `title={tip}`。

## 6. 卡片布局重构

### 6.1 MemoryCard（候选/已审批/已拒绝三 tab 共用）

```
<标题：stripCategoryPrefix(m.title)>                      ← strong，剥离前缀
[分类：团队约定] [价值：规矩 · 高优先] [出处：用户陈述] [主题：bun-test-runner]  ← 徽章行
出处：「evidence 原话」                                    ← 现状保持
bodyMd                                                    ← 现状保持
范围: 仅本项目 · 会话工具: Claude Code · 源项目: memside · 提炼于: 2026/8/11 15:36:25
[操作按钮]                                                 ← 现状保持
```

规则：

1. 徽章行 `display:flex, gap:6, flexWrap:wrap, margin:'6px 0'`；每枚 chip：`background:#f5f5f5, border:1px solid #e5e5e5, borderRadius:4, padding:'2px 8px', fontSize:12`。文字色：分类/价值 `#444`，出处沿用 originBadge.color，主题 `#36c`。
2. 徽章顺序固定：分类 → 价值 → 出处 → 主题；有什么显什么（无分类前缀不显分类；老行无 origin 不显出处；无 slug 不显主题；价值未评估也显「价值：未评估」——与现状 valueBadge 一致，它参与批量拒绝语义，必须可见）。
3. 元信息行：`<small>` 样式不变；四个字段各包 `<span title={tip}>`，分隔符 ` · ` 保持。源项目显示逻辑（sourceCwd 末段 / manual / opencode / 未知兜底）逐字不动，只加字段名与 tip。
4. **编辑模式零改动**：title 输入框仍是完整原标题（含前缀）；scope 单选、body、slug 输入框不动。
5. 标题剥离后为空串（title 只有前缀）→ 显示原标题（stripCategoryPrefix 兜底）。

### 6.2 DiscardCard

1. 标题同剥离前缀；前缀存在时加「分类：」chip（与 MemoryCard 同函数同样式）。
2. reason 徽章：`拒绝理由: <discardReasonLabel(reason)>` + tip（§4.5），红色文字保持。
3. 元信息行字段化：`范围: … · 源项目: … · 拒绝于: …`（discards 表无 runtime 列，只三项）。
4. 已提升标注 / 提升按钮不动。

## 7. 筛选栏重构

1. **标题 + 说明**：灰底区块改为 `flexDirection: column`；顶部加：
   - `筛选`（fontWeight 600, fontSize 13）
   - `按以下条件缩小列表。每个 tab 的筛选相互独立。`（fontSize 12, color #888, marginBottom 8）
   下拉行包一层 `display:flex, gap:10, flexWrap:wrap, alignItems:center`，「清除筛选」按钮与灰字降级留在该行。
2. **FilterSelect 标签改名**：项目 → `源项目`；分类不变；slug → `主题（slug）`；价值筐 → `价值`。
3. **选项文案中文化**（同一套纯函数，单一事实来源）：
   - 分类选项：`${categoryInfo(v)?.name ?? v} (${count})`，option `title` 属性挂英文原值。
   - 价值选项：`${name}${priority ? ' · 高优先' : ''} (${count})`；`UNEVALUATED` 哨兵显 `未评估 (${count})`。
   - 源项目 / 主题（slug）选项值不变（projectDisplayName 已人话；slug 本就是标识符）。
4. **不变**：per-tab 独立筛选态、facetsByTab 缓存、changeFilter 只作废当前 tab 缓存、filterRef 防轮换闭包、facets 未就绪灰字、`hasActiveFilter` 空态文案。

## 8. 改动面与耦合点

| 文件 | 改动 |
|---|---|
| `src/web/ui-utils.ts` | 新增 categoryInfo / categoryFromTitle / stripCategoryPrefix / valueClassInfo / scopeInfo / runtimeLabel；originBadge 加 tip |
| `src/web/App.tsx` | MemoryCard 显示层（标题剥离 + 徽章行 + 元信息字段化）；DiscardCard 同步；筛选栏标题/说明/标签/选项中文化；删除本地 VALUE_LABEL + valueBadge（迁 ui-utils 的 valueClassInfo 取代）；**删除死代码 priorityRank**（已 grep 确认零调用：排序走 sortCandidatesByTime；tests/ui-sort-source.test.ts 只断言旧 comparator 模式不存在，与删除兼容） |
| `src/memory/store.ts` | 仅注释：`:987` 注释引用了被删的 `priorityRank`，改为引用 `valueClassInfo`（value_class 保护逻辑本身不动） |
| `tests/ui-utils.test.ts` | originBadge 断言更新（tip 字段） |
| `tests/web-ui.test.ts` | 旧锚点更新（`高·决策` / VALUE_LABEL 两条，见 §10.3）+ 新增可理解性回归锚点 |
| 新测试文件 `tests/ui-clarity.test.ts` | §10.1 全部纯函数 case + 一致性测试 |

不动：`src/server.ts`、`src/memory/*`、`src/web/api.ts`、`src/web/tab-cache.ts`、`vite.config.ts`、schema。

## 9. 失败模式

| # | 场景 | 行为 |
|---|---|---|
| F1 | 幻觉 category（模型自由发挥的值） | 徽章/下拉显原值，tip 标注「非标准分类」；不崩不空白 |
| F2 | title 仅含前缀，剥离后为空 | stripCategoryPrefix 返回原标题，绝不渲染空白 |
| F3 | 老行无 origin / 无 valueClass | origin 徽章不显（现状）；价值显「未评估」（现状） |
| F4 | facets 加载失败 | 灰字降级保持现状；中文化函数不参与（无选项可渲染） |
| F5 | web 本地 categoryFromTitle 与后端 pure.ts 语义漂移 | 一致性测试（§10.2）锁定；红即意图 |
| F6 | 编辑 title 时误剥前缀 | 编辑输入框绑定 m.title 原值，stripCategoryPrefix 只用于显示路径，不进 save 链路 |
| F7 | native title tooltip 触屏不可见 | 接受：桌面工具；徽章文字本身已自解释（前缀 + 中文筐名） |
| F8 | 旧测试锚定旧文案（`高·决策` 等） | §10.3 显式清单同步更新，不允许「删测试过绿」 |

## 10. 测试策略（CLAUDE.md：以下 case 必须全绿才算交付）

### 10.1 纯函数层（新文件 `tests/ui-clarity.test.ts`）

1. `categoryInfo`：10 个标准值逐一断言 name + tip 非空；大小写不敏感（`'CONVENTION'`）；首尾空白；未知值兜底（name=原值、tip 含「非标准」）；null/undefined/''/纯空白 → null。
2. `valueClassInfo`：6 筐 name/priority 正确（user-rule/decision priority='高'，其余 null）；tip 非空；null/undefined/未知值 → 未评估。
3. `originBadge`：3 origin 的 label/color **逐字回归**（不得随 tip 新增漂移）+ tip 非空；null/undefined/未知 → null。
4. `scopeInfo`：project/global/null/未知 四路 + tip 非空。
5. `runtimeLabel`：claude-code/opencode/null/未知 四路。
6. `stripCategoryPrefix`：标准前缀剥离 + trim；大小写（`[CATEGORY:x]`）；多次出现全剥；无前缀原样返回；仅前缀 → 返回原标题。
7. `categoryFromTitle`（web 副本）：前缀在 title 中任意位置、大小写、空值、无前缀 → null。

### 10.2 一致性测试（同文件，锁 D7 漂移）

8. 对照 corpus（标准前缀 / 大小写变体 / 前缀在中段 / 无前缀 / 多前缀 / 空串）断言：web `categoryFromTitle` 与 `@/memory/pure` 的 `categoryFromTitle` 逐例相等；且 `categoryFromTitle(stripCategoryPrefix(t)) === null`（对含前缀的 t——剥后不得再提出分类）。

### 10.3 存量测试同步更新清单（禁止删测试过绿）

- `tests/ui-utils.test.ts:165-170`：originBadge `toEqual` 三条更新为含 tip 的新形状（label/color 断言保留）。
- `tests/web-ui.test.ts:25-31`：`高·决策` 锚点移除（旧缩写文案有意废除），保留 `未评估` / `批量拒绝未评估` 锚点，新增 §10.4 锚点。
- `tests/web-ui.test.ts:152-157`：VALUE_LABEL 六筐断言对象从 App.tsx 源码改为 `src/web/ui-utils.ts` 源码（映射搬家；断言语义改为 valueClassInfo 覆盖 user-rule/preference 等 6 键）。

### 10.4 接线回归（源码层文本断言，`tests/web-ui.test.ts` 追加）

9. App.tsx 含筛选栏标题与说明：`筛选` + `每个 tab 的筛选相互独立`。
10. App.tsx 含元信息字段名：`范围:` / `会话工具:` / `源项目:` / `提炼于:`；DiscardCard `拒绝于:`。
11. App.tsx 接线新纯函数：`stripCategoryPrefix(` / `categoryInfo(` / `valueClassInfo(` / `scopeInfo(` / `runtimeLabel(`。
12. 旧缩写退场锁（反向断言）：App.tsx **不含** `高·` 与 `中·`（旧 VALUE_LABEL 拼接格式不得复活）。
13. DiscardCard reason 前缀：`拒绝理由:` 存在于 App.tsx。

运行门槛：`bun run typecheck && bun test` 全绿（只允许用 bun test，禁 npm test）。

## 11. 验收清单

- [ ] 卡片上不再出现裸 `[category:xxx]`、`[slug]`、`高·陷阱` 式缩写、裸 `project · claude-code` 元信息行。
- [ ] 所有徽章/元信息字段带字段名前缀 + 悬停解释。
- [ ] 筛选栏有标题与说明；分类/价值下拉选项中文化。
- [ ] 编辑 title 仍保存含前缀原值；服务端分类筛选不受影响。
- [ ] 注入块（formatMemoryBlock）输出逐字节不变（无相关代码改动，既有测试锁定）。
- [ ] `bun run typecheck && bun test` 全绿。

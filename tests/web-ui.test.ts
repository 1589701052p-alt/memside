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

// 价值徽标 + 批量拒绝未评估。2026-08-11 ui-clarity：旧缩写文案（高·决策 等）
// 有意废除，六筐映射迁 ui-utils valueClassInfo；锚点改锁新接线。
test('App.tsx renders value badge via valueClassInfo + bulk-reject button (source text)', () => {
  expect(src).toContain('valueClassInfo(')
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

// agentic-value-judge 终审修复（2026-08-06 final fix wave）:spec §4.5 透明化要求
// 蒸馏记录详情可回看「它查了哪些词、读了哪些文件、为什么这么判」。此前
// GET /api/distill-runs/:jobId 已返回 rawOutput.agentTrace / judgeFallback,
// 但 DistillRunModal 只渲染 .candidates,两者在 UI 不可见。
// React 组件不单测,源码文本断言锁住渲染锚点,refactor 删除即变红。
test('DistillRunModal renders agentTrace + judgeFallback (source text)', () => {
  const src = readFileSync(join(import.meta.dir, '..', 'src', 'web', 'App.tsx'), 'utf8')
  expect(src).toContain('agentTrace')          // 探查轨迹读取 + 渲染
  expect(src).toContain('agent 探查轨迹')      // 轨迹区块标题
  expect(src).toContain('toolResult')          // 每步工具结果展示
  expect(src).toContain('judgeFallback')       // 降级标记读取 + 渲染
  expect(src).toContain('价值判定降级')        // 降级横幅文案
})

// LLM 凭证 UI 配置（2026-07-30）：设置区块常驻生效回显行 + 保存/测试连接/清除。
// 兜底回归（CLAUDE.md 最低限度）：生效回显行与三按钮必须存在于 App.tsx 源码，
// refactor 删除即变红。
test('App.tsx 含 LLM 设置区块：生效回显行 + 保存/测试连接/清除', () => {
  const src = readFileSync(join(import.meta.dir, '..', 'src', 'web', 'App.tsx'), 'utf8')
  expect(src).toContain('当前生效')
  expect(src).toContain('测试连接')
  expect(src).toContain('getLlmSettings')
  expect(src).toContain('saveLlmSettings')
  expect(src).toContain('testLlmConnection')
})

// 出处驱动的价值判定（2026-07-30）：审批卡片 origin 徽标 + evidence 出处行 +
// VALUE_LABEL 扩 6 筐（user-rule/preference 新增）+ DiscardCard 拒绝理由中文化。
// React 组件不单测，源码文本断言锁住 UI 锚点 + 6 筐映射 + 接线，refactor 删除即变红。
// 设计依据：docs/superpowers/specs/2026-07-30-origin-driven-value-judgment-design.md。
test('App.tsx renders origin badge + evidence 出处 line (source text)', () => {
  const src = readFileSync(join(import.meta.dir, '..', 'src', 'web', 'App.tsx'), 'utf8')
  // evidence 出处行
  expect(src).toContain('出处：')
  // origin 徽标接线（ui-utils 纯函数调用）
  expect(src).toContain('originBadge(')
  // DiscardCard 拒绝理由中文化接线
  expect(src).toContain('discardReasonLabel(')
})

test('ui-utils valueClassInfo covers 6 buckets incl user-rule + preference (source text)', () => {
  // 2026-08-11 ui-clarity：六筐映射从 App.tsx VALUE_LABEL 迁到 ui-utils.ts
  const utils = readFileSync(join(import.meta.dir, '..', 'src', 'web', 'ui-utils.ts'), 'utf8')
  expect(utils).toContain("'user-rule'")
  expect(utils).toContain('preference')
  expect(utils).toContain('valueClassInfo')
})

// opencode 支持：sourceLabel 必须能产出 'opencode' 标签，且 'opencode' 字符串存在于
// App.tsx 源码中。refactor 删除即变红。
// 设计依据：docs/superpowers/specs/2026-07-31-opencode-support-design.md §UI sourceLabel。
test('App.tsx sourceLabel 含 opencode (source text)', () => {
  const src = readFileSync(join(import.meta.dir, '..', 'src', 'web', 'App.tsx'), 'utf8')
  expect(src).toMatch(/opencode/)
})

// 双协议（2026-08-06）：LLM 设置面板必须有协议下拉（Anthropic/OpenAI），
// 且 save/test 透传 protocol。源码文本断言锁锚点，refactor 删除即变红。
test('App.tsx 含双协议下拉 + protocol 透传（source text）', () => {
  const src = readFileSync(join(import.meta.dir, '..', 'src', 'web', 'App.tsx'), 'utf8')
  expect(src).toContain('value="anthropic"')
  expect(src).toContain('value="openai"')
  expect(src).toContain('Anthropic')
  expect(src).toContain('OpenAI')
  expect(src).toContain('protocol')
})

// 生效 API 回显与测试（2026-08-06）：生效行内必须有「测试生效」按钮，api.ts 有
// testEffectiveLlmConnection。源码文本断言锁锚点，refactor 删除即变红。
test('App.tsx 生效行有「测试生效」按钮 + api.ts 有 testEffectiveLlmConnection', () => {
  const app = readFileSync(join(import.meta.dir, '..', 'src', 'web', 'App.tsx'), 'utf8')
  const api = readFileSync(join(import.meta.dir, '..', 'src', 'web', 'api.ts'), 'utf8')
  expect(app).toContain('测试生效')
  expect(app).toContain('testEffectiveLlmConnection')
  expect(api).toContain('testEffectiveLlmConnection')
})

// tab 切换缓存（2026-08-06）：App.tsx 必须走 shouldShowLoading 语义 + 用 memCache，
// 且不得再在切 tab 时清空缓存（setItems([])/setDiscards([])/setRuns([])/setLoading(true)
// 那组复位块是 2s 卡顿根因）。注意：SourceInputModal/DistillRunModal 各自有独立的
// loading 状态（setLoading(true) 合法存在），故只锁「记忆/列表缓存不复位」。
// 源码文本断言锁锚点，回归即变红。
test('App.tsx stale-while-revalidate：用 memCache + shouldShowLoading，不再清空切 tab', () => {
  const src = readFileSync(join(import.meta.dir, '..', 'src', 'web', 'App.tsx'), 'utf8')
  expect(src).toContain('shouldShowLoading')
  expect(src).toContain('memCache')
  expect(src).toContain('memoryTabFilter')
  expect(src).not.toContain('setItems([])')
  expect(src).not.toContain('setDiscards([])')
  expect(src).not.toContain('setRuns([])')
})

// agentic value judge 配置面（2026-08-06 Task 6）：设置区「判定」小节存在且走
// /api/settings/judge，含模式下拉（质量/经济）与两个预算输入；保存失败显错误不静默。
// 源码文本断言锁锚点，refactor 删除即变红。
test('App.tsx 含「判定」设置小节：模式卡片 + 预算输入 + /api/settings/judge', () => {
  const src = readFileSync(join(import.meta.dir, '..', 'src', 'web', 'App.tsx'), 'utf8')
  const api = readFileSync(join(import.meta.dir, '..', 'src', 'web', 'api.ts'), 'utf8')
  expect(src).toContain('判定')
  expect(api).toContain('/api/settings/judge') // URL 在 api.ts wrapper 层
  expect(src).toContain('JudgeSettings')
  expect(src).toContain('fetchJudgeConfig')
  expect(src).toContain('saveJudgeConfig')
  expect(src).toContain('质量模式(默认)')
  expect(src).toContain('经济模式')
  expect(src).toContain('有未保存修改')
  expect(src).toContain('保存失败')
})

// 回归防护(spec 2026-08-07 §3.2):回扫工具栏必须让人看懂——按钮说清干什么、
// 跑动中进度条 + 实时判丢数 + 停止按钮、结束有结果卡片且能跳 discards。
test('App.tsx 候选 tab 回扫:按钮文案 + 说明行 + 进度条 + 停止(source text)', () => {
  const appSrc = readFileSync(join(import.meta.dir, '..', 'src', 'web', 'App.tsx'), 'utf8')
  expect(appSrc).toContain('重新筛查全部候选')
  expect(appSrc).toContain('停止筛查')
  expect(appSrc).toContain('正在停止(当前这批判完即停)')
  expect(appSrc).toContain('把候选队列按当前判定模式全部重判一遍')
  expect(appSrc).toContain('已判丢')
  expect(appSrc).toContain('rescanPercent(')  // 进度条走纯函数
  expect(appSrc).toContain('回扫失败')
  expect(appSrc).toContain('/api/rescan')  // 按钮注释锚定端点
})

test('App.tsx 回扫结果卡片:计数 + 停止标题 + 跳 discards(source text)', () => {
  const appSrc = readFileSync(join(import.meta.dir, '..', 'src', 'web', 'App.tsx'), 'utf8')
  expect(appSrc).toContain('筛查完成')
  expect(appSrc).toContain('条未筛查')
  expect(appSrc).toContain('保留')
  expect(appSrc).toContain('目录已删除的项目')
  expect(appSrc).toContain('查看判丢的')
  expect(appSrc).toContain("setTab('discards')")
})

test('api.ts RescanState 带 discarded/stopping/error 可选字段 + /api/rescan(source text)', () => {
  const apiSrc = readFileSync(join(import.meta.dir, '..', 'src', 'web', 'api.ts'), 'utf8')
  expect(apiSrc).toContain('/api/rescan')
  expect(apiSrc).toContain('discarded?: number')
  expect(apiSrc).toContain('stopping?: boolean')
  expect(apiSrc).toContain('error?: string | null')
})

// 回归防护(spec 2026-08-07 §3.1):判定设置区必须让人看懂——模式卡片带后果说明、
// 预算字段完整中文 label + 「不会误丢」附注、预算段仅质量模式显示、保存行有
// 「有未保存修改」脏提示。源码文本断言,refactor 删除即变红。
test('JudgeSettings 模式卡片 + 人话说明(source text)', () => {
  const s = readFileSync(join(import.meta.dir, '..', 'src', 'web', 'App.tsx'), 'utf8')
  expect(s).toContain('每条候选记忆进审批队列前')
  expect(s).toContain('质量模式(默认)')
  expect(s).toContain('经济模式')
  expect(s).toContain('亲手搜代码、读文件查证后再判决')
  expect(s).toContain('不会误丢有用的')
})

test('JudgeSettings 预算段:完整 label + 附注 + 仅质量模式显示(source text)', () => {
  const s = readFileSync(join(import.meta.dir, '..', 'src', 'web', 'App.tsx'), 'utf8')
  expect(s).toContain('查证次数上限')
  expect(s).toContain('查证时间上限(秒)')
  expect(s).toContain('查满就用已有信息直接判决')
  expect(s).toContain('不会误丢')
  expect(s).toContain("mode === 'quality'")  // 预算段条件渲染
  expect(s).toContain('有未保存修改')
  expect(s).toContain('已保存,立即生效')
})

test('api.ts cancelRescan 走 /api/rescan/cancel + 409 静默(source text)', () => {
  const s = readFileSync(join(import.meta.dir, '..', 'src', 'web', 'api.ts'), 'utf8')
  expect(s).toContain('/api/rescan/cancel')
  expect(s).toContain('export async function cancelRescan')
  expect(s).toContain('res.status === 409')
})

// 五 tab 无限滚动（spec 2026-08-07）：哨兵 + loadMore + 分页缓存结构 +
// 服务端批量拒绝 + 回扫完成缓存重置。refactor 删掉任一锚点即红。
test('App.tsx infinite scroll anchors (source text)', () => {
  expect(src).toContain('IntersectionObserver')
  expect(src).toContain('loadMore')
  expect(src).toContain('nextCursor')
  expect(src).toContain('hasMore')
  expect(src).toContain('加载更多失败')
  expect(src).toContain('没有更多了')
})

test('App.tsx bulk-reject moved to server-side endpoint (source text)', () => {
  expect(src).toContain('bulk-reject-unevaluated')
  expect(src).toContain('unevaluatedCandidates')
})

test('App.tsx resets candidate cache on rescan completion (source text)', () => {
  expect(src).toContain('prevRescanRunning')
  expect(src).toContain('emptyPage')
})

test('App.tsx no legacy full-array memCache (source text)', () => {
  expect(src).not.toContain('Record<MemoryTabKey, MemoryItem[]>')
})

// 回归防护（2026-08-07 实测 bug）：refresh（3s 轮询）必须走 mergeRefreshPage
// 保留已翻深的游标；若回退成「mergePage + 采用页 1 的 nextCursor/hasMore」，
// 轮询每 3s 把翻页进度重置回第一页末尾，loadMore 反复拉重复页被全去重，
// 无限滚动永远卡在第二页（实测现象：只能显示 100 条）。
test('App.tsx refresh keeps deep cursor via mergeRefreshPage (source text)', () => {
  expect(src).toContain('mergeRefreshPage')
  expect(src).not.toContain('nextCursor: pg.nextCursor, hasMore: pg.hasMore } }))\n        setStatus')
})

// 回归防护（2026-08-07 用户反馈）：五 tab 列表头计数必须来自服务端全表计数
// （tabTotalCount / /api/status），不是前端已加载条数——分页后 items.length
// 只是前 N 页，当总数会误导用户（实测「20 条候选记忆待审」实为 538 条）。
// runs 总数走 distillRuns.allTime（total 只是 24h 活动窗口）。
test('App.tsx list headers show server-side totals via tabTotalCount (source text)', () => {
  expect(src).toContain('tabTotalCount')
  expect(src).not.toContain('{memItems.length} 条')
  expect(src).not.toContain('{runs.items.length} 条')
  expect(src).not.toContain('{discards.items.length} 条')
})

// 回归防护（Task 8 评审 Important #1）：哨兵 div 必须渲染在
// `error ? null : showLoading ? null : (` 门控块之外（之前）。哨兵若在门控内，
// 首访 tab 时 pending=true -> showLoading=true -> 哨兵不在 DOM，observer effect
// （依赖 [tab]，只在切 tab 时跑）读到 null 早退，此后不再重跑 -> 无限滚动死锁，
// 直到切走再切回才恢复；transient error 后还会观察已 detach 的旧节点。
// 哨兵无条件渲染无害：Observer 回调走 loadMore，已被 pending/loadingMore/
// nextCursorAfter 三重守卫，加载中相交是安全 no-op。
test('App.tsx sentinel renders outside the error/showLoading gate (source text)', () => {
  const sentinelIdx = src.indexOf('ref={sentinelRef}')
  const gateIdx = src.indexOf('error ? null : showLoading ? null : (')
  expect(sentinelIdx).toBeGreaterThan(-1)
  expect(gateIdx).toBeGreaterThan(-1)
  // 哨兵必须在门控 opener 之前（无条件渲染），否则首访 tab observer 无 DOM 可挂
  expect(sentinelIdx).toBeLessThan(gateIdx)
})

// 设置 tab 统一收拢（spec 2026-08-07 settings-tab）：LLM/判定设置从常驻位置收进
// 独立「设置」tab。回归防护：
// 1. tab 栏有 settings 条目且不显计数徽标；
// 2. LlmSettings/JudgeSettings 恰一处 JSX 挂载（常驻位置已删，只在 settings 分支）；
// 3. 五处列表数据流入口都有 isListTab 短路守卫。
test('App.tsx 设置 tab 存在 + 区块恰一处挂载 + 数据流短路 (source text)', () => {
  const s = readFileSync(join(import.meta.dir, '..', 'src', 'web', 'App.tsx'), 'utf8')
  // tab 条目 + 无计数徽标
  expect(s).toContain("key: 'settings'")
  expect(s).toContain("label: '设置'")
  expect(s).toContain('count: null')
  // 区块只在 settings 分支挂载（常驻位置已移除 => 全文恰一处）
  expect(s).toContain("tab === 'settings'")
  expect((s.match(/<LlmSettings \/>/g) ?? []).length).toBe(1)
  expect((s.match(/<JudgeSettings \/>/g) ?? []).length).toBe(1)
  // 五处入口守卫：refresh / loadMore / observer effect / 轮询 effect / 列表尾部
  expect((s.match(/isListTab\(/g) ?? []).length).toBeGreaterThanOrEqual(5)
})

// 2026-08-11 四维筛选按 tab 圈定（spec per-tab-memory-filters §4.4）：per-tab 独立
// 筛选态 + per-tab facets 缓存 + 收窄缓存作废 + filterRef 防轮换闭包 + 筛选态空态/计数。
// React 组件不单测，源码文本断言锁接线锚点，refactor 删除即变红。
// 注意：web-memory-filters 时代的「四缓存全作废」锚点（setMemCache({candidate:…,
// approved:…, rejected:…})）本轮**有意移除**——per-tab 独立态下其余 tab 缓存对应
// 各自筛选，changeFilter 只作废当前 tab（spec per-tab §4.4-4），不要当回归改回去。
test('App.tsx wires per-tab memory list filters (source text)', () => {
  expect(src).toContain('清除筛选')
  expect(src).toContain('没有符合当前筛选的记录')
  expect(src).toContain('符合当前筛选')
  expect(src).toContain('筛选选项加载失败')
  expect(src).toContain('filterRef')
  expect(src).toContain('hasActiveFilter')
  expect(src).toContain('getFacets')
  expect(src).toContain('projectDisplayName')
  expect(src).toContain('FilterSelect')
  // per-tab 独立筛选态 + per-tab facets 缓存（推翻跨 tab 共享）
  expect(src).toContain('Record<FacetTab, MemoryFilter>')
  expect(src).toContain('facetsByTab')
  expect(src).toContain('isFilterTab')
  // 缓存作废收窄到当前 tab（spec per-tab §4.4-4 / 失败模式 F2）：改筛选只清本 tab，
  // 其余 tab 缓存对应各自筛选不受影响。refactor 改回全量作废或漏清当前 tab 即红。
  expect(src).toContain('setMemCache((c) => ({ ...c, [tab]: emptyPage() }))')
  expect(src).toContain('setDiscards(emptyPage())')
})

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

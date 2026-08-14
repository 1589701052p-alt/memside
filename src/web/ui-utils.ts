/**
 * Web UI 纯函数（可单测，不依赖 React / DOM）。从 App.tsx 抽出，便于在纯函数层
 * 写测试（CLAUDE.md「首选可断言面」）。App.tsx 的 React 组件本身不单测，靠
 * tests/ui-sort-source.test.ts 兜底接线。
 *
 * 设计依据：docs/superpowers/specs/2026-07-27-candidate-time-sort-design.md §3.1。
 */

/**
 * 格式化候选记忆的 createdAt（Unix ms）为本地化时间字符串。
 * - undefined / null / NaN / 非有限数 -> ''（绝不返回 "Invalid Date"）
 * - 合法 -> new Date(ts).toLocaleString()（用户本地时区）
 *
 * 返回 '' 时调用方应跳过渲染，避免空时间碎片。
 */
export function formatMemoryTime(ts: number | undefined | null): string {
  if (ts == null || !Number.isFinite(ts)) return ''
  return new Date(ts).toLocaleString()
}

/**
 * 按 createdAt 倒序排序候选记忆（newest first）。缺值（undefined/null/NaN）排尾。
 * 返回新数组，不 mutate 输入（避免污染 React state）。
 *
 * 完全替换 PR #9 的价值优先级排序；价值徽标仍显示，只是不再决定顺序。
 */
export function sortCandidatesByTime<T extends { createdAt?: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
}

/**
 * 原始输入遮罩层：把一个 transcript turn 映射成 { label, color }，供按 role 分色渲染。
 * user 蓝、assistant 深、thinking 紫（#6a1b9a，spec §4.2）、tool 灰（error 红；带 toolName 时 label 为 tool:<名>，spec §4.3）、其余灰 + 原角色名。纯函数，可单测。
 *
 * 设计依据：docs/superpowers/specs/2026-07-28-source-input-traceability-design.md §7。
 *
 * 参数类型放宽 content?：测试与遮罩层都直接喂 SourceTurn 形状的字面量（含 content），
 * 列出 content? 让对象字面量通过 TS excess-property 检查，函数本身只读 role / isError / toolName。
 */
export function formatSourceTurn(turn: { role: string; content?: string; isError?: boolean; toolName?: string }): { label: string; color: string } {
  if (turn.role === 'user') return { label: 'user', color: '#1565c0' }
  if (turn.role === 'assistant') return { label: 'assistant', color: '#222' }
  if (turn.role === 'thinking') return { label: 'thinking', color: '#6a1b9a' }
  if (turn.role === 'tool') return { label: turn.toolName ? `tool:${turn.toolName}` : 'tool', color: turn.isError ? '#c00' : '#666' }
  return { label: turn.role, color: '#666' }
}

export type DistillOutcome = 'skipped_no_new_turns' | 'empty_output' | 'llm_error' | 'produced' | 'skipped_trivial'

/**
 * 蒸馏记录 outcome -> 徽标 { label, color }。produced 绿 / empty_output 灰 /
 * llm_error 红 / skipped 浅灰 / skipped_trivial 浅灰（琐碎跳过，spec §4.7）。
 * 未知 outcome 兜底原样返回不得空白（spec §5 #10 降级可见化）。
 * 纯函数，可单测（CLAUDE.md「首选可断言面」）。
 *
 * 设计依据：docs/superpowers/specs/2026-07-29-distill-work-record-design.md §7。
 */
export function formatOutcome(outcome: DistillOutcome): { label: string; color: string } {
  if (outcome === 'produced') return { label: '产出', color: '#2e7d32' }
  if (outcome === 'empty_output') return { label: '空产出', color: '#666' }
  if (outcome === 'llm_error') return { label: 'LLM错误', color: '#c00' }
  if (outcome === 'skipped_trivial') return { label: '琐碎跳过', color: '#999' }
  if (outcome === 'skipped_no_new_turns') return { label: '跳过', color: '#999' }
  // 未知 outcome 兜底：不得空白（spec §5 #10）
  return { label: String(outcome), color: '#999' }
}

/** 降级 kind -> 人话（spec §5 枚举；未知 kind 原样返回兜底）。 */
export function degradationKindLabel(kind: string): string {
  const map: Record<string, string> = {
    threshold_compute_error: '阈值计算失败',
    capture_persist_failed: '捕获存储失败',
    flush_mark_failed: 'flush标记失败',
    digest_llm_failed: '滚动摘要失败',
    digest_read_failed: '摘要读取失败',
    titles_query_failed: '已审批查询失败',
    sweep_error: 'sweep异常',
    digest_truncated: '摘要压缩超限',
  }
  return map[kind] ?? kind
}

/**
 * 计数链 distilled->deduped->filtered->stored 渲染为「N->M->K->J」。
 * 直观显示候选在哪一步被杀光。accepted_count（格式校验后）不在链中，由遮罩层
 * hint 用 rawCount vs acceptedCount 体现。纯函数，可单测。
 */
export function formatRunCounts(c: { distilled: number; deduped: number; filtered: number; stored: number }): string {
  return `${c.distilled}->${c.deduped}->${c.filtered}->${c.stored}`
}

/** LLM 凭证来源标签（生效回显行用）。null = 凭证链无可用凭证。 */
export function llmSourceLabel(source: string | null): string {
  if (source === null) return '未配置'
  if (source === 'ui') return 'UI 配置'
  if (source.startsWith('settings.json')) return 'settings.json'
  if (source.startsWith('env')) return '进程 env'
  if (source.startsWith('credentials.json')) return 'credentials.json'
  return source
}

/**
 * 出处徽标（审批卡片用）。null/undefined（老行未标注）不显示。纯函数，可单测。
 *
 * user-stated 紫（用户主动陈述，最高可信）/ user-confirmed 青（用户采纳 agent 建议）/
 * agent-observed 灰（agent 自行观察，需审慎审批）。老行无 origin 字段返回 null。
 *
 * 设计依据：docs/superpowers/specs/2026-07-30-origin-driven-value-judgment-design.md。
 * tip 文案权威表见 spec 2026-08-11-ui-clarity §4.3。
 */
export function originBadge(origin: string | null | undefined): { label: string; color: string; tip: string } | null {
  if (origin === 'user-stated') return { label: '用户陈述', color: '#6a1b9a', tip: '用户在会话里亲口说的，可信度最高' }
  if (origin === 'user-confirmed') return { label: '用户采纳', color: '#00838f', tip: 'agent 提议、被用户采纳的' }
  if (origin === 'agent-observed') return { label: 'agent 观察', color: '#999', tip: 'agent 自己观察总结的，审批时多留个心眼' }
  return null
}

/**
 * AI 自动拒绝理由中文化（DiscardCard 用）。未知 reason 原样显示（向后兼容老数据）。
 * 四理由对应 spec 的 fleeting 价值判定：公开知识 / 可从代码推导 / 驯化指令 / 一次性·琐事。
 * 纯函数，可单测。
 *
 * 设计依据：docs/superpowers/specs/2026-07-30-origin-driven-value-judgment-design.md。
 */
export function discardReasonLabel(reason: string): string {
  const m: Record<string, string> = {
    'public-knowledge': '公开知识',
    derivable: '可从代码推导',
    taming: '驯化指令',
    fleeting: '一次性/琐事',
    'exact-duplicate': '逐字重复',
    duplicate: '与已有记忆重复',
  }
  return m[reason] ?? reason
}

/**
 * 把 tool_use 的 input 字符串格式化为 Web 渲染用的「调用: ...」文本。
 * call 为 truthy 非空串时返回 `调用: ${call}`，否则返回 null（调用方据此跳过渲染）。
 *
 * 注意：不在 Web 层再做 slice(0,300) 截断--toolCall 在捕获时已截 TOOL_INPUT_CAP_CHARS
 * 字 + 后缀（见 captureToolCall），Web 再 slice 会丢后缀。纯函数，可单测
 * （CLAUDE.md「首选可断言面」）。
 */
export function formatToolCall(call?: string): string | null {
  if (!call) return null
  return `调用: ${call}`
}

/**
 * 回扫进度条百分比(0-100,整数)。total<=0 -> 0(未开始/空队列不显示 NaN);
 * 上限夹取 100(回调乱序不得撑破进度条)。纯函数,可单测。
 *
 * 设计依据:docs/superpowers/specs/2026-08-07-judge-rescan-ux-design.md §3.2。
 */
export function rescanPercent(done: number, total: number): number {
  if (total <= 0) return 0
  return Math.min(100, Math.round((done / total) * 100))
}

/**
 * 项目下拉显示名：取路径末段（同时切 \ 与 /，去空段）；末段在同批值里撞名时
 * 升级为「父段/末段」；取不到段 -> 原值兜底。永不抛。
 * spec 2026-08-11-web-memory-filters §4.3。
 */
export function projectDisplayName(value: string, allValues: string[]): string {
  const segs = (v: string) => v.split(/[\\/]+/).filter(Boolean)
  const last = (v: string): string => {
    const s = segs(v)
    return s.length > 0 ? s[s.length - 1]! : v
  }
  const base = last(value)
  if (base === '') return value
  const collide = allValues.some((o) => o !== value && last(o) === base)
  if (!collide) return base
  const s = segs(value)
  if (s.length >= 2) return `${s[s.length - 2]}/${base}`
  return value
}

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

/** runtime 悬停解释（按值措辞，spec §4.5）。未知值兜底通用文案。never-throw。 */
export function runtimeTip(runtime: string | null | undefined): string {
  if (runtime === 'claude-code') return '产生这条记忆的会话来自 Claude Code'
  if (runtime === 'opencode') return '产生这条记忆的会话来自 opencode'
  if (runtime == null) return '未限定来源工具（老数据）'
  return '产生这条记忆的会话所用的运行时工具'
}

/** 主题 slug 徽章固定 tip（spec §4.4）。 */
export const SLUG_BADGE_TIP = '主题分组标识。同主题的记忆共用一个 slug，注入新会话时合并为一节；可在编辑里修改。'

/** LLM 阶段 -> 中文列名（spec 2026-08-12 §5.11）。digest（账本压缩）归「蒸馏」列。 */
export function phaseLabel(phase: string): string {
  if (phase === 'distill' || phase === 'digest') return '蒸馏'
  if (phase === 'dedup') return '去重'
  if (phase === 'judge') return '审查'
  return phase
}

/** 耗时人话：<60s 显秒；<60分 显整分；>=1小时 显「N小时M分」。负值归 0。 */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}秒`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}分`
  return `${Math.floor(m / 60)}小时${m % 60}分`
}

/** 24h 统计单元格：「19次·8分」；0 次省略耗时。 */
export function formatPhaseStat(count: number, ms: number): string {
  if (count <= 0) return '0次'
  return `${count}次·${formatElapsed(ms)}`
}

/** 消息标题人话（spec §5.11）：degradation 复用降级 kind 映射；llm_error 固定文案。 */
export function notificationTitle(n: { kind: string; title: string }): string {
  if (n.kind === 'llm_error') return '蒸馏 LLM 报错'
  if (n.kind === 'degradation') return degradationKindLabel(n.title)
  return n.title
}

/**
 * 状态栏警示条「最近：<body>」文案截断（spec 2026-08-14 §3.5）。
 * - null（无未读 LLM 报错的详情）-> '（无详情）'
 * - 长度 <= max -> 原样返回
 * - 超长 -> 截到 max 字 + '…'
 * 纯函数，可单测。
 */
export function truncateAlertBody(body: string | null, max = 40): string {
  if (body === null) return '（无详情）'
  if (body.length <= max) return body
  return body.slice(0, max) + '…'
}

import { test, expect, describe } from 'bun:test'
import { formatMemoryTime, sortCandidatesByTime, formatSourceTurn, formatOutcome, formatRunCounts, llmSourceLabel, originBadge, discardReasonLabel, rescanPercent, formatToolCall, projectDisplayName, phaseLabel, formatElapsed, formatPhaseStat, notificationTitle } from '@/web/ui-utils'

// 纯函数层测试（CLAUDE.md「首选可断言面」）：覆盖 App.tsx 抽出的时间格式化 +
// 候选倒序排序。React 组件本身不单测，接线兜底见 tests/ui-sort-source.test.ts。
// 设计依据：docs/superpowers/specs/2026-07-27-candidate-time-sort-design.md §7。

type Item = { id: string; createdAt?: number }

// --- formatMemoryTime ---

test('formatMemoryTime: 合法 ts 返回非空本地化字符串，含 4 位年', () => {
  const ts = new Date('2026-07-27T14:32:00').getTime()
  const s = formatMemoryTime(ts)
  expect(s).not.toBe('')
  expect(s).toMatch(/\d{4}/) // 含年份成分（跨 locale 稳健）
})

test('formatMemoryTime: undefined / null -> ""', () => {
  expect(formatMemoryTime(undefined)).toBe('')
  expect(formatMemoryTime(null)).toBe('')
})

test('formatMemoryTime: NaN / Infinity / -Infinity -> ""（绝不返回 Invalid Date）', () => {
  expect(formatMemoryTime(NaN)).toBe('')
  expect(formatMemoryTime(Infinity)).toBe('')
  expect(formatMemoryTime(-Infinity)).toBe('')
})

// --- sortCandidatesByTime ---

test('sortCandidatesByTime: 按 createdAt 倒序（newest first）', () => {
  const items: Item[] = [
    { id: 'a', createdAt: 1000 },
    { id: 'b', createdAt: 3000 },
    { id: 'c', createdAt: 2000 },
  ]
  const sorted = sortCandidatesByTime(items)
  expect(sorted.map((i) => i.id)).toEqual(['b', 'c', 'a'])
})

test('sortCandidatesByTime: 缺值条目排尾', () => {
  const items: Item[] = [
    { id: 'old', createdAt: 1000 },
    { id: 'missing', createdAt: undefined },
    { id: 'new', createdAt: 3000 },
  ]
  const sorted = sortCandidatesByTime(items)
  expect(sorted.map((i) => i.id)).toEqual(['new', 'old', 'missing'])
})

test('sortCandidatesByTime: 全缺值不抛错、返回等长数组', () => {
  const items: Item[] = [{ id: 'a' }, { id: 'b' }]
  const sorted = sortCandidatesByTime(items)
  expect(sorted).toHaveLength(2)
})

test('sortCandidatesByTime: 不 mutate 输入数组', () => {
  const items: Item[] = [
    { id: 'a', createdAt: 1000 },
    { id: 'b', createdAt: 3000 },
  ]
  const snapshot = items.map((i) => i.id)
  sortCandidatesByTime(items)
  expect(items.map((i) => i.id)).toEqual(snapshot)
})

test('sortCandidatesByTime: 负数 ts 按数值大小参与排序', () => {
  const items: Item[] = [
    { id: 'a', createdAt: -100 },
    { id: 'b', createdAt: -300 },
    { id: 'c', createdAt: 100 },
  ]
  const sorted = sortCandidatesByTime(items)
  expect(sorted.map((i) => i.id)).toEqual(['c', 'a', 'b'])
})

// --- formatSourceTurn ---
// 原始输入遮罩层按 role 分色渲染的纯映射。CLAUDE.md「首选可断言面」：抽纯函数层测，
// React 组件不单测，靠 tests/web-ui.test.ts 源码文本兜底。

test('formatSourceTurn: user -> 蓝色标签', () => {
  const r = formatSourceTurn({ role: 'user', content: 'x' })
  expect(r.label).toBe('user')
  expect(r.color).toBe('#1565c0')
})

test('formatSourceTurn: assistant -> 深色标签', () => {
  const r = formatSourceTurn({ role: 'assistant', content: 'x' })
  expect(r.label).toBe('assistant')
  expect(r.color).toBe('#222')
})

test('formatSourceTurn: tool (non-error) -> 灰色标签', () => {
  const r = formatSourceTurn({ role: 'tool', content: 'x' })
  expect(r.label).toBe('tool')
  expect(r.color).toBe('#666')
})

test('formatSourceTurn: tool error -> 红色标签', () => {
  const r = formatSourceTurn({ role: 'tool', content: 'boom', isError: true })
  expect(r.label).toBe('tool')
  expect(r.color).toBe('#c00')
})

test('formatSourceTurn: unknown role -> 灰色 + 原角色名', () => {
  const r = formatSourceTurn({ role: 'system', content: 'x' })
  expect(r.label).toBe('system')
  expect(r.color).toBe('#666')
})

test('formatSourceTurn: thinking -> 紫色标签（spec §4.2）', () => {
  const r = formatSourceTurn({ role: 'thinking', content: 'x' })
  expect(r).toEqual({ label: 'thinking', color: '#6a1b9a' })
})

test('formatSourceTurn: tool 带 toolName -> tool:Read 标签（spec §4.3）', () => {
  const r = formatSourceTurn({ role: 'tool', content: 'x', toolName: 'Read' })
  expect(r).toEqual({ label: 'tool:Read', color: '#666' })
})

test('formatSourceTurn: tool 带 toolName 且 error -> tool:Bash 红色标签', () => {
  const r = formatSourceTurn({ role: 'tool', content: 'x', toolName: 'Bash', isError: true })
  expect(r).toEqual({ label: 'tool:Bash', color: '#c00' })
})

// --- formatOutcome ---
// 蒸馏记录 outcome 四态 -> 徽标 { label, color }。CLAUDE.md「首选可断言面」。
// 设计依据：docs/superpowers/specs/2026-07-29-distill-work-record-design.md §7。

test('formatOutcome maps four outcomes to label + color', () => {
  expect(formatOutcome('produced').color).toBe('#2e7d32')
  expect(formatOutcome('empty_output').color).toBe('#666')
  expect(formatOutcome('llm_error').color).toBe('#c00')
  expect(formatOutcome('skipped_no_new_turns').color).toBe('#999')
  expect(formatOutcome('produced').label).toBe('产出')
})

// --- formatRunCounts ---
// 计数链 distilled->deduped->filtered->stored 渲染为「N->M->K->J」。
// 纯函数，可单测。

test('formatRunCounts renders distilled->deduped->filtered->stored chain', () => {
  expect(formatRunCounts({ distilled: 5, deduped: 3, filtered: 1, stored: 1 })).toBe('5->3->1->1')
  expect(formatRunCounts({ distilled: 0, deduped: 0, filtered: 0, stored: 0 })).toBe('0->0->0->0')
})

// --- llmSourceLabel ---
// LLM 设置区块生效回显行的来源标签映射。纯函数，可单测（CLAUDE.md「首选可断言面」）。
test('llmSourceLabel 映射各来源', () => {
  expect(llmSourceLabel('ui')).toBe('UI 配置')
  expect(llmSourceLabel('settings.json:authToken')).toBe('settings.json')
  expect(llmSourceLabel('settings.json:apiKey')).toBe('settings.json')
  expect(llmSourceLabel('env:authToken')).toBe('进程 env')
  expect(llmSourceLabel('credentials.json:apiKey')).toBe('credentials.json')
  expect(llmSourceLabel(null)).toBe('未配置')
})

// --- originBadge / discardReasonLabel ---
// 出处驱动的价值判定（2026-07-30）：审批卡片 origin 徽标（user-stated/user-confirmed/
// agent-observed 三态 -> {label,color}，老行未标注返回 null 不显示）+ AI 自动拒绝理由
// 中文化。纯函数，可单测（CLAUDE.md「首选可断言面」）。
// 设计依据：docs/superpowers/specs/2026-07-30-origin-driven-value-judgment-design.md。

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

test('discardReasonLabel: 四理由中文化 + 未知原样', () => {
  expect(discardReasonLabel('public-knowledge')).toBe('公开知识')
  expect(discardReasonLabel('derivable')).toBe('可从代码推导')
  expect(discardReasonLabel('taming')).toBe('驯化指令')
  expect(discardReasonLabel('fleeting')).toBe('一次性/琐事')
  expect(discardReasonLabel('bogus')).toBe('bogus')
})

// 回扫进度条百分比(spec 2026-08-07 §3.2):total=0 -> 0;上限夹取 100。
test('rescanPercent: 百分比计算与夹取', () => {
  expect(rescanPercent(0, 0)).toBe(0)
  expect(rescanPercent(0, 734)).toBe(0)
  expect(rescanPercent(367, 734)).toBe(50)
  expect(rescanPercent(734, 734)).toBe(100)
  expect(rescanPercent(800, 734)).toBe(100)  // 夹取:不得超过 100
})

// --- formatToolCall ---
// toolCall Web 渲染纯函数（spec §4.2/§4.3）。call 为 truthy 非空串 -> `调用: ${call}`；
// 否则 null（调用方据此跳过渲染）。不在 Web 层再 slice(0,300)--捕获时已截断 + 后缀。
test('formatToolCall: 非空串 -> 调用: ${call}', () => {
  expect(formatToolCall('{"command":"bun test"}')).toBe('调用: {"command":"bun test"}')
})

test('formatToolCall: undefined -> null', () => {
  expect(formatToolCall(undefined)).toBeNull()
})

test('formatToolCall: 空串 -> null', () => {
  expect(formatToolCall('')).toBeNull()
})

// --- projectDisplayName（spec 2026-08-11-web-memory-filters §4.3）---

test('projectDisplayName: 取路径末段（正反斜杠 / 尾分隔符）', () => {
  expect(projectDisplayName('C:\\Users\\admin\\Desktop\\memside', ['C:\\Users\\admin\\Desktop\\memside'])).toBe('memside')
  expect(projectDisplayName('/home/u/proj/', ['/home/u/proj/'])).toBe('proj')
})

test('projectDisplayName: 末段撞名升级 父/子', () => {
  const all = ['C:\\a\\app', 'C:\\b\\app']
  expect(projectDisplayName('C:\\a\\app', all)).toBe('a/app')
  expect(projectDisplayName('C:\\b\\app', all)).toBe('b/app')
})

test('projectDisplayName: 无父段 / 空输入回退原值，永不抛', () => {
  expect(projectDisplayName('solo', ['solo', 'x/solo'])).toBe('solo')
  expect(projectDisplayName('', [''])).toBe('')
})

describe('LLM 实况与消息文案（spec 2026-08-12 §5.11）', () => {
  test('phaseLabel：digest 归蒸馏；未知原样兜底', () => {
    expect(phaseLabel('distill')).toBe('蒸馏')
    expect(phaseLabel('digest')).toBe('蒸馏')
    expect(phaseLabel('dedup')).toBe('去重')
    expect(phaseLabel('judge')).toBe('审查')
    expect(phaseLabel('weird')).toBe('weird')
  })

  test('formatElapsed 边界：59s/60s/59分/60分', () => {
    expect(formatElapsed(59_000)).toBe('59秒')
    expect(formatElapsed(60_000)).toBe('1分')
    expect(formatElapsed(3_599_000)).toBe('59分')
    expect(formatElapsed(3_600_000)).toBe('1小时0分')
    expect(formatElapsed(-5)).toBe('0秒')
  })

  test('formatPhaseStat：0 次不带耗时；正常「N次·X」', () => {
    expect(formatPhaseStat(0, 123456)).toBe('0次')
    expect(formatPhaseStat(19, 8 * 60_000)).toBe('19次·8分')
    expect(formatPhaseStat(2, 45_000)).toBe('2次·45秒')
  })

  test('notificationTitle：降级走 degradationKindLabel；llm_error 固定文案；未知兜底', () => {
    expect(notificationTitle({ kind: 'degradation', title: 'digest_truncated' })).toBe('摘要压缩超限')
    expect(notificationTitle({ kind: 'degradation', title: 'unknown_kind' })).toBe('unknown_kind')
    expect(notificationTitle({ kind: 'llm_error', title: 'llm_error' })).toBe('蒸馏 LLM 报错')
  })
})

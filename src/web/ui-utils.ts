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
 * user 蓝、assistant 深、tool 灰（error 红）、其余灰 + 原角色名。纯函数，可单测。
 *
 * 设计依据：docs/superpowers/specs/2026-07-28-source-input-traceability-design.md §7。
 *
 * 参数类型放宽 content?：测试与遮罩层都直接喂 SourceTurn 形状的字面量（含 content），
 * 列出 content? 让对象字面量通过 TS excess-property 检查，函数本身只读 role / isError。
 */
export function formatSourceTurn(turn: { role: string; content?: string; isError?: boolean }): { label: string; color: string } {
  if (turn.role === 'user') return { label: 'user', color: '#1565c0' }
  if (turn.role === 'assistant') return { label: 'assistant', color: '#222' }
  if (turn.role === 'tool') return { label: 'tool', color: turn.isError ? '#c00' : '#666' }
  return { label: turn.role, color: '#666' }
}

export type DistillOutcome = 'skipped_no_new_turns' | 'empty_output' | 'llm_error' | 'produced'

/**
 * 蒸馏记录 outcome 四态 -> 徽标 { label, color }。produced 绿 / empty_output 灰 /
 * llm_error 红 / skipped 浅灰。纯函数，可单测（CLAUDE.md「首选可断言面」）。
 *
 * 设计依据：docs/superpowers/specs/2026-07-29-distill-work-record-design.md §7。
 */
export function formatOutcome(outcome: DistillOutcome): { label: string; color: string } {
  if (outcome === 'produced') return { label: '产出', color: '#2e7d32' }
  if (outcome === 'empty_output') return { label: '空产出', color: '#666' }
  if (outcome === 'llm_error') return { label: 'LLM错误', color: '#c00' }
  return { label: '跳过', color: '#999' }
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
 */
export function originBadge(origin: string | null | undefined): { label: string; color: string } | null {
  if (origin === 'user-stated') return { label: '用户陈述', color: '#6a1b9a' }
  if (origin === 'user-confirmed') return { label: '用户采纳', color: '#00838f' }
  if (origin === 'agent-observed') return { label: 'agent 观察', color: '#999' }
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

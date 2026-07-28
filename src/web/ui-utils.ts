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

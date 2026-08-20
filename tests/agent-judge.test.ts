// 回归防护:agent 判定器=质量模式终审。锁:duplicate 第 10 类映射、
// stated 免疫(derivable 改判)与 duplicate 不免疫、LLM 故障返回 failed 标识、永不抛。
// spec: docs/superpowers/specs/2026-08-06-agentic-value-judge-design.md §4.5
// Task 6（2026-08-18 §缺陷2/§8.4）：失败不再 keepAll 全保留冒充成功，返回 failed 标识。
import { test, expect } from 'bun:test'
import { judgeValueAgentic } from '@/memory/agentJudge'
import { DEFAULT_JUDGE_CONFIG } from '@/memory/judgeConfig'
import type { DistillCandidate } from '@/memory/distiller'

const cand = (title: string, origin: DistillCandidate['origin'] = 'agent-observed'): DistillCandidate => ({
  title, bodyMd: 'b', scopeType: 'project', runtime: 'claude-code',
  distillAction: 'new', origin, evidence: null, subjectSlug: null,
})
const base = {
  rootDir: null as string | null,  // 无仓库路径 -> 无工具循环也能判(工具全部返回错误文本)
  approvedTitles: [] as string[],
  sourceKind: 'conversation' as const,
  maxRounds: 5, timeBudgetMs: 60_000,
}

test('final verdicts 正常映射:retain 留 + duplicate 丢', async () => {
  const callLLM = async () => '{"final": {"verdicts": [{"index": 0, "category": "trap"}, {"index": 1, "category": "duplicate"}]}}'
  const r = await judgeValueAgentic([cand('A'), cand('B')], { ...base, callLLM })
  expect('failed' in r).toBe(false)
  const { verdicts } = r as Exclude<typeof r, { failed: true }>
  expect(verdicts[0]).toEqual({ index: 0, keep: true, valueClass: 'trap' })
  expect(verdicts[1]).toEqual({ index: 1, keep: false, reason: 'duplicate' })
})

test('stated 免疫:用户陈述被判 derivable 改判 keep+decision;被判 duplicate 不免疫', async () => {
  const callLLM = async () => '{"final": {"verdicts": [{"index": 0, "category": "derivable"}, {"index": 1, "category": "duplicate"}]}}'
  const r = await judgeValueAgentic(
    [cand('用户说的规则', 'user-stated'), cand('用户复述已审批规则', 'user-stated')], { ...base, callLLM })
  expect('failed' in r).toBe(false)
  const { verdicts } = r as Exclude<typeof r, { failed: true }>
  expect(verdicts[0]).toEqual({ index: 0, keep: true, valueClass: 'decision' })
  expect(verdicts[1]).toEqual({ index: 1, keep: false, reason: 'duplicate' })
})

test('LLM 全程报错:返回 failed 标识（不再 keepAll 全保留冒充成功）', async () => {
  // Task 6：旧 keepAll 全保留（stated->decision, observed->null）会冒充成功；新行为
  // 返回 failed 标识让 scheduler 暂停。
  const callLLM = async () => { throw new Error('HTTP 502') }
  const r = await judgeValueAgentic(
    [cand('X', 'user-stated'), cand('Y', 'agent-observed')], { ...base, callLLM })
  expect('failed' in r).toBe(true)
  expect((r as { failed: true; reasons: string[] }).failed).toBe(true)
  expect((r as { failed: true; reasons: string[] }).reasons.length).toBeGreaterThan(0)
})

test('DEFAULT_JUDGE_CONFIG: 质量模式默认 + 预算 30 轮/300 秒', () => {
  expect(DEFAULT_JUDGE_CONFIG).toEqual({ mode: 'quality', maxRounds: 30, timeBudgetS: 300 })
})

// Task 4（2026-08-20 spec §3.2）：judge 失败时 reasons 优先取 agentLoop trace 末条
// 真实原因（Task 3 透出的 aborted:/llm-error:），trace 为空才回退 stopReason 文案。
// 旧实现固定 `agent loop ended without final: llm-error`，掩盖了真实 abort/error。
test('agentLoop 失败: reasons 透出真实原因（aborted:），不再固定 llm-error', async () => {
  // callLLM 抛 AbortError -> agentLoop trace 末条含 aborted: -> reasons 含 aborted:
  const callLLM = async () => {
    const e = new Error('The operation was aborted')
    e.name = 'AbortError'
    throw e
  }
  const r = await judgeValueAgentic(
    [cand('[category:x] t')], { ...base, callLLM })
  expect('failed' in r).toBe(true)
  if ('failed' in r) {
    const joined = r.reasons.join(' | ')
    expect(joined).toContain('aborted:')
  }
})

test('agentLoop 预算耗尽无 trace 真实原因时: reasons 回退带 stopReason', async () => {
  // maxRounds=1 + 永远要工具 -> rounds-budget，trace 末条是 correction（工具请求），
  // 非 catch 路径 -> reasons 取 trace 末条原文（保留旧兜底语义：reasons 非空）。
  const callLLM = async () => '{"tool": "grep", "args": {"pattern": "x"}}'
  const r = await judgeValueAgentic(
    [cand('[category:x] t')], { ...base, callLLM, maxRounds: 1 })
  expect('failed' in r).toBe(true)
  if ('failed' in r) {
    expect(r.reasons.length).toBeGreaterThan(0)
  }
})

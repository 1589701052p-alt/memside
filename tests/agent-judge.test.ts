// 回归防护:agent 判定器=质量模式终审。锁:duplicate 第 10 类映射、
// stated 免疫(derivable 改判)与 duplicate 不免疫、LLM 故障全保留兜底、永不抛。
// spec: docs/superpowers/specs/2026-08-06-agentic-value-judge-design.md §4.5
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
  const { verdicts } = await judgeValueAgentic([cand('A'), cand('B')], { ...base, callLLM })
  expect(verdicts[0]).toEqual({ index: 0, keep: true, valueClass: 'trap' })
  expect(verdicts[1]).toEqual({ index: 1, keep: false, reason: 'duplicate' })
})

test('stated 免疫:用户陈述被判 derivable 改判 keep+decision;被判 duplicate 不免疫', async () => {
  const callLLM = async () => '{"final": {"verdicts": [{"index": 0, "category": "derivable"}, {"index": 1, "category": "duplicate"}]}}'
  const { verdicts } = await judgeValueAgentic(
    [cand('用户说的规则', 'user-stated'), cand('用户复述已审批规则', 'user-stated')], { ...base, callLLM })
  expect(verdicts[0]).toEqual({ index: 0, keep: true, valueClass: 'decision' })
  expect(verdicts[1]).toEqual({ index: 1, keep: false, reason: 'duplicate' })
})

test('LLM 全程报错:全保留兜底(stated->decision, observed->null),不抛', async () => {
  const callLLM = async () => { throw new Error('HTTP 502') }
  const { verdicts, trace } = await judgeValueAgentic(
    [cand('X', 'user-stated'), cand('Y', 'agent-observed')], { ...base, callLLM })
  expect(verdicts).toEqual([
    { index: 0, keep: true, valueClass: 'decision' },
    { index: 1, keep: true, valueClass: null },
  ])
  expect(trace.length).toBeGreaterThan(0)
})

test('DEFAULT_JUDGE_CONFIG: 质量模式默认 + 预算 30 轮/300 秒', () => {
  expect(DEFAULT_JUDGE_CONFIG).toEqual({ mode: 'quality', maxRounds: 30, timeBudgetS: 300 })
})

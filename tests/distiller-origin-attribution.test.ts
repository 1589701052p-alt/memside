import { test, expect } from 'bun:test'
import { distillTranscript, DISTILLER_SYSTEM_PROMPT } from '@/memory/distiller'

/**
 * Origin 归因三层防线（spec 2026-08-20 §3.5/§3.6）。
 * 事故背景：/loop 会话里 loop 框架把 prompt 机械重放成 user 行（promptSource=system），
 * 捕获层旧代码映 role:"user"，蒸馏器误标 origin=user-stated，valueFilter 双重保护
 * （derivable 免疫 + decision 兜底）把 skill 派生/会话物流候选永久锁死删不掉。
 * 修复：捕获层重标 system（Task 3）+ prompt 硬规则（本任务）+ 无真人行兜底（本任务）。
 */

test('prompt 硬规则：[user] 锚定 user-stated / [system] 至多 agent-observed（文本锁）', () => {
  expect(DISTILLER_SYSTEM_PROMPT).toContain('[user]')
  expect(DISTILLER_SYSTEM_PROMPT).toContain('[system]')
  expect(DISTILLER_SYSTEM_PROMPT).toContain('只能锚定在')
  expect(DISTILLER_SYSTEM_PROMPT).toContain('BEGIN INJECTED MEMORY')
  expect(DISTILLER_SYSTEM_PROMPT).toContain('重复提炼')
})

test('纯 loop 会话（turns 全 system）：LLM 标 user-stated → 强制降级 agent-observed', async () => {
  const fakeResponse = {
    candidates: [
      {
        title: '[category:process] 子代理任务报告的处理分支：DONE/DONE_WITH_CONCERNS/NEEDS_CONTEXT/BLOCKED',
        bodyMd: '按 report 状态分支处理。',
        scope: 'project', runtime: null, distillAction: 'new',
        origin: 'user-stated',
        evidence: '按 report 状态分支处理 Task 1 结果',
      },
    ],
  }
  let seenPrompt = ''
  const result = await distillTranscript({
    turns: [
      { role: 'system', content: '检查 Task 5 implementer (a11a0f3be1ceeb11c) 是否完成。若完成则处理 report（DONE→生成 review package 派 task reviewer）' },
      { role: 'assistant', content: '唤醒已触发。正在检查 Task 5。' },
    ],
    runtime: 'claude-code', cwd: '/repo', existingSlugs: [],
    callLLM: async (_sys: string, user: string) => { seenPrompt = user; return JSON.stringify(fakeResponse) },
  })
  // 兜底：无真人行 → 强制 agent-observed（LLM 标注被推翻）
  expect(result.candidates.length).toBe(1)
  expect(result.candidates[0]!.origin).toBe('agent-observed')
  // prompt 标签：system 行以 [system] 抵达（供 prompt 硬规则约束 LLM）
  expect(seenPrompt).toContain('[system] 检查 Task 5')
})

test('有真人行：origin 保留 LLM 标注（贴金防护不变）', async () => {
  const fakeResponse = {
    candidates: [
      {
        title: '[category:convention] 测试一律 bun test',
        bodyMd: '本仓库测试一律用 bun test 运行。',
        scope: 'project', runtime: null, distillAction: 'new',
        origin: 'user-stated',
        evidence: '测试一律用 bun test 运行',
      },
    ],
  }
  const result = await distillTranscript({
    turns: [
      { role: 'user', content: '测试一律用 bun test 运行' },
      { role: 'assistant', content: '明白。' },
    ],
    runtime: 'claude-code', cwd: '/repo', existingSlugs: [],
    callLLM: async () => JSON.stringify(fakeResponse),
  })
  expect(result.candidates[0]!.origin).toBe('user-stated')
})

test('真人行 + 纯 tool 会话判 hasHumanUserTurn 以原始 turns 为准（过滤前）', async () => {
  // 一条 user（真人）+ 大量 tool turns：兜底不该触发（真人发过言）
  const fakeResponse = {
    candidates: [{
      title: '[category:invariant] x', bodyMd: 'y', scope: 'project',
      runtime: null, distillAction: 'new', origin: 'user-stated', evidence: 'x',
    }],
  }
  const turns = [
    { role: 'user' as const, content: 'run the tests please' },
    ...Array.from({ length: 5 }, () => ({ role: 'tool' as const, content: 'ok output', isError: false })),
  ]
  const result = await distillTranscript({
    turns, runtime: 'claude-code', cwd: '/repo', existingSlugs: [],
    callLLM: async () => JSON.stringify(fakeResponse),
  })
  expect(result.candidates[0]!.origin).toBe('user-stated')
})

test('subagent 降级与无真人行兜底叠加：均为 agent-observed，互不干扰', async () => {
  const fakeResponse = {
    candidates: [{
      title: '[category:process] x', bodyMd: 'y', scope: 'project',
      runtime: null, distillAction: 'new', origin: 'user-confirmed', evidence: 'x',
    }],
  }
  const result = await distillTranscript({
    turns: [{ role: 'user', content: 'task brief from main agent' }],  // subagent brief（有 user 行但非真人）
    runtime: 'claude-code', cwd: '/repo', existingSlugs: [],
    sourceKind: 'subagent',
    callLLM: async () => JSON.stringify(fakeResponse),
  })
  expect(result.candidates[0]!.origin).toBe('agent-observed')
})

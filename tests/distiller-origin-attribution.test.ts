import { test, expect, afterEach } from 'bun:test'
import { distillTranscript, DISTILLER_SYSTEM_PROMPT } from '@/memory/distiller'
import { parseTranscriptFile } from '@/claude/transcript'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

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

// ---------------------------------------------------------------------------
// 事故复现回归锁（spec 2026-08-20 §1）：复刻 distill job 01M0EKC0AGBAENJQ8KWS3E4PDQ
// 的输入形状——/loop 会话，真人早已离场，turns 全是 loop 重放（promptSource=system）
// 与 assistant/tool 轮转。全链路：JSONL 文件 → parseTranscriptFile → distillTranscript，
// 断言捕获层重标 system + 蒸馏器兜底降级 origin，双重防线同时生效。
// ---------------------------------------------------------------------------

// M5 终审 fix：e2e 用例用的临时目录路径固定，提到模块级让 afterEach 兜底清理。
// 原代码只在用例开头 + 结尾 rmSync，断言失败时中途抛错会残留目录。开头的 rmSync
// 保留作「前置干净」兜底，afterEach 保证无论用例成功失败都清干净。
const originE2eDir = join(import.meta.dir, '.tmp-origin-e2e')

afterEach(() => {
  rmSync(originE2eDir, { recursive: true, force: true })
})

test('e2e 事故复现：/loop 会话 transcript → 捕获层 system + origin 强制降级', async () => {
  const dir = originE2eDir
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const p = join(dir, 'loop-session.jsonl')
  // 复刻实测 transcript 行形状（去掉长字段，保留来源字段与内容）
  const rows = [
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '正在等待 Task 5。' }] } },
    { type: 'user', promptSource: 'system', isMeta: true, message: { role: 'user', content: '检查 Task 5 implementer (a11a0f3be1ceeb11c) 是否完成。若完成则处理 report（DONE→生成 review package 派 task reviewer；DONE_WITH_CONCERNS→先读 concerns；NEEDS_CONTEXT→补上下文重派；BLOCKED→裁决）' } },
    { type: 'user', isMeta: true, message: { role: 'user', content: '[1 prior /loop wakeup found nothing actionable; loop is healthy.]' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '唤醒已触发。正在检查 Task 5。' }] } },
    // 工具结果行（toolUseResult 形态走 array 分支 → role:tool）
    { type: 'user', toolUseResult: { success: true }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '4cb64a8 refactor commit' }] } },
  ]
  writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')

  // 第一道防线：捕获层
  const turns = parseTranscriptFile(p)
  const roles = turns.map((t) => t.role)
  expect(roles).toEqual(['assistant', 'system', 'system', 'assistant', 'tool'])
  expect(turns.some((t) => t.role === 'user')).toBe(false)  // 无真人行

  // 第二道防线：蒸馏器兜底（LLM 顽固标 user-stated 也被推翻）
  const fakeResponse = {
    candidates: [{
      title: '[category:process] 子代理任务报告的处理分支：DONE/DONE_WITH_CONCERNS/NEEDS_CONTEXT/BLOCKED',
      bodyMd: '按 report 状态分支处理任务结果。',
      scope: 'project', runtime: null, distillAction: 'new',
      origin: 'user-stated',
      evidence: '按 report 状态分支处理 Task 1 结果',
    }],
  }
  const result = await distillTranscript({
    turns, runtime: 'claude-code', cwd: '/repo', existingSlugs: [],
    callLLM: async () => JSON.stringify(fakeResponse),
  })
  expect(result.candidates.length).toBe(1)
  expect(result.candidates[0]!.origin).toBe('agent-observed')

  rmSync(dir, { recursive: true, force: true })
})

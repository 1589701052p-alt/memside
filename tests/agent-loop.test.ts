// tests/agent-loop.test.ts
// 回归防护:agent 循环的核心资产是「对话累积」——每轮必须带上之前全部工具结果,
// 格式纠错是追加而非重置(callWithRetry 式重置会让 agent 每轮失忆)。
// spec: docs/superpowers/specs/2026-08-06-agentic-value-judge-design.md §4.4
import { test, expect } from 'bun:test'
import { runAgentLoop } from '@/memory/agentLoop'
import type { RepoTools } from '@/memory/repoTools'

const fakeTools = (result = 'grep 结果文本'): RepoTools => ({
  execute: async () => result,
})

test('收敛:工具结果累积进下一轮 prompt,final 结束循环', async () => {
  const seenUsers: string[] = []
  const callLLM = async (_s: string, u: string) => {
    seenUsers.push(u)
    return seenUsers.length === 1
      ? '{"tool": "grep", "args": {"pattern": "sslBackend"}}'
      : '{"final": {"verdicts": [{"index": 0, "category": "trap"}]}}'
  }
  const r = await runAgentLoop({
    callLLM, system: 'sys', user: '初始材料', tools: fakeTools(), maxRounds: 10, timeBudgetMs: 60_000,
  })
  expect(r.stopReason).toBe('final')
  expect(r.final).toEqual({ verdicts: [{ index: 0, category: 'trap' }] })
  expect(seenUsers).toHaveLength(2)
  expect(seenUsers[1]).toContain('grep 结果文本')   // 累积:第二轮看到工具结果
  expect(seenUsers[1]).toContain('初始材料')        // 累积:初始材料仍在
  expect(r.trace.map((t) => t.kind)).toEqual(['tool', 'final'])
})

test('格式错误:追加纠正消息而非重置对话', async () => {
  const seenUsers: string[] = []
  const callLLM = async (_s: string, u: string) => {
    seenUsers.push(u)
    if (seenUsers.length === 1) return '不是 JSON 的胡言乱语'
    if (seenUsers.length === 2) return '{"tool": "list", "args": {}}'
    return '{"final": {"verdicts": []}}'
  }
  const r = await runAgentLoop({
    callLLM, system: 'sys', user: '材料', tools: fakeTools(), maxRounds: 10, timeBudgetMs: 60_000,
  })
  expect(r.stopReason).toBe('final')
  expect(seenUsers[1]).toContain('格式不对')        // 纠正消息
  expect(seenUsers[2]).toContain('材料')            // 对话未重置
})

test('轮次预算耗尽:强制收尾;仍无 final 则 final=null', async () => {
  const seenUsers: string[] = []
  const callLLM = async (_s: string, u: string) => {
    seenUsers.push(u)
    return '{"tool": "grep", "args": {"pattern": "x"}}'  // 永远要查,永不下判
  }
  const r = await runAgentLoop({
    callLLM, system: 'sys', user: '材料', tools: fakeTools(), maxRounds: 3, timeBudgetMs: 60_000,
  })
  expect(r.stopReason).toBe('rounds-budget')
  expect(r.final).toBeNull()
  expect(seenUsers.some((u) => u.includes('预算已尽'))).toBe(true)  // 收到强制收尾消息
})

test('强制收尾一轮成功:final 可取,stopReason 仍记 rounds-budget', async () => {
  let calls = 0
  const callLLM = async () => {
    calls++
    return calls <= 3 ? '{"tool": "grep", "args": {"pattern": "x"}}' : '{"final": {"verdicts": []}}'
  }
  const r = await runAgentLoop({
    callLLM, system: 'sys', user: '材料', tools: fakeTools(), maxRounds: 3, timeBudgetMs: 60_000,
  })
  expect(r.stopReason).toBe('rounds-budget')
  expect(r.final).toEqual({ verdicts: [] })
})

test('LLM 抛错:stopReason=llm-error,final=null,不炸调用方', async () => {
  const r = await runAgentLoop({
    callLLM: async () => { throw new Error('HTTP 502') },
    system: 'sys', user: '材料', tools: fakeTools(), maxRounds: 5, timeBudgetMs: 60_000,
  })
  expect(r.stopReason).toBe('llm-error')
  expect(r.final).toBeNull()
})

test('工具执行出错:错误文本塞回对话,循环继续', async () => {
  const seenUsers: string[] = []
  const callLLM = async (_s: string, u: string) => {
    seenUsers.push(u)
    return seenUsers.length === 1
      ? '{"tool": "write", "args": {}}'
      : '{"final": {"verdicts": []}}'
  }
  const r = await runAgentLoop({
    callLLM, system: 'sys', user: '材料',
    tools: { execute: async (t) => `未知工具:${t}` }, maxRounds: 5, timeBudgetMs: 60_000,
  })
  expect(r.stopReason).toBe('final')
  expect(seenUsers[1]).toContain('未知工具')
})

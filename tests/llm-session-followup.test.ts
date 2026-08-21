// tests/llm-session-followup.test.ts
//
// 回归锁（spec 2026-08-20-consolidate-update-of-target-prompt Task 3 评审 fix）：
// shouldRetry 返回的引导字符串必须随 followup prompt 抵达模型，否则「重试可收敛」
// 机制是断的——模型在重试轮只见通用「格式不对」提示，无据可改，3 轮同错。
// 两个断言面：
// a. buildFollowupPrompt 纯函数：format 分支携带 detail（具体问题），无 detail 时文案与旧版一致。
// b. runLlmSession 机制集成：shouldRetry 报错串被拼进第 2 轮 conversation。
import { describe, it, expect } from 'bun:test'
import { buildFollowupPrompt } from '@/memory/stepPrompt'
import { runLlmSession } from '@/memory/llmSession'
import type { LLMCall } from '@/llm'

describe('buildFollowupPrompt detail 引导', () => {
  it('format 分支带 detail → 文案含「具体问题：<detail>」', () => {
    const p = buildFollowupPrompt('format', 'r', 'dedup', '合法 targetId 仅限 APPROVED 分区: A')
    expect(p).toContain('具体问题：合法 targetId 仅限 APPROVED 分区: A')
  })
  it('format 分支不传 detail → 文案与旧版一致（回归兼容）', () => {
    const p = buildFollowupPrompt('format', 'r', 'dedup')
    expect(p).toBe(
      '\n\n[系统] 你上次的回复格式不对，请输出合规的 JSON 对象。上次的回复：\nr\n请只输出纯 JSON 对象，不要 markdown 围栏，不要解释文字，键与字符串值用双引号。',
    )
  })
  it('incomplete / aborted 分支不插入 detail（detail 仅 format 分支生效）', () => {
    expect(buildFollowupPrompt('incomplete', 'r', 'dedup', '不应出现')).not.toContain('具体问题')
    expect(buildFollowupPrompt('aborted', 'r', 'dedup', '不应出现')).not.toContain('具体问题')
  })
})

describe('runLlmSession shouldRetry 引导抵达 followup', () => {
  it('shouldRetry 报错串拼进第 2 轮 conversation，第 2 轮合法输出 → ok 收尾', async () => {
    const ROUND1 = JSON.stringify({ groups: [{ action: 'update_of', targetId: 'C', members: ['new-0'] }] })
    const ROUND2 = JSON.stringify({ groups: [{ action: 'keep', members: ['new-0'] }] })
    const GUIDANCE = '合法 targetId 仅限 APPROVED 分区: A'
    let calls = 0
    let round2Conversation = ''
    const callLLM: LLMCall = async (_system, conversation) => {
      calls++
      if (calls === 1) return ROUND1
      round2Conversation = conversation
      return ROUND2
    }
    const res = await runLlmSession({
      callLLM,
      system: 'sys',
      initialUser: 'user',
      step: 'dedup',
      jobId: 'j',
      shouldRetry: (parsed) => {
        const g = (parsed as { groups?: { targetId?: string }[] }).groups?.[0]
        return g && g.targetId === 'C' ? GUIDANCE : null
      },
      maxAttempts: 2,
    })
    expect(calls).toBe(2)
    expect(round2Conversation).toContain(GUIDANCE)
    expect(round2Conversation).toContain(`具体问题：${GUIDANCE}`)
    expect(res).toEqual({ ok: true, parsed: JSON.parse(ROUND2) })
  })
})

// 回归锁（spec 2026-08-20-consolidate-update-of-target-prompt final-fix C1）：
// 生产 dedup 路径恒带 loadHistory，consolidateCandidates 此时 maxAttempts = history.length + 1，
// runLlmSession 单 tick 只跑一轮——失败轮构造的带 detail 的 conversation 在单 tick 内被丢弃；
// 真实重试在下一 tick 走恢复路径（loadHistory 返回上一轮记录 + buildFollowupPrompt）。
// 若 RoundRecord 不落盘/读回 detail，恢复路径的 buildFollowupPrompt 不传 detail，
// 引导串无法抵达模型，模型下一轮仍无据可改。本用例模拟生产「单 tick 单轮 × 两 tick」：
// a. 第一 tick：loadHistory=[]、maxAttempts=1、persistRound 捕获 RoundRecord，
//    fake callLLM 返回可 parse 但被 shouldRetry 拒的 JSON → ok:false，捕获的 detail 等于引导串。
// b. 第二 tick（下一轮恢复）：loadHistory=[上一轮记录]、maxAttempts=2，
//    捕获本次 callLLM 收到的 conversation → 断言含引导串与「具体问题：」。
describe('runLlmSession 生产恢复路径引导抵达模型（C1）', () => {
  it('detail 经 persistRound 落盘、loadHistory 读回、恢复路径 buildFollowupPrompt 传 detail', async () => {
    const ROUND1 = JSON.stringify({ groups: [{ action: 'update_of', targetId: 'C', members: ['new-0'] }] })
    const ROUND2 = JSON.stringify({ groups: [{ action: 'keep', members: ['new-0'] }] })
    const GUIDANCE = '合法 targetId 仅限 APPROVED 分区: A'
    const shouldRetry = (parsed: unknown) => {
      const g = (parsed as { groups?: { targetId?: string }[] }).groups?.[0]
      return g && g.targetId === 'C' ? GUIDANCE : null
    }

    // 第一 tick：模拟生产单 tick 单轮
    let tick1Calls = 0
    let capturedRound: import('@/memory/llmSession').RoundRecord | null = null
    const callLLM1: LLMCall = async () => {
      tick1Calls++
      return ROUND1
    }
    const res1 = await runLlmSession({
      callLLM: callLLM1,
      system: 'sys',
      initialUser: 'user',
      step: 'dedup',
      jobId: 'j',
      loadHistory: async () => [],
      maxAttempts: 1,
      shouldRetry,
      persistRound: async (r) => { capturedRound = r },
    })
    expect(tick1Calls).toBe(1)
    expect(res1.ok).toBe(false)
    expect(capturedRound).not.toBeNull()
    expect(capturedRound!.detail).toBe(GUIDANCE)

    // 第二 tick：模拟下一 tick 恢复路径
    let tick2Calls = 0
    let tick2Conversation = ''
    const callLLM2: LLMCall = async (_sys, conversation) => {
      tick2Calls++
      tick2Conversation = conversation
      return ROUND2
    }
    const res2 = await runLlmSession({
      callLLM: callLLM2,
      system: 'sys',
      initialUser: 'user',
      step: 'dedup',
      jobId: 'j',
      loadHistory: async () => [capturedRound!],
      maxAttempts: 2,
      shouldRetry,
    })
    expect(tick2Calls).toBe(1)
    expect(tick2Conversation).toContain(GUIDANCE)
    expect(tick2Conversation).toContain('具体问题：')
    expect(res2.ok).toBe(true)
  })
})

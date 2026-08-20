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

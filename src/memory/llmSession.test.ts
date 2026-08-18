// 锁 spec 2026-08-18 §3/§5/§8.2：执行器是重构核心。失败带历史接着跑（P2），
// 3 轮上限（P7），失败绝不冒充成功（P1）。历史四样 round-trip。
import { describe, expect, test } from 'bun:test'
import { runLlmSession, type RoundRecord } from './llmSession'
import type { LLMCall } from '@/llm'

// responses 按成功调用顺序消费；throws 按调用序号（含抛错轮）判定。两者
// 用独立计数器，否则抛错轮既占一个 responses 槽又推进 i，导致下一轮取错响应。
function makeCallLLM(responses: string[], throws?: number[]): LLMCall {
  let callIdx = 0
  let respIdx = 0
  return async (_sys, _user) => {
    const i = callIdx++
    if (throws?.includes(i)) { throw new Error('the operation was aborted') }
    return responses[respIdx++] ?? ''
  }
}

describe('runLlmSession', () => {
  test('第1轮成功 → ok + parsed', async () => {
    const saved: RoundRecord[] = []
    const r = await runLlmSession({
      callLLM: makeCallLLM(['{"candidates":[]}']), system: 's', initialUser: 'u', step: 'distill', jobId: 'j1',
      persistRound: async (rr) => { saved.push(rr) },
      loadHistory: async () => [],
      shouldRetry: () => null,
    })
    expect(r.ok).toBe(true)
    expect(saved).toHaveLength(1)
    expect(saved[0].result.ok).toBe(true)
  })

  test('第1轮失败第2轮成功 → 带历史追问，3轮内静默成功', async () => {
    const saved: RoundRecord[] = []
    const r = await runLlmSession({
      // 第1轮抛 aborted，第2轮回合法 JSON
      callLLM: makeCallLLM(['{"candidates":[]}'], [0]),
      system: 's', initialUser: 'u', step: 'distill', jobId: 'j2',
      persistRound: async (rr) => { saved.push(rr) },
      loadHistory: async () => [],
      shouldRetry: () => null,
    })
    expect(r.ok).toBe(true)
    expect(saved).toHaveLength(2)
    expect(saved[0].result.ok).toBe(false)
    // 第2轮 request 应带历史（追问措辞含"中断"或"重新输出"）
    expect(saved[1].request).toMatch(/中断|重新输出|接着/)
  })

  test('3轮全失败 → ok:false + reasons 三条', async () => {
    const r = await runLlmSession({
      callLLM: makeCallLLM([], [0, 1, 2]),
      system: 's', initialUser: 'u', step: 'judge', jobId: 'j3',
      persistRound: async () => {},
      loadHistory: async () => [],
      shouldRetry: () => 'verdicts 缺失',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reasons).toHaveLength(3)
  })

  test('重试时 loadHistory 带回历史 → 第2轮 request 含第1轮内容', async () => {
    const history: RoundRecord[] = [
      { round: 1, request: 'u', response: '{"bad', result: { ok: false, reason: 'incomplete' } },
    ]
    let capturedReq = ''
    const r = await runLlmSession({
      callLLM: async (_s, u) => { capturedReq = u; return '{"candidates":[]}' },
      system: 's', initialUser: 'u', step: 'distill', jobId: 'j4',
      persistRound: async () => {},
      loadHistory: async () => history,
      shouldRetry: () => null,
    })
    expect(r.ok).toBe(true)
    expect(capturedReq).toContain('{"bad') // 带了上一轮响应
  })

  test('失败绝不冒充成功：第2轮仍失败但有第3轮，不提前返回 ok', async () => {
    let calls = 0
    const r = await runLlmSession({
      callLLM: async () => { calls++; throw new Error('connection error') },
      system: 's', initialUser: 'u', step: 'judge', jobId: 'j5',
      persistRound: async () => {},
      loadHistory: async () => [],
      shouldRetry: () => null,
    })
    expect(r.ok).toBe(false)
    expect(calls).toBe(3)
  })

  // 锁 parse-fail 分支（llmSession.ts §58-64）：callLLM 返回非 JSON → 内层
  // JSON.parse 抛错 → classifyFailure(null, raw) → persist → continue → 下一轮成功。
  // 非 JSON 字符串 classifyFailure 落 'format'（无 '{' → format，stepPrompt.ts §19）。
  test('第1轮返回非JSON → format分类+落盘+追问，第2轮成功', async () => {
    const saved: RoundRecord[] = []
    const r = await runLlmSession({
      callLLM: makeCallLLM(['not json at all', '{"ok":true}']),
      system: 's', initialUser: 'u', step: 'distill', jobId: 'j6',
      persistRound: async (rr) => { saved.push(rr) },
      loadHistory: async () => [],
      shouldRetry: () => null,
    })
    expect(r.ok).toBe(true)
    expect(saved).toHaveLength(2)
    expect(saved[0].result.ok).toBe(false)
    if (!saved[0].result.ok) expect(saved[0].result.reason).toBe('format')
    // 第2轮 request 带追问（buildFollowupPrompt format 分支含"格式"/"JSON"）
    expect(saved[1].request).toMatch(/格式|JSON|接着/)
  })

  // 锁 format-retry 分支（llmSession.ts §65-74）：parse 成功但 shouldRetry
  // 返回非 null → reason='format' → persist → continue → 下一轮 shouldRetry 接受。
  test('第1轮JSON合法但shouldRetry拒绝 → format+落盘+追问，第2轮接受', async () => {
    const saved: RoundRecord[] = []
    const r = await runLlmSession({
      callLLM: makeCallLLM(['{"a":1}', '{"a":2}']),
      system: 's', initialUser: 'u', step: 'judge', jobId: 'j7',
      persistRound: async (rr) => { saved.push(rr) },
      loadHistory: async () => [],
      shouldRetry: (parsed) => {
        const p = parsed as { a?: number }
        return p.a === 1 ? 'shape wrong' : null
      },
    })
    expect(r.ok).toBe(true)
    expect(saved).toHaveLength(2)
    expect(saved[0].result.ok).toBe(false)
    if (!saved[0].result.ok) expect(saved[0].result.reason).toBe('format')
    // 第2轮 request 带追问（format 分支含"格式"/"JSON"）
    expect(saved[1].request).toMatch(/格式|JSON/)
  })
})

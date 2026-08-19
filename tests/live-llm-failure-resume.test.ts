// 锁 spec 2026-08-18 §8.8 / Task 10：mock 网关掐断，验证执行器（runLlmSession）
// 接续重试 3 轮内成功；3 轮都掐断 → 返回 ok:false（调用方 scheduler 据此暂停 + 通知）。
//
// 这是 live e2e 门禁（opt-in）：默认 bun test 不设 MEMSIDE_RUN_LIVE -> 全 skip。
// 用可控 wrapper 包真实 callLLM（不真打网关墙模拟掐断）：
//   - resume-succeeds case：第 1 次抛 aborted，第 2 次放行真模型 → 3 轮内成功。
//   - all-aborted case：3 轮都抛 aborted → ok:false（暂停路径）。
//
// ⚠️ 反模式规避（前次失败根因）：不要把 attempts 计数器解构出来——解构捕获的是
// 解构时刻的值（0），不是 live 引用。这里用闭包内 `let calls = 0` 在 wrapped 函数内
// 自增，await 之后再读 `calls`，计数才准确。
import { test, expect } from 'bun:test'
import { runLlmSession } from '@/memory/llmSession'
import { realCallLLM, LIVE_GUARD } from './live-helpers'
import type { LLMCall } from '@/llm'

/**
 * 与 callLLM catch 诊断化后同源的 abort 文案（spec §缺陷3）。
 * 故意复刻这条文案：验证 classifyFailure 的 ABORT_PATTERNS（含 'aborted'）
 * 能命中、runLlmSession 走 aborted 追问分支接续。
 */
const ABORT_MSG =
  'LLM 调用被中断，可能是网关掐断或超时；memside 会自动接续重试（原始错误：the operation was aborted）'

const SYSTEM = '只输出纯 JSON 对象 {"ok":true}，不要 markdown 围栏，不要解释文字。'
const USER = '请回复 {"ok":true}'

/**
 * shouldRetry：只要解析出任意 JSON 对象即视为成功。
 * 本 case 验证的是「执行器在 abort 后能接续并完成一次真实 LLM 调用」，不是模型
 * 合规度——故判据放宽到「任意可解析 JSON 对象」。模型若返回带解释文字的 JSON
 * （extractJsonObject 能扒出）也算通过；真正无 JSON 的纯散文才要求重试。
 */
function shouldRetry(parsed: unknown): string | null {
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return null
  return 'expected a JSON object'
}

test.skipIf(!LIVE_GUARD)(
  'live resume: 第 1 次抛 aborted、第 2 次放行 → 执行器 3 轮内成功',
  async () => {
    // 闭包内可变计数器——勿解构出去（前次失败根因）。
    let calls = 0
    const wrapped: LLMCall = async (system, user, opts) => {
      calls++
      if (calls === 1) {
        // 模拟网关掐断：抛诊断化 abort 错误，执行器应走 aborted 接续分支。
        throw new Error(ABORT_MSG)
      }
      // 第 2 次起放行真模型，验接续后真链路能完成。
      return realCallLLM(system, user, opts)
    }

    const r = await runLlmSession({
      callLLM: wrapped,
      system: SYSTEM,
      initialUser: USER,
      step: 'distill',
      jobId: 'live-resume-succeeds',
      shouldRetry,
      maxAttempts: 3,
    })

    // 至少抛过 1 次 + 放行成功 1 次；执行器确实接续了。
    expect(calls).toBeGreaterThanOrEqual(2)
    expect(r.ok).toBe(true)
    if (r.ok) {
      // 成功 = 解析出任意 JSON 对象（证明 abort 后真实 LLM 调用完成且可解析）。
      expect(typeof r.parsed).toBe('object')
    }
  },
  { timeout: 300_000 },
)

test.skipIf(!LIVE_GUARD)(
  'live resume: 3 轮都掐断 → 返回 ok:false（调用方据此暂停 + 通知）',
  async () => {
    let calls = 0
    const wrapped: LLMCall = async () => {
      calls++
      throw new Error(ABORT_MSG)
    }

    const r = await runLlmSession({
      callLLM: wrapped,
      system: SYSTEM,
      initialUser: USER,
      step: 'distill',
      jobId: 'live-resume-all-aborted',
      shouldRetry,
      maxAttempts: 3,
    })

    // 3 轮都抛了，没有第 4 次（maxAttempts 上限生效）。
    expect(calls).toBe(3)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      // reasons 非空，调用方据 ok:false 暂停 job 并把 reasons 落 stepError。
      expect(r.reasons.length).toBeGreaterThan(0)
      // 每条 reason 都带 aborted 诊断（classifyFailure 走 aborted 分支）。
      expect(r.reasons.some((x) => /aborted/i.test(x))).toBe(true)
    }
  },
  { timeout: 120_000 },
)

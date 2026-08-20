// src/memory/llmSession.ts
import type { LLMCall } from '@/llm'
import { extractJsonObject } from './pure'
import { classifyFailure, buildFollowupPrompt } from './stepPrompt'
import type { DistillStep, StepAttemptResult, StepFailReason } from './stepState'
import { STEP_MAX_ATTEMPTS } from './stepState'

export interface RoundRecord {
  round: number
  request: string
  response: string
  result: StepAttemptResult
  /**
   * shouldRetry 返回的引导串（spec 2026-08-20-consolidate-update-of-target-prompt final-fix C1）。
   * 生产 dedup 路径恒带 loadHistory，单 tick 单轮失败后，带 detail 的 conversation 被丢弃；
   * 真实重试在下一 tick 走恢复路径 buildFollowupPrompt(last.result.reason, last.response, step, last.detail)。
   * 不落盘 detail → 恢复路径无法把引导传给模型，3 轮同错必挂。
   */
  detail?: string
}

export interface LlmSessionOpts {
  callLLM: LLMCall
  system: string
  initialUser: string
  step: DistillStep
  jobId: string
  persistRound?: (r: RoundRecord) => Promise<void>
  loadHistory?: () => Promise<RoundRecord[]>
  shouldRetry: (parsed: unknown) => string | null
  maxAttempts?: number
}

export type LlmSessionResult = { ok: true; parsed: unknown } | { ok: false; reasons: string[] }

/**
 * 可接续 agent 会话执行器（spec §3）。每轮历史落盘+读回，失败分类追问带历史接着跑，
 * maxAttempts 内成功静默返回 ok；全失败返回 ok:false + reasons（调用方据此暂停/通知）。
 * 永不把失败当成功（P1）。
 *
 * 关键裁决（跨任务 ledger #2）：callLLM 抛错时 classifyFailure 的 response 传 null，
 * 否则 aborted 分支在 SDK 返回部分文本时不可达。
 */
export async function runLlmSession(opts: LlmSessionOpts): Promise<LlmSessionResult> {
  const max = opts.maxAttempts ?? STEP_MAX_ATTEMPTS
  const history = opts.loadHistory ? await opts.loadHistory() : []
  let conversation = opts.initialUser
  // 把历史拼进首轮（执行器消费方：loadHistory 返回的非空历史代表"接着跑"）
  if (history.length > 0) {
    const last = history[history.length - 1]!
    if (!last.result.ok) {
      conversation = opts.initialUser + buildFollowupPrompt(last.result.reason, last.response, opts.step, last.detail)
    } else {
      // Task 7（spec §3.3 不变量 3 / P3 断点续跑）：末轮已成功的会话不重发 LLM——
      // 直接复用落盘的成功响应。覆盖「round 落库后、断点推进前」的崩溃窗口：
      // 重试 tick 读回历史即拿回结果，绝不重算已成功步骤。
      try {
        return { ok: true, parsed: JSON.parse(extractJsonObject(last.response)) }
      } catch {
        // 落盘响应损坏（不应发生）——落到下方正常回合继续追问
      }
      conversation = opts.initialUser + buildFollowupPrompt('format', last.response, opts.step)
    }
  }
  const reasons: string[] = []
  for (let round = history.length + 1; round <= max; round++) {
    let raw: string
    let result: StepAttemptResult
    try {
      raw = await opts.callLLM(opts.system, conversation)
      // 校验：解析 + shouldRetry
      let parsed: unknown
      try {
        parsed = JSON.parse(extractJsonObject(raw))
      } catch {
        result = { ok: false, reason: classifyFailure(null, raw) }
        reasons.push(`${result.reason}:${raw.slice(0, 80)}`)
        await opts.persistRound?.({ round, request: conversation, response: raw, result })
        conversation = opts.initialUser + buildFollowupPrompt(result.reason, raw, opts.step)
        continue
      }
      const retryErr = opts.shouldRetry(parsed)
      if (retryErr === null) {
        result = { ok: true }
        await opts.persistRound?.({ round, request: conversation, response: raw, result })
        return { ok: true, parsed }
      }
      result = { ok: false, reason: 'format' as StepFailReason }
      reasons.push(`format:${retryErr}`)
      await opts.persistRound?.({ round, request: conversation, response: raw, result, detail: retryErr })
      conversation = opts.initialUser + buildFollowupPrompt('format', raw, opts.step, retryErr)
    } catch (e) {
      // 裁决 #2：catch 块 response 传 null，避免 aborted 被 partial raw 遮蔽
      const reason = classifyFailure(e, null)
      result = { ok: false, reason }
      reasons.push(`${reason}:${e instanceof Error ? e.message : String(e)}`)
      await opts.persistRound?.({ round, request: conversation, response: '', result })
      conversation = opts.initialUser + buildFollowupPrompt(reason, '', opts.step)
    }
  }
  return { ok: false, reasons }
}

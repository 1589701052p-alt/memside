import type { LLMCall } from '@/llm'

/** LLM 工作阶段（spec 2026-08-12 §5.5）。digest = 滚动账本压缩，UI 归入「蒸馏」列。 */
export type LlmPhase = 'distill' | 'dedup' | 'judge' | 'digest'

export interface LlmActivity { phase: LlmPhase; detail: string | null; since: number }
export interface PhaseHandle { end(): { calls: number; ms: number } }

export interface ActivityTracker {
  begin(phase: LlmPhase, detail?: string | null): PhaseHandle
  /** 包装 callLLM：每次调用递增当前阶段 calls；无当前阶段仅透传。LLM 模块零感知。 */
  wrapCall(call: LLMCall): LLMCall
  get(): LlmActivity | null
}

/**
 * 单槽内存活动跟踪器（spec §5.5）：蒸馏管线串行，任一时刻最多一个阶段在跑，
 * begin 覆盖语义；end 仅当 current 仍属本 handle 才清除（防覆盖后误清）。
 * now 注入仅为测试；生产用 Date.now。不落库——daemon 重启自然归零。
 */
export function createActivityTracker(now: () => number = Date.now): ActivityTracker {
  let current: { activity: LlmActivity; calls: number; handle: symbol } | null = null
  return {
    begin(phase, detail = null) {
      const handle = Symbol(phase)
      const since = now()
      current = { activity: { phase, detail, since }, calls: 0, handle }
      return {
        end() {
          if (current && current.handle === handle) {
            const result = { calls: current.calls, ms: now() - current.activity.since }
            current = null
            return result
          }
          return { calls: 0, ms: 0 }
        },
      }
    },
    wrapCall(call) {
      return async (system, user, opts) => {
        if (current) current.calls += 1
        return await call(system, user, opts)
      }
    },
    get() {
      return current ? current.activity : null
    },
  }
}

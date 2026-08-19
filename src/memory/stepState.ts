// src/memory/stepState.ts
export type DistillStep = 'distill' | 'dedup' | 'judge' | 'digest'
export type StepFailReason = 'aborted' | 'format' | 'incomplete'
export type StepAttemptResult = { ok: true } | { ok: false; reason: StepFailReason }
export type JobPauseState = 'active' | 'paused'

const STEP_ORDER: readonly DistillStep[] = ['distill', 'dedup', 'judge', 'digest']

/** 下一步；digest 后 null = 四步全成。 */
export function nextStep(current: DistillStep): DistillStep | null {
  const i = STEP_ORDER.indexOf(current)
  return i < 0 || i >= STEP_ORDER.length - 1 ? null : STEP_ORDER[i + 1]!
}

/** 累计失败次数 >= 3 即暂停（spec P7）。 */
export const STEP_MAX_ATTEMPTS = 3
export function shouldPause(stepAttempts: number): boolean {
  return stepAttempts >= STEP_MAX_ATTEMPTS
}

/**
 * 给定当前步骤、本轮结果、当前已尝试次数，算出下一步状态。
 * 成功 → 推进到下一步，attempts 归零，active。
 * 失败 → attempts+1；到 3 暂停，否则同步骤继续。
 */
export function advanceStep(
  current: DistillStep, result: StepAttemptResult, currentAttempts: number,
): { step: DistillStep; attempts: number; paused: JobPauseState } {
  if (result.ok) {
    const next = nextStep(current) ?? current
    return { step: next, attempts: 0, paused: 'active' }
  }
  const attempts = currentAttempts + 1
  return { step: current, attempts, paused: shouldPause(attempts) ? 'paused' : 'active' }
}

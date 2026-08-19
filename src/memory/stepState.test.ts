// 锁 spec 2026-08-18 §3.3/§5：断点续跑状态机。失败绝不冒充成功（P1），
// 3 次失败暂停（P7），全成功才完成。未来 refactor 变红即回归意图。
import { describe, expect, test } from 'bun:test'
import { nextStep, shouldPause, advanceStep } from './stepState'

describe('stepState', () => {
  test('nextStep 顺序 distill→dedup→judge→digest→null', () => {
    expect(nextStep('distill')).toBe('dedup')
    expect(nextStep('dedup')).toBe('judge')
    expect(nextStep('judge')).toBe('digest')
    expect(nextStep('digest')).toBeNull()
  })

  test('shouldPause: <3 false, >=3 true', () => {
    expect(shouldPause(0)).toBe(false)
    expect(shouldPause(2)).toBe(false)
    expect(shouldPause(3)).toBe(true)
    expect(shouldPause(5)).toBe(true)
  })

  test('advanceStep: 成功推进到下一步 attempts 归零', () => {
    const r = advanceStep('distill', { ok: true }, 0)
    expect(r).toEqual({ step: 'dedup', attempts: 0, paused: 'active' })
  })

  test('advanceStep: 当前 attempts=2 失败后变 3 暂停', () => {
    const r = advanceStep('judge', { ok: false, reason: 'format' }, 2)
    expect(r).toEqual({ step: 'judge', attempts: 3, paused: 'paused' })
  })

  test('advanceStep: 当前 attempts=1 失败后变 2 不暂停', () => {
    const r = advanceStep('judge', { ok: false, reason: 'aborted' }, 1)
    expect(r).toEqual({ step: 'judge', attempts: 2, paused: 'active' })
  })

  test('advanceStep: 成功时 attempts 归零推进（忽略 currentAttempts）', () => {
    expect(advanceStep('distill', { ok: true }, 2)).toEqual({ step: 'dedup', attempts: 0, paused: 'active' })
  })

  test('digest 成功 = 完成（nextStep null）', () => {
    const r = advanceStep('digest', { ok: true }, 0)
    expect(r).toEqual({ step: 'digest', attempts: 0, paused: 'active' })
    expect(nextStep('digest')).toBeNull()
  })
})

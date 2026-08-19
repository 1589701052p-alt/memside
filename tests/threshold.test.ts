import { describe, test, expect } from 'bun:test'
import {
  DISTILL_RELEASE_MIN_CHARS, DISTILL_RELEASE_MAX_TURNS, DISTILL_TRIVIAL_FLOOR_CHARS, SESSION_FLUSH_TTL_MS,
  computeSliceSignal, shouldRelease, isTrivial, isStale,
} from '@/memory/threshold'
import type { TranscriptTurn } from '@/memory/pure'

const t = (role: TranscriptTurn['role'], content: string): TranscriptTurn => ({ role, content })

describe('threshold 常量（spec §3.3）', () => {
  test('常量值锁定', () => {
    expect(DISTILL_RELEASE_MIN_CHARS).toBe(8000)
    expect(DISTILL_RELEASE_MAX_TURNS).toBe(50)
    expect(DISTILL_TRIVIAL_FLOOR_CHARS).toBe(1000)
    expect(SESSION_FLUSH_TTL_MS).toBe(7_200_000)
  })
})

describe('computeSliceSignal', () => {
  test('空切片 -> {0,0}', () => {
    expect(computeSliceSignal([], 0)).toEqual({ chars: 0, turnCount: 0 })
    expect(computeSliceSignal([t('user', 'hello')], 1)).toEqual({ chars: 0, turnCount: 0 })
  })
  test('offset=0 全量；offset 在中间只算切片', () => {
    const turns = [t('user', 'a'.repeat(100)), t('assistant', 'b'.repeat(200))]
    const full = computeSliceSignal(turns, 0)
    expect(full.turnCount).toBe(2)
    expect(full.chars).toBe(300)
    const half = computeSliceSignal(turns, 1)
    expect(half.turnCount).toBe(1)
    expect(half.chars).toBe(200)
  })
  test('offset 越界 -> {0,0}（不抛）', () => {
    expect(computeSliceSignal([t('user', 'x')], 99)).toEqual({ chars: 0, turnCount: 0 })
  })
  test('与过滤管线一致：tool turn 经 compactToolTurn 后按过滤结果计字符', () => {
    // 锁「信号量 = distiller 实际所见量」：长 tool 输出会被过滤截断，
    // signal.chars 必须反映截断后的长度而非原始长度。
    const bigTool: TranscriptTurn = { role: 'tool', content: 'x'.repeat(100_000) }
    const s = computeSliceSignal([bigTool], 0)
    expect(s.turnCount).toBe(1)
    expect(s.chars).toBeLessThan(10_000)
  })
  test('thinking 不计入信号量：thinking 被剔除，不触发放行也不抵消琐碎判定', () => {
    // 2026-08-19 数据驱动决策：thinking 占输入 50.8% 但 0 evidence 产出，
    // filterTranscriptForDistill 剔除 thinking（DROP_THINKING_TURNS）。computeSliceSignal
    // 复用过滤管线，故 thinking 字符不再计入信号量——纯 thinking 会话不该因 thinking
    // 体积而「够量」放行（thinking 喂 LLM 是零产出，触发 distill 是浪费 LLM 调用）。
    const mixed = computeSliceSignal(
      [t('assistant', 'a'.repeat(100)), t('thinking', 'k'.repeat(150))], 0)
    expect(mixed).toEqual({ chars: 100, turnCount: 1 })
    // 纯 thinking 即使体积巨大也不放行（thinking 不算 distill 输入信号）
    const thinkingOnly = computeSliceSignal([t('thinking', 'k'.repeat(DISTILL_RELEASE_MIN_CHARS))], 0)
    expect(thinkingOnly).toEqual({ chars: 0, turnCount: 0 })
    expect(shouldRelease(thinkingOnly)).toBe(false)
    // 纯 thinking 判琐碎（不抵消 trivial floor）
    expect(isTrivial(computeSliceSignal([t('thinking', 'k'.repeat(DISTILL_TRIVIAL_FLOOR_CHARS))], 0))).toBe(true)
  })
})

describe('shouldRelease', () => {
  test('字符阈值边界 7999/8000', () => {
    expect(shouldRelease({ chars: 7999, turnCount: 3 })).toBe(false)
    expect(shouldRelease({ chars: 8000, turnCount: 3 })).toBe(true)
  })
  test('turn 护栏边界 49/50（OR 语义）', () => {
    expect(shouldRelease({ chars: 10, turnCount: 49 })).toBe(false)
    expect(shouldRelease({ chars: 10, turnCount: 50 })).toBe(true)
  })
})

describe('isTrivial', () => {
  test('999/1000 边界', () => {
    expect(isTrivial({ chars: 999, turnCount: 5 })).toBe(true)
    expect(isTrivial({ chars: 1000, turnCount: 5 })).toBe(false)
  })
})

describe('isStale', () => {
  test('TTL 边界 ±1ms', () => {
    const t0 = 1_000_000
    expect(isStale(t0, t0 + SESSION_FLUSH_TTL_MS - 1)).toBe(false)
    expect(isStale(t0, t0 + SESSION_FLUSH_TTL_MS)).toBe(true)
  })
})

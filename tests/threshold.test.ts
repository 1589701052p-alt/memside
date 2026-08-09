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
  test('thinking 计入信号量：与 assistant 同等计数（锁放行门槛/琐碎下限的同等对待）', () => {
    // 锁「thinking 与 assistant 同等对待」在攒量批处理阈值层的体现：
    // computeSliceSignal 复用 filterTranscriptForDistill，thinking 字符同等计入
    // 放行门槛（8000 chars）与琐碎下限（1000 chars）。
    const mixed = computeSliceSignal(
      [t('assistant', 'a'.repeat(100)), t('thinking', 'k'.repeat(150))], 0)
    expect(mixed).toEqual({ chars: 250, turnCount: 2 })
    // 纯 thinking 达到放行门槛即放行（与纯 assistant 行为一致）
    const thinkingRelease = computeSliceSignal([t('thinking', 'k'.repeat(DISTILL_RELEASE_MIN_CHARS))], 0)
    expect(thinkingRelease.chars).toBe(DISTILL_RELEASE_MIN_CHARS)
    expect(shouldRelease(thinkingRelease)).toBe(true)
    // 纯 thinking 达到琐碎下限即不判 skipped_trivial
    expect(isTrivial(computeSliceSignal([t('thinking', 'k'.repeat(DISTILL_TRIVIAL_FLOOR_CHARS))], 0))).toBe(false)
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

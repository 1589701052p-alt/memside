import { filterTranscriptForDistill, type TranscriptTurn } from './pure'

// spec §3.3 阈值常量（代码常量，上线观测后调；观测结论记录 STATE.md）。
export const DISTILL_RELEASE_MIN_CHARS = 8000
export const DISTILL_RELEASE_MAX_TURNS = 50
export const DISTILL_TRIVIAL_FLOOR_CHARS = 1000
export const SESSION_FLUSH_TTL_MS = 2 * 60 * 60 * 1000

export interface SliceSignal { chars: number; turnCount: number }

/**
 * 切片信号：turns.slice(offset) 经 filterTranscriptForDistill 后的字符/turn 数。
 * 复用过滤管线保证「信号量 = distiller 实际会看到的量」（spec §4.1）。
 * offset 越界/空切片 -> {0,0}，永不抛（filterTranscriptForDistill 自身有 catch-all）。
 */
export function computeSliceSignal(turns: readonly TranscriptTurn[], offset: number): SliceSignal {
  const slice = offset <= 0 ? turns : turns.slice(offset)
  const filtered = filterTranscriptForDistill(slice)
  return {
    chars: filtered.reduce((s, t) => s + t.content.length, 0),
    turnCount: filtered.length,
  }
}

/** 放行判定（capture 时）：字符量达标 OR turn 数护栏（防单 job 切片无限变厚）。 */
export function shouldRelease(signal: SliceSignal): boolean {
  return signal.chars >= DISTILL_RELEASE_MIN_CHARS || signal.turnCount >= DISTILL_RELEASE_MAX_TURNS
}

/** 琐碎判定（flush/TTL 时）：低于下限判 skipped_trivial，不调 LLM。 */
export function isTrivial(signal: SliceSignal): boolean {
  return signal.chars < DISTILL_TRIVIAL_FLOOR_CHARS
}

/** TTL 过期判定（sweep 时）。 */
export function isStale(lastCaptureAt: number, now: number): boolean {
  return now - lastCaptureAt >= SESSION_FLUSH_TTL_MS
}

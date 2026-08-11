// src/memory/rollingSummary.ts
// 会话事实账本（spec 2026-08-11-digest-ledger-redesign）：LLM 只做按片压缩（配额 2:1），
// 追加与全局预算留存（丢最旧、保最近）由代码强制。旧「全量旧摘要+新切片整体重压缩」
// （mergeRollingSummary）已删除：压缩比随会话长度单调上升、超预算连环降级、摘要重压缩渐糊。
import type { TranscriptTurn } from './pure'
import type { LLMCall } from '@/llm'
import { DIGEST_MAX_CHARS, DIGEST_LINE_MAX_CHARS, renderDigestLines, trimOldestLines } from './contextDigest'

/** 切片压缩配额下限（spec §5.2）。 */
export const SLICE_BUDGET_MIN = 600
/** 直追阈值：渲染总长低于此值不调 LLM，rendered 行原样入账本（spec §4.1）。 */
export const DIRECT_APPEND_MAX_CHARS = SLICE_BUDGET_MIN * 2
/** 行化探测阈值：非空行 ≤ 此值视为已行化（账本行恒 ≤300，留 100 字余量，spec §5.2）。 */
export const LEDGER_LINE_SHAPE_MAX = 400

/**
 * 切片压缩配额：约 2:1，下限 SLICE_BUDGET_MIN，上限账本一半（历史至少留一半）。
 * 纯函数。spec §5.2。
 */
export function sliceBudget(renderedLen: number): number {
  return Math.min(Math.max(Math.ceil(renderedLen / 2), SLICE_BUDGET_MIN), Math.floor(DIGEST_MAX_CHARS / 2))
}

/**
 * 遗留 prose 探测（spec §6）：所有非空行 ≤ LEDGER_LINE_SHAPE_MAX 视为已行化。
 * 现网 prose 段落体（单段数百至上千字）判假；行式账本判真。纯函数、永不抛。
 */
export function isLineStructured(digest: string): boolean {
  return digest.split('\n').every((l) => l.length <= LEDGER_LINE_SHAPE_MAX)
}

/**
 * LLM 产出行净化（spec §5.2）：按 \n 切、逐行压平空白、丢空行、单行超
 * DIGEST_LINE_MAX_CHARS 截断（无后缀，与 renderDigestLines 约定一致）。
 * 纯函数、永不抛。
 */
export function sanitizeLlmLines(raw: string): string[] {
  return raw.split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 0)
    .map((l) => l.slice(0, DIGEST_LINE_MAX_CHARS))
}

/**
 * 切片压缩 system prompt（预算参数化，spec §5.3）。中立压缩：只压缩不评判。
 * 硬约束：不得匹配 /keep|discard|保留重要|丢弃|取舍/i——取舍策略在代码层
 * （trimOldestLines），不进 prompt，比旧设计更干净。
 */
export function sliceDigestSystemPrompt(budget: number): string {
  return `You are a session-digest compressor for a memory sidecar.

Convert the provided NEW conversation slice into compact fact lines for the session's rolling ledger.

Rules:
- Output ONLY the fact lines: no JSON, no markdown fences, no numbering, no commentary.
- One fact per line, chronological order, plain declarative sentences.
- Write in 简体中文 (technical terms may stay in English).
- Compress mechanically: no opinions, no importance ranking, no advice.
- Hard length budget: at most ${budget} characters in total.`
}

/** updateSessionLedger 返回形状（spec §5.2）。 */
export interface LedgerUpdateResult {
  digest: string
  /** 仅表示「切片压缩产出超配额被按行裁剪」；全局预算裁剪是设计内留存，不置位。 */
  truncated: boolean
  overshoot: { budget: number; actual: number } | null
}

const joinLen = (lines: readonly string[]): number => lines.join('\n').length

/**
 * 会话事实账本编排（spec §4.1，取代 mergeRollingSummary）：
 * - 无可渲染行 -> 原样返回，不调 LLM；
 * - rendered < DIRECT_APPEND_MAX_CHARS -> 直追，不调 LLM；
 * - prior 为遗留 prose（!isLineStructured）-> 一次性重整调用（满额预算），产出替换账本；
 * - 正常路径 -> LLM 按片压缩（配额 sliceBudget，prompt 附账本最后 ≤5 行衔接），
 *   产出超配额按行裁掉最旧（truncated + overshoot）；
 * - 追加后全局预算 DIGEST_MAX_CHARS 由 trimOldestLines 强制（设计内留存，不报 truncated）。
 * LLM 抛错 / 空产出向外抛（调用方留旧账本 + digest_llm_failed）。
 */
export async function updateSessionLedger(
  priorLedger: string | null,
  newTurns: readonly TranscriptTurn[],
  callLLM: LLMCall,
): Promise<LedgerUpdateResult> {
  const rendered = renderDigestLines(newTurns)
  if (rendered.length === 0) {
    return { digest: priorLedger ?? '', truncated: false, overshoot: null }
  }
  const renderedLen = joinLen(rendered)

  // 遗留 prose：一次性重整（spec §6），预算用满额。
  if (priorLedger !== null && !isLineStructured(priorLedger)) {
    const budget = DIGEST_MAX_CHARS
    const user = `旧摘要（需一并整理）：\n${priorLedger}\n\n新增会话内容：\n${rendered.join('\n')}\n\n请输出整理后的全部事实行。`
    const out = await callLLM(sliceDigestSystemPrompt(budget), user)
    const trimmed = (out ?? '').trim()
    if (!trimmed) throw new Error('ledger restructure: empty LLM output')
    let lines = sanitizeLlmLines(trimmed)
    const actual = joinLen(lines)
    let overshoot: LedgerUpdateResult['overshoot'] = null
    if (actual > budget) {
      lines = trimOldestLines(lines, budget)
      overshoot = { budget, actual }
    }
    return { digest: lines.join('\n'), truncated: overshoot !== null, overshoot }
  }

  const priorLines = priorLedger ? priorLedger.split('\n').filter((l) => l.length > 0) : []
  let newLines: string[]
  let overshoot: LedgerUpdateResult['overshoot'] = null

  if (renderedLen < DIRECT_APPEND_MAX_CHARS) {
    newLines = rendered
  } else {
    const budget = sliceBudget(renderedLen)
    const tail = priorLines.slice(-5)
    const contextSection = tail.length > 0
      ? `已有摘要结尾（仅供衔接参考，不要重复其中内容）：\n${tail.join('\n')}\n\n`
      : ''
    const user = `${contextSection}新增会话内容：\n${rendered.join('\n')}\n\n请输出事实行。`
    const out = await callLLM(sliceDigestSystemPrompt(budget), user)
    const trimmed = (out ?? '').trim()
    if (!trimmed) throw new Error('ledger slice digest: empty LLM output')
    newLines = sanitizeLlmLines(trimmed)
    const actual = joinLen(newLines)
    if (actual > budget) {
      newLines = trimOldestLines(newLines, budget)
      overshoot = { budget, actual }
    }
  }

  const digest = trimOldestLines([...priorLines, ...newLines], DIGEST_MAX_CHARS).join('\n')
  return { digest, truncated: overshoot !== null, overshoot }
}

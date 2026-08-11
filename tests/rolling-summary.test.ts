// tests/rolling-summary.test.ts
// 会话事实账本回归锁（spec 2026-08-11-digest-ledger-redesign §9）：纯函数集
// （sliceBudget/isLineStructured/sanitizeLlmLines/prompt 中立性）+ updateSessionLedger
// 编排（直追/压缩/超配额裁剪/全局留存/prose 重整/失败路径/性质断言）。
import { describe, test, expect } from 'bun:test'
import { DIGEST_MAX_CHARS, DIGEST_LINE_MAX_CHARS } from '@/memory/contextDigest'
import {
  SLICE_BUDGET_MIN, DIRECT_APPEND_MAX_CHARS,
  sliceBudget, isLineStructured, sanitizeLlmLines, sliceDigestSystemPrompt,
  updateSessionLedger,
} from '@/memory/rollingSummary'
import type { TranscriptTurn } from '@/memory/pure'
import type { LLMCall } from '@/llm'

const t = (role: TranscriptTurn['role'], content: string): TranscriptTurn => ({ role, content })

describe('sliceBudget（切片压缩配额，spec §5.2）', () => {
  test('下限钳制 SLICE_BUDGET_MIN', () => {
    expect(sliceBudget(100)).toBe(SLICE_BUDGET_MIN)
    expect(sliceBudget(1199)).toBe(SLICE_BUDGET_MIN)
    expect(sliceBudget(1200)).toBe(SLICE_BUDGET_MIN)
  })
  test('2:1 区段', () => {
    expect(sliceBudget(4000)).toBe(2000)
  })
  test('上限钳制 = 账本一半', () => {
    expect(sliceBudget(10000)).toBe(Math.floor(DIGEST_MAX_CHARS / 2))
  })
})

describe('DIRECT_APPEND_MAX_CHARS（直追阈值）', () => {
  test('= 配额下限 × 2（低于它压缩无意义，spec §5.2）', () => {
    expect(DIRECT_APPEND_MAX_CHARS).toBe(SLICE_BUDGET_MIN * 2)
  })
})

describe('isLineStructured（遗留 prose 探测，spec §5.2/§6）', () => {
  test('长段 prose -> false', () => {
    expect(isLineStructured('x'.repeat(500))).toBe(false)
  })
  test('行式账本 -> true', () => {
    expect(isLineStructured('USER: a\nASSISTANT: b')).toBe(true)
  })
  test('空串/纯空白行 -> true（无违规行）', () => {
    expect(isLineStructured('')).toBe(true)
    expect(isLineStructured('\n\n')).toBe(true)
  })
  test('混入一行超 400 -> false', () => {
    expect(isLineStructured(`ok\n${'y'.repeat(401)}`)).toBe(false)
  })
})

describe('sanitizeLlmLines（LLM 产出行净化，spec §5.2）', () => {
  test('按行切 + 压平空白 + 丢空行', () => {
    expect(sanitizeLlmLines('a  b\n\n  c \n')).toEqual(['a b', 'c'])
  })
  test('单行 cap DIGEST_LINE_MAX_CHARS（无后缀，与 renderDigestLines 约定一致）', () => {
    expect(sanitizeLlmLines('x'.repeat(500))[0]!.length).toBe(DIGEST_LINE_MAX_CHARS)
  })
  test('空白输入 -> 空数组', () => {
    expect(sanitizeLlmLines('   ')).toEqual([])
  })
})

describe('sliceDigestSystemPrompt（中立性 + 预算参数化，spec §5.3）', () => {
  test('只压缩不评判：无 keep/discard/保留重要/丢弃/取舍类指令词', () => {
    expect(sliceDigestSystemPrompt(600)).not.toMatch(/keep|discard|保留重要|丢弃|取舍/i)
    expect(sliceDigestSystemPrompt(600).length).toBeGreaterThan(50)
  })
  test('预算数字参数化', () => {
    expect(sliceDigestSystemPrompt(1234)).toContain('1234')
  })
})

// 大切片 fixture：每 turn 渲染后 'USER: ' + 300 = 306 字；5 turn joined = 1534 ≥ 1200 -> LLM 路径。
const bigSlice = (): TranscriptTurn[] =>
  Array.from({ length: 5 }, (_, i) => t('user', `topic-${i} ` + 'x'.repeat(400)))

describe('updateSessionLedger 编排（mock LLM，spec §4.1）', () => {
  test('正常追加：prior 行式 + LLM 压缩新切片，结果 = 旧行 + 新行', async () => {
    let seen = ''
    const callLLM: LLMCall = async (_sys, user) => { seen = user; return '新事实1\n新事实2' }
    const out = await updateSessionLedger('USER: 旧事实', bigSlice(), callLLM)
    expect(out.digest).toBe('USER: 旧事实\n新事实1\n新事实2')
    expect(out.truncated).toBe(false)
    expect(out.overshoot).toBeNull()
  })
  test('衔接段：prior 有行时 prompt 含最后 ≤5 行 + 「不要重复」；prior=null 时不含', async () => {
    let seen = ''
    const callLLM: LLMCall = async (_sys, user) => { seen = user; return '事实' }
    await updateSessionLedger('USER: 旧事实', bigSlice(), callLLM)
    expect(seen).toContain('USER: 旧事实')
    expect(seen).toContain('不要重复')
    await updateSessionLedger(null, bigSlice(), callLLM)
    expect(seen).not.toContain('不要重复')
  })
  test('全局预算裁剪：追加后超 6000 -> 丢最旧行，truncated=false（设计内留存，spec §7 #3）', async () => {
    const prior = Array.from({ length: 30 }, (_, i) => `旧-${String(i).padStart(2, '0')} ` + 'p'.repeat(290)).join('\n')
    // 30 行 × 295 字 + 29 换行 = 8879 字；裁剪后 ≤6000
    const callLLM: LLMCall = async () => '新事实'
    const out = await updateSessionLedger(prior, bigSlice(), callLLM)
    expect(out.digest.length).toBeLessThanOrEqual(DIGEST_MAX_CHARS)
    expect(out.digest).toContain('新事实')
    expect(out.digest).not.toContain('旧-00')
    expect(out.truncated).toBe(false)
    expect(out.overshoot).toBeNull()
  })
  test('超配额：产出超 budget -> 按行裁掉最旧、保留最新，truncated=true + overshoot 数值', async () => {
    // rendered 1534 -> budget = ceil(1534/2) = 767
    const callLLM: LLMCall = async () =>
      Array.from({ length: 10 }, (_, i) => `fact-${i} ` + 'z'.repeat(190)).join('\n') // 10×197+9=1979 > 767
    const out = await updateSessionLedger(null, bigSlice(), callLLM)
    expect(out.truncated).toBe(true)
    expect(out.overshoot).toEqual({ budget: 767, actual: 1979 })
    expect(out.digest).toContain('fact-9')   // 最新保留
    expect(out.digest).not.toContain('fact-0') // 最旧被裁
    expect(out.digest.length).toBeLessThanOrEqual(767)
  })
  test('小切片直追：rendered < 1200 -> callLLM 零调用，rendered 行原样入账本', async () => {
    let called = 0
    const callLLM: LLMCall = async () => { called += 1; return '不该出现' }
    const out = await updateSessionLedger('USER: 旧', [t('user', '短内容')], callLLM)
    expect(called).toBe(0)
    expect(out.digest).toBe('USER: 旧\nUSER: 短内容')
    expect(out.truncated).toBe(false)
  })
  test('遗留 prose 重整：prompt 含 prose 全文 + 满额预算 6000，产出替换账本', async () => {
    const prose = '这是一段很长的段落体摘要。'.repeat(40) // 单行 >400 -> 判 prose
    let seenSys = ''
    let seenUser = ''
    const callLLM: LLMCall = async (sys, user) => { seenSys = sys; seenUser = user; return '整理1\n整理2' }
    const out = await updateSessionLedger(prose, bigSlice(), callLLM)
    expect(seenSys).toContain('6000')
    expect(seenUser).toContain('旧摘要（需一并整理）')
    expect(seenUser).toContain('这是一段很长的段落体摘要。')
    expect(out.digest).toBe('整理1\n整理2') // 替换，无 prose 残留
    expect(out.truncated).toBe(false)
  })
  test('重整路径产出超 6000 -> 按行裁剪 + overshoot', async () => {
    const prose = '长段落。'.repeat(101) // 404 字单行 >400 -> 判 prose（repeat(100)=400 恰在边界，会误判行式）
    const callLLM: LLMCall = async () =>
      Array.from({ length: 30 }, (_, i) => `行-${i} ` + 'q'.repeat(290)).join('\n') // 远超 6000
    const out = await updateSessionLedger(prose, bigSlice(), callLLM)
    expect(out.truncated).toBe(true)
    expect(out.overshoot!.budget).toBe(DIGEST_MAX_CHARS)
    expect(out.digest.length).toBeLessThanOrEqual(DIGEST_MAX_CHARS)
    expect(out.digest).toContain('行-29')
  })
  test('空/空白产出视为失败向外抛（调用方留旧账本）', async () => {
    const callLLM: LLMCall = async () => '   '
    await expect(updateSessionLedger(null, bigSlice(), callLLM)).rejects.toThrow()
  })
  test('LLM 抛错向外传播（catch 不得吞）', async () => {
    const callLLM: LLMCall = async () => { throw new Error('ark 502') }
    await expect(updateSessionLedger(null, bigSlice(), callLLM)).rejects.toThrow('ark 502')
  })
  test('无可渲染行（全 system）-> 不调 LLM，返回 prior 原值', async () => {
    let called = 0
    const callLLM: LLMCall = async () => { called += 1; return 'x' }
    const withPrior = await updateSessionLedger('USER: 旧', [t('system', 's')], callLLM)
    expect(called).toBe(0)
    expect(withPrior.digest).toBe('USER: 旧')
    const noPrior = await updateSessionLedger(null, [t('system', 's')], callLLM)
    expect(noPrior.digest).toBe('')
  })
  test('性质断言：任意非空 mock 产出，digest 恒 ≤ DIGEST_MAX_CHARS', async () => {
    const nasties = [
      'x'.repeat(20000),                                  // 巨长单行
      Array.from({ length: 100 }, (_, i) => `l${i} ${'y'.repeat(280)}`).join('\n'), // 海量行
      'a\n\n\nb',                                          // 稀疏
    ]
    for (const raw of nasties) {
      const callLLM: LLMCall = async () => raw
      const out = await updateSessionLedger('USER: 旧', bigSlice(), callLLM)
      expect(out.digest.length).toBeLessThanOrEqual(DIGEST_MAX_CHARS)
    }
  })
})

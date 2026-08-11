// tests/rolling-summary.test.ts
import { describe, test, expect } from 'bun:test'
import { DIGEST_MAX_CHARS, DIGEST_LINE_MAX_CHARS } from '@/memory/contextDigest'
import {
  ROLLING_SUMMARY_SYSTEM_PROMPT, mergeRollingSummary,
  SLICE_BUDGET_MIN, DIRECT_APPEND_MAX_CHARS,
  sliceBudget, isLineStructured, sanitizeLlmLines, sliceDigestSystemPrompt,
} from '@/memory/rollingSummary'
import type { TranscriptTurn } from '@/memory/pure'
import type { LLMCall } from '@/llm'

const t = (role: TranscriptTurn['role'], content: string): TranscriptTurn => ({ role, content })

describe('mergeRollingSummary（mock LLM）', () => {
  test('prior=null 首建：prompt 不含旧摘要段，返回新摘要', async () => {
    let seen = ''
    const callLLM: LLMCall = async (_sys, user) => { seen = user; return '摘要v1' }
    const out = await mergeRollingSummary(null, [t('user', '讨论 bun 测试')], callLLM)
    expect(out.digest).toBe('摘要v1')
    expect(out.truncated).toBe(false)
    expect(seen).not.toContain('旧摘要')
    expect(seen).toContain('讨论 bun 测试')
  })
  test('增量合并：prompt 同时含旧摘要与新切片', async () => {
    let seen = ''
    const callLLM: LLMCall = async (_sys, user) => { seen = user; return '合并后摘要' }
    const out = await mergeRollingSummary('旧摘要内容', [t('assistant', '新进展')], callLLM)
    expect(out.digest).toBe('合并后摘要')
    expect(seen).toContain('旧摘要内容')
    expect(seen).toContain('新进展')
  })
  test('超长产出被代码强制截断且 truncated=true（不信任 LLM，spec §4.3/§5 #8）', async () => {
    const callLLM: LLMCall = async () => 'x'.repeat(DIGEST_MAX_CHARS + 500)
    const out = await mergeRollingSummary(null, [t('user', 'a')], callLLM)
    expect(out.digest.length).toBe(DIGEST_MAX_CHARS)
    expect(out.truncated).toBe(true)
  })
  test('空白产出视为失败向外抛（调用方降级保留旧摘要）', async () => {
    const callLLM: LLMCall = async () => '   '
    await expect(mergeRollingSummary('旧', [t('user', 'a')], callLLM)).rejects.toThrow()
  })
  test('LLM 抛错向外传播（catch 不得吞）', async () => {
    const callLLM: LLMCall = async () => { throw new Error('ark 502') }
    await expect(mergeRollingSummary('旧', [t('user', 'a')], callLLM)).rejects.toThrow('ark 502')
  })
})

describe('ROLLING_SUMMARY_SYSTEM_PROMPT 中立性（项目记忆：判定 prompt 禁倾向性措辞）', () => {
  test('只压缩不评判：无 keep/discard/保留/丢弃类指令词', () => {
    expect(ROLLING_SUMMARY_SYSTEM_PROMPT).not.toMatch(/keep|discard|保留重要|丢弃|取舍/i)
    expect(ROLLING_SUMMARY_SYSTEM_PROMPT.length).toBeGreaterThan(50)
  })
})

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

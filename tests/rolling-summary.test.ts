// tests/rolling-summary.test.ts
import { describe, test, expect } from 'bun:test'
import { DIGEST_MAX_CHARS } from '@/memory/contextDigest'
import { ROLLING_SUMMARY_SYSTEM_PROMPT, mergeRollingSummary } from '@/memory/rollingSummary'
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

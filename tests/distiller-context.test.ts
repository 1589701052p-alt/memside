// Task 6（蒸馏攒量批处理，spec §4.6）：distiller 输入扩展回归锁。
// 锁两件事：(1) priorContext/approvedTitles 进 user prompt 的节标题与顺序；
// (2) 两字段均空时 prompt 与旧行为逐字节一致（向后兼容锁——空节整节省略）。
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { distillTranscript } from '@/memory/distiller'
import type { LLMCall } from '@/llm'
import type { TranscriptTurn } from '@/memory/pure'

const t = (role: TranscriptTurn['role'], content: string): TranscriptTurn => ({ role, content })
const okLLM = (capture: { user?: string }): LLMCall => async (_sys, user) => {
  capture.user = user
  return JSON.stringify({ candidates: [] })
}
const base = { runtime: 'claude-code' as const, cwd: '/x', existingSlugs: [] }

describe('distiller 上下文扩展（spec §4.6）', () => {
  test('priorContext 进 prompt：背景节 + 禁止提炼标注', async () => {
    const cap: { user?: string } = {}
    await distillTranscript({ ...base, turns: [t('user', '新内容')], priorContext: 'USER: 旧讨论', approvedTitles: [], callLLM: okLLM(cap) })
    expect(cap.user).toContain('## 背景（仅供理解上下文，禁止从中提炼）')
    expect(cap.user).toContain('USER: 旧讨论')
    expect(cap.user!.indexOf('USER: 旧讨论')).toBeLessThan(cap.user!.indexOf('新内容'))
  })
  test('approvedTitles 进 prompt：已记录节 + 禁止重复标注', async () => {
    const cap: { user?: string } = {}
    await distillTranscript({ ...base, turns: [t('user', '新内容')], priorContext: null, approvedTitles: ['[category:convention] 用 bun test'], callLLM: okLLM(cap) })
    expect(cap.user).toContain('## 已记录的记忆标题（禁止重复提炼）')
    expect(cap.user).toContain('- [category:convention] 用 bun test')
  })
  test('向后兼容锁：两字段均空时 prompt 与旧行为逐字节一致', async () => {
    const capNew: { user?: string } = {}
    const capOld: { user?: string } = {}
    const turns = [t('user', '同样的输入')]
    await distillTranscript({ ...base, turns, callLLM: okLLM(capOld) })
    await distillTranscript({ ...base, turns, priorContext: null, approvedTitles: [], callLLM: okLLM(capNew) })
    expect(capNew.user).toBe(capOld.user)
  })
  test('空字符串 priorContext 视为无（不渲染空节）', async () => {
    const cap: { user?: string } = {}
    await distillTranscript({ ...base, turns: [t('user', 'x')], priorContext: '', approvedTitles: [], callLLM: okLLM(cap) })
    expect(cap.user).not.toContain('## 背景')
  })
})

describe('源码层文本断言（CLAUDE.md 运行时兜底面）', () => {
  test('distiller.ts 含两节标题常量', () => {
    const src = readFileSync('src/memory/distiller.ts', 'utf8')
    expect(src).toContain('## 背景（仅供理解上下文，禁止从中提炼）')
    expect(src).toContain('## 已记录的记忆标题（禁止重复提炼）')
  })
})

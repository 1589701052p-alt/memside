// tests/context-digest.test.ts
import { describe, test, expect } from 'bun:test'
import { DIGEST_MAX_CHARS, DIGEST_LINE_MAX_CHARS, buildDeterministicDigest } from '@/memory/contextDigest'
import type { TranscriptTurn } from '@/memory/pure'

const t = (role: TranscriptTurn['role'], content: string, toolName?: string): TranscriptTurn =>
  ({ role, content, ...(toolName ? { toolName } : {}) })

describe('buildDeterministicDigest', () => {
  test('常量锁定', () => {
    expect(DIGEST_MAX_CHARS).toBe(3000)
    expect(DIGEST_LINE_MAX_CHARS).toBe(300)
  })
  test('user/assistant 截断 300 字单行，换行压平', () => {
    const d = buildDeterministicDigest([t('user', 'line1\nline2 ' + 'x'.repeat(500))])
    expect(d.startsWith('USER: line1 line2 ')).toBe(true)
    expect(d.length).toBeLessThanOrEqual('USER: '.length + DIGEST_LINE_MAX_CHARS)
  })
  test('tool 只留名字，system 跳过', () => {
    const d = buildDeterministicDigest([
      t('system', 'sys prompt 内容'),
      t('tool', '巨大的文件内容'.repeat(100), 'Read'),
    ])
    expect(d).toBe('[tool: Read]')
    expect(d).not.toContain('sys')
    expect(d).not.toContain('巨大的文件内容')
  })
  test('tool 无 toolName 时占位 unknown', () => {
    expect(buildDeterministicDigest([t('tool', 'x')])).toBe('[tool: unknown]')
  })
  test('时间序保持：输出顺序与输入一致', () => {
    const d = buildDeterministicDigest([t('user', 'first'), t('assistant', 'second'), t('user', 'third')])
    expect(d.indexOf('first')).toBeLessThan(d.indexOf('second'))
    expect(d.indexOf('second')).toBeLessThan(d.indexOf('third'))
  })
  test('总量超限从最早处截（保留最近的）', () => {
    const turns: TranscriptTurn[] = []
    for (let i = 0; i < 100; i++) turns.push(t('user', `msg-${i} ` + 'y'.repeat(200)))
    const d = buildDeterministicDigest(turns, 1000)
    expect(d.length).toBeLessThanOrEqual(1000)
    expect(d).toContain('msg-99')
    expect(d).not.toContain('msg-0')
  })
  test('空输入 -> 空串', () => {
    expect(buildDeterministicDigest([])).toBe('')
  })
  test('逐字节稳定性：同输入两次调用输出全等（锁 prompt 稳定性回归）', () => {
    const turns = [t('user', 'a'.repeat(400)), t('tool', 'z', 'Bash'), t('assistant', 'b')]
    expect(buildDeterministicDigest(turns)).toBe(buildDeterministicDigest(turns))
  })
  test('thinking -> THINKING 行，换行压平 + 同 300 字截断（spec §4.2 同等对待）', () => {
    const d = buildDeterministicDigest([t('thinking', 'why\n' + 'z'.repeat(500))])
    expect(d.startsWith('THINKING: why ')).toBe(true)
    expect(d.length).toBeLessThanOrEqual('THINKING: '.length + DIGEST_LINE_MAX_CHARS)
  })
})

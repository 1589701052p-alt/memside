// tests/context-digest.test.ts
import { describe, test, expect } from 'bun:test'
import { DIGEST_MAX_CHARS, DIGEST_LINE_MAX_CHARS, buildDeterministicDigest, renderDigestLines, trimOldestLines } from '@/memory/contextDigest'
import type { TranscriptTurn } from '@/memory/pure'

const t = (role: TranscriptTurn['role'], content: string, toolName?: string): TranscriptTurn =>
  ({ role, content, ...(toolName ? { toolName } : {}) })

describe('buildDeterministicDigest', () => {
  test('常量锁定', () => {
    // DIGEST_MAX_CHARS 3000 -> 6000：2026-08-11 digest-ledger-redesign spec §2 G5（用户确认）。
    // 依据：digest 仅是蒸馏 prompt 的背景一节，64k token 输入预算下增量 ~5%；
    // 预算越大合并压缩比越小，超预算概率越低。
    expect(DIGEST_MAX_CHARS).toBe(6000)
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
  test('tool 带 toolCall -> [tool: 名字] <截 100 字>（spec §4.2）', () => {
    const d = buildDeterministicDigest([
      { role: 'tool', content: 'out', toolName: 'Bash', toolCall: '{"command":"bun test"}' },
    ])
    expect(d).toBe('[tool: Bash] {"command":"bun test"}')
  })

  test('tool 带 toolCall 超 100 字 -> 截断', () => {
    const d = buildDeterministicDigest([
      { role: 'tool', content: 'out', toolName: 'Bash', toolCall: 'x'.repeat(150) },
    ])
    expect(d.startsWith('[tool: Bash] ')).toBe(true)
    expect(d.endsWith('…[truncated]')).toBe(true)
    // 调用部分截 100 字：'[tool: Bash] '.length + 100 + 后缀
    expect(d.length).toBe('[tool: Bash] '.length + 100 + '…[truncated]'.length)
  })

  test('tool 无 toolCall -> 保持 [tool: 名字]（兼容）', () => {
    const d = buildDeterministicDigest([t('tool', 'out', 'Read')])
    expect(d).toBe('[tool: Read]')
  })
})

describe('renderDigestLines（行格式唯一权威，spec §5.1）', () => {
  test('四种 role 格式 + system 跳过', () => {
    expect(renderDigestLines([
      t('user', 'a'), t('assistant', 'b'), t('thinking', 'c'), t('tool', 'out', 'Read'), t('system', 's'),
    ])).toEqual(['USER: a', 'ASSISTANT: b', 'THINKING: c', '[tool: Read]'])
  })
  test('300 字 cap + 换行压平', () => {
    const [line] = renderDigestLines([t('user', 'a\nb ' + 'x'.repeat(500))])
    expect(line!.startsWith('USER: a b ')).toBe(true)
    expect(line!.length).toBe('USER: '.length + DIGEST_LINE_MAX_CHARS)
  })
  test('空输入 -> 空数组', () => {
    expect(renderDigestLines([])).toEqual([])
  })
})

describe('trimOldestLines（最旧整行丢弃，经济/质量共用，spec §5.1）', () => {
  test('丢最旧整行直到达标', () => {
    expect(trimOldestLines(['aaaa', 'bbbb', 'cccc'], 9)).toEqual(['bbbb', 'cccc']) // 'bbbb\ncccc' = 9
  })
  test('恰好达标不动', () => {
    expect(trimOldestLines(['aa', 'bb'], 5)).toEqual(['aa', 'bb'])
  })
  test('仅剩单行仍超 -> 原样返回（尾部切片归调用方）', () => {
    expect(trimOldestLines(['x'.repeat(20)], 5)).toEqual(['x'.repeat(20)])
  })
  test('空数组 -> 空数组', () => {
    expect(trimOldestLines([], 10)).toEqual([])
  })
})

import { test, expect } from 'bun:test'
import {
  filterTranscriptForDistill,
  DEFAULT_DISTILL_INPUT_BUDGET_TOKENS,
  type TranscriptTurn,
  TOOL_INPUT_CAP_CHARS,
} from '@/memory/pure'

const tool = (over: Partial<TranscriptTurn> & Pick<TranscriptTurn, 'content'>): TranscriptTurn =>
  ({ role: 'tool', ...over })

test('Read tool result (non-error) -> file placeholder, source gone', () => {
  const src = 'import { x } from "y"\nexport function f(){return 1}\n'.repeat(50)
  const out = filterTranscriptForDistill([tool({ content: src, toolName: 'Read', toolInputPath: '/a/b.ts' })])
  expect(out[0]!.content).toBe(`[file: /a/b.ts, 原文 ${src.split('\n').length} 行]`)
  expect(out[0]!.content).not.toContain('import')
})

test('Read tool result (isError) -> content unchanged', () => {
  const src = 'Error: file not found\nstack'.repeat(20)
  const out = filterTranscriptForDistill([tool({ content: src, toolName: 'Read', toolInputPath: '/x', isError: true })])
  expect(out[0]!.content).toBe(src)
})

test('Bash tool result -> truncated to 3000 + suffix', () => {
  const src = 'x'.repeat(5000)
  const out = filterTranscriptForDistill([tool({ content: src, toolName: 'Bash' })])
  expect(out[0]!.content.length).toBe(3000 + '…[truncated]'.length)
  expect(out[0]!.content).toContain('…[truncated]')
})

test('old payload (no toolName) long + code-like -> file placeholder', () => {
  const src = 'import a from "b"\n'.repeat(200)
  const out = filterTranscriptForDistill([tool({ content: src })])
  expect(out[0]!.content).toMatch(/^\[file: 未知路径, 原文 \d+ 行\]$/)
})

test('old payload (no toolName) long + no code feature -> truncated', () => {
  const src = 'plain text no code here '.repeat(200)
  const out = filterTranscriptForDistill([tool({ content: src })])
  expect(out[0]!.content).toContain('…[truncated]')
})

test('user/assistant over 20000 chars -> truncated', () => {
  const big = 'u'.repeat(25000)
  const out = filterTranscriptForDistill([
    { role: 'user', content: big },
    { role: 'assistant', content: big },
  ])
  expect(out[0]!.content.length).toBe(20000 + '…[truncated]'.length)
  expect(out[1]!.content.length).toBe(20000 + '…[truncated]'.length)
})

test('assistant text between 8000 and 20000 is NOT truncated (design rationale survives)', () => {
  // 第三层放开 origin discipline 后，设计 rationale（长段 assistant 文本）必须能完整
  // 进蒸馏输入。8000-20000 区间不再被腰斩。
  const mid = 'r'.repeat(15000)
  const out = filterTranscriptForDistill([{ role: 'assistant', content: mid }])
  expect(out[0]!.content).toBe(mid)
  expect(out[0]!.content).not.toContain('…[truncated]')
})

test('assistant text at exactly 20000 is not truncated; over 20000 is', () => {
  const exact = 'a'.repeat(20000)
  const over = 'a'.repeat(20001)
  expect(filterTranscriptForDistill([{ role: 'assistant', content: exact }])[0]!.content).toBe(exact)
  expect(filterTranscriptForDistill([{ role: 'assistant', content: over }])[0]!.content).toContain('…[truncated]')
})

test('empty string assistant passes through unchanged', () => {
  expect(filterTranscriptForDistill([{ role: 'assistant', content: '' }])[0]!.content).toBe('')
})

test('budget: drops oldest lowest-priority first; user + error kept; recent kept over old', () => {
  // 5 turns * 2000 chars = 5 * ~500 tokens = ~2500 tokens; budget 2000 forces drops.
  const turns: TranscriptTurn[] = [
    { role: 'assistant', content: 'A'.repeat(2000) },   // oldest assistant, p=2 -> dropped first
    { role: 'assistant', content: 'B'.repeat(2000) },   // p=2
    { role: 'tool', content: 'E'.repeat(2000), isError: true }, // p=1 -> kept
    { role: 'assistant', content: 'C'.repeat(2000) },   // newest assistant, p=2 -> kept over A
    { role: 'user', content: 'U'.repeat(2000) },         // p=0 -> kept
  ]
  const out = filterTranscriptForDistill(turns, 2000)
  const firsts = out.map((t) => t.content[0])
  expect(firsts).toContain('U')   // user kept
  expect(firsts).toContain('E')   // error kept
  expect(firsts).toContain('C')   // newest assistant kept (recent prioritized)
  expect(firsts).not.toContain('A') // oldest assistant dropped first
})

test('never throws on weird input', () => {
  expect(() => filterTranscriptForDistill(null as any)).not.toThrow()
  expect(() => filterTranscriptForDistill([])).not.toThrow()
})

test('DEFAULT_DISTILL_INPUT_BUDGET_TOKENS is 64000 (second-round widen)', () => {
  // TDD（第二轮）：用户确认不省 token，预算 12k->64k 给 distiller 更完整上下文判
  // subject/category。见 spec §3.5。
  expect(DEFAULT_DISTILL_INPUT_BUDGET_TOKENS).toBe(64000)
})

test('per-turn caps widened: non-tool 20000, tool 3000', async () => {
  // TDD：cap 翻倍。非文件 tool 结果截断到 3000；user/assistant 截断到 20000。
  const longTool = 'x'.repeat(5000)
  const longUser = 'y'.repeat(10000)
  const out = filterTranscriptForDistill([
    { role: 'tool', content: longTool, toolName: 'Bash' },
    { role: 'user', content: longUser },
  ])
  expect(out[0]!.content.length).toBeLessThanOrEqual(3000 + '…[truncated]'.length)
  expect(out[1]!.content.length).toBeLessThanOrEqual(20000 + '…[truncated]'.length)
})

// --- thinking 捕获（spec 2026-08-09 §4.2 同等对待）---

test('thinking turn 走非 tool 分支：20000 字符截断', () => {
  const turns: TranscriptTurn[] = [{ role: 'thinking', content: 'x'.repeat(25000) }]
  const out = filterTranscriptForDistill(turns)
  expect(out[0]!.role).toBe('thinking')
  expect(out[0]!.content.endsWith('…[truncated]')).toBe(true)
  expect(out[0]!.content.length).toBe(20000 + '…[truncated]'.length)
})

test('预算裁剪：thinking 与 assistant 同级（同 tier 最老先丢，user/错误必留）', () => {
  const big = 'y'.repeat(400) // 每条约 100 token
  const turns: TranscriptTurn[] = [
    { role: 'user', content: 'keep me' },
    { role: 'thinking', content: big },   // idx1，同 tier 中更老 -> 先丢
    { role: 'assistant', content: big },  // idx2
    { role: 'tool', content: 'err', isError: true },
  ]
  // 总量约 203 token；预算 150 -> 丢一条 p=2（最老的 thinking）即达标
  const out = filterTranscriptForDistill(turns, 150)
  expect(out.some((t) => t.role === 'user')).toBe(true)
  expect(out.some((t) => t.isError)).toBe(true)
  expect(out.some((t) => t.role === 'assistant')).toBe(true)
  expect(out.some((t) => t.role === 'thinking')).toBe(false)
})

test('预算裁剪区分场景：p=3 普通 tool 先于 thinking 被丢（锁 thinking 与 assistant 同为 p=2）', () => {
  const big = 'z'.repeat(400) // 每条约 100 token
  const turns: TranscriptTurn[] = [
    { role: 'user', content: 'keep me' },
    { role: 'thinking', content: big },
    { role: 'tool', content: big }, // 非错误 tool -> p=3，应先于 thinking 被丢
  ]
  const out = filterTranscriptForDistill(turns, 150)
  expect(out.some((t) => t.role === 'thinking')).toBe(true)
  expect(out.some((t) => t.role === 'tool')).toBe(false)
  expect(out.some((t) => t.role === 'user')).toBe(true)
})

// --- 工具调用信息捕获（spec 2026-08-09 §4.1）---

test('TOOL_INPUT_CAP_CHARS 常量锁定 300', () => {
  expect(TOOL_INPUT_CAP_CHARS).toBe(300)
})

test('预算计量含 toolCall：大 toolCall 计入预算，触发裁剪', () => {
  // 每条 toolCall 约 400 字符 = 100 token；content 极小
  const bigCall = 'y'.repeat(400)
  const turns: TranscriptTurn[] = Array.from({ length: 10 }, (_, i) => ({
    role: 'tool' as const,
    content: `out${i}`,
    toolName: 'Bash',
    toolCall: bigCall,
  }))
  // 10 条 × (content ~3 token + toolCall ~100 token) ≈ 1030 token；预算 500 -> 必须裁
  const out = filterTranscriptForDistill(turns, 500)
  expect(out.length).toBeLessThan(10)
})

import { test, expect } from 'bun:test'
import {
  filterTranscriptForDistill,
  DEFAULT_DISTILL_INPUT_BUDGET_TOKENS,
  type TranscriptTurn,
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

test('Bash tool result -> truncated to 1500 + suffix', () => {
  const src = 'x'.repeat(3000)
  const out = filterTranscriptForDistill([tool({ content: src, toolName: 'Bash' })])
  expect(out[0]!.content.length).toBe(1500 + '…[truncated]'.length)
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

test('user/assistant over 4000 chars -> truncated', () => {
  const big = 'u'.repeat(5000)
  const out = filterTranscriptForDistill([
    { role: 'user', content: big },
    { role: 'assistant', content: big },
  ])
  expect(out[0]!.content.length).toBe(4000 + '…[truncated]'.length)
  expect(out[1]!.content.length).toBe(4000 + '…[truncated]'.length)
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

test('DEFAULT_DISTILL_INPUT_BUDGET_TOKENS is 12000', () => {
  expect(DEFAULT_DISTILL_INPUT_BUDGET_TOKENS).toBe(12000)
})
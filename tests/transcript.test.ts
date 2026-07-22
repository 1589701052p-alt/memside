import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseTranscriptFile, extractText } from '@/claude/transcript'

/**
 * Tests for the claude code transcript JSONL parser (C3 fix).
 *
 * Locks in the real transcript shape verified against claude code 2.1.217's
 * bundle + a real local transcript JSONL: each line is one JSON object with a
 * `type` field; only `user` and `assistant` rows carry conversation. The
 * collector previously read an inline `body.transcript` array (always
 * undefined in production) -> empty turns -> distiller got nothing. These
 * tests prove `parseTranscriptFile` turns a real JSONL file into the
 * `TranscriptTurn[]` shape `detectErrorSignals` / the distiller expect.
 *
 * No DB, no mocking: real file writes to a per-test tmp dir, cleaned up after.
 */
const root = join(import.meta.dir, '.tmp-transcript')
let dir = ''

beforeAll(() => {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
})

beforeEach(() => {
  dir = join(root, Math.random().toString(36).slice(2))
  mkdirSync(dir, { recursive: true })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Write `lines` (one JSON object per arg) as a JSONL file, return its path. */
function writeJsonl(...lines: unknown[]): string {
  const p = join(dir, 't.jsonl')
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  return p
}

test('user string prompt -> {role:"user"}', () => {
  const p = writeJsonl({
    type: 'user',
    message: { role: 'user', content: 'what is the refund policy?' },
  })
  const turns = parseTranscriptFile(p)
  expect(turns).toEqual([{ role: 'user', content: 'what is the refund policy?' }])
})

test('user tool_result with is_error=true -> {role:"tool", isError:true}', () => {
  const p = writeJsonl({
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: 'Error: file not found', is_error: true },
      ],
    },
  })
  const turns = parseTranscriptFile(p)
  expect(turns).toEqual([{ role: 'tool', content: 'Error: file not found', isError: true }])
})

test('user tool_result with is_error absent -> isError false', () => {
  const p = writeJsonl({
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_2', content: [{ type: 'text', text: 'ok result' }] },
      ],
    },
  })
  const turns = parseTranscriptFile(p)
  expect(turns).toEqual([{ role: 'tool', content: 'ok result', isError: false }])
})

test('assistant text+thinking+tool_use -> only text becomes {role:"assistant"}', () => {
  const p = writeJsonl({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: "I'll read the file." },
        { type: 'thinking', thinking: 'internal reasoning here' },
        { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { path: '/x' } },
      ],
    },
  })
  const turns = parseTranscriptFile(p)
  // thinking + tool_use must be skipped: thinking would pollute retry
  // detection; tool_use's result is captured by the next user row's
  // tool_result.
  expect(turns).toEqual([{ role: 'assistant', content: "I'll read the file." }])
})

test('non-conversation row types are skipped', () => {
  const p = writeJsonl(
    { type: 'mode', mode: 'default' },
    { type: 'permission-mode', mode: 'default' },
    { type: 'last-prompt', prompt: 'x' },
    { type: 'file-history-snapshot', files: [] },
    { type: 'system', content: 'something' },
  )
  expect(parseTranscriptFile(p)).toEqual([])
})

test('empty file -> []', () => {
  const p = join(dir, 'empty.jsonl')
  writeFileSync(p, '')
  expect(parseTranscriptFile(p)).toEqual([])
})

test('missing file -> []', () => {
  expect(parseTranscriptFile(join(dir, 'does-not-exist.jsonl'))).toEqual([])
})

test('malformed lines mixed with valid -> valid extracted, malformed skipped', () => {
  // Interleave garbage with valid JSONL; the parser must not lose the valid
  // rows when one line fails to parse.
  const p = join(dir, 'mixed.jsonl')
  writeFileSync(
    p,
    [
      '{not valid json',
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'valid turn' } }),
      'this is also not json',
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }] } }),
      '',
    ].join('\n'),
  )
  const turns = parseTranscriptFile(p)
  expect(turns).toEqual([
    { role: 'user', content: 'valid turn' },
    { role: 'assistant', content: 'reply' },
  ])
})

test('order is preserved across user/assistant turns', () => {
  const p = writeJsonl(
    { type: 'user', message: { role: 'user', content: 'first' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'second' }] } },
    { type: 'user', message: { role: 'user', content: 'third' } },
  )
  const turns = parseTranscriptFile(p)
  expect(turns.map((t) => `${t.role}:${t.content}`)).toEqual([
    'user:first',
    'assistant:second',
    'user:third',
  ])
})

test('CRLF line endings parse correctly', () => {
  // Windows transcripts may use \r\n; the trim() per line strips the \r so
  // JSON.parse still succeeds.
  const p = join(dir, 'crlf.jsonl')
  const line1 = JSON.stringify({ type: 'user', message: { role: 'user', content: 'crlf ok' } })
  const line2 = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'yes' }] } })
  writeFileSync(p, `${line1}\r\n${line2}\r\n`)
  const turns = parseTranscriptFile(p)
  expect(turns).toEqual([
    { role: 'user', content: 'crlf ok' },
    { role: 'assistant', content: 'yes' },
  ])
})

// --- extractText unit cases -------------------------------------------------

test('extractText: string passthrough', () => {
  expect(extractText('hello')).toBe('hello')
})

test('extractText: array of text blocks joined', () => {
  expect(extractText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('ab')
})

test('extractText: non-text array items ignored', () => {
  expect(extractText([{ type: 'image', source: {} }, { type: 'text', text: 'only' }])).toBe('only')
})

test('extractText: other types -> empty string', () => {
  expect(extractText(42)).toBe('')
  expect(extractText(null)).toBe('')
  expect(extractText(undefined)).toBe('')
  expect(extractText({})).toBe('')
})

import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseTranscriptFile, extractText, subagentFilePathFromPayload, loadSubagentTranscript } from '@/claude/transcript'

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

test('assistant text+thinking+tool_use (no following tool_result) -> only text emitted; tool_use queued but unconsumed', () => {
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
  // thinking skipped; tool_use queued for the NEXT tool_result (none here) ->
  // no tool turn emitted.
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

test('assistant tool_use + following user tool_result -> paired tool turn with toolName + path', () => {
  const p = writeJsonl(
    { type: 'assistant', message: { role: 'assistant', content: [
      { type: 'text', text: 'reading' },
      { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/a/b.ts' } },
    ] } },
    { type: 'user', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'toolu_1', content: 'export const x = 1' },
    ] } },
  )
  const turns = parseTranscriptFile(p)
  expect(turns).toEqual([
    { role: 'assistant', content: 'reading' },
    { role: 'tool', content: 'export const x = 1', isError: false, toolName: 'Read', toolInputPath: '/a/b.ts' },
  ])
})

test('multiple tool_use consumed in order across following tool_results', () => {
  const p = writeJsonl(
    { type: 'assistant', message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'u1', name: 'Read', input: { file_path: '/f1' } },
      { type: 'tool_use', id: 'u2', name: 'Bash', input: { command: 'ls' } },
    ] } },
    { type: 'user', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'u1', content: 'f1-content' },
      { type: 'tool_result', tool_use_id: 'u2', content: 'ls-output' },
    ] } },
  )
  const turns = parseTranscriptFile(p)
  expect(turns.filter((t) => t.role === 'tool')).toEqual([
    { role: 'tool', content: 'f1-content', isError: false, toolName: 'Read', toolInputPath: '/f1' },
    { role: 'tool', content: 'ls-output', isError: false, toolName: 'Bash' },
  ])
})

test('orphan tool_result (no preceding tool_use) -> tool turn without toolName', () => {
  const p = writeJsonl(
    { type: 'user', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'orphan', content: 'lonely' },
    ] } },
  )
  const turns = parseTranscriptFile(p)
  expect(turns).toEqual([{ role: 'tool', content: 'lonely', isError: false }])
})

// --- subagentFilePathFromPayload unit cases -----------------------------------

test('subagentFilePathFromPayload: normal main-session path -> subagent file path', () => {
  const tp = '/home/u/.claude/projects/C--repo/abc-123.jsonl'
  expect(subagentFilePathFromPayload(tp, 'a0696f74')).toBe(
    '/home/u/.claude/projects/C--repo/abc-123/subagents/agent-a0696f74.jsonl',
  )
})

test('subagentFilePathFromPayload: Windows-style path', () => {
  const tp = 'C:\\Users\\u\\.claude\\projects\\C--repo\\abc-123.jsonl'
  expect(subagentFilePathFromPayload(tp, 'xyz')).toBe(
    'C:\\Users\\u\\.claude\\projects\\C--repo\\abc-123\\subagents\\agent-xyz.jsonl',
  )
})

test('subagentFilePathFromPayload: agentId empty -> null', () => {
  expect(subagentFilePathFromPayload('/x/abc.jsonl', '')).toBeNull()
  expect(subagentFilePathFromPayload('/x/abc.jsonl', null)).toBeNull()
  expect(subagentFilePathFromPayload('/x/abc.jsonl', undefined)).toBeNull()
})

test('subagentFilePathFromPayload: non-jsonl transcriptPath -> null', () => {
  expect(subagentFilePathFromPayload('/x/abc.txt', 'ag')).toBeNull()
  expect(subagentFilePathFromPayload('/x/abc', 'ag')).toBeNull()
})

test('subagentFilePathFromPayload: empty transcriptPath -> null', () => {
  expect(subagentFilePathFromPayload('', 'ag')).toBeNull()
})

// --- loadSubagentTranscript double-fallback (Task 5) -------------------------

test('loadSubagentTranscript: agent_id path hit -> parses subagent file', () => {
  // 主会话 dir/sess-1.jsonl；subagent 文件 dir/sess-1/subagents/agent-AG.jsonl
  mkdirSync(join(dir, 'sess-1', 'subagents'), { recursive: true })
  const mainPath = join(dir, 'sess-1.jsonl')
  writeFileSync(mainPath, JSON.stringify({ type: 'user', message: { role: 'user', content: 'MAIN SESSION' } }) + '\n')
  const subPath = join(dir, 'sess-1', 'subagents', 'agent-AG.jsonl')
  writeFileSync(subPath, JSON.stringify({ type: 'user', message: { role: 'user', content: 'SUBAGENT INTERNAL' } }) + '\n')
  const turns = loadSubagentTranscript(mainPath, 'AG')
  expect(turns.length).toBe(1)
  expect(turns[0]!.content).toBe('SUBAGENT INTERNAL')
  expect(turns[0]!.content).not.toBe('MAIN SESSION')
})

test('loadSubagentTranscript: agent_id path miss -> falls back to transcript_path', () => {
  const mainPath = join(dir, 'sess-2.jsonl')
  writeFileSync(mainPath, JSON.stringify({ type: 'user', message: { role: 'user', content: 'FALLBACK TO MAIN' } }) + '\n')
  // 不建 subagents 目录 -> 推路径读不到 -> 退回 mainPath
  const turns = loadSubagentTranscript(mainPath, 'NOPE')
  expect(turns.length).toBe(1)
  expect(turns[0]!.content).toBe('FALLBACK TO MAIN')
})

test('loadSubagentTranscript: both miss -> empty (no throw)', () => {
  const turns = loadSubagentTranscript(join(dir, 'nope.jsonl'), 'AG')
  expect(turns).toEqual([])
  // agentId 空 + 无 transcript_path 也空
  expect(loadSubagentTranscript('', 'AG')).toEqual([])
  expect(loadSubagentTranscript(join(dir, 'x.jsonl'), '')).toEqual([])
})

import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseTranscriptFile, extractText, subagentFilePathFromPayload, loadSubagentTranscript, resolveSubagentTranscript } from '@/claude/transcript'
import { detectErrorSignals } from '@/memory/pure'

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

test('assistant text+thinking+tool_use -> thinking turn + text turn 均产出；tool_use queued but unconsumed', () => {
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
  // thinking 捕获（spec §4.1）按文件顺序原位插入；tool_use queued for the NEXT
  // tool_result (none here) -> no tool turn emitted.
  expect(turns).toEqual([
    { role: 'assistant', content: "I'll read the file." },
    { role: 'thinking', content: 'internal reasoning here' },
  ])
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
    { role: 'tool', content: 'export const x = 1', isError: false, toolName: 'Read', toolInputPath: '/a/b.ts', toolCall: '{"file_path":"/a/b.ts"}' },
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
    { role: 'tool', content: 'f1-content', isError: false, toolName: 'Read', toolInputPath: '/f1', toolCall: '{"file_path":"/f1"}' },
    { role: 'tool', content: 'ls-output', isError: false, toolName: 'Bash', toolCall: '{"command":"ls"}' },
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

// --- thinking 捕获（spec 2026-08-09 §4.1）---

test('thinking block 在 text 之前时按文件顺序先产出', () => {
  const p = writeJsonl({
    type: 'assistant',
    message: { role: 'assistant', content: [
      { type: 'thinking', thinking: 'plan first' },
      { type: 'text', text: 'visible answer' },
    ] },
  })
  expect(parseTranscriptFile(p)).toEqual([
    { role: 'thinking', content: 'plan first' },
    { role: 'assistant', content: 'visible answer' },
  ])
})

test('redacted_thinking / thinking 缺文本字段 -> 跳过不产出 thinking turn', () => {
  const p = writeJsonl({
    type: 'assistant',
    message: { role: 'assistant', content: [
      { type: 'redacted_thinking', data: 'abc' },
      { type: 'thinking' },
      { type: 'thinking', thinking: 42 },
      { type: 'text', text: 'answer' },
    ] },
  })
  expect(parseTranscriptFile(p)).toEqual([{ role: 'assistant', content: 'answer' }])
})

test('retry 检测不受 thinking 污染：重复 thinking 内容不计 retries', () => {
  const p = writeJsonl(
    { type: 'assistant', message: { role: 'assistant', content: [
      { type: 'thinking', thinking: 'same reasoning' }, { type: 'text', text: 'first answer' } ] } },
    { type: 'assistant', message: { role: 'assistant', content: [
      { type: 'thinking', thinking: 'same reasoning' }, { type: 'text', text: 'second answer' } ] } },
  )
  const signals = detectErrorSignals(parseTranscriptFile(p))
  expect(signals.retries).toBe(0)
})

// --- 工具调用信息捕获（spec 2026-08-09 §4.1）---

test('Bash tool_use input -> 配对 tool turn 带 toolCall（含 command）', () => {
  const p = writeJsonl(
    { type: 'assistant', message: { role: 'assistant', content: [
      { type: 'text', text: 'run tests' },
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'bun test', description: '跑测试' } },
    ] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'all pass' }] } },
  )
  const turns = parseTranscriptFile(p)
  const toolTurn = turns.find((t) => t.role === 'tool')
  expect(toolTurn?.toolCall).toBe('{"command":"bun test","description":"跑测试"}')
})

test('tool_use input 缺失/非对象 -> toolCall 不设置', () => {
  const p = writeJsonl(
    { type: 'assistant', message: { role: 'assistant', content: [
      { type: 'tool_use', id: 't1', name: 'Bash', input: 'notobj' },
    ] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
  )
  const turns = parseTranscriptFile(p)
  const toolTurn = turns.find((t) => t.role === 'tool')
  expect(toolTurn?.toolCall).toBeUndefined()
})

test('tool_use input 超 300 字 -> toolCall 截断带后缀', () => {
  const longCmd = 'x'.repeat(500)
  const p = writeJsonl(
    { type: 'assistant', message: { role: 'assistant', content: [
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: longCmd } },
    ] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
  )
  const turns = parseTranscriptFile(p)
  const toolTurn = turns.find((t) => t.role === 'tool')
  expect(toolTurn?.toolCall).toBeDefined()
  expect(toolTurn!.toolCall!.endsWith('…[truncated]')).toBe(true)
  // 截断后长度 = 300 + 后缀（JSON 包装部分会超 300，截在 300 处）
  expect(toolTurn!.toolCall!.length).toBe(300 + '…[truncated]'.length)
})

// --- resolveSubagentTranscript (spec 2026-08-15 §5.2)：不兜底主会话，带取证 diag ---

test('resolveSubagentTranscript: 文件存在 -> turns + diag 全字段', () => {
  // 夹具：main.jsonl + main/subagents/agent-AG.jsonl（内容同既有用例）
  mkdirSync(join(dir, 'main', 'subagents'), { recursive: true })
  const mainPath = join(dir, 'main.jsonl')
  writeFileSync(mainPath, JSON.stringify({ type: 'user', message: { role: 'user', content: 'MAIN SESSION' } }) + '\n')
  const subPath = join(dir, 'main', 'subagents', 'agent-AG.jsonl')
  writeFileSync(subPath, JSON.stringify({ type: 'user', message: { role: 'user', content: 'SUBAGENT INTERNAL' } }) + '\n')
  const { turns, diag } = resolveSubagentTranscript(mainPath, 'AG')
  expect(turns.length).toBeGreaterThan(0)
  expect(diag.derivedExists).toBe(true)
  expect(diag.derivedTurns).toBe(turns.length)
  expect(diag.mainTranscriptExists).toBe(true)
  expect(diag.subagentsDirEntries).toContain('agent-AG.jsonl')
  expect(diag.derivedPath).toContain('agent-AG.jsonl')
})

test('resolveSubagentTranscript: 文件缺失 -> 空 turns，不读主会话（行为锁）', () => {
  // 夹具同上但无 agent-NOPE.jsonl；主会话文件有内容
  mkdirSync(join(dir, 'main', 'subagents'), { recursive: true })
  const mainPath = join(dir, 'main.jsonl')
  writeFileSync(mainPath, JSON.stringify({ type: 'user', message: { role: 'user', content: 'MAIN SESSION' } }) + '\n')
  const subPath = join(dir, 'main', 'subagents', 'agent-AG.jsonl')
  writeFileSync(subPath, JSON.stringify({ type: 'user', message: { role: 'user', content: 'SUBAGENT INTERNAL' } }) + '\n')
  const { turns, diag } = resolveSubagentTranscript(mainPath, 'NOPE')
  expect(turns).toEqual([])          // 旧行为会退回主会话返回非空——此断言锁死新行为
  expect(diag.derivedExists).toBe(false)
  expect(diag.derivedTurns).toBe(0)
  expect(diag.mainTranscriptExists).toBe(true)   // 主文件存在也不读
  expect(diag.subagentsDirEntries).toContain('agent-AG.jsonl')  // 目录现场仍取证
})

test('resolveSubagentTranscript: 畸形输入永不抛 + 目录不存在时 listing 为 []', () => {
  expect(resolveSubagentTranscript('', 'AG').turns).toEqual([])
  expect(resolveSubagentTranscript(join(dir, 'nope.jsonl'), 'AG').diag.subagentsDirEntries).toEqual([])
  expect(resolveSubagentTranscript(join(dir, 'x.jsonl'), '').diag.derivedPath).toBeNull()
})

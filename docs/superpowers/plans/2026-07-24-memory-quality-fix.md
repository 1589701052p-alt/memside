# 记忆质量修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消除 distiller 的代码复述型记忆、修 valueFilter 倒挂、修 dedup 同义改写失效，让留存候选质量从"82% 代码复述"降到可审批水平。

**Architecture:** 蒸馏侧加纯函数 `filterTranscriptForDistill`（配对 tool_use、按工具类型压缩源码、token 预算近期优先）；valueFilter 加代码逻辑门保护 invariant/integration/compliance（force keep + valueClass=decision）+ 提示词定义澄清；dedup 前置到 valueFilter 之前并覆盖同批兄弟+跨批。全部以纯函数为实现主体。

**Tech Stack:** Bun + TypeScript + bun:test + drizzle + bun:sqlite。测试用 mock `callLLM: (system, user) => Promise<string>`。

## Global Constraints

- 分支 `feat/memory-quality-fix`，从 `origin/master` 切出；禁止直推 master。
- 输入预算 `DEFAULT_DISTILL_INPUT_BUDGET_TOKENS = 12000`；tool 结果截断 `1500` 字符；非 tool 单条截断 `4000`。
- `FILE_TOOLS = {Read, Edit, Write, MultiEdit, NotebookEdit}`。
- valueFilter 受保护类别 `VALUE_PROTECTED_CATEGORIES = {invariant, integration, compliance}` -> force keep + `valueClass='decision'`（非 null，免疫 Web UI"批量拒绝未评估"按钮，该按钮 target `value_class IS NULL`）。
- **valueFilter 提示词 neutrality 硬约束**（`tests/valueFilter.test.ts:83`）：prompt 不得含 `keep/discard/reject/avoid/important/valuable/unsure/cautious/careful/don't/dangerous`。保护业务规则只靠代码逻辑门，不靠 prompt 引导。
- `detectErrorSignals` 跑在**过滤前**的原始 turns 上（错误信号不丢）；`renderUserPrompt` 用**过滤后** turns。
- dedup 移到 valueFilter **之前**；调用顺序变为 `distill -> dedup -> judgeValue`。
- LLM 输出 `max_tokens=8192` 不变（`src/anthropic.ts`/`src/openai.ts` 不动）；本次只改输入侧。
- 运行门槛：`bun run typecheck && bun test` 全绿才能 push。
- DB 253MB 膨胀 / 保留策略：本次不做（非目标）。

## File Structure

- `src/memory/pure.ts` — 扩展 `TranscriptTurn`（+`toolName`/`toolInputPath`）；新增 `filterTranscriptForDistill` + 常量。
- `src/claude/transcript.ts` — `parseTranscriptFile` 配对 tool_use↔tool_result，提取 toolName/toolInputPath。
- `src/memory/distiller.ts` — `distillTranscript` 接入过滤；`DISTILLER_SYSTEM_PROMPT` 加 REJECT 条款。
- `src/memory/valueFilter.ts` — 新增 `parseCategory`/`VALUE_PROTECTED_CATEGORIES` + 逻辑门；提示词定义澄清。
- `src/memory/dedup.ts` — `judgeDuplicates` 覆盖同批兄弟+跨批；短路与 prompt/shouldRetry 调整。
- `src/scheduler.ts` — `tick` 重排（dedup 前置），去掉 valueClass 重挂 hack。
- 测试：`tests/pure-transcript-filter.test.ts`（新）；`tests/transcript.test.ts`、`tests/valueFilter.test.ts`、`tests/dedup.test.ts`、`tests/distiller.test.ts`、`tests/scheduler.test.ts`（更新）。

---

### Task 1: TranscriptTurn 扩展 + filterTranscriptForDistill（pure.ts）

**Files:**
- Modify: `src/memory/pure.ts`（`TranscriptTurn` 接口 + 文件末尾追加）
- Test: `tests/pure-transcript-filter.test.ts`（新建）

**Interfaces:**
- Produces: `TranscriptTurn`（+`toolName?: string`、`toolInputPath?: string`）、`filterTranscriptForDistill(turns, budgetTokens?) => TranscriptTurn[]`、`DEFAULT_DISTILL_INPUT_BUDGET_TOKENS`。Task 2/3 消费。

- [ ] **Step 1: 写失败测试** `tests/pure-transcript-filter.test.ts`

```ts
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test tests/pure-transcript-filter.test.ts`
Expected: FAIL — `filterTranscriptForDistill` 未导出 / `DEFAULT_DISTILL_INPUT_BUDGET_TOKENS` 未导出。

- [ ] **Step 3: 扩展 TranscriptTurn 接口**

Modify `src/memory/pure.ts`，把现有 `TranscriptTurn`（约 75-79 行）替换为：

```ts
export interface TranscriptTurn {
  role: 'user' | 'assistant' | 'tool' | 'system'
  content: string
  isError?: boolean
  /** 配对自前一个 assistant 行的 tool_use 块；仅 role==='tool' 有值。 */
  toolName?: string
  /** 提取自 tool_use.input（file_path / notebook_path / path）；仅文件类工具有值。 */
  toolInputPath?: string
}
```

- [ ] **Step 4: 在 `src/memory/pure.ts` 文件末尾追加过滤实现**

```ts

// ---------------------------------------------------------------------------
// Distill-time transcript filtering. Pure; never throws.
// ---------------------------------------------------------------------------

export const DEFAULT_DISTILL_INPUT_BUDGET_TOKENS = 12000

const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const TOOL_RESULT_CAP_CHARS = 1500
const NON_TOOL_CAP_CHARS = 4000
const CODE_FEATURE_RE = /(^|\n)\s*(import |export |function |const |class |interface |def |async |return )/
const INDENT_RE = /\n( {4,}|\t+)\S/

function looksLikeCode(s: string): boolean {
  if (CODE_FEATURE_RE.test(s)) return true
  return (s.match(/\n/g)?.length ?? 0) >= 4 && INDENT_RE.test(s)
}

function lineCount(s: string): number {
  if (s.length === 0) return 0
  return s.split('\n').length
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max) + '…[truncated]'
}

function compactToolTurn(t: TranscriptTurn): TranscriptTurn {
  if (t.isError) return { ...t }
  if (t.toolName && FILE_TOOLS.has(t.toolName)) {
    return { ...t, content: `[file: ${t.toolInputPath ?? '未知路径'}, 原文 ${lineCount(t.content)} 行]` }
  }
  if (t.toolName) {
    return { ...t, content: truncate(t.content, TOOL_RESULT_CAP_CHARS) }
  }
  // 老 payload（无 toolName）启发式
  if (t.content.length > TOOL_RESULT_CAP_CHARS && looksLikeCode(t.content)) {
    return { ...t, content: `[file: 未知路径, 原文 ${lineCount(t.content)} 行]` }
  }
  return { ...t, content: truncate(t.content, TOOL_RESULT_CAP_CHARS) }
}

function turnPriority(t: TranscriptTurn): number {
  if (t.role === 'user') return 0
  if (t.role === 'tool' && t.isError) return 1
  if (t.role === 'assistant') return 2
  if (t.role === 'tool') return 3
  return 4
}

/**
 * Filter a parsed transcript for distill-time input: compact file-source tool
 * results to a one-line placeholder, cap command/test outputs, keep errors
 * verbatim, then apply a token budget (recent + user/error prioritized).
 *
 * Pure + never throws (degrades to truncated/identity on any error).
 * `detectErrorSignals` must run on the ORIGINAL turns (before this filter),
 * since budget clipping could drop user negations / tool failures.
 */
export function filterTranscriptForDistill(
  turns: readonly TranscriptTurn[],
  budgetTokens: number = DEFAULT_DISTILL_INPUT_BUDGET_TOKENS,
): TranscriptTurn[] {
  if (!Array.isArray(turns)) return []
  try {
    const compacted = turns.map((t) =>
      t.role === 'tool' ? compactToolTurn(t) : { ...t, content: truncate(t.content, NON_TOOL_CAP_CHARS) },
    )
    const used = () => compacted.reduce((s, t) => s + estimateTokens(t.content), 0)
    if (used() <= budgetTokens) return compacted
    const droppable = compacted
      .map((t, i) => ({ i, p: turnPriority(t) }))
      .filter((x) => x.p > 1) // never drop user(0) or error-tool(1)
      .sort((a, b) => b.p - a.p || a.i - b.i) // least important first, oldest first
    let tokens = used()
    const drop = new Set<number>()
    for (const x of droppable) {
      if (tokens <= budgetTokens) break
      drop.add(x.i)
      tokens -= estimateTokens(compacted[x.i]!.content)
    }
    return compacted.filter((_, i) => !drop.has(i))
  } catch {
    return [...turns]
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `bun test tests/pure-transcript-filter.test.ts`
Expected: PASS（全部用例）。

- [ ] **Step 6: typecheck + 全量回归**

Run: `bun run typecheck && bun test`
Expected: typecheck 干净；现有测试全绿（`TranscriptTurn` 新字段可选，不破坏既有断言）。

- [ ] **Step 7: Commit**

```bash
git add src/memory/pure.ts tests/pure-transcript-filter.test.ts
git commit -m "feat(memory): add filterTranscriptForDistill pure function + TranscriptTurn fields"
```

---

### Task 2: parseTranscriptFile 配对 tool_use（transcript.ts）

**Files:**
- Modify: `src/claude/transcript.ts`（JSDoc + assistant/user 分支 + 新 helper）
- Test: `tests/transcript.test.ts`（更新现有 tool_use 测试 + 新增配对测试）

**Interfaces:**
- Consumes: `TranscriptTurn.toolName`/`toolInputPath`（Task 1）。
- Produces: `parseTranscriptFile` 输出的 tool turn 现在带 `toolName`/`toolInputPath`。

- [ ] **Step 1: 写失败测试** — 在 `tests/transcript.test.ts` 末尾追加：

```ts
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
```

并更新现有测试 `assistant text+thinking+tool_use -> only text becomes {role:"assistant"}`（约 80-97 行）的注释与断言，反映 tool_use 现在是"配对"而非"跳过"——该测试无后续 tool_result，故 tool_use 入队后无消费者，输出仍只有 assistant text（断言不变，仅改注释）：

```ts
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test tests/transcript.test.ts`
Expected: FAIL — 新配对测试断言 `toolName` 不存在（当前 tool_use 被丢弃，tool_result 无 toolName）。

- [ ] **Step 3: 更新 parseTranscriptFile JSDoc**

Modify `src/claude/transcript.ts` 的 `parseTranscriptFile` JSDoc（约 37-61 行），把"tool_use SKIPPED"段改为"tool_use 配对到后续 tool_result"：

把：
```
 * - `type:"assistant"`: each `{type:'text'}` item -> `{role:'assistant', content}`.
 *   `{type:'thinking'}` is SKIPPED (internal reasoning would pollute retry
 *   detection). `{type:'tool_use'}` is SKIPPED (its result is captured by the
 *   tool_result on the following user row).
```
改为：
```
 * - `type:"assistant"`: each `{type:'text'}` item -> `{role:'assistant', content}`.
 *   `{type:'thinking'}` is SKIPPED (internal reasoning would pollute retry
 *   detection). `{type:'tool_use'}` is QUEUED (name + file_path extracted) and
 *   paired FIFO with the following user row's `tool_result` blocks, so the
 *   distill-time filter can compact file-source results by tool name.
```

- [ ] **Step 4: 加 helper + 配对游标，改 assistant/user 分支**

在 `extractText` 函数之后、`parseTranscriptFile` 之前加：

```ts
/**
 * Extract a file path from a tool_use `input` object, checking common keys.
 * Used to pair `toolName` + `toolInputPath` onto the following tool_result.
 */
function extractToolInputPath(input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  const o = input as Record<string, unknown>
  for (const k of ['file_path', 'notebook_path', 'path', 'filePath']) {
    const v = o[k]
    if (typeof v === 'string') return v
  }
  return undefined
}
```

在 `parseTranscriptFile` 内、`for (const line of lines)` 循环之前加配对游标：

```ts
    // Pending tool_use blocks from the most recent assistant message,
    // consumed FIFO by following user-row tool_result blocks.
    const pendingToolUses: { name: string; inputPath?: string }[] = []
```

把 user 分支里 `tool_result` 的 push（约 105-110 行）：
```ts
                if (it.type === 'tool_result') {
                  turns.push({
                    role: 'tool',
                    content: extractText(it.content),
                    isError: it.is_error === true,
                  })
                }
```
改为：
```ts
                if (it.type === 'tool_result') {
                  const paired = pendingToolUses.shift()
                  const base = {
                    role: 'tool' as const,
                    content: extractText(it.content),
                    isError: it.is_error === true,
                  }
                  turns.push(
                    paired
                      ? { ...base, toolName: paired.name, ...(paired.inputPath ? { toolInputPath: paired.inputPath } : {}) }
                      : base,
                  )
                }
```

把 assistant 分支里 `tool_use` 的处理（约 122-127 行）：
```ts
              const it = item as { type?: unknown; text?: unknown }
              if (it.type === 'text' && typeof it.text === 'string') {
                turns.push({ role: 'assistant', content: it.text })
              }
              // thinking + tool_use are deliberately skipped (see JSDoc above).
```
改为：
```ts
              const it = item as { type?: unknown; text?: unknown; name?: unknown; input?: unknown }
              if (it.type === 'text' && typeof it.text === 'string') {
                turns.push({ role: 'assistant', content: it.text })
              } else if (it.type === 'tool_use' && typeof it.name === 'string') {
                pendingToolUses.push({ name: it.name, inputPath: extractToolInputPath(it.input) })
              }
              // thinking is deliberately skipped (see JSDoc above).
```

- [ ] **Step 5: 运行测试确认通过**

Run: `bun test tests/transcript.test.ts`
Expected: PASS（新配对测试 + 现有测试；现有 `user tool_result` 无前导 tool_use 的测试仍通过，因配对游标为空 -> 无 toolName 的 base turn，`toEqual` 相等）。

- [ ] **Step 6: typecheck + 全量回归**

Run: `bun run typecheck && bun test`
Expected: 全绿。

- [ ] **Step 7: Commit**

```bash
git add src/claude/transcript.ts tests/transcript.test.ts
git commit -m "feat(transcript): pair tool_use with tool_result (toolName + toolInputPath)"
```

---

### Task 3: distiller 接入过滤 + prompt REJECT（distiller.ts）

**Files:**
- Modify: `src/memory/distiller.ts`（`distillTranscript` + `DISTILLER_SYSTEM_PROMPT`）
- Test: `tests/distiller.test.ts`

**Interfaces:**
- Consumes: `filterTranscriptForDistill`（Task 1）。
- Produces: distiller 传给 LLM 的 user prompt 不含文件源码。

- [ ] **Step 1: 写失败测试** — 在 `tests/distiller.test.ts` 末尾追加：

```ts
test('distillTranscript filters file-source Read results out of the LLM prompt', async () => {
  let captured = ''
  await distillTranscript({
    turns: [
      { role: 'user', content: 'read the file' },
      { role: 'tool', content: 'SECRET_SOURCE_CODE_LINE'.repeat(200), toolName: 'Read', toolInputPath: '/a.ts' },
    ],
    runtime: 'claude-code', cwd: '/r',
    callLLM: async (_sys, user) => { captured = user; return JSON.stringify({ candidates: [] }) },
  })
  expect(captured).toContain('[file: /a.ts')
  expect(captured).not.toContain('SECRET_SOURCE_CODE_LINE')
})

test('detectErrorSignals still sees original (unfiltered) tool failure', async () => {
  // An error tool turn must still be counted as a tool failure for signals,
  // even though filtering keeps errors verbatim. We assert the prompt carries
  // the error content (filter keeps errors) AND the signals JSON shows 1 failure.
  let captured = ''
  await distillTranscript({
    turns: [
      { role: 'tool', content: 'boom', toolName: 'Bash', isError: true },
    ],
    runtime: 'claude-code', cwd: '/r',
    callLLM: async (_sys, user) => { captured = user; return JSON.stringify({ candidates: [] }) },
  })
  expect(captured).toContain('"toolFailures":1')
  expect(captured).toContain('boom')
})

test('DISTILLER_SYSTEM_PROMPT rejects codebase implementation details', () => {
  expect(DISTILLER_SYSTEM_PROMPT).toContain('被开发仓库自身源码的实现细节')
})
```

并在文件顶部 import 行确认导入了 `distillTranscript, DISTILLER_SYSTEM_PROMPT`（若已导入则跳过）。

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test tests/distiller.test.ts`
Expected: FAIL — 当前 `renderUserPrompt` 用原始 turns，prompt 含 `SECRET_SOURCE_CODE_LINE`；prompt 无"被开发仓库自身源码"条款。

- [ ] **Step 3: 改 distillTranscript 接入过滤**

Modify `src/memory/distiller.ts`，把 `distillTranscript` 内（约 96-97 行）：
```ts
    const signals = detectErrorSignals(input.turns)
    const userPrompt = renderUserPrompt(input.turns, input.runtime, input.cwd, signals)
```
改为：
```ts
    const signals = detectErrorSignals(input.turns)
    const filtered = filterTranscriptForDistill(input.turns)
    const userPrompt = renderUserPrompt(filtered, input.runtime, input.cwd, signals)
```
并在顶部 import 加 `filterTranscriptForDistill`：
```ts
import { detectErrorSignals, filterTranscriptForDistill, type TranscriptTurn, type MemoryScope, type RuntimeTag } from './pure'
```

- [ ] **Step 4: 给 DISTILLER_SYSTEM_PROMPT 加 REJECT 条款**

在 `DISTILLER_SYSTEM_PROMPT` 的 `REJECT (emit nothing) if the content is a fleeting status update, mood, or one-off acknowledgement.` 行之后追加：

```
Also REJECT 被开发仓库自身源码的实现细节（文件内容、内部实现、配置默认值、符号名）--这些可从仓库源码重新推导，不是持久记忆。把记忆锚定到用户或领域明确陈述的规则、决策与约束；不要总结 agent 读到的文件内容。
```

- [ ] **Step 5: 运行测试确认通过**

Run: `bun test tests/distiller.test.ts`
Expected: PASS。

- [ ] **Step 6: typecheck + 全量回归**

Run: `bun run typecheck && bun test`
Expected: 全绿。

- [ ] **Step 7: Commit**

```bash
git add src/memory/distiller.ts tests/distiller.test.ts
git commit -m "feat(distiller): filter transcript before prompt + reject codebase impl details"
```

---

### Task 4: valueFilter 逻辑门 + 提示词定义澄清（valueFilter.ts）

**Files:**
- Modify: `src/memory/valueFilter.ts`（`parseCategory`/`VALUE_PROTECTED_CATEGORIES` + `judgeValue` 门 + prompt）
- Test: `tests/valueFilter.test.ts`

**Interfaces:**
- Produces: `parseCategory(title) => string | null`、`VALUE_PROTECTED_CATEGORIES`。受保护类别候选在 `judgeValue` 中强制 `keep:true, valueClass:'decision'`。Task 6 依赖此行为。

- [ ] **Step 1: 写失败测试** — 在 `tests/valueFilter.test.ts` 末尾追加：

```ts
import { parseCategory, VALUE_PROTECTED_CATEGORIES } from '@/memory/valueFilter'

const prot = (cat: string) => cand(`[category:${cat}] some business rule`, 'b')

test('parseCategory extracts lowercased category', () => {
  expect(parseCategory('[category:Invariant] X')).toBe('invariant')
  expect(parseCategory('[category:integration] X')).toBe('integration')
  expect(parseCategory('no prefix here')).toBeNull()
})

test('VALUE_PROTECTED_CATEGORIES = invariant/integration/compliance', () => {
  expect(VALUE_PROTECTED_CATEGORIES.has('invariant')).toBe(true)
  expect(VALUE_PROTECTED_CATEGORIES.has('integration')).toBe(true)
  expect(VALUE_PROTECTED_CATEGORIES.has('compliance')).toBe(true)
  expect(VALUE_PROTECTED_CATEGORIES.has('architecture')).toBe(false)
})

test('judgeValue force-keeps protected invariant even when LLM says derivable', async () => {
  const v = await judgeValue([prot('invariant')], async () => verdictsJson({ index: 0, category: 'derivable' }))
  expect(v).toEqual([{ index: 0, keep: true, valueClass: 'decision' }])
})

test('judgeValue force-keeps protected integration/compliance with valueClass=decision', async () => {
  const v = await judgeValue([prot('integration'), prot('compliance')], async () => verdictsJson(
    { index: 0, category: 'public-knowledge' },
    { index: 1, category: 'derivable' },
  ))
  expect(v).toEqual([
    { index: 0, keep: true, valueClass: 'decision' },
    { index: 1, keep: true, valueClass: 'decision' },
  ])
})

test('judgeValue force-keeps protected category even when LLM throws', async () => {
  const v = await judgeValue([prot('invariant')], async () => { throw new Error('down') })
  expect(v).toEqual([{ index: 0, keep: true, valueClass: 'decision' }])
})

test('non-protected category still discards normally', async () => {
  // architecture is NOT protected -> derivable discards it (code-restating case)
  const v = await judgeValue([cand('[category:architecture] how module X works', 'b')], async () => verdictsJson({ index: 0, category: 'derivable' }))
  expect(v).toEqual([{ index: 0, keep: false, reason: 'derivable' }])
})

test('VALUE_JUDGE_SYSTEM_PROMPT has sharpened derivable + public-knowledge definitions', () => {
  expect(VALUE_JUDGE_SYSTEM_PROMPT).toContain('codebase being worked on')
  expect(VALUE_JUDGE_SYSTEM_PROMPT).toContain('do not belong here')
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test tests/valueFilter.test.ts`
Expected: FAIL — `parseCategory`/`VALUE_PROTECTED_CATEGORIES` 未导出；受保护类别当前按 LLM 判定丢弃；prompt 无新定义。

- [ ] **Step 3: 加 parseCategory + VALUE_PROTECTED_CATEGORIES**

在 `src/memory/valueFilter.ts` 的 `VALID_CATEGORIES` 定义附近加：

```ts
export function parseCategory(title: string): string | null {
  const m = /^\s*\[category:([^\]]+)\]/i.exec(title)
  if (!m) return null
  return m[1]!.trim().toLowerCase()
}

/** Distill categories whose candidates valueFilter must NEVER discard:
 *  business hard rules / external contracts / regulatory constraints.
 *  Force-kept with valueClass='decision' (non-null -> immune to the Web UI
 *  "批量拒绝未评估" button, which targets value_class IS NULL). */
export const VALUE_PROTECTED_CATEGORIES = new Set(['invariant', 'integration', 'compliance'])
```

- [ ] **Step 4: 在 judgeValue 末尾应用逻辑门**

把 `judgeValue` 的 return（约 112 行）：
```ts
    return candidates.map((_, i) => byIndex.get(i) ?? { index: i, keep: true, valueClass: null })
```
改为：
```ts
    return candidates.map((c, i) => {
      if (VALUE_PROTECTED_CATEGORIES.has(parseCategory(c.title))) {
        return { index: i, keep: true, valueClass: 'decision' as ValueClass }
      }
      return byIndex.get(i) ?? { index: i, keep: true, valueClass: null }
    })
```

注意：`keepNull`（LLM 失败兜底，约 87-88 行）也要尊重门——把：
```ts
  const keepNull = (): ValueVerdict[] =>
    candidates.map((_, i) => ({ index: i, keep: true, valueClass: null }))
```
改为：
```ts
  const keepNull = (): ValueVerdict[] =>
    candidates.map((c, i) =>
      VALUE_PROTECTED_CATEGORIES.has(parseCategory(c.title))
        ? { index: i, keep: true, valueClass: 'decision' as ValueClass }
        : { index: i, keep: true, valueClass: null },
    )
```

- [ ] **Step 5: 改 VALUE_JUDGE_SYSTEM_PROMPT 定义澄清（不加禁词）**

把 `1. public-knowledge` 与 `2. derivable` 两条改为：

```
1. public-knowledge - obtainable via Google / official docs / source within ~10s
   (language syntax, stdlib, third-party API, generic algorithms, public standards).
   Project-specific business rules, contracts, and SLAs do not belong here.
2. derivable - re-derivable by reading THIS repository's current code/files/docs
   without the conversation. If the candidate describes the codebase being worked
   on (file paths, function/symbol names, config defaults, internal module
   behavior, file contents), it is derivable even when rationale is given.
```

> 自检：新增英文不得含 neutrality 禁词（`keep/discard/reject/avoid/important/valuable/unsure/cautious/careful/don't/dangerous`）。上面两条只描述 category 定义，无 keep/discard 指令。Step 6 的 neutrality 测试会锁这点。

- [ ] **Step 6: 运行测试确认通过**

Run: `bun test tests/valueFilter.test.ts`
Expected: PASS（含原有 neutrality 测试 `VALUE_JUDGE_SYSTEM_PROMPT is neutral` 仍绿）。

- [ ] **Step 7: typecheck + 全量回归**

Run: `bun run typecheck && bun test`
Expected: 全绿。

- [ ] **Step 8: Commit**

```bash
git add src/memory/valueFilter.ts tests/valueFilter.test.ts
git commit -m "feat(valueFilter): logic gate protects invariant/integration/compliance + sharpened defs"
```

---

### Task 5: dedup 同批兄弟 + 跨批（dedup.ts）

**Files:**
- Modify: `src/memory/dedup.ts`（`DEDUP_SYSTEM_PROMPT` + `renderUserPrompt` + `judgeDuplicates` 短路 + `dedupShouldRetry`）
- Test: `tests/dedup.test.ts`

**Interfaces:**
- Produces: `judgeDuplicates` 现在接受 `duplicateOfId` 为 existing id 或 `new-${j}`（j<i）；existing 空但 >1 候选时仍调 LLM 做兄弟比对。Task 6 消费（`dedupCandidates` 只看 `!v.duplicate`，无需改）。

- [ ] **Step 1: 写失败测试** — 在 `tests/dedup.test.ts` 末尾追加：

```ts
test('judgeDuplicates merges same-batch sibling (new-j duplicateOf)', async () => {
  const a: DistillCandidate = { title: '[category:invariant] 退款14天', bodyMd: 'b', scopeType: 'project', runtime: null, distillAction: 'new' }
  const b: DistillCandidate = { title: '[category:invariant] 退款须在14天内', bodyMd: 'b', scopeType: 'project', runtime: null, distillAction: 'new' }
  const v = await judgeDuplicates({
    newCandidates: [a, b], existing: [],
    callLLM: async () => JSON.stringify({ verdicts: [{ index: 0, isDuplicate: false }, { index: 1, isDuplicate: true, duplicateOfId: 'new-0' }] }),
  })
  expect(v).toEqual([{ index: 0, duplicate: false }, { index: 1, duplicate: true, duplicateOfId: 'new-0' }])
})

test('judgeDuplicates calls LLM for sibling comparison when existing empty but >1 candidate', async () => {
  let called = 0
  await judgeDuplicates({
    newCandidates: [newCand, { ...newCand, title: '[category:x] sibling' }], existing: [],
    callLLM: async () => { called++; return JSON.stringify({ verdicts: [{ index: 0, isDuplicate: false }, { index: 1, isDuplicate: false }] }) },
  })
  expect(called).toBe(1)
})

test('judgeDuplicates rejects duplicateOf new-j with j>=i (retry)', async () => {
  let calls = 0
  const v = await judgeDuplicates({
    newCandidates: [newCand, { ...newCand, title: '[category:x] s' }], existing: [],
    callLLM: async () => {
      calls++
      if (calls === 1) return JSON.stringify({ verdicts: [{ index: 0, isDuplicate: true, duplicateOfId: 'new-1' }] }) // j>=i illegal
      return JSON.stringify({ verdicts: [{ index: 0, isDuplicate: false }, { index: 1, isDuplicate: false }] })
    },
  })
  expect(calls).toBe(2)
})

test('user prompt includes new-i ids for sibling comparison', async () => {
  let captured = ''
  await judgeDuplicates({
    newCandidates: [newCand, { ...newCand, title: '[category:x] s' }], existing: [],
    callLLM: async (_sys, user) => { captured = user; return JSON.stringify({ verdicts: [{ index: 0, isDuplicate: false }, { index: 1, isDuplicate: false }] }) },
  })
  expect(captured).toContain('id=new-0')
  expect(captured).toContain('id=new-1')
})

test('DEDUP_SYSTEM_PROMPT mentions sibling comparison + new-id duplicateOf', () => {
  expect(DEDUP_SYSTEM_PROMPT).toContain('siblings')
  expect(DEDUP_SYSTEM_PROMPT).toContain('new-')
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test tests/dedup.test.ts`
Expected: FAIL — `judgeDuplicates` 当前 existing 空时短路返回 all-new（不调 LLM）；`duplicateOfId: 'new-0'` 被当幻觉处理。

- [ ] **Step 3: 改 DEDUP_SYSTEM_PROMPT**

把 `src/memory/dedup.ts` 的 `DEDUP_SYSTEM_PROMPT` 改为：

```ts
export const DEDUP_SYSTEM_PROMPT = `You are memside-dedup. Decide whether each new candidate memory is a SEMANTIC DUPLICATE of any other item in the same scope — the same rule or fact, even if worded differently or tagged with a different [category:] prefix.

Compare each new candidate against BOTH (a) the existing memories listed below, and (b) its same-batch siblings (the other new candidates). A new candidate is a duplicate if it restates the same rule as an existing memory OR as an earlier new candidate (new-j where j < i).

输出格式如下（仅示范结构，勿照抄内容；只输出这一个 JSON 对象，无 markdown 围栏，无解释文字）：
{
  "verdicts": [
    {"index": 0, "isDuplicate": false},
    {"index": 1, "isDuplicate": true, "duplicateOfId": "A"},
    {"index": 2, "isDuplicate": true, "duplicateOfId": "new-0"}
  ]
}
Emit one verdict per new candidate, keyed by its index. duplicateOfId MUST be either an existing memory id or "new-j" with j < i (an earlier new candidate). Keep the earliest member of each duplicate group.`
```

- [ ] **Step 4: 改 renderUserPrompt（new 带 new-i id，existing 空时显示 none）**

```ts
function renderUserPrompt(newCandidates: DistillCandidate[], existing: ExistingMemoryForDedup[]): string {
  const exLines = existing.length > 0
    ? existing.map((e) => `id=${e.id} | ${e.title}`).join('\n')
    : '(none)'
  const newLines = newCandidates.map((c, i) => `id=new-${i} | ${c.title}\n${c.bodyMd}`).join('\n---\n')
  return `Existing memories (same scope):\n${exLines}\n\nNew candidates:\n${newLines}\n\nReturn JSON per the system instructions.`
}
```

- [ ] **Step 5: 改 dedupShouldRetry 接受 new-j**

```ts
function isValidDuplicateOf(id: string, index: number, existingIds: Set<string>): boolean {
  if (existingIds.has(id)) return true
  const m = /^new-(\d+)$/.exec(id)
  if (!m) return false
  const j = Number(m[1])
  return j >= 0 && j < index
}

function dedupShouldRetry(existingIds: Set<string>): (parsed: unknown) => string | null {
  return (parsed) => {
    if (!parsed || typeof parsed !== 'object') return '返回的不是 JSON 对象'
    const p = parsed as { verdicts?: unknown }
    if (!Array.isArray(p.verdicts)) return '缺少 verdicts 数组'
    for (let i = 0; i < p.verdicts.length; i++) {
      const v = p.verdicts[i] as Record<string, unknown> | null
      if (!v || typeof v.index !== 'number') return `verdict ${i} 缺少 index`
      if (v.isDuplicate === true) {
        if (typeof v.duplicateOfId !== 'string') return `verdict ${v.index} 标记重复但缺少 duplicateOfId`
        if (!isValidDuplicateOf(v.duplicateOfId, v.index as number, existingIds)) return `verdict ${v.index} 的 duplicateOfId 非法`
      }
    }
    return null
  }
}
```

- [ ] **Step 6: 改 judgeDuplicates 短路条件**

把 `judgeDuplicates` 内（约 79-81 行）：
```ts
  if (input.existing.length === 0) {
    return input.newCandidates.map((_, i) => ({ index: i, duplicate: false }))
  }
```
改为：
```ts
  // Skip the LLM only when there is nothing to compare against: no existing
  // AND at most one new candidate (no siblings to compare). With >=2 new
  // candidates and no existing, we still call to compare siblings.
  if (input.existing.length === 0 && input.newCandidates.length <= 1) {
    return input.newCandidates.map((_, i) => ({ index: i, duplicate: false }))
  }
```

- [ ] **Step 7: 更新现有 dedup 测试 `skips LLM when existing is empty`（约 61-69 行）**

把测试名与断言改为反映新短路条件（1 候选 + 无 existing 仍短路）：

```ts
test('judgeDuplicates skips LLM when existing empty AND <=1 candidate', async () => {
  let called = 0
  const v = await judgeDuplicates({
    newCandidates: [newCand], existing: [],
    callLLM: async () => { called++; return 'x' },
  })
  expect(called).toBe(0)
  expect(v).toEqual([{ index: 0, duplicate: false }])
})
```

- [ ] **Step 8: 运行测试确认通过**

Run: `bun test tests/dedup.test.ts`
Expected: PASS（含现有 `treats hallucinated duplicateOfId as new`：'NONEXISTENT' 既非 existing id 也非 new-j -> 仍按 new 处理/重试，行为一致）。

- [ ] **Step 9: typecheck + 全量回归**

Run: `bun run typecheck && bun test`
Expected: 全绿（`dedupCandidates` 消费侧只看 `!v.duplicate`，无需改）。

- [ ] **Step 10: Commit**

```bash
git add src/memory/dedup.ts tests/dedup.test.ts
git commit -m "feat(dedup): same-batch sibling comparison + cross-batch in one call"
```

---

### Task 6: scheduler tick 重排（dedup 前置）（scheduler.ts）

**Files:**
- Modify: `src/scheduler.ts`（`tick` 内 distill 之后的部分）
- Test: `tests/scheduler.test.ts`（更新 4 个受影响测试的 mock 分支顺序 + 1 个断言）

**Interfaces:**
- Consumes: Task 4（`judgeValue` 受保护门）+ Task 5（`dedupCandidates` 同批+跨批）。
- Produces: tick 调用顺序 `distill -> dedup -> judgeValue`；去掉 valueClass 重挂 hack。

- [ ] **Step 1: 先更新受影响测试的 mock 分支顺序**

> 调用顺序从 `distill(1) -> judgeValue(2) -> dedup(3)` 变为 `distill(1) -> dedup(2) -> judgeValue(3)`。受影响测试需把 call2/call3 的分支对调；dedup 移除候选时 judgeValue 不再被调。

Modify `tests/scheduler.test.ts`：

**测试 `tick filters duplicate candidates (dedup marks duplicate, not persisted)`（约 99-117 行）** — dedup 现在是 call 2，候选被 dedup 移除后 judgeValue 不调（0 候选短路）。把 `callLLM` 改为：

```ts
    callLLM: async () => {
      callCount++
      if (callCount === 1) return JSON.stringify({ candidates: [{ title: '[category:process] 14天退款', bodyMd: '14d', scope: 'project', runtime: null, distillAction: 'new' }] })
      // callCount === 2: dedup marks dup of existing -> candidate removed -> judgeValue skipped (0 candidates)
      return JSON.stringify({ verdicts: [{ index: 0, isDuplicate: true, duplicateOfId: ex.id }] })
    },
```
（删除原 callCount===2 的 judgeValue 分支；`expect(createCalls).toBe(0)` 不变。）

**测试 `tick keeps all candidates when dedup LLM throws (conservative, job still done)`（约 119-139 行）** — dedup 是 call 2（throw，judgeDuplicates 内部捕获 -> 全留），judgeValue 是 call 3。把 `callLLM` 改为：

```ts
    callLLM: async () => {
      callCount++
      if (callCount === 1) return JSON.stringify({ candidates: [{ title: '[category:x] new', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] })
      if (callCount === 2) throw new Error('dedup api down')
      return JSON.stringify({ verdicts: [{ index: 0, category: 'decision' }] })
    },
```
（`expect(createCalls).toBe(1)` 与 `status === 'done'` 不变。）

**测试 `tick keeps sourceCwd/distillAction in createCandidate input after dedup`（约 159-178 行）** — dedup 是 call 2（not dup），judgeValue 是 call 3。把 `callLLM` 改为：

```ts
    callLLM: async () => {
      callCount++
      if (callCount === 1) return JSON.stringify({ candidates: [{ title: '[category:x] new', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] })
      if (callCount === 2) return JSON.stringify({ verdicts: [{ index: 0, isDuplicate: false }] })
      return JSON.stringify({ verdicts: [{ index: 0, category: 'decision' }] })
    },
```
（`captured.sourceCwd`/`distillAction` 断言不变。）

**测试 `tick runs judgeValue before dedup (3-phase call order)`（约 311-332 行）** — 改名 + 改断言 + 对调 call2/call3：

```ts
test('tick runs dedup before judgeValue (3-phase call order)', async () => {
  const ex = await realCreateCandidate(db, { scopeType: 'project', scopeId: '/r', title: 'existing', bodyMd: 'b', tags: [], sourceKind: 'manual', runtime: null, sourceCwd: '/r' })
  await db.update(memories).set({ status: 'approved' }).where(eq(memories.id, ex.id)).run()
  const { jobId } = await enqueueDistillJob(db, { sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0 })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  const phases: string[] = []
  let callCount = 0
  await tick(db, {
    loadTranscript: async () => [{ role: 'user', content: 'x' }],
    callLLM: async (_sys, user) => {
      callCount++
      if (callCount === 1) { phases.push('distill'); return JSON.stringify({ candidates: [{ title: '[category:x] new', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] }) }
      if (callCount === 2) { phases.push('dedup'); return JSON.stringify({ verdicts: [{ index: 0, isDuplicate: false }] }) }
      phases.push('judgeValue'); return JSON.stringify({ verdicts: [{ index: 0, category: 'trap' }] })
    },
    createCandidate: async () => ({ id: 'c1', status: 'candidate', version: 1 } as any),
  })
  expect(phases).toEqual(['distill', 'dedup', 'judgeValue'])
})
```

> 其余 scheduler 测试（141-157 `skips dedup when no existing`、248-269 `discards value-filter public-knowledge`、271-287 `passes valueClass`、289-309 `judgeValue LLM throws`）**无需改**：1 候选 + 无 existing 时 dedup 短路不调 LLM，调用数与原先一致；Step 5 全量回归会验证。

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test tests/scheduler.test.ts`
Expected: FAIL — 当前 `tick` 仍是 `judgeValue -> dedup`，调用顺序与改后的 mock 不符（`phases` 断言失败等）。

- [ ] **Step 3: 重排 tick**

Modify `src/scheduler.ts` 的 `tick`，把 `distillTranscript` 之后到 `createCandidate` 循环之前（约 120-166 行）替换为：

```ts
      const turns = await deps.loadTranscript({ id: job.id, cwd: job.cwd, sourceEventId: job.sourceEventId })
      const candidates: DistillCandidate[] = await distillTranscript({
        turns,
        runtime: job.runtime as 'claude-code' | 'opencode',
        cwd: job.cwd ?? '',
        callLLM: deps.callLLM,
      })
      // Dedup FIRST (same-batch siblings + cross-batch existing), so valueFilter
      // only runs on survivors (no wasted calls, no per-dupe mis-classification).
      const deduped = await dedupCandidates(db, deps.callLLM, candidates, job.cwd ?? null)
      // Value filter: classify each survivor. public-knowledge/derivable =>
      // discard (audit-logged); decision/convention/trap/topology => keep with
      // valueClass; protected categories (invariant/integration/compliance) are
      // force-kept with valueClass='decision' inside judgeValue. judgeValue
      // swallows its own LLM errors (all keep+null/decision), never bubbles.
      const verdicts = await judgeValue(deduped, deps.callLLM)
      const keepWithClass: { cand: DistillCandidate; valueClass: ValueClass | null }[] = []
      const discarded: DiscardRecord[] = []
      verdicts.forEach((v, i) => {
        const c = deduped[i]
        if (!c) return
        if (v.keep) keepWithClass.push({ cand: c, valueClass: v.valueClass })
        else discarded.push({ title: c.title, bodyMd: c.bodyMd, reason: v.reason })
      })
      if (discarded.length > 0) {
        // Best-effort audit log: a DB failure here must not block distill.
        try { await logDiscards(db, job.id, discarded) } catch (e) { console.warn('memside: logDiscards failed', e) }
      }
      for (const k of keepWithClass) {
        await deps.createCandidate(db, {
          scopeType: k.cand.scopeType,
          scopeId: resolveScopeId(k.cand.scopeType, job.cwd ?? null),
          title: k.cand.title,
          bodyMd: k.cand.bodyMd,
          tags: [],
          sourceKind: 'conversation',
          sourceCwd: job.cwd ?? null,
          runtime: k.cand.runtime,
          distillJobId: job.id,
          distillAction: k.cand.distillAction,
          sourceEventId: job.sourceEventId,
          valueClass: k.valueClass,
        })
      }
      await db.update(memoryDistillJobs).set({ status: 'done', finishedAt: Date.now() }).where(eq(memoryDistillJobs.id, job.id)).run()
      processed += 1
```

（删除原 `keepCandidates`/`classByCand` 重挂逻辑。`DistillCandidate`/`ValueClass`/`DiscardRecord` import 已存在，无需加。）

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test tests/scheduler.test.ts`
Expected: PASS（全部，含 4 个改 mock 的 + 4 个未改的 + 直接 `dedupCandidates` 测试）。

- [ ] **Step 5: typecheck + 全量回归**

Run: `bun run typecheck && bun test`
Expected: 全绿。

- [ ] **Step 6: Commit**

```bash
git add src/scheduler.ts tests/scheduler.test.ts
git commit -m "refactor(scheduler): run dedup before valueFilter (removes valueClass re-attach hack)"
```

---

### Task 7: 全量验证 + 回归兜底

**Files:**
- Test: `tests/scheduler.test.ts`（新增一条受保护类别端到端断言）

**Interfaces:**
- 无新接口；锁住"受保护类别候选最终以 valueClass=decision 入库"的端到端行为。

- [ ] **Step 1: 写端到端回归测试** — 在 `tests/scheduler.test.ts` 末尾追加：

```ts
test('tick: protected invariant candidate survives with valueClass=decision (e2e gate + bulk-reject immunity)', async () => {
  const { jobId } = await enqueueDistillJob(db, { sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0 })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  let captured: any = null
  let callCount = 0
  await tick(db, {
    loadTranscript: async () => [{ role: 'user', content: 'refunds only within 14 days' }],
    callLLM: async () => {
      callCount++
      if (callCount === 1) return JSON.stringify({ candidates: [{ title: '[category:invariant] 退款须在发货后14天内', bodyMd: '14d', scope: 'project', runtime: null, distillAction: 'new' }] })
      if (callCount === 2) return JSON.stringify({ verdicts: [{ index: 0, isDuplicate: false }] })
      // judgeValue LLM wrongly says derivable -> logic gate must override to keep+decision
      return JSON.stringify({ verdicts: [{ index: 0, category: 'derivable' }] })
    },
    createCandidate: async (_db, input) => { captured = input; return { id: 'c1', status: 'candidate', version: 1 } as any },
  })
  expect(captured).not.toBeNull()
  expect(captured.valueClass).toBe('decision') // non-null -> immune to 批量拒绝未评估
  const rows = await db.select().from(memoryDiscards)
  expect(rows.length).toBe(0) // not discarded despite LLM saying derivable
})
```

- [ ] **Step 2: 运行确认通过**

Run: `bun test tests/scheduler.test.ts`
Expected: PASS。

- [ ] **Step 3: 全量门禁**

Run: `bun run typecheck && bun test`
Expected: typecheck 干净；`bun test` 全绿（原有 100+ 用例 + 本次新增）。

- [ ] **Step 4: Commit**

```bash
git add tests/scheduler.test.ts
git commit -m "test(scheduler): e2e gate protects invariant candidate (bulk-reject immunity)"
```

---

## 完成后（非本计划任务，执行阶段之后）

- 推远端 + 开 PR 合并回 `master`（PR 标题 `feat(memory): 记忆质量修复 — 输入过滤 + valueFilter 逻辑门 + dedup 前置`）。
- 合并后本地 `git branch -d feat/memory-quality-fix` + `git fetch --prune`。
- DB 253MB 膨胀 / `memory_distill_events` 保留策略：单独开 issue / 后续 plan。

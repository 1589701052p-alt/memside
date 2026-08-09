# Thinking 捕获 + 工具名渲染修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 AI 思考内容（claude code thinking 块 / opencode reasoning part）以独立 role `'thinking'` 进入蒸馏管线并与正式输出同等对待，同时让蒸馏 prompt 与 Web 原始输入遮罩渲染真实工具名（`[tool:Read]`）。

**Architecture:** `TranscriptTurn.role` 联合加 `'thinking'`（方案 A），两个 runtime 的解析器各自产出 thinking turn；下游消费点按 spec §4.2 矩阵适配（retry 检测结构性免疫、turnPriority=2、渲染 `[thinking]` 标签、digest `THINKING:` 行、Web 紫色徽标）；distiller SYSTEM_PROMPT 仅加说明性文本。

**Tech Stack:** Bun + TypeScript（`bun:test`），无新依赖、无 schema 迁移。

**Spec:** `docs/superpowers/specs/2026-08-09-thinking-capture-design.md`（已批准）

## Global Constraints

- 运行门槛：每个 task 提交前 `bun run typecheck && bun test` 全绿。
- 同等对待原则：thinking 与 assistant 同单条 cap（20000 字符）、同预算优先级（2）、同 digest 截断（300 字符）——数值一个都不改。
- 三档压缩策略（`compactToolTurn`：文件类占位 / 非文件 3000 字符 / 错误原文）逐字不动。
- 已验证块形状（spec §3）：claude `{type:'thinking', thinking:string}`；opencode `{type:'reasoning', text:string}`。取不到字符串即跳过，解析器永不抛。
- distiller SYSTEM_PROMPT 只加 §4.4 说明段，REJECT 规则 / JSON 模板 / origin / evidence 契约一字不动。
- commit 前缀：`test:` / `feat:` / `docs:`；分支 `feat/thinking-capture`，禁止直推 master。
- spec + plan 两份文档已随分支首个 commit 落档（前置，不占 task）。

---

### Task 1: `TranscriptTurn.role` 加 `'thinking'` + `turnPriority` 同级

**Files:**
- Modify: `src/memory/pure.ts:109-117`（role 联合）、`src/memory/pure.ts:244-250`（turnPriority）
- Test: `tests/pure-transcript-filter.test.ts`

**Interfaces:**
- Consumes: 无（纯类型 + 纯函数改动）。
- Produces: `TranscriptTurn.role` 联合含 `'thinking'`（Task 2-7 全部依赖此类型）；`turnPriority` 对 thinking 返回 2。

- [ ] **Step 1: 写失败测试**

在 `tests/pure-transcript-filter.test.ts` 末尾追加（文件顶部已有 `filterTranscriptForDistill` 与 `TranscriptTurn` 的 import，若无则补 `import { filterTranscriptForDistill, type TranscriptTurn } from '@/memory/pure'`）：

```ts
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
```

- [ ] **Step 2: 跑测试确认红**

Run: `bun test tests/pure-transcript-filter.test.ts`
Expected: FAIL —— TS 报错 `'"thinking"' is not assignable to type`（role 联合无 thinking）。

- [ ] **Step 3: 实现**

`src/memory/pure.ts:110` role 联合改为：

```ts
export interface TranscriptTurn {
  role: 'user' | 'assistant' | 'tool' | 'system' | 'thinking'
  content: string
  isError?: boolean
  /** 配对自前一个 assistant 行的 tool_use 块；仅 role==='tool' 有值。 */
  toolName?: string
  /** 提取自 tool_use.input（file_path / notebook_path / path）；仅文件类工具有值。 */
  toolInputPath?: string
}
```

`src/memory/pure.ts:244-250` `turnPriority` 加一行：

```ts
function turnPriority(t: TranscriptTurn): number {
  if (t.role === 'user') return 0
  if (t.role === 'tool' && t.isError) return 1
  if (t.role === 'assistant') return 2
  if (t.role === 'thinking') return 2 // 与 assistant 同级（spec §4.2 同等对待）
  if (t.role === 'tool') return 3
  return 4
}
```

- [ ] **Step 4: 跑测试确认绿**

Run: `bun test tests/pure-transcript-filter.test.ts && bun run typecheck`
Expected: PASS 全绿。

- [ ] **Step 5: Commit**

```bash
git add src/memory/pure.ts tests/pure-transcript-filter.test.ts
git commit -m "feat(memory): TranscriptTurn.role 加 'thinking' + turnPriority 同级（spec §4.2）"
```

---

### Task 2: claude code 解析器捕获 thinking 块

**Files:**
- Modify: `src/claude/transcript.ts:52-76`（JSDoc）、`src/claude/transcript.ts:139-156`（assistant 分支）
- Test: `tests/transcript.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `'thinking'` role。
- Produces: `parseTranscriptFile` 对 `{type:'thinking', thinking:string}` 块产出 `{role:'thinking', content}` turn（Task 7 e2e 依赖）。

- [ ] **Step 1: 更新锁旧行为的测试（红）+ 新增用例**

`tests/transcript.test.ts:80-96` 的旧测试**整体替换**为：

```ts
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
```

文件顶部 import 行补 `detectErrorSignals`：

```ts
import { parseTranscriptFile, extractText, subagentFilePathFromPayload, loadSubagentTranscript } from '@/claude/transcript'
import { detectErrorSignals } from '@/memory/pure'
```

末尾追加三个新用例：

```ts
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
```

- [ ] **Step 2: 跑测试确认红**

Run: `bun test tests/transcript.test.ts`
Expected: FAIL —— 更新后的测试期望含 thinking turn 的数组，实际只有 assistant turn。

- [ ] **Step 3: 实现**

`src/claude/transcript.ts` JSDoc（:66-70 区域）中

```
 * - `type:"assistant"`: each `{type:'text'}` item -> `{role:'assistant', content}`.
 *   `{type:'thinking'}` is SKIPPED (internal reasoning would pollute retry
 *   detection). `{type:'tool_use'}` is QUEUED ...
```

改为：

```
 * - `type:"assistant"`: each `{type:'text'}` item -> `{role:'assistant', content}`.
 *   `{type:'thinking'}` with a string `thinking` field -> `{role:'thinking',
 *   content}`（spec 2026-08-09 §4.1；独立 role 使 retry 检测结构性免疫，旧版
 *   skip 的污染顾虑由类型消除）。`redacted_thinking` / 缺文本字段的块跳过。
 *   `{type:'tool_use'}` is QUEUED ...
```

assistant 分支（:144-154）改为：

```ts
        if (Array.isArray(content)) {
          for (const item of content) {
            if (item && typeof item === 'object' && !Array.isArray(item)) {
              const it = item as { type?: unknown; text?: unknown; thinking?: unknown; name?: unknown; input?: unknown }
              if (it.type === 'text' && typeof it.text === 'string') {
                turns.push({ role: 'assistant', content: it.text })
              } else if (it.type === 'thinking' && typeof it.thinking === 'string') {
                turns.push({ role: 'thinking', content: it.thinking })
              } else if (it.type === 'tool_use' && typeof it.name === 'string') {
                pendingToolUses.push({ name: it.name, inputPath: extractToolInputPath(it.input) })
              }
              // redacted_thinking / 缺 thinking 字段的块 -> 跳过
            }
          }
        }
```

- [ ] **Step 4: 跑测试确认绿**

Run: `bun test tests/transcript.test.ts && bun run typecheck`
Expected: PASS 全绿。

- [ ] **Step 5: Commit**

```bash
git add src/claude/transcript.ts tests/transcript.test.ts
git commit -m "feat(claude): parseTranscriptFile 捕获 thinking 块为 thinking turn（spec §4.1）"
```

---

### Task 3: opencode 解析器捕获 reasoning part

**Files:**
- Modify: `src/opencode/transcript.ts:9-13`（OpencodePart 联合）、`src/opencode/transcript.ts:15-22`（JSDoc）、`src/opencode/transcript.ts:37-56`（转换循环）
- Test: `tests/opencode-transcript.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `'thinking'` role。
- Produces: `parseOpencodeMessages` 对 `{type:'reasoning', text:string}` part 产出 `{role:'thinking', content}` turn。

- [ ] **Step 1: 更新锁旧行为的测试（红）+ 新增用例**

`tests/opencode-transcript.test.ts:29-40` 的旧测试**整体替换**为：

```ts
test('ReasoningPart -> thinking turn；subtask / StepStart 仍过滤', () => {
  const msgs: OpencodeMessage[] = [{
    info: { role: 'assistant' },
    parts: [
      { type: 'reasoning', text: 'thinking' } as any,
      { type: 'text', text: 'answer' } as any,
      { type: 'subtask', prompt: 'p', description: 'd', agent: 'a' } as any,
    ],
  }]
  const turns = parseOpencodeMessages(msgs)
  expect(turns).toEqual([
    { role: 'thinking', content: 'thinking' },
    { role: 'assistant', content: 'answer' },
  ])
})

test('reasoning part 缺 text 字段 -> 跳过不抛', () => {
  const msgs: OpencodeMessage[] = [{
    info: { role: 'assistant' },
    parts: [{ type: 'reasoning' } as any, { type: 'text', text: 'a' } as any],
  }]
  expect(parseOpencodeMessages(msgs)).toEqual([{ role: 'assistant', content: 'a' }])
})
```

- [ ] **Step 2: 跑测试确认红**

Run: `bun test tests/opencode-transcript.test.ts`
Expected: FAIL —— reasoning part 目前被过滤，期望数组含 thinking turn。

- [ ] **Step 3: 实现**

`src/opencode/transcript.ts` `OpencodePart` 联合（:10-13）加成员：

```ts
export type OpencodePart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool'; tool?: string; callID?: string; input?: unknown; output?: string; error?: boolean; metadata?: Record<string, unknown> }
  | { type: string; [k: string]: unknown }
```

JSDoc（:19）`- reasoning/subtask/step/patch/snapshot/... 一律过滤` 改为
`- reasoning -> thinking turn（spec 2026-08-09 §4.1）；subtask/step/patch/snapshot/... 一律过滤`。

转换循环（:40-55）`if (p.type === 'text')` 与 `else if (p.type === 'tool')` 之间插入：

```ts
      } else if (p.type === 'reasoning') {
        const rp = p as { text?: unknown }
        if (typeof rp.text === 'string') turns.push({ role: 'thinking', content: rp.text })
```

循环尾部注释（:54）`// 其余 part（reasoning/subtask/step/patch/snapshot/agent/retry/compaction）-> 跳过` 改为
`// 其余 part（subtask/step/patch/snapshot/agent/retry/compaction）-> 跳过`。

- [ ] **Step 4: 跑测试确认绿**

Run: `bun test tests/opencode-transcript.test.ts && bun run typecheck`
Expected: PASS 全绿。

- [ ] **Step 5: Commit**

```bash
git add src/opencode/transcript.ts tests/opencode-transcript.test.ts
git commit -m "feat(opencode): parseOpencodeMessages 捕获 reasoning part 为 thinking turn（spec §4.1）"
```

---

### Task 4: distiller 渲染 `[thinking]` / `[tool:Name]` + SYSTEM_PROMPT 增补

**Files:**
- Modify: `src/memory/distiller.ts:51` 后（SYSTEM_PROMPT 增补）、`src/memory/distiller.ts:137`（renderUserPrompt 渲染行）
- Test: `tests/distiller.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `'thinking'` role。
- Produces: `renderUserPrompt` 输出 `[thinking] ...` 与 `[tool:${toolName}] ...` 标签行；`DISTILLER_SYSTEM_PROMPT` 含 `[thinking]` 说明段（Task 7 e2e 断言依赖 `[thinking]` 标签）。

- [ ] **Step 1: 写失败测试**

`tests/distiller.test.ts` 末尾追加（文件已有 `distillTranscript, DISTILLER_SYSTEM_PROMPT` import）：

```ts
// --- thinking 捕获 + 工具名渲染（spec 2026-08-09 §4.2/§4.3/§4.4）---

test('renderUserPrompt: thinking -> [thinking] 标签；tool 带 toolName -> [tool:Read]；无名兜底 [tool]', async () => {
  let captured = ''
  await distillTranscript({
    turns: [
      { role: 'thinking', content: 'why this design' },
      { role: 'tool', content: 'file placeholder', toolName: 'Read' },
      { role: 'tool', content: 'legacy output' },
    ],
    runtime: 'claude-code',
    cwd: '/repo',
    existingSlugs: [],
    callLLM: async (_s: string, u: string) => {
      captured = u
      return JSON.stringify({ candidates: [] })
    },
  })
  expect(captured).toContain('[thinking] why this design')
  expect(captured).toContain('[tool:Read] file placeholder')
  expect(captured).toContain('[tool] legacy output')
})

test('DISTILLER_SYSTEM_PROMPT 含 [thinking] 说明段（spec §4.4）', () => {
  expect(DISTILLER_SYSTEM_PROMPT).toContain('[thinking]')
  expect(DISTILLER_SYSTEM_PROMPT).toContain('内部推理')
  expect(DISTILLER_SYSTEM_PROMPT).toContain('evidence 可摘 thinking 原文')
})
```

- [ ] **Step 2: 跑测试确认红**

Run: `bun test tests/distiller.test.ts`
Expected: FAIL —— captured 中 `[tool] file placeholder`（无 toolName）、无 `[thinking]`；SYSTEM_PROMPT 无说明段。

- [ ] **Step 3: 实现**

`src/memory/distiller.ts:51`（`硬约束：记 rationale 时必须能在所给 transcript 中找到 agent 原话出处；找不到出处的不记（防止脑补）。`）之后插入新段落：

```
[thinking] 标签说明：[thinking] 是 agent 未对用户展示的内部推理。它可以作为 rationale 的「原话出处」证据（evidence 可摘 thinking 原文）；但仅在 thinking 中出现、未在对话浮现也未被用户采纳的推理，仍按上面的 Origin discipline 不得提取为候选。
```

`src/memory/distiller.ts:137` 渲染行改为：

```ts
  const transcript = turns
    .map((t) => (t.role === 'tool' && t.toolName ? `[tool:${t.toolName}] ${t.content}` : `[${t.role}] ${t.content}`))
    .join('\n')
```

（thinking 经 `[${t.role}]` 自然渲染为 `[thinking]`，无需特判。）

- [ ] **Step 4: 跑测试确认绿**

Run: `bun test tests/distiller.test.ts && bun run typecheck`
Expected: PASS 全绿。

- [ ] **Step 5: Commit**

```bash
git add src/memory/distiller.ts tests/distiller.test.ts
git commit -m "feat(distiller): 渲染 [thinking]/[tool:Name] 标签 + SYSTEM_PROMPT thinking 说明段（spec §4.3/§4.4）"
```

---

### Task 5: contextDigest 加 `THINKING:` 行

**Files:**
- Modify: `src/memory/contextDigest.ts:9-13`（JSDoc）、`src/memory/contextDigest.ts:21-26`（循环）
- Test: `tests/context-digest.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `'thinking'` role。
- Produces: `buildDeterministicDigest` 对 thinking turn 输出 `THINKING: <squash+截断>` 行。

- [ ] **Step 1: 写失败测试**

`tests/context-digest.test.ts` 的 `describe('buildDeterministicDigest')` 块内追加：

```ts
  test('thinking -> THINKING 行，换行压平 + 同 300 字截断（spec §4.2 同等对待）', () => {
    const d = buildDeterministicDigest([t('thinking', 'why\n' + 'z'.repeat(500))])
    expect(d.startsWith('THINKING: why ')).toBe(true)
    expect(d.length).toBeLessThanOrEqual('THINKING: '.length + DIGEST_LINE_MAX_CHARS)
  })
```

- [ ] **Step 2: 跑测试确认红**

Run: `bun test tests/context-digest.test.ts`
Expected: FAIL —— `d` 为空串（thinking 目前无分支，落入"跳过"）。

- [ ] **Step 3: 实现**

`src/memory/contextDigest.ts:23` 后插入一行：

```ts
    else if (t.role === 'thinking') lines.push(`THINKING: ${squash(t.content).slice(0, DIGEST_LINE_MAX_CHARS)}`)
```

JSDoc（:10-11）`user/assistant 每条截 DIGEST_LINE_MAX_CHARS 字单行，tool 只留 \`[tool: 名字]\`，system 跳过。` 改为
`user/assistant/thinking 每条截 DIGEST_LINE_MAX_CHARS 字单行（thinking 前缀 \`THINKING:\`），tool 只留 \`[tool: 名字]\`，system 跳过。`

- [ ] **Step 4: 跑测试确认绿**

Run: `bun test tests/context-digest.test.ts && bun run typecheck`
Expected: PASS 全绿。

- [ ] **Step 5: Commit**

```bash
git add src/memory/contextDigest.ts tests/context-digest.test.ts
git commit -m "feat(memory): contextDigest 渲染 THINKING 行（spec §4.2）"
```

---

### Task 6: Web 遮罩 `formatSourceTurn` thinking 徽标 + 工具名 label

**Files:**
- Modify: `src/web/ui-utils.ts:31-45`（formatSourceTurn）
- Test: `tests/ui-utils.test.ts`

**Interfaces:**
- Consumes: 无（web 层独立，role 在边界是宽松 string）。
- Produces: `formatSourceTurn({role:'thinking'})` -> `{label:'thinking', color:'#6a1b9a'}`；`formatSourceTurn({role:'tool', toolName:'Read'})` -> `{label:'tool:Read', ...}`。参数类型加 `toolName?: string`（App.tsx 调用点已传 SourceTurn 形状，含 toolName，无需改）。

- [ ] **Step 1: 写失败测试**

`tests/ui-utils.test.ts` 的 `// --- formatSourceTurn ---` 区域内追加：

```ts
test('formatSourceTurn: thinking -> 紫色标签（spec §4.2）', () => {
  const r = formatSourceTurn({ role: 'thinking', content: 'x' })
  expect(r).toEqual({ label: 'thinking', color: '#6a1b9a' })
})

test('formatSourceTurn: tool 带 toolName -> tool:Read 标签（spec §4.3）', () => {
  const r = formatSourceTurn({ role: 'tool', content: 'x', toolName: 'Read' })
  expect(r).toEqual({ label: 'tool:Read', color: '#666' })
})

test('formatSourceTurn: tool 带 toolName 且 error -> tool:Bash 红色标签', () => {
  const r = formatSourceTurn({ role: 'tool', content: 'x', toolName: 'Bash', isError: true })
  expect(r).toEqual({ label: 'tool:Bash', color: '#c00' })
})
```

- [ ] **Step 2: 跑测试确认红**

Run: `bun test tests/ui-utils.test.ts`
Expected: FAIL —— thinking 落入兜底 `{label:'thinking', color:'#666'}`；tool 带 toolName 仍 `{label:'tool'}`。

- [ ] **Step 3: 实现**

`src/web/ui-utils.ts:40-45` 改为：

```ts
export function formatSourceTurn(turn: { role: string; content?: string; isError?: boolean; toolName?: string }): { label: string; color: string } {
  if (turn.role === 'user') return { label: 'user', color: '#1565c0' }
  if (turn.role === 'assistant') return { label: 'assistant', color: '#222' }
  if (turn.role === 'thinking') return { label: 'thinking', color: '#6a1b9a' }
  if (turn.role === 'tool') return { label: turn.toolName ? `tool:${turn.toolName}` : 'tool', color: turn.isError ? '#c00' : '#666' }
  return { label: turn.role, color: '#666' }
}
```

JSDoc（:32-33）`user 蓝、assistant 深、tool 灰（error 红）、其余灰 + 原角色名。` 改为
`user 蓝、assistant 深、thinking 紫（#6a1b9a，spec §4.2）、tool 灰（error 红；带 toolName 时 label 为 tool:<名>，spec §4.3）、其余灰 + 原角色名。`

- [ ] **Step 4: 跑测试确认绿**

Run: `bun test tests/ui-utils.test.ts && bun run typecheck`
Expected: PASS 全绿。

- [ ] **Step 5: Commit**

```bash
git add src/web/ui-utils.ts tests/ui-utils.test.ts
git commit -m "feat(web): formatSourceTurn thinking 紫徽标 + tool:Name 标签（spec §4.2/§4.3）"
```

---

### Task 7: e2e 闭环锁 + STATE.md 收尾

**Files:**
- Modify: `tests/e2e.test.ts:69-76`（fixture）、`tests/e2e.test.ts:142-144`（断言区）
- Modify: `STATE.md`（追加本轮段落）

**Interfaces:**
- Consumes: Task 2（claude thinking 捕获）+ Task 4（`[thinking]` 渲染标签）。
- Produces: e2e 断言 thinking 块内容经真实链路（JSONL -> parseTranscriptFile -> events -> makeLoadTranscript -> distiller prompt）抵达 LLM 输入。

- [ ] **Step 1: fixture 加 thinking 块 + 断言（先跑确认红）**

`tests/e2e.test.ts:69-76` 的 `writeFileSync` 调用改为：

```ts
  const fixturePath = join(dir, 'transcript.jsonl')
  writeFileSync(
    fixturePath,
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'refund policy rationale THINKING_SENTINEL' }] },
    }) + '\n' +
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'we only issue refunds within 14 days of shipment' },
    }) + '\n',
  )
```

`tests/e2e.test.ts:144`（`expect(capturedUserPrompt).toContain('refunds within 14 days')`）之后追加：

```ts
  // thinking 捕获锁（spec 2026-08-09 §6 #7）：thinking 块内容必须经真实链路
  // （JSONL -> parseTranscriptFile -> events -> makeLoadTranscript -> 渲染）
  // 抵达 distiller 输入，并以 [thinking] 标签呈现。
  expect(capturedUserPrompt).toContain('[thinking] refund policy rationale THINKING_SENTINEL')
```

Run: `bun test tests/e2e.test.ts`
Expected: 若 Task 2/4 已合并则为 PASS（本 task 是闭环验证锁，不是新行为；若意外 FAIL 说明前面 task 链路断裂，回去修）。

- [ ] **Step 2: 全套测试 + 类型检查**

Run: `bun run typecheck && bun test`
Expected: 全绿。

- [ ] **Step 3: STATE.md 追加本轮段落**

`STATE.md` 末尾追加：

```markdown
## Thinking 捕获 + 工具名渲染（2026-08-09）

诊断：distill 输入整体丢弃 AI 思考内容（claude thinking 块刻意 skip、opencode
reasoning part 过滤），而 origin discipline 放宽后「agent 给出且被用户采纳的
rationale 可记但需原话出处」——thinking 正是 rationale 主要载体，distiller 看不
到；伴生缺陷：toolName 已配对拿到但渲染只剩 `[tool]`，LLM 与用户都分不清
Read/Bash。设计 spec / 计划见 `docs/superpowers/specs|plans/
2026-08-09-thinking-capture*`。

1. `TranscriptTurn.role` 加 `'thinking'`（方案 A 独立 role）：retry 检测只看
   assistant，旧版 skip 的污染顾虑结构性消除。
2. claude `parseTranscriptFile` 捕获 `{type:'thinking', thinking}` 块；
   opencode `parseOpencodeMessages` 捕获 `{type:'reasoning', text}` part；
   redacted / 缺文本字段跳过，解析器永不抛。
3. 同等对待：thinking 与 assistant 同 20000 cap、同 turnPriority=2、digest
   同 300 字 `THINKING:` 行；三档压缩策略逐字不动。
4. 渲染：distiller prompt `[thinking]` / `[tool:Name]`（无名兜底 `[tool]`）；
   SYSTEM_PROMPT 加 thinking 说明段（可作 rationale 出处证据，未浮现未采纳
   仍 REJECT）；Web 遮罩 thinking 紫徽标 + tool:Name 标签。
5. e2e 闭环锁：fixture 带 thinking 块，断言 `[thinking] …` 抵达 distiller
   输入。无 schema 迁移。

### 上线后观测（并入 2026-08-09 攒量批处理清单）

- thinking turn 占蒸馏输入比例（distill runs 抽样）；
- events 表体积增速变化（thinking 全文入快照，对比 92MB 基线）；
- evidence 摘自 thinking 的候选质量（人工审批抽样）与 LLM 过度提取迹象
  （origin=agent-observed 且 evidence 仅出自 thinking 的占比）。
```

- [ ] **Step 4: Commit**

```bash
git add tests/e2e.test.ts STATE.md
git commit -m "test(e2e): thinking 捕获闭环锁 + STATE 收尾（spec §6/§7）"
```

---

## Self-Review 记录

- **Spec 覆盖**：§4.1 类型/解析 -> Task 1/2/3；§4.2 消费点矩阵 -> Task 1（turnPriority）
  /2（retry 免疫测试）/4（渲染）/5（digest）/6（Web）；§4.3 工具名渲染 -> Task 4/6；
  §4.4 prompt 增补 -> Task 4；§5 失败模式 -> Task 2/3 跳过用例覆盖；§6 测试策略
  1-7 -> Task 2/3/1/4/5/6/7 一一对应；§7 观测回填 -> Task 7 STATE 段落。无缺口。
- **Placeholder 扫描**：无 TBD/TODO；每个代码步骤含完整代码。
- **类型一致性**：`role: 'thinking'`（Task 1 定义）在 Task 2-7 一致；`toolName?: string`
  （pure.ts:114 既有）Task 4/6 复用同名；`formatSourceTurn` 参数加 `toolName?: string`
  与 `SourceTurn`（web/api.ts:140-144）字段同名。

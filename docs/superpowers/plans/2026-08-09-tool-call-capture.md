# 工具调用信息捕获 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让工具调用的 input（Bash 命令、Grep pattern 等）以 `toolCall` 字段进入蒸馏管线，全链路呈现，单条截断 300 字，无按工具特判。

**Architecture:** `TranscriptTurn` 加 `toolCall?: string`（捕获时 stringify+截 300）；两个 runtime 解析器各自从 tool_use input 取 toolCall 落到配对 tool turn；全链路呈现--蒸馏 prompt 两段式、digest tool 行带调用摘要、Web 遮罩展示；预算计量含 toolCall。无 schema 迁移、无新依赖、三档压缩策略逐字不动。

**Tech Stack:** Bun + TypeScript（`bun:test`）。

**Spec:** `docs/superpowers/specs/2026-08-09-tool-call-capture-design.md`（已批准）

## Global Constraints

- 运行门槛：每个 task 提交前 `bun run typecheck && bun test` 全绿。
- 一刀切 + 截断：所有工具的 input 都 stringify 后截 `TOOL_INPUT_CAP_CHARS = 300`，**无按工具特判**。
- 三档压缩策略（`compactToolTurn`：文件类占位 / 非文件 3000 字符 / 错误原文）逐字不动--它只作用于 content，不影响 toolCall。
- 蒸馏预算（64000 token）与 thinking cap（20000 字符）数值不改。
- 不改 origin discipline / REJECT 规则 / JSON 模板 / SYSTEM_PROMPT 既有内容（不含 thinking 段之外的文本）。
- 无新依赖、无 schema 迁移。
- 解析器永不抛契约不变：input 缺失/畸形/非对象 -> 不设 toolCall（= 现状）。
- commit 前缀：`test:` / `feat:` / `docs:`；分支 `feat/tool-call-capture`，禁止直推 master。
- spec + plan 两份文档已随分支首个 commit 落档（前置，不占 task）。

---

### Task 1: `TranscriptTurn` 加 `toolCall` 字段 + `TOOL_INPUT_CAP_CHARS` 常量

**Files:**
- Modify: `src/memory/pure.ts:109-117`（TranscriptTurn 接口）、`src/memory/pure.ts:206` 区域（加常量）
- Test: `tests/pure-transcript-filter.test.ts`

**Interfaces:**
- Consumes: 无（纯类型 + 常量改动）。
- Produces: `TranscriptTurn.toolCall?: string`（Task 2-7 全部依赖）；`TOOL_INPUT_CAP_CHARS = 300`（Task 2/3 捕获层用）。

- [ ] **Step 1: 写失败测试**

在 `tests/pure-transcript-filter.test.ts` 末尾追加（文件顶部已有 `filterTranscriptForDistill` 与 `type TranscriptTurn` 的 import，若无则补）：

```ts
// --- 工具调用信息捕获（spec 2026-08-09 §4.1）---

test('TOOL_INPUT_CAP_CHARS 常量锁定 300', () => {
  expect(TOOL_INPUT_CAP_CHARS).toBe(300)
})
```

import 补 `TOOL_INPUT_CAP_CHARS`：

```ts
import { filterTranscriptForDistill, type TranscriptTurn, TOOL_INPUT_CAP_CHARS } from '@/memory/pure'
```

（若已存在同名 import 则合并，不重复声明。）

- [ ] **Step 2: 跑测试确认红**

Run: `bun test tests/pure-transcript-filter.test.ts`
Expected: FAIL -- `TOOL_INPUT_CAP_CHARS is not defined`（常量未导出）。

- [ ] **Step 3: 实现**

`src/memory/pure.ts:109-117` TranscriptTurn 接口加字段：

```ts
export interface TranscriptTurn {
  role: 'user' | 'assistant' | 'tool' | 'system' | 'thinking'
  content: string
  isError?: boolean
  /** 配对自前一个 assistant 行的 tool_use 块；仅 role==='tool' 有值。 */
  toolName?: string
  /** 提取自 tool_use.input（file_path / notebook_path / path）；仅文件类工具有值。 */
  toolInputPath?: string
  /** 工具调用信息（input 紧凑 JSON，捕获时截 TOOL_INPUT_CAP_CHARS 字）。无则缺失（老 payload/无 input）。 */
  toolCall?: string
}
```

`src/memory/pure.ts` 在 `DEFAULT_DISTILL_INPUT_BUDGET_TOKENS` 附近（约 :206 行）加常量：

```ts
export const TOOL_INPUT_CAP_CHARS = 300
```

- [ ] **Step 4: 跑测试确认绿**

Run: `bun test tests/pure-transcript-filter.test.ts && bun run typecheck`
Expected: PASS 全绿。

- [ ] **Step 5: Commit**

```bash
git add src/memory/pure.ts tests/pure-transcript-filter.test.ts
git commit -m "feat(memory): TranscriptTurn 加 toolCall 字段 + TOOL_INPUT_CAP_CHARS 常量（spec §4.1）"
```

---

### Task 2: claude 解析器捕获 tool_use input 为 toolCall

**Files:**
- Modify: `src/claude/transcript.ts:41-49`（extractToolInputPath 区域，加 captureToolCall）、`src/claude/transcript.ts:51-76`（JSDoc）、`src/claude/transcript.ts:90-93`（pendingToolUses 类型）、`src/claude/transcript.ts:113-156`（assistant 分支与配对消费）
- Test: `tests/transcript.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `toolCall?: string` 与 `TOOL_INPUT_CAP_CHARS`。
- Produces: `parseTranscriptFile` 对 tool_use input 产出 toolCall（落配对 tool turn）。

- [ ] **Step 1: 写失败测试**

`tests/transcript.test.ts` 末尾追加（顶部 import 已含 `parseTranscriptFile`）：

```ts
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
```

- [ ] **Step 2: 跑测试确认红**

Run: `bun test tests/transcript.test.ts`
Expected: FAIL -- toolTurn.toolCall undefined（解析器尚未捕获 input）。

- [ ] **Step 3: 实现**

`src/claude/transcript.ts` 在 `extractToolInputPath` 函数后（约 :49 行后）加 `captureToolCall`：

```ts
/**
 * 把 tool_use 的 input 对象序列化成紧凑 JSON 字符串，截断 TOOL_INPUT_CAP_CHARS 字。
 * 非对象 / 缺失 / 序列化抛错 -> undefined（不设 toolCall，与既有"取不到即跳过"一致）。
 * 一刀切：不做按工具特判（spec §4.1），新工具自动覆盖。
 */
function captureToolCall(input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  try {
    const s = JSON.stringify(input)
    if (typeof s !== 'string') return undefined
    return s.length > TOOL_INPUT_CAP_CHARS ? s.slice(0, TOOL_INPUT_CAP_CHARS) + '…[truncated]' : s
  } catch {
    // 循环引用 / bigint 等 -> 不设 toolCall（永不抛契约）
    return undefined
  }
}
```

文件顶部 import 补 `TOOL_INPUT_CAP_CHARS`：

```ts
import type { TranscriptTurn } from '@/memory/pure'
import { TOOL_INPUT_CAP_CHARS } from '@/memory/pure'
```

`pendingToolUses` 类型（:93）改为：

```ts
const pendingToolUses: { name: string; inputPath?: string; call?: string }[] = []
```

`tool_use` 处理分支（:149-150）改为：

```ts
              } else if (it.type === 'tool_use' && typeof it.name === 'string') {
                pendingToolUses.push({
                  name: it.name,
                  inputPath: extractToolInputPath(it.input),
                  call: captureToolCall(it.input),
                })
              }
```

配对消费（:124-134）改为带上 call：

```ts
                  const paired = pendingToolUses.shift()
                  const base = {
                    role: 'tool' as const,
                    content: extractText(it.content),
                    isError: it.is_error === true,
                  }
                  turns.push(
                    paired
                      ? { ...base, toolName: paired.name, ...(paired.inputPath ? { toolInputPath: paired.inputPath } : {}), ...(paired.call ? { toolCall: paired.call } : {}) }
                      : base,
                  )
```

JSDoc（:66-70 区域）tool_use 那句补：`tool_use.input 经 captureToolCall 序列化截断后作 toolCall 落配对 tool turn`。

- [ ] **Step 4: 跑测试确认绿**

Run: `bun test tests/transcript.test.ts && bun run typecheck`
Expected: PASS 全绿。

- [ ] **Step 5: Commit**

```bash
git add src/claude/transcript.ts tests/transcript.test.ts
git commit -m "feat(claude): parseTranscriptFile 捕获 tool_use input 为 toolCall（spec §4.1）"
```

---

### Task 3: opencode 解析器捕获 tool part input 为 toolCall

**Files:**
- Modify: `src/opencode/transcript.ts:15-22`（JSDoc）、`src/opencode/transcript.ts:27-36`（第一遍扫描）、`src/opencode/transcript.ts:37-56`（第二遍生成）
- Test: `tests/opencode-transcript.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `toolCall?: string` 与 `TOOL_INPUT_CAP_CHARS`。
- Produces: `parseOpencodeMessages` 对 tool part input 产出 toolCall。

- [ ] **Step 1: 写失败测试**

`tests/opencode-transcript.test.ts` 末尾追加：

```ts
test('tool part 带 input -> toolCall；缺 input -> 无', () => {
  const msgs: OpencodeMessage[] = [{
    info: { role: 'assistant' },
    parts: [
      { type: 'tool', tool: 'bash', callID: 'c1', input: { command: 'ls -la' } } as any,
      { type: 'tool', tool: 'grep', callID: 'c2' } as any, // 缺 input
    ],
  }, {
    info: { role: 'user' },
    parts: [
      { type: 'tool', callID: 'c1', output: 'out1' } as any,
      { type: 'tool', callID: 'c2', output: 'out2' } as any,
    ],
  }]
  const turns = parseOpencodeMessages(msgs)
  const t1 = turns.find((t) => t.toolName === 'bash')
  const t2 = turns.find((t) => t.toolName === 'grep')
  expect(t1?.toolCall).toBe('{"command":"ls -la"}')
  expect(t2?.toolCall).toBeUndefined()
})
```

- [ ] **Step 2: 跑测试确认红**

Run: `bun test tests/opencode-transcript.test.ts`
Expected: FAIL -- toolCall undefined。

- [ ] **Step 3: 实现**

`src/opencode/transcript.ts` 顶部 import 补：

```ts
import { TOOL_INPUT_CAP_CHARS } from '@/memory/pure'
```

第一遍扫描（:27-36）`toolNames` 改为记 toolCall 的 Map：

```ts
  // 第一遍：收集 tool_use（assistant 发起），按 callID 记 toolName + toolCall
  const toolMeta = new Map<string, { name: string; call?: string }>()
  for (const m of messages) {
    if (!Array.isArray(m.parts)) continue
    for (const p of m.parts) {
      const tp = p as any
      if (tp.type === 'tool' && tp.callID && tp.input !== undefined && tp.output === undefined) {
        const name = tp.tool ?? 'tool'
        let call: string | undefined
        if (tp.input && typeof tp.input === 'object' && !Array.isArray(tp.input)) {
          try {
            const s = JSON.stringify(tp.input)
            if (typeof s === 'string') call = s.length > TOOL_INPUT_CAP_CHARS ? s.slice(0, TOOL_INPUT_CAP_CHARS) + '…[truncated]' : s
          } catch { /* 循环引用等 -> 不设 */ }
        }
        toolMeta.set(tp.callID, { name, call })
      }
    }
  }
```

第二遍生成（:42-52）tool result 分支改为：

```ts
      } else if (p.type === 'tool') {
        const tp = p as any
        if (tp.output !== undefined) {
          const meta = tp.callID ? toolMeta.get(tp.callID) : undefined
          turns.push({
            role: 'tool',
            content: typeof tp.output === 'string' ? tp.output : JSON.stringify(tp.output),
            isError: tp.error === true,
            toolName: meta?.name,
            ...(meta?.call ? { toolCall: meta.call } : {}),
          })
        }
      }
```

JSDoc（:19）补：`tool_use.input 经序列化截断作 toolCall 落 tool turn（spec §4.1）`。

- [ ] **Step 4: 跑测试确认绿**

Run: `bun test tests/opencode-transcript.test.ts && bun run typecheck`
Expected: PASS 全绿。

- [ ] **Step 5: Commit**

```bash
git add src/opencode/transcript.ts tests/opencode-transcript.test.ts
git commit -m "feat(opencode): parseOpencodeMessages 捕获 tool part input 为 toolCall（spec §4.1）"
```

---

### Task 4: 预算诚实化（filterTranscriptForDistill 计量含 toolCall）

**Files:**
- Modify: `src/memory/pure.ts:261-287`（filterTranscriptForDistill 的 used 与丢弃循环）
- Test: `tests/pure-transcript-filter.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `toolCall?: string`。
- Produces: 预算计量含 toolCall，避免 300 字 × N 个工具调用绕过 64000 token 预算。

- [ ] **Step 1: 写失败测试**

`tests/pure-transcript-filter.test.ts` 末尾追加：

```ts
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
```

- [ ] **Step 2: 跑测试确认红**

Run: `bun test tests/pure-transcript-filter.test.ts`
Expected: FAIL -- 当前计量不含 toolCall，10 条全部保留（`out.length === 10`）。

- [ ] **Step 3: 实现**

`src/memory/pure.ts:269-271` `used` 改为：

```ts
    const used = () => compacted.reduce(
      (s, t) => s + estimateTokens(t.content) + estimateTokens(t.toolCall ?? ''),
      0,
    )
```

丢弃循环（:280-282）改：

```ts
    for (const x of droppable) {
      if (tokens <= budgetTokens) break
      drop.add(x.i)
      tokens -= estimateTokens(compacted[x.i]!.content) + estimateTokens(compacted[x.i]!.toolCall ?? '')
    }
```

- [ ] **Step 4: 跑测试确认绿**

Run: `bun test tests/pure-transcript-filter.test.ts && bun run typecheck`
Expected: PASS 全绿。

- [ ] **Step 5: Commit**

```bash
git add src/memory/pure.ts tests/pure-transcript-filter.test.ts
git commit -m "feat(memory): filterTranscriptForDistill 预算计量含 toolCall（spec §4.2）"
```

---

### Task 5: distiller 渲染两段式（调用: + 结果:）

**Files:**
- Modify: `src/memory/distiller.ts:137`（renderUserPrompt 渲染行）
- Test: `tests/distiller.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `toolCall?: string`。
- Produces: 渲染行 `[tool:Name] 调用: {...}\n结果: <content>`；无 toolCall 时逐字节兼容旧行。

- [ ] **Step 1: 写失败测试**

`tests/distiller.test.ts` 末尾追加（文件已 import `distillTranscript`）：

```ts
// --- 工具调用信息渲染（spec 2026-08-09 §4.2）---

test('renderUserPrompt: tool 带 toolCall -> 两段式 调用: + 结果:', async () => {
  let captured = ''
  await distillTranscript({
    turns: [
      { role: 'tool', content: 'all pass', toolName: 'Bash', toolCall: '{"command":"bun test"}' },
    ],
    runtime: 'claude-code',
    cwd: '/repo',
    existingSlugs: [],
    callLLM: async (_s: string, u: string) => {
      captured = u
      return JSON.stringify({ candidates: [] })
    },
  })
  expect(captured).toContain('[tool:Bash] 调用: {"command":"bun test"}')
  expect(captured).toContain('结果: all pass')
})

test('renderUserPrompt: tool 无 toolCall -> 保持单行 [tool:Name] content（逐字节兼容）', async () => {
  let captured = ''
  await distillTranscript({
    turns: [
      { role: 'tool', content: 'legacy output', toolName: 'Read' },
    ],
    runtime: 'claude-code',
    cwd: '/repo',
    existingSlugs: [],
    callLLM: async (_s: string, u: string) => {
      captured = u
      return JSON.stringify({ candidates: [] })
    },
  })
  expect(captured).toContain('[tool:Read] legacy output')
  expect(captured).not.toContain('调用:')
  expect(captured).not.toContain('结果:')
})
```

- [ ] **Step 2: 跑测试确认红**

Run: `bun test tests/distiller.test.ts`
Expected: FAIL -- 当前渲染 `[tool:Bash] all pass`（无两段式）。

- [ ] **Step 3: 实现**

`src/memory/distiller.ts:137` 渲染行改为：

```ts
  const transcript = turns
    .map((t) => {
      if (t.role !== 'tool') return `[${t.role}] ${t.content}`
      const label = t.toolName ? `[tool:${t.toolName}]` : '[tool]'
      return t.toolCall ? `${label} 调用: ${t.toolCall}\n结果: ${t.content}` : `${label} ${t.content}`
    })
    .join('\n')
```

- [ ] **Step 4: 跑测试确认绿**

Run: `bun test tests/distiller.test.ts && bun run typecheck`
Expected: PASS 全绿。

- [ ] **Step 5: Commit**

```bash
git add src/memory/distiller.ts tests/distiller.test.ts
git commit -m "feat(distiller): 渲染 tool 两段式 调用:/结果:（spec §4.2）"
```

---

### Task 6: contextDigest tool 行带调用摘要

**Files:**
- Modify: `src/memory/contextDigest.ts:5`（加常量）、`src/memory/contextDigest.ts:9-13`（JSDoc）、`src/memory/contextDigest.ts:21-26`（循环）
- Test: `tests/context-digest.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `toolCall?: string`。
- Produces: digest tool 行 `[tool: Name] <截 100 字>`；无 toolCall 时 `[tool: 名字]`。

- [ ] **Step 1: 写失败测试**

`tests/context-digest.test.ts` 的 `describe('buildDeterministicDigest')` 块内追加：

```ts
  test('tool 带 toolCall -> 行带截 100 字调用摘要', () => {
    const d = buildDeterministicDigest([t('tool', 'out', 'Bash')])
    // t() helper 不带 toolCall，需直接构造
  })
```

由于 `t()` helper 不带 toolCall，改用直接对象：

```ts
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
```

- [ ] **Step 2: 跑测试确认红**

Run: `bun test tests/context-digest.test.ts`
Expected: FAIL -- 当前 `[tool: Bash]`（无调用摘要）。

- [ ] **Step 3: 实现**

`src/memory/contextDigest.ts:5` 后加常量：

```ts
export const DIGEST_TOOL_CALL_MAX_CHARS = 100
```

循环（:24）tool 分支改为：

```ts
    else if (t.role === 'tool') {
      const name = t.toolName ?? 'unknown'
      if (t.toolCall) {
        const c = t.toolCall.length > DIGEST_TOOL_CALL_MAX_CHARS
          ? t.toolCall.slice(0, DIGEST_TOOL_CALL_MAX_CHARS) + '…[truncated]'
          : t.toolCall
        lines.push(`[tool: ${name}] ${c}`)
      } else {
        lines.push(`[tool: ${name}]`)
      }
    }
```

JSDoc（:10-11）补：`tool 带 toolCall 时附截 100 字调用摘要`。

- [ ] **Step 4: 跑测试确认绿**

Run: `bun test tests/context-digest.test.ts && bun run typecheck`
Expected: PASS 全绿。

- [ ] **Step 5: Commit**

```bash
git add src/memory/contextDigest.ts tests/context-digest.test.ts
git commit -m "feat(memory): contextDigest tool 行带调用摘要（spec §4.2）"
```

---

### Task 7: Web SourceTurn 加 toolCall + e2e 闭环锁 + STATE 收尾

**Files:**
- Modify: `src/web/api.ts:140-146`（SourceTurn 加字段）、`src/web/App.tsx`（原始输入 tool 行渲染，定位 formatSourceTurn 调用处）
- Modify: `tests/e2e.test.ts:69-76`（fixture）、`tests/e2e.test.ts:144`（断言）
- Modify: `STATE.md`（追加段落）
- Test: `tests/ui-utils.test.ts` 或 `tests/web-api.test.ts`（SourceTurn 类型兜底）

**Interfaces:**
- Consumes: Task 1-6。
- Produces: SourceTurn 带 toolCall；e2e 断言 `调用: {"command"...` 抵达 distiller 输入。

- [ ] **Step 1: SourceTurn 加字段**

`src/web/api.ts:140-146` SourceTurn 接口加：

```ts
export interface SourceTurn {
  role: string
  content: string
  isError?: boolean
  toolName?: string
  toolCall?: string
}
```

- [ ] **Step 2: 找 App.tsx 中原始输入 tool 行渲染处并适配**

读 `src/web/App.tsx`，定位渲染 source turns 的位置（搜 `formatSourceTurn` 或 `SourceTurn` 调用）。在 tool 行的 content 展示前，若 `turn.toolCall` 存在，附一行展示（沿用现有行结构，inline style，不引入新框架）：

```tsx
{turn.toolCall && (
  <div style={{ fontSize: 12, color: '#6a1b9a' }}>调用: {turn.toolCall.slice(0, 300)}</div>
)}
```

（位置：tool 行 content 渲染之前。若现有结构难以插入，最低限度保留 SourceTurn 类型字段透传 + 在 ui-utils 加一个 `formatToolCall` 纯函数供测试兜底。）

- [ ] **Step 3: e2e fixture 加 Bash tool_use+result + 断言（先跑确认）**

`tests/e2e.test.ts:69-76` 的 `writeFileSync` 调用改为（在现有 fixture 基础上追加 assistant tool_use + user tool_result 行）：

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
    }) + '\n' +
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [
        { type: 'text', text: 'checking the refund policy' },
        { type: 'tool_use', id: 'toolu_e2e', name: 'Bash', input: { command: 'grep -r refund RULES.md', description: 'find refund policy' } },
      ] },
    }) + '\n' +
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_e2e', content: 'no matches found' }] },
    }) + '\n',
  )
```

`tests/e2e.test.ts:144`（既有断言后）追加：

```ts
  // 工具调用信息闭环锁（spec 2026-08-09 §6 #6）：tool_use input 经真实链路
  // 抵达 distiller 输入，以 调用: 标签呈现。
  expect(capturedUserPrompt).toContain('调用: {"command":"grep -r refund RULES.md"')
```

Run: `bun test tests/e2e.test.ts`
Expected: 若 Task 2/5 已合并则 PASS（闭环验证锁）。

- [ ] **Step 4: 全套测试 + 类型检查**

Run: `bun run typecheck && bun test`
Expected: 全绿。

- [ ] **Step 5: STATE.md 追加段落**

`STATE.md` 末尾追加：

```markdown
## 工具调用信息捕获（2026-08-09）

诊断：thinking 捕获（PR #54）让 distiller 看到 `[tool:Read]` 标签，但工具调用的
input（Bash 命令、Grep pattern 等）仍被整体丢弃--distiller 看到工具结果却不知
是哪条命令跑出来的。设计 spec / 计划见 `docs/superpowers/specs|plans/
2026-08-09-tool-call-capture*`。

1. `TranscriptTurn` 加 `toolCall?: string`：input 紧凑 JSON，捕获时截
   `TOOL_INPUT_CAP_CHARS`(300) 字。一刀切，无按工具特判（新工具自动覆盖）。
2. claude `parseTranscriptFile` 配对时从 tool_use.input 取 toolCall；
   opencode `parseOpencodeMessages` 按 callID 取。input 缺失/畸形 -> 不设，
   解析器永不抛契约不变。老 payload 无 toolCall -> 全链路走无调用分支（向后兼容）。
3. 全链路呈现：distiller prompt 两段式 `调用: {...}` + `结果: ...`（无 toolCall
   时逐字节兼容单行）；digest tool 行带截 100 字调用摘要；Web 原始输入遮罩展示。
4. 预算诚实化：`filterTranscriptForDistill` 计量含 toolCall，避免 300 字 × N
   个工具调用绕过 64000 token 预算。三档压缩策略逐字不动（只作用于 content）。
5. e2e 闭环锁：fixture 加 Bash tool_use+result，断言 `调用: {"command"...`
   抵达 distiller 输入。无 schema 迁移、无新依赖。

### 上线后观测（并入既有清单）

- events 表体积增速变化（toolCall 入快照，每条 tool turn 至多 +300 字）；
- 蒸馏候选中 evidence 引自命令调用（`调用:` 行）的质量抽样；
- distill runs 抽样：toolCall 占蒸馏输入的比例。
```

- [ ] **Step 6: Commit**

```bash
git add src/web/api.ts src/web/App.tsx tests/e2e.test.ts STATE.md
git commit -m "feat(web,e2e): SourceTurn toolCall + 闭环锁 + STATE 收尾（spec §4.2/§6/§7）"
```

---

## Self-Review 记录

- **Spec 覆盖**：§4.1 数据模型/捕获 -> Task 1/2/3；§4.2 呈现 -> Task 5（prompt）/6（digest）/7（Web）；§4.2 预算诚实化 -> Task 4；§5 失败模式 -> Task 2/3 缺失/截断用例；§6 测试策略 1-7 -> Task 2/3/4/5/6/7 + Task 1 常量；§7 观测 -> Task 7 STATE 段落。无缺口。
- **Placeholder 扫描**：无 TBD/TODO；每个代码步骤含完整代码。Task 7 Step 2 的 App.tsx 渲染处因需读文件定位，给了兜底方案（ui-utils 纯函数）。
- **类型一致性**：`toolCall?: string`（Task 1 定义）在 Task 2-7 一致；`TOOL_INPUT_CAP_CHARS`（Task 1）Task 2/3 复用同名；`DIGEST_TOOL_CALL_MAX_CHARS`（Task 6 定义）仅 Task 6 用。
- **风险点**：Task 7 Step 2 App.tsx 渲染需读文件确认现有结构，已给兜底；Task 4 预算计量改动需确认无既有测试依赖旧计量（typecheck 会兜底）。

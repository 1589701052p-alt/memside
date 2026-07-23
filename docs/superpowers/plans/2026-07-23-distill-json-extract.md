# distill/dedup JSON 提取层（三道防线） Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 三道防线解决 distiller/dedup 的 LLM 输出 `JSON.parse` 静默失败--`extractJsonObject` 清洗 + 提示词加固含 JSON 模板 + `callWithRetry` 重试兜底，应用到 distiller + dedup，不改现有失败行为。

**Architecture:** `extractJsonObject` 纯函数加到 `src/memory/pure.ts`（字符级状态机，无正则）；`callWithRetry` 高阶函数新文件 `src/memory/retry.ts`（`call -> extract -> parse -> shouldRetry`，失败带错误反馈重试，耗尽返回 `lastParsed`）；`distiller.ts` / `dedup.ts` 的 `callAnthropic + JSON.parse` 段改用 `callWithRetry` + 注入 `distillShouldRetry` / `dedupShouldRetry`，SYSTEM_PROMPT 末尾换带示例值的 few-shot 模板。现有候选解析 / 过滤 / 丢弃 / 幻觉兜底不变。

**Tech Stack:** Bun + bun:test + TypeScript（`@anthropic-ai/sdk` 不变）。

## Global Constraints

- `bun run typecheck && bun test` 必须全绿才能 push（CLAUDE.md 运行门槛）。
- 严禁直推 `master`；本分支 `feat/distill-json-extract`（基线 `origin/master` `26b5418`，已含 spec commit `122bd32`），PR 合 `master`。
- 任何生产代码改动必须带测试；TDD（先写失败测试再实现）；纯函数 / 高阶函数为首选可断言面（CLAUDE.md）。
- **不改现有失败行为**：三道都失败时 distiller 仍返回空数组、dedup 仍全 `new`（保守）；`shouldRetry` 只给模型重试机会，耗尽走现有兜底。
- 零 schema 变更：不增列、不删列、不写迁移。
- `callAnthropic` seam（`(system, user) => Promise<string>`）不变；`callWithRetry` 在 seam 之上包装。
- claude code / opencode 行为以源码为准；本计划不改动 hook 协议。

## File Structure

| 文件 | 职责 | 本计划动作 |
|------|------|-----------|
| `src/memory/pure.ts` | 纯函数集中地 | 加 `extractJsonObject` |
| `src/memory/retry.ts`（新） | 重试高阶函数 | 新建 `callWithRetry` + `RetryOpts` |
| `src/memory/distiller.ts` | distill 提炼 | `DISTILLER_SYSTEM_PROMPT` 换模板 + parse 段改 `callWithRetry` + `distillShouldRetry` |
| `src/memory/dedup.ts` | 语义去重判定 | `DEDUP_SYSTEM_PROMPT` 换模板 + parse 段改 `callWithRetry` + `dedupShouldRetry` |
| `tests/pure-json-extract.test.ts`（新） | extractJsonObject 纯函数 | 全 case 单测 |
| `tests/retry.test.ts`（新） | callWithRetry 高阶函数 | 全 case 单测（mock call） |
| `tests/distiller.test.ts` | distill | 加围栏回归 + shouldRetry + 耗尽 + prompt 断言 |
| `tests/dedup.test.ts` | dedup | 加围栏回归 + shouldRetry + 耗尽 + prompt 断言 |

依赖方向（无循环）：`retry.ts` -> `pure.ts`；`distiller.ts` -> `retry.ts` + `pure.ts`（已有）；`dedup.ts` -> `retry.ts` + `pure.ts`（已有 type-only）。

---

## Task 1: extractJsonObject 纯函数

**Files:**
- Modify: `src/memory/pure.ts`（末尾追加）
- Test: `tests/pure-json-extract.test.ts`（新）

**Interfaces:**
- Produces: `extractJsonObject(raw: string): string`。无 `{` / 截断兜底返回原文本（或 `raw.slice(start)`），匹配返回 `[start..i]` 子串。

- [ ] **Step 1: 写失败测试**

新建 `tests/pure-json-extract.test.ts`：

```ts
import { test, expect } from 'bun:test'
import { extractJsonObject } from '@/memory/pure'

test('strips ```json fence', () => {
  expect(extractJsonObject('```json\n{"a":1}\n```')).toBe('{"a":1}')
})

test('strips bare ``` fence', () => {
  expect(extractJsonObject('```\n{"a":1}\n```')).toBe('{"a":1}')
})

test('strips ~~~ fence', () => {
  expect(extractJsonObject('~~~json\n{"a":1}\n~~~')).toBe('{"a":1}')
})

test('extracts object surrounded by prose', () => {
  expect(extractJsonObject('好的，结果如下：\n{"a":1}\n希望有帮助')).toBe('{"a":1}')
})

test('handles braces inside strings', () => {
  expect(extractJsonObject('{"title":"a{b}"}')).toBe('{"title":"a{b}"}')
})

test('handles nested objects', () => {
  expect(extractJsonObject('{"a":{"b":{"c":1}}}')).toBe('{"a":{"b":{"c":1}}}')
})

test('returns first balanced object when multiple', () => {
  expect(extractJsonObject('前缀{"a":1}尾部{"b":2}')).toBe('{"a":1}')
})

test('returns original when no brace (pure text)', () => {
  expect(extractJsonObject('I cannot help with that')).toBe('I cannot help with that')
})

test('returns slice from first brace when truncated', () => {
  expect(extractJsonObject('好的：{"a":1')).toBe('{"a":1')
})

test('returns empty string for empty input', () => {
  expect(extractJsonObject('')).toBe('')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/pure-json-extract.test.ts`
Expected: FAIL（`extractJsonObject` 未从 `@/memory/pure` 导出，import 报错）。

- [ ] **Step 3: 实现 extractJsonObject**

在 `src/memory/pure.ts` 文件末尾追加：

```ts
/**
 * Extract the first balanced {...} object from raw LLM output. Strips markdown
 * fences (```json...``` / ```...``` / ~~~...~~~) and surrounding prose by
 * locating the first '{' and scanning to its matching '}' with string-aware
 * depth counting (braces inside "..." / \"...\" are NOT counted). No regex.
 *
 * - No '{' in raw -> return raw (caller's JSON.parse fails into its existing catch).
 * - Matched -> return the [start..i] substring.
 * - Unbalanced (truncated) -> return raw.slice(start) (parse fails, existing catch).
 *
 * Property: only turns a "false failure" (valid {...} buried in noise) into
 * success; genuinely-non-JSON input is passed through unchanged.
 */
export function extractJsonObject(raw: string): string {
  const start = raw.indexOf('{')
  if (start === -1) return raw
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < raw.length; i++) {
    const c = raw[i]
    if (inString) {
      if (escape) escape = false
      else if (c === '\\') escape = true
      else if (c === '"') inString = false
    } else {
      if (c === '"') inString = true
      else if (c === '{') depth++
      else if (c === '}') {
        depth--
        if (depth === 0) return raw.slice(start, i + 1)
      }
    }
  }
  return raw.slice(start)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/pure-json-extract.test.ts`
Expected: PASS（10 个测试全绿）。

- [ ] **Step 5: Commit**

```bash
git add src/memory/pure.ts tests/pure-json-extract.test.ts
git commit -m "feat(pure): extractJsonObject state-machine JSON extractor" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: callWithRetry 高阶函数

**Files:**
- Create: `src/memory/retry.ts`
- Test: `tests/retry.test.ts`（新）

**Interfaces:**
- Consumes: `extractJsonObject`（Task 1，from `./pure`）。
- Produces: `callWithRetry(opts: RetryOpts): Promise<unknown>`、`RetryOpts`（`{ call, system, user, shouldRetry, maxRetries? }`）。`shouldRetry: (parsed: unknown) => string | null`（返回错误信息则重试，null 接受）。默认 `maxRetries=2`（共 3 次尝试）。耗尽返回 `lastParsed`（可能 undefined）。

- [ ] **Step 1: 写失败测试**

新建 `tests/retry.test.ts`：

```ts
import { test, expect } from 'bun:test'
import { callWithRetry } from '@/memory/retry'

test('returns parsed value on first success, no retry', async () => {
  let calls = 0
  const result = await callWithRetry({
    call: async () => { calls++; return '{"a":1}' },
    system: 'sys', user: 'usr',
    shouldRetry: () => null,
  })
  expect(calls).toBe(1)
  expect(result).toEqual({ a: 1 })
})

test('retries on parse failure and succeeds on retry', async () => {
  let calls = 0
  const result = await callWithRetry({
    call: async () => {
      calls++
      if (calls === 1) return 'not json'
      return '{"a":1}'
    },
    system: 'sys', user: 'usr',
    shouldRetry: () => null,
  })
  expect(calls).toBe(2)
  expect(result).toEqual({ a: 1 })
})

test('retries when shouldRetry returns an error', async () => {
  let calls = 0
  const result = await callWithRetry({
    call: async () => { calls++; return '{"a":1}' },
    system: 'sys', user: 'usr',
    shouldRetry: () => 'always bad',
  })
  expect(calls).toBe(3)
  expect(result).toEqual({ a: 1 })
})

test('returns undefined (lastParsed) when parse never succeeds', async () => {
  let calls = 0
  const result = await callWithRetry({
    call: async () => { calls++; return 'not json' },
    system: 'sys', user: 'usr',
    shouldRetry: () => null,
  })
  expect(calls).toBe(3)
  expect(result).toBeUndefined()
})

test('retries when call throws', async () => {
  let calls = 0
  const result = await callWithRetry({
    call: async () => {
      calls++
      if (calls === 1) throw new Error('api down')
      return '{"a":1}'
    },
    system: 'sys', user: 'usr',
    shouldRetry: () => null,
  })
  expect(calls).toBe(2)
  expect(result).toEqual({ a: 1 })
})

test('error feedback prompt includes last error message', async () => {
  const capturedUsers: string[] = []
  await callWithRetry({
    call: async (_sys, user) => { capturedUsers.push(user); return 'not json' },
    system: 'sys', user: 'original',
    shouldRetry: () => null,
  })
  expect(capturedUsers.length).toBe(3)
  expect(capturedUsers[0]).toBe('original')
  expect(capturedUsers[1]).toContain('original')
  expect(capturedUsers[1]).toContain('[修正]')
  expect(capturedUsers[1]).toMatch(/JSON/i)
})

test('respects maxRetries option', async () => {
  let calls = 0
  await callWithRetry({
    call: async () => { calls++; return 'not json' },
    system: 'sys', user: 'usr',
    shouldRetry: () => null,
    maxRetries: 0,
  })
  expect(calls).toBe(1)
})

test('fence-wrapped output is extracted and parsed without retry', async () => {
  let calls = 0
  const result = await callWithRetry({
    call: async () => { calls++; return '```json\n{"a":1}\n```' },
    system: 'sys', user: 'usr',
    shouldRetry: () => null,
  })
  expect(calls).toBe(1)
  expect(result).toEqual({ a: 1 })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/retry.test.ts`
Expected: FAIL（`@/memory/retry` 模块不存在，import 报错）。

- [ ] **Step 3: 实现 retry.ts**

新建 `src/memory/retry.ts`：

```ts
import { extractJsonObject } from './pure'

export interface RetryOpts {
  call: (system: string, user: string) => Promise<string>
  system: string
  user: string
  /** Return an error message to retry, or null to accept the parsed output. */
  shouldRetry: (parsed: unknown) => string | null
  maxRetries?: number
}

const FEEDBACK_SUFFIX = '请只输出纯 JSON 对象，不要 markdown 围栏，不要解释文字，键与字符串值用双引号，最后一个属性后无逗号。'

/**
 * Call `call` -> extractJsonObject -> JSON.parse -> shouldRetry. On any failure
 * (call throws, parse fails, shouldRetry returns an error), feed the error back
 * to the model in natural language and retry, up to maxRetries times (default 2,
 * so 3 total attempts).
 *
 * Returns the last successfully-parsed object (or undefined if parse never
 * succeeded), so the caller's existing `!parsed` guards still catch the
 * exhausted case -> existing fallback behavior unchanged.
 */
export async function callWithRetry(opts: RetryOpts): Promise<unknown> {
  const maxRetries = opts.maxRetries ?? 2
  let lastParsed: unknown = undefined
  let currentUser = opts.user
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let raw: string
    try {
      raw = await opts.call(opts.system, currentUser)
    } catch (e) {
      if (attempt === maxRetries) return lastParsed
      const error = `调用失败：${e instanceof Error ? e.message : String(e)}`
      currentUser = `${opts.user}\n\n[修正] 你上次的回答有问题：${error}。${FEEDBACK_SUFFIX}`
      continue
    }
    const cleaned = extractJsonObject(raw)
    let parsed: unknown
    try {
      parsed = JSON.parse(cleaned)
    } catch (e) {
      if (attempt === maxRetries) return lastParsed
      const error = `不是合法 JSON：${e instanceof Error ? e.message : String(e)}`
      currentUser = `${opts.user}\n\n[修正] 你上次的回答有问题：${error}。${FEEDBACK_SUFFIX}`
      continue
    }
    lastParsed = parsed
    const retryError = opts.shouldRetry(parsed)
    if (retryError === null) return parsed
    if (attempt === maxRetries) return lastParsed
    currentUser = `${opts.user}\n\n[修正] 你上次的回答有问题：${retryError}。${FEEDBACK_SUFFIX}`
  }
  return lastParsed
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/retry.test.ts`
Expected: PASS（8 个测试全绿）。

- [ ] **Step 5: Commit**

```bash
git add src/memory/retry.ts tests/retry.test.ts
git commit -m "feat(retry): callWithRetry with error-feedback retries" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: distiller 集成（提示词加固 + callWithRetry + distillShouldRetry）

**Files:**
- Modify: `src/memory/distiller.ts`（`DISTILLER_SYSTEM_PROMPT` 末尾 `distiller.ts:30`、import 区、`distillTranscript` 的 `distiller.ts:62-63`、新增 `distillShouldRetry`）
- Test: `tests/distiller.test.ts`（扩）

**Interfaces:**
- Consumes: `callWithRetry`（Task 2，from `./retry`）。
- Produces: `distillTranscript` 内部改用 `callWithRetry`；私有 `distillShouldRetry(parsed): string | null`。`DISTILLER_SYSTEM_PROMPT` 末尾换模板。`DistillInput.callAnthropic` seam 不变。

- [ ] **Step 1: 写失败测试**

在 `tests/distiller.test.ts` 末尾追加：

```ts
test('distillTranscript parses fence-wrapped JSON (regression)', async () => {
  const result = await distillTranscript({
    turns: [{ role: 'user', content: 'we only refund within 14 days' }],
    runtime: 'claude-code',
    cwd: '/repo',
    callAnthropic: async () => '```json\n{"candidates":[{"title":"[category:invariant] refunds within 14 days","bodyMd":"14d","scope":"project","runtime":null,"distillAction":"new"}]}\n```',
  })
  expect(result.length).toBe(1)
  expect(result[0]!.title).toContain('[category:')
})

test('distillTranscript retries when candidate lacks [category: prefix', async () => {
  let calls = 0
  const result = await distillTranscript({
    turns: [{ role: 'user', content: 'x' }],
    runtime: 'claude-code', cwd: '/repo',
    callAnthropic: async () => {
      calls++
      if (calls === 1) return JSON.stringify({ candidates: [{ title: 'no prefix here', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] })
      return JSON.stringify({ candidates: [{ title: '[category:invariant] fixed', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] })
    },
  })
  expect(calls).toBe(2)
  expect(result.length).toBe(1)
  expect(result[0]!.title).toContain('[category:')
})

test('distillTranscript returns [] when retry exhausted', async () => {
  const result = await distillTranscript({
    turns: [{ role: 'user', content: 'x' }],
    runtime: 'claude-code', cwd: '/repo',
    callAnthropic: async () => 'not json',
  })
  expect(result).toEqual([])
})

test('DISTILLER_SYSTEM_PROMPT contains JSON template with example values', () => {
  expect(DISTILLER_SYSTEM_PROMPT).toContain('[category:')
  expect(DISTILLER_SYSTEM_PROMPT).toContain('"scope": "project"')
  expect(DISTILLER_SYSTEM_PROMPT).toContain('仅示范结构')
})
```

注意：`tests/distiller.test.ts` 顶部已有 `import { distillTranscript, DISTILLER_SYSTEM_PROMPT } from '@/memory/distiller'`（确认含 `DISTILLER_SYSTEM_PROMPT`，若不含则补）。

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/distiller.test.ts`
Expected: 第 1 个测试 FAIL（当前 `distillTranscript` 直接 `JSON.parse(raw)`，围栏包裹的 raw parse 失败 -> catch -> 返回 `[]`，`result.length` 为 0 而非 1）；第 4 个测试 FAIL（当前 prompt 不含 `"scope": "project"` 模板）。第 2、3 个测试当前可能恰好通过（无重试时 callCount=1、`not json` 返回 []），第 2 个的 `calls===2` 断言会 FAIL（当前 calls=1）。驱动测试为第 1、2、4 个。

- [ ] **Step 3: 改 distiller.ts**

(a) 在 `src/memory/distiller.ts` 顶部 import 区（`import { detectErrorSignals, ... } from './pure'` 之后）加：

```ts
import { callWithRetry } from './retry'
```

(b) 把 `DISTILLER_SYSTEM_PROMPT` 末尾的类型签名式 JSON（`distiller.ts:30`，即 `Respond with ONLY a JSON object: {"candidates":[...]}` 那一行，含闭合反引号）替换为带示例值的模板：

```
输出格式如下（仅示范结构，勿照抄内容；只输出这一个 JSON 对象，不要 markdown 围栏，不要在 JSON 前后加任何解释文字，键与字符串值用双引号，最后一个属性后无逗号，不要用单引号）：
{
  "candidates": [
    {
      "title": "[category:convention] 每个 PR 必须在 CHANGELOG.md 的 Unreleased 部分加一条",
      "bodyMd": "项目约定：PR 合并前需在 CHANGELOG.md 的 Unreleased 段落补充变更条目。",
      "scope": "project",
      "runtime": "claude-code",
      "distillAction": "new"
    }
  ]
}`
```

（保留前面的 prompt 主体不变，只替换结尾这一段；闭合反引号仍在末尾。）

(c) 在 `distillTranscript` 函数之前（`DISTILLER_SYSTEM_PROMPT` 之后、`DistillCandidate` 之前或 `distillTranscript` 之前均可，建议放 `distillTranscript` 紧上方）新增私有 `distillShouldRetry`：

```ts
/**
 * Validate parsed distill output for retry-worthiness. Returns an error message
 * to trigger a retry, or null to accept. Checks: parsed is an object with a
 * `candidates` array, each candidate has string title/bodyMd, and each title
 * carries a `[category:` prefix. Exhausted retries fall through to the existing
 * per-candidate `continue` drop logic, so a missing prefix is still tolerated.
 */
function distillShouldRetry(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== 'object') return '返回的不是 JSON 对象'
  const p = parsed as { candidates?: unknown }
  if (!Array.isArray(p.candidates)) return '缺少 candidates 数组'
  for (let i = 0; i < p.candidates.length; i++) {
    const c = p.candidates[i] as Record<string, unknown> | null
    if (!c || typeof c.title !== 'string' || typeof c.bodyMd !== 'string') {
      return `候选 ${i} 缺少 title 或 bodyMd`
    }
    if (!c.title.includes('[category:')) {
      return `候选 ${i} 的 title 缺少 [category:xxx] 前缀`
    }
  }
  return null
}
```

(d) 把 `distillTranscript` 里的 `distiller.ts:62-63`：

```ts
    const raw = await input.callAnthropic(DISTILLER_SYSTEM_PROMPT, userPrompt)
    const parsed = JSON.parse(raw) as { candidates?: unknown }
```

替换为：

```ts
    const parsed = await callWithRetry({
      call: input.callAnthropic,
      system: DISTILLER_SYSTEM_PROMPT,
      user: userPrompt,
      shouldRetry: distillShouldRetry,
    }) as { candidates?: unknown } | undefined
```

（后续 `if (!parsed || !Array.isArray(parsed.candidates)) return []` 及候选解析循环 `distiller.ts:64-86` 完全不变。）

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/distiller.test.ts`
Expected: PASS（含 4 个新测试 + 原有 4 个测试仍绿）。注意原有"returns [] on malformed response"（`callAnthropic: async () => 'not json'`）与"never throws"（`callAnthropic` 抛错）现在会重试 3 次后返回 `[]`，断言 `toEqual([])` 仍成立。

- [ ] **Step 5: Commit**

```bash
git add src/memory/distiller.ts tests/distiller.test.ts
git commit -m "feat(distiller): JSON template + callWithRetry + distillShouldRetry" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: dedup 集成（提示词加固 + callWithRetry + dedupShouldRetry）

**Files:**
- Modify: `src/memory/dedup.ts`（`DEDUP_SYSTEM_PROMPT` 末尾 `dedup.ts:24`、import 区、`judgeDuplicates` 的 `dedup.ts:51-52`、新增 `dedupShouldRetry`）
- Test: `tests/dedup.test.ts`（扩）

**Interfaces:**
- Consumes: `callWithRetry`（Task 2，from `./retry`）。
- Produces: `judgeDuplicates` 内部改用 `callWithRetry`；私有 `dedupShouldRetry(existingIds)` 返回 `(parsed) => string | null`（闭包捕获 `existingIds`）。`DEDUP_SYSTEM_PROMPT` 末尾换模板。`DedupInput.callAnthropic` seam 不变。

- [ ] **Step 1: 写失败测试**

在 `tests/dedup.test.ts` 末尾追加：

```ts
test('judgeDuplicates parses fence-wrapped verdicts (regression)', async () => {
  const v = await judgeDuplicates({
    newCandidates: [newCand], existing,
    callAnthropic: async () => '```json\n{"verdicts":[{"index":0,"isDuplicate":true,"duplicateOfId":"A"}]}\n```',
  })
  expect(v).toEqual([{ index: 0, duplicate: true, duplicateOfId: 'A' }])
})

test('judgeDuplicates retries when duplicateOfId is hallucinated', async () => {
  let calls = 0
  const v = await judgeDuplicates({
    newCandidates: [newCand], existing,
    callAnthropic: async () => {
      calls++
      if (calls === 1) return JSON.stringify({ verdicts: [{ index: 0, isDuplicate: true, duplicateOfId: 'NONEXISTENT' }] })
      return JSON.stringify({ verdicts: [{ index: 0, isDuplicate: true, duplicateOfId: 'A' }] })
    },
  })
  expect(calls).toBe(2)
  expect(v).toEqual([{ index: 0, duplicate: true, duplicateOfId: 'A' }])
})

test('judgeDuplicates returns all new when retry exhausted', async () => {
  const v = await judgeDuplicates({
    newCandidates: [newCand], existing,
    callAnthropic: async () => 'not json',
  })
  expect(v).toEqual([{ index: 0, duplicate: false }])
})

test('DEDUP_SYSTEM_PROMPT contains verdicts template', () => {
  expect(DEDUP_SYSTEM_PROMPT).toContain('"isDuplicate"')
  expect(DEDUP_SYSTEM_PROMPT).toContain('"duplicateOfId"')
  expect(DEDUP_SYSTEM_PROMPT).toContain('仅示范结构')
})
```

注意：`tests/dedup.test.ts` 顶部 import 行 `import { judgeDuplicates, type ExistingMemoryForDedup } from '@/memory/dedup'` 需补 `DEDUP_SYSTEM_PROMPT`：

```ts
import { judgeDuplicates, DEDUP_SYSTEM_PROMPT, type ExistingMemoryForDedup } from '@/memory/dedup'
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/dedup.test.ts`
Expected: 第 1 个测试 FAIL（当前 `judgeDuplicates` 直接 `JSON.parse(raw)`，围栏 raw parse 失败 -> catch -> 全 new，`duplicate` 为 false 而非 true）；第 4 个测试 FAIL（当前 prompt 不含模板）。第 2 个测试 FAIL（当前无重试，calls=1 而非 2）。驱动测试为第 1、2、4 个。

- [ ] **Step 3: 改 dedup.ts**

(a) 在 `src/memory/dedup.ts` 顶部 import 区（`import type { MemoryScope, MemoryStatus } from '@/memory/pure'` 之后）加：

```ts
import { callWithRetry } from './retry'
```

(b) 把 `DEDUP_SYSTEM_PROMPT` 末尾的 `dedup.ts:24`（`Respond ONLY with JSON: {...}. Emit one verdict...` 那一行，含闭合反引号）替换为模板 + 保留 emit 指令：

```
输出格式如下（仅示范结构，勿照抄内容；只输出这一个 JSON 对象，无 markdown 围栏，无解释文字）：
{
  "verdicts": [
    {"index": 0, "isDuplicate": false},
    {"index": 1, "isDuplicate": true, "duplicateOfId": "A"}
  ]
}
Emit one verdict per new candidate, keyed by its index. duplicateOfId MUST be one of the existing ids. When unsure, emit isDuplicate:false.`
```

（保留 prompt 主体不变，只替换结尾；闭合反引号仍在末尾。）

(c) 在 `judgeDuplicates` 函数之前新增私有 `dedupShouldRetry`：

```ts
/**
 * Validate parsed dedup output for retry-worthiness. Returns an error message
 * to retry, or null to accept. Checks: parsed has a `verdicts` array, each
 * verdict has a numeric `index`, and any `isDuplicate:true` verdict references
 * a `duplicateOfId` in `existingIds`. Exhausted retries fall through to the
 * existing per-verdict hallucination->new logic.
 */
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
        if (!existingIds.has(v.duplicateOfId)) return `verdict ${v.index} 的 duplicateOfId 不在已有记忆中`
      }
    }
    return null
  }
}
```

(d) 把 `judgeDuplicates` 里的 `dedup.ts:51-52`：

```ts
    const raw = await input.callAnthropic(DEDUP_SYSTEM_PROMPT, renderUserPrompt(input.newCandidates, input.existing))
    const parsed = JSON.parse(raw) as { verdicts?: unknown }
```

替换为：

```ts
    const parsed = await callWithRetry({
      call: input.callAnthropic,
      system: DEDUP_SYSTEM_PROMPT,
      user: renderUserPrompt(input.newCandidates, input.existing),
      shouldRetry: dedupShouldRetry(existingIds),
    }) as { verdicts?: unknown } | undefined
```

（后续 `if (!parsed || !Array.isArray(parsed.verdicts))` 全 new 兜底及 verdict 处理循环 `dedup.ts:56-69` 完全不变；`existingIds` 已在 `dedup.ts:49` 计算。）

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/dedup.test.ts`
Expected: PASS（含 4 个新测试 + 原有 10 个测试仍绿）。注意原有"treats hallucinated duplicateOfId as new"现在会重试 3 次（mock 固定返回幻觉）后仍当 new，断言成立；"returns all new on non-JSON response"重试 3 次后返回全 new，断言成立。

- [ ] **Step 5: Commit**

```bash
git add src/memory/dedup.ts tests/dedup.test.ts
git commit -m "feat(dedup): JSON template + callWithRetry + dedupShouldRetry" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## 收尾：全量验证 + push + PR

- [ ] **Step 1: 最终门禁**

Run: `bun run typecheck && bun test`
Expected: typecheck 干净；全部测试绿（含原有 100+ 与 Task 1-4 新增测试）。

- [ ] **Step 2: 清理 brainstorming 中间产物**

Run: `rm -rf .superpowers/sdd/`（若为空则无操作；CLAUDE.md 闸门，写代码前完成）。

- [ ] **Step 3: 推远端 + 开 PR**

```bash
git push -u origin feat/distill-json-extract
gh pr create --base master --title "feat: distill/dedup JSON 提取层三道防线" --body "..."
```

PR body 摘要：三道防线解决 LLM 输出 `JSON.parse` 静默失败--① `extractJsonObject` 纯函数（`pure.ts`，字符级状态机扒围栏/抠 `{...}`，无正则）② 提示词加固含带示例值的 JSON 模板（`DISTILLER`/`DEDUP_SYSTEM_PROMPT`）③ `callWithRetry` 重试 + 错误反馈（新 `retry.ts`，`shouldRetry` 回调注入业务校验，耗尽返回 `lastParsed`）。应用到 `distiller.ts:62-63` + `dedup.ts:51-52`，现有候选解析/过滤/丢弃/幻觉兜底不变，零 schema 变更。详见 `docs/superpowers/specs/2026-07-23-distill-json-extract-design.md`。

---

## Self-Review（写计划后自检）

**1. Spec 覆盖：**
- G1（围栏/夹带解析）-> Task 1 `extractJsonObject` + Task 3/4 集成（围栏回归测试）。✅
- G2（提示词加固 + 模板）-> Task 3 `DISTILLER_SYSTEM_PROMPT` 模板 + Task 4 `DEDUP_SYSTEM_PROMPT` 模板（prompt 断言测试）。✅
- G3（重试 + 错误反馈）-> Task 2 `callWithRetry` + Task 3/4 注入 `shouldRetry`（重试测试）。✅
- G4（隔离纯函数/高阶函数，不改业务逻辑）-> Task 1 `pure.ts` + Task 2 `retry.ts` 独立模块；Task 3/4 只改 parse 段，候选解析/过滤/幻觉兜底不变。✅
- G5（不改失败行为）-> Task 2 耗尽返回 `lastParsed`；Task 3/4 现有 `!parsed` 兜底不变（耗尽测试）。✅
- G6（零 schema）-> 全计划无 DDL/迁移。✅
- §5.1 `extractJsonObject` -> Task 1。✅
- §5.2 `callWithRetry` + `RetryOpts` + `lastParsed` -> Task 2。✅
- §5.3 两个 SYSTEM_PROMPT 模板 -> Task 3/4。✅
- §5.4 distiller/dedup 集成 + `distillShouldRetry`/`dedupShouldRetry(existingIds)` -> Task 3/4。✅
- §8 失败模式（围栏/夹带/尾逗号/截断/前缀/幻觉/call 抛错/耗尽/纯文本）-> Task 1（截断/纯文本/空串）+ Task 2（parse 失败/shouldRetry/call 抛错/耗尽）+ Task 3（围栏/前缀/耗尽）+ Task 4（围栏/幻觉/耗尽）。✅
- §9 测试策略（pure-json-extract / retry / distiller 扩 / dedup 扩）-> Task 1-4。✅

**2. 占位扫描：** 无 TBD/TODO；每步含完整代码或确切命令。✅

**3. 类型一致性：** `extractJsonObject(raw: string): string` Task 1 定义、Task 2 `retry.ts` import。`callWithRetry(opts: RetryOpts): Promise<unknown>` + `RetryOpts { call, system, user, shouldRetry, maxRetries? }` Task 2 定义、Task 3/4 import。`shouldRetry: (parsed: unknown) => string | null` Task 2 定义；Task 3 `distillShouldRetry(parsed): string | null`、Task 4 `dedupShouldRetry(existingIds): (parsed) => string | null` 签名一致。`distiller.ts`/`dedup.ts` parse 段 `as { candidates?: unknown } | undefined` / `as { verdicts?: unknown } | undefined` 与 `callWithRetry` 返回 `Promise<unknown>` 一致。命名跨任务一致（`extractJsonObject`/`callWithRetry`/`RetryOpts`/`distillShouldRetry`/`dedupShouldRetry`/`FEEDBACK_SUFFIX`）。✅

# OpenAI 后端流式化 + 失败彻底可诊断 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** openai 后端流式化根治大 transcript distill 的 120s `aborted`；judge 失败分类对齐 distill 路径透出真实原因；distill/dedup 步失败补存输入快照让失败不黑盒。

**Architecture:** 三处连根修——(1) `src/openai.ts` 非流式 fetch 改 SSE 流式 + 600s 总上限兜底（移植 2026-08-14 anthropic 修复）；(2) `src/memory/agentLoop.ts` catch 块用 `isAbortLike` 分类 + trace 透出真实原因（不再笼统 llm-error 丢原因）；(3) `src/scheduler.ts` 失败暂停块 `saveSourceInput` 从仅 judge 步放开到任意步骤暂停都存。调用方零感知（返回 string 契约不变）。

**Tech Stack:** Bun + Hono + @anthropic-ai/sdk；原生 `fetch` + `ReadableStream`（零新依赖）；zod；bun:test。

**Spec:** `docs/superpowers/specs/2026-08-20-openai-streaming-and-failure-visibility-design.md`

## Global Constraints

- 零新运行时依赖（openai 后端保持原生 `fetch`，不引入 `openai` npm SDK）。
- `makeLLMCall` 返回 `Promise<string>` 契约不变——distiller/dedup/judge/runLlmSession/runAgentLoop 调用方零感知。
- `OpenAiDeps.timeoutMs` 缺省由 `120_000` 改为 `600_000`（与 anthropic `timeout: 600_000` 对齐）。
- `agentLoop.stopReason` 外部契约不变（仍 `'llm-error'`），只改 trace 文本 + reasons 透出。
- `saveSourceInput` 失败仍 best-effort warn 不阻塞（既有不变量）。
- 步骤机 / offset / 断点续跑语义不动（2026-08-18 已根治）。
- 运行门槛：`bun run typecheck && bun test` 必须全绿。
- live 测试双守卫保护，默认 skip，本 plan 不强制真打模型。
- commit / PR 目标 master；不直推 master。

---

## File Structure

| 文件 | 责任 | 改动 |
|---|---|---|
| `src/openai.ts` | openai 后端 LLMCall | 流式重写 makeLLMCall；timeoutMs 缺省 600k |
| `src/memory/agentLoop.ts` | agent 循环 | catch 块 isAbortLike 分类 + trace 透出 |
| `src/memory/agentJudge.ts` | 质量模式 agent 终审 | reasons 透出真实原因 |
| `src/scheduler.ts` | 步骤机 tick | saveSourceInput 上提到任意步骤暂停都存 |
| `tests/openai.test.ts` | openai 测试 | 加 SSE 流式 framing + 超时回归测试 |
| `tests/agent-loop.test.ts` | agentLoop 测试 | 加 abort 分类 trace 断言 |
| `tests/scheduler-resume.test.ts` | 步骤暂停测试 | 加 distill 暂停存输入快照断言 |

---

### Task 1: openai 后端 SSE 流式解析纯函数

**Files:**
- Create: `src/memory/sse.ts`
- Test: `tests/sse.test.ts`

**Interfaces:**
- Consumes: 无（纯函数，无运行时依赖）
- Produces:
  - `export interface SseEvent { data: string }`
  - `export function parseSseChunks(buffer: string, leftover: string): { events: SseEvent[]; leftover: string }`
    - 入参 `buffer` 是本次新读到的文本块；`leftover` 是上次切剩的尾巴（可空串）。
    - 返回 `events` 是本次能完整解析出的 `data:` 事件（payload 已剥 `data: ` 前缀）；`leftover` 是本次仍不完整的尾巴，留待下次。
    - 解析规则（SSE 规范）：按 `\n` 切行；行尾 `\r\n` 去掉 `\r`；以 `data: `（或 `data:`）为前缀的行取 payload；`[DONE]` payload 也作为事件返回（调用方据 payload===`[DONE]` 判终止）；空行 / 以 `:` 开头的心跳行跳过；不完整行（无换行结尾）留作 leftover。

- [ ] **Step 1: Write the failing test**

创建 `tests/sse.test.ts`：

```typescript
import { test, expect } from 'bun:test'
import { parseSseChunks } from '@/memory/sse'

test('完整一行一事件：data: {...}\\n\\n', () => {
  const r = parseSseChunks('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n', '')
  expect(r.events).toHaveLength(1)
  expect(r.events[0]!.data).toBe('{"choices":[{"delta":{"content":"hi"}}]}')
  expect(r.leftover).toBe('')
})

test('跨 chunk 拆断的行正确拼接', () => {
  const r1 = parseSseChunks('data: {"ch', '')
  expect(r1.events).toHaveLength(0)
  expect(r1.leftover).toBe('data: {"ch')
  const r2 = parseSseChunks('oices":[]}\\n\\n', r1.leftover)
  expect(r2.events).toHaveLength(1)
  expect(r2.events[0]!.data).toBe('{"choices":[]}')
  expect(r2.leftover).toBe('')
})

test('[DONE] 哨兵作为事件返回（payload 仍为 [DONE]）', () => {
  const r = parseSseChunks('data: [DONE]\\n\\n', '')
  expect(r.events).toHaveLength(1)
  expect(r.events[0]!.data).toBe('[DONE]')
})

test('空行 / :heartbeat 心跳行跳过', () => {
  const r = parseSseChunks(': heartbeat\\n\\ndata: {"a":1}\\n\\n', '')
  expect(r.events).toHaveLength(1)
  expect(r.events[0]!.data).toBe('{"a":1}')
})

test('data: 无空格前缀也识别', () => {
  const r = parseSseChunks('data:{"a":1}\\n\\n', '')
  expect(r.events).toHaveLength(1)
  expect(r.events[0]!.data).toBe('{"a":1}')
})

test('不完整行（无换行结尾）留作 leftover', () => {
  const r = parseSseChunks('data: {"un', '')
  expect(r.events).toHaveLength(0)
  expect(r.leftover).toBe('data: {"un')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/sse.test.ts`
Expected: FAIL，`parseSseChunks` 未定义。

- [ ] **Step 3: Write minimal implementation**

创建 `src/memory/sse.ts`：

```typescript
// src/memory/sse.ts
// 纯函数 SSE（Server-Sent Events）行解析器：把流式读到的文本块切成 data: 事件。
// spec: docs/superpowers/specs/2026-08-20-openai-streaming-and-failure-visibility-design.md §3.1
// 零运行时依赖；跨 chunk 的不完整行通过 leftover 延续到下次。

export interface SseEvent {
  /** data: 行的 payload（已剥前缀）；[DONE] 哨兵原样返回。 */
  data: string
}

/**
 * 解析一段新读到的 SSE 文本块。
 *
 * @param buffer 本次新读到的文本（可能是半行）。
 * @param leftover 上次切剩的尾巴（可空串）。
 * @returns events=本次完整解析出的事件；leftover=本次仍不完整的尾巴。
 *
 * 规则：按 \n 切行（行尾 \r\n 去 \r）；data: / data: 前缀取 payload；
 * [DONE] 也作为事件返回（调用方判终止）；空行 / :开头心跳行跳过；无换行结尾的行留作 leftover。
 */
export function parseSseChunks(buffer: string, leftover: string): { events: SseEvent[]; leftover: string } {
  const text = leftover + buffer
  const events: SseEvent[] = []
  // 按行扫描，最后一行若无换行结尾则留作 leftover
  let lastNewline = -1
  let lineStart = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      let line = text.slice(lineStart, i)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      processLine(line, events)
      lastNewline = i
      lineStart = i + 1
    }
  }
  const leftoverNext = lastNewline === -1 ? text : text.slice(lastNewline + 1)
  return { events, leftover: leftoverNext }
}

function processLine(line: string, events: SseEvent[]): void {
  if (line === '') return                 // 空行（事件分隔）
  if (line.startsWith(':')) return        // SSE 心跳注释
  if (line.startsWith('data:')) {
    const payload = line.slice('data:'.length).replace(/^ /, '')
    events.push({ data: payload })
    return
  }
  // 其它字段（event:/id:/retry:）暂不处理，跳过
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/sse.test.ts`
Expected: PASS（6 测试全绿）。

- [ ] **Step 5: Run typecheck**

Run: `bun run typecheck`
Expected: 干净无报错。

- [ ] **Step 6: Commit**

```bash
git add src/memory/sse.ts tests/sse.test.ts
git commit -m "feat(openai): 抽出 SSE 流式解析纯函数

spec §3.1：openai 后端流式化需要把 fetch ReadableStream 读到的文本块
切成 data: 事件。先抽 parseSseChunks 纯函数（跨 chunk leftover 拼接、
[DONE] 哨兵、心跳跳过），独立可测。零运行时依赖。"
```

---

### Task 2: openai makeLLMCall 流式重写 + timeoutMs 缺省 600k

**Files:**
- Modify: `src/openai.ts`（`makeLLMCall`，约 `:57-92`）
- Test: `tests/openai.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `parseSseChunks` from `@/memory/sse`
- Produces: `makeLLMCall` 返回 `Promise<string>` 契约不变（调用方零感知）；`OpenAiDeps.timeoutMs` 缺省改 `600_000`。

- [ ] **Step 1: Write the failing tests**

在 `tests/openai.test.ts` 末尾追加（保留既有测试，这是新增）：

```typescript
// ---- makeLLMCall：流式 SSE（spec §3.1 / 2026-08-20 移植自 anthropic 流式）----

function sseStreamResponse(chunks: string[], status = 200): Response {
  // 返回一个 body 逐块吐出 chunks 的流式 Response
  const stream = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(new TextEncoder().encode(c))
      controller.close()
    },
  })
  return new Response(stream, { status, headers: { 'content-type': 'text/event-stream' } })
}

test('makeLLMCall 流式：累加 delta.content 拼出全文', async () => {
  fetchImpl = async () => sseStreamResponse([
    'data: {"choices":[{"delta":{"content":"hel"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
    'data: [DONE]\n\n',
  ])
  const call = makeLLMCall({ loadOpenAiCreds: () => CREDS })
  const out = await call('s', 'u')
  expect(out).toBe('hello world')
})

test('makeLLMCall 流式：body 含 stream:true', async () => {
  fetchImpl = async () => sseStreamResponse(['data: {"choices":[{"delta":{"content":"x"}}]}\n\n', 'data: [DONE]\n\n'])
  const call = makeLLMCall({ loadOpenAiCreds: () => CREDS })
  await call('s', 'u')
  const body = JSON.parse(fetchCalls[0]!.init.body as string)
  expect(body.stream).toBe(true)
})

test('makeLLMCall 流式：跨 chunk 拆断的 SSE 行正确拼接', async () => {
  // 一个 data 行被拆成两个 chunk
  fetchImpl = async () => sseStreamResponse([
    'data: {"choices":[{"delta":{',
    '"content":"ok"}}]}\n\n',
    'data: [DONE]\n\n',
  ])
  const call = makeLLMCall({ loadOpenAiCreds: () => CREDS })
  const out = await call('s', 'u')
  expect(out).toBe('ok')
})

test('makeLLMCall 流式：心跳行 / 缺 content 的 chunk 跳过不抛', async () => {
  fetchImpl = async () => sseStreamResponse([
    ': heartbeat\n\n',
    'data: {"choices":[{"delta":{}}]}\n\n',          // 无 content
    'data: {"choices":[{"delta":{"content":"x"}}]}\n\n',
    'data: [DONE]\n\n',
  ])
  const call = makeLLMCall({ loadOpenAiCreds: () => CREDS })
  const out = await call('s', 'u')
  expect(out).toBe('x')
})

test('makeLLMCall 流式：未见 [DONE] 连接关闭也视结束返回已累计文本', async () => {
  fetchImpl = async () => sseStreamResponse([
    'data: {"choices":[{"delta":{"content":"ab"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"c"}}]}\n\n',
    // 无 [DONE]，stream 直接 close
  ])
  const call = makeLLMCall({ loadOpenAiCreds: () => CREDS })
  const out = await call('s', 'u')
  expect(out).toBe('abc')
})

test('makeLLMCall：timeoutMs 缺省 600_000（回归锁，防回退 120k）', async () => {
  fetchImpl = async () => sseStreamResponse(['data: {"choices":[{"delta":{"content":"x"}}]}\n\n', 'data: [DONE]\n\n'])
  const call = makeLLMCall({ loadOpenAiCreds: () => CREDS })  // 不传 timeoutMs
  await call('s', 'u')
  expect(fetchCalls[0]!.init.signal).toBeInstanceOf(AbortSignal)
  // signal 没有公开字段读 timeout 时长，用「未传 timeoutMs 时 AbortController 不在 120s 触发」
  // 的形态间接锁：此处只断言 signal 下发（直接断言缺省值不可达，保留为语义锁 + Task 2 实现层注释钉死）。
})
```

注：超时缺省值（600k vs 120k）无法从外部直接断言 AbortController 时长（无公开字段）。改在实现层用 `const timeoutMs = deps.timeoutMs ?? 600_000` + 一条源码层文本断言锁字符串 `'600_000'` 出现在文件中（见 Step 4）。上面的 timeoutMs 测试改成纯文本守卫：

把上面最后一个测试替换为：

```typescript
test('makeLLMCall timeoutMs 缺省：源码层文本锁 600_000（防回退 120k）', async () => {
  // 无法从外部读 AbortController 时长；锁源码缺省值字符串，防 PR 后回退到 120_000。
  const src = await Bun.file(require('node:path').join(import.meta.dir, '..', 'src', 'openai.ts')).text()
  expect(src).toContain('600_000')
  expect(src).not.toContain('120_000')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/openai.test.ts`
Expected: 新增流式测试 FAIL（当前 makeLLMCall 非流式，不读 SSE 流）。

- [ ] **Step 3: Write minimal implementation**

改写 `src/openai.ts` 的 `makeLLMCall`（保留 `loadOpenAiCreds`/`loadOpenAiUiCreds`/`testConnection` 不动）：

把 `makeLLMCall` 函数体替换为：

```typescript
export function makeLLMCall(deps: OpenAiDeps = {}): LLMCall {
  const load = deps.loadOpenAiCreds ?? loadOpenAiCreds
  const loadUi = deps.loadUiConfig
  const timeoutMs = deps.timeoutMs ?? 600_000
  return async function callLLM(system: string, user: string, opts?: LLMCallOpts): Promise<string> {
    const c = loadUi ? loadOpenAiUiCreds(loadUi(), process.env) : load()
    if (!c) throw new Error('no OpenAI credentials; set OPENAI_API_KEY + OPENAI_BASE_URL + OPENAI_MODEL')
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const resp = await fetch(`${c.baseURL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.apiKey}` },
        body: JSON.stringify({
          model: c.model,
          max_tokens: opts?.maxTokens ?? DEFAULT_LLM_MAX_TOKENS,
          stream: true,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
        signal: ctrl.signal,
      })
      if (!resp.ok) {
        const body = await resp.text().catch(() => '')
        throw new Error(`OpenAI HTTP ${resp.status}: ${body.slice(0, 200)}`)
      }
      if (!resp.body) throw new Error('OpenAI streaming response missing body')
      // 流式：逐块读 body，SSE 解析，累加 delta.content。字节持续流动期间不触发超时。
      const reader = resp.body.getReader()
      const decoder = new TextDecoder('utf-8')
      let leftover = ''
      let text = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        leftover += decoder.decode(value, { stream: true })
        const { events, leftover: next } = parseSseChunks(leftover, '')
        leftover = next
        for (const ev of events) {
          if (ev.data === '[DONE]') { reader.cancel(); break }
          let parsed: unknown
          try { parsed = JSON.parse(ev.data) } catch { continue }
          const delta = (parsed as { choices?: { delta?: { content?: unknown } }[] })?.choices?.[0]?.delta?.content
          if (typeof delta === 'string') text += delta
        }
      }
      // 兼容：响应可能为空（极少），返回空串（与旧「无 content 抛错」略不同——
      // 流式语义下空响应更可能合法地返回空串；调用方 shouldRetry 路径会兜住非 JSON）。
      return text
    } finally {
      clearTimeout(timer)
    }
  }
}
```

文件顶部加 import：`import { parseSseChunks } from './memory/sse'`

同时更新 `OpenAiDeps.timeoutMs` 的注释（`:17` 附近）：把「默认 120s」改为「默认 600s（流式总上限兜底，字节流动期间不触发）」。

- [ ] **Step 4: 修正既有测试（非流式契约变更）**

既有测试 `tests/openai.test.ts` 里基于非流式响应的用例需改为流式响应。具体：

- `okResp({ choices: [{ message: { content: 'hello' } }] })` 这类返回非流式 JSON 的 helper 不再适用流式。但既有用例 `'makeLLMCall posts to {baseURL}/chat/completions ...'`、`'honors opts.maxTokens override'`、`'extracts choices[0].message.content'` 仍断言「请求形状 + 返回值」，需把它们改用 `sseStreamResponse` 造流式响应。

把既有这几条用例的 `fetchImpl` 改为返回流式响应。例如：
```typescript
// 既有 'extracts choices[0].message.content (first of many choices)' 用例：
// 旧断言「多 choice 取 [0]」对流式不适用（流式 delta 无多 choice 语义）。
// 改为：流式累加单 choice 的多 delta。
test('makeLLMCall 流式累加 choices[0] delta 拼全文', async () => {
  fetchImpl = async () => sseStreamResponse([
    'data: {"choices":[{"delta":{"content":"first"}}]}\n\n',
    'data: [DONE]\n\n',
  ])
  const call = makeLLMCall({ loadOpenAiCreds: () => CREDS })
  const out = await call('s', 'u')
  expect(out).toBe('first')
})
```

删除 `'makeLLMCall throws when response missing choices[0].message.content'` 用例（流式语义下空响应返回空串，不再抛此错——这是契约的合理变更，spec §3.1 失败模式已说明「空响应由调用方 shouldRetry 兜住」）。改为一条新用例锁「流式空响应返回空串」：
```typescript
test('makeLLMCall 流式空响应返回空串（不抛 missing content）', async () => {
  fetchImpl = async () => sseStreamResponse(['data: [DONE]\n\n'])
  const call = makeLLMCall({ loadOpenAiCreds: () => CREDS })
  const out = await call('s', 'u')
  expect(out).toBe('')
})
```

`'makeLLMCall aborts after timeoutMs when fetch never resolves'` 用例保留（流式下AbortController 仍在，行为不变）。

既有「请求形状」用例的 body 断言里 `expect(body.stream).toBe(true)` 已覆盖，`max_tokens` 断言保留（流式 body 仍带 max_tokens）。

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/openai.test.ts`
Expected: PASS（既有改流式 + 新增流式 framing 全绿）。

- [ ] **Step 6: Run typecheck + full suite**

Run: `bun run typecheck && bun test`
Expected: typecheck 干净；测试全绿（其它后端测试 anthropic/llm 不受影响）。

- [ ] **Step 7: Commit**

```bash
git add src/openai.ts tests/openai.test.ts
git commit -m "fix(openai): 流式化 makeLLMCall + timeoutMs 缺省 600k，根治 120s aborted

spec §3.1：2026-08-14 流式化只覆盖 anthropic 后端，openai 后端仍非流式
+120s 硬超时；公司 OpenAI 兼容网关对生成超 ~60s 无首字节的非流式请求掐断
-> distill 大 transcript 必撞 120s aborted。移植流式：stream:true + 逐块读
ReadableStream + SSE 解析累加 delta.content；timeoutMs 缺省 120k->600k
（流式总上限兜底，字节流动期间不触发，与 anthropic 对齐）。返回 string
契约不变，调用方零感知。"
```

---

### Task 3: agentLoop catch 块 abort 分类 + trace 透出真实原因

**Files:**
- Modify: `src/memory/agentLoop.ts`（`callOnce` catch 块，约 `:54-56`）
- Test: `tests/agent-loop.test.ts`

**Interfaces:**
- Consumes: `isAbortLike` from `./stepPrompt`（已存在，单一真相源）
- Produces: `AgentLoopResult.stopReason` 不变（仍 `'llm-error'`）；`trace` 末条 correction 文本含 `${reason}:${msg}`。

- [ ] **Step 1: Write the failing tests**

在 `tests/agent-loop.test.ts` 末尾追加：

```typescript
// ---- 失败分类：spec 2026-08-20 §3.2，judge(agentLoop) catch 不再笼统丢原因 ----

test('callLLM 抛 AbortError: trace 末条含 aborted:，stopReason 仍 llm-error', async () => {
  const r = await runAgentLoop({
    callLLM: async () => {
      const e = new Error('The operation was aborted')
      e.name = 'AbortError'
      throw e
    },
    system: 'sys', user: '材料', tools: fakeTools(), maxRounds: 5, timeBudgetMs: 60_000,
  })
  expect(r.stopReason).toBe('llm-error')
  expect(r.final).toBeNull()
  expect(r.trace.length).toBeGreaterThan(0)
  expect(r.trace[r.trace.length - 1]!.text).toContain('aborted:')
})

test('callLLM 抛普通 Error: trace 末条含 llm-error:', async () => {
  const r = await runAgentLoop({
    callLLM: async () => { throw new Error('HTTP 502 bad gateway') },
    system: 'sys', user: '材料', tools: fakeTools(), maxRounds: 5, timeBudgetMs: 60_000,
  })
  expect(r.stopReason).toBe('llm-error')
  expect(r.trace[r.trace.length - 1]!.text).toContain('llm-error:')
  expect(r.trace[r.trace.length - 1]!.text).toContain('HTTP 502 bad gateway')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/agent-loop.test.ts`
Expected: 两条新测试 FAIL（当前 catch 块不 push trace，trace 为空，`r.trace.length` 为 0 → `trace[length-1]` undefined 抛错）。

- [ ] **Step 3: Write minimal implementation**

改 `src/memory/agentLoop.ts`：

顶部加 import：
```typescript
import { isAbortLike } from './stepPrompt'
```

把 `callOnce` 的 catch 块：
```typescript
    } catch {
      return { final: null, trace, stopReason: 'llm-error' }
    }
```
改为：
```typescript
    } catch (e) {
      // spec 2026-08-20 §3.2：不再笼统丢原因——按 isAbortLike 分类，trace 透出真实原因。
      // stopReason 外部契约不变（仍 llm-error，scheduler 据此暂停 + pending_review）。
      const reason = isAbortLike(e) ? 'aborted' : 'llm-error'
      const msg = e instanceof Error ? e.message : String(e)
      trace.push({ kind: 'correction', text: `${reason}:${msg}`.slice(0, TRACE_CAP) })
      return { final: null, trace, stopReason: 'llm-error' }
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/agent-loop.test.ts`
Expected: PASS（新增 2 条 + 既有 6 条全绿）。

- [ ] **Step 5: Run typecheck**

Run: `bun run typecheck`
Expected: 干净。

- [ ] **Step 6: Commit**

```bash
git add src/memory/agentLoop.ts tests/agent-loop.test.ts
git commit -m "fix(judge): agentLoop catch 用 isAbortLike 分类 + trace 透出真实原因

spec §3.2：judge(agentLoop) catch 块一律报 llm-error 丢原因（网关掐断
和真报错混为一谈）。改为 isAbortLike 分类，trace push aborted:/llm-error:
带真实原因；stopReason 外部契约不变（仍 llm-error）。不接 persistRound
（STATE deferred minor #3 跨 tick 断点续跑仍是独立项）。"
```

---

### Task 4: agentJudge reasons 透出真实原因

**Files:**
- Modify: `src/memory/agentJudge.ts`（约 `:95-101`）
- Test: `tests/agent-judge.test.ts`

**Interfaces:**
- Consumes: Task 3 的 agentLoop trace 末条含真实原因
- Produces: `AgentJudgeResultOrFailed` 的 `failed` 变体 `reasons` 透出真实原因（不再固定 `agent loop ended without final: llm-error`）；`failed` 标识不变，scheduler 暂停逻辑不变。

- [ ] **Step 1: Read existing agent-judge test to match style**

Run: `sed -n '1,60p' tests/agent-judge.test.ts`（了解既有 failed 断言形态，无需改动既有用例，只新增）。

- [ ] **Step 2: Write the failing test**

在 `tests/agent-judge.test.ts` 末尾追加（既有 helper 如 `makeCallLLM` / `fakeTools` 按文件实际复用；如签名不同请适配）：

```typescript
test('agentLoop 失败: reasons 透出真实原因（aborted:），不再固定 llm-error', async () => {
  // callLLM 抛 AbortError -> agentLoop trace 末条含 aborted: -> reasons 含 aborted:
  const callLLM = async () => {
    const e = new Error('The operation was aborted')
    e.name = 'AbortError'
    throw e
  }
  const r = await judgeValueAgentic(
    [{ title: '[category:x] t', bodyMd: 'b', origin: 'agent-observed', evidence: '', scope: 'project', runtime: null, distillAction: 'new' }] as never,
    {
      callLLM, rootDir: null, approvedTitles: [], sourceKind: 'conversation',
      maxRounds: 5, timeBudgetMs: 60_000,
    },
  )
  expect('failed' in r).toBe(true)
  if ('failed' in r) {
    const joined = r.reasons.join(' | ')
    expect(joined).toContain('aborted:')
  }
})

test('agentLoop 预算耗尽无 trace 真实原因时: reasons 回退带 stopReason', async () => {
  // maxRounds=1 + 永远要工具 -> rounds-budget，trace 末条是 correction（工具请求），
  // 非 catch 路径 -> reasons 不含 aborted:，但含 stopReason 信息（保留旧兜底语义）。
  const callLLM = async () => '{"tool": "grep", "args": {"pattern": "x"}}'
  const r = await judgeValueAgentic(
    [{ title: '[category:x] t', bodyMd: 'b', origin: 'agent-observed', evidence: '', scope: 'project', runtime: null, distillAction: 'new' }] as never,
    {
      callLLM, rootDir: null, approvedTitles: [], sourceKind: 'conversation',
      maxRounds: 1, timeBudgetMs: 60_000,
    },
  )
  expect('failed' in r).toBe(true)
  if ('failed' in r) {
    expect(r.reasons.length).toBeGreaterThan(0)
  }
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test tests/agent-judge.test.ts`
Expected: 第一条 FAIL（当前 reasons 固定 `agent loop ended without final: llm-error`，不含 `aborted:`）。

- [ ] **Step 4: Write minimal implementation**

改 `src/memory/agentJudge.ts` 的 `judgeValueAgentic`，把：

```typescript
    const final = loop.final as { verdicts?: unknown } | null
    if (!final || !Array.isArray(final.verdicts)) {
      return { failed: true, reasons: [`agent loop ended without final: ${loop.stopReason}`] }
    }
```

改为：

```typescript
    const final = loop.final as { verdicts?: unknown } | null
    if (!final || !Array.isArray(final.verdicts)) {
      // spec 2026-08-20 §3.2：reasons 优先透出 trace 末条真实原因（catch 路径含
      // aborted:/llm-error:），trace 为空回退 stopReason。failed 标识不变。
      const lastTrace = loop.trace.length > 0 ? loop.trace[loop.trace.length - 1]!.text : null
      const reasons = lastTrace
        ? [lastTrace]
        : [`agent loop ended without final: ${loop.stopReason}`]
      return { failed: true, reasons }
    }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/agent-judge.test.ts`
Expected: PASS（新增 2 + 既有全绿）。

- [ ] **Step 6: Run typecheck + full suite**

Run: `bun run typecheck && bun test`
Expected: 全绿。

- [ ] **Step 7: Commit**

```bash
git add src/memory/agentJudge.ts tests/agent-judge.test.ts
git commit -m "fix(judge): reasons 透出 agentLoop trace 真实原因，不再固定 llm-error

spec §3.2：judge 失败时 reasons 优先取 trace 末条（Task 3 透出的
aborted:/llm-error:真实原因），trace 为空回退 stopReason 文案。failed
标识不变，scheduler 暂停 + pending_review 逻辑不动。"
```

---

### Task 5: scheduler 失败暂停块 saveSourceInput 放开到任意步骤

**Files:**
- Modify: `src/scheduler.ts`（失败块，约 `:723-778`）
- Test: `tests/scheduler-resume.test.ts`

**Interfaces:**
- Consumes: `saveSourceInput` from `@/memory/store`（已 import，`:10`）、`filterTranscriptForDistill` from `@/memory/pure`
- Produces: 任意步骤（distill/dedup/judge/digest）3 次失败暂停时都存 source-input 快照（之前仅 judge 步存）。

- [ ] **Step 1: Write the failing test**

在 `tests/scheduler-resume.test.ts` 末尾追加（复用 `seedDueJob`/`forceDue`/`loadTranscript`/`ECONOMY` helper）：

```typescript
import { getSourceInput } from '@/memory/store'   // 如文件顶部已 import 则不重复

test('distill 3 次失败暂停: 存 source-input 快照（之前 distill 暂停无快照是黑盒）', async () => {
  const jobId = await seedDueJob('s-res-distill-pause')
  // distill 每轮都抛 abort -> 3 次暂停
  const callLLM = async () => { throw new Error('the operation was aborted') }
  for (let i = 0; i < 3; i++) {
    await tick(db, { loadTranscript: () => loadTranscript('some real input content'), callLLM, createCandidate: fakeCreate as never, loadJudgeConfig: () => ECONOMY })
    if (i < 2) await forceDue(jobId)
  }
  const rows = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, jobId))
  expect(rows[0]!.status).toBe('paused')
  expect(rows[0]!.stepError).toBe('distill')
  // 核心：distill 暂停也存了输入快照（spec §3.3(a)）
  const snap = await getSourceInput(db, jobId)
  expect(snap).not.toBeNull()
  expect(snap!.turnCount).toBeGreaterThan(0)
})
```

注：`getSourceInput` 如文件顶部未 import，加 `import { ..., getSourceInput } from '@/memory/store'`。`memoryDistillJobs` / `eq` 已在文件顶部 import。

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/scheduler-resume.test.ts -t "distill 3 次失败暂停"`
Expected: FAIL（`getSourceInput` 返回 null —— 当前 distill 暂停不存快照）。

- [ ] **Step 3: Write minimal implementation**

改 `src/scheduler.ts` 的失败暂停块。当前结构（约 `:723-778`）：

```typescript
        if (adv.paused === 'paused') {
          // 3 次失败：暂停等人处置，绝不标 failed 丢内容（D2/P8）。
          const isAbort = failReason === 'aborted'
          let rawText: string | null = null
          if (!isAbort) {
            try {
              const rounds = await listLlmRounds(db, job.id, failStep)
              const last = rounds.length > 0 ? rounds[rounds.length - 1]! : null
              rawText = capRawText(last?.response ?? null)
            } catch { /* best-effort */ }
          }
          try {
            await saveDistillRun(db, job.id, { ... })
          } catch (e) { console.warn('memside: saveDistillRun failed', e) }
          await markJobPaused(db, job.id, failStep)
          await logStepFailureNotification(db, { jobId: job.id, step: failStep, reasons })
          if (failStep === 'judge' && deduped && deduped.length > 0) {
            // ... pending_review 插入 ...
            // 暂停也保留 source-input 快照
            try { await saveSourceInput(db, job.id, filterTranscriptForDistill(newTurns)) }
            catch (e) { console.warn('memside: saveSourceInput failed', e) }
          }
        }
```

改动：把 `saveSourceInput` 调用从 `if (failStep === 'judge' ...)` 内部**上提**到 `if (adv.paused === 'paused')` 顶层（pending_review 插入逻辑之外），让任意步骤暂停都执行。即：

```typescript
        if (adv.paused === 'paused') {
          // 3 次失败：暂停等人处置，绝不标 failed 丢内容（D2/P8）。
          const isAbort = failReason === 'aborted'
          let rawText: string | null = null
          if (!isAbort) {
            try {
              const rounds = await listLlmRounds(db, job.id, failStep)
              const last = rounds.length > 0 ? rounds[rounds.length - 1]! : null
              rawText = capRawText(last?.response ?? null)
            } catch { /* best-effort */ }
          }
          try {
            await saveDistillRun(db, job.id, {
              outcome: isAbort ? 'llm_error' : 'parse_error',
              rawOutput: null, rawCount, acceptedCount: 0,
              dedupedCount: deduped?.length ?? 0,
              filteredCount: 0, storedCount: 0, discardedCount: dedupExactDrops,
              durationMs: Date.now() - t0, errorMessage: lastErrorText,
              rawText, dedupMs, judgeMs,
            })
          } catch (e) { console.warn('memside: saveDistillRun failed', e) }
          await markJobPaused(db, job.id, failStep)
          await logStepFailureNotification(db, { jobId: job.id, step: failStep, reasons })
          // spec 2026-08-20 §3.3(a)：任意步骤暂停都存输入快照（之前仅 judge 步存，
          // distill/dedup 暂停是黑盒）。best-effort：失败只 warn 不阻塞。
          try { await saveSourceInput(db, job.id, filterTranscriptForDistill(newTurns)) }
          catch (e) { console.warn('memside: saveSourceInput failed', e) }
          if (failStep === 'judge' && deduped && deduped.length > 0) {
            // judge 暂停期间候选标 pending_review（spec §6.4）：不进审批队列（非
            // candidate）、不丢弃（不进 discards）；重试成功后自动退役，暂停期间
            // 可手动接管审批。先清掉上一轮暂停留下的占位行（重试又失败的场景）。
            try {
              await db.delete(memories).where(and(eq(memories.distillJobId, job.id), eq(memories.status, 'pending_review'))).run()
            } catch (e) { console.warn('memside: pending_review cleanup failed', e) }
            for (const c of deduped) {
              try {
                const m = await deps.createCandidate(db, { /* ... 既有不变 ... */ })
                await db.update(memories).set({ status: 'pending_review' }).where(eq(memories.id, m.id)).run()
              } catch (e) { console.warn('memside: pending_review insert failed', e) }
            }
            // saveSourceInput 已上提到任意步骤，此处不再重复调用。
          }
        }
```

关键：`saveSourceInput` 移到 pending_review 分支**之外**；judge pending_review 分支内**删除**原 saveSourceInput 调用（避免重复）。pending_review 插入循环体内容逐字不变。

`rawText` 路径（`:727` 的 `if (!isAbort)`）**不动**——spec §3.3(b) 说明：abort 时 rawText 仍 null 是事实正确（无末轮响应），靠 saveSourceInput 补「输入快照」这一面，两道信息面解耦。

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/scheduler-resume.test.ts -t "distill 3 次失败暂停"`
Expected: PASS（`getSourceInput` 非空）。

- [ ] **Step 5: Run full scheduler-resume suite + typecheck**

Run: `bun run typecheck && bun test tests/scheduler-resume.test.ts`
Expected: 全绿（既有 judge 暂停仍存快照不破；pending_review 仍插）。

- [ ] **Step 6: Commit**

```bash
git add src/scheduler.ts tests/scheduler-resume.test.ts
git commit -m "fix(scheduler): 任意步骤失败暂停都存 source-input 快照，distill 不再黑盒

spec §3.3(a)：saveSourceInput 从仅 judge 步上提到失败暂停块顶层——distill/
dedup 步 3 次失败暂停时也存输入快照，之前 distill 暂停是黑盒（点「查看原始
输入」为空）。rawText 路径不动（abort 时 null 是事实正确，无末轮响应），
两道信息面（输入快照 / 末轮响应）解耦：abort 只丢末轮响应，不丢输入快照。"
```

---

### Task 6: 全量回归 + 收官

**Files:** 无（验证任务）

- [ ] **Step 1: Run full typecheck + test suite**

Run: `bun run typecheck && bun test`
Expected: typecheck 干净；全部测试全绿（基线不回归）。

- [ ] **Step 2: Spot-check 受影响测试文件独立全绿**

Run: `bun test tests/openai.test.ts tests/agent-loop.test.ts tests/agent-judge.test.ts tests/scheduler-resume.test.ts tests/sse.test.ts`
Expected: 全绿。

- [ ] **Step 3: 推远端开 PR**

```bash
git -c http.sslBackend=openssl push -u origin fix/openai-streaming-and-failure-visibility
gh pr create --base master --title "fix(openai): 流式化根治 120s aborted + 失败彻底可诊断" --body "$(cat <<'EOF'
## 根因

公司 OpenAI 兼容网关对生成超 ~60s 无首字节的非流式请求掐断。2026-08-14 流式化只覆盖 anthropic 后端，openai 后端仍非流式 + 120s 硬超时 → distill 大 transcript 必撞 120s `aborted`。伴生：distill 步失败不存输入快照（黑盒）；judge(agentLoop) catch 一律 `llm-error` 丢原因。

## 修复（三处连根）

1. **openai 流式化**（`src/openai.ts`）：`stream:true` + 逐块读 ReadableStream + SSE 解析累加 `delta.content`；timeoutMs 缺省 120k→600k（流式总上限兜底，字节流动期间不触发，与 anthropic 对齐）。返回 string 契约不变，调用方零感知。
2. **judge 失败分类对齐**（`src/memory/agentLoop.ts` + `agentJudge.ts`）：catch 块用 `isAbortLike` 分类 + trace 透出真实原因（`aborted:` / `llm-error:`），reasons 不再固定笼统文案。`stopReason` 外部契约不变。
3. **distill/dedup 失败补存输入快照**（`src/scheduler.ts`）：`saveSourceInput` 从仅 judge 步上提到任意步骤暂停都存。rawText 路径不动（abort 时 null 是事实正确），两道信息面解耦。

## Spec / Plan

- spec: `docs/superpowers/specs/2026-08-20-openai-streaming-and-failure-visibility-design.md`
- plan: `docs/superpowers/plans/2026-08-20-openai-streaming-and-failure-visibility.md`

## 测试

`bun run typecheck && bun test` 全绿。新增 SSE framing 契约测试 + 流式累加测试 + abort 分类 trace 断言 + distill 暂停存输入快照断言。

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: 验收自查**

- openai makeLLMCall 走流式分支（body.stream=true）
- timeoutMs 缺省 600k（源码层文本锁）
- agentLoop catch 透出 aborted:/llm-error: 真实原因
- agentJudge reasons 透出 trace
- 任意步骤暂停都存 source-input
- 既有断言不回归（offset 仅四步全成推进、pending_review 仍插）

---

## Self-Review

**1. Spec coverage：**
- G1（openai 流式化根治 120s）→ Task 1（SSE 纯函数）+ Task 2（makeLLMCall 流式重写 + 600k）。✓
- G2（judge 失败分类对齐）→ Task 3（agentLoop catch isAbortLike + trace）+ Task 4（agentJudge reasons 透出）。✓
- G3（distill/dedup 失败补存输入快照 + abort 不清空）→ Task 5（saveSourceInput 上提）。✓
- N1（不引入 openai SDK）→ Task 2 用原生 fetch + ReadableStream。✓
- N3（不接 persistRound / 跨 tick）→ Task 3/4 明确不接，stopReason 不变。✓
- N4（不动 anthropic / testConnection）→ 无对应 task。✓
- N5（不动步骤机/offset）→ Task 5 只动 saveSourceInput 位置。✓
- §5 失败模式（chunk 解析失败跳过、连接被掐抛异常、saveSourceInput 失败 warn、缺 [DONE] 视结束）→ Task 2 测试覆盖。✓
- §6 测试策略（SSE framing 纯函数、流式累加、超时文本锁、abort 分类 trace、distill 暂停存快照、既有不变量回归）→ 各 Task 覆盖。✓
- §7 上线后观测 → 非本 plan 实施项（post-merge），已在 spec 标注回填 STATE。

**2. Placeholder scan：** 无 TBD/TODO；Task 5 的 pending_review 循环体用 `/* ... 既有不变 ... */` 标注（那是已存在代码逐字保留，不是要新写——实现者按文件实际内容保留，不删改）。已注明。无其它占位。

**3. Type consistency：** `parseSseChunks(buffer, leftover)` 在 Task 1 定义、Task 2 消费，签名一致。`isAbortLike` from `./stepPrompt` 在 Task 3 消费（已存在）。`getSourceInput` / `saveSourceInput` / `filterTranscriptForDistill` 均既有。`AgentLoopResult.stopReason`/`trace` 字段名与既有一致。

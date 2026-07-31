# opencode 支持 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 opencode 接入 memside 的完整 capture -> distill -> approve -> inject 闭环，对齐 claude code 体验。

**Architecture:** 仓库自带一个 opencode in-process plugin（`opencode-plugin/`），挂 `event`/`messages.transform` 两钩子，通过 fetch 与 daemon 通信。daemon 侧新增 `/hooks/opencode/{capture,inject}` 路由：capture 走既有 `enqueueDistillJob` + `memory_distill_events` DB 路径（**不经 adapter 内存队列**，与 claude code Stop 一致），inject 走 `OpencodeAdapter.inject`。error 信号不设单独路由--capture 全量 transcript 已含 tool error（`isError` turn），由 `detectErrorSignals` 提取，对齐 claude code 第四轮（server.ts:148-154）。project 记忆跨 runtime 共享（`listApprovedByScope` 去 runtime 过滤）。distill/store/scheduler/valueFilter/dedup/Web UI 全复用。

**Tech Stack:** Bun + Hono + Drizzle + bun:sqlite + zod（后端）；opencode plugin SDK `@opencode-ai/plugin`（in-process JS）；Vite + React 19（前端，仅 sourceLabel 一行改动）。

## Global Constraints

- 基线 `origin/master`，分支 `feat/opencode-support`，禁止直推 master，走 PR。
- 每任务结束 `bun run typecheck && bun test` 必须全绿才能进下一任务 / push。
- TDD：每改动先写失败测试（红）再实现（绿）。测试用例是改动的一部分。
- opencode 行为以源码为准，不靠记忆：plugin SDK hooks / `client.session.messages` / message-part 模型 / `session.idle` payload 需在实现时对照本机 opencode 1.15.5 验证（spec「验证缺口」1-7）。
- daemon 端口默认 7777，`MEMSIDE_PORT` 覆盖；plugin 端口 env 优先、烘焙值回退。
- 可断言面首选纯函数（`parseOpencodeMessages` / `installOpencodePlugin` / `listApprovedByScope`）；daemon 路由用 fake adapter + enqueueDistillJob seam；plugin 钩子用源码层文本断言兜底，运行时行为靠 live smoke。
- 现有 claude code 闭环不得回归（`tests/` 既有套件全绿）。
- `runtime` 列保留作来源标记，仅不再参与 inject 匹配。

## File Structure

- **Create** `src/opencode/transcript.ts` — `OpencodeMessage`/`OpencodePart` 类型 + 纯函数 `parseOpencodeMessages`。单文件单职责（opencode 消息 -> TranscriptTurn 转换）。
- **Create** `opencode-plugin/package.json` + `opencode-plugin/memside.js` — opencode in-process plugin（两钩子，fetch daemon）。
- **Modify** `src/adapter/opencode.ts` — 替换 stub，落地 `inject`（`pushCapture`/`capture` 留单测对齐 ClaudeCodeAdapter）。
- **Modify** `src/memory/store.ts` — `listApprovedByScope` 去 runtime 过滤 + 参数。
- **Modify** `src/adapter/claudeCode.ts` — inject 调用去掉 `runtime` 实参。
- **Modify** `src/server.ts` — deps 加 opencode adapter；新增 3 个 opencode 路由。
- **Modify** `src/daemon.ts` — 实例化 OpencodeAdapter 并传 server。
- **Modify** `src/install.ts` — 新增 `installOpencodePlugin`。
- **Modify** `src/cli.ts` — install / start-and-install 串调 opencode plugin 安装。
- **Modify** `src/web/App.tsx` — `sourceLabel` 加 `'opencode'`（minor，对齐既有 follow-up 模式）。
- **Create** `tests/opencode-transcript.test.ts` / `tests/adapter-opencode.test.ts` / `tests/server-opencode.test.ts` / `tests/install-opencode.test.ts` / `tests/plugin-opencode.test.ts`。
- **Modify** `tests/store-crud.test.ts` — 更新 runtime 过滤断言（语义变了）。
- **Modify** `README.md` / `STATE.md` — 去 opencode 限制、加用法、记录交付。

---

### Task 1: opencode transcript 转换纯函数

**Files:**
- Create: `src/opencode/transcript.ts`
- Test: `tests/opencode-transcript.test.ts`

**Interfaces:**
- Produces: `parseOpencodeMessages(messages: OpencodeMessage[]): TranscriptTurn[]`，`OpencodeMessage = { info: { role: 'user'|'assistant' }, parts: OpencodePart[] }`，`OpencodePart` 是 `TextPart | ToolPart | 其它`的判别联合（按 `type` 字段）。
- Consumes: `TranscriptTurn`（`src/memory/pure.ts:109`，`{role, content, isError?, toolName?, toolInputPath?}`）。

- [ ] **Step 1: Write failing tests**

```ts
// tests/opencode-transcript.test.ts
import { test, expect } from 'bun:test'
import { parseOpencodeMessages } from '@/opencode/transcript'
import type { OpencodeMessage } from '@/opencode/transcript'

test('user TextPart -> user turn', () => {
  const msgs: OpencodeMessage[] = [{ info: { role: 'user' }, parts: [{ type: 'text', text: 'hello' } as any] }]
  expect(parseOpencodeMessages(msgs)).toEqual([{ role: 'user', content: 'hello' }])
})

test('assistant TextPart -> assistant turn', () => {
  const msgs: OpencodeMessage[] = [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: 'doing it' } as any] }]
  expect(parseOpencodeMessages(msgs)).toEqual([{ role: 'assistant', content: 'doing it' }])
})

test('ToolPart tool_use/tool_result paired by callID, error -> isError', () => {
  const msgs: OpencodeMessage[] = [{
    info: { role: 'assistant' },
    parts: [
      { type: 'tool', tool: 'bash', callID: 'c1', input: { command: 'ls' } } as any,
    ],
  }, {
    info: { role: 'user' },
    parts: [{ type: 'tool', callID: 'c1', output: 'boom', error: true } as any],
  }]
  const turns = parseOpencodeMessages(msgs)
  expect(turns.some(t => t.role === 'tool' && t.isError && t.toolName === 'bash')).toBe(true)
})

test('ReasoningPart / subtask / StepStart filtered out', () => {
  const msgs: OpencodeMessage[] = [{
    info: { role: 'assistant' },
    parts: [
      { type: 'reasoning', text: 'thinking' } as any,
      { type: 'text', text: 'answer' } as any,
      { type: 'subtask', prompt: 'p', description: 'd', agent: 'a' } as any,
    ],
  }]
  const turns = parseOpencodeMessages(msgs)
  expect(turns).toEqual([{ role: 'assistant', content: 'answer' }])
})

test('empty messages -> []', () => {
  expect(parseOpencodeMessages([])).toEqual([])
})

test('malformed part skipped, no throw', () => {
  const msgs: OpencodeMessage[] = [{ info: { role: 'user' }, parts: [{ type: 'text' } as any, { type: 'unknown' } as any] }]
  expect(parseOpencodeMessages(msgs)).toEqual([{ role: 'user', content: '' }])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/opencode-transcript.test.ts`
Expected: FAIL（模块不存在 / 导出缺失）。

- [ ] **Step 3: Write minimal implementation**

```ts
// src/opencode/transcript.ts
import type { TranscriptTurn } from '@/memory/pure'

/** opencode message（PluginInput.client.session.messages 返回项的子集）。 */
export interface OpencodeMessage {
  info: { role: 'user' | 'assistant' }
  parts: OpencodePart[]
}

/** opencode Part 的判别联合（按 type 字段）。只列转换关心的形态，其余走 default 过滤。 */
export type OpencodePart =
  | { type: 'text'; text: string }
  | { type: 'tool'; tool?: string; callID?: string; input?: unknown; output?: string; error?: boolean; metadata?: Record<string, unknown> }
  | { type: string; [k: string]: unknown }

/**
 * 把 opencode session 消息转成 memside TranscriptTurn[]。
 * - user/assistant TextPart -> {role, content}
 * - ToolPart 按 callID 配对，tool result error -> isError；output 作为 tool turn content
 * - reasoning/subtask/step/patch/snapshot/... 一律过滤（对齐 filterTranscriptForDistill 只保留 user/assistant text + tool I/O）
 * 纯函数，malformed part 跳过不抛。
 */
export function parseOpencodeMessages(messages: OpencodeMessage[]): TranscriptTurn[] {
  const turns: TranscriptTurn[] = []
  // 第一遍：收集 tool_use（assistant 发起），按 callID 记 toolName
  const toolNames = new Map<string, string>()
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type === 'tool' && p.callID && (p as any).input !== undefined && (p as any).output === undefined) {
        toolNames.set(p.callID, (p as any).tool ?? 'tool')
      }
    }
  }
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type === 'text') {
        turns.push({ role: m.info.role, content: (p as any).text ?? '' })
      } else if (p.type === 'tool') {
        const tp = p as any
        // tool result（有 output）-> tool turn；tool_use（有 input 无 output）不单独成 turn（input 已在配对 result）
        if (tp.output !== undefined) {
          turns.push({
            role: 'tool',
            content: typeof tp.output === 'string' ? tp.output : JSON.stringify(tp.output),
            isError: tp.error === true,
            toolName: tp.callID ? toolNames.get(tp.callID) : undefined,
          })
        }
      }
      // 其余 part（reasoning/subtask/step/patch/snapshot/agent/retry/compaction）-> 跳过
    }
  }
  return turns
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/opencode-transcript.test.ts`
Expected: PASS（6/6）。

- [ ] **Step 5: Commit**

```bash
git add src/opencode/transcript.ts tests/opencode-transcript.test.ts
git commit -m "feat(opencode): parseOpencodeMessages 纯函数（message -> TranscriptTurn）"
```

---

### Task 2: inject 跨 runtime 共享（listApprovedByScope 去 runtime 过滤）

**Files:**
- Modify: `src/memory/store.ts:124-146`（`listApprovedByScope`）
- Modify: `src/adapter/claudeCode.ts:38`
- Test: `tests/store-crud.test.ts`（更新 runtime 过滤断言）

**Interfaces:**
- Consumes: 现有 `listApprovedByScope(db, {projectId, runtime})`。
- Produces: `listApprovedByScope(db, {projectId})`（去掉 `runtime` 参数与 `filterRuntime`）。`runtime` 列保留（来源标记，`createCandidate` 写入不变），仅不再参与 inject 匹配。
- 调用方 `claudeCode.ts:38` 与 Task 3 的 `opencode.ts` 都去掉 `runtime:` 实参。

- [ ] **Step 1: Write failing test**

在 `tests/store-crud.test.ts` 加（或改既有 runtime 测试）：

```ts
test('listApprovedByScope 跨 runtime 共享：claude-code runtime 记忆对 opencode 可见', async () => {
  // seed 一条 project approved 记忆，runtime='claude-code'
  await createCandidate(db, { /* ...projectId=cwd1, runtime:'claude-code', status:'approved'... */ })
  const set = await listApprovedByScope(db, { projectId: cwd1 })
  expect(set.byScope.project.length).toBe(1)  // 不传 runtime，仍可见
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/store-crud.test.ts`
Expected: FAIL（`listApprovedByScope` 仍要求 `runtime` 参数 / 仍按 runtime 过滤）。

- [ ] **Step 3: Implement**

`src/memory/store.ts`：`listApprovedByScope` 签名改为 `opts: { projectId: string }`，删除 `filterRuntime` 与 `runtime` 引用，project/global 查询只按 scope + status。`toRow` 里 `runtime` 仍读出（来源标记）。

`src/adapter/claudeCode.ts:38`：`listApprovedByScope(this.db, { projectId: input.cwd })`（去掉 `runtime: 'claude-code'`）。

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run typecheck && bun test`
Expected: PASS。注意：若有既有测试锁了「runtime 隔离」语义，同步改为「跨 runtime 共享」并加注释「跨 runtime 共享决策（spec §5）」。

- [ ] **Step 5: Commit**

```bash
git add src/memory/store.ts src/adapter/claudeCode.ts tests/store-crud.test.ts
git commit -m "feat(inject): project 记忆跨 runtime 共享（listApprovedByScope 去 runtime 过滤）"
```

---

### Task 3: OpencodeAdapter 落地（替换 stub）

**Files:**
- Modify: `src/adapter/opencode.ts`
- Test: `tests/adapter-opencode.test.ts`

**Interfaces:**
- Consumes: `listApprovedByScope`（Task 2 新签名）、`formatMemoryBlock`、`RuntimeAdapter`/`InjectInput`（`src/adapter/types.ts`）。
- Produces: `OpencodeAdapter`（`kind:'opencode'`，`pushCapture`/`capture`/`inject`），供 Task 4 daemon 实例化。

- [ ] **Step 1: Write failing test**

```ts
// tests/adapter-opencode.test.ts
import { test, expect } from 'bun:test'
import { OpencodeAdapter } from '@/adapter/opencode'
// 用 tmp DB + createCandidate seed approved 记忆（参考 tests/store-crud.test.ts 的 db setup）

test('inject 返回 approved 记忆块（跨 runtime）', async () => {
  // seed approved project 记忆 in tmp db
  const adapter = new OpencodeAdapter(db)
  const block = await adapter.inject({ cwd: projectId })
  expect(block).toContain('--- BEGIN INJECTED MEMORY ---')
})

test('inject 无 db -> null', async () => {
  expect(await new OpencodeAdapter(undefined).inject({ cwd: '/x' })).toBeNull()
})

test('inject db 错误降级 null，不抛', async () => {
  // 用一个会抛的 fake db
  const adapter = new OpencodeAdapter(badDb as any)
  expect(await adapter.inject({ cwd: '/x' })).toBeNull()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/adapter-opencode.test.ts`
Expected: FAIL（stub inject 返回 null）。

- [ ] **Step 3: Implement**

```ts
// src/adapter/opencode.ts
import type { DbClient } from '@/db/client'
import { listApprovedByScope } from '@/memory/store'
import { formatMemoryBlock } from '@/memory/pure'
import type { RuntimeAdapter, CaptureEvent, InjectInput } from './types'

export class OpencodeAdapter implements RuntimeAdapter {
  readonly kind = 'opencode' as const
  private queue: CaptureEvent[] = []
  constructor(private db?: DbClient) {}
  pushCapture(event: CaptureEvent): void { this.queue.push(event) }
  async capture(): Promise<CaptureEvent[]> { const out = this.queue; this.queue = []; return out }
  async inject(input: InjectInput): Promise<string | null> {
    if (!this.db) return null
    try {
      const set = await listApprovedByScope(this.db, { projectId: input.cwd })
      return formatMemoryBlock(set)
    } catch { return null }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run typecheck && bun test tests/adapter-opencode.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/adapter/opencode.ts tests/adapter-opencode.test.ts
git commit -m "feat(opencode): OpencodeAdapter 落地 inject（替换 stub）"
```

---

### Task 4: daemon 实例化 OpencodeAdapter + server 接收双 adapter

**Files:**
- Modify: `src/server.ts`（deps 加 opencode adapter）
- Modify: `src/daemon.ts:151-153`（实例化 + 传 server）
- Test: `tests/server-opencode.test.ts`（inject 路由部分，与 Task 5 合并也可）

**Interfaces:**
- Consumes: `OpencodeAdapter`（Task 3）、现有 `ClaudeCodeAdapter`。
- Produces: `createApp(deps)` 接收 `deps.adapter`（claude，保留）+ `deps.opencodeAdapter`（新增）。现有 `/hooks/claude/SessionStart` 仍用 `deps.adapter.inject`；`/inject` 路由仍用 `deps.adapter.inject`（claude）或按 query `runtime` 路由——本任务保持 `/inject` 用 claude adapter，新增 `/hooks/opencode/inject` 用 opencode adapter（Task 5）。

- [ ] **Step 1: Write failing test**

```ts
// tests/server-opencode.test.ts（先建文件，本任务只测 inject 路由）
import { test, expect } from 'bun:test'
import { createApp } from '@/server'
// fake adapter: opencodeAdapter.inject returns a block; claude adapter 不动

test('GET /hooks/opencode/inject 返回 opencode adapter 块', async () => {
  const app = createApp({ db, adapter: claudeFake, opencodeAdapter: opencodeFake, enqueueDistillJob: fakeEnq, broadcast: () => {} })
  const res = await app.request('/hooks/opencode/inject?cwd=/p', { method: 'GET' })
  const body = await res.json()
  expect(body.block).toContain('--- BEGIN INJECTED MEMORY ---')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/server-opencode.test.ts`
Expected: FAIL（`createApp` 不接收 `opencodeAdapter` / 路由不存在）。

- [ ] **Step 3: Implement**

`src/server.ts`：
- `deps` 类型加 `opencodeAdapter: RuntimeAdapter`（或 `adapters`）。最小改动：加具名字段。
- 暂不注册 opencode 路由（Task 5 注册），但 deps 接收 `opencodeAdapter` 并 export type。

`src/daemon.ts`：
```ts
const claudeAdapter = new ClaudeCodeAdapter(db)
const opencodeAdapter = new OpencodeAdapter(db)
const app = createApp({ db, adapter: claudeAdapter, opencodeAdapter, enqueueDistillJob, broadcast, staticDir: opts.serveStaticDir })
```
import `OpencodeAdapter`。

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run typecheck && bun test`
Expected: PASS（既有 claude 套件不回归 + 新 inject 路由测试在 Task 5 补全；本任务先确保 typecheck 绿、deps 接通）。

- [ ] **Step 5: Commit**

```bash
git add src/server.ts src/daemon.ts tests/server-opencode.test.ts
git commit -m "feat(opencode): daemon 实例化 OpencodeAdapter + server 接收双 adapter"
```

---

### Task 5: daemon opencode 路由（capture / inject）

**Files:**
- Modify: `src/server.ts`（注册 2 路由，静态托管前）
- Test: `tests/server-opencode.test.ts`（补全 capture）

**Interfaces:**
- Consumes: `parseOpencodeMessages`（Task 1）、`enqueueDistillJob` + `memoryDistillEvents`（既有）、`opencodeAdapter.inject`（Task 4）。
- Produces: `POST /hooks/opencode/capture`、`GET /hooks/opencode/inject`。

- [ ] **Step 1: Write failing tests**

```ts
test('POST /hooks/opencode/capture -> enqueueDistillJob + events 行 + 202', async () => {
  let enqCalled = false
  const app = createApp({ db, adapter: claudeFake, opencodeAdapter: opcFake,
    enqueueDistillJob: async (_db, input) => { enqCalled = input.runtime === 'opencode'; return { jobId: 'j1', nextRunAt: 0 } },
    broadcast: () => {} })
  const res = await app.request('/hooks/opencode/capture', { method: 'POST', body: JSON.stringify({ sessionId: 's1', cwd: '/p', messages: [{ info: { role: 'user' }, parts: [{ type: 'text', text: 'hi' }] }] }), headers: { 'content-type': 'application/json' } })
  expect(res.status).toBe(202)
  expect(enqCalled).toBe(true)
  // memory_distill_events 行写入（用 tmp db 查验）
})

test('GET /hooks/opencode/inject?cwd= -> {block}', async () => { /* Task 4 已覆盖，补无记忆返回 null block */ })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/server-opencode.test.ts`
Expected: FAIL（路由不存在）。

- [ ] **Step 3: Implement**

`src/server.ts`，在 `/inject` 路由附近、静态托管前注册：

```ts
import { parseOpencodeMessages } from '@/opencode/transcript'
import type { OpencodeMessage } from '@/opencode/transcript'
// memoryDistillEvents 已 import

app.post('/hooks/opencode/capture', async (c) => {
  const body = await c.req.json().catch(() => ({}) as { sessionId?: string; cwd?: string; messages?: OpencodeMessage[]; sourceEventId?: string })
  const cwd = body.cwd ?? ''
  const sessionId = body.sessionId ?? ''
  const sourceEventId = body.sourceEventId ?? `opencode-idle-${Date.now()}`
  const debounceKey = sessionId || `${cwd}:opencode`
  const turns = parseOpencodeMessages(body.messages ?? [])
  void (async () => {
    try {
      const { jobId } = await deps.enqueueDistillJob(deps.db, { sourceEventId, runtime: 'opencode', cwd, debounceKey, sessionId })
      await deps.db.insert(memoryDistillEvents).values({ distillJobId: jobId, attemptIndex: 0, ts: Date.now(), kind: 'conversation', payload: JSON.stringify(turns) })
    } catch (e) { deps.broadcast({ type: 'memory.enqueue.failed', sourceEventId, error: String(e) }) }
  })()
  deps.broadcast({ type: 'memory.capture', sourceEventId })
  return c.json({ ok: true }, 202)
})

app.get('/hooks/opencode/inject', async (c) => {
  const cwd = c.req.query('cwd') ?? ''
  const block = await deps.opencodeAdapter.inject({ cwd })
  return c.json({ block })
})
```

注意：对照 `enqueueDistillJob` 实际签名调整（`EnqueueInput` 是否含 `sessionId`——claude code Stop 路由已传，见 `server.ts:219`；error 信号不走单独路由，由 capture 全量 transcript 的 `isError` turn 经 `detectErrorSignals` 提取，对齐 claude code 第四轮 server.ts:148-154）。

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run typecheck && bun test`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/server.ts tests/server-opencode.test.ts
git commit -m "feat(opencode): daemon /hooks/opencode/{capture,inject} 路由"
```

---

### Task 6: opencode plugin（opencode-plugin/）

**Files:**
- Create: `opencode-plugin/package.json`
- Create: `opencode-plugin/memside.js`
- Test: `tests/plugin-opencode.test.ts`（源码层文本断言）

**Interfaces:**
- Consumes: daemon 路由契约（Task 5）：`POST /hooks/opencode/capture` body `{sessionId, cwd, messages}`、`GET /hooks/opencode/inject?cwd=` 返回 `{block}`。
- Produces: opencode plugin（默认导出 `async ({client, directory}) => Hooks`），install 时端口占位 `__MEMSIDE_PORT__` 烘焙。

- [ ] **Step 1: Write failing test**

```ts
// tests/plugin-opencode.test.ts
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'

const js = readFileSync(new URL('../opencode-plugin/memside.js', import.meta.url), 'utf-8')

test('plugin 注册两钩子', () => {
  expect(js).toContain("'experimental.chat.messages.transform'")
  expect(js).toContain('session.idle')
})

test('plugin 端口 env 优先烘焙回退', () => {
  expect(js).toContain('process.env.MEMSIDE_PORT')
  expect(js).toContain('__MEMSIDE_PORT__')
})

test('inject 幂等守卫标记', () => {
  expect(js).toContain('--- BEGIN INJECTED MEMORY ---')
})

test('best-effort catch 不抛回 opencode', () => {
  expect(js).toMatch(/catch/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/plugin-opencode.test.ts`
Expected: FAIL（文件不存在）。

- [ ] **Step 3: Implement**

`opencode-plugin/package.json`:
```json
{ "name": "memside-opencode", "version": "0.1.0", "type": "module", "main": "memside.js" }
```

`opencode-plugin/memside.js`（核心骨架；callID/Part 处理由 daemon 侧 `parseOpencodeMessages` 负责，plugin 只 POST 原始 messages）:

```js
const PORT = () => process.env.MEMSIDE_PORT || __MEMSIDE_PORT__;
const BASE = () => `http://127.0.0.1:${PORT()}`;
const INJECT_MARK = '--- BEGIN INJECTED MEMORY ---';

export default async function memsidePlugin({ client, directory }) {
  const cwd = directory;
  // session.idle 已处理过的最高水位，避免重复拉取（daemon 侧 offset 兜底，这里额外去重）
  return {
    event: async ({ event }) => {
      if (event.type !== 'session.idle') return;
      try {
        const sessionID = event.properties?.sessionID ?? event.properties?.info?.id;
        if (!sessionID) return;
        const res = await client.session.messages({ sessionID });
        const messages = (res.data?.messages ?? res.data ?? []) ;
        await fetch(`${BASE()}/hooks/opencode/capture`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: sessionID, cwd, messages }),
        });
      } catch (e) { /* best-effort: 不抛回 opencode */ }
    },
    'experimental.chat.messages.transform': async (_input, output) => {
      try {
        if (!output.messages?.length) return;
        const firstUser = output.messages.find(m => m.info?.role === 'user');
        if (!firstUser?.parts?.length) return;
        if (firstUser.parts.some(p => p.type === 'text' && p.text?.includes(INJECT_MARK))) return; // 幂等
        const res = await fetch(`${BASE()}/hooks/opencode/inject?cwd=${encodeURIComponent(cwd)}`, { method: 'GET' });
        const { block } = await res.json();
        if (!block) return;
        const ref = firstUser.parts[0];
        firstUser.parts.unshift({ ...ref, type: 'text', text: block });
      } catch (e) { /* best-effort */ }
    },
  };
}
```

> 验证缺口（实现时对照真实 opencode 1.15.5 跑 `opencode run --print-logs` 确认）：(1) `client.session.messages` 返回结构（`res.data` 形状）；(2) `session.idle` 的 `event.properties` 是否带 `sessionID`；(3) `messages.transform` 每 step 触发的幂等。

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/plugin-opencode.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add opencode-plugin/ tests/plugin-opencode.test.ts
git commit -m "feat(opencode): in-process plugin（event/messages.transform）"
```

---

### Task 7: install 扩展（installOpencodePlugin + CLI 串调）

**Files:**
- Modify: `src/install.ts`（新增 `installOpencodePlugin`）
- Modify: `src/cli.ts`（install / start-and-install 串调）
- Test: `tests/install-opencode.test.ts`

**Interfaces:**
- Consumes: `opencode-plugin/` 目录（Task 6）、`resolveHome()`（既有）。
- Produces: `installOpencodePlugin({port, baseDir?, pluginSrcDir?})`——复制 plugin 到 `~/.config/opencode/memside-opencode/`（端口占位替换）+ 幂等合并 `opencode.json` `plugin` 数组（路径子串 `memside-opencode` 标记识别）。

- [ ] **Step 1: Write failing tests**

```ts
// tests/install-opencode.test.ts
import { test, expect } from 'bun:test'
import { installOpencodePlugin } from '@/install'
import { readFileSync, existsSync } from 'node:fs'
// baseDir = tmp dir; pluginSrcDir = 仓库 opencode-plugin/

test('复制 plugin 文件 + 端口烘焙', () => {
  installOpencodePlugin({ port: 8888, baseDir: tmpDir, pluginSrcDir: realPluginDir })
  const js = readFileSync(join(tmpDir, 'memside-opencode', 'memside.js'), 'utf-8')
  expect(js).toContain('8888')  // __MEMSIDE_PORT__ 被替换
  expect(existsSync(join(tmpDir, 'memside-opencode', 'package.json'))).toBe(true)
})

test('opencode.json plugin 数组幂等 + 保留用户既有条目', () => {
  // 先写一个含 "plugin": ["superpowers@..."] 的 opencode.json
  installOpencodePlugin({ port: 7777, baseDir: tmpDir, pluginSrcDir: realPluginDir })
  installOpencodePlugin({ port: 7777, baseDir: tmpDir, pluginSrcDir: realPluginDir })  // 重复
  const cfg = JSON.parse(readFileSync(join(tmpDir, 'opencode.json'), 'utf-8'))
  expect(cfg.plugin.filter(p => p.includes('memside-opencode')).length).toBe(1)  // 不重复
  expect(cfg.plugin.some(p => p.includes('superpowers'))).toBe(true)  // 保留用户条目
})

test('malformed opencode.json 当空文档不抛', () => {
  writeFileSync(join(tmpDir, 'opencode.json'), '{not json')
  expect(() => installOpencodePlugin({ port: 7777, baseDir: tmpDir, pluginSrcDir: realPluginDir })).not.toThrow()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/install-opencode.test.ts`
Expected: FAIL（`installOpencodePlugin` 不存在）。

- [ ] **Step 3: Implement**

`src/install.ts` 新增（复用 `resolveHome`、`MEMSIDE_TAG` 模式但用路径子串）：

```ts
import { cpSync } from 'node:fs'

export function installOpencodePlugin(opts: { port: number; baseDir?: string; pluginSrcDir: string }): void {
  const ocdDir = opts.baseDir ?? join(resolveHome(), '.config', 'opencode')
  mkdirSync(ocdDir, { recursive: true })
  const destDir = join(ocdDir, 'memside-opencode')
  // 复制 plugin 目录
  cpSync(opts.pluginSrcDir, destDir, { recursive: true })
  // 端口烘焙：读 memside.js 替换 __MEMSIDE_PORT__
  const jsPath = join(destDir, 'memside.js')
  let js = readFileSync(jsPath, 'utf-8')
  js = js.replace(/__MEMSIDE_PORT__/g, String(opts.port))
  writeFileSync(jsPath, js)
  // 幂等合并 opencode.json
  const settingsPath = join(ocdDir, 'opencode.json')
  let cfg: Record<string, unknown> = {}
  if (existsSync(settingsPath)) {
    try { const p = JSON.parse(readFileSync(settingsPath, 'utf-8')); if (p && typeof p === 'object' && !Array.isArray(p)) cfg = p } catch { cfg = {} }
  }
  let plugin = Array.isArray(cfg.plugin) ? cfg.plugin as string[] : []
  plugin = plugin.filter(p => typeof p === 'string' && !p.includes('memside-opencode'))
  plugin.push(destDir.replace(/\\/g, '/'))
  cfg.plugin = plugin
  writeFileSync(settingsPath, JSON.stringify(cfg, null, 2) + '\n')
}
```

`src/cli.ts`：
```ts
import { installHooks, installOpencodePlugin } from './install'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
const pluginSrcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'opencode-plugin')
// install 分支：
installHooks({ port: PORT })
installOpencodePlugin({ port: PORT, pluginSrcDir })
console.log('hooks installed into ~/.claude/settings.json; opencode plugin installed into ~/.config/opencode/')
// start-and-install 分支同理（startDaemon installClaudeHooks 之外再调 installOpencodePlugin）
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run typecheck && bun test`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/install.ts src/cli.ts tests/install-opencode.test.ts
git commit -m "feat(opencode): installOpencodePlugin + CLI 串调（幂等 opencode.json）"
```

---

### Task 8: Web UI sourceLabel + README/STATE 收尾

**Files:**
- Modify: `src/web/App.tsx`（`sourceLabel` 加 `'opencode'`）
- Modify: `README.md`（去 opencode 限制 + 加 opencode 用法）
- Modify: `STATE.md`（记录交付 + 验证缺口）

**Interfaces:** 无新接口，纯收尾。

- [ ] **Step 1: Write failing test**

`src/web/App.tsx` 的 `sourceLabel` 若有 `claude-code` 分支，加 `opencode` 分支。源码层断言（参考既有 web-ui 测试模式）：

```ts
test('sourceLabel 含 opencode', () => {
  const src = readFileSync(new URL('../src/web/App.tsx', import.meta.url), 'utf-8')
  expect(src).toMatch(/opencode/)
})
```

- [ ] **Step 2: Run test to verify it fails** — `bun test`（新断言）Expected FAIL。

- [ ] **Step 3: Implement** — `App.tsx` `sourceLabel` 加 `'opencode'` 中文标签（如「opencode」）。README「已知限制」删 opencode stub 行 + 加 opencode 安装/用法小节。STATE.md 加「opencode 支持」交付段 + 验证缺口追踪。

- [ ] **Step 4: Run test to verify it passes** — `bun run typecheck && bun test` Expected PASS（全套绿）。

- [ ] **Step 5: Commit**

```bash
git add src/web/App.tsx README.md STATE.md
git commit -m "docs(opencode): UI sourceLabel + README/STATE 收尾"
```

---

## Self-Review

**1. Spec coverage:** spec 各节均有点名任务——plugin 两钩子（Task 6）、daemon 两路由（Task 5）、OpencodeAdapter（Task 3）、transcript 转换（Task 1）、inject 跨 runtime（Task 2）、install（Task 7）、Web UI sourceLabel（Task 8）。daemon 双 adapter 接线（Task 4）。验证缺口在 Task 6 标注，live smoke 留实现后手动跑（spec 测试策略 live-only）。

**2. Placeholder scan:** 代码块均为可执行骨架；`enqueueDistillJob` 签名细节标注「对照实际签名调整」（Task 5），非占位而是诚实声明（实现时验证 `sourceKind` 是否在 `EnqueueInput`）。

**3. Type consistency:** `parseOpencodeMessages(messages: OpencodeMessage[])` 在 Task 1 定义、Task 5 消费，签名一致。`listApprovedByScope(db, {projectId})` Task 2 定义、Task 3 消费，一致。`installOpencodePlugin({port, baseDir?, pluginSrcDir})` Task 7 定义、cli 消费，一致。`OpencodeAdapter` Task 3 定义、Task 4 实例化，一致。

## Execution Handoff

实现顺序：Task 1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7 -> 8（严格依赖序）。每任务 TDD 红->绿->commit。全过完后 `bun run typecheck && bun test` 全绿，然后手动跑 live smoke（真实 `opencode run` + tmp DB 走闭环，验证 spec 验证缺口 1-7）。PR 合并后清理本地分支。`.superpowers/sdd/` 在本 plan 落档后、切分支前清理。

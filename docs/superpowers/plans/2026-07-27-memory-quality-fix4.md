# 记忆质量修复第四轮 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** PostToolUse hook 不再 enqueue 蒸馏，根治"同一段会话被重复蒸馏 N 次"导致的同义候选爆炸。

**Architecture:** server.ts 的 hook 路由里 PostToolUse 早返回 202（不 parse/event/enqueue/broadcast）。Stop/SubagentStop 仍完整蒸馏。错误信号由 distiller 内 detectErrorSignals 从 Stop transcript（含全部 tool_result）提取，PostToolUse 无独有价值。

**Tech Stack:** Bun + Hono + bun:sqlite；测试 bun:test（注入 mock enqueueDistillJob + broadcast）。

## Global Constraints

- LLMCall seam 保持 vendor-neutral。
- 不动 enqueueDistillJob/makeLoadTranscript/parseTranscriptFile/scheduler tick。
- 不删已入库 PostToolUse job/event（历史数据不动）。
- 不动 hooks 安装配置（install.ts 不改；settings.json 仍装 PostToolUse hook）。
- 前三轮修复（条件门/输入过滤/dedup/64k 预算/subject 信号）全保留不回退。
- 测试随改动落地（TDD：先红后绿）；`bun run typecheck && bun test` 全绿才能 push。
- 分支 `feat/memory-quality-fix4`（已从最新 `origin/master` 切出），PR 目标 `master`。

---

## File Structure

| 文件 | 责任 | 本轮改动 |
|---|---|---|
| `src/server.ts` | hook 路由 + collector | PostToolUse 早返回 + sourceKind 简化 + 注释更新 |
| `tests/server.test.ts` | server 单测 | PostToolUse 测试改为断言"跳过" |

---

## Task 1: PostToolUse 早返回 + sourceKind 简化 + 测试改造

**Files:**
- Modify: `src/server.ts`（hook 路由 第 84-95 行 + 顶部注释 第 39-40 行）
- Test: `tests/server.test.ts`（PostToolUse 测试 第 125-151 行）

**Interfaces:**
- Consumes: 无（首个且唯一任务）
- Produces: server.ts PostToolUse 路径早返回 202；sourceKind 恒 'conversation'。

- [ ] **Step 1: 改 tests/server.test.ts 的 PostToolUse 测试为断言"跳过"**

`tests/server.test.ts` 第 125-151 行，整段替换：

旧：
```ts
test('collector PostToolUse marks sourceKind error', async () => {
  // PostToolUse events carry error signals; the collector must tag them
  // sourceKind='error' so the distiller routes to the error-signal prompt path.
  // C3: writes a real JSONL fixture with a tool_result is_error=true turn.
  const fixturePath = writeJsonlFixture('posttool.jsonl', {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'err', is_error: true }],
    },
  })
  const r = await req('/hooks/claude/PostToolUse', {
    method: 'POST',
    body: JSON.stringify({ sourceEventId: 'e2', cwd: '/r', transcript_path: fixturePath }),
    headers: { 'content-type': 'application/json' },
  })
  expect(r.status).toBe(202)
  // C1 fix: sourceKind is persisted as `kind` on the memory_distill_events row
  // (previously asserted on the vestigial adapter.pushCapture queue).
  await new Promise((res) => setTimeout(res, 50))
  const events = await db.select().from(memoryDistillEvents)
  expect(events.length).toBe(1)
  expect(events[0]!.kind).toBe('error')
  // C3 lock: the real tool_result turn was parsed and stored.
  expect(events[0]!.payload).toContain('"role":"tool"')
  expect(events[0]!.payload).toContain('"isError":true')
})
```

新：
```ts
test('collector PostToolUse is skipped (no distill, no event, no job, no broadcast)', async () => {
  // 第四轮：PostToolUse transcript 是累积式全量，与 Stop transcript 前缀重叠，
  // 每次 tool call 一个 job 导致同一段会话被重复蒸馏（同义候选爆炸）。
  // PostToolUse 不再蒸馏--Stop transcript 已含全部 tool_result（含 error），
  // 错误信号由 distiller 内 detectErrorSignals 从 Stop transcript 提取。
  // 即使带 transcript_path + is_error turn，也直接 202 跳过，不产生任何副作用。
  const fixturePath = writeJsonlFixture('posttool.jsonl', {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'err', is_error: true }],
    },
  })
  const beforeEvents = await db.select().from(memoryDistillEvents)
  const r = await req('/hooks/claude/PostToolUse', {
    method: 'POST',
    body: JSON.stringify({ sourceEventId: 'e2', cwd: '/r', transcript_path: fixturePath }),
    headers: { 'content-type': 'application/json' },
  })
  expect(r.status).toBe(202)
  // 等待 fire-and-forget 路径（若误走）写出 event
  await new Promise((res) => setTimeout(res, 50))
  const events = await db.select().from(memoryDistillEvents)
  expect(events.length).toBe(beforeEvents.length)  // 不存 event
  expect(enqueueCalls.length).toBe(0)               // 不 enqueue job
  expect(broadcastCalls.length).toBe(0)             // 不 broadcast（连 memory.capture 都不发）
})
```

注意：`enqueueCalls` / `broadcastCalls` 在 `beforeEach`（第 34-35 行）重置为 `[]`，每个测试干净起步，所以 `enqueueCalls.length === 0` / `broadcastCalls.length === 0` 可直接断言。`beforeEvents` 用于容错（万一表里已有历史行，但 fresh db 下应为 0）。

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test tests/server.test.ts`
Expected: FAIL - PostToolUse 测试断言 `events.length === beforeEvents.length`（期望 0）失败（当前 PostToolUse 仍存 event，events.length === 1）；`enqueueCalls.length === 0` 失败（当前 enqueue 了 1 次）；`broadcastCalls.length === 0` 失败（当前 broadcast 了 memory.capture）。

- [ ] **Step 3: 改 server.ts PostToolUse 早返回**

`src/server.ts`：在 SessionStart 早返回块（第 73-84 行 `if (event === 'SessionStart') {...}`）**之后**、`const transcriptPath`（第 92 行）**之前**，插入 PostToolUse 早返回：

```ts
    // PostToolUse 不蒸馏（第四轮）：transcript 是累积式全量，与 Stop transcript
    // 前缀重叠，每次 tool call 一个 job 会导致同一段会话被重复蒸馏（同义候选爆炸）。
    // Stop/SubagentStop transcript 已含全部 tool_result（含 error），错误信号由
    // distiller 内的 detectErrorSignals 从 Stop transcript 提取，PostToolUse 无独有价值。
    if (event === 'PostToolUse') {
      return c.json({ ok: true }, 202)
    }
```

- [ ] **Step 4: 改 server.ts sourceKind 简化**

`src/server.ts` 第 95 行：

旧：
```ts
    const sourceKind = event === 'PostToolUse' ? 'error' : 'conversation'
```
新：
```ts
    const sourceKind = 'conversation'
```

（PostToolUse 已早返回，走到这里的只剩 Stop/SubagentStop，恒 conversation。）

- [ ] **Step 5: 改 server.ts 顶部注释**

`src/server.ts` 第 39-40 行：

旧：
```
 *      and enqueues a distill job. `sourceKind` is `'error'` for `PostToolUse`
 *      (error-signal transcript path) and `'conversation'` otherwise.
```
新：
```
 *      and enqueues a distill job. `sourceKind` is `'conversation'` (PostToolUse
 *      is skipped entirely - see the early return in the route handler).
```

- [ ] **Step 6: 运行测试确认通过**

Run: `bun test tests/server.test.ts`
Expected: PASS（全部，含改造后的 PostToolUse 跳过测试 + 现有 Stop/SubagentStop/SessionStart 测试不变）。

特别确认这些现有测试仍绿：
- `collector hook accepts event and acks 202`（Stop 存 event + broadcast）
- `collector acks 202 even when enqueue rejects`（Stop enqueue 失败兜底）
- `collector SessionStart returns hookSpecificOutput envelope`（SessionStart inject）

- [ ] **Step 7: typecheck + 全量回归**

Run: `bun run typecheck && bun test`
Expected: typecheck 干净；`bun test` 全绿（前三轮测试全绿不回退；install.test.ts 仍绿--hooks 安装不动）。

- [ ] **Step 8: Commit**

```bash
git add src/server.ts tests/server.test.ts
git commit -m "feat(server): skip PostToolUse distill (root-cause fix for duplicate candidates)"
```

---

## 完成后（非本计划任务，执行阶段之后）

- 推远端 + 开 PR 合并回 `master`（PR 标题 `feat(memory): 记忆质量修复第四轮 - PostToolUse 跳过根治重复蒸馏`）。
- 合并后本地 `git branch -d feat/memory-quality-fix4` + `git fetch --prune`。
- 重启 daemon 验证：PostToolUse job 不再新增；一次会话只产 Stop + SubagentStop job；同义候选不再爆炸。

# 记忆质量修复第四轮设计（PostToolUse 跳过 - 输入侧去重）

## 1. 背景

前三轮（PR #13/#14/#15）都在调提示词/判定逻辑（输入过滤、条件门、subject 信号、dedup 合并），但诊断发现真正的病根在输入侧架构--提示词层修复是在和输入问题打补丁。

### 1.1 诊断证据（查实际 DB + 代码链路）

**问题1：全量累积 transcript，非增量**。claude code 的 `transcript_path` 指向累积式 JSONL，每次 hook 触发时文件包含从会话开始到当前的全部 turns。实测一个 Stop job：711 turns、624KB、~140k tokens，第一条 user 是几小时前第一轮分析的起点。`filterTranscriptForDistill` 压到 64k（654/711 turns 保留），但仍是整段累积会话。

**问题2：当前会话关键信息出现在相邻会话记录里--大量重复**。`enqueueDistillJob`（scheduler.ts:26）每次 hook 都新建 job，`debounceKey` 字段存了但从不用于合并。实测 4 个 PostToolUse job（ageMin 0-1，几乎同时）：4 个 job 开头完全相同（都是几小时前第一句），turns 数 726/724/722/718 递减（越早捕获 turns 越少），结尾各异。同一段会话被重复蒸馏 4 次，每次从头开始。这是 dogfood 场景"5 条同义 invariant"的源头--同一规则在 4 个重叠 transcript 里各被提取一次。dedup 第二轮加的合并是在和这个重复问题打补丁，但源头不停产 dedup 永远追不上。

**问题3：阶段现象--PostToolUse 与 Stop 重叠**。最近 15 个 job：PostToolUse ×11、SubagentStop ×2、Stop ×1，全 cwd=memside。PostToolUse 每次工具调用后触发（transcript 是会话到当前工具为止的累积），Stop 在会话结束时触发（完整会话）。两者内容高度重叠（PostToolUse 是 Stop 的前缀子集），各自独立蒸馏。每个 job 恰好 1 个 event（1:1）。

### 1.2 根因

`server.ts:86-130` 里 Stop/SubagentStop/PostToolUse 共用同一路径：parse transcript -> enqueue job -> 存 event payload -> broadcast。PostToolUse 每次工具调用都触发（hooks 配置确认四类都在跑），累积式 transcript 下每个 PostToolUse job 都是会话从头到当前的全量，与 Stop transcript 前缀重叠。`enqueueDistillJob` 无 debounce 合并（debounceKey 只用于 nextRunAt 延迟）。

### 1.3 第四轮定位

方案 A（三方案对比后选定）：PostToolUse 不再 enqueue 蒸馏，只 Stop/SubagentStop 触发。这是唯一彻底解决重复的方案--B（debounce 合并）和 C（仅 error enqueue）都只减少不根治。Stop transcript 含全部 tool_result（含 error），错误信号由 distiller 内的 detectErrorSignals 从 Stop transcript 提取，PostToolUse 无独有价值。

## 2. 目标 / 非目标

### 目标
- PostToolUse hook 收到后直接 202 ack 返回，不 parse、不存 event、不 enqueue、不 broadcast。
- Stop/SubagentStop 仍完整蒸馏（不动）。
- 一次会话的 job 数从"几十个 PostToolUse + 1 Stop"降到"1 Stop + N SubagentStop"。

### 非目标
- 不加 debounce 合并逻辑（YAGNI--Stop/SubagentStop 频率低，不需要）。
- 不加增量偏移/schema 变更（YAGNI--不再有累积式重复蒸馏问题）。
- 不动 enqueueDistillJob / makeLoadTranscript / scheduler tick / parseTranscriptFile（仍正确，只是 PostToolUse 不再调用）。
- 不删已入库的 PostToolUse job/event（历史数据不动；DB 膨胀是独立 issue）。
- 不动 hooks 安装配置（settings.json 仍装 PostToolUse hook，daemon 端不处理）。
- 前三轮修复（条件门/输入过滤/dedup/64k 预算/subject 信号）全保留不回退。

## 3. 接口契约

### 3.1 server.ts hook 路由改造

`src/server.ts` 的 hook 处理（当前 SessionStart 之后、Stop/SubagentStop/PostToolUse 共用路径之前）加 PostToolUse 早返回：

```ts
if (event === 'SessionStart') {
  ... inject ...
  return c.json(...)
}

// PostToolUse 不蒸馏：transcript 是累积式全量，与 Stop transcript 前缀重叠，
// 每次 tool call 一个 job 会导致同一段会话被重复蒸馏（同义候选爆炸）。
// Stop/SubagentStop transcript 已含全部 tool_result（含 error），错误信号由
// distiller 内的 detectErrorSignals 从 Stop transcript 提取，PostToolUse 无独有价值。
if (event === 'PostToolUse') {
  return c.json({ ok: true }, 202)
}

// Stop / SubagentStop 继续：parse + enqueue + store event + broadcast
```

### 3.2 sourceKind 简化

当前 `const sourceKind = event === 'PostToolUse' ? 'error' : 'conversation'`（server.ts:95）。PostToolUse 跳过后，走到共用路径的只剩 Stop/SubagentStop，恒为 `'conversation'`。简化为 `const sourceKind = 'conversation'`。

### 3.3 注释更新

server.ts:39 当前注释说"`sourceKind` is `'error'` for `PostToolUse` (error-signal transcript path) and `'conversation'` otherwise"。PostToolUse 跳过后过时，更新为只说 Stop/SubagentStop 是 conversation。

### 3.4 不变项

- `enqueueDistillJob` / `makeLoadTranscript` / `parseTranscriptFile` / scheduler tick：不动。
- SessionStart 路径：不动。
- Stop/SubagentStop 路径：不动（仍 parse + enqueue + store + broadcast）。
- hooks 安装配置（install.ts）：不动（仍装 PostToolUse hook）。

## 4. 数据流与不变量

### 4.1 新数据流

1. **PostToolUse hook** -> server.ts -> **202 ack 立即返回**，不 parse、不存 event、不 enqueue、不 broadcast。
2. **Stop hook** -> server.ts -> parse transcript（完整会话）-> enqueue job -> 存 event payload -> broadcast capture。tick 时 distill 完整会话。
3. **SubagentStop hook** -> 同 Stop（subagent 独立 transcript，完整子会话）。
4. **SessionStart hook** -> 不变（inject approved memories）。

### 4.2 关键不变量

| 不变量 | 来源 | 本轮状态 |
|---|---|---|
| Stop/SubagentStop 仍完整蒸馏 | - | 保留（transcript 含全部 tool_result + error）|
| 错误信号不丢 | 第一轮 | 保留（detectErrorSignals 跑在 Stop transcript，含 tool error）|
| SessionStart inject 不变 | - | 保留 |
| 前三轮修复不回退 | - | 保留（条件门/输入过滤/dedup/64k 预算/subject 信号全不动）|
| hook <50ms ack 契约 | 现有 | 保留（PostToolUse 早返回更快）|

### 4.3 向后兼容

- 已入库的 PostToolUse job/event：不删不改，仍会被 tick 处理（如果还有 pending 的），只是不再产生新的。
- DB 里历史 PostToolUse event payload：占空间但不影响新逻辑（STATE.md 记的 DB 膨胀是独立 issue）。
- 已 enqueue 的 pending PostToolUse job：tick 仍会处理它们（status='pending' 的照常跑），只是不再新增。

### 4.4 错误处理

无新失败模式。PostToolUse 早返回是纯同步 `return c.json`，无 IO、无异常路径。Stop/SubagentStop 的错误处理不变。

## 5. 与现有模块的耦合点

| 模块 | 本轮改动 | 兼容性 |
|---|---|---|
| `src/server.ts` | PostToolUse 早返回 + sourceKind 简化 + 注释更新 | 纯控制流变更，无接口/类型变更 |
| `src/scheduler.ts` | 无 | 不变 |
| `src/daemon.ts` | 无 | 不变 |
| `src/claude/transcript.ts` | 无 | 不变 |
| `src/install.ts` | 无 | 不变（仍装 PostToolUse hook）|

## 6. 测试策略

### 6.1 server.test.ts 改造

**改现有测试** `collector PostToolUse marks sourceKind error`（server.test.ts:125-151）：当前断言 PostToolUse 后 event 表有 1 行 kind='error'。方案 A 后 PostToolUse 不再存 event。改为断言"PostToolUse 返回 202 且不存 event、不 enqueue job"：

```ts
test('collector PostToolUse is skipped (no distill, no event, no job)', async () => {
  // 第四轮：PostToolUse transcript 是累积式全量，与 Stop transcript 前缀重叠，
  // 每次 tool call 一个 job 导致同义候选爆炸。PostToolUse 不再蒸馏--Stop transcript
  // 已含全部 tool_result（含 error），错误信号由 distiller 内 detectErrorSignals 提取。
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
  await new Promise((res) => setTimeout(res, 50))
  const events = await db.select().from(memoryDistillEvents)
  expect(events.length).toBe(0)  // 不存 event
  const jobs = await db.select().from(memoryDistillJobs)
  expect(jobs.length).toBe(0)    // 不 enqueue job
})
```

**保留测试**：Stop/SubagentStop 仍存 event + enqueue 的测试不动（server.test.ts:74 等）。

### 6.2 新增 e2e 对比测试（可选，若 server.test.ts 已覆盖则免）

若 server.test.ts 的 Stop 测试已验证"Stop 存 event + enqueue"，则 PostToolUse 跳过测试 + Stop 保留测试共同构成正反锚点，无需额外 e2e。

### 6.3 运行门槛

`bun run typecheck && bun test` 全绿。新测试顶端注释写清"为什么这条测试存在"（链接第四轮根因：PostToolUse 重复蒸馏）。describe/title 用 `PostToolUse skipped` 等可识别词。

### 6.4 install.test.ts 不动

`tests/install.test.ts:38-44` 验证 PostToolUse hook 仍被安装。本轮**不动 hooks 安装**（settings.json 仍装 PostToolUse hook，daemon 端不处理），这些测试应仍绿。

## 7. 验收清单

- [ ] server.ts PostToolUse 早返回（202，不 parse/event/enqueue/broadcast）
- [ ] sourceKind 简化为 'conversation' + 注释更新
- [ ] server.test.ts PostToolUse 测试改为断言"跳过"（不存 event、不 enqueue）
- [ ] Stop/SubagentStop 测试仍绿（不回退）
- [ ] install.test.ts 仍绿（hooks 安装不动）
- [ ] `bun run typecheck && bun test` 全绿
- [ ] 重启后：PostToolUse job 不再新增；一次会话只产 Stop + SubagentStop job；同义候选不再爆炸

# 记忆质量修复第五轮设计（增量蒸馏 - turn 偏移 + SubagentStop 跳过）

## 1. 背景

第四轮（PR #16，PostToolUse 跳过）只堵住了三个重复源中的一个。dogfood 复盘 + DB 深挖发现真正的主体重复源是 **Stop 累积重复蒸馏**，第四轮的 YAGNI（"砍 PostToolUse 就够了，不加增量偏移"）判断错误。本轮根因修复。

### 1.1 诊断证据（查实际 DB + 代码链路 + claude code hook 文档）

**问题1：Stop-vs-Stop 累积重复蒸馏（真正的主体）**。claude code 的 `transcript_path` 指向累积式 JSONL，会话越长文件越大，每次 `Stop` hook 看到的都是从会话起点到当前的**全量** turns。实测同一 session 被 Stop 了 33 次，对应 33 个 Stop job，turns 数从 36 单调增长到 711。验证：早 Stop 的 transcript 是晚 Stop 的**完整前缀**（前 36 turn 完全一致）。也就是说，第 N 次 Stop 把第 N-1 次已经蒸馏过的前缀又从头蒸馏了一遍——33 次里同一段早期会话被重复蒸馏最多 33 次。这才是"同义候选爆炸"的真正源头，dedup 第二轮加的合并是在和它打补丁，源头不停产 dedup 永远追不上。第四轮砍 PostToolUse 没碰到这个——PostToolUse 只是次要重复源。

**问题2：SubagentStop 与 Stop 重叠**。实测 SubagentStop 的 `transcript_path` 指向**主会话** JSONL（不是独立子会话）：其 firstUser 与同 session 的 Stop 完全相同，turns 数 712 vs 711（几乎一致）。第四轮假设 SubagentStop 是独立子会话 transcript、有独有价值，这个假设错了——它和 Stop 蒸馏的是同一段主会话，纯重复。验证依据：claude code hook 官方文档（https://code.claude.com/docs/en/hooks）确认所有 hook payload 含 `session_id`、`transcript_path`，SubagentStop 额外含 `agent_id`/`agent_type`，但 `transcript_path` 仍指主会话文件。

**问题3：会话识别缺失**。`enqueueDistillJob`（scheduler.ts:26）不存 session 标识，`debounceKey` 是 `${cwd}:${event}`（server.ts:105）——同一会话的多次 Stop 因 event 相同共享 debounceKey，但 debounceKey 只用于 `nextRunAt` 延迟，从不用于合并或增量定位。没有 session 维度，无法知道"这个会话上次蒸馏到第几 turn"。claude code hook payload 里的 `session_id`（文档确认所有 hook 都带）是天然的会话键，但目前从未读取。

### 1.2 根因

`server.ts:97-141` 里 Stop/SubagentStop 共用同一路径：parse transcript -> enqueue job -> 存 event payload -> broadcast。每次 Stop 都新建 job（`enqueueDistillJob` 无合并），`makeLoadTranscript`（daemon.ts:30-44）把该 job 的 event payload 全量解析成 turns 喂给 distiller。累积式 transcript 下，每个 Stop job 的 turns 都是会话从头到当前的全量，后一个 Stop 包含前一个的完整前缀。`tick`（scheduler.ts:105-176）拿到全量 turns 直接 `distillTranscript`，无任何"已蒸馏偏移"概念。SubagentStop 走同一路径，与 Stop 重复。

### 1.3 第五轮定位

两处根因修复，互不依赖：

- **增量蒸馏（turn 偏移）**：用 `session_id` 作键，记录每个会话"上次蒸馏到第几 turn"。下次该会话的 Stop job 只蒸馏 `turns.slice(offset)` 之后的新增 turn；无新增则跳过蒸馏。这是 Stop-vs-Stop 累积重复的根治。偏移存新表 `memory_session_offsets`。
- **SubagentStop 跳过**：SubagentStop transcript 指向主会话、与 Stop 重复，早返回 202（与第四轮 PostToolUse 跳过对称）。SubagentStop 无独有价值。

第四轮的 PostToolUse 跳过保留不动。前三轮（条件门/输入过滤/dedup/64k 预算/subject 信号）全保留。

### 1.4 已知折损（可接受）

claude code 的 transcript **不是严格单调追加**：会话过长触发 compaction 时会改写早期 turn（实测两个 Stop 的 transcript 在第 2 turn 处就出现前缀分叉）。turn 偏移切片会漏掉被改写的早期 turn——但那些是几小时前的低价值历史，漏掉可接受；而新增 turn（会话尾部、最新决策）永远被正确捕获。这是"用最小复杂度拿到 90% 收益"的权衡，compaction 感知留作未来 issue。

## 2. 目标 / 非目标

### 目标
- `server.ts` 读取 hook payload 的 `session_id`，传入 `enqueueDistillJob`，存入 `memory_distill_jobs.session_id`。
- `server.ts` 对 `SubagentStop` 早返回 202（不 parse/event/enqueue/broadcast），与 PostToolUse 跳过对称。
- `tick` 对同一 session 的后续 Stop job 只蒸馏 `turns.slice(lastOffset)` 的新增 turn；新增为空则跳过蒸馏（标 done，不 createCandidate、不 setSessionOffset）。
- 蒸馏成功后更新该 session 的偏移到本次 `fullLength`。
- 新表 `memory_session_offsets`（sessionId PK + lastTurnOffset + updatedAt）。
- `memory_distill_jobs` 加 `session_id` 列 + 索引。
- 无 `session_id` 的历史 job 仍全量蒸馏（向后兼容，不切片、不更新偏移）。

### 非目标
- 不清理历史重复 job/event/候选（第四轮遗留 DB 膨胀是独立 issue；本轮只止损未来）。
- 不感知 compaction（早期 turn 改写漏掉，见 §1.4）。
- 不删 SubagentStop/PostToolUse 的 hooks 安装配置（install.ts 不改；daemon 端不处理即可）。
- 不动 `parseTranscriptFile` / `distillTranscript` / `filterTranscriptForDistill` / dedup / valueFilter / 条件门（它们在新增 turn 子集上行为不变）。
- 不加 debounce 合并（Stop 频率低，增量已足够去重）。
- 不动 `memory_distill_events` 表结构（payload 仍存该 job 捕获时的全量 turns；切片在 loadTranscript 读侧做）。

## 3. 接口契约

### 3.1 server.ts hook 路由改造

`src/server.ts:62-141`。body 解析（第 63 行）增加 `session_id` 字段；PostToolUse 跳过（第 93-95 行，第四轮）之后、Stop 路径之前加 SubagentStop 跳过；Stop 路径的 `enqueueDistillJob` 调用（第 127 行）传入 `sessionId`。

```ts
const body = await c.req.json().catch(() => ({}) as {
  transcript_path?: string; cwd?: string; sourceEventId?: string; session_id?: string
})
const cwd: string = body.cwd ?? ''
const sessionId: string = body.session_id ?? ''

// SessionStart: inject ...（不动）

// PostToolUse 跳过（第四轮，不动）
if (event === 'PostToolUse') {
  return c.json({ ok: true }, 202)
}

// SubagentStop 跳过（第五轮）：transcript_path 指向主会话 JSONL（不是独立子会话），
// 与同 session 的 Stop 蒸馏同一段会话（firstUser 一致、turns 数几乎相同），纯重复。
// SubagentStop 无独有价值，早返回 202 不蒸馏。
if (event === 'SubagentStop') {
  return c.json({ ok: true }, 202)
}

// Stop 继续：parse + enqueue + store event + broadcast
// ...
const { jobId } = await deps.enqueueDistillJob(deps.db, {
  sourceEventId, runtime: 'claude-code', cwd, debounceKey, sessionId,
})
```

### 3.2 scheduler.ts enqueueDistillJob + TickDeps 改造

`src/scheduler.ts:18-36`。`EnqueueInput` 加 `sessionId?: string`；`enqueueDistillJob` 把 `sessionId` 写入 job 行（历史调用方不传则 null）。

```ts
export interface EnqueueInput {
  sourceEventId: string
  runtime: 'claude-code' | 'opencode'
  cwd: string
  debounceKey: string
  debounceMs?: number
  sessionId?: string  // 第五轮：会话键，用于增量偏移
}

export async function enqueueDistillJob(db: DbClient, input: EnqueueInput) {
  const id = ulid()
  const now = Date.now()
  const nextRunAt = now + (input.debounceMs ?? DISTILL_DEBOUNCE_MS)
  await db.insert(memoryDistillJobs).values({
    id, debounceKey: input.debounceKey, sourceEventId: input.sourceEventId,
    runtime: input.runtime, cwd: input.cwd, sessionId: input.sessionId ?? null,
    status: 'pending', attempts: 0, nextRunAt, createdAt: now, finishedAt: null,
  })
  return { jobId: id, nextRunAt }
}
```

`TickDeps.loadTranscript` 签名变更（第 39 行）：job 入参加 `sessionId`，返回值从 `TranscriptTurn[]` 改为 `{ turns: TranscriptTurn[]; fullLength: number }`。

```ts
export interface TickDeps {
  loadTranscript: (job: {
    id: string; cwd: string | null; sourceEventId: string; sessionId: string | null
  }) => Promise<{ turns: TranscriptTurn[]; fullLength: number }>
  callLLM: LLMCall
  createCandidate: (db: DbClient, input: MemoryInput) => Promise<Memory>
}
```

### 3.3 tick 改造（增量切片 + 跳过 + 偏移更新）

`src/scheduler.ts:105-176`。`tick` 内 loadTranscript 调用（第 119 行）改为解构 `{ turns: newTurns, fullLength }` 并传 `sessionId`；新增为空则跳过蒸馏；蒸馏成功后更新偏移。

```ts
const { turns: newTurns, fullLength } = await deps.loadTranscript({
  id: job.id, cwd: job.cwd, sourceEventId: job.sourceEventId, sessionId: job.sessionId ?? null,
})
// 增量切片后无新增 turn：该 session 自上次蒸馏后无新内容，跳过蒸馏。
// 标 done（消费 job），不 createCandidate、不 setSessionOffset（偏移不变）。
if (newTurns.length === 0) {
  await db.update(memoryDistillJobs).set({ status: 'done', finishedAt: Date.now() })
    .where(eq(memoryDistillJobs.id, job.id)).run()
  processed += 1
  continue
}
const candidates: DistillCandidate[] = await distillTranscript({
  turns: newTurns,  // 只喂新增 turn，不再全量
  runtime: job.runtime as 'claude-code' | 'opencode',
  cwd: job.cwd ?? '',
  callLLM: deps.callLLM,
})
// ... dedupCandidates / judgeValue / createCandidate 不变 ...
await db.update(memoryDistillJobs).set({ status: 'done', finishedAt: Date.now() })
  .where(eq(memoryDistillJobs.id, job.id)).run()
// 增量偏移更新（第五轮）：本次蒸馏到 fullLength，下次该 session 从此处切。
// 仅 job 有 sessionId 时更新；无 sessionId（历史 job）不更新，保持全量向后兼容。
if (job.sessionId) {
  try { await setSessionOffset(db, job.sessionId, fullLength) }
  catch (e) { console.warn('memside: setSessionOffset failed', e) }  // 不阻塞 job done
}
processed += 1
```

### 3.4 daemon.ts makeLoadTranscript 改造（读侧切片）

`src/daemon.ts:30-44`。解析全量 turns 后，若 job 有 sessionId 则查偏移、切片返回；返回 `{ turns, fullLength }`。无 sessionId 则全量返回（向后兼容）。

```ts
export function makeLoadTranscript(db: DbClient): TickDeps['loadTranscript'] {
  return async (job) => {
    const rows = await db.select().from(memoryDistillEvents)
      .where(eq(memoryDistillEvents.distillJobId, job.id))
      .orderBy(memoryDistillEvents.ts)
    const turns: TranscriptTurn[] = []
    for (const r of rows) {
      try {
        const parsed = JSON.parse(r.payload)
        if (Array.isArray(parsed)) for (const t of parsed) turns.push(t as TranscriptTurn)
      } catch { /* skip malformed payload */ }
    }
    const fullLength = turns.length
    if (!job.sessionId) return { turns, fullLength }  // 历史 job：全量，向后兼容
    let offset = 0
    try { offset = await getSessionOffset(db, job.sessionId) }
    catch (e) { console.warn('memside: getSessionOffset failed, degrading to full', e); return { turns, fullLength } }
    return { turns: turns.slice(offset), fullLength }
  }
}
```

### 3.5 store.ts 偏移读写

`src/memory/store.ts` 新增两个函数。`getSessionOffset` 无记录返回 0（首次蒸馏 = 全量）；`setSessionOffset` UPSERT（同 sessionId 二次写覆盖）。

```ts
export async function getSessionOffset(db: DbClient, sessionId: string): Promise<number> {
  const rows = await db.select().from(memorySessionOffsets)
    .where(eq(memorySessionOffsets.sessionId, sessionId)).limit(1)
  return rows.length > 0 ? (rows[0]!.lastTurnOffset as number) : 0
}

export async function setSessionOffset(db: DbClient, sessionId: string, offset: number): Promise<void> {
  const now = Date.now()
  await db.insert(memorySessionOffsets).values({ sessionId, lastTurnOffset: offset, updatedAt: now })
    .onConflictDoUpdate({ target: memorySessionOffsets.sessionId, set: { lastTurnOffset: offset, updatedAt: now } })
}
```

## 4. 数据流与不变量

### 4.1 增量蒸馏数据流（同一 session 多次 Stop）

```
会话 S 第一次 Stop（transcript 36 turns）
  -> server.ts 读 session_id=S，enqueue job(S, sessionId=S)
  -> tick: loadTranscript(job) 查 offset(S)=0，返回 {turns: 全 36, fullLength:36}
  -> newTurns=36 非空 -> distillTranscript(36 turns) -> 候选
  -> job done -> setSessionOffset(S, 36)

会话 S 第二次 Stop（transcript 120 turns，前 36 是旧前缀）
  -> server.ts enqueue job(S', sessionId=S)
  -> tick: loadTranscript(job) 查 offset(S)=36，返回 {turns: 后 84, fullLength:120}
  -> newTurns=84 非空 -> distillTranscript(84 turns) 只蒸馏新增
  -> job done -> setSessionOffset(S, 120)

会话 S 第三次 Stop（transcript 仍 120 turns，无新增）
  -> tick: loadTranscript 查 offset(S)=120，返回 {turns: [], fullLength:120}
  -> newTurns=0 -> 跳过蒸馏，标 done，不更新偏移
```

### 4.2 不变量
- **偏移单调不减**：`setSessionOffset(S, n)` 的 n 只随会话推进增大（transcript 累积）。compaction 改写早期 turn 不影响 fullLength（仍是文件总 turn 数），故偏移不会倒退。
- **跳过不更新偏移**：newTurns 为空时偏移不变，避免无意义写。
- **无 sessionId 全量**：历史 job（第四轮及之前，session_id 列 null）走全量路径，不切片、不更新偏移——与旧行为一致，向后兼容。
- **偏移读写失败不阻塞蒸馏**：getSessionOffset 失败降级全量；setSessionOffset 失败只 warn、job 仍 done。偏移是优化，不是正确性依赖。
- **event payload 仍存全量**：`memory_distill_events.payload` 存该 job 捕获时的全量 turns（server.ts:133 不变）；切片在 loadTranscript 读侧做。重试同一 job 时偏移可能已推进，但重试是异常路径，可接受。

## 5. 与现有模块的耦合点

| 模块 | 耦合点 | 影响 |
|---|---|---|
| `src/server.ts` | body 解析(63)、SubagentStop 跳过(新增)、enqueue 调用(127) | 加 session_id 读取 + SubagentStop 早返回 + 传 sessionId |
| `src/scheduler.ts` | EnqueueInput(18)、enqueueDistillJob(26)、TickDeps.loadTranscript(39)、tick(119,163) | 加 sessionId 字段/列、签名变更、切片/跳过/偏移更新 |
| `src/daemon.ts` | makeLoadTranscript(30) | 切片逻辑 + 返回 {turns, fullLength} |
| `src/memory/store.ts` | 新增 getSessionOffset/setSessionOffset | 纯加法，不动现有函数 |
| `src/db/schema.ts` | memoryDistillJobs(38)、新增 memorySessionOffsets | 加 session_id 列 + 新表 |
| `src/db/client.ts` | DDL(40-53)、migration 块(75-93) | 加 session_id 列 DDL + 新表 DDL + 幂等迁移 |
| `src/claude/transcript.ts` | parseTranscriptFile | **不动**（仍解析全量，切片在 loadTranscript） |
| `src/memory/distiller.ts` | distillTranscript | **不动**（在新增 turn 子集上行为不变） |
| `src/memory/dedup.ts` / `valueFilter.ts` / `pure.ts` | | **不动**（前三轮修复全保留） |
| `tests/scheduler.test.ts` | mock loadTranscript | 签名变更波及：mock 返回值改 {turns, fullLength} |
| `tests/server.test.ts` | PostToolUse 跳过测试 | 不动；新增 SubagentStop 跳过 + session_id 测试 |

**关键风险**：`loadTranscript` 签名变更（返回 `{turns, fullLength}`）波及所有 mock。已确认 `tick` 是唯一调用方、`makeLoadTranscript` 是唯一实现；`tests/scheduler.test.ts` 的 mock loadTranscript 须同步改返回值。

## 6. 测试策略

本轮触及 schema + server + daemon + scheduler + store 五处，是五轮里最大的一轮。纯函数层写足，运行时层留集成断言。每个新测试顶端注释写"为什么这条测试存在"（链接第五轮根因：Stop 累积重复蒸馏）。

### 6.1 store 偏移读写（纯函数层）
- `getSessionOffset` 无记录返回 0（首次蒸馏 = 全量）。
- `setSessionOffset` UPSERT：同 sessionId 二次写覆盖；`getSessionOffset(setSessionOffset(id,5))` === 5。

### 6.2 loadTranscript 切片（daemon.test.ts 或 scheduler.test.ts）
- mock event payload 存全量 10 turn，session offset=4 -> 返回 {turns:6, fullLength:10}。
- offset=0 -> {turns:10, fullLength:10}。
- offset=10 -> {turns:0, fullLength:10}（空，tick 应跳过）。
- 无 sessionId -> {turns:全部, fullLength}（向后兼容，不切片）。

### 6.3 tick 增量行为（scheduler.test.ts）
- newTurns=0 -> 标 done、不 distill、不 createCandidate、不 setSessionOffset。
- 蒸馏成功 + job 有 sessionId -> setSessionOffset 被调用，入参 fullLength。
- job 无 sessionId -> 全量蒸馏、不调 setSessionOffset（向后兼容）。
- setSessionOffset throw -> job 仍 done（warn，不阻塞）。
- getSessionOffset throw（loadTranscript 内）-> 降级全量返回。

### 6.4 server 路由（server.test.ts）
- SubagentStop 跳过：返回 202、不存 event、不 enqueue、不 broadcast（与 PostToolUse 跳过测试对称）。
- Stop 带 session_id -> enqueueDistillJob 入参含 sessionId（mock 断言）。
- Stop 无 session_id -> sessionId 为空串/不传（向后兼容）。

### 6.5 schema 迁移（schema.test.ts 或 client.test.ts）
- 新表 memory_session_offsets 存在 + 列正确（sessionId PK、lastTurnOffset、updatedAt）。
- memory_distill_jobs 含 session_id 列 + 索引。
- 迁移幂等：openDb 运行两次不报错；已有 DB（无 session_id 列）升级后列存在。

### 6.6 e2e 增量端到端（scheduler.test.ts）
- 同一 session 两次 Stop job（第二次 transcript 是第一次的超集）-> 第一次蒸馏全量、第二次只蒸馏新增、偏移更新正确。
- 第二次 Stop 无新增（transcript 相同）-> 跳过蒸馏、createCalls=0、偏移不变。

### 6.7 回归保护
- 前四轮测试全绿不回退：PostToolUse 跳过（第四轮）、条件门/dedup bodyMd（第二轮）、subject 驱动（第三轮）、valueFilter 中性（第一轮）。
- `bun run typecheck && bun test` 全绿才能 push。

## 7. 验收清单

- [ ] `server.ts` 读取 `session_id` 并传入 `enqueueDistillJob`。
- [ ] `server.ts` SubagentStop 早返回 202（不 parse/event/enqueue/broadcast）。
- [ ] `memory_distill_jobs` 加 `session_id` 列 + 索引；迁移幂等。
- [ ] 新表 `memory_session_offsets`（sessionId PK + lastTurnOffset + updatedAt）。
- [ ] `getSessionOffset`/`setSessionOffset` 实现且单测绿。
- [ ] `loadTranscript` 返回 `{turns, fullLength}`，按 offset 切片；无 sessionId 全量。
- [ ] `tick` 对 newTurns=0 跳过蒸馏（标 done）；蒸馏成功后 setSessionOffset（有 sessionId 时）。
- [ ] 偏移读写失败不阻塞蒸馏（降级全量 / warn 不阻塞 done）。
- [ ] 同 session 第二次 Stop 只蒸馏新增 turn（e2e 绿）。
- [ ] 无 sessionId 历史 job 全量蒸馏（向后兼容）。
- [ ] `bun run typecheck && bun test` 全绿。
- [ ] 前四轮测试不回退。
- [ ] 分支 `feat/memory-quality-fix5`（从最新 `origin/master` 切出），PR 目标 `master`。

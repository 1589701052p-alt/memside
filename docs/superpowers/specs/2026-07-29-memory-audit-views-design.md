# 记忆审计视图（已审批 / 已拒绝 / AI自动拒绝）- 设计 spec

分支：`feat/memory-audit-views`（基线 `origin/master`）
日期：2026-07-29
状态：设计待审

## 背景

memside 的 Web UI 目前只展示 `status='candidate'` 的候选记忆（`src/web/App.tsx:79` 客户端过滤）。`GET /api/memories`（`src/server.ts:221-224`）其实已返回**全部状态**的记忆，但 UI 把 approved / rejected / archived / superseded 都丢弃不显示。而 AI 自动拒绝（valueFilter 在候选入库前丢弃的 public-knowledge / derivable / taming）写进独立的 `memory_discards` 表（`src/db/schema.ts:84-99`），**没有任何 HTTP API**，UI 完全看不到。

用户无法回看自己审批过什么、拒绝过什么、AI 帮自己挡掉了什么--记忆闭环只露出「待审」这一面。本需求补齐「审批后/拒绝后」的可视面，并给三类记忆各加最小操作能力。

## 目标

- Web UI 顶部 4 个 tab：候选审批（现有）/ 已审批 / 已拒绝 / AI自动拒绝。
- 已审批视图含 approved + archived + superseded，徽标区分。
- 已审批可归档/取消归档；已拒绝可撤回（拉回候选）；AI自动拒绝可提升为候选。
- AI自动拒绝的来源（scope/runtime/sourceKind）在丢弃时就存好，提升路径自包含。

## 非目标

- 不做分页 / 无限滚动（数据量小，YAGNI；`/api/discards` LIMIT 200 截断足够）。
- 不做服务端按视图分别停轮询的优化（四个 tab 同 3s 频率）。
- 不删 discard 审计行（提升一条不代表该次自动拒绝没发生过）。
- superseded 不开「撤回」（被取代意味已被新版本顶替，撤回旧版会破坏版本链）。
- 不反查 job 回填历史 discard 的 scope（job 可能已被未来清理债务删掉；YAGNI）。
- 不把 discards 塞进 `/api/memories` 合成行（字段形状不同，硬套有损且混淆语义）。

## 接口契约与数据流

### 读取面（列表 API）

**`GET /api/memories` 泛化为服务端 status 过滤（方案 B）：**

- 新增 query 参数 `status`，逗号分隔，值取自 `MemoryStatus`（`candidate`/`approved`/`archived`/`superseded`/`rejected`）之一或多选。
- 不带 `status` 时**保持现状**：返回全部记忆（createdAt DESC）。向后兼容老调用方。
- 非法 status 值宽松忽略（只取合法值），不返回 400。
- 实现位于 `src/server.ts:221-224` 现有 handler 内，加 query 解析 + `inArray(memories.status, …)` 过滤；无 `status` 时不加 where 子句（全量，与现状逐字节一致）。

**`GET /api/discards`（新端点）：**

- `SELECT … FROM memory_discards ORDER BY ts DESC LIMIT 200`。
- 返回 `{ items: DiscardRow[] }`，每行含新加的 scope/source 列（见「数据库迁移」）+ `promoted_memory_id`（非 null 即已提升）。
- 空表返回 `{items:[]}`，不报错。

**四个视图各自的查询：**

| 视图 | 端点 / status | 来源表 |
|------|---------------|--------|
| 候选审批 | `/api/memories?status=candidate` | memories |
| 已审批 | `/api/memories?status=approved,archived,superseded` | memories |
| 已拒绝 | `/api/memories?status=rejected` | memories |
| AI自动拒绝 | `/api/discards` | memory_discards |

**`GET /api/status` 扩展：** 在现有 `memories`（按 status 分桶）基础上，加一个 `discards: number`（`SELECT count(*) FROM memory_discards`），供 tab 计数徽标。

### 状态机与写路径变更

**现有状态机**（`src/memory/pure.ts:153-159` `TRANSITIONS`）：

```
candidate -> approved | rejected
approved  -> archived | superseded
archived  -> approved
superseded-> []   (终态，不动)
rejected  -> []   (终态)
```

**新增转换 `rejected -> candidate`**（撤回拒绝）。唯一动状态机之处。`canTransition('rejected','candidate')` 改为 true。superseded 保持终态。

**四个写端点：**

| 端点 | store 函数 | 状态机 | 现状 |
|------|-----------|--------|------|
| `POST /api/memories/:id/archive` | `archiveMemory` | approved->archived | store 已存在，**只缺路由** |
| `POST /api/memories/:id/unarchive` | `unarchiveMemory` | archived->approved | 同上 |
| `POST /api/memories/:id/restore` | `restoreMemory`（新增） | rejected->candidate | 新 store + 路由 |
| `POST /api/discards/:id/promote` | `promoteDiscard`（新增） | discard->candidate | 新 store + 路由 |

**`restoreMemory` 设计**（照 `unarchiveMemory` 的 specific-source guard 模式，`src/memory/store.ts:356-369`）：

```ts
export async function restoreMemory(db: DbClient, id: string): Promise<Memory> {
  return db.transaction((tx) => {
    const rows = tx.select().from(memories).where(eq(memories.id, id)).limit(1).all()
    if (rows.length === 0) throw new MemoryNotFoundError(`memory ${id} not found`)
    // Specific-source guard (I3): restore must only accept status === 'rejected'.
    if (rows[0]!.status !== 'rejected') {
      throw new MemoryConflictError(`memory ${id} is '${rows[0]!.status}', not 'rejected'`)
    }
    tx.update(memories).set({ status: 'candidate', approvedAt: null }).where(eq(memories.id, id)).run()
    return rowToMemory(tx.select().from(memories).where(eq(memories.id, id)).limit(1).all()[0]!)
  })
}
```

回到 candidate 时清掉 `approvedAt`（归位干净）。version 不动（非内容变更）。

**`promoteDiscard` 设计：**

- 从 `memory_discards` 读行，用其存好的 scope/source 字段走 `createCandidate`（sourceKind 用记录里的值，distillJobId 透传），产出 candidate。
- **不删 discard 行**（审计保留）。提升后回填 `promoted_memory_id` = 新 candidate.id。
- 幂等保护：`promoted_memory_id` 非 null 时直接抛 `MemoryConflictError`（-> 409「已提升」）。
- 老行（迁移前产生，scope 字段全 NULL）scopeType 缺失 -> 抛 `MemoryConflictError`（-> 409「该 AI 拒绝记录缺少来源信息，无法提升」）。不反查 job 回填。
- 单事务：读 discard -> createCandidate -> 回填 promoted_memory_id。

### 数据库迁移（discards 加 scope/source 列）

`memory_discards` 现有列：`id/distillJobId/title/bodyMd/reason/ts`。新增 6 个 **nullable** 列，`ALTER TABLE ADD COLUMN` 幂等迁移（无需表重建，与 `source_cwd`/`source_agent_id` 那批同模式）：

| 列 | 类型 | 来源（scheduler.ts:171-176 构造 discarded 时填） |
|----|------|---------------------------------------------------|
| `scope_type` | text (`project`\|`global`) | `cand.scopeType` |
| `scope_id` | text | `resolveScopeId(scopeType, job.cwd)`（project->cwd，global->null） |
| `source_cwd` | text | `job.cwd` |
| `runtime` | text (`claude-code`\|`opencode`) | `k.cand.runtime` |
| `source_kind` | text (`conversation`\|`subagent`) | `job.sourceAgentId ? 'subagent' : 'conversation'` |
| `promoted_memory_id` | text | 提升 success 后回填 candidate.id，初始 null |

**迁移位置**：`src/db/client.ts` 现有迁移段，加一段幂等 `ALTER TABLE memory_discards ADD COLUMN …`（包 try/catch，列已存在则跳过）。

**`logDiscards` 改动**（`src/memory/store.ts:382-394`）：`DiscardRecord` 接口扩字段；scheduler.ts:171 构造时填入上述 scope/source（scheduler tick 上下文已有 `job.cwd`/`job.runtime`/`job.sourceAgentId`/`k.cand.scopeType`/`k.cand.runtime`，全部可得，无需新查询）。

**`schema.ts`**：`memoryDiscards` drizzle 定义同步加列。新列无需索引（discards 查询走 `ORDER BY ts`，已有 `idx_discards_ts`）。

### Web UI 布局与组件

**顶部 4-tab 切换**（不用路由，单页无路由库，引入属过度工程）：

```
memside · 记忆
─────────────────────────────────
[ 候选审批(N) ] [ 已审批(N) ] [ 已拒绝(N) ] [ AI自动拒绝(N) ]
─────────────────────────────────
<状态栏>（后台可见性，保持不动）
─────────────────────────────────
<当前 tab 的列表>
```

**各 tab 数据 + 操作：**

| Tab | 拉取 | 卡片操作 |
|-----|------|----------|
| 候选审批 | `/api/memories?status=candidate` + `/api/status` | 批准/拒绝/编辑/查看原始输入（现有，不动） |
| 已审批 | `/api/memories?status=approved,archived,superseded` | 归档/取消归档（approved↔archived）；superseded 只读标注「已被取代」 |
| 已拒绝 | `/api/memories?status=rejected` | 撤回拒绝(restore) |
| AI自动拒绝 | `/api/discards` | 提升为候选(promote)；已提升标注「已提升」并禁用按钮 |

**复用既有 chrome（CLAUDE.md 强制）：**

- tab 栏用 `App.tsx` 现有 inline style 风格（灰底圆角、`#f5f5f5`），不引新框架。
- `MemoryCard` 抽通用展示骨架，操作按钮按 tab 注入。discards 卡片形状不同（有 reason 徽标、无 tags/version/slug），单独轻量 `DiscardCard`，各自聚焦（避免单文件职责过载）。

**状态可见性（CLAUDE.md「不得静默 stall」）：**

- 切 tab 立即显示「加载中…」；fetch 失败显错误横幅（复用现有 error banner 逻辑）。
- tab 标题带计数徽标（N），计数来自 `/api/status` 的 memories 分桶 + 新增 discards 计数。
- 空列表显文案（如「暂无已审批记忆」），不留白页。

**轮询：** 当前 tab 轮询其对应端点，3s（与现有一致）。切 tab 清旧 interval 建新的。候选 tab 仍同时轮询 status。

## 错误处理

| 场景 | 行为 |
|------|------|
| `restore` 非 rejected 行 | `MemoryConflictError` -> 409 `{error}` |
| `restore` 不存在 id | `MemoryNotFoundError` -> 404 |
| `promoteDiscard` 已提升（promoted_memory_id 非 null） | `MemoryConflictError` -> 409「已提升」 |
| `promoteDiscard` 老行 scope 缺失 | `MemoryConflictError` -> 409「缺少来源信息」 |
| `promoteDiscard` id 不存在 | 404 |
| `archive/unarchive` 状态不符 | 现有 `MemoryConflictError` -> 409（store 已有，路由透传） |
| `/api/discards` 空表 | `{items:[]}`，不报错 |
| `GET /api/memories?status=非法值` | 忽略非法值（只取合法 status），不 400 |

所有写端点 success 后 `broadcast` WS 事件（与现有 promote/patch 一致，`src/server.ts:259/270/284`），UI 轮询兜底。WS 事件类型：`memory.restored` / `memory.archived` / `memory.unarchived` / `discard.promoted`。

## 测试策略

CLAUDE.md：纯函数层足测 + 运行时少量集成断言。

1. **`pure-statemachine.test.ts`**：新增 `canTransition('rejected','candidate') === true` 断言（锁状态机回归）。
2. **`store-restore.test.ts`（新）**：`restoreMemory` 正向（rejected->candidate + approvedAt 清空）、状态不符 409、not found 404。
3. **`store-discard.test.ts`（新）**：`promoteDiscard` 正向（discard->candidate + scope 透传 + promoted_memory_id 回填）、重复提升 409、老行 scope 缺失 409、not found 404、`logDiscards` 写入新 scope/source 字段。
4. **`server.test.ts`**：`GET /api/memories?status=approved,archived` 过滤正确；不带 status 全量；`GET /api/discards` 返回 + 空表；`GET /api/status` 含 discards 计数；四个写端点的 200/409/404。
5. **`schema.test.ts`**：迁移幂等（重复 openDb 不报错）+ discards 新列存在。
6. **`web-api.test.ts`**：`listMemories(status)` 透传 query；`listDiscards`；`restoreMemory`/`promoteDiscard`/`archiveMemory`/`unarchiveMemory` client wrapper。
7. **`web-ui.test.ts`**：tab 切换渲染对应列表（源码层文本断言兜底，如 tab 标题「已审批」「AI自动拒绝」可见）。
8. **回归**：现有 store-promote / e2e / candidate 审批流不动，确认仍绿。

运行门槛：`bun run typecheck && bun test` 全绿才 push。

## 与现有模块的耦合点

- `src/memory/pure.ts:153-159` `TRANSITIONS`：加 `rejected: ['candidate']`。
- `src/memory/store.ts`：新增 `restoreMemory`、`promoteDiscard`；扩 `DiscardRecord` + `logDiscards`；`rowToMemory` 不动（memories 表无新列）。
- `src/db/schema.ts:84-99` `memoryDiscards`：加 6 列。
- `src/db/client.ts`：迁移段加 discards ALTER。
- `src/scheduler.ts:166-176`：构造 `discarded` 时填 scope/source 字段。
- `src/server.ts:221-224`：`GET /api/memories` 加 status 过滤；`/api/status` 加 discards 计数；新 4 个写路由 + `GET /api/discards`。
- `src/web/api.ts`：`listMemories(status?)`；新增 `listDiscards`/`restoreMemory`/`promoteDiscard`/`archiveMemory`/`unarchiveMemory`。
- `src/web/App.tsx`：4-tab 布局 + `DiscardCard` + 切 tab 轮询。

## 失败模式

- **迁移在旧库失败**：`ALTER TABLE ADD COLUMN` 对已存在列报错 -> try/catch 跳过（幂等，与现有迁移同模式）。迁移从不阻塞 daemon 启动。
- **promoteDiscard 老行无 scope**：明确 409 + 文案，UI 提示用户该条无法提升（历史数据，不回填）。
- **discards 表膨胀**：LIMIT 200 截断列表响应；表本身无 TTL 是既有债务（STATE.md 2026-07-23 审计第 1 项），本需求不解决，仅记。
- **切 tab 轮询泄漏**：切 tab 必须清旧 interval，否则多 tab 并发轮询（实现注意点，测试 #7 间接覆盖）。
- **状态机扩展破坏现有终态语义**：`rejected->candidate` 是回环（candidate 可再 rejected），不引入新终态；superseded 仍终态。`canTransition` 单测锁住。

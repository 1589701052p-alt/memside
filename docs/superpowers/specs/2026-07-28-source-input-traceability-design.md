# 记忆原始输入溯源（source-input traceability）- 设计 spec

日期：2026-07-28
分支：`feat/source-input-traceability`
状态：设计已与用户逐段确认通过，待用户复核 spec 文件。

## 1. 背景

memside 的闭环是 capture -> distill -> approve -> inject。用户在 Web UI 审批候选记忆时，
只能看到 distiller 产出的 `title` / `bodyMd`，看不到「这条记忆是从哪段会话提炼出来的」。
用户需要更透明的调试手段：对每条记忆，能直接看到**产生这一条记忆的原始输入内容**，从而
判断 distiller 提炼得对不对、该不该批。

### 关键现状（摸底结论）

1. **原始输入其实已存在数据库里。** 每条记忆有 `distill_job_id`（蒸馏它的那次任务），那次
   任务捕获的会话 transcript 存在 `memory_distill_events.payload`（JSON 序列化的
   `TranscriptTurn[]`）。
2. **distiller 喂模型前过滤过一道。** `filterTranscriptForDistill`（`src/memory/pure.ts`，
   纯函数）对原始 turns 做了压缩截断：文件类工具结果压成一行占位、超长截断、按 token 预算
   裁剪。即「存数据库的原始版」≠「模型实际看到的过滤版」。
3. **events 存完整 transcript 且从不清理**是 STATE.md 已知债务第 1 项，未来可能改成只存摘要。
   依赖 events.payload 会让本功能被该债务牵连。

## 2. 目标 / 非目标

### 目标

- 对每条记忆（候选 / 已审批 / 已归档，只要有快照），在 Web UI 上能一键查看「蒸馏时喂给
  模型的过滤版 transcript」。
- 快照忠实：存的就是当时发给模型的，不受未来过滤参数改动影响、不依赖 events 清理节奏。
- 大内容能容纳：过滤版虽已压缩截断但仍是成段对话，展示方式要能滚动容纳。
- 状态可见：加载 / 失败 / 无快照都有明确反馈，不静默 stall。

### 非目标（YAGNI）

- ❌ 存量回填。已审批/已存档的历史记忆没有「蒸馏当时过滤版」的可靠来源（events.payload 若
  在能算，但过滤参数若变过就不准；回填会撒谎，不如不填）。这些记忆的「查看原始输入」按钮
  对无快照者显示 `available:false`，遮罩层提示「该记忆无原始输入快照」。
- ❌ 完整原始版 / 两版切换。本轮只展示过滤版。
- ❌ 全文搜索 / 复制导出。遮罩层是只读展示。
- ❌ WS 推送快照写入。快照是异步副产物，审批时已就绪，不需实时。
- ❌ 快照 TTL / 清理。独立债务，本轮不碰，留 STATE.md 已知债务第 1 项统一处理。
- ❌ 按记忆 status 差别对待。只要有快照就能看，不看 status。

## 3. 用户确认的关键决策

| 决策 | 选项 | 用户选定 |
|------|------|----------|
| 看哪一版 transcript | 过滤版 / 完整原始版 / 两版可切换 | **过滤版**（最贴「为什么产生这条记忆」，且已压缩截断、体积有界） |
| 怎么存/取 | 蒸馏时快照存下 / 请求时按需重算 | **蒸馏时快照存下**（所见即当时所发、与 events 清理债务解耦） |
| UI 怎么摆 | 卡片内联展开 / 弹出遮罩层 / 跳转详情页 | **弹出遮罩层**（空间足、大内容能滚、不挤卡片） |
| 存储结构 | 副表按 job / memories 加列 / 存渲染后 prompt 串 | **副表按 job**（不重复、列表不受影响、可按 role 排版） |

## 4. 架构与数据流

### 写入侧（蒸馏时快照）

1. `distillTranscript`（`src/memory/distiller.ts`）现内部已算
   `filtered = filterTranscriptForDistill(turns)`，但只返回 `candidates`。改为同时返回它
   实际喂给模型的 `filteredTurns`（保证快照 = 当时所发，零偏差）。
2. `scheduler.tick` 拿到 `{ candidates, filteredTurns }` 后，走完 dedup -> judgeValue ->
   createCandidate；**当至少有一条候选入库时**，把 `filteredTurns` 以 `job.id` 为键
   UPSERT 进 `memory_distill_inputs`。写失败只 warn、不阻塞蒸馏（与 `logDiscards` 同级
   best-effort）。
3. job 重试会重新蒸馏并 UPSERT 覆盖同一行，不产生重复。

### 读取侧（懒加载）

4. UI 卡片新增「查看原始输入」按钮（仅 `distillJobId` 非空的记忆显示；手动记忆不显示）。
5. 点击 -> `GET /api/memories/:id/source-input` -> 后端取 memory 的 `distill_job_id` ->
   查 `memory_distill_inputs` -> 返回过滤 turns + memory 摘要（标题/body）。
6. 遮罩层顶部展示 memory 标题/body + 说明「蒸馏时喂给模型的过滤版（文件类工具已压缩、超长
   已截断）」，下方按 role 渲染 turns，近全屏可滚，ESC/× 关闭。

### 为什么不塞进列表接口

`GET /api/memories` 每 3s 轮询。带 turns 会让列表响应膨胀到 MB 级、拖垮轮询。原始输入走
专用懒加载端点，点开才拉。

## 5. 数据模型

### 新表 `memory_distill_inputs`（`src/db/schema.ts`）

| 列 | 类型 | 说明 |
|----|------|------|
| `distill_job_id` | TEXT PRIMARY KEY | 一个 job 一份快照 |
| `turns_json` | TEXT NOT NULL | `filterTranscriptForDistill` 输出的 `TranscriptTurn[]` JSON |
| `turn_count` | INTEGER NOT NULL | 遮罩层头「N turn」展示用，免去前端反序列化计数 |
| `char_count` | INTEGER NOT NULL | 头部「约 N 字」展示用 |
| `ts` | INTEGER NOT NULL | 写入时间 |

**不加 FK 指回 `memory_distill_jobs`。** 理由：`memory_distill_jobs` 未来要加清理/TTL（STATE.md
已知债务第 1 项），FK CASCADE 会让快照随 job 一起被删，而审批可能滞后于清理。用
`distill_job_id` 做逻辑键、靠应用层查询，解耦清理节奏。`memories.distill_job_id` 本就是普通
列无 FK，保持一致。

### 迁移（`src/db/client.ts`）

套用现有幂等 `CREATE TABLE IF NOT EXISTS` 风格：

```sql
CREATE TABLE IF NOT EXISTS memory_distill_inputs (
  distill_job_id TEXT PRIMARY KEY,
  turns_json     TEXT NOT NULL,
  turn_count     INTEGER NOT NULL,
  char_count     INTEGER NOT NULL,
  ts             INTEGER NOT NULL
);
```

幂等、无列增删，老 DB 升级零风险。需同步在 `openDb` 的 drizzle schema 注册对象 +
`raw.exec` DDL 块加表。

### 存量回填

**不做。** 见 §2 非目标。无快照的记忆 -> 端点 `available:false`。

### 读函数（`src/memory/store.ts`）

```ts
getSourceInput(db, distillJobId): { turns: TranscriptTurn[]; turnCount: number; charCount: number } | null
```

取行 -> `turns_json` 反序列化（失败返回 null，遮罩层显示「无法加载原始输入」）。

## 6. 写入侧实现细节

### `distillTranscript` 返回值变更（`src/memory/distiller.ts`）

```ts
export interface DistillResult {
  candidates: DistillCandidate[]
  filteredTurns: TranscriptTurn[]   // 实际喂给模型的过滤版，零偏差快照源
}
export async function distillTranscript(input: DistillInput): Promise<DistillResult>
```

- `filteredTurns` 来自函数内部已有的 `const filtered = filterTranscriptForDistill(input.turns)`。
  之前没 return，现在 return 出来，保证快照 = 当时所发。
- 空转（无候选）时 `filteredTurns` 仍是这次喂的过滤 turns，但 tick 只在「有候选入库」时才落
  快照（见下），所以空转不会写无主快照。
- 失败降级（catch 吞错）返回 `{ candidates: [], filteredTurns: [] }`，与现在「返回 `[]`」语义一致。
- 新转 turn 数为 0 的早期分支：tick 里 `newTurns.length === 0` 直接 `continue`，根本不调
  distillTranscript，不涉及。

### `tick` 的 best-effort 写入（`src/scheduler.ts`）

`distillTranscript` 调用点解构：
```ts
const { candidates, filteredTurns } = await distillTranscript({...})
```
在「`keepWithClass` 入库循环之后、`status='done'` 之前」，当 `keepWithClass.length > 0` 时：

```ts
if (keepWithClass.length > 0) {
  try {
    await saveSourceInput(db, job.id, filteredTurns)   // UPSERT
  } catch (e) { console.warn('memside: saveSourceInput failed', e) }
}
```

- **best-effort**：失败只 warn、不重试、不阻塞 done，与 `logDiscards`/`setSessionOffset` 同级。
- **仅当有候选入库才写**：避免给「0 候选」的 job 落无主快照（没人会看）。dedup 全杀 /
  valueFilter 全弃时，没有候选入库，自然不写。
- **UPSERT 覆盖**：job 重试会重新蒸馏再写，`onConflictDoUpdate` 覆盖旧行，无重复。

### `saveSourceInput`（`src/memory/store.ts`）

```ts
export async function saveSourceInput(
  db: DbClient, distillJobId: string, turns: TranscriptTurn[]
): Promise<void> {
  const turnsJson = JSON.stringify(turns)
  const turnCount = turns.length
  const charCount = turns.reduce((s, t) => s + t.content.length, 0)
  const now = Date.now()
  await db.insert(memoryDistillInputs).values({
    distillJobId, turnsJson, turnCount, charCount, ts: now,
  }).onConflictDoUpdate({
    target: memoryDistillInputs.distillJobId,
    set: { turnsJson, turnCount, charCount, ts: now },
  })
}
```

## 7. 读取侧 + 遮罩层 UI

### 新 API 路由（`src/server.ts`）

```
GET /api/memories/:id/source-input
```

逻辑：
1. `getMemoryById(db, id)` -> 404 若记忆不存在。
2. 取 `memory.distillJobId`；为 null（手动记忆 / 历史无 job 记忆）-> 返回 `{ available: false }`。
3. `getSourceInput(db, distillJobId)` -> 无行 -> `{ available: false }`；有行 -> 返回：
```ts
{
  available: true,
  title: memory.title,
  bodyMd: memory.bodyMd,
  valueClass: memory.valueClass,
  sourceCwd: memory.sourceCwd,
  createdAt: memory.createdAt,
  turnCount: snap.turnCount,
  charCount: snap.charCount,
  turns: snap.turns,            // TranscriptTurn[] 已反序列化（getSourceInput 返回的 turns）
}
```
4. 不把 turns 塞进 `GET /api/memories` 列表（见 §4）。但列表响应需让前端拿到 `distillJobId`
   以决定是否显示「查看原始输入」按钮--`GET /api/memories` 已返回整行（含 `distill_job_id`），
   只需在 `MemoryItem` TS 类型（`src/web/api.ts`）补 `distillJobId?: string | null` 字段。

### 前端 API client（`src/web/api.ts`）

```ts
export interface SourceTurn { role: string; content: string; isError?: boolean; toolName?: string; toolInputPath?: string }
export interface SourceInput {
  available: boolean
  title?: string; bodyMd?: string; valueClass?: string|null; sourceCwd?: string|null; createdAt?: number
  turnCount?: number; charCount?: number; turns?: SourceTurn[]
}
export async function getSourceInput(id: string, fetchFn: FetchLike = fetch): Promise<SourceInput>
```

### 遮罩层组件（`src/web/App.tsx`，新增 `<SourceInputModal>`）

触发：卡片按钮区加「查看原始输入」，仅当 `m.distillJobId` 非空时显示（手动记忆不显示；历史
无快照记忆会显示但点开 `available:false` 时遮罩层显示「该记忆无原始输入快照」——比静默不显示
更可预期，也能提示存量不回填的取舍）。点开时：
1. 设置 `{ memoryId, open: true }`；`useEffect` 检测 open -> `getSourceInput(memoryId)` ->
   `loading` / `data` / `error` 三态。
2. 遮罩层：固定定位、半透明黑底、内容卡片近全屏（`max-width: 900px; max-height: 85vh;
   overflow:auto`）。
3. 头部：memory 标题 + valueClass 徽标 + 一行说明「蒸馏时喂给模型的过滤版（文件类工具已压缩、
   超长已截断）· N turn · 约 M 字」。
4. 正文：turns 按 role 分色渲染（`[user]` 蓝、`[assistant]` 黑、`[tool]` 灰、tool error 标红），
   每条 `<pre>` 保留换行、白底框。
5. 关闭：右上角 ×、点击遮罩层背景、ESC 键（三者都能关）。
6. 状态可见性（CLAUDE.md 硬规则）：加载中显示 spinner 文案；fetch 失败显示错误文案；
   `available:false` 显示「该记忆无原始输入快照」——绝不空白 stall。
7. 焦点管理：打开时聚焦遮罩层容器，关闭时焦点回到触发按钮（键盘可达）。

### 纯函数可测面（`src/web/ui-utils.ts`）

抽 `formatSourceTurn(turn)` 纯函数：turn -> `{ label: string; color: string }`（role->标签/颜色
映射），在纯函数层测。遮罩层 React 组件不单测（与现有 `MemoryCard` 策略一致，靠接线测试兜底）。

## 8. 错误处理

| 故障点 | 行为 | 依据 |
|--------|------|------|
| `saveSourceInput` 写库失败 | warn、不重试、不阻塞 done | 与 `logDiscards`/`setSessionOffset` 同级 best-effort；候选已入库，快照缺失只影响 UI 调试 |
| `getSourceInput` 反序列化失败 | 返回 null -> 端点 `available:false` | 遮罩层显示「无法加载」，不崩 |
| `GET /source-input` 记忆不存在 | 404 | 与 `GET /api/memories/:id` 一致 |
| `distillJobId` 为 null（手动/历史） | 端点 `available:false` | 不回填、不撒谎 |
| 快照行不存在（写失败/存量） | 端点 `available:false` | 同上 |
| 遮罩层 fetch 失败 | 显示错误文案 | CLAUDE.md 状态可见性：不得静默 stall |
| 遮罩层加载中 | 显示 spinner 文案 | 同上 |

## 9. 测试策略

### 核心不变式（测试锁定）

1. 快照忠实：`distillTranscript().filteredTurns === filterTranscriptForDistill(input.turns)`
   （喂给模型的 = 存的 = 展示的）。
2. 有候选才写：`tick` 后 `keepWithClass.length === 0` -> `memory_distill_inputs` 无该 job 行。
3. 写失败可吞：`saveSourceInput` 抛错 -> job 仍 `done`、候选仍入库。
4. UPSERT 幂等：同 job 重复 `saveSourceInput` -> 表中仍一行。
5. 懒加载不污染列表：`GET /api/memories` 响应不含任何 turn 内容（文本断言兜底）。

### 测试文件清单

- `tests/distiller.test.ts`（扩）：返回 `filteredTurns`、失败降级空数组。
- `tests/scheduler.test.ts`（扩）：有候选入库写快照、0 候选不写、写失败可吞。
- `tests/store.test.ts`（扩）：`saveSourceInput` insert + UPSERT 覆盖、`getSourceInput`
  命中/反序列化失败 null。
- `tests/server.test.ts`（扩）：`GET /api/memories/:id/source-input` 四态
  （available:true / available:false(无 job) / available:false(无快照) / 404）；列表响应不含
  turns（文本断言）。
- `tests/ui-utils.test.ts`（新）：`formatSourceTurn` role->标签/颜色映射。

### 运行门槛

`bun run typecheck && bun test` 必须全绿才能 push（CLAUDE.md 硬规则）。

## 10. 与现有模块的耦合点

- `src/memory/pure.ts` `filterTranscriptForDistill`：本功能复用其输出作为快照源，不改其逻辑。
- `src/memory/distiller.ts` `distillTranscript`：返回值类型变更（`DistillCandidate[]` ->
  `DistillResult`），所有调用方（`scheduler.tick` + 测试）需同步。
- `src/scheduler.ts` `tick`：新增 best-effort 写入分支；`distillTranscript` 调用解构。
- `src/db/schema.ts` + `src/db/client.ts`：新表 + DDL + drizzle 注册 + 迁移。
- `src/memory/store.ts`：`saveSourceInput` + `getSourceInput` 两个新函数。
- `src/server.ts`：新 `GET /api/memories/:id/source-input` 路由。
- `src/web/api.ts`：`getSourceInput` client + `SourceInput`/`SourceTurn` 类型。
- `src/web/App.tsx`：卡片按钮 + `<SourceInputModal>` 组件。
- `src/web/ui-utils.ts`：`formatSourceTurn` 纯函数。

## 11. 失败模式

- **快照缺失但不影响闭环**：写入失败 / 存量记忆 -> `available:false` -> 遮罩层提示，记忆候选
  照常审批、注入。最坏情况是「看不到原始输入」，不是「闭环断」。
- **快照与展示偏差**：不可能——存的就是 `distillTranscript` 内部 `filtered` 变量本身，不经
  二次加工。
- **大内容拖垮列表**：不可能——turns 走专用端点懒加载，列表接口不含 turns。
- **快照表膨胀**：过滤版已压缩截断、体积有界；且与 events 清理债务解耦（独立表，未来随
  events 清理策略一起规划，见 §2 非目标）。

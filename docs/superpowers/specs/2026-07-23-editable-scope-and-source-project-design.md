# 可编辑 scope 分类 + 标注来源项目 - 设计 spec

- 日期：2026-07-23
- 状态：Draft
- 分支：`feat/editable-scope-and-source-project`
- 相关：`docs/superpowers/specs/2026-07-21-memside-design.md`（memside 总体设计）

## 1. 背景与动机

memside 的候选记忆在审批队列里有两个用户痛点：

1. **scope 分类（global / project）完全由 AI 判定，且不可纠错。** `src/memory/distiller.ts` 的提示词让 LLM 在每个候选上输出 `"scope":"project"|"global"`，`distillTranscript` 直接采信（`o.scope === 'global' ? 'global' : 'project'`）。LLM 偶尔判错——例如把一条只对当前仓库成立的约定判成 global，或把一条通用约定判成 project。而 Web UI 的编辑表单（`src/web/App.tsx` 的 `MemoryCard` 编辑模式）只允许改 `title`/`bodyMd`，web API 客户端 `src/web/api.ts` 的 `patchMemory` 类型也未声明 scope 字段。用户没有纠错入口。

2. **来源项目信息丢失。** `src/scheduler.ts` 的 `tick` 在落候选时：`scopeId: c.scopeType === 'project' ? (job.cwd ?? 'unknown') : null`。于是 project 记忆的 `scopeId` 就是来源 cwd（同时充当 scope 身份），而 **global 记忆的 `scopeId` 为 null，没有任何字段记录它来自哪个项目**。distill job 表（`memory_distill_jobs`）虽有 `cwd` 列，但从未下传到 `memories` 行。审批队列无从展示"这条记忆来自哪个项目"。

注：后端 `patchMemory`（`src/memory/store.ts`）其实已支持改 `scopeType`/`scopeId`，`PATCH /api/memories/:id`（`src/server.ts`）也已透传 body。但存在两个缺口：(a) web `api.ts` 类型与 UI 未暴露；(b) `patchMemory` 未处理 scope 与 scopeId 的 CHECK 耦合——单独把 `scopeType` 改成 `'global'` 会留下旧 `scopeId`，撞 DB 的 `CHECK ((scope_type='global' AND scope_id IS NULL) OR ...)` 约束报错。

## 2. 目标

- **G1**：用户可在审批队列 UI 把任意非终态记忆的 scope 在 global ⇄ project 间切换；切换后下次 SessionStart 注入按新 scope 生效。
- **G2**：每条记忆记录其来源项目（提炼时的 cwd），并在卡片上展示（末段名 + hover 全路径）；global 记忆也保留来源，不再丢失。

## 3. 非目标

- **N1**：把记忆重指派到**另一个**项目的 cwd。v1 仅 global ⇄ project 切换；切到 project 时绑定到该记忆的来源 cwd（注入本就按 cwd 精确匹配）。项目重指派 / 项目别名管理留待后续。
- **N2**：让用户编辑 `sourceCwd` 本身——它是来源事实（provenance），只读。
- **N3**：改变注入匹配机制（仍 cwd 精确匹配 project、global 全量）。
- **N4**：给手动创建（`sourceKind='manual'`）的记忆补来源 cwd——手动记忆无来源，展示"手动"。

## 4. 关键决策

| # | 决策点 | 选择 | 理由 |
|---|--------|------|------|
| 1 | 来源项目建模 | `memories` 新增独立 `source_cwd` 列 | 与 scopeType/scopeId 解耦；来源不因改 global 而丢；无 join、不怕 job 被清理；现有 CHECK 不变量保留 |
| 2 | scope 编辑粒度 | 仅 global ⇄ project 切换 | 贴合架构（project scope 身份即 cwd）；最小可行；重指派需求未提出 |
| 3 | project 切换的 scopeId 取值 | `入参 ?? row.sourceCwd ?? 抛错` | 切到 project 必须有非 null scopeId；回落到来源 cwd 最自然；手动记忆无来源则显式报错 |
| 4 | 来源展示 | 末段名 + `title` 全路径 | 简洁不丢精度；与现有 inline 样式一致 |
| 5 | 旧库迁移 | 幂等 `ALTER TABLE ADD COLUMN` + 回填 project 行 | 无迁移运行器；`CREATE TABLE IF NOT EXISTS` 对已存在表无效，必须显式 ALTER；回填让旧 project 记忆也有来源 |
| 6 | `sourceCwd` 可编辑性 | 不可 patch | 来源是事实，非分类标签 |

## 5. 接口契约

### 5.1 数据模型（`src/db/schema.ts` + `src/db/client.ts`）

`memories` 表新增列：

```
source_cwd TEXT   -- 来源项目 cwd；蒸馏记忆来自 job.cwd，手动记忆为 NULL
```

- `schema.ts`：`sourceCwd: text('source_cwd')`（无 notNull、无 enum、无 CHECK）。
- `client.ts` 的 `openDb` DDL：`CREATE TABLE` 语句加 `source_cwd TEXT`；并在建表后做幂等迁移（见 §5.6）。
- 现有 CHECK 约束 `(scope_type='global' AND scope_id IS NULL) OR (scope_type='project' AND scope_id IS NOT NULL)` **不变**。`source_cwd` 与之无关。

### 5.2 Store（`src/memory/store.ts`）

- `MemoryInput` 增 `sourceCwd?: string | null`。
- `Memory` 接口增 `sourceCwd: string | null`。
- `rowToMemory` 透传 `sourceCwd: r.sourceCwd ?? null`。
- `createCandidate` 写入 `sourceCwd: input.sourceCwd ?? null`，返回对象带上。

`patchMemory` 的 scope 耦合逻辑（在现有字段 diff 之前/之中插入）：

```
if (input.scopeType !== undefined && input.scopeType !== row.scopeType) {
  changed.push('scopeType'); set.scopeType = input.scopeType
  if (input.scopeType === 'global') {
    // 强制清空 scopeId，满足 global⇒null 不变量
    if (row.scopeId !== null) { changed.push('scopeId'); set.scopeId = null }
  } else { // 'project'
    const desired = input.scopeId !== undefined ? input.scopeId : (row.sourceCwd ?? null)
    if (desired === null) throw new MemoryConflictError('project scope requires a sourceCwd / scopeId')
    if (desired !== (row.scopeId ?? null)) { changed.push('scopeId'); set.scopeId = desired }
  }
} else if (input.scopeId !== undefined && input.scopeId !== (row.scopeId ?? null)) {
  // 仅改 scopeId 不改 scopeType：仍须满足不变量
  if (row.scopeType === 'global' && input.scopeId !== null)
    throw new MemoryConflictError('global scope requires null scopeId')
  if (row.scopeType === 'project' && input.scopeId === null)
    throw new MemoryConflictError('project scope requires non-null scopeId')
  changed.push('scopeId'); set.scopeId = input.scopeId
}
```

- `PatchInput` **不**增 `sourceCwd`（来源不可编辑）。
- 终态守卫（`superseded`/`rejected` 不可 patch）不变。
- 幂等 no-op（无 changed 字段时不写、不 bump version、不广播）不变。
- 上述 `else if`（仅改 `scopeId` 不改 `scopeType`）是**现有 `patchMemory` 已有的能力**，本设计保留并加不变量校验，不构成新功能；UI 不暴露任意重指派（见 N1），仅随 `scopeType` 切换发送 `scopeId = sourceCwd`。

### 5.3 Scheduler（`src/scheduler.ts`）

`tick` 调 `createCandidate` 时新增入参 `sourceCwd: job.cwd ?? null`。其余不变。

### 5.4 Server（`src/server.ts`）

- 无新路由、无路由签名变更。
- `PATCH /api/memories/:id`：已 `await c.req.json()` 透传给 `patchMemory`，body 含 `scopeType`/`scopeId` 时由 store 处理；409 冲突沿用现有 `catch`。
- `GET /api/memories`：返回裸行 `{ items: rows }`，加列后自带 `source_cwd`（drizzle 映射为 `sourceCwd`）。
- `POST /api/memories`（手动建）：`{ ...body, sourceKind: 'manual', runtime: body.runtime ?? null }` 透传，`body.sourceCwd` 一般为 undefined -> 存 null（符合 N4）。

### 5.5 Web（`src/web/api.ts` + `src/web/App.tsx`）

`api.ts`：

- `MemoryItem` 增 `sourceCwd?: string | null`。
- `patchMemory` 的 body 类型增 `scopeType?: 'project' | 'global'; scopeId?: string | null`。

`App.tsx` 的 `MemoryCard`：

- 只读区：在现有 `<small>{m.scopeType} · {m.runtime ?? '任意 runtime'}</small>` 旁追加来源标记，规则：`sourceCwd` 非空 -> `· 来源: <basename>`，外层元素 `title={sourceCwd}`（全路径 hover）；`sourceKind==='manual'` -> `· 来源: 手动`；否则（旧 global 无来源记录）-> `· 来源: 未知`。`basename` 取 cwd 末段（`split(/[\\/]/).filter(Boolean).pop()`，空则原样）。
- 编辑模式：在 title/body 之上加 project/global 选择器（两个 radio 或一个 select）。保存时 `onEdit` 连同 `scopeType` 一起回传：global->`{scopeType:'global'}`，project->`{scopeType:'project', scopeId: m.sourceCwd ?? null}`。`App.edit` 签名改为接收 scopeType/scopeId，调 `patchMemory(id, { title, bodyMd, scopeType, scopeId })`。
- 复用既有 inline 样式，不引新框架/新 chrome。

### 5.6 旧库迁移（`src/db/client.ts` `openDb`）

`CREATE TABLE IF NOT EXISTS` 对已存在的 `memories` 表是 no-op，故新列不会自动出现。在建表块之后追加幂等迁移（bun:sqlite 标准 API：`raw.prepare(sql).all()`；`PRAGMA table_info` 返回 `{name,...}[]`）：

```
const cols = raw.prepare('PRAGMA table_info(memories)').all() as { name: string }[]
if (!cols.some((c) => c.name === 'source_cwd')) {
  raw.exec('ALTER TABLE memories ADD COLUMN source_cwd TEXT')
  raw.exec("UPDATE memories SET source_cwd = scope_id WHERE scope_type = 'project' AND source_cwd IS NULL")
}
```

- 回填只覆盖旧 project 记忆（其 `scope_id` 即来源 cwd）；旧 global 记忆来源不可恢复，保持 NULL（UI 显示"来源: 手动"语义上略不精确，但可接受——它们本就无来源记录；后续可单独显示"未知"）。为区分"手动"与"旧 global 未知"，UI 展示规则：`sourceCwd` 非空->末段名；`sourceKind==='manual'`->"手动"；否则（旧 global 无来源）->"未知"。
- 幂等：探测到列已存在则跳过 ALTER 与回填，重复 `openDb` 无副作用。

## 6. 数据流

```
捕获：claude code hook(cwd) ──> memory_distill_jobs.cwd ──> tick ──> createCandidate(sourceCwd = job.cwd) ──> memories.source_cwd

展示：GET /api/memories(裸行) ──> MemoryCard 显示 basename(sourceCwd) + title 全路径

编辑 scope：UI 选 global/project ──> PATCH /api/memories/:id {scopeType[, scopeId]} ──> patchMemory 耦合处理 scopeId ──> version+1 + 广播 memory.updated

注入：SessionStart(cwd) ──> listApprovedByScope({projectId: cwd}) 按行 scopeType/scopeId 匹配 ──> formatMemoryBlock
      （project->global 后：任意 cwd 都命中；global->project 后：仅源 cwd 命中）
```

## 7. 与现有模块的耦合点

- **`listApprovedByScope` / `formatMemoryBlock`**（`store.ts`/`pure.ts`）：本就读行的 `scopeType`/`scopeId`，编辑后自动生效，**无需改动**。`sourceCwd` 不进入注入块。
- **`promoteCandidate` supersede scope 校验**（`store.ts`）：`t.scopeType !== cand.scopeType || t.scopeId !== cand.scopeId` 抛 mismatch。若用户在审批前改过 scope，candidate 的 scope 即改后值，supersede 目标须匹配——语义一致，无需改动。
- **`createCandidate` 调用方**：`scheduler.tick`（改）、`POST /api/memories`（手动，不改）、各测试（`MemoryInput` 增可选字段，向后兼容，不破坏现有调用）。
- **DB CHECK 约束**：`patchMemory` 的耦合逻辑保证不违反；`schema.test.ts` 现有 global-rejects-non-null 测试仍绿。
- **WS 广播**：`memory.updated` 已带 `changedFields`，scope 变更会包含 `'scopeType'`/`'scopeId'`，无需改广播协议。

## 8. 失败模式

| 场景 | 行为 |
|------|------|
| global->project 但 `sourceCwd` 为 null（手动记忆） | `patchMemory` 抛 `MemoryConflictError` -> PATCH 返回 409；UI 须提示"该记忆无来源项目，无法切到 project" |
| 单独改 `scopeType='global'` 未带 scopeId | store 自动清空 scopeId，不撞 CHECK（修复现有缺口） |
| 单独改 `scopeId` 与当前 scopeType 不变量冲突 | 抛 `MemoryConflictError` -> 409 |
| 终态（superseded/rejected）改 scope | 沿用现有终态守卫抛 `MemoryConflictError` -> 409 |
| 旧库迁移时列已存在 | `PRAGMA table_info` 探测跳过，无副作用 |
| 旧库迁移 ALTER 失败（理论） | `openDb` 抛错，daemon 不启动——与现有 DDL 失败行为一致 |
| 来源展示 cwd 为空串 | basename 取空串->显示空；按 `sourceKind` 兜底"手动/未知" |
| `distillTranscript` 仍判错 scope | 用户可在 UI 纠正——这正是本特性目的；纠正后注入立即按新 scope |

## 9. 测试策略

可断言面优先落在纯函数/纯数据层（store、scheduler 入参、web client），UI/daemon 运行时层留少量集成断言 + 源码层文本断言兜底（CLAUDE.md 要求）。

- **`tests/schema.test.ts`**：新列存在；迁移幂等——先用旧 DDL 建无 `source_cwd` 的库并插入 project/global 行，reopen 后断言列存在、project 行 `source_cwd=scope_id`、global 行 `source_cwd` 仍 null；再次 reopen 无副作用。
- **store scope 编辑（新增 `tests/store-scope-edit.test.ts` 或扩 `store-crud.test.ts`）**：
  - `createCandidate` 存 `sourceCwd` 且 `getMemoryById` 读回。
  - patch project->global：`scopeId` 变 null、`scopeType` 变 global、version+1、`changedFields` 含两者。
  - patch global->project（有 sourceCwd）：`scopeId` 变 sourceCwd、version+1。
  - patch global->project（sourceCwd=null，手动）：抛 `MemoryConflictError`。
  - patch 仅 `scopeId` 与 scopeType 不变量冲突：抛错。
  - patch scope 未变：幂等 no-op（无 write、无 version bump、`changedFields=[]`）。
  - patch 后 `listApprovedByScope` 注入按新 scope（project->global 在另一 cwd 命中；global->project 仅源 cwd 命中）——回归断言。
- **`tests/scheduler.test.ts`**：`tick` 调 `createCandidate` 的入参含 `sourceCwd = job.cwd`（用 mock 捕获 input 断言）。
- **`tests/server.test.ts`**：PATCH `{scopeType:'global'}` 于 project 候选 -> 200、`memory.scopeId` null、`changedFields` 含 scopeType/scopeId、广播 `memory.updated`；PATCH global->project 无 sourceCwd -> 409。
- **`tests/web-api.test.ts`**：`patchMemory` body 含 `scopeType` 时被序列化进请求体。
- **UI 兜底**（CLAUDE.md 最低要求）：`App.tsx` 源码层文本断言——`MemoryCard` 含 "来源" 文本与 scope 选择器节点（grep 级断言或轻量 render）。若 React 组件不便于单测，至少保留一条源码层文本断言锁住"来源"与 scope 编辑入口存在。

## 10. 落地流程（CLAUDE.md）

1. 已切 `feat/editable-scope-and-source-project`（基线 `origin/master`）。
2. 本 spec 落档 + commit。
3. 调用 `writing-plans` skill 产出 `docs/superpowers/plans/2026-07-23-editable-scope-and-source-project.md`。
4. 按计划实现 + 测试，`bun run typecheck && bun test` 全绿。
5. push -> PR 合 `master`。

## 11. 涉及文件

- `src/db/schema.ts`、`src/db/client.ts`
- `src/memory/store.ts`
- `src/scheduler.ts`
- `src/web/api.ts`、`src/web/App.tsx`
- 测试：`tests/schema.test.ts`、`tests/store-scope-edit.test.ts`（新）/`tests/store-crud.test.ts`、`tests/scheduler.test.ts`、`tests/server.test.ts`、`tests/web-api.test.ts`
- 落档：本 spec + `docs/superpowers/plans/2026-07-23-editable-scope-and-source-project.md`

# Spec: 记忆可移植性与批量操作（2026-08-16）

> 配套：`docs/superpowers/plans/2026-08-16-memory-portability-and-batch-ops.md`（后续 writing-plans 产出）。
> 这是双 spec 分解的 **Spec A**。**Spec B（npm 包 + exe + 安装器一键发布）** 为独立 spec，在其后头脑风暴。

## 背景

memside 即将商用。当前记忆管理层缺三块商用必备能力：

1. **没有批量删除**——`store.ts` 无硬删除原语，只有 `archive`（approved→archived，行仍在"已审批" tab）/ `reject`（candidate→rejected，行仍在"已拒绝" tab）。用户无法真正删掉记忆。
2. **没有导出/导入**——`server.ts` 无任何 export/import 路由；用户无法备份记忆库、跨机器迁移、或在重装后恢复。
3. **没有多选批量操作**——`App.tsx` 无 checkbox / selectedIds / select-all；只有逐条操作和一条服务端条件的 `bulk-reject-unevaluated`。

目标闭环：用户在 Web UI 多选记忆 → 批量删除（移入回收站，可恢复）/ 批量导出（memside JSON 高保真 + Markdown 低保真两种格式）→ 文件导入（两种格式都吃，冲突策略可选）→ 回收站恢复 / 清空。

## 目标 / 非目标

### 目标

- 回收站机制：删除 = 移入回收站（保留完整快照，可恢复）；清空回收站 = 物理删快照（不可恢复）。
- 批量删除：多选 → 一键移入回收站。
- 批量导出：三档作用域（选中项 / 当前筛选 / 全部）× 两格式（memside JSON / Markdown）。
- 导入：文件上传 + 格式自动识别（JSON envelope / Markdown）+ 冲突策略（跳过 / 覆盖 / 全部新建）。
- 导入恢复与文件导入共享同一高保真存储 seam（绕过 `createCandidate` 的 `status:'candidate'` 硬编码，保留 status）。
- 回收站 tab（第 8 个 tab）+ 计数徽标 + 四维筛选 + 逐条恢复 + 清空。

### 非目标

- 不做导出流式传输（live DB 3000 条量级可控，YAGNI；标注上限，未来大表再升级）。
- 不做回收站自动 TTL 清理（只手动清空；自动清理留独立后续）。
- 不做跨机器实时同步（导出/导入是离线迁移手段，非在线同步）。
- 不做记忆的版本历史/差异对比（supersedes 链不变）。
- 不改 distiller / scheduler / 注入链路 / 状态机（`TRANSITIONS` 不动）。
- 不动 discards（AI 自动丢弃审计）语义——discards 是机器丢的，trash 是用户删的，职责分开。

## 接口契约

### 数据模型：新增 `memory_trash` 表

沿用 `memory_discards` 的成熟模式（纯文件系统写入、可独立测、带来源快照、幂等 `CREATE TABLE IF NOT EXISTS` 不表重建）。

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT PK | 回收站条目 id（新 ULID，不复用原 memory id） |
| `memory_snapshot` | TEXT | 被删记忆的完整 `Memory` JSON 快照（高保真；清空后此行物理删除 → 不可恢复） |
| `original_memory_id` | TEXT | 原 memory id（恢复时去重/幂等判断） |
| `scope_type` | TEXT | 来源 scope（`'project'`/`'global'`） |
| `scope_id` | TEXT nullable | project scope 的 cwd；global 时 null |
| `source_cwd` | TEXT nullable | 冗余，便于回收站按项目筛选（对齐 facets 风格） |
| `runtime` | TEXT nullable | 来源 runtime（`'claude-code'`/`'opencode'`/null） |
| `deleted_at` | INTEGER | 删除时间（epoch ms） |
| `title` | TEXT | 冗余展示列（列表展示用，免每行反序列化 snapshot） |
| `value_class` | TEXT nullable | 冗余展示列（筛选/徽标） |
| `subject_slug` | TEXT nullable | 冗余展示列（筛选/分组） |

**三个动作的存储语义：**

- **删除** = `DELETE FROM memories WHERE id=?` + `INSERT INTO memory_trash (snapshot...)`（同一事务）。原行真删，快照留 trash。
- **恢复** = 反序列化 `memory_snapshot` → 走高保真 `importMemories(db, [snapshot], {conflict})` 写回 `memories`（保留 status/origin/evidence 等）→ `DELETE FROM memory_trash`。若 `original_memory_id` 在 memories 已存在，按冲突策略处理（restore 默认 `skip`，安全——见失败模式 #4）。
- **清空** = `DELETE FROM memory_trash`（全表物理删 snapshot，不可恢复）。

### 导入/恢复共享 seam：`importMemories`

新存储函数 `importMemories(db, records: Memory[], { conflict: 'skip'|'overwrite'|'newid' }): Promise<{ imported, skipped, overwritten, errors: string[] }>`：

- 绕过 `createCandidate` 的 `status:'candidate'`/`version:1`/`approvedAt:null` 硬编码，按记录里的 status 直接写入（高保真）。
- 按 `record.id` 查重：`skip` 跳过计 skipped；`overwrite` 删旧写新（保留 id，status 跟导入走）；`newid` 生成新 ULID 当新记忆插（无视冲突）。
- `subjectSlug` 经 `normalizeSubjectSlug` 校验（与 `patchMemory` 写路径一致）。
- 非法记录（字段缺失/类型错）跳过计 errors，不整批失败。
- 文件导入的 markdown 路径解析出的记录走 `createCandidate`（成 candidate，因 markdown 本就低保真、用户再审批）——此路径不走 `importMemories`，是独立的 `createCandidate` 循环。

### 导出/导入格式（纯函数，`src/memory/exchange.ts`）

**1. memside JSON（高保真）**

```json
{
  "format": "memside-memories",
  "version": 1,
  "exportedAt": 1723760000000,
  "memories": [ /* 完整 Memory 对象数组，24 字段全保留 */ ]
}
```

- `format` + `version` 自描述 envelope，未来可演进。`exportedAt` 便于追溯。
- `memories[]` 每条完整 `Memory` 记录（status/origin/evidence/subjectSlug/valueClass/tags 全在）。`tags` 为数组形态（不存 DB 的 JSON 字符串形态）。
- 导入按 envelope 校验 `format==='memside-memories'` + 逐条 zod 校验；非法条目跳过计 errors。

**2. markdown（低保真，人类可读）**

```markdown
# memside 记忆导出

> 导出于 2026-08-16 · 共 3 条 · 来源:memside

---

## [category:convention] 用 bun 跑测试

- **范围**: project · claude-code
- **来源项目**: C:/Users/admin/Desktop/memside
- **标签**: testing, tooling
- **主题**: test-runner

必须用 `bun test` 跑测试,不要用 `npm test`。

---

## [category:decision] 端口 7777

- **范围**: global · claude-code
- **标签**: infra

daemon 固定监听 7777。
```

- 一条记忆 = 一个 `## [category:xxx] 标题` 小节，正文为 `bodyMd`，元信息 `- **字段**: 值` 列表，`---` 分隔。
- 复用 `formatMemoryBlock` 的分组渲染思路（按 subjectSlug 分节），但此处每条独立、带元信息头。
- **markdown 导入解析**：正则切 `^## ` 小节 → 从标题剥 `[category:xxx]`（复用 `categoryFromTitle`）→ 正文行直到下个 `^## ` 或文件尾 → 元信息 `- **字段**:` 解析。解析出记录走 `createCandidate`（成 candidate）。解析失败条目计 errors 跳过，不整批失败。

**格式自动识别**：导入时先 `JSON.parse` 尝试——成功且 `format==='memside-memories'` → JSON 高保真路径；否则当 markdown 解析。用户不用手选格式。

### 服务端 API（`src/server.ts`）

沿用现有约定（`c.json` 成功 / `{error}` 400-409 / `broadcast` WS 扇出 / loop-and-swallow 吞错计数）。

**批量删除**
- `POST /api/memories/bulk-delete` — body `{ ids: string[] }` → `bulkDeleteMemories(db, ids)` → `{ deleted, skipped }`。逐条删（事务内删 memory + 写 trash），吞错计 skipped。broadcast `memories.bulk-deleted`。空 ids 400。

**回收站**
- `GET /api/trash` — 分页（`?limit&before`）+ 四维筛选（project/category/slug/valueClass，trash 表冗余列支持）。返回 `PageWithTotal<TrashRow>`（列表不含 snapshot 大字段）。
- `GET /api/trash/:id` — `{ trash }` 含完整 snapshot（恢复前预览）。
- `POST /api/trash/:id/restore` — `restoreFromTrash(db, id, {conflict:'skip'})` → `{ memory }`。trash 行删 + memory 写回。404（不存在）。broadcast `memory.restored`。
- `POST /api/trash/empty` — `emptyTrash(db)` → `{ emptied }`。broadcast `trash.emptied`。物理删 snapshot，不可恢复。

**导出**
- `POST /api/memories/export` — body `{ scope: 'selected'|'filter'|'all', ids?, filter?, format: 'json'|'markdown' }`。
  - `selected` → 按 ids 取（无视分页）。
  - `filter` → 复用 `MemoryListFilter` + 当前 tab statuses，服务端无分页查（新增 `listMemoriesForExport`，无 cursor）。
  - `all` → 全部 statuses。
  - JSON 返回 `{ format, version, exportedAt, memories }`；markdown 返回 `c.text(md, 200, {'Content-Disposition':'attachment; filename="memside-export.md"'})`。UI 端触发浏览器下载。

**导入**
- `POST /api/memories/import` — multipart/form-data 单文件 + query `?conflict=skip|overwrite|newid` → `importMemories` / `createCandidate`（按格式）→ `{ imported, skipped, overwritten, errors }`。服务端先 `JSON.parse` 判格式。broadcast `memories.imported`。导入条数 cap 10000（超限 400）。

### Web UI（`src/web/App.tsx` + `api.ts`）

复用既有 chrome（同一 `MemoryCard`、同一刷新契约 no-throw → 乐观本地变更 → `refresh(tab)`）。新增「回收站」tab + 记忆 tab 多选 + 批量操作条。

**1. 多选机制（候选/已审批/已拒绝三个 tab）**
- 新增 `selectedIds: Set<string>` state（per-tab 隔离，切 tab 清空，对齐 `filters` per-tab 模式）。
- `MemoryCard` 加可选 `selectionMode: boolean` + `selected: boolean` + `onToggleSelect(id)` props。勾选框卡片左侧；非选中态不显示。整卡点击可切换选中。
- 列表头部「全选当前页」复选框 + 「已选 N 条」计数。

**2. 批量操作条（记忆 tab）**

`selectedIds.size > 0` 时列表顶部固定操作条：
- 左：`已选 N 条` + `全选当前页` / `取消选择`。
- 右按钮组（按 tab）：
  - 候选：`批量批准` / `批量拒绝` / `批量删除（移入回收站）`
  - 已审批：`批量归档` / `批量取消归档` / `批量删除`
  - 已拒绝：`批量恢复` / `批量删除`
- 批量删除前确认弹窗（`确认将 N 条移入回收站?可从回收站恢复`）。删除后乐观 `removeFromTab` + `refresh`。

**3. 导出/导入入口（独立，不依赖选中——配合三档作用域）**

记忆列表工具栏（筛选栏旁）：
- **导出** → 下拉：`导出选中(N)` / `导出当前筛选` / `导出全部` → 二级 `memside JSON` / `Markdown` → `/api/memories/export` → 浏览器下载（`Blob` + `URL.createObjectURL` + `<a download>`）。
- **导入** → `<input type="file">`（accept `.json,.md`）→ 冲突策略选择（`跳过已存在` / `覆盖已存在` / `全部新建`）→ 上传 → 结果 toast（`导入 X / 跳过 Y / 覆盖 Z`）+ `refresh`。

**4. 回收站 tab（新增第 8 个 tab,带计数徽标）**
- `TabKey` 加 `'trash'`，徽标 `status.trashCount`。
- `TrashCard`（新组件，仿 `DiscardCard`）：标题（剥 category 前缀，复用 `stripCategoryPrefix`）、分类/价值/来源项目徽标、删除时间。
- 四维筛选（复用 facets，trash scope）。
- 操作：`恢复`（逐条）、`清空回收站`（顶部按钮，二次确认「清空后不可恢复」）。
- `isListTab('trash')` = true，纳入轮询/无限滚动/分页缓存。

**状态可见性**（对齐 CLAUDE.md 后台状态可见要求）：导入/导出/清空进行中显示 loading；失败显示错误横幅（fetch 失败不静默白屏）；回收站空态文案。

## 数据流

```
删除：UI 多选 → POST /api/memories/bulk-delete {ids}
     → store.bulkDeleteMemories(事务: DELETE memories + INSERT memory_trash 快照)
     → broadcast memories.bulk-deleted → UI removeFromTab + refresh

恢复：回收站 tab → POST /api/trash/:id/restore
     → store.restoreFromTrash(反序列化 snapshot → importMemories(skip) → DELETE trash 行)
     → broadcast memory.restored → UI 移出 trash + refresh

清空：回收站 tab → POST /api/trash/empty
     → store.emptyTrash(DELETE FROM memory_trash 全表)
     → broadcast trash.emptied → UI 清空 trash 列表 + refresh

导出：UI 选 scope+format → POST /api/memories/export
     → store.listMemoriesForExport(selected|filter|all)
     → exchange.serializeMemoriesJson | serializeMemoriesMd
     → c.json(envelope) 或 c.text(md, Content-Disposition)
     → UI Blob 下载

导入：UI 上传文件 + 选 conflict → POST /api/memories/import (multipart, ?conflict)
     → server JSON.parse 判格式
       → JSON: exchange.parseMemoriesJson → store.importMemories(records, conflict) 高保真
       → MD:   exchange.parseMemoriesMd → store.createCandidate 循环 (成 candidate)
     → { imported, skipped, overwritten, errors }
     → broadcast memories.imported → UI toast + refresh
```

## 与现有模块的耦合点

- **`store.ts`**：新增 `bulkDeleteMemories` / `restoreFromTrash` / `emptyTrash` / `importMemories` / `listMemoriesForExport` / `listTrashPage` / `listTrashFacets`。新增 `memory_trash` 表 schema（`src/db/schema.ts` + `src/db/client.ts` 幂等迁移块，复用既有迁移插入位置）。`rowToMemory`/`parseTags` 复用于 snapshot 序列化往返。
- **`pure.ts`**：复用 `normalizeSubjectSlug` / `categoryFromTitle` / `MemoryStatus` / `MemoryScope` / `RuntimeTag` / `MemoryInput`。`Memory` 接口（store.ts:41-64）是 snapshot 与 JSON 导出的权威记录形状。
- **`server.ts`**：新增 7 路由（bulk-delete / trash×4 / export / import）。multipart 解析用 Hono 内建或 `c.req.parseBody`。`broadcast` seam 复用。静态/导出 download header 用 `c.header('Content-Disposition', ...)`。
- **`App.tsx`**：`TabKey` 加 `'trash'`；`selectedIds` per-tab state；`MemoryCard` 加 selection props；新 `TrashCard`；导出/导入入口 + 文件下载/上传代码（当前仓库无任何 download/upload，greenfield）。`isListTab`（`tab-cache.ts`）加 `'trash'`。
- **`api.ts`**：新增 `bulkDelete` / `exportMemories` / `importMemories` / `listTrashPage` / `getTrash` / `restoreFromTrash` / `emptyTrash` wrapper（沿用既有 injectable `fetchFn` 测试 seam）。
- **`/api/status`**：加 `trashCount` 字段（驱动回收站 tab 徽标）。
- **`install.ts` / `daemon.ts` / `distiller.ts` / `scheduler.ts`**：零改动（明确非目标）。

## 失败模式

1. **导出大表 OOM**：全量导出 live DB（3000+ 条）服务端 `c.json` 一次性序列化大对象。缓解：本次不做流式（YAGNI，量级可控）；标注上限日志；未来大表升级流式。
2. **导入大文件**：multipart 大文件内存爆。缓解：导入条数 cap 10000，超限 400 拒绝并提示。
3. **markdown 解析歧义**：bodyMd 含 `## ` 或 `---` 被误切。缓解：解析按"标题行优先、正文吃到底下一个 `^## ` 或文件尾"贪心规则；`---` 只在独立行作可选分隔，不强依赖切分。
4. **恢复时 id 已存在**：`overwrite` 会删掉恢复期间新建的同 id 记忆。决定：restore 默认 `skip`（安全），恢复 UI 不暴露 overwrite（避免误删），只有文件导入暴露三策略。恢复遇冲突计 skipped，提示"已存在同 id,跳过"。
5. **清空回收站误操作**：二次确认覆盖。
6. **snapshot schema 演进**：未来 `Memory` 加字段时旧 snapshot 缺字段。缓解：`restoreFromSnapshot` 对缺失字段返回 null，不崩。
7. **markdown 导入重复执行**：每次导入 markdown 都生成新 candidate（新 ULID），重复导入同一文件会产生重复记忆。缓解：markdown 导入是低保真一次性操作；用户可用"批量拒绝"清理；dedup 机制（既有）会在 distill 时去重，但手动导入不触发 dedup——标注为已知行为，非 bug。

## 测试策略

对齐 CLAUDE.md 测试门禁（`bun run typecheck && bun test` 全绿才 push）+ "首选可断言面:纯函数层写足测试,运行时层只留少量集成断言"。

**纯函数层（主力，`tests/exchange.test.ts`）**
- JSON 序列化往返：`serializeMemoriesJson([memory])` → `parseMemoriesJson(str)` 严格还原全部 24 字段（含 status/origin/evidence/tags 数组）。
- JSON envelope 校验：非法 `format` / 缺 `version` / `memories` 非数组 → 抛错或返回空 errors 不静默吞。
- markdown 序列化：`serializeMemoriesMd([memory])` 产出含 `## [category:xxx]` + 元信息列表 + bodyMd + `---`。
- markdown 解析往返：多 category、多 slug、缺元信息、标题无 category 前缀、bodyMd 多行/含 `---`/含 `- **字段**:` 文本 → 正确切分不误吃边界。
- 格式自动识别：JSON envelope → JSON 路径；纯 markdown → markdown 路径；畸形 JSON（非 envelope）→ markdown 兜底；完全无法解析 → errors 非空。
- 类别剥前缀一致性回归锁（对齐既有 ui-clarity D7 跨模块一致性测试模式）。

**纯函数层（`tests/trash.test.ts`）**
- `snapshotMemory(memory)` → `restoreFromSnapshot(snapshot)` 全字段还原（tags 数组、epoch ms、nullable）。
- snapshot schema 演进容错：旧 snapshot 缺字段不崩（返回 null）。

**存储层（`tests/store-crud.test.ts` 扩展）**
- `bulkDeleteMemories`：删 memory + 写 trash 原子（删成功但 trash 写失败 → 回滚，memory 不丢）；逐条吞错计 skipped；幂等（同 id 重复删只产生一条 trash 或计 skipped）。
- `restoreFromTrash`：恢复后 trash 行删 + memory 写回 + status 保留（approved 恢复仍 approved）。
- `emptyTrash`：清空后 `memory_trash` 表为空 + 不可恢复（无残留 snapshot）。
- `importMemories` 三冲突策略：`skip`/`overwrite`/`newid`；非法记录跳过计 errors 不整批失败；markdown 导入（走解析→createCandidate）成 candidate。
- `listMemoriesForExport`：无分页、按 filter / all 正确取集（不受 cursor 限制）。

**服务端层（`tests/server.test.ts` 扩展，少量集成断言）**
- `POST /api/memories/bulk-delete`：正常返回 `{deleted, skipped}`；空 ids 400；不存在 id 计 skipped。
- `GET /api/trash` 分页 + 筛选；`POST /api/trash/:id/restore` 404/409；`POST /api/trash/empty` 清空返回计数。
- `POST /api/memories/export`：三档 scope + 两格式；校验 `Content-Disposition` header（markdown）与 JSON envelope 结构。
- `POST /api/memories/import`：multipart + 三冲突策略 + 格式自动识别 + 错误聚合返回。

**UI 层（`tests/web-*.test.ts`，源码层文本断言兜底）**
- `App.tsx` 含批量操作条 token、回收站 tab key、导入对话框冲突选项 token（对齐既有运行时组件只留源码层文本断言兜底模式）。
- `api.ts` 新 wrapper fetch 调用形状锁。

## 与既有债务/决策的关系

- 复用 `memory_discards` 的审计表模式（幂等迁移、纯文件系统、来源快照）。
- 复用 `createCandidate` 作为 markdown 导入 seam（低保真路径）。
- 复用 `Memory` 接口（store.ts:41-64）作为 snapshot 与 JSON 导出权威形状。
- 复用 `MemoryListFilter`（store.ts:790-799）+ facets 机制作为导出 filter scope 与回收站筛选。
- 不引入新依赖（multipart 用 Hono 内建；Blob 下载用浏览器原生 API；ULID 复用现有 `ulid` 依赖）。

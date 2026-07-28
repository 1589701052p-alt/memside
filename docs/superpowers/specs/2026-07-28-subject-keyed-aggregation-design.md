# Subject-keyed 聚合层（第一期：确定性分组渲染）设计 spec

日期：2026-07-28
来源：`OPUS-5.md`（Claude 内置记忆 `<memory_filesystem>`）特性 6 —— subject-keyed 聚合

## 1. 背景与问题

memside 目前的记忆组织模型是**扁平原子块列表**：N 条 approved 记忆在 SessionStart 注入时平铺成 N 行（`formatMemoryBlock`，`src/memory/pure.ts`），行与行之间没有任何主题组织。已有的 dedup（PR #5，`src/memory/dedup.ts`）只做蒸馏时的语义近重复聚合，不做跨主题归并。

OPUS-5 的模型是"一个 subject 一个文件，事实往里堆"：同一主题领域的多条事实合成一个更紧凑的上下文。把这一思路搬进 memside，可以同时缓解两个问题：

1. **注入噪声**：同主题事实散落平铺，注入块随记忆数线性膨胀。
2. **队列膨胀**：（第二期）同主题 N 条可合成一条紧凑 profile，减少注入行数。

## 2. 目标 / 非目标

### 目标（第一期）

- distiller 为每条候选产出 **subject slug**（kebab-case 主题标识，如 `refund-policy`），入库 `memories.subject_slug` 新列。
- 蒸馏时把该 scope **现有 slug 清单**喂进 prompt，模型优先复用已有 slug（对抗同义碎裂——本特性最大的失败模式）。
- 审批 UI 可查看 / 编辑 slug（可留空 = 未分组），延续"liberal 捕获 + 用户把关"。
- 注入渲染按 slug 分节：同主题行归拢一节，NULL slug 照旧平铺。**预算裁剪语义零变更**。

### 非目标

- **不做 LLM 合成压缩**（第二期）：不把同 subject 的 N 条改写为一条摘要。第一期 slug 列即第二期的挂载点。
- **不给老数据做 LLM 回填**：老行 `subject_slug = NULL`（未分组），行为与今天一致。
- 不改 dedup / valueFilter / 状态机语义。

## 3. 关键设计决定

| # | 决定 | 理由 |
|---|------|------|
| D1 | 两步走：第一期纯分组渲染（无 LLM），第二期才加合成层 | 第一期零 LLM 调用、零注入延迟、行为确定可测；slug 列一次到位，第二期只加合成层 |
| D2 | 新增 `subject_slug` 列，而非复用 `[category:]` 前缀或 `tags` | category 是"事实类型"（10 个固定类目），同类目下多主题仍混杂；tags 多值归属模糊且历史为空 |
| D3 | 蒸馏 prompt 附现有 slug 清单，模型优先复用 | 不给清单则模型自由起名，同主题碎裂成多个一条一组的 slug，聚合失效 |
| D4 | distiller 现有瞬态字段 `subject`（codebase\|domain）改名 `ruleObject` | 与新 slug 撞名；`ruleObject` 才是其真实语义（规则对象的所指），`subject` 名字让给 OPUS-5 概念 |
| D5 | 先裁剪、后分组渲染 | `clipByBudget` 的顺序与语义一行不动；分组只是渲染层归拢，预算行为零回归风险，NULL slug 老数据渲染逐字节兼容 |
| D6 | slug 校验失败静默降级为 NULL，不触发重试、不丢记忆 | slug 是增强项，绝不能卡住蒸馏闭环 |

## 4. 接口契约

### 4.1 slug 格式

- 正则：`^[a-z0-9]+(-[a-z0-9]+)*$`，最长 48 字符。
- 解析时先 trim + 转小写再校验；不过 → `null`（不 retry，见 D6）。
- 纯函数 `normalizeSubjectSlug(raw: unknown): string | null`（`src/memory/pure.ts`）：非法输入一律返回 null，永不抛错。

### 4.2 Schema 迁移

- `memories` 加列 `subject_slug TEXT`（NULL = 未分组）。
- 迁移照搬 `value_class` 先例（`src/db/client.ts`）：新列**同时**写进 `CREATE TABLE` DDL（新库）**和**幂等迁移块（老库 `PRAGMA table_info` 缺列则 `ALTER TABLE memories ADD COLUMN subject_slug TEXT`）。
- 新索引 `idx_memories_subject` on `(scope_type, scope_id, subject_slug)`，在 ALTER 之后以 `CREATE INDEX IF NOT EXISTS` 创建（照 `idx_distill_jobs_session` 先例，避免老库 DDL 阶段缺列报错）。
- 老行不回填（保持 NULL）。

### 4.3 Distiller（`src/memory/distiller.ts`）

- `DistillCandidate.subject` 改名 `ruleObject`（值域 `'codebase'|'domain'` 不变，逻辑不动）。prompt 内对应段落同步改名。
- 新增 `DistillCandidate.subjectSlug: string | null`。
- `DistillInput` 新增 `existingSlugs: string[]`——该 scope 现有 slug 清单，由 scheduler 调用前查询注入。
- prompt 新增段落：slug 规则（kebab-case、2~4 个英文单词、描述主题领域、拿不准不输出）+ 现有 slug 清单（"优先复用清单中的主题；确实是新主题才造新 slug"）。
- `distillShouldRetry` 校验：`subjectSlug` 若存在必须是 string（否则 retry）；**格式是否合法不在 retry 层判断**，留给解析层 `normalizeSubjectSlug` 降级为 null。

### 4.4 Store（`src/memory/store.ts`）

- `MemoryInput` / `Memory` 增加 `subjectSlug: string | null`；`createCandidate` 写入；`rowToMemory` 解析（`?? null`）。
- 新增 `listSubjectSlugs(db, { scopeType, scopeId }): Promise<string[]>`：`status IN ('candidate','approved')` 且 `subject_slug NOT NULL` 的 DISTINCT slug，字母序，LIMIT 50。project = 精确 scopeId 匹配；global = scopeId IS NULL（与 `listForDedupByScope` 同规则）。
- `patchMemory` 支持 `subjectSlug`：传 string 经 `normalizeSubjectSlug` 校验，非法抛 `MemoryConflictError`；传 null = 移出分组；不传 = 不改。变更计入 `changedFields`。
- `listApprovedByScope` 投影增加 `subjectSlug`。

### 4.5 注入渲染（`src/memory/pure.ts`）

- `InjectableMemoryRow` 增加 `subjectSlug?: string | null`。
- `formatMemoryBlock` 流程：**先按现有 `clipByBudget` 裁剪（D5），再分组渲染**：
  - 裁剪后的行按 slug 归拢，节标题 `[slug]` 单独一行，组内行为 `- title - bodyMd`（省略 `[scope]` 前缀，节内同 scope）。
  - 未分组行保持现有格式 `- [scope] title - bodyMd`。
  - 节的相对位置由组内最先出现的成员在裁剪后序列中的位置决定；组内成员保持裁剪后序列的相对顺序。
  - 空组不可能出现（分组在裁剪后做，无成员即无节）。
  - 全部行 slug 为 NULL 时，输出与现状逐字节一致。

### 4.6 Scheduler（`src/scheduler.ts`）

- tick 在调 `distillTranscript` 前，分别查 `listSubjectSlugs` 的 project（`job.cwd`）与 global 两份清单取**并集**（去重、字母序）作为 `existingSlugs` 传入——同一 job 的候选可能被标成 project 或 global，两份清单都要给模型看。查询失败 → 传空数组（distill 照常）。
- 候选入库时把 `subjectSlug` 透传给 `createCandidate`。

### 4.7 Web UI（`src/web/App.tsx` + `src/server.ts`）

- 审批卡片显示 slug 徽标 + 可编辑输入框（复用现有 scope 编辑交互），PATCH body 增加 `subjectSlug`；留空 = 未分组（传 null）。
- server PATCH 路由透传 `subjectSlug` 给 `patchMemory`（含 null 语义：JSON `"subjectSlug": null` = 移出分组；字段缺失 = 不改）。
- 失败显示错误（与现有 approve/reject 错误处理一致）。

## 5. 数据流

```
Stop hook → capture → scheduler.tick
  → listSubjectSlugs(scope)           # 现有 slug 清单
  → distillTranscript(..., existingSlugs)
      LLM 输出候选(含 subjectSlug)     # 优先复用清单
  → normalizeSubjectSlug 校验降级       # 非法 → null
  → dedup → judgeValue（不变）
  → createCandidate(..., subjectSlug)
→ 用户审批（UI 可改 slug）
→ SessionStart → listApprovedByScope（投影含 slug）
  → clipByBudget（不变）→ formatMemoryBlock 分组渲染
  → hookSpecificOutput.additionalContext
```

## 6. 失败模式

| 失败 | 行为 |
|------|------|
| LLM 不输出 slug / 输出非法格式 | 解析层降级 null，记忆照常入库，不 retry 不丢 |
| `listSubjectSlugs` 查询抛错 | scheduler 传空清单，distill 照常 |
| 迁移 `ALTER TABLE` 失败 | 与现有列迁移行为一致：`openDb` 内同步执行，失败即 `openDb` 抛错、daemon 启动失败并显式报错（不静默降级）。slug 是无回填的纯增量列，失败面与 `value_class` 迁移相同 |
| slug 同义碎裂（模型无视清单） | 残留风险：组碎成多个一条一组。缓解：D3 清单 + 用户审批时可改 slug 归并 |
| 老行 NULL slug | 渲染逐字节兼容现状 |
| UI PATCH 非法 slug | server 409（`MemoryConflictError`，与现有 PATCH 错误路径一致），UI 显示错误 |

## 7. 测试策略

必写 case：

1. **pure**：`normalizeSubjectSlug` 正反例（合法、大写转小写、空格/下划线/超长/非 string → null）；`formatMemoryBlock` 分组渲染（分组+未分组混合、节位置由首成员位置决定、组内顺序保持、裁剪后整组消失不出空节标题、全 NULL slug 输出与旧格式逐字节一致）。
2. **distiller**：user prompt 含现有 slug 清单（mock callLLM 断言）；`subjectSlug` 合法 / 非法（降级 null）/ 缺失三种解析路径；`ruleObject` 改名回归（旧 `subject` 键不再读取）。
3. **store**：`createCandidate`/`rowToMemory` slug 写入回读；`listSubjectSlugs` DISTINCT + 状态过滤 + global/project scope 规则 + LIMIT；`patchMemory` 改 slug / 置 null / 非法抛 `MemoryConflictError`。
4. **迁移**：无 `subject_slug` 列的老库打开后自动补列；老行读出 NULL。
5. **scheduler 集成**：tick 把 slug 清单传进 distiller（mock 断言 `existingSlugs`）。
6. **UI**：源代码层文本断言兜底（slug 输入框存在）。

回归防护命名：测试文件 / describe 标明锁定的是 subject-keyed 聚合。

## 8. 与现有模块的耦合点

- `src/memory/pure.ts`：`InjectableMemoryRow`、`formatMemoryBlock`、新增 `normalizeSubjectSlug`。
- `src/memory/distiller.ts`：`subject`→`ruleObject` 改名、新增 slug 输出与 prompt 段。
- `src/memory/valueFilter.ts`、`src/scheduler.ts`、`src/daemon.ts`：`ruleObject` 改名的机械跟随（不改逻辑）。
- `src/memory/store.ts`、`src/db/schema.ts`、`src/db/client.ts`：列、迁移、查询、patch。
- `src/server.ts`、`src/web/App.tsx`：PATCH 透传 + 审批 UI。
- 第二期（非本 spec 范围）：基于 `subject_slug` 的 LLM profile 合成层。

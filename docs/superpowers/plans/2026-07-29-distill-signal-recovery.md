# 蒸馏输入信号丢失（三层治）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让设计/brainstorming 会话能提取出富记忆（设计 rationale、被采纳的设计决策、subagent 任务产出的推理），同时不重新放开脑补/过度捕获。

**Architecture:** 三层一起治。第三层（主力）改 distiller 的 origin discipline prompt，放宽"agent 说过且被用户采纳的 rationale 可记"，加"必须 transcript 有出处"硬约束防脑补。第一层把 SubagentStop 钩子从早返回改为：用 payload 的 agent_id 定位该 subagent 自己的对话文件，单独蒸馏成独立任务（与主会话互不可见），标 sourceKind='subagent'。第二层把 assistant 文本截断上限从 8000 调到 20000，让长段设计分析不被腰斩。

**Tech Stack:** Bun + Hono + Drizzle + bun:sqlite（WAL）+ zod + @anthropic-ai/sdk；测试 bun:test。

## Global Constraints

- **测试门槛**：`bun run typecheck && bun test` 必须全绿才能 push。每个任务结束都跑一遍。
- **schema migration 幂等**：CREATE TABLE IF NOT EXISTS 风格；新列用 `ALTER TABLE ... ADD COLUMN`（PRAGMA table_info 守卫）；memories.source_kind 的 CHECK 扩展用表重建（旧库 CHECK 不含 'subagent' 时重建，见 Task 1）。沿用 client.ts 现有 dual-registration 模式（drizzle schema map + raw DDL）。
- **Windows EBUSY**：DB 测试沿用 fresh-subdir-per-test + afterEach-close-raw-handle 模式（见 tests/scheduler.test.ts:18-36）。
- **不直推 master**：在本分支 `feat/distill-signal-recovery` 上提交。
- **纯函数优先可测面**：路径推导、截断常量抽纯函数/常量测；prompt 用源代码层文本断言锁契约（LLM 遵循度非单测范围，与现有 distiller.test.ts 模式一致）。
- **subagent 蒸馏隔离**：subagent 文件单独蒸馏，主会话 Stop 蒸馏对 subagent 内容不可见；subagent 任务不更新主会话偏移。
- **双路兜底**：subagent 文件读取先试 agent_id 推路径 -> 退回 transcript_path -> 空 turns，任一失败不崩、不丢事件（仍 enqueue）。
- **distiller 逻辑不动**：只改 `DISTILLER_SYSTEM_PROMPT` 文本，不改 `distillTranscript` 逻辑、不改 `DistillCandidate` 接口。
- **不动的部分**：valueFilter、taming 检测、dedup、注入侧（SessionStart）、文件类工具结果压占位、预算裁剪机制。

---

## File Structure

- `src/db/schema.ts`（改）：`memoryDistillJobs` 加 `source_agent_id` 列；`memories.source_kind` enum 加 `'subagent'`。
- `src/db/client.ts`（改）：DDL 加新列 + 更新 source_kind CHECK；幂等 migration（ADD COLUMN source_agent_id + memories 表重建扩展 CHECK）。
- `src/memory/pure.ts`（改）：`NON_TOOL_CAP_CHARS` 8000 -> 20000。
- `src/memory/distiller.ts`（改）：重写 `DISTILLER_SYSTEM_PROMPT` 的 Origin discipline 段。
- `src/claude/transcript.ts`（改）：新增 `subagentFilePathFromPayload` 纯函数 + `loadSubagentTranscript` 双路兜底读取。
- `src/scheduler.ts`（改）：`EnqueueInput` 加 `sourceAgentId`；`enqueueDistillJob` 持久化；`TickDeps.loadTranscript` 入参加 `sourceAgentId`；`tick` 传参 + sourceKind 按 job 类型决定 + subagent 不更新偏移。
- `src/daemon.ts`（改）：`makeLoadTranscript` 对 subagent job（有 sourceAgentId）跳过偏移切片、返回全量。
- `src/server.ts`（改）：SubagentStop 分支由早返回改为 fire-and-forget 处理（loadSubagentTranscript + enqueue + 落 events）。
- 测试：`tests/schema.test.ts`、`tests/pure-transcript-filter.test.ts`、`tests/distiller.test.ts`、`tests/transcript.test.ts`、`tests/scheduler.test.ts`、`tests/server.test.ts`、`tests/daemon.test.ts`。

---

### Task 1: Schema — source_agent_id 列 + source_kind 'subagent' enum（含表重建 migration）

**Files:**
- Modify: `src/db/schema.ts:40-64`（memoryDistillJobs）、`src/db/schema.ts:16-18`（memories.source_kind）
- Modify: `src/db/client.ts:41-55`（memory_distill_jobs DDL）、`src/db/client.ts:17-38`（memories DDL）、`src/db/client.ts:120-134`（migration 区）
- Test: `tests/schema.test.ts`

**Interfaces:**
- Produces: `memoryDistillJobs.source_agent_id`（drizzle `sourceAgentId` 字段，nullable text）；`memories.source_kind` 接受 `'subagent'`。后续 Task 6/7 依赖此列与 enum。

- [ ] **Step 1: 写失败测试（schema.test.ts 末尾追加）**

```ts
test('memories.source_kind accepts subagent (CHECK widened)', () => {
  // 旧 CHECK ('conversation','error','manual') 会拒绝 'subagent'；扩展后必须接受。
  // 沿用 schema.test.ts 既有风格：raw db.insert(memories)（本文件已 import memories + eq）。
  db = openDb(join(dir, 't.db'))
  db.insert(memories).values({
    id: '01SUB', scopeType: 'global', scopeId: null, runtime: null,
    title: '[category:x] sub', bodyMd: 'b', tags: '[]', status: 'candidate',
    sourceKind: 'subagent', createdAt: 1, version: 1,
  }).run()
  const rows = db.select().from(memories).where(eq(memories.id, '01SUB')).all()
  expect(rows[0]!.sourceKind).toBe('subagent')
})

test('memory_distill_jobs has source_agent_id column', () => {
  db = openDb(join(dir, 't.db'))
  const pragma = db!.$client.prepare('PRAGMA table_info(memory_distill_jobs)').all() as { name: string }[]
  expect(pragma.some((c) => c.name === 'source_agent_id')).toBe(true)
})

test('old DB with narrow source_kind CHECK is rebuilt to accept subagent (idempotent)', () => {
  // 模拟旧库：手建一个 source_kind CHECK 不含 subagent 的 memories 表 + 一行数据，
  // 重新 openDb 触发 migration，断言：数据保留 + 'subagent' 插入不再被 CHECK 拒绝 + 幂等。
  const oldDbPath = join(dir, 'old.db')
  const raw = new Database(oldDbPath)
  raw.exec(`CREATE TABLE memories (
    id TEXT PRIMARY KEY, scope_type TEXT NOT NULL, scope_id TEXT, runtime TEXT,
    title TEXT NOT NULL, body_md TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL, source_kind TEXT NOT NULL CHECK (source_kind IN ('conversation','error','manual')),
    source_event_id TEXT, distill_job_id TEXT, distill_action TEXT,
    supersedes_id TEXT, superseded_by_id TEXT, approved_at INTEGER, created_at INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1, source_cwd TEXT, value_class TEXT, subject_slug TEXT,
    CHECK ((scope_type='global' AND scope_id IS NULL) OR (scope_type='project' AND scope_id IS NOT NULL))
  )`)
  raw.exec(`INSERT INTO memories (id, scope_type, scope_id, runtime, title, body_md, tags, status, source_kind, source_event_id, distill_job_id, distill_action, supersedes_id, superseded_by_id, approved_at, created_at, version, source_cwd, value_class, subject_slug)
    VALUES ('m-old','global',NULL,NULL,'old title','old body','[]','approved','conversation',NULL,NULL,NULL,NULL,NULL,1,100,1,NULL,NULL,NULL)`)
  raw.close()
  // 重新打开 -> 触发 migration（表重建扩展 CHECK）
  const db2 = openDb(oldDbPath)
  // 旧数据保留
  const rows = db2.select().from(memories).all()
  expect(rows.some((r: any) => r.id === 'm-old' && r.title === 'old title')).toBe(true)
  // 'subagent' 现在可插入（CHECK 已扩展）
  db2.insert(memories).values({
    id: 'm-new', scopeType: 'global', scopeId: null, runtime: null,
    title: 'sub', bodyMd: 'b', tags: '[]', status: 'candidate',
    sourceKind: 'subagent', createdAt: 1, version: 1,
  }).run()
  const got = db2.select().from(memories).where(eq(memories.id, 'm-new')).all()
  expect(got[0]!.sourceKind).toBe('subagent')
  db2.$client.close()
  // 再开一次 -> 幂等（不重复重建；'subagent' 仍可插）
  const db3 = openDb(oldDbPath)
  db3.insert(memories).values({
    id: 'm-new2', scopeType: 'global', scopeId: null, runtime: null,
    title: 'sub2', bodyMd: 'b', tags: '[]', status: 'candidate',
    sourceKind: 'subagent', createdAt: 2, version: 1,
  }).run()
  expect(db3.select().from(memories).where(eq(memories.id, 'm-new2')).all().length).toBe(1)
  db3.$client.close()
})
```

注意：schema.test.ts 的 `db` 是 `DbClient | null`，每个测试须先 `db = openDb(join(dir, 't.db'))`（见该文件既有测试 line 37-38 模式）。所需 import `Database`（已有，line 4）、`memories`（已有，line 6）、`eq`（已有，line 7）、`openDb`（已有，line 5）--**无需新增 import**。`memory_distill_jobs` 列检查用 `db.$client.prepare('PRAGMA table_info(...)')`（`$client` 是 raw 句柄，scheduler.test.ts:35 同款用法）。

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/schema.test.ts`
Expected: FAIL（source_kind='subagent' 被 CHECK 拒 / source_agent_id 列不存在）。

- [ ] **Step 3: 改 schema.ts**

`memories.source_kind` enum 加 `'subagent'`：

```ts
    sourceKind: text('source_kind', {
      enum: ['conversation', 'error', 'manual', 'subagent'],
    }).notNull(),
```

`memoryDistillJobs` 加列（在 `sessionId` 后、`scopeResolvedJson` 前或末尾均可，放 `sessionId` 后）：

```ts
    sessionId: text('session_id'), // 第五轮：claude code hook payload 的 session_id，增量偏移键
    sourceAgentId: text('source_agent_id'), // subagent 蒸馏任务的 agent_id；主会话任务为 null
```

- [ ] **Step 4: 改 client.ts DDL + migration**

DDL `memory_distill_jobs` CREATE TABLE 加列（紧跟 `session_id TEXT,`）：

```sql
      session_id TEXT,
      source_agent_id TEXT,
```

DDL `memories` CREATE TABLE 的 source_kind CHECK 更新：

```sql
      source_kind TEXT NOT NULL CHECK (source_kind IN ('conversation','error','manual','subagent')),
```

在 session_id migration 块（client.ts:120-134）之后追加两个幂等 migration 块：

```ts
  // Idempotent migration: add source_agent_id to memory_distill_jobs.
  // subagent 蒸馏任务的来源标识；主会话 job 为 NULL。无 backfill。
  {
    const cols = raw.prepare('PRAGMA table_info(memory_distill_jobs)').all() as { name: string }[]
    if (!cols.some((c) => c.name === 'source_agent_id')) {
      raw.exec('ALTER TABLE memory_distill_jobs ADD COLUMN source_agent_id TEXT')
    }
  }
  // Idempotent migration: widen memories.source_kind CHECK to include 'subagent'.
  // sqlite 无法 ALTER CHECK，旧库的窄 CHECK 会拒绝 source_kind='subagent' 插入。
  // 检测 sqlite_master 里的建表 SQL 是否已含 'subagent'；不含则表重建（保数据、重建索引）。
  {
    const tbl = raw.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='memories'").get() as { sql?: string } | undefined
    if (tbl?.sql && !tbl.sql.includes("'subagent'")) {
      raw.exec(`CREATE TABLE memories_new (
        id TEXT PRIMARY KEY,
        scope_type TEXT NOT NULL CHECK (scope_type IN ('project','global')),
        scope_id TEXT,
        runtime TEXT CHECK (runtime IN ('claude-code','opencode') OR runtime IS NULL),
        title TEXT NOT NULL,
        body_md TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL CHECK (status IN ('candidate','approved','archived','superseded','rejected')),
        source_kind TEXT NOT NULL CHECK (source_kind IN ('conversation','error','manual','subagent')),
        source_cwd TEXT,
        source_event_id TEXT,
        distill_job_id TEXT,
        distill_action TEXT CHECK (distill_action IN ('new','update_of','duplicate_of','conflict_with') OR distill_action IS NULL),
        supersedes_id TEXT,
        superseded_by_id TEXT,
        approved_at INTEGER,
        created_at INTEGER NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        subject_slug TEXT,
        value_class TEXT,
        CHECK ((scope_type='global' AND scope_id IS NULL) OR (scope_type='project' AND scope_id IS NOT NULL))
      )`)
      raw.exec(`INSERT INTO memories_new (id, scope_type, scope_id, runtime, title, body_md, tags, status, source_kind, source_cwd, source_event_id, distill_job_id, distill_action, supersedes_id, superseded_by_id, approved_at, created_at, version, subject_slug, value_class)
        SELECT id, scope_type, scope_id, runtime, title, body_md, tags, status, source_kind, source_cwd, source_event_id, distill_job_id, distill_action, supersedes_id, superseded_by_id, approved_at, created_at, version, subject_slug, value_class FROM memories`)
      raw.exec('DROP TABLE memories')
      raw.exec('ALTER TABLE memories_new RENAME TO memories')
      raw.exec('CREATE INDEX IF NOT EXISTS idx_memories_scope_status ON memories(scope_type, scope_id, status)')
      raw.exec('CREATE INDEX IF NOT EXISTS idx_memories_status_created ON memories(status, created_at)')
      raw.exec('CREATE INDEX IF NOT EXISTS idx_memories_subject ON memories(scope_type, scope_id, subject_slug)')
    }
  }
```

- [ ] **Step 5: 跑测试确认通过**

Run: `bun test tests/schema.test.ts`
Expected: PASS（含 3 条新测试）。注意旧库重建测试要确认 import 齐全。

- [ ] **Step 6: typecheck + 全量测试**

Run: `bun run typecheck && bun test`
Expected: PASS（其它测试不应受影响；schema 改动向后兼容）。

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.ts src/db/client.ts tests/schema.test.ts
git commit -m "feat(schema): source_agent_id 列 + source_kind 'subagent' enum（含旧库表重建 migration）"
```

---

### Task 2: 过滤上限放宽（NON_TOOL_CAP_CHARS 8000 -> 20000）

**Files:**
- Modify: `src/memory/pure.ts:210`
- Test: `tests/pure-transcript-filter.test.ts`

**Interfaces:**
- Produces: `NON_TOOL_CAP_CHARS` 值变为 20000（非导出常量，但行为通过 `filterTranscriptForDistill` 暴露）。

- [ ] **Step 1: 写失败测试（pure-transcript-filter.test.ts 追加 + 改既有）**

先改既有测试（行 43-51 `user/assistant over 8000 chars -> truncated` 与行 81-91 `per-turn caps widened`）的 8000 期望为 20000：

```ts
test('user/assistant over 20000 chars -> truncated', () => {
  const big = 'u'.repeat(25000)
  const out = filterTranscriptForDistill([
    { role: 'user', content: big },
    { role: 'assistant', content: big },
  ])
  expect(out[0]!.content.length).toBe(20000 + '…[truncated]'.length)
  expect(out[1]!.content.length).toBe(20000 + '…[truncated]'.length)
})

test('assistant text between 8000 and 20000 is NOT truncated (design rationale survives)', () => {
  // 第三层放开 origin discipline 后，设计 rationale（长段 assistant 文本）必须能完整
  // 进蒸馏输入。8000-20000 区间不再被腰斩。
  const mid = 'r'.repeat(15000)
  const out = filterTranscriptForDistill([{ role: 'assistant', content: mid }])
  expect(out[0]!.content).toBe(mid)
  expect(out[0]!.content).not.toContain('…[truncated]')
})

test('assistant text at exactly 20000 is not truncated; over 20000 is', () => {
  const exact = 'a'.repeat(20000)
  const over = 'a'.repeat(20001)
  expect(filterTranscriptForDistill([{ role: 'assistant', content: exact }])[0]!.content).toBe(exact)
  expect(filterTranscriptForDistill([{ role: 'assistant', content: over }])[0]!.content).toContain('…[truncated]')
})

test('empty string assistant passes through unchanged', () => {
  expect(filterTranscriptForDistill([{ role: 'assistant', content: '' }])[0]!.content).toBe('')
})
```

同时把行 81-91 的 `per-turn caps widened` 测试里 `8000` 期望改 `20000`（`expect(out[1]!.content.length).toBeLessThanOrEqual(20000 + '…[truncated]'.length)`）。

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/pure-transcript-filter.test.ts`
Expected: FAIL（仍按 8000 截断，15000 文本被截 / 20000 边界不符）。

- [ ] **Step 3: 改 pure.ts 常量**

```ts
const NON_TOOL_CAP_CHARS = 20000
```

（`pure.ts:210`，原值 8000。注释可补一句"放宽：设计 rationale 长段 assistant 文本不再腰斩"。）

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/pure-transcript-filter.test.ts`
Expected: PASS。

- [ ] **Step 5: typecheck + 全量测试**

Run: `bun run typecheck && bun test`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add src/memory/pure.ts tests/pure-transcript-filter.test.ts
git commit -m "feat(filter): NON_TOOL_CAP_CHARS 8000->20000，设计 rationale 不被腰斩"
```

---

### Task 3: distiller origin discipline 重平衡（prompt 文本）

**Files:**
- Modify: `src/memory/distiller.ts:56-65`（Origin discipline 段）
- Test: `tests/distiller.test.ts`

**Interfaces:**
- Consumes: 无（纯 prompt 文本改动）。
- Produces: 更新后的 `DISTILLER_SYSTEM_PROMPT`（导出不变，文本变）。

- [ ] **Step 1: 写失败测试（distiller.test.ts 追加 + 改既有）**

先改既有测试（行 198-209 `DISTILLER_SYSTEM_PROMPT has [stated] origin discipline with 6 exclusions`）：'推理或建议' 措辞改为 '推理过程'，并补放宽 + 硬约束断言：

```ts
test('DISTILLER_SYSTEM_PROMPT has [stated] origin discipline with放宽 + REJECT + hard约束', () => {
  // 第七轮（本 spec）：origin discipline 重平衡。第3/6条放宽（agent 说过且被用户采纳
  // 的设计 rationale 可记）；第1/2/4/5条维持 REJECT；加"必须 transcript 有出处"硬约束
  // 防脑补。源码层文本断言锁 prompt 契约（LLM 遵循度由 dogfood 验证，非单测范围）。
  expect(DISTILLER_SYSTEM_PROMPT).toContain('Origin discipline')
  // 维持 REJECT 的四类关键词仍在
  expect(DISTILLER_SYSTEM_PROMPT).toContain('推断')        // 第1条 脑补闸门
  expect(DISTILLER_SYSTEM_PROMPT).toContain('前瞻')        // 第2条
  expect(DISTILLER_SYSTEM_PROMPT).toContain('研究输出')    // 第3条 研究输出仍 REJECT
  expect(DISTILLER_SYSTEM_PROMPT).toContain('丰富化')      // 第4条
  expect(DISTILLER_SYSTEM_PROMPT).toContain('道听途说')    // 第5条
  // 放宽：agent 给出且被用户采纳的设计 rationale 可记
  expect(DISTILLER_SYSTEM_PROMPT).toContain('被用户采纳')
  expect(DISTILLER_SYSTEM_PROMPT).toContain('rationale')
  // 硬约束：必须 transcript 有出处（防脑补）
  expect(DISTILLER_SYSTEM_PROMPT).toContain('出处')
})
```

再加一条集成测试，断言带 agent rationale 的 transcript 能完整进 distiller 的 user prompt（即 rationale 没在过滤/渲染阶段被丢）：

```ts
test('agent rationale in transcript reaches distiller prompt unfiltered (layer 2+3 signal survival)', async () => {
  // 正向信号存活：agent 在 transcript 里说的设计 rationale（长段 assistant 文本）
  // 必须能进 distiller 的 user prompt，这样第三层放开的 origin discipline 才有素材可提取。
  // 锁住"过滤不丢 rationale 文本"+"渲染把它拼进 prompt"。
  const rationale = '选 bun 脚本而非 concurrently，因为跨平台、契合 Bun 栈、生产模式只占一个进程一个端口'
  let captured = ''
  await distillTranscript({
    turns: [
      { role: 'assistant', content: `方案 A 推荐：${rationale}` },
      { role: 'user', content: '就 A 吧，两个模式都要' },
    ],
    runtime: 'claude-code', cwd: '/r', existingSlugs: [],
    callLLM: async (_sys, user) => { captured = user; return JSON.stringify({ candidates: [] }) },
  })
  expect(captured).toContain(rationale)
  expect(captured).toContain('就 A 吧')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/distiller.test.ts`
Expected: FAIL（'被用户采纳'/'rationale'/'出处' 不在 prompt 里；rationale 集成测试可能因 8000 截断失败——但 Task 2 已把上限调到 20000，rationale 短不会被截，故此条应只因 prompt 文本未改而捕获失败取决于断言——实际 'captured 含 rationale' 在 Task 2 后应已通过，真正失败的是文本断言）。

- [ ] **Step 3: 改 distiller.ts 的 Origin discipline 段**

把 `distiller.ts:56-65` 整段替换为：

```
Origin discipline（[stated] 起源判定）：记用户或领域在会话中明确陈述的持久事实、规则、决策与约束；也记 agent 在 transcript 中明确给出、且被用户采纳的设计 rationale（"为什么"是承重的）。REJECT (emit nothing) 以下内容——它们不该当作记忆：
1. 你自己推出的结论或推断（用户没明说，是你脑补的因果、意图或规律）——脑补闸门，必须 REJECT。
2. 前瞻状态、待办、下一步计划（"以后要 X"、"接下来做 Y"）——意图、非已成事实，会过期。
3. 研究输出：搜索结果、文档摘录（纯信息搬运，非设计 rationale）。
4. 对用户原话的丰富化或升级（用户说"用 bun"，你写成"用户强烈推崇 bun 生态"）。
5. 道听途说（"听说 X"、"人们说 Y"），非用户直接陈述。
6. agent 自言自语的推理过程（未经用户采纳的散漫推理）；但 agent 给出且被用户采纳的设计 rationale 可记。
硬约束：记 rationale 时必须能在所给 transcript 中找到 agent 原话出处；找不到出处的不记（防止脑补）。
```

（其余 prompt 段落——category 列表、ruleObject 判定、subjectSlug、输出格式 JSON 模板——一律不动。）

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/distiller.test.ts`
Expected: PASS（含改后的 origin discipline 测试 + rationale 存活集成测试）。注意检查既有测试 `rejects codebase implementation details`（行 119-121，断言含 '被开发仓库自身源码的实现细节'）仍通过——该句在 REJECT 末段（distiller.ts:65 附近），未被本次替换触及，应仍存在；若被误删需补回。

- [ ] **Step 5: typecheck + 全量测试**

Run: `bun run typecheck && bun test`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add src/memory/distiller.ts tests/distiller.test.ts
git commit -m "feat(distiller): origin discipline 重平衡——采纳的 agent rationale 可记 + 出处硬约束"
```

---

### Task 4: subagent 文件路径推导纯函数

**Files:**
- Modify: `src/claude/transcript.ts`（末尾追加导出函数）
- Test: `tests/transcript.test.ts`

**Interfaces:**
- Produces: `subagentFilePathFromPayload(transcriptPath: string, agentId: string | null | undefined): string | null`。规则：transcriptPath 形如 `<dir>/<sid>.jsonl`，去末尾 `.jsonl` 当目录，拼 `subagents/agent-<agentId>.jsonl`。agentId 空 / transcriptPath 非 `.jsonl` 结尾 / 空串 -> null。

- [ ] **Step 1: 写失败测试（transcript.test.ts 追加）**

```ts
import { subagentFilePathFromPayload } from '@/claude/transcript'
// transcript.test.ts 顶部既有 import（line 4）：parseTranscriptFile, extractText。
// 改为加 subagentFilePathFromPayload：import { parseTranscriptFile, extractText, subagentFilePathFromPayload } from '@/claude/transcript'
// （loadSubagentTranscript 的 import 与测试在 Task 5 加。）

test('subagentFilePathFromPayload: normal main-session path -> subagent file path', () => {
  const tp = '/home/u/.claude/projects/C--repo/abc-123.jsonl'
  expect(subagentFilePathFromPayload(tp, 'a0696f74')).toBe(
    '/home/u/.claude/projects/C--repo/abc-123/subagents/agent-a0696f74.jsonl',
  )
})

test('subagentFilePathFromPayload: Windows-style path', () => {
  const tp = 'C:\\Users\\u\\.claude\\projects\\C--repo\\abc-123.jsonl'
  expect(subagentFilePathFromPayload(tp, 'xyz')).toBe(
    'C:\\Users\\u\\.claude\\projects\\C--repo\\abc-123\\subagents\\agent-xyz.jsonl',
  )
})

test('subagentFilePathFromPayload: agentId empty -> null', () => {
  expect(subagentFilePathFromPayload('/x/abc.jsonl', '')).toBeNull()
  expect(subagentFilePathFromPayload('/x/abc.jsonl', null)).toBeNull()
  expect(subagentFilePathFromPayload('/x/abc.jsonl', undefined)).toBeNull()
})

test('subagentFilePathFromPayload: non-jsonl transcriptPath -> null', () => {
  expect(subagentFilePathFromPayload('/x/abc.txt', 'ag')).toBeNull()
  expect(subagentFilePathFromPayload('/x/abc', 'ag')).toBeNull()
})

test('subagentFilePathFromPayload: empty transcriptPath -> null', () => {
  expect(subagentFilePathFromPayload('', 'ag')).toBeNull()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/transcript.test.ts`
Expected: FAIL（`subagentFilePathFromPayload` 未导出/未定义）。

- [ ] **Step 3: 实现（transcript.ts 末尾追加）**

```ts
/**
 * Derive the subagent's own transcript file path from a SubagentStop payload's
 * `transcript_path` (main-session `<dir>/<sid>.jsonl`) + `agent_id`. The
 * subagent file lives at `<dir>/<sid>/subagents/agent-<agentId>.jsonl`
 * (verified on disk against claude code 2.1.220). Returns null when the inputs
 * can't yield a valid path (agentId empty, transcriptPath not a .jsonl, etc.)
 * so callers can fall back to the raw transcript_path. Pure + never throws.
 */
export function subagentFilePathFromPayload(
  transcriptPath: string,
  agentId: string | null | undefined,
): string | null {
  try {
    if (!transcriptPath || !transcriptPath.endsWith('.jsonl')) return null
    if (!agentId) return null
    // strip trailing '.jsonl' -> the <sid> directory; join with subagents/agent-<id>.jsonl
    const sep = transcriptPath.includes('\\') && !transcriptPath.includes('/') ? '\\' : '/'
    const base = transcriptPath.slice(0, -'.jsonl'.length)
    return `${base}${sep}subagents${sep}agent-${agentId}.jsonl`
  } catch {
    return null
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/transcript.test.ts`
Expected: PASS。

- [ ] **Step 5: typecheck + 全量测试**

Run: `bun run typecheck && bun test`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add src/claude/transcript.ts tests/transcript.test.ts
git commit -m "feat(transcript): subagentFilePathFromPayload 纯函数（payload->subagent 文件路径）"
```

---

### Task 5: subagent transcript 双路兜底读取

**Files:**
- Modify: `src/claude/transcript.ts`（追加 `loadSubagentTranscript`）
- Test: `tests/transcript.test.ts`

**Interfaces:**
- Consumes: `subagentFilePathFromPayload`（Task 4）、`parseTranscriptFile`（既有）。
- Produces: `loadSubagentTranscript(transcriptPath: string, agentId: string | null | undefined): TranscriptTurn[]`。三态：① agent_id 推路径命中 -> 解析该文件；② 推不出或读不到 -> 退回 parseTranscriptFile(transcriptPath)；③ 都读不到 -> []。永不抛。

- [ ] **Step 1: 写失败测试（transcript.test.ts 追加）**

用真实 fixture 文件，放 per-test `dir`（.tmp-transcript/<rand>，beforeEach 已建；transcript.test.ts 已 import writeFileSync/mkdirSync/join）。

```ts
// Task 4 已把 line 4 改为含 subagentFilePathFromPayload；本任务再加 loadSubagentTranscript：
// import { parseTranscriptFile, extractText, subagentFilePathFromPayload, loadSubagentTranscript } from '@/claude/transcript'

test('loadSubagentTranscript: agent_id path hit -> parses subagent file', () => {
  // 主会话 dir/sess-1.jsonl；subagent 文件 dir/sess-1/subagents/agent-AG.jsonl
  mkdirSync(join(dir, 'sess-1', 'subagents'), { recursive: true })
  const mainPath = join(dir, 'sess-1.jsonl')
  writeFileSync(mainPath, JSON.stringify({ type: 'user', message: { role: 'user', content: 'MAIN SESSION' } }) + '\n')
  const subPath = join(dir, 'sess-1', 'subagents', 'agent-AG.jsonl')
  writeFileSync(subPath, JSON.stringify({ type: 'user', message: { role: 'user', content: 'SUBAGENT INTERNAL' } }) + '\n')
  const turns = loadSubagentTranscript(mainPath, 'AG')
  expect(turns.length).toBe(1)
  expect(turns[0]!.content).toBe('SUBAGENT INTERNAL')
  expect(turns[0]!.content).not.toBe('MAIN SESSION')
})

test('loadSubagentTranscript: agent_id path miss -> falls back to transcript_path', () => {
  const mainPath = join(dir, 'sess-2.jsonl')
  writeFileSync(mainPath, JSON.stringify({ type: 'user', message: { role: 'user', content: 'FALLBACK TO MAIN' } }) + '\n')
  // 不建 subagents 目录 -> 推路径读不到 -> 退回 mainPath
  const turns = loadSubagentTranscript(mainPath, 'NOPE')
  expect(turns.length).toBe(1)
  expect(turns[0]!.content).toBe('FALLBACK TO MAIN')
})

test('loadSubagentTranscript: both miss -> empty (no throw)', () => {
  const turns = loadSubagentTranscript(join(dir, 'nope.jsonl'), 'AG')
  expect(turns).toEqual([])
  // agentId 空 + 无 transcript_path 也空
  expect(loadSubagentTranscript('', 'AG')).toEqual([])
  expect(loadSubagentTranscript(join(dir, 'x.jsonl'), '')).toEqual([])
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/transcript.test.ts`
Expected: FAIL（`loadSubagentTranscript` 未定义）。

- [ ] **Step 3: 实现（transcript.ts 追加）**

```ts
import { existsSync } from 'node:fs'  // 顶部 import 区补（若未有）

/**
 * Load a subagent's own transcript with double-fallback (spec 第一层):
 * 1. Try the path derived from (transcriptPath, agentId) via subagentFilePathFromPayload.
 * 2. If that yields no path or the file is absent, fall back to parseTranscriptFile(transcriptPath).
 * 3. If neither reads, return [].
 * Never throws — degrades to [] on any fs/parse error so the caller can still enqueue
 * (preserve capture signal, don't drop the event). The subagent file format matches the
 * main session's (verified), so parseTranscriptFile reads it directly.
 */
export function loadSubagentTranscript(
  transcriptPath: string,
  agentId: string | null | undefined,
): TranscriptTurn[] {
  try {
    const subPath = subagentFilePathFromPayload(transcriptPath, agentId)
    if (subPath && existsSync(subPath)) {
      const turns = parseTranscriptFile(subPath)
      if (turns.length > 0) return turns
    }
    if (transcriptPath) {
      return parseTranscriptFile(transcriptPath)
    }
    return []
  } catch {
    return []
  }
}
```

（`parseTranscriptFile` 已在 transcript.ts 内定义；`existsSync` 从 `node:fs` import。若 transcript.ts 顶部已 import `readFileSync, statSync`，追加 `existsSync`。）

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/transcript.test.ts`
Expected: PASS。

- [ ] **Step 5: typecheck + 全量测试**

Run: `bun run typecheck && bun test`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add src/claude/transcript.ts tests/transcript.test.ts
git commit -m "feat(transcript): loadSubagentTranscript 双路兜底读取 subagent 文件"
```

---

### Task 6: scheduler 接线 sourceAgentId（enqueue 持久化 + sourceKind + 偏移守卫）

**Files:**
- Modify: `src/scheduler.ts:18-37`（EnqueueInput + enqueueDistillJob）、`src/scheduler.ts:39-46`（TickDeps.loadTranscript 签名）、`src/scheduler.ts:122-124`（tick 传参）、`src/scheduler.ts:173-188`（sourceKind）、`src/scheduler.ts:199-202`（setSessionOffset 守卫）
- Modify: `src/daemon.ts:33-54`（makeLoadTranscript subagent 全量）
- Test: `tests/scheduler.test.ts`、`tests/daemon.test.ts`

**Interfaces:**
- Consumes: `memoryDistillJobs.source_agent_id` 列（Task 1）。
- Produces: `EnqueueInput.sourceAgentId?: string | null`；`TickDeps['loadTranscript']` 入参对象增加 `sourceAgentId: string | null`；tick 对 subagent job（sourceAgentId 非空）传 sourceKind='subagent' 且不更新偏移。

- [ ] **Step 1: 写失败测试（scheduler.test.ts 追加）**

```ts
test('tick: subagent job (sourceAgentId set) -> sourceKind=subagent in createCandidate', async () => {
  const { jobId } = await enqueueDistillJob(db, {
    sourceEventId: 'sub-1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0,
    sourceAgentId: 'agent-XYZ',
  })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  let captured: any = null
  await tick(db, {
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'subagent did X' }], fullLength: 1 }),
    callLLM: async () => JSON.stringify({ candidates: [{ title: '[category:architecture] subagent rationale', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] }),
    createCandidate: async (_db, input) => { captured = input; return { id: 'c1', status: 'candidate', version: 1 } as any },
  })
  expect(captured.sourceKind).toBe('subagent')
})

test('tick: subagent job does NOT update session offset (even if sessionId present)', async () => {
  const { getSessionOffset } = await import('@/memory/store')
  const { jobId } = await enqueueDistillJob(db, {
    sourceEventId: 'sub-2', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0,
    sessionId: 'sess-sub', sourceAgentId: 'agent-OFF',
  })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  await tick(db, {
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'x' }], fullLength: 1 }),
    callLLM: async () => JSON.stringify({ candidates: [{ title: '[category:x] t', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] }),
    createCandidate: async () => ({ id: 'c1', status: 'candidate', version: 1 } as any),
  })
  // subagent job 不更新偏移：sess-sub 无记录（getSessionOffset 返回 0 且无行）
  expect(await getSessionOffset(db, 'sess-sub')).toBe(0)
  const offs = await db.select().from(memorySessionOffsets)
  expect(offs.length).toBe(0)
})

test('tick: main-session job (no sourceAgentId) still uses sourceKind=conversation + updates offset', async () => {
  const { getSessionOffset } = await import('@/memory/store')
  const { jobId } = await enqueueDistillJob(db, {
    sourceEventId: 'main-1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0,
    sessionId: 'sess-main',
  })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  let captured: any = null
  await tick(db, {
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'x' }], fullLength: 7 }),
    callLLM: async () => JSON.stringify({ candidates: [{ title: '[category:x] t', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] }),
    createCandidate: async (_db, input) => { captured = input; return { id: 'c1', status: 'candidate', version: 1 } as any },
  })
  expect(captured.sourceKind).toBe('conversation')
  expect(await getSessionOffset(db, 'sess-main')).toBe(7)
})
```

daemon.test.ts 追加（makeLoadTranscript 对 subagent job 跳过切片）。**需补 import**：该文件现 import `runDistillOnce, sweepStuckRunning` from `@/daemon`（line 7）-> 加 `makeLoadTranscript`；现 import `memoryDistillJobs, memoryDistillEvents` from `@/db/schema`（line 8）-> 加 `memorySessionOffsets`。

```ts
test('makeLoadTranscript: subagent job (sourceAgentId) returns full turns, ignores session offset', async () => {
  // 即使 subagent job 带 sessionId + 偏移表有记录，也必须返回全量（subagent 一次性，不切片）
  const { jobId } = await enqueueDistillJob(db, {
    sourceEventId: 'sub-lt', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0,
    sessionId: 'sess-lt', sourceAgentId: 'agent-LT',
  })
  await db.insert(memoryDistillEvents).values({
    distillJobId: jobId, attemptIndex: 0, ts: 1, kind: 'conversation',
    payload: JSON.stringify([
      { role: 'user', content: 'A' }, { role: 'user', content: 'B' }, { role: 'user', content: 'C' },
    ]),
  })
  // 预置偏移 = 2（正常会 slice(2) 只给 1 turn）；subagent 必须忽略、返回全量 3
  await db.insert(memorySessionOffsets).values({ sessionId: 'sess-lt', lastTurnOffset: 2, updatedAt: Date.now() })
  const loadTranscript = makeLoadTranscript(db)
  const result = await loadTranscript({ id: jobId, cwd: '/r', sourceEventId: 'sub-lt', sessionId: 'sess-lt', sourceAgentId: 'agent-LT' })
  expect(result.turns.length).toBe(3)
  expect(result.fullLength).toBe(3)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/scheduler.test.ts tests/daemon.test.ts`
Expected: FAIL（EnqueueInput 无 sourceAgentId / loadTranscript 签名无 sourceAgentId / sourceKind 仍硬编码 conversation / subagent 仍切片）。

- [ ] **Step 3: 改 scheduler.ts**

`EnqueueInput` 加字段（scheduler.ts:18-25）：

```ts
export interface EnqueueInput {
  sourceEventId: string
  runtime: 'claude-code' | 'opencode'
  cwd: string
  debounceKey: string
  debounceMs?: number
  sessionId?: string  // 第五轮：会话键，用于增量偏移
  sourceAgentId?: string | null  // subagent 蒸馏任务的 agent_id；主会话任务为 null/不传
}
```

`enqueueDistillJob` 持久化（scheduler.ts:31-35，在 values 里加）：

```ts
  await db.insert(memoryDistillJobs).values({
    id, debounceKey: input.debounceKey, sourceEventId: input.sourceEventId,
    runtime: input.runtime, cwd: input.cwd, sessionId: input.sessionId ?? null,
    sourceAgentId: input.sourceAgentId ?? null,
    status: 'pending', attempts: 0, nextRunAt, createdAt: now, finishedAt: null,
  })
```

`TickDeps.loadTranscript` 签名加 sourceAgentId（scheduler.ts:40-42）：

```ts
  loadTranscript: (job: {
    id: string; cwd: string | null; sourceEventId: string; sessionId: string | null
    sourceAgentId: string | null
  }) => Promise<{ turns: TranscriptTurn[]; fullLength: number }>
```

`tick` 传参（scheduler.ts:122-124）：

```ts
      const { turns: newTurns, fullLength } = await deps.loadTranscript({
        id: job.id, cwd: job.cwd, sourceEventId: job.sourceEventId,
        sessionId: job.sessionId ?? null, sourceAgentId: (job.sourceAgentId as string | null) ?? null,
      })
```

`createCandidate` 的 sourceKind（scheduler.ts:180，替换硬编码 `'conversation'`）：

```ts
          sourceKind: job.sourceAgentId ? 'subagent' : 'conversation',
```

`setSessionOffset` 守卫（scheduler.ts:199，加 `&& !job.sourceAgentId`）：

```ts
      if (job.sessionId && !job.sourceAgentId) {
```

- [ ] **Step 4: 改 daemon.ts makeLoadTranscript**

在 `makeLoadTranscript` 里、`if (!job.sessionId)` 之前加 subagent 全量早返回（daemon.ts:46 之前）：

```ts
    const fullLength = turns.length
    // subagent 蒸馏任务：一次性全量，不按 session 偏移切片（spec 第一层）。
    if (job.sourceAgentId) return { turns, fullLength }
    // 无 sessionId（历史 job）-> 全量返回，向后兼容（不切片、不更新偏移）。
    if (!job.sessionId) return { turns, fullLength }
```

- [ ] **Step 5: 跑测试确认通过**

Run: `bun test tests/scheduler.test.ts tests/daemon.test.ts`
Expected: PASS（含 4 条新测试）。注意既有 scheduler 测试 mock loadTranscript 多用 `async () => (...)` 忽略入参，签名加字段不破坏它们；但需 typecheck 确认 `job.sourceAgentId` 类型可达（drizzle schema 已加该列，Task 1）。

- [ ] **Step 6: typecheck + 全量测试**

Run: `bun run typecheck && bun test`
Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add src/scheduler.ts src/daemon.ts tests/scheduler.test.ts tests/daemon.test.ts
git commit -m "feat(scheduler): subagent job 走 sourceKind=subagent + 跳过偏移切片/更新"
```

---

### Task 7: server SubagentStop 分支真正处理（fire-and-forget 蒸馏）

**Files:**
- Modify: `src/server.ts:73-75`（body 类型加 agent_id）、`src/server.ts:110-115`（SubagentStop 分支改写）
- Test: `tests/server.test.ts:153-173`（改既有 SubagentStop 测试 + 加 agent_id 路径测试）

**Interfaces:**
- Consumes: `loadSubagentTranscript`（Task 5）、`enqueueDistillJob` 的 `sourceAgentId`（Task 6）、`parseTranscriptFile`（既有，loadSubagentTranscript 内部用）。
- Produces: SubagentStop 钩子现在 enqueue + 落 memory_distill_events + broadcast，而非早返回。

- [ ] **Step 1: 写失败测试（改 server.test.ts:153-173 的既有测试 + 追加）**

把既有 `collector SubagentStop is skipped...` 测试改为断言"现在会处理"：

```ts
test('collector SubagentStop now enqueues + stores event + broadcasts (subagent distill)', async () => {
  // 第七轮（本 spec）：SubagentStop 不再早返回。payload 带 agent_id -> 定位 subagent
  // 自己的文件 -> 单独蒸馏。这里 transcript_path 指向一个 fixture（双路兜底退回它），
  // 断言 enqueue（带 sourceAgentId）+ 落 event + broadcast。
  const fixturePath = writeJsonlFixture('sub.jsonl', {
    type: 'user', message: { role: 'user', content: 'subagent internal turn' },
  })
  const beforeEvents = await db.select().from(memoryDistillEvents)
  const r = await req('/hooks/claude/SubagentStop', {
    method: 'POST',
    body: JSON.stringify({ sourceEventId: 'e3', cwd: '/r', transcript_path: fixturePath, session_id: 'sess-1', agent_id: 'ag-1' }),
    headers: { 'content-type': 'application/json' },
  })
  expect(r.status).toBe(202)
  await new Promise((res) => setTimeout(res, 50))
  // enqueue 被调用，且带 sourceAgentId
  expect(enqueueCalls.length).toBe(1)
  expect(enqueueCalls[0]).toMatchObject({ sourceEventId: 'e3', runtime: 'claude-code', cwd: '/r', debounceKey: '/r:SubagentStop' })
  expect(enqueueCalls[0]!.sourceAgentId).toBe('ag-1')
  // 落了 event（含 subagent 内部 turn）
  const events = await db.select().from(memoryDistillEvents)
  expect(events.length).toBe(beforeEvents.length + 1)
  expect(events[events.length - 1]!.payload).toContain('subagent internal turn')
  // broadcast 了 capture
  expect(broadcastCalls.length).toBeGreaterThanOrEqual(1)
})

test('collector SubagentStop with agent_id hitting subagent file (double-fallback path 1)', async () => {
  // agent_id 推路径命中真实 subagent 文件 -> 落的 event 含 subagent 内容、不含主会话内容
  const subDir = join(dir, 'sess-ff', 'subagents')
  mkdirSync(subDir, { recursive: true })
  const mainPath = join(dir, 'sess-ff.jsonl')
  writeFileSync(mainPath, JSON.stringify({ type: 'user', message: { role: 'user', content: 'MAIN' } }) + '\n')
  const subPath = join(subDir, 'agent-ff.jsonl')
  writeFileSync(subPath, JSON.stringify({ type: 'user', message: { role: 'user', content: 'SUBAGENT-FF' } }) + '\n')
  await req('/hooks/claude/SubagentStop', {
    method: 'POST',
    body: JSON.stringify({ sourceEventId: 'e-ff', cwd: '/r', transcript_path: mainPath, agent_id: 'ff' }),
    headers: { 'content-type': 'application/json' },
  })
  await new Promise((res) => setTimeout(res, 50))
  const events = await db.select().from(memoryDistillEvents)
  const last = events[events.length - 1]!
  expect(last.payload).toContain('SUBAGENT-FF')
  expect(last.payload).not.toContain('MAIN')
})

test('collector SubagentStop still acks 202 when enqueue rejects, broadcasts failure', async () => {
  const bc: unknown[] = []
  app = createApp({
    db, adapter,
    enqueueDistillJob: async () => { throw new Error('SQLITE_BUSY') },
    broadcast: (m: unknown) => { bc.push(m) },
  })
  const r = await req('/hooks/claude/SubagentStop', {
    method: 'POST',
    body: JSON.stringify({ sourceEventId: 'e-rej', cwd: '/r', transcript_path: '', agent_id: 'ag' }),
    headers: { 'content-type': 'application/json' },
  })
  expect(r.status).toBe(202)
  await new Promise((res) => setTimeout(res, 50))
  expect(bc.some((m: any) => m.type === 'memory.enqueue.failed' && m.sourceEventId === 'e-rej')).toBe(true)
})
```

（server.test.ts 顶部 import 已有 `mkdirSync, writeFileSync`、`join`，沿用。）

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/server.test.ts`
Expected: FAIL（SubagentStop 仍早返回，enqueueCalls=0 / events 不增）。

- [ ] **Step 3: 改 server.ts**

body 类型加 agent_id（server.ts:73-75）：

```ts
    const body = await c.req.json().catch(() => ({}) as {
      transcript_path?: string; cwd?: string; sourceEventId?: string; session_id?: string; agent_id?: string
    })
```

顶部 import 加 `loadSubagentTranscript`（server.ts:9 附近，与 `parseTranscriptFile` 同来源）：

```ts
import { parseTranscriptFile, loadSubagentTranscript } from '@/claude/transcript'
```

把 SubagentStop 早返回分支（server.ts:110-115）整段替换为处理逻辑（参照 Stop 分支的 fire-and-forget IIFE，server.ts:144-160）：

```ts
    // SubagentStop（第七轮）：不再早返回。payload 带 agent_id -> loadSubagentTranscript
    // 定位该 subagent 自己的对话文件（双路兜底）-> 单独蒸馏成独立任务（与主会话互不可见）。
    // subagent 一次性任务，不传 sessionId（不更新主会话偏移）；sourceAgentId 标来源。
    if (event === 'SubagentStop') {
      const agentId: string = body.agent_id ?? ''
      const transcriptPath: string = body.transcript_path ?? ''
      const sourceEventId: string = body.sourceEventId ?? `${event}-${Date.now()}`
      const debounceKey = `${cwd}:${event}`
      const sourceKind = 'conversation'  // events.kind：对话型数据（subagent 区分在 job.source_agent_id）
      void (async () => {
        try {
          const turns = loadSubagentTranscript(transcriptPath, agentId)
          const { jobId } = await deps.enqueueDistillJob(deps.db, {
            sourceEventId, runtime: 'claude-code', cwd, debounceKey, sourceAgentId: agentId || null,
          })
          await deps.db.insert(memoryDistillEvents).values({
            distillJobId: jobId, attemptIndex: 0, ts: Date.now(),
            kind: sourceKind, payload: JSON.stringify(turns),
          })
        } catch (e) {
          deps.broadcast({ type: 'memory.enqueue.failed', sourceEventId, error: String(e) })
        }
      })()
      deps.broadcast({ type: 'memory.capture', sourceEventId })
      return c.json({ ok: true }, 202)
    }
```

（注意：此分支必须放在 Stop 分支之前（保持 server.ts:113 原位置），否则会落到 Stop 的通用逻辑。Stop 分支的 `event === 'Stop'` 判断仍在更下方——实际上当前代码 Stop 不是显式 `if (event==='Stop')` 而是早返回后的 fall-through。确认替换后 SubagentStop 的 if 在 PostToolUse 之后、Stop fall-through 之前，与原位置一致。）

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/server.test.ts`
Expected: PASS（含 3 条新/改测试）。

- [ ] **Step 5: typecheck + 全量测试**

Run: `bun run typecheck && bun test`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add src/server.ts tests/server.test.ts
git commit -m "feat(server): SubagentStop 分支真正处理——单独蒸馏该 subagent"
```

---

### Task 8: 全量验证 + STATE.md 更新

**Files:**
- Modify: `STATE.md`（记录本轮变更）
- 无新测试（验证性任务）

- [ ] **Step 1: 全量 typecheck + 测试**

Run: `bun run typecheck && bun test`
Expected: 全绿。若有红，回对应 Task 修。

- [ ] **Step 2: grep 复核无残留早返回 / 硬编码**

```bash
grep -n "SubagentStop" src/server.ts   # 确认分支是处理逻辑而非 return c.json({ok:true},202) 早返回
grep -n "sourceKind: 'conversation'" src/scheduler.ts  # 确认已改为 job.sourceAgentId ? 'subagent' : 'conversation'
```

Expected: server.ts 的 SubagentStop 分支含 loadSubagentTranscript + enqueue；scheduler.ts 无硬编码 `sourceKind: 'conversation'`（应为三元表达式）。

- [ ] **Step 3: 更新 STATE.md**

在 STATE.md 的进度/已知债务区追加一轮记录（日期 2026-07-29，分支 feat/distill-signal-recovery），简述三层治：origin discipline 重平衡、subagent 单独蒸馏、过滤上限 20000。标注 spec/plan 路径。

- [ ] **Step 4: Commit + 推远端开 PR**

```bash
git add STATE.md
git commit -m "docs(state): record distill signal recovery three-layer fix round"
git push -u origin feat/distill-signal-recovery
```

开 PR 合并回 master（标题按改动类型，如 `feat: 蒸馏输入信号丢失三层治（origin discipline 重平衡 + subagent 单独蒸馏 + 过滤上限放宽）`）。

---

## Self-Review

**1. Spec coverage:**
- 第三层 origin discipline 重平衡（第3/6条放宽、1/2/4/5维持、硬约束）-> Task 3。✓
- 第一层 subagent 单独蒸馏（SubagentStop 处理、agent_id 定位、双路兜底、sourceKind='subagent'、与主会话隔离、不更新偏移）-> Task 1（schema）、4（路径）、5（读取）、6（scheduler）、7（server）。✓
- 第二层过滤上限 8000->20000 -> Task 2。✓
- schema source_kind enum + source_agent_id 列 + 幂等 migration -> Task 1。✓（修正了 spec failure-mode 关于"enum 无强制约束"的事实错误——实际有 CHECK，需表重建。）
- 测试策略各项：origin discipline 正向/反向（Task 3 文本断言 + rationale 存活集成；反向脑补防护为 LLM 行为，以硬约束文本断言为 proxy，已诚实标注）、subagentFilePathFromPayload 纯函数（Task 4）、双路兜底三态（Task 5）、scheduler 主会话/subagent 区分（Task 6）、server SubagentStop 改断言（Task 7）、过滤边界（Task 2）。✓
- 运行门槛 `bun run typecheck && bun test` 全绿 -> 每个 Task 末尾 + Task 8。✓

**2. Placeholder scan:** 无 TBD/TODO；每步含实际代码或具体命令。✓

**3. Type consistency:**
- `sourceAgentId`（drizzle 字段名）/ `source_agent_id`（DB 列名）一致（drizzle 映射 `text('source_agent_id')` -> `sourceAgentId`）。✓
- `loadSubagentTranscript(transcriptPath, agentId)` 签名在 Task 5 定义、Task 7 调用一致。✓
- `subagentFilePathFromPayload(transcriptPath, agentId)` Task 4 定义、Task 5 调用一致。✓
- `EnqueueInput.sourceAgentId?: string | null` Task 6 定义、Task 7 传 `sourceAgentId: agentId || null` 一致。✓
- `TickDeps.loadTranscript` 入参 `sourceAgentId: string | null` Task 6 定义，daemon.test.ts Task 6 测试传 `sourceAgentId: 'agent-LT'` 一致。✓
- `sourceKind: 'subagent'` 与 schema enum `'subagent'` 一致。✓

**4. 已知风险/诚实标注:**
- Task 3 的"反向脑补防护"无法单测 LLM 行为，以硬约束文本断言为 proxy（与现有 distiller.test.ts 源码层断言模式一致）。
- Task 1 表重建 migration 在用户的真实 `~/.memside/memside.db` 上首次运行会重建 memories 表（保数据）；单用户本地工具，无并发，可接受。
- SubagentStop 的 transcript_path 是否指主会话（spec 未 100% 坐实）-> 双路兜底覆盖，Task 5/7 测试两态。

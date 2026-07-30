# 蒸馏工作记录透明化（distill work-record）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 每个 distill job 落一条运行记录（outcome 四态 + LLM 原始产出 + 四道闸计数 + 耗时），去掉 `memory_distill_inputs` 条件门让 0 产出 job 也存输入，Web UI 加第 5 个 tab「蒸馏记录」展示计数链 + outcome 徽标，点开看产出/输入。

**Architecture:** 新建 `memory_distill_runs` 表（1:1 随 job，与 `memory_distill_inputs` 并列，各司输入/产出）。distiller 透出 `rawOutput`/`rawCount`/`callThrew`；scheduler.tick 采集计数 + 判定 outcome + best-effort 写 run 记录（skipped 分支也写）。server 加 3 个 GET 端点 + `/api/status` 计数。Web UI 第 5 tab 列表（计数链 + outcome 徽标）+ 点开 DistillRunModal（产出区 + 输入区懒加载）。

**Tech Stack:** Bun + Hono + Drizzle + bun:sqlite(WAL) + zod；前端 Vite + React 19。

## Global Constraints

- 测试随改动落地：纯函数层测足、运行时/UI 层少量集成断言；`bun run typecheck && bun test` 全绿才能 push（CLAUDE.md 硬规则）。
- 迁移用幂等 `CREATE TABLE IF NOT EXISTS` 风格（见 `src/db/client.ts` 现有模式）；新表不设 FK（与 `memory_distill_inputs` 一致，解耦未来 job 清理/TTL）。
- Web UI 复用 `src/web/App.tsx` 既有 inline style 与 `MemoryCard`/`DiscardCard`/`SourceInputModal` 骨架，不引新样式框架。
- best-effort 契约：`saveDistillRun`/`saveSourceInput` 写失败只 `console.warn`、不阻塞 job done（与 `logDiscards`/`setSessionOffset` 同级）。
- 计数链展示 `distilled->deduped->filtered->stored` 四段；`accepted_count`（格式校验后）在详情遮罩层用 hint 文案体现（`rawCount` vs `acceptedCount`）。
- 分支 `feat/distill-work-record`（基线 `origin/master`），每个任务一个 commit，PR 目标 `master`。

---

## File Structure

- `src/db/schema.ts` - 加 `memoryDistillRuns` drizzle 表定义。
- `src/db/client.ts` - DDL + drizzle schema 注册（幂等）。
- `src/memory/distiller.ts` - `DistillResult` 扩展 `rawOutput`/`rawCount`/`callThrew`，所有返回路径填充。
- `src/memory/store.ts` - `saveDistillRun`/`getDistillRun`/`listRecentDistillRuns` + 类型。
- `src/scheduler.ts` - tick 接线：outcome 判定 + 计数采集 + 两处 best-effort `saveDistillRun` + `saveSourceInput` 去门。
- `src/server.ts` - 3 个 GET 路由 + `/api/status` 加 distillRuns 计数。
- `src/web/api.ts` - `listDistillRuns`/`getDistillRun`/`getDistillRunSourceInput` client + 类型 + `MemsideStatus` 扩展。
- `src/web/ui-utils.ts` - `formatOutcome`/`formatRunCounts` 纯函数。
- `src/web/App.tsx` - 第 5 tab + `DistillRunRow` + `DistillRunModal`。

---

## Task 1: schema + 迁移（memory_distill_runs 表）

**Files:**
- Modify: `src/db/schema.ts`（在 `memoryDistillInputs` 定义后追加）
- Modify: `src/db/client.ts`（import 第 5 行、drizzle map 第 14 行、DDL 块第 88 行后）
- Test: `tests/store-crud.test.ts`

**Interfaces:**
- Produces: drizzle 表对象 `memoryDistillRuns`（列见下），供 Task 3 store 函数与 Task 5 server 查询使用。

- [ ] **Step 1: 写失败测试（表存在 + 列齐全）**

在 `tests/store-crud.test.ts` 顶部 describe 内加：

```ts
import { memoryDistillRuns } from '@/db/schema'

test('openDb creates memory_distill_runs with all columns', () => {
  const cols = db.$client.exec('PRAGMA table_info(memory_distill_runs)').toArray()
    .map((r: any) => r.name as string)
  expect(cols).toEqual(expect.arrayContaining([
    'distill_job_id', 'outcome', 'raw_output_json', 'distilled_count', 'accepted_count',
    'deduped_count', 'filtered_count', 'stored_count', 'discarded_count', 'duration_ms', 'ts',
  ]))
})
```

> 注：`db.$client` 是 bun:sqlite 原始句柄（`store-crud.test.ts` 已用 `db.$client.close()` 关库，确认可访问）。若该属性名不同，改用 `db.run('PRAGMA table_info(memory_distill_runs)')` 配合测试中已有的查询模式；以实际能拿到列名为准。

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test tests/store-crud.test.ts -t "memory_distill_runs with all columns"`
Expected: FAIL（表不存在 / `memoryDistillRuns` 未导出）。

- [ ] **Step 3: 加 drizzle 表定义**

在 `src/db/schema.ts` 的 `memoryDistillInputs` 定义（第 117-126 行）之后追加：

```ts
export const memoryDistillRuns = sqliteTable(
  'memory_distill_runs',
  {
    distillJobId: text('distill_job_id').primaryKey(),
    outcome: text('outcome').notNull(),
    rawOutputJson: text('raw_output_json'),
    distilledCount: integer('distilled_count').notNull(),
    acceptedCount: integer('accepted_count').notNull(),
    dedupedCount: integer('deduped_count').notNull(),
    filteredCount: integer('filtered_count').notNull(),
    storedCount: integer('stored_count').notNull(),
    discardedCount: integer('discarded_count').notNull(),
    durationMs: integer('duration_ms').notNull(),
    ts: integer('ts').notNull(),
  },
)
```

- [ ] **Step 4: 注册到 client.ts**

`src/db/client.ts` 第 5 行 import 末尾加 `memoryDistillRuns`：

```ts
import { memories, memoryDistillJobs, memoryDistillEvents, memoryDiscards, memorySessionOffsets, memoryDistillInputs, memoryDistillRuns } from './schema'
```

第 14 行 drizzle schema map 加 `memoryDistillRuns`：

```ts
const db = drizzle(raw, { schema: { memories, memoryDistillJobs, memoryDistillEvents, memoryDiscards, memorySessionOffsets, memoryDistillInputs, memoryDistillRuns } })
```

DDL 块（`memory_distill_inputs` 的 CREATE 之后，第 88 行 `);` 后）加：

```sql
    CREATE TABLE IF NOT EXISTS memory_distill_runs (
      distill_job_id   TEXT PRIMARY KEY,
      outcome          TEXT NOT NULL,
      raw_output_json  TEXT,
      distilled_count  INTEGER NOT NULL,
      accepted_count   INTEGER NOT NULL,
      deduped_count    INTEGER NOT NULL,
      filtered_count   INTEGER NOT NULL,
      stored_count     INTEGER NOT NULL,
      discarded_count  INTEGER NOT NULL,
      duration_ms      INTEGER NOT NULL,
      ts               INTEGER NOT NULL
    );
```

- [ ] **Step 5: 运行测试确认通过**

Run: `bun test tests/store-crud.test.ts -t "memory_distill_runs with all columns" && bun run typecheck`
Expected: PASS + typecheck 干净。

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.ts src/db/client.ts tests/store-crud.test.ts
git commit -m "feat(db): memory_distill_runs 表 + 幂等迁移"
```

---

## Task 2: distiller DistillResult 扩展（rawOutput/rawCount/callThrew）

**Files:**
- Modify: `src/memory/distiller.ts`（`DistillResult` 接口第 107-110 行、`distillTranscript` 第 155-213 行）
- Test: `tests/distiller.test.ts`

**Interfaces:**
- Consumes: 无新依赖；复用已有 `callWithRetry` 返回的 parsed 对象与已跟踪的 `callThrew` 标志。
- Produces: `DistillResult` 新增三字段 `rawOutput: unknown | null` / `rawCount: number` / `callThrew: boolean`，供 Task 4 scheduler 采集。

- [ ] **Step 1: 写失败测试（四态返回值）**

在 `tests/distiller.test.ts` 加（`distillTranscript` 与 `filterTranscriptForDistill` 已 import）：

```ts
test('distillTranscript returns rawOutput/rawCount/callThrew on produced', async () => {
  const turns = [{ role: 'user', content: '记一下' }, { role: 'assistant', content: '好' }] as any
  const r = await distillTranscript({
    turns, runtime: 'claude-code', cwd: '/repo', existingSlugs: [],
    callLLM: async () => JSON.stringify({ candidates: [{ title: '[category:convention] x', bodyMd: 'b', scope: 'project', runtime: 'claude-code', distillAction: 'new' }] }),
  })
  expect(r.candidates.length).toBe(1)
  expect(r.rawCount).toBe(1)
  expect(r.callThrew).toBe(false)
  expect((r.rawOutput as any)?.candidates?.length).toBe(1)
})

test('distillTranscript returns callThrew=true + null rawOutput when LLM throws', async () => {
  const turns = [{ role: 'user', content: 'hi' }] as any
  const r = await distillTranscript({
    turns, runtime: 'claude-code', cwd: '/repo', existingSlugs: [],
    callLLM: async () => { throw new Error('api down') },
  })
  expect(r.candidates).toEqual([])
  expect(r.callThrew).toBe(true)
  expect(r.rawOutput).toBeNull()
  expect(r.rawCount).toBe(0)
})

test('distillTranscript returns empty_output shape when LLM returns 0 candidates', async () => {
  const turns = [{ role: 'user', content: 'hi' }] as any
  const r = await distillTranscript({
    turns, runtime: 'claude-code', cwd: '/repo', existingSlugs: [],
    callLLM: async () => JSON.stringify({ candidates: [] }),
  })
  expect(r.candidates).toEqual([])
  expect(r.callThrew).toBe(false)
  expect(r.rawCount).toBe(0)
  expect((r.rawOutput as any)?.candidates).toEqual([])
})

test('distillTranscript preserves format-invalid candidates in rawOutput (rawCount > accepted)', async () => {
  const turns = [{ role: 'user', content: 'hi' }] as any
  // 始终返回 1 好 + 1 坏（无 [category: 前缀）-> shouldRetry 重试耗尽 -> 返回 lastParsed
  const r = await distillTranscript({
    turns, runtime: 'claude-code', cwd: '/repo', existingSlugs: [],
    callLLM: async () => JSON.stringify({ candidates: [
      { title: '[category:convention] good', bodyMd: 'b', scope: 'project', runtime: 'claude-code', distillAction: 'new' },
      { title: 'no-prefix bad', bodyMd: 'b' },
    ] }),
  })
  expect(r.candidates.length).toBe(1)            // 坏的被格式校验丢
  expect(r.rawCount).toBe(2)                      // 原始两条都计
  expect((r.rawOutput as any)?.candidates?.length).toBe(2)  // rawOutput 保留被丢的
  expect(r.callThrew).toBe(false)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test tests/distiller.test.ts -t "rawOutput"`
Expected: FAIL（`r.rawCount` / `r.rawOutput` / `r.callThrew` undefined）。

- [ ] **Step 3: 扩展 DistillResult 接口**

`src/memory/distiller.ts` 第 107-110 行 `DistillResult` 改为：

```ts
export interface DistillResult {
  candidates: DistillCandidate[]
  filteredTurns: TranscriptTurn[]   // 实际喂给模型的过滤版，零偏差快照源
  /** LLM 原始解析输出（candidates 数组原样，含被格式校验丢弃的）。无候选/跳过/报错时为 null。 */
  rawOutput: unknown | null
  /** LLM 返回的原始候选数（含格式不合格被丢的）。 */
  rawCount: number
  /** 底层 LLM 调用是否抛错（scheduler 据此判 llm_error vs empty_output）。 */
  callThrew: boolean
}
```

- [ ] **Step 4: 填充所有返回路径**

`distillTranscript`（第 155-213 行）改三处返回。把第 180 行早返回改为：

```ts
    const rawOutput: unknown = parsed ?? null
    if (!parsed || !Array.isArray(parsed.candidates)) {
      return { candidates: [], filteredTurns: callThrew ? [] : filtered, rawOutput, rawCount: 0, callThrew }
    }
    const rawCount = parsed.candidates.length
```

末尾正常返回（原第 208 行）改为：

```ts
    return { candidates: out, filteredTurns: filtered, rawOutput, rawCount, callThrew }
```

catch（原第 209-212 行）改为：

```ts
  } catch {
    // Never throw: distill failures degrade to \"no candidates this round\".
    return { candidates: [], filteredTurns: [], rawOutput: null, rawCount: 0, callThrew: true }
  }
```

> 注：catch 强制 `callThrew: true` 是 spec §5 既定防御形态（\"distill 失败\"统归 llm_error）；该路径仅纯函数意外抛错时触达，distiller 已内部吞 LLM throw，不会由此区分失误。

- [ ] **Step 5: 运行测试确认通过**

Run: `bun test tests/distiller.test.ts && bun run typecheck`
Expected: 全绿（含原有 304+ 测试 + 新 4 条）+ typecheck 干净。

- [ ] **Step 6: Commit**

```bash
git add src/memory/distiller.ts tests/distiller.test.ts
git commit -m "feat(distiller): DistillResult 透出 rawOutput/rawCount/callThrew"
```

---

## Task 3: store 函数（saveDistillRun / getDistillRun / listRecentDistillRuns）

**Files:**
- Modify: `src/memory/store.ts`（import 第 4 行、文件末尾追加）
- Test: `tests/store-crud.test.ts`

**Interfaces:**
- Consumes: `memoryDistillRuns`、`memoryDistillJobs`（Task 1）、`inArray`/`eq`/`desc`（已 import）。
- Produces: `DistillOutcome` 类型、`DistillRunRecord`、`DistillRunRow`、`DistillRunListRow`、`saveDistillRun`、`getDistillRun`、`listRecentDistillRuns`，供 Task 4 scheduler 与 Task 5 server 使用。

- [ ] **Step 1: 写失败测试**

在 `tests/store-crud.test.ts` 加（参照已有 `saveSourceInput` 测试风格，`db` 与 `memoryDistillJobs` 已就绪）：

```ts
import { saveDistillRun, getDistillRun, listRecentDistillRuns } from '@/memory/store'

test('saveDistillRun inserts a row, getDistillRun reads it back', async () => {
  // listRecentDistillRuns JOIN job，先建一个 job 行
  await db.insert(memoryDistillJobs).values({ id: 'job-r1', debounceKey: 'k', sourceEventId: 'e', runtime: 'claude-code', cwd: '/repo', status: 'done', attempts: 0, nextRunAt: 0, createdAt: 100, finishedAt: 200 })
  await saveDistillRun(db, 'job-r1', { outcome: 'produced', rawOutput: { candidates: [{ title: 'x' }] }, rawCount: 1, acceptedCount: 1, dedupedCount: 1, filteredCount: 1, storedCount: 1, discardedCount: 0, durationMs: 42 })
  const run = await getDistillRun(db, 'job-r1')
  expect(run?.outcome).toBe('produced')
  expect(run?.rawCount).toBe(1)
  expect(run?.durationMs).toBe(42)
  expect((run?.rawOutput as any)?.candidates?.length).toBe(1)
})

test('saveDistillRun UPSERT overwrites on same distillJobId', async () => {
  await saveDistillRun(db, 'job-r2', { outcome: 'empty_output', rawOutput: null, rawCount: 0, acceptedCount: 0, dedupedCount: 0, filteredCount: 0, storedCount: 0, discardedCount: 0, durationMs: 5 })
  await saveDistillRun(db, 'job-r2', { outcome: 'produced', rawOutput: null, rawCount: 3, acceptedCount: 2, dedupedCount: 2, filteredCount: 1, storedCount: 1, discardedCount: 1, durationMs: 9 })
  const rows = db.$client.exec('SELECT outcome, distilled_count FROM memory_distill_runs WHERE distill_job_id = ?'.replace('?', '\\'+'?')).get(...['job-r2'])  // 见下注
  // 直接用 getDistillRun 断言更稳：
  const run = await getDistillRun(db, 'job-r2')
  expect(run?.outcome).toBe('produced')
  expect(run?.rawCount).toBe(3)
})

test('getDistillRun returns null for missing job', async () => {
  expect(await getDistillRun(db, 'nope')).toBeNull()
})

test('getDistillRun returns null rawOutput on malformed raw_output_json', async () => {
  await db.insert(memoryDistillRuns).values({ distillJobId: 'job-bad', outcome: 'produced', rawOutputJson: 'not-json{', distilledCount: 1, acceptedCount: 1, dedupedCount: 1, filteredCount: 1, storedCount: 1, discardedCount: 0, durationMs: 1, ts: 1 })
  const run = await getDistillRun(db, 'job-bad')
  expect(run?.rawOutput).toBeNull()
  expect(run?.outcome).toBe('produced')
})

test('listRecentDistillRuns returns rows newest-first with job metadata, no rawOutput', async () => {
  await db.insert(memoryDistillJobs).values({ id: 'job-l1', debounceKey: 'k', sourceEventId: 'e', runtime: 'claude-code', cwd: '/a', status: 'done', attempts: 0, nextRunAt: 0, createdAt: 10, finishedAt: 20 })
  await db.insert(memoryDistillJobs).values({ id: 'job-l2', debounceKey: 'k', sourceEventId: 'e', runtime: 'claude-code', cwd: '/b', sourceAgentId: 'ag1', status: 'done', attempts: 0, nextRunAt: 0, createdAt: 30, finishedAt: 40 })
  await saveDistillRun(db, 'job-l1', { outcome: 'produced', rawOutput: { candidates: [] }, rawCount: 1, acceptedCount: 1, dedupedCount: 1, filteredCount: 1, storedCount: 1, discardedCount: 0, durationMs: 1 })
  await saveDistillRun(db, 'job-l2', { outcome: 'empty_output', rawOutput: null, rawCount: 0, acceptedCount: 0, dedupedCount: 0, filteredCount: 0, storedCount: 0, discardedCount: 0, durationMs: 1 })
  const rows = await listRecentDistillRuns(db)
  expect(rows.length).toBe(2)
  expect(rows[0]!.ts).toBeGreaterThanOrEqual(rows[1]!.ts)  // DESC
  expect(rows.find((r) => r.distillJobId === 'job-l2')?.sourceAgentId).toBe('ag1')
  expect(rows.find((r) => r.distillJobId === 'job-l1')?.cwd).toBe('/a')
  // 列表行不含 rawOutput
  expect((rows[0] as any).rawOutput).toBeUndefined()
})
```

> 注：UPSERT 测试里那行 `$client.exec` 占位写法不严谨，实现时直接用 `getDistillRun` 断言即可（已给），删掉那行 `$client.exec`。

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test tests/store-crud.test.ts -t "saveDistillRun|getDistillRun|listRecentDistillRuns"`
Expected: FAIL（函数未导出）。

- [ ] **Step 3: 加 import**

`src/memory/store.ts` 第 4 行改为：

```ts
import { memories, memoryDiscards, memorySessionOffsets, memoryDistillInputs, memoryDistillRuns, memoryDistillJobs } from '@/db/schema'
```

- [ ] **Step 4: 实现三个函数**

文件末尾追加：

```ts
// ---------------------------------------------------------------------------
// 蒸馏工作记录透明化：每个 distill job 一条 run 记录（outcome + LLM 原始产出 +
// 四道闸计数 + 耗时）。saveDistillRun best-effort 写（调用方 tick 吞错）；
// getDistillRun 反序列化 raw_output_json 失败 -> rawOutput=null（不崩）。
// listRecentDistillRuns 不含 rawOutput（走专用详情端点），JOIN job 元数据。
// ---------------------------------------------------------------------------

export type DistillOutcome = 'skipped_no_new_turns' | 'empty_output' | 'llm_error' | 'produced'

export interface DistillRunRecord {
  outcome: DistillOutcome
  rawOutput: unknown | null
  rawCount: number
  acceptedCount: number
  dedupedCount: number
  filteredCount: number
  storedCount: number
  discardedCount: number
  durationMs: number
}

export interface DistillRunRow {
  distillJobId: string
  outcome: DistillOutcome
  rawOutput: unknown | null
  rawCount: number
  acceptedCount: number
  dedupedCount: number
  filteredCount: number
  storedCount: number
  discardedCount: number
  durationMs: number
  ts: number
}

export async function saveDistillRun(
  db: DbClient, distillJobId: string, record: DistillRunRecord,
): Promise<void> {
  const now = Date.now()
  const rawOutputJson = record.rawOutput == null ? null : JSON.stringify(record.rawOutput)
  await db.insert(memoryDistillRuns).values({
    distillJobId, outcome: record.outcome, rawOutputJson,
    distilledCount: record.rawCount, acceptedCount: record.acceptedCount,
    dedupedCount: record.dedupedCount, filteredCount: record.filteredCount,
    storedCount: record.storedCount, discardedCount: record.discardedCount,
    durationMs: record.durationMs, ts: now,
  }).onConflictDoUpdate({
    target: memoryDistillRuns.distillJobId,
    set: { outcome: record.outcome, rawOutputJson, distilledCount: record.rawCount,
      acceptedCount: record.acceptedCount, dedupedCount: record.dedupedCount,
      filteredCount: record.filteredCount, storedCount: record.storedCount,
      discardedCount: record.discardedCount, durationMs: record.durationMs, ts: now },
  })
}

function rowToRun(r: any): DistillRunRow {
  let rawOutput: unknown = null
  if (r.rawOutputJson != null) {
    try { rawOutput = JSON.parse(r.rawOutputJson) } catch { rawOutput = null }
  }
  return {
    distillJobId: r.distillJobId, outcome: r.outcome as DistillOutcome, rawOutput,
    rawCount: r.distilledCount, acceptedCount: r.acceptedCount, dedupedCount: r.dedupedCount,
    filteredCount: r.filteredCount, storedCount: r.storedCount, discardedCount: r.discardedCount,
    durationMs: r.durationMs, ts: r.ts,
  }
}

export async function getDistillRun(db: DbClient, distillJobId: string): Promise<DistillRunRow | null> {
  const rows = await db.select().from(memoryDistillRuns)
    .where(eq(memoryDistillRuns.distillJobId, distillJobId)).limit(1)
  return rows.length === 0 ? null : rowToRun(rows[0])
}

export const DISTILL_RUNS_LIST_LIMIT = 200

export interface DistillRunListRow {
  distillJobId: string
  outcome: DistillOutcome
  rawCount: number
  acceptedCount: number
  dedupedCount: number
  filteredCount: number
  storedCount: number
  discardedCount: number
  durationMs: number
  ts: number
  cwd: string | null
  runtime: string
  createdAt: number
  sourceAgentId: string | null
}

/**
 * 最近 N 条 run（ts DESC，默认 200）。不含 rawOutput（走 GET /api/distill-runs/:jobId）。
 * job 元数据（cwd/runtime/createdAt/sourceAgentId）通过 inArray 二次查询带出，避免
 * drizzle JOIN 结果键名不确定性。孤儿 run（job 已删）-> cwd=null / createdAt=0。
 */
export async function listRecentDistillRuns(
  db: DbClient, opts: { limit?: number } = {},
): Promise<DistillRunListRow[]> {
  const limit = opts.limit ?? DISTILL_RUNS_LIST_LIMIT
  const cols = {
    distillJobId: memoryDistillRuns.distillJobId, outcome: memoryDistillRuns.outcome,
    rawCount: memoryDistillRuns.distilledCount, acceptedCount: memoryDistillRuns.acceptedCount,
    dedupedCount: memoryDistillRuns.dedupedCount, filteredCount: memoryDistillRuns.filteredCount,
    storedCount: memoryDistillRuns.storedCount, discardedCount: memoryDistillRuns.discardedCount,
    durationMs: memoryDistillRuns.durationMs, ts: memoryDistillRuns.ts,
  }
  const runRows = await db.select(cols).from(memoryDistillRuns)
    .orderBy(desc(memoryDistillRuns.ts)).limit(limit).all()
  if (runRows.length === 0) return []
  const jobRows = await db.select().from(memoryDistillJobs)
    .where(inArray(memoryDistillJobs.id, runRows.map((r) => r.distillJobId))).all()
  const jobById = new Map(jobRows.map((j) => [j.id, j]))
  return runRows.map((r) => {
    const j = jobById.get(r.distillJobId)
    return {
      distillJobId: r.distillJobId, outcome: r.outcome as DistillOutcome,
      rawCount: r.rawCount, acceptedCount: r.acceptedCount, dedupedCount: r.dedupedCount,
      filteredCount: r.filteredCount, storedCount: r.storedCount, discardedCount: r.discardedCount,
      durationMs: r.durationMs, ts: r.ts,
      cwd: j?.cwd ?? null, runtime: j?.runtime ?? '', createdAt: j?.createdAt ?? 0,
      sourceAgentId: j?.sourceAgentId ?? null,
    }
  })
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `bun test tests/store-crud.test.ts && bun run typecheck`
Expected: 全绿 + typecheck 干净。

- [ ] **Step 6: Commit**

```bash
git add src/memory/store.ts tests/store-crud.test.ts
git commit -m "feat(store): saveDistillRun/getDistillRun/listRecentDistillRuns"
```

---

## Task 4: scheduler.tick 接线（outcome + 计数 + saveDistillRun + 去门）

**Files:**
- Modify: `src/scheduler.ts`（import 第 6 行、skipped 分支第 131-136 行、distillTranscript 调用第 149 行、saveSourceInput 第 201-206 行）
- Test: `tests/scheduler.test.ts`

**Interfaces:**
- Consumes: Task 2 `DistillResult` 新字段、Task 3 `saveDistillRun`。
- Produces: 每个 done job 在 `memory_distill_runs` 有一行；`memory_distill_inputs` 不再有条件门。

- [ ] **Step 1: 写失败测试（outcome 四态 + 去门 + best-effort + 计数链）**

在 `tests/scheduler.test.ts` 加（参照已有 tick 测试的 `loadTranscript`/`callLLM`/`createCandidate` mock 模式与 `nextRunAt: 0` 强制 due）：

```ts
import { saveDistillRun } from '@/memory/store'  // 仅用于类型；run 记录查 memoryDistillRuns
import { memoryDistillRuns } from '@/db/schema'

async function forceDue(jobId: string) {
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
}

test('tick writes run record outcome=skipped_no_new_turns when newTurns empty', async () => {
  const { jobId } = await enqueueDistillJob(db, { sourceEventId: 'e', runtime: 'claude-code', cwd: '/r', debounceKey: 'k', debounceMs: 0, sessionId: 's1' })
  await db.insert(memoryDistillEvents).values({ distillJobId: jobId, attemptIndex: 0, ts: Date.now(), kind: 'conversation', payload: '[]' })
  await forceDue(jobId)
  const n = await tick(db, { loadTranscript: async () => ({ turns: [], fullLength: 0 }), callLLM: async () => JSON.stringify({ candidates: [] }), createCandidate: async (_d: any, input: any) => ({ id: 'c', status: 'candidate', version: 1 } as any) })
  expect(n).toBe(1)
  const runs = db.select().from(memoryDistillRuns).all()
  expect(runs.length).toBe(1)
  expect(runs[0]!.outcome).toBe('skipped_no_new_turns')
  expect(runs[0]!.distilledCount).toBe(0)
})

test('tick writes run record outcome=empty_output when LLM returns 0 candidates', async () => {
  const { jobId } = await enqueueDistillJob(db, { sourceEventId: 'e', runtime: 'claude-code', cwd: '/r', debounceKey: 'k', debounceMs: 0, sessionId: 's2' })
  await db.insert(memoryDistillEvents).values({ distillJobId: jobId, attemptIndex: 0, ts: Date.now(), kind: 'conversation', payload: JSON.stringify([{ role: 'user', content: 'hi' }]) })
  await forceDue(jobId)
  await tick(db, { loadTranscript: async () => ({ turns: [{ role: 'user', content: 'hi' }] as any, fullLength: 1 }), callLLM: async () => JSON.stringify({ candidates: [] }), createCandidate: async (_d: any, input: any) => ({ id: 'c', status: 'candidate', version: 1 } as any) })
  const runs = db.select().from(memoryDistillRuns).all()
  expect(runs[0]!.outcome).toBe('empty_output')
  expect(runs[0]!.callThrew ?? false).toBe(false)  // 注意：run 表无 callThrew 列；用 distilledCount===0 断言即可
  expect(runs[0]!.distilledCount).toBe(0)
})

test('tick writes run record outcome=llm_error when callLLM throws', async () => {
  const { jobId } = await enqueueDistillJob(db, { sourceEventId: 'e', runtime: 'claude-code', cwd: '/r', debounceKey: 'k', debounceMs: 0, sessionId: 's3' })
  await db.insert(memoryDistillEvents).values({ distillJobId: jobId, attemptIndex: 0, ts: Date.now(), kind: 'conversation', payload: JSON.stringify([{ role: 'user', content: 'hi' }]) })
  await forceDue(jobId)
  await tick(db, { loadTranscript: async () => ({ turns: [{ role: 'user', content: 'hi' }] as any, fullLength: 1 }), callLLM: async () => { throw new Error('api down') }, createCandidate: async (_d: any, input: any) => ({ id: 'c', status: 'candidate', version: 1 } as any) })
  const runs = db.select().from(memoryDistillRuns).all()
  expect(runs[0]!.outcome).toBe('llm_error')
})

test('tick writes run record outcome=produced with correct count chain', async () => {
  const { jobId } = await enqueueDistillJob(db, { sourceEventId: 'e', runtime: 'claude-code', cwd: '/r', debounceKey: 'k', debounceMs: 0, sessionId: 's4' })
  await db.insert(memoryDistillEvents).values({ distillJobId: jobId, attemptIndex: 0, ts: Date.now(), kind: 'conversation', payload: JSON.stringify([{ role: 'user', content: 'hi' }]) })
  await forceDue(jobId)
  // distill 返回 2 候选 -> dedup 全留 2 -> valueFilter 全留 2（decision）-> 入库 2
  let phase = 0
  await tick(db, {
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'hi' }] as any, fullLength: 1 }),
    callLLM: async () => {
      phase++
      if (phase === 1) return JSON.stringify({ candidates: [
        { title: '[category:convention] a', bodyMd: 'b', scope: 'project', runtime: 'claude-code', distillAction: 'new' },
        { title: '[category:convention] c', bodyMd: 'd', scope: 'project', runtime: 'claude-code', distillAction: 'new' },
      ] })
      return JSON.stringify({ verdicts: [{ index: 0, category: 'decision' }, { index: 1, category: 'decision' }] })  // dedup + valueFilter
    },
    createCandidate: async (_d: any, input: any) => ({ id: 'c' + input.title, status: 'candidate', version: 1 } as any),
  })
  const runs = db.select().from(memoryDistillRuns).all()
  const r = runs[0]!
  expect(r.outcome).toBe('produced')
  expect(r.distilledCount).toBe(2)
  expect(r.acceptedCount).toBe(2)
  expect(r.dedupedCount).toBe(2)
  expect(r.filteredCount).toBe(2)
  expect(r.storedCount).toBe(2)
  expect(r.discardedCount).toBe(0)
})

test('tick writes source-input snapshot even when 0 candidates kept (去门)', async () => {
  const { jobId } = await enqueueDistillJob(db, { sourceEventId: 'e', runtime: 'claude-code', cwd: '/r', debounceKey: 'k', debounceMs: 0, sessionId: 's5' })
  await db.insert(memoryDistillEvents).values({ distillJobId: jobId, attemptIndex: 0, ts: Date.now(), kind: 'conversation', payload: JSON.stringify([{ role: 'user', content: 'hi' }]) })
  await forceDue(jobId)
  await tick(db, { loadTranscript: async () => ({ turns: [{ role: 'user', content: 'hi' }] as any, fullLength: 1 }), callLLM: async () => JSON.stringify({ candidates: [] }), createCandidate: async (_d: any, input: any) => ({ id: 'c', status: 'candidate', version: 1 } as any) })
  const snaps = db.select().from(memoryDistillInputs).all()
  expect(snaps.length).toBe(1)  // 去门后 0 候选也写
})

test('tick still marks done when saveDistillRun throws', async () => {
  const { jobId } = await enqueueDistillJob(db, { sourceEventId: 'e', runtime: 'claude-code', cwd: '/r', debounceKey: 'k', debounceMs: 0, sessionId: 's6' })
  await db.insert(memoryDistillEvents).values({ distillJobId: jobId, attemptIndex: 0, ts: Date.now(), kind: 'conversation', payload: JSON.stringify([{ role: 'user', content: 'hi' }]) })
  await forceDue(jobId)
  const origInsert = db.insert.bind(db)
  ;(db as any).insert = (...args: any[]) => { if (args[0] === memoryDistillRuns) throw new Error('write fail'); return origInsert(...args) }
  try {
    await tick(db, { loadTranscript: async () => ({ turns: [{ role: 'user', content: 'hi' }] as any, fullLength: 1 }), callLLM: async () => JSON.stringify({ candidates: [] }), createCandidate: async (_d: any, input: any) => ({ id: 'c', status: 'candidate', version: 1 } as any) })
  } finally { (db as any).insert = origInsert }
  const job = db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, jobId)).all()[0]!
  expect(job.status).toBe('done')
})
```

> 注：测试里 `runs[0]!.callThrew` 那行误用了不存在的列，实现时删掉该行（run 表无 callThrew 列）；保留 `distilledCount===0` 断言即可。`memoryDistillInputs` import 已在文件中。

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test tests/scheduler.test.ts -t "run record|0 candidates kept|saveDistillRun throws"`
Expected: FAIL（run 记录未写 / 去门未生效）。

- [ ] **Step 3: 加 import**

`src/scheduler.ts` 第 6 行 store import 加 `saveDistillRun`：

```ts
import { listForDedupByScope, listSubjectSlugs, logDiscards, setSessionOffset, saveSourceInput, saveDistillRun, type DiscardRecord } from '@/memory/store'
```

- [ ] **Step 4: skipped 分支写 run 记录**

`src/scheduler.ts` 第 131-136 行 `if (newTurns.length === 0)` 分支，在 `await db.update(...).set({ status: 'done' ...})` **之前**插入 best-effort 写：

```ts
      if (newTurns.length === 0) {
        // skipped_no_new_turns：未调 LLM，记一条空 run（透明化），再 done。
        try {
          await saveDistillRun(db, job.id, {
            outcome: 'skipped_no_new_turns', rawOutput: null, rawCount: 0,
            acceptedCount: 0, dedupedCount: 0, filteredCount: 0, storedCount: 0,
            discardedCount: 0, durationMs: 0,
          })
        } catch (e) { console.warn('memside: saveDistillRun failed', e) }
        await db.update(memoryDistillJobs).set({ status: 'done', finishedAt: Date.now() })
          .where(eq(memoryDistillJobs.id, job.id)).run()
        processed += 1
        continue
      }
```

- [ ] **Step 5: distillTranscript 调用加计时 + 解构新字段**

第 149 行调用改为：

```ts
      const t0 = Date.now()
      const { candidates, filteredTurns, rawOutput, rawCount, callThrew } = await distillTranscript({
        turns: newTurns,  // 只喂新增 turn，不再全量
        runtime: job.runtime as 'claude-code' | 'opencode',
        cwd: job.cwd ?? '',
        existingSlugs,
        callLLM: deps.callLLM,
      })
      const durationMs = Date.now() - t0
```

- [ ] **Step 6: saveSourceInput 去门 + 加 saveDistillRun**

第 201-206 行 `saveSourceInput` 块改为去门，并在其后（`status='done'` 之前）加 `saveDistillRun`：

```ts
      // 去门（spec §5）：0 产出 job 也存过滤版输入，让用户看到「模型看到了什么却返回 0」。
      // skipped 分支已 continue，此处恒非 skipped。best-effort：失败只 warn，不阻塞 done。
      try { await saveSourceInput(db, job.id, filteredTurns) }
      catch (e) { console.warn('memside: saveSourceInput failed', e) }
      // 运行记录：outcome + 计数链 + LLM 原始产出。best-effort，与 logDiscards/saveSourceInput 同级。
      try {
        await saveDistillRun(db, job.id, {
          outcome: callThrew ? 'llm_error' : (candidates.length === 0 ? 'empty_output' : 'produced'),
          rawOutput, rawCount, acceptedCount: candidates.length, dedupedCount: deduped.length,
          filteredCount: keepWithClass.length, storedCount: keepWithClass.length,
          discardedCount: discarded.length, durationMs,
        })
      } catch (e) { console.warn('memside: saveDistillRun failed', e) }
```

> 注：`deduped`/`keepWithClass`/`discarded` 在此点已声明（第 158/165/166 行），作用域覆盖此处。`filteredCount === storedCount`（valueFilter 存活者全部入库，无再过滤）——spec §4 既定，两列并存为前向兼容。

- [ ] **Step 7: 更新被翻转的旧测试**

`tests/scheduler.test.ts` 中 `tick does NOT write source-input snapshot when 0 candidates kept`（约第 769-789 行）已被去门翻转——将其改名为 `tick writes source-input snapshot even when 0 candidates kept (去门)`，断言从「无行」改为「有一行」。若该测试已被 Step 1 的新测试覆盖，可直接删除旧测试避免重复（保留一个即可）。

- [ ] **Step 8: 运行测试确认通过**

Run: `bun test tests/scheduler.test.ts && bun run typecheck`
Expected: 全绿（含原有 + 新 6 条）+ typecheck 干净。

- [ ] **Step 9: Commit**

```bash
git add src/scheduler.ts tests/scheduler.test.ts
git commit -m "feat(scheduler): tick 写 distill run 记录 + source-input 去门"
```

---

## Task 5: server 端点 + /api/status 计数

**Files:**
- Modify: `src/server.ts`（import 第 6/9 行、`/api/status` 第 205-222 行、新增 3 路由）
- Test: `tests/server.test.ts`

**Interfaces:**
- Consumes: Task 3 `getDistillRun`/`listRecentDistillRuns`、已有 `getSourceInput`（按 jobId）。
- Produces: `GET /api/distill-runs`、`GET /api/distill-runs/:jobId`、`GET /api/distill-runs/:jobId/source-input`、`/api/status` 增 `distillRuns` 字段。

- [ ] **Step 1: 写失败测试**

在 `tests/server.test.ts` 加（参照 `seedDiscardRow` helper 与 `req` helper 模式；先建 job + run 行）：

```ts
import { saveDistillRun } from '@/memory/store'

async function seedRunRow(jobId: string, outcome: string, cwd = '/repo', agentId: string | null = null) {
  await db.insert(memoryDistillJobs).values({ id: jobId, debounceKey: 'k', sourceEventId: 'e', runtime: 'claude-code', cwd, sourceAgentId: agentId, status: 'done', attempts: 0, nextRunAt: 0, createdAt: 100, finishedAt: 200 })
  await saveDistillRun(db, jobId, { outcome: outcome as any, rawOutput: { candidates: [{ title: '[category:convention] x' }] }, rawCount: 1, acceptedCount: 1, dedupedCount: 1, filteredCount: 1, storedCount: 1, discardedCount: 0, durationMs: 5 })
}

test('GET /api/distill-runs lists runs without rawOutput', async () => {
  await seedRunRow('job-x1', 'produced')
  const r = await req('/api/distill-runs')
  expect(r.status).toBe(200)
  expect(r.body.items.length).toBe(1)
  expect(r.body.items[0].outcome).toBe('produced')
  expect(r.body.items[0].cwd).toBe('/repo')
  expect(JSON.stringify(r.body)).not.toContain('rawOutput')  // 列表不含 rawOutput
})

test('GET /api/distill-runs/:jobId returns detail with rawOutput', async () => {
  await seedRunRow('job-x2', 'produced')
  const r = await req('/api/distill-runs/job-x2')
  expect(r.status).toBe(200)
  expect((r.body.rawOutput as any)?.candidates?.length).toBe(1)
})

test('GET /api/distill-runs/:jobId 404 when missing', async () => {
  const r = await req('/api/distill-runs/nope')
  expect(r.status).toBe(404)
})

test('GET /api/distill-runs/:jobId/source-input returns turns', async () => {
  await saveSourceInput(db, 'job-x3', [{ role: 'user', content: 'hello' }] as any)
  const r = await req('/api/distill-runs/job-x3/source-input')
  expect(r.status).toBe(200)
  expect(r.body.turnCount).toBe(1)
  expect(r.body.turns[0].content).toBe('hello')
})

test('GET /api/distill-runs/:jobId/source-input 404 when no snapshot', async () => {
  const r = await req('/api/distill-runs/no-snap/source-input')
  expect(r.status).toBe(404)
})

test('GET /api/status includes distillRuns counts', async () => {
  await seedRunRow('job-x4', 'produced')
  await seedRunRow('job-x5', 'empty_output')
  const r = await req('/api/status')
  expect(r.status).toBe(200)
  expect(r.body.distillRuns).toBeDefined()
  expect(r.body.distillRuns.total).toBeGreaterThanOrEqual(2)
})
```

> 注：`saveSourceInput` 需在 server.test.ts import（若未 import）。`req` helper 与 `db` 已就绪。

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test tests/server.test.ts -t "distill-runs|distillRuns"`
Expected: FAIL（路由 404 / 字段缺失）。

- [ ] **Step 3: 加 import**

`src/server.ts` 第 6 行 schema import 加 `memoryDistillRuns`：

```ts
import { memories, memoryDistillJobs, memoryDistillEvents, memoryDiscards, memoryDistillRuns } from '@/db/schema'
```

第 9 行 store import 加 `getDistillRun, listRecentDistillRuns`（`getSourceInput` 已在）：

```ts
import { promoteCandidate, patchMemory, createCandidate, getMemoryById, getSourceInput, archiveMemory, unarchiveMemory, restoreMemory, promoteDiscard, listDiscards, getDistillRun, listRecentDistillRuns, MemoryNotFoundError } from '@/memory/store'
```

- [ ] **Step 4: /api/status 加 distillRuns 计数**

`/api/status`（第 205-222 行）在 `discardRows` 后加 runs 查询，响应加字段：

```ts
    const runRows = await deps.db.select().from(memoryDistillRuns).all()
    const now = Date.now()
    const recentRuns = runRows.filter((r) => now - (r.ts as number) < 24 * 60 * 60 * 1000)
    const runStats: Record<string, number> = {}
    for (const r of recentRuns) runStats[r.outcome] = (runStats[r.outcome] ?? 0) + 1
```

return 里加：

```ts
      distillRuns: { total: recentRuns.length, byOutcome: runStats },
```

- [ ] **Step 5: 加 3 个路由**

在 discards 路由组之后（archive 路由之前或之后均可，`/api/memories` POST 之前）加：

```ts
  // --- Distill runs (工作记录透明化) --------------------------------------
  app.get('/api/distill-runs', async (c) => {
    const limitParam = c.req.query('limit')
    let limit = 200
    if (limitParam) {
      const n = Number(limitParam)
      if (Number.isFinite(n) && n > 0) limit = Math.min(Math.floor(n), 500)
    }
    const items = await listRecentDistillRuns(deps.db, { limit })
    return c.json({ items })
  })

  app.get('/api/distill-runs/:jobId', async (c) => {
    const run = await getDistillRun(deps.db, c.req.param('jobId'))
    if (!run) return c.json({ error: 'not found' }, 404)
    return c.json(run)
  })

  app.get('/api/distill-runs/:jobId/source-input', async (c) => {
    const snap = await getSourceInput(deps.db, c.req.param('jobId'))
    if (!snap) return c.json({ error: 'not found' }, 404)
    return c.json({ turnCount: snap.turnCount, charCount: snap.charCount, turns: snap.turns })
  })
```

- [ ] **Step 6: 运行测试确认通过**

Run: `bun test tests/server.test.ts && bun run typecheck`
Expected: 全绿 + typecheck 干净。

- [ ] **Step 7: Commit**

```bash
git add src/server.ts tests/server.test.ts
git commit -m "feat(server): distill-runs 端点 + /api/status 计数"
```

---

## Task 6: web api client

**Files:**
- Modify: `src/web/api.ts`（`MemsideStatus` 第 72-78 行、文件末尾追加）
- Test: `tests/web-api.test.ts`

**Interfaces:**
- Consumes: Task 5 端点形状。
- Produces: `DistillOutcome`/`DistillRunListItem`/`DistillRunDetail` 类型 + `listDistillRuns`/`getDistillRun`/`getDistillRunSourceInput` client，供 Task 8 UI 使用。

- [ ] **Step 1: 写失败测试**

在 `tests/web-api.test.ts` 加（参照已有 mock fetch 模式）：

```ts
import { listDistillRuns, getDistillRun, getDistillRunSourceInput } from '@/web/api'

test('listDistillRuns calls GET /api/distill-runs', async () => {
  const fake = async (url: string) => new Response(JSON.stringify({ items: [{ distillJobId: 'j1', outcome: 'produced' }] }), { status: 200 })
  const rows = await listDistillRuns(fake as any)
  expect(rows.length).toBe(1)
  expect(rows[0].distillJobId).toBe('j1')
})

test('getDistillRun calls GET /api/distill-runs/:jobId', async () => {
  const fake = async (url: string) => new Response(JSON.stringify({ distillJobId: 'j1', outcome: 'produced', rawOutput: { candidates: [] } }), { status: 200 })
  const r = await getDistillRun('j1', fake as any)
  expect(r.distillJobId).toBe('j1')
  expect(r.rawOutput).toBeDefined()
})

test('getDistillRunSourceInput returns null on 404', async () => {
  const fake = async (url: string) => new Response('not found', { status: 404 })
  const r = await getDistillRunSourceInput('j1', fake as any)
  expect(r).toBeNull()
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test tests/web-api.test.ts -t "listDistillRuns|getDistillRun"`
Expected: FAIL（未导出）。

- [ ] **Step 3: 扩展 MemsideStatus + 加 client**

`src/web/api.ts` `MemsideStatus`（第 72-78 行）加可选字段：

```ts
export interface MemsideStatus {
  events: number
  jobs: Record<string, number>
  memories: Record<string, number>
  discards: number
  distillRuns?: { total: number; byOutcome: Record<string, number> }
  lastError: { error: string } | null
}
```

文件末尾追加：

```ts
// --- Distill runs (工作记录透明化) client ------------------------------------

export type DistillOutcome = 'skipped_no_new_turns' | 'empty_output' | 'llm_error' | 'produced'

export interface DistillRunListItem {
  distillJobId: string
  outcome: DistillOutcome
  rawCount: number
  acceptedCount: number
  dedupedCount: number
  filteredCount: number
  storedCount: number
  discardedCount: number
  durationMs: number
  ts: number
  cwd: string | null
  runtime: string
  createdAt: number
  sourceAgentId: string | null
}

export interface DistillRunDetail extends DistillRunListItem {
  rawOutput: unknown | null
}

export async function listDistillRuns(fetchFn: FetchLike = fetch): Promise<DistillRunListItem[]> {
  const res = await fetchFn('/api/distill-runs')
  const data = await res.json()
  return (data.items ?? []) as DistillRunListItem[]
}

export async function getDistillRun(jobId: string, fetchFn: FetchLike = fetch): Promise<DistillRunDetail> {
  const res = await fetchFn(`/api/distill-runs/${jobId}`)
  return (await res.json()) as DistillRunDetail
}

export async function getDistillRunSourceInput(
  jobId: string, fetchFn: FetchLike = fetch,
): Promise<{ turnCount: number; charCount: number; turns: SourceTurn[] } | null> {
  const res = await fetchFn(`/api/distill-runs/${jobId}/source-input`)
  if (!res.ok) return null
  return (await res.json()) as { turnCount: number; charCount: number; turns: SourceTurn[] }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test tests/web-api.test.ts && bun run typecheck`
Expected: 全绿 + typecheck 干净。

- [ ] **Step 5: Commit**

```bash
git add src/web/api.ts tests/web-api.test.ts
git commit -m "feat(web-api): distill-runs client + 类型"
```

---

## Task 7: ui-utils 纯函数（formatOutcome / formatRunCounts）

**Files:**
- Modify: `src/web/ui-utils.ts`（文件末尾追加）
- Test: `tests/ui-utils.test.ts`

**Interfaces:**
- Produces: `formatOutcome(outcome)` -> `{ label, color }`、`formatRunCounts({ distilled, deduped, filtered, stored })` -> `string`，供 Task 8 UI 使用。

- [ ] **Step 1: 写失败测试**

在 `tests/ui-utils.test.ts` 加：

```ts
import { formatOutcome, formatRunCounts } from '@/web/ui-utils'

test('formatOutcome maps four outcomes to label + color', () => {
  expect(formatOutcome('produced').color).toBe('#2e7d32')
  expect(formatOutcome('empty_output').color).toBe('#666')
  expect(formatOutcome('llm_error').color).toBe('#c00')
  expect(formatOutcome('skipped_no_new_turns').color).toBe('#999')
  expect(formatOutcome('produced').label).toBe('产出')
})

test('formatRunCounts renders distilled->deduped->filtered->stored chain', () => {
  expect(formatRunCounts({ distilled: 5, deduped: 3, filtered: 1, stored: 1 })).toBe('5->3->1->1')
  expect(formatRunCounts({ distilled: 0, deduped: 0, filtered: 0, stored: 0 })).toBe('0->0->0->0')
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test tests/ui-utils.test.ts -t "formatOutcome|formatRunCounts"`
Expected: FAIL（未导出）。

- [ ] **Step 3: 实现两个纯函数**

`src/web/ui-utils.ts` 末尾追加：

```ts
export type DistillOutcome = 'skipped_no_new_turns' | 'empty_output' | 'llm_error' | 'produced'

/**
 * 蒸馏记录 outcome 四态 -> 徽标 { label, color }。produced 绿 / empty_output 灰 /
 * llm_error 红 / skipped 浅灰。纯函数，可单测（CLAUDE.md「首选可断言面」）。
 *
 * 设计依据：docs/superpowers/specs/2026-07-29-distill-work-record-design.md §7。
 */
export function formatOutcome(outcome: DistillOutcome): { label: string; color: string } {
  if (outcome === 'produced') return { label: '产出', color: '#2e7d32' }
  if (outcome === 'empty_output') return { label: '空产出', color: '#666' }
  if (outcome === 'llm_error') return { label: 'LLM错误', color: '#c00' }
  return { label: '跳过', color: '#999' }
}

/**
 * 计数链 distilled->deduped->filtered->stored 渲染为「N->M->K->J」。
 * 直观显示候选在哪一步被杀光。accepted_count（格式校验后）不在链中，由遮罩层
 * hint 用 rawCount vs acceptedCount 体现。纯函数，可单测。
 */
export function formatRunCounts(c: { distilled: number; deduped: number; filtered: number; stored: number }): string {
  return `${c.distilled}->${c.deduped}->${c.filtered}->${c.stored}`
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test tests/ui-utils.test.ts && bun run typecheck`
Expected: 全绿 + typecheck 干净。

- [ ] **Step 5: Commit**

```bash
git add src/web/ui-utils.ts tests/ui-utils.test.ts
git commit -m "feat(web): formatOutcome/formatRunCounts 纯函数"
```

---

## Task 8: Web UI 第 5 tab + DistillRunRow + DistillRunModal

**Files:**
- Modify: `src/web/App.tsx`（TabKey 第 28 行、tab 数组第 144-149 行、refresh 第 58-85 行、state 第 45-56 行、listEmpty 第 142 行、渲染分支第 246 行、新增组件）
- Test: `tests/web-ui.test.ts`（源码层文本断言兜底）

**Interfaces:**
- Consumes: Task 6 client（`listDistillRuns`/`getDistillRun`/`getDistillRunSourceInput`）、Task 7 纯函数（`formatOutcome`/`formatRunCounts`）、已有 `formatMemoryTime`/`formatSourceTurn`/`SourceInputModal` 渲染模式。
- Produces: 第 5 tab「蒸馏记录」可视面。

- [ ] **Step 1: 写失败测试（源码层文本断言）**

在 `tests/web-ui.test.ts` 加（参照已有 `readFileSync('src/web/App.tsx')` + `expect(src).toContain(...)` 模式）：

```ts
test('App.tsx has distill runs tab + row + modal', () => {
  const src = readFileSync('src/web/App.tsx', 'utf8')
  expect(src).toContain("'runs'")              // TabKey 含 runs
  expect(src).toContain('蒸馏记录')            // tab label
  expect(src).toContain('DistillRunRow')       // 列表行组件
  expect(src).toContain('DistillRunModal')     // 详情遮罩层
  expect(src).toContain('listDistillRuns')     // refresh 拉取
  expect(src).toContain('formatOutcome')       // 徽标纯函数
  expect(src).toContain('formatRunCounts')     // 计数链纯函数
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test tests/web-ui.test.ts -t "distill runs tab"`
Expected: FAIL（断言文本不存在）。

- [ ] **Step 3: 加 import + state**

`src/web/App.tsx` 顶部 api import 加 `listDistillRuns, getDistillRun, getDistillRunSourceInput` 与类型 `DistillRunListItem`；ui-utils import 加 `formatOutcome, formatRunCounts`。

TabKey（第 28 行）加 `'runs'`：

```ts
type TabKey = 'candidate' | 'approved' | 'rejected' | 'discards' | 'runs'
```

state（第 45-56 行附近）加 runs 列表 + modal 触发：

```ts
const [runs, setRuns] = useState<DistillRunListItem[]>([])
const [runDetailFor, setRunDetailFor] = useState<string | null>(null)
```

- [ ] **Step 4: tab 数组加第 5 项**

第 144-149 行 `tabs` 数组追加：

```ts
  { key: 'runs', label: '蒸馏记录', count: status?.distillRuns?.total ?? 0 },
```

- [ ] **Step 5: refresh 加 runs 分支 + tab 切换重置**

`refresh()`（第 58-85 行）加 `myTab === 'runs'` 分支：

```ts
    if (myTab === 'runs') {
      const [runItems, st] = await Promise.all([listDistillRuns(fetch), getStatus(fetch)])
      if (tabRef.current !== myTab) return
      setRuns(runItems); setStatus(st); setError(null); setLoading(false)
      return
    }
```

tab 切换 useEffect（第 89-97 行）reset 里加 `setRuns([])`。

`listEmpty`（第 142 行）加 runs 判断：

```ts
const listEmpty = tab === 'discards' ? discards.length === 0 : tab === 'runs' ? runs.length === 0 : memItems.length === 0
```

- [ ] **Step 6: 渲染分支加 runs**

第 246 行三态门后加 `tab === 'runs'` 分支，映射 `DistillRunRow`：

```tsx
: tab === 'runs' ? (
  <div>
    <p>共 {runs.length} 条蒸馏记录</p>
    {runs.map((r) => (
      <DistillRunRow key={r.distillJobId} r={r} onOpen={() => setRunDetailFor(r.distillJobId)} />
    ))}
    {runs.length === 0 && <p>暂无蒸馏记录</p>}
  </div>
)
```

末尾 modal 渲染（参照 `SourceInputModal` 挂载点第 314-316 行）：

```tsx
{runDetailFor ? <DistillRunModal jobId={runDetailFor} onClose={() => setRunDetailFor(null)} /> : null}
```

- [ ] **Step 7: 实现 DistillRunRow 组件**

在 `DiscardCard` 之后加（复用 inline style 风格）：

```tsx
function DistillRunRow({ r, onOpen }: { r: DistillRunListItem; onOpen: () => void }) {
  const oc = formatOutcome(r.outcome)
  const cwdLabel = r.cwd ? (r.cwd.split(/[\\\\/]/).filter(Boolean).pop() ?? r.cwd) : '未知'
  const time = formatMemoryTime(r.createdAt)
  return (
    <div style={{ border: '1px solid #eee', borderRadius: 6, padding: 12, marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ background: oc.color, color: '#fff', borderRadius: 4, padding: '2px 8px', fontSize: 12 }}>{oc.label}</span>
        <span style={{ fontFamily: 'monospace', fontSize: 13 }}>{formatRunCounts({ distilled: r.rawCount, deduped: r.dedupedCount, filtered: r.filteredCount, stored: r.storedCount })}</span>
      </div>
      <div style={{ fontSize: 13, color: '#555', marginTop: 6 }}>
        {r.sourceAgentId ? 'subagent' : cwdLabel}{time ? ` · ${time}` : ''} · {r.durationMs}ms
      </div>
      <button onClick={onOpen} style={{ marginTop: 8 }}>查看详情</button>
    </div>
  )
}
```

- [ ] **Step 8: 实现 DistillRunModal 组件**

参照 `SourceInputModal`（第 483-557 行）的三态 + ESC + 背景关闭模式，加产出区 + 输入区懒加载：

```tsx
function DistillRunModal({ jobId, onClose }: { jobId: string; onClose: () => void }) {
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof getDistillRun>> | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [source, setSource] = useState<{ turnCount: number; charCount: number; turns: SourceTurn[] } | null>(null)
  const [sourceLoading, setSourceLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true); setError(null); setDetail(null)
    getDistillRun(jobId).then((d) => { if (!cancelled) setDetail(d) })
      .catch((e) => { if (!cancelled) setError(String(e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [jobId])

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h)
  }, [onClose])

  const loadSource = async () => {
    setSourceLoading(true)
    try { setSource(await getDistillRunSourceInput(jobId)) } finally { setSourceLoading(false) }
  }

  const cands = (detail?.rawOutput as { candidates?: any[] } | null)?.candidates
  const oc = detail ? formatOutcome(detail.outcome) : null
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', borderRadius: 8, maxWidth: 900, width: '90%', maxHeight: '85vh', overflow: 'auto', padding: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
          <strong>蒸馏记录详情</strong>
          <button onClick={onClose}>×</button>
        </div>
        {loading ? <p>加载中…</p>
          : error ? <p style={{ color: '#c00' }}>无法加载: {error}</p>
          : detail && oc ? (
            <>
              <div style={{ marginBottom: 8 }}>
                <span style={{ background: oc.color, color: '#fff', borderRadius: 4, padding: '2px 8px', fontSize: 12 }}>{oc.label}</span>
                <span style={{ marginLeft: 8, fontFamily: 'monospace' }}>{formatRunCounts({ distilled: detail.rawCount, deduped: detail.dedupedCount, filtered: detail.filteredCount, stored: detail.storedCount })}</span>
                {detail.rawCount > detail.acceptedCount && (
                  <span style={{ marginLeft: 8, color: '#999' }}>模型返回 {detail.rawCount} 条，{detail.rawCount - detail.acceptedCount} 条格式不合格被丢弃</span>
                )}
              </div>
              <div style={{ marginBottom: 12 }}>
                <strong>产出：</strong>
                {detail.outcome === 'empty_output' ? <span>LLM 返回 0 候选</span>
                  : detail.outcome === 'llm_error' ? <span style={{ color: '#c00' }}>LLM 调用失败</span>
                  : detail.outcome === 'skipped_no_new_turns' ? <span>该 job 无新 turn，未调用 LLM</span>
                  : Array.isArray(cands) ? cands.map((c: any, i: number) => (
                      <pre key={i} style={{ background: '#f7f7f7', padding: 8, margin: '4px 0', whiteSpace: 'pre-wrap' }}>{JSON.stringify(c, null, 2)}</pre>
                    )) : <span>（无产出解析）</span>}
              </div>
              <div>
                <button onClick={loadSource} disabled={sourceLoading}>{sourceLoading ? '加载中…' : '查看原始输入'}</button>
                {source && (
                  <div style={{ marginTop: 8 }}>
                    <p style={{ color: '#666' }}>{source.turnCount} turn · 约 {source.charCount} 字</p>
                    {source.turns.map((t, i) => {
                      const f = formatSourceTurn(t)
                      return <pre key={i} style={{ borderLeft: `3px solid ${f.color}`, padding: '4px 8px', margin: '4px 0', whiteSpace: 'pre-wrap' }}>[{f.label}] {t.content}</pre>
                    })}
                  </div>
                )}
              </div>
            </>
          ) : <p>无记录</p>}
      </div>
    </div>
  )
}
```

> 注：`SourceTurn`/`formatSourceTurn`/`getDistillRun`/`getDistillRunSourceInput` 需在 App.tsx import。`SourceTurn` 类型从 `@/web/api` 导入。

- [ ] **Step 9: 运行测试确认通过**

Run: `bun test tests/web-ui.test.ts && bun run typecheck && bun test`
Expected: 全绿（含源码层断言 + 全套回归）+ typecheck 干净。

- [ ] **Step 10: Commit**

```bash
git add src/web/App.tsx tests/web-ui.test.ts
git commit -m "feat(web): 第 5 tab 蒸馏记录 + DistillRunRow/Modal"
```

---

## Self-Review（plan 作者已执行）

1. **Spec coverage**: §4 数据模型 -> Task 1；§5 写入侧（distiller 返回值 + scheduler 接线 + 去门）-> Task 2/4；§6 读取侧（store + 3 端点 + status）-> Task 3/5；§7 Web UI -> Task 6/7/8；§9 测试策略 各 case 映射到对应任务的测试步骤。无遗漏。
2. **Placeholder scan**: 无 TBD/TODO；每步含实际代码。两处测试占位写法（Task 3 UPSERT 的 `$client.exec` 行、Task 4 的 `callThrew` 列断言）已在注释中标明删除/修正。
3. **Type consistency**: `DistillOutcome` 四值在 store/api/ui-utils 三处一致；`DistillRunListRow`（无 rawOutput）vs `DistillRunRow`/`DistillRunDetail`（含 rawOutput）区分与 spec §6「列表不含 rawOutput」一致；`saveDistillRun` 入参 `DistillRunRecord` 字段名与 `DistillRunRow` 输出字段名对齐（rawCount/distilledCount 等映射在 rowToRun 内）。
4. **歧义**: 计数链 4 段 vs 5 列已澄清（链用 distilled->deduped->filtered->stored，accepted 在 hint）；`filtered_count === stored_count` 当前恒等已注明。

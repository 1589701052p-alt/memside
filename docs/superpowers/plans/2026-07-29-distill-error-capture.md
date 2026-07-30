# 蒸馏 LLM 错误捕获与透传 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `llm_error` 的 distill run 记录并展示底层 LLM 调用的错误描述，不再黑盒；顺便修复 callThrew 时 source input 被清空 + `/api/status` 找不到 llm_error 的伴生缺口。

**Architecture:** 方案 2--错误捕获留在 distiller 层。`wrappedCall` 的 catch 记 `lastErrorMessage`，`DistillResult` 透出 `errorMessage`，经 scheduler 写入 `memory_distill_runs.error_message` 新列 + llm_error 时回写 `memory_distill_jobs.last_error`。`callWithRetry` / dedup / valueFilter 不动。store 加字段后 server 端点自然带出，Web UI 在 llm_error 时展示。

**Tech Stack:** Bun + Hono + Drizzle + bun:sqlite + zod + React 19（与既有 distill-work-record 同栈）。

## Global Constraints

- `bun run typecheck && bun test` 必须全绿才能 push（CLAUDE.md 运行门槛）。
- 任何代码改动带对应测试（TDD：先红后绿）。
- `errorMessage` 是 **required nullable** 字段（`string | null`，非 optional）--与 `rawOutput` 等同模式，强制每个 `saveDistillRun` 调用显式思考。既有调用点加 `errorMessage: null`。
- Web UI 状态可见性硬规则：llm_error + 无 errorMessage（历史 run）时显示「无错误描述」兜底，不得空白。
- 错误以字符串存储（含 HTTP status 若有，如 `"500 Internal Server Error"`）；不做结构化分类（非目标）。
- DB 时间戳为 epoch ms（既有约定）。

---

### Task 1: db schema + 幂等迁移（error_message 列）

**Files:**
- Modify: `src/db/schema.ts:128-143`（`memoryDistillRuns` drizzle 定义）
- Modify: `src/db/client.ts:89-101`（DDL）+ 新增幂等 ALTER 块
- Test: `tests/schema.test.ts`

**Interfaces:**
- Produces: `memoryDistillRuns.errorMessage` drizzle 列（`text('error_message')`）+ DDL `error_message TEXT` 列。后续 task 的 store 层依赖此列存在。

- [ ] **Step 1: 写失败测试（fresh db 有 error_message 列）**

追加到 `tests/schema.test.ts` 末尾：

```ts
test('fresh db has error_message column on memory_distill_runs', () => {
  db = openDb(join(dir, 'em.db'))
  const cols = db.$client.prepare('PRAGMA table_info(memory_distill_runs)').all() as { name: string }[]
  expect(cols.some((c) => c.name === 'error_message')).toBe(true)
})

test('migration adds error_message to pre-existing memory_distill_runs, idempotent, no backfill', () => {
  const dbPath = join(dir, 'oldem.db')
  // 旧形态库：memory_distill_runs 无 error_message 列
  const old = new Database(dbPath)
  old.exec(`CREATE TABLE memory_distill_runs (distill_job_id TEXT PRIMARY KEY, outcome TEXT NOT NULL, raw_output_json TEXT, distilled_count INTEGER NOT NULL, accepted_count INTEGER NOT NULL, deduped_count INTEGER NOT NULL, filtered_count INTEGER NOT NULL, stored_count INTEGER NOT NULL, discarded_count INTEGER NOT NULL, duration_ms INTEGER NOT NULL, ts INTEGER NOT NULL)`)
  old.exec(`INSERT INTO memory_distill_runs (distill_job_id, outcome, raw_output_json, distilled_count, accepted_count, deduped_count, filtered_count, stored_count, discarded_count, duration_ms, ts) VALUES ('j1','llm_error',NULL,0,0,0,0,0,0,1234,1)`)
  old.close()
  const migrated = openDb(dbPath)
  const cols = migrated.$client.prepare('PRAGMA table_info(memory_distill_runs)').all() as { name: string }[]
  expect(cols.some((c) => c.name === 'error_message')).toBe(true)
  // no backfill: existing row stays NULL
  const rows = migrated.$client.prepare('SELECT distill_job_id, error_message FROM memory_distill_runs').all() as { distill_job_id: string; error_message: string | null }[]
  expect(rows.find((r) => r.distill_job_id === 'j1')!.error_message).toBeNull()
  migrated.$client.close()
  // 幂等：reopen 不抛（guard 跳过 ALTER，否则 duplicate column 报错）
  const reopened = openDb(dbPath)
  expect((reopened.$client.prepare('PRAGMA table_info(memory_distill_runs)').all() as { name: string }[]).some((c) => c.name === 'error_message')).toBe(true)
  reopened.$client.close()
})
```

注：`tests/schema.test.ts` 顶部已 import `Database` from `bun:sqlite`、`openDb`、`join`。无需新增 import。

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/schema.test.ts -t "error_message"`
Expected: FAIL（fresh db 测试因列不存在失败；迁移测试因无 ALTER 失败）

- [ ] **Step 3: 改 schema.ts drizzle 定义**

`src/db/schema.ts` 的 `memoryDistillRuns`（line 128-143），在 `durationMs` 后、`ts` 前加列：

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
    errorMessage: text('error_message'),   // 新增：nullable；llm_error 时存错误描述，其余 null
    ts: integer('ts').notNull(),
  },
)
```

- [ ] **Step 4: 改 client.ts DDL + 加幂等 ALTER**

`src/db/client.ts` 的 `memory_distill_runs` DDL（line 89-101），在 `duration_ms` 后、`ts` 前加 `error_message TEXT`：

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
      error_message    TEXT,
      ts               INTEGER NOT NULL
    );
```

在 `openDb` 末尾（`return db` 之前，与既有迁移块同级）加幂等 ALTER，参照 `value_class` 迁移模式（client.ts:114-121）：

```ts
  // Idempotent migration: add error_message to pre-existing memory_distill_runs.
  // llm_error 时存 LLM 调用错误描述（spec §数据模型）。无 backfill（老行 NULL）。
  {
    const cols = raw.prepare('PRAGMA table_info(memory_distill_runs)').all() as { name: string }[]
    if (!cols.some((c) => c.name === 'error_message')) {
      raw.exec('ALTER TABLE memory_distill_runs ADD COLUMN error_message TEXT')
    }
  }
```

- [ ] **Step 5: 跑测试确认通过**

Run: `bun test tests/schema.test.ts -t "error_message"`
Expected: PASS（2 条）

- [ ] **Step 6: typecheck + 全量回归**

Run: `bun run typecheck && bun test`
Expected: typecheck 干净；测试全绿（既有测试不受影响--新列 nullable，无 backfill）。

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.ts src/db/client.ts tests/schema.test.ts
git commit -m "feat(db): memory_distill_runs 加 error_message 列 + 幂等迁移"
```

---

### Task 2: distiller 透传 errorMessage + filteredTurns 修复

**Files:**
- Modify: `src/memory/distiller.ts:107-116`（DistillResult）+ `:161-228`（distillTranscript）
- Test: `tests/distiller.test.ts`

**Interfaces:**
- Consumes: Task 1 无关（distiller 不碰 DB）。
- Produces: `DistillResult.errorMessage: string | null`。Task 4 scheduler 解构此字段。

- [ ] **Step 1: 写失败测试**

追加到 `tests/distiller.test.ts` 末尾（顶部已 import `distillTranscript`）：

```ts
test('distillTranscript captures last LLM error message when all attempts throw', async () => {
  // 3 次 attempt 都抛错：errorMessage 应为最后一次的 message（spec §透传路径）。
  let calls = 0
  const result = await distillTranscript({
    turns: [{ role: 'user', content: 'x' }],
    runtime: 'claude-code', cwd: '/repo', existingSlugs: [],
    callLLM: async () => {
      calls++
      throw new Error(calls <= 2 ? 'timeout' : '500 Internal Server Error')
    },
  })
  expect(result.candidates).toEqual([])
  expect(result.callThrew).toBe(true)
  expect(result.errorMessage).toBe('500 Internal Server Error')
  expect(calls).toBe(3)  // callWithRetry maxRetries=2 -> 3 attempts
})

test('distillTranscript errorMessage is null on retry-success', async () => {
  // attempt 0 抛错（记 lastErrorMessage）、attempt 1 成功产出候选：
  // callThrew=false（最后 attempt 重置并成功）、有候选 -> errorMessage=null（spec §透传路径）。
  let calls = 0
  const result = await distillTranscript({
    turns: [{ role: 'user', content: 'we refund within 14 days' }],
    runtime: 'claude-code', cwd: '/repo', existingSlugs: [],
    callLLM: async () => {
      calls++
      if (calls === 1) throw new Error('timeout')
      return JSON.stringify({ candidates: [{ title: '[category:invariant] refunds 14d', bodyMd: '14d', scope: 'project', runtime: null, distillAction: 'new' }] })
    },
  })
  expect(result.candidates.length).toBe(1)
  expect(result.errorMessage).toBeNull()
})

test('distillTranscript errorMessage is null on parse failure (call did not throw)', async () => {
  // callLLM 成功返回非 JSON：callThrew=false、无候选 -> empty_output，errorMessage=null。
  const result = await distillTranscript({
    turns: [{ role: 'user', content: 'x' }],
    runtime: 'claude-code', cwd: '/repo', existingSlugs: [],
    callLLM: async () => 'not json',
  })
  expect(result.candidates).toEqual([])
  expect(result.callThrew).toBe(false)
  expect(result.errorMessage).toBeNull()
})

test('distillTranscript preserves filteredTurns when callThrew (regression: source input must not be cleared)', async () => {
  // 回归防护：callThrew 时 filteredTurns 必须保留（spec §source input 修复）。
  // 历史 bug：distiller.ts 曾用 `filteredTurns: callThrew ? [] : filtered` 清空，
  // 导致 llm_error job 的 source input 丢失（turnCount:0）。此测试锁住修复。
  const result = await distillTranscript({
    turns: [{ role: 'user', content: 'meaningful turn that must be preserved' }],
    runtime: 'claude-code', cwd: '/repo', existingSlugs: [],
    callLLM: async () => { throw new Error('api down') },
  })
  expect(result.callThrew).toBe(true)
  expect(result.filteredTurns.length).toBeGreaterThan(0)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/distiller.test.ts -t "errorMessage\\|filteredTurns when callThrew"`
Expected: FAIL（`result.errorMessage` undefined；filteredTurns 为空数组）

- [ ] **Step 3: 改 DistillResult 接口**

`src/memory/distiller.ts:107-116`，加 `errorMessage` 字段：

```ts
export interface DistillResult {
  candidates: DistillCandidate[]
  filteredTurns: TranscriptTurn[]
  /** LLM 原始解析输出（candidates 数组原样，含被格式校验丢弃的）。无候选/跳过/报错时为 null。 */
  rawOutput: unknown | null
  /** LLM 返回的原始候选数（含格式不合格被丢的）。 */
  rawCount: number
  /** 底层 LLM 调用是否抛错（scheduler 据此判 llm_error vs empty_output）。 */
  callThrew: boolean
  /** LLM 调用错误描述（最后一次 attempt 的错误 message）。仅 llm_error 时非 null；
   *  produced/empty_output/skipped 时 null。retry-success 时 null（错误被成功覆盖）。 */
  errorMessage: string | null
}
```

- [ ] **Step 4: 改 wrappedCall 捕获 lastErrorMessage**

`src/memory/distiller.ts:171-184`，加 `lastErrorMessage` 变量并在 catch 记录：

```ts
    let callThrew = false
    let lastErrorMessage: string | null = null
    const wrappedCall: LLMCall = async (sys, user, opts) => {
      // reset per attempt: a prior failed attempt must not stain a later success.
      callThrew = false
      try {
        return await input.callLLM(sys, user, opts)
      } catch (e) {
        callThrew = true
        lastErrorMessage = e instanceof Error ? e.message : String(e)
        throw e
      }
    }
```

- [ ] **Step 5: 改 !parsed 分支（filteredTurns 修复 + errorMessage）**

`src/memory/distiller.ts:191-194`。去掉 `callThrew ? [] : filtered`，加 errorMessage：

```ts
    const rawOutput: unknown = parsed ?? null
    if (!parsed || !Array.isArray(parsed.candidates)) {
      // filteredTurns 恒为过滤快照（调用前已算出，与调用成败无关）。
      // 历史 bug 曾在 callThrew 时清空 -> llm_error job 丢失 source input（spec §source input 修复）。
      return { candidates: [], filteredTurns: filtered, rawOutput, rawCount: 0, callThrew,
        errorMessage: callThrew ? lastErrorMessage : null }
    }
```

- [ ] **Step 6: 改成功分支（显式 errorMessage: null）**

`src/memory/distiller.ts:223`，成功返回加 `errorMessage: null`（防止 attempt 0 残留的 lastErrorMessage 污染产出记录）：

```ts
    return { candidates: out, filteredTurns: filtered, rawOutput, rawCount, callThrew, errorMessage: null }
```

- [ ] **Step 7: 改顶层 catch（命名 e + errorMessage）**

`src/memory/distiller.ts:224-227`，`catch` 加参数并透出 errorMessage：

```ts
  } catch (e) {
    // Never throw: distill failures degrade to "no candidates this round".
    // 顶层兜底（detectErrorSignals/filterTranscriptForDistill 等纯函数抛错时），
    // 不可达路径，errorMessage 仍透出异常 message 供诊断。
    return { candidates: [], filteredTurns: [], rawOutput: null, rawCount: 0, callThrew: true,
      errorMessage: e instanceof Error ? e.message : String(e) }
  }
```

- [ ] **Step 8: 跑测试确认通过**

Run: `bun test tests/distiller.test.ts`
Expected: PASS（4 条新测试 + 既有全绿；既有 `never throws` 测试仍绿）

- [ ] **Step 9: typecheck + 全量回归**

Run: `bun run typecheck && bun test`
Expected: typecheck 干净（DistillResult 加 required 字段，但 distiller 内部三路径都已返回）；全量绿。

- [ ] **Step 10: Commit**

```bash
git add src/memory/distiller.ts tests/distiller.test.ts
git commit -m "feat(distiller): 透传 errorMessage + 修复 callThrew 时 filteredTurns 清空"
```

---

### Task 3: store 层适配 errorMessage

**Files:**
- Modify: `src/memory/store.ts:555-565`（DistillRunRecord）+ `:567-579`（DistillRunRow）+ `:581-599`（saveDistillRun）+ `:601-612`（rowToRun）+ `:622-637`（DistillRunListRow）+ `:644-660`（listRecentDistillRuns）
- Test: `tests/store-crud.test.ts`（既有 distill run 测试在 line 224+）

**Interfaces:**
- Consumes: Task 1 的 `memoryDistillRuns.errorMessage` 列。
- Produces: `DistillRunRecord.errorMessage` / `DistillRunRow.errorMessage` / `DistillRunListRow.errorMessage`。Task 4 scheduler 调 `saveDistillRun` 传 errorMessage；Task 5 server 端点返回 `DistillRunRow`/`DistillRunListRow`（自动含 errorMessage）。

- [ ] **Step 1: 写失败测试**

追加到 `tests/store-crud.test.ts`（既有 distill run 测试段，line 224+；`saveDistillRun`/`getDistillRun`/`listRecentDistillRuns`/`memoryDistillRuns` 已 import，`db` 在 beforeEach 开）：

```ts
test('saveDistillRun persists errorMessage; getDistillRun reads it back', async () => {
  await saveDistillRun(db, 'job-em1', { outcome: 'llm_error', rawOutput: null, rawCount: 0,
    acceptedCount: 0, dedupedCount: 0, filteredCount: 0, storedCount: 0, discardedCount: 0,
    durationMs: 42, errorMessage: '500 Internal Server Error' })
  const run = await getDistillRun(db, 'job-em1')
  expect(run?.errorMessage).toBe('500 Internal Server Error')
  expect(run?.outcome).toBe('llm_error')
})

test('saveDistillRun UPSERT overwrites errorMessage', async () => {
  await saveDistillRun(db, 'job-em2', { outcome: 'llm_error', rawOutput: null, rawCount: 0,
    acceptedCount: 0, dedupedCount: 0, filteredCount: 0, storedCount: 0, discardedCount: 0,
    durationMs: 5, errorMessage: 'timeout' })
  await saveDistillRun(db, 'job-em2', { outcome: 'produced', rawOutput: null, rawCount: 1,
    acceptedCount: 1, dedupedCount: 1, filteredCount: 1, storedCount: 1, discardedCount: 0,
    durationMs: 9, errorMessage: null })
  const run = await getDistillRun(db, 'job-em2')
  expect(run?.errorMessage).toBeNull()
  expect(run?.outcome).toBe('produced')
})

test('listRecentDistillRuns returns errorMessage in each row', async () => {
  await saveDistillRun(db, 'job-em3', { outcome: 'llm_error', rawOutput: null, rawCount: 0,
    acceptedCount: 0, dedupedCount: 0, filteredCount: 0, storedCount: 0, discardedCount: 0,
    durationMs: 1, errorMessage: 'fetch failed' })
  const rows = await listRecentDistillRuns(db)
  const row = rows.find((r) => r.distillJobId === 'job-em3')
  expect(row?.errorMessage).toBe('fetch failed')
})
```

- [ ] **Step 2: 更新既有 saveDistillRun 调用（加 errorMessage: null）**

`tests/store-crud.test.ts` 既有 3 处 `saveDistillRun` 调用（line 226, 235, 236, 256, 257）加 `errorMessage: null`（produced/empty_output 既有调用）。例如 line 226：

```ts
await saveDistillRun(db, 'job-r1', { outcome: 'produced', rawOutput: { candidates: [{ title: 'x' }] }, rawCount: 1, acceptedCount: 1, dedupedCount: 1, filteredCount: 1, storedCount: 1, discardedCount: 0, durationMs: 42, errorMessage: null })
```

同样改 line 235、236（job-r2 两次）、256（job-l1）、257（job-l2）。

- [ ] **Step 3: 跑测试确认失败**

Run: `bun test tests/store-crud.test.ts -t "errorMessage"`
Expected: FAIL（`errorMessage` 不在 Record 类型 / 未写入 / 未读回）

- [ ] **Step 4: 改 store.ts 类型 + 函数**

`src/memory/store.ts`：

(a) `DistillRunRecord`（line 555）加字段：
```ts
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
  errorMessage: string | null   // 新增
}
```

(b) `DistillRunRow`（line 567）加 `errorMessage: string | null`（在 `durationMs` 后、`ts` 前）。

(c) `saveDistillRun`（line 581-599）：insert values + onConflictDoUpdate set 都加 `errorMessage: record.errorMessage`：
```ts
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
    durationMs: record.durationMs, errorMessage: record.errorMessage, ts: now,
  }).onConflictDoUpdate({
    target: memoryDistillRuns.distillJobId,
    set: { outcome: record.outcome, rawOutputJson, distilledCount: record.rawCount,
      acceptedCount: record.acceptedCount, dedupedCount: record.dedupedCount,
      filteredCount: record.filteredCount, storedCount: record.storedCount,
      discardedCount: record.discardedCount, durationMs: record.durationMs,
      errorMessage: record.errorMessage, ts: now },
  })
}
```

(d) `rowToRun`（line 601-612）：返回对象加 `errorMessage: r.errorMessage`（在 `durationMs` 后）。

(e) `DistillRunListRow`（line 622）加 `errorMessage: string | null`（在 `durationMs` 后、`ts` 前）。

(f) `listRecentDistillRuns`（line 648-654）：`cols` 对象加 `errorMessage: memoryDistillRuns.errorMessage`。

- [ ] **Step 5: 跑测试确认通过**

Run: `bun test tests/store-crud.test.ts`
Expected: PASS（3 条新 + 既有 distill run 测试绿）

- [ ] **Step 6: typecheck + 全量回归**

Run: `bun run typecheck && bun test`
Expected: typecheck 报 scheduler.ts 的 saveDistillRun 调用缺 errorMessage（Task 4 修）；store 自身测试绿。**此时 typecheck 可能因 scheduler 未改而失败--先只跑 store 测试确认本 task 绿，scheduler 在 Task 4 修后 typecheck 全绿。**

Run: `bun test tests/store-crud.test.ts tests/schema.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/memory/store.ts tests/store-crud.test.ts
git commit -m "feat(store): saveDistillRun/getDistillRun/listRecentDistillRuns 适配 errorMessage"
```

---

### Task 4: scheduler 接线 + llm_error 写 job.last_error

**Files:**
- Modify: `src/scheduler.ts:134-138`（skipped 分支 saveDistillRun）+ `:158`（解构）+ `:217-229`（主路径 saveDistillRun + 新增 last_error 回写）
- Test: `tests/scheduler.test.ts`（`enqueueDistillJob`/`tick` 已 import，`memoryDistillJobs`/`memoryDistillRuns` 已 import）

**Interfaces:**
- Consumes: Task 2 的 `DistillResult.errorMessage` + Task 3 的 `saveDistillRun(errorMessage)`。
- Produces: llm_error 时 `memory_distill_jobs.last_error` 被写 -> Task 5 `/api/status` 的 `lastError` 生效。

- [ ] **Step 1: 写失败测试**

追加到 `tests/scheduler.test.ts`：

```ts
test('llm_error: scheduler writes errorMessage to distill run + job.last_error', async () => {
  const { jobId } = await enqueueDistillJob(db, {
    sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0,
  })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId)).run()
  await tick(db, {
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'x' }], fullLength: 1 }),
    callLLM: async () => { throw new Error('500 Internal Server Error') },
    createCandidate: async () => ({ id: 'c', status: 'candidate', version: 1 } as any),
  })
  // distill run 记录 errorMessage
  const run = await db.select().from(memoryDistillRuns).where(eq(memoryDistillRuns.distillJobId, jobId)).all()
  expect(run[0]!.outcome).toBe('llm_error')
  expect(run[0]!.errorMessage).toBe('500 Internal Server Error')
  // job.last_error 回写（/api/status lastError 生效）
  const job = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, jobId)).all()
  expect(job[0]!.lastError).toBe('500 Internal Server Error')
  expect(job[0]!.status).toBe('done')
})

test('produced: scheduler does NOT write job.last_error', async () => {
  const { jobId } = await enqueueDistillJob(db, {
    sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0,
  })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId)).run()
  await tick(db, {
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'refund 14 days' }], fullLength: 1 }),
    callLLM: async () => JSON.stringify({ candidates: [{ title: '[category:invariant] 14d', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] }),
    createCandidate: async () => ({ id: 'c', status: 'candidate', version: 1 } as any),
  })
  const job = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, jobId)).all()
  expect(job[0]!.lastError).toBeNull()
  expect(job[0]!.status).toBe('done')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/scheduler.test.ts -t "llm_error: scheduler\\|produced: scheduler"`
Expected: FAIL（`run[0].errorMessage` undefined / `job.lastError` 为 null）

- [ ] **Step 3: 改 scheduler 解构 + skipped 分支**

`src/scheduler.ts:158` 解构加 `errorMessage`：

```ts
      const { candidates, filteredTurns, rawOutput, rawCount, callThrew, errorMessage } = await distillTranscript({
```

`src/scheduler.ts:134-138` skipped 分支 saveDistillRun 加 `errorMessage: null`：

```ts
          await saveDistillRun(db, job.id, {
            outcome: 'skipped_no_new_turns', rawOutput: null, rawCount: 0,
            acceptedCount: 0, dedupedCount: 0, filteredCount: 0, storedCount: 0,
            discardedCount: 0, durationMs: 0, errorMessage: null,
          })
```

- [ ] **Step 4: 改主路径 saveDistillRun + 加 last_error 回写**

`src/scheduler.ts:215-228`。把 outcome 提取为变量（saveDistillRun 与 last_error 判断共用），saveDistillRun 传 errorMessage，其后加 llm_error 回写 job.last_error：

```ts
      // 运行记录：outcome + 计数链 + LLM 原始产出 + 错误描述。best-effort，与 logDiscards/saveSourceInput 同级。
      const outcome = candidates.length === 0 ? (callThrew ? 'llm_error' : 'empty_output') : 'produced'
      try {
        await saveDistillRun(db, job.id, {
          // spec §4: produced = accepted_count > 0 regardless of transient LLM
          // errors during retry. Check candidates.length===0 FIRST so a retry-
          // success (callThrew=true from attempt 0 but candidates produced on
          // attempt 1) is classified 'produced', not 'llm_error'.
          outcome,
          rawOutput, rawCount, acceptedCount: candidates.length, dedupedCount: deduped.length,
          filteredCount: keepWithClass.length, storedCount: keepWithClass.length,
          discardedCount: discarded.length, durationMs, errorMessage,
        })
      } catch (e) { console.warn('memside: saveDistillRun failed', e) }
      // /api/status 修复（spec §scheduler）：llm_error 时把错误也写进 job.last_error，
      // 顶部状态栏的 lastError 才能看到 LLM 错误（既有 lastError 查 j.lastError 非空）。
      // best-effort：失败只 warn，不阻塞 done。
      if (outcome === 'llm_error' && errorMessage) {
        try {
          await db.update(memoryDistillJobs).set({ lastError: errorMessage })
            .where(eq(memoryDistillJobs.id, job.id)).run()
        } catch (e) { console.warn('memside: set lastError failed', e) }
      }
```

- [ ] **Step 5: 跑测试确认通过**

Run: `bun test tests/scheduler.test.ts`
Expected: PASS（2 条新 + 既有全绿）

- [ ] **Step 6: typecheck + 全量回归**

Run: `bun run typecheck && bun test`
Expected: typecheck 干净（scheduler 调用已补 errorMessage）；全量绿。

- [ ] **Step 7: Commit**

```bash
git add src/scheduler.ts tests/scheduler.test.ts
git commit -m "feat(scheduler): 接线 errorMessage + llm_error 回写 job.last_error"
```

---

### Task 5: server 端点验证 + web-api client 类型

**Files:**
- Modify: `src/web/api.ts:189-208`（`DistillRunListItem` + `DistillRunDetail` 类型）
- Test: `tests/server.test.ts`（`createApp`/`saveDistillRun` 已 import）+ `tests/web-api.test.ts`（`listDistillRuns`/`getDistillRun` 已 import）

**Interfaces:**
- Consumes: Task 3 的 `DistillRunRow`/`DistillRunListRow`（server 端点自动序列化含 errorMessage）。
- Produces: `DistillRunListItem.errorMessage` / `DistillRunDetail.errorMessage`。Task 6 Web UI 消费。

- [ ] **Step 1: 写失败测试（server 端点返回 errorMessage）**

追加到 `tests/server.test.ts`：

```ts
test('GET /api/distill-runs/:jobId returns errorMessage', async () => {
  await saveDistillRun(db, 'job-em1', { outcome: 'llm_error', rawOutput: null, rawCount: 0,
    acceptedCount: 0, dedupedCount: 0, filteredCount: 0, storedCount: 0, discardedCount: 0,
    durationMs: 42, errorMessage: '500 Internal Server Error' })
  const res = await app.request('/api/distill-runs/job-em1')
  const data = await res.json()
  expect(data.errorMessage).toBe('500 Internal Server Error')
  expect(data.outcome).toBe('llm_error')
})

test('GET /api/distill-runs list items include errorMessage', async () => {
  await saveDistillRun(db, 'job-em2', { outcome: 'llm_error', rawOutput: null, rawCount: 0,
    acceptedCount: 0, dedupedCount: 0, filteredCount: 0, storedCount: 0, discardedCount: 0,
    durationMs: 1, errorMessage: 'timeout' })
  const res = await app.request('/api/distill-runs')
  const data = await res.json()
  const row = (data.items as any[]).find((r) => r.distillJobId === 'job-em2')
  expect(row?.errorMessage).toBe('timeout')
})
```

- [ ] **Step 2: 写失败测试（web-api 类型 + URL）**

追加到 `tests/web-api.test.ts`：

```ts
test('getDistillRun returns errorMessage in detail', async () => {
  let called = ''
  const fake = (url: string) => {
    called = url
    return Promise.resolve({ ok: true, json: async () => ({
      distillJobId: 'j1', outcome: 'llm_error', errorMessage: '500 boom',
      rawCount: 0, acceptedCount: 0, dedupedCount: 0, filteredCount: 0,
      storedCount: 0, discardedCount: 0, durationMs: 1, ts: 1,
      cwd: null, runtime: 'claude-code', createdAt: 1, sourceAgentId: null, rawOutput: null,
    }) } as any)
  }
  const r = await getDistillRun('j1', fake as any)
  expect(called).toBe('/api/distill-runs/j1')
  expect(r.errorMessage).toBe('500 boom')
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `bun test tests/server.test.ts -t "errorMessage" && bun test tests/web-api.test.ts -t "errorMessage in detail"`
Expected: server 测试 PASS（端点已自动带出 errorMessage，因 store 加了字段）；web-api 测试 FAIL（类型无 errorMessage，但运行时 JS 不报错--断言 r.errorMessage 仍可能 PASS 因 JSON 含该字段）。

注：web-api 类型是 TS 编译期约束，运行时测试不断言类型。若 Step 3 web-api 测试 PASS，靠 Step 5 typecheck 锁类型。

- [ ] **Step 4: 改 web-api.ts 类型**

`src/web/api.ts:189-208`，`DistillRunListItem` 加 `errorMessage: string | null`（在 `durationMs` 后、`ts` 前）；`DistillRunDetail extends DistillRunListItem` 自动继承：

```ts
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
  errorMessage: string | null   // 新增
  ts: number
  cwd: string | null
  runtime: string
  createdAt: number
  sourceAgentId: string | null
}
```

- [ ] **Step 5: 跑测试 + typecheck**

Run: `bun test tests/server.test.ts tests/web-api.test.ts && bun run typecheck`
Expected: server 测试 PASS（2 条）；web-api 测试 PASS；typecheck 干净。

- [ ] **Step 6: 全量回归**

Run: `bun run typecheck && bun test`
Expected: 全量绿。

- [ ] **Step 7: Commit**

```bash
git add src/web/api.ts tests/server.test.ts tests/web-api.test.ts
git commit -m "feat(web-api): distill-runs client + 端点验证 errorMessage"
```

---

### Task 6: Web UI 展示错误（DistillRunModal + DistillRunRow）

**Files:**
- Modify: `src/web/App.tsx:513-...`（DistillRunRow 加截断错误）+ `:698-706`（DistillRunModal 产出区 llm_error 分支）
- Test: `tests/web-ui.test.ts`（源代码层文本断言，既有模式 line 82+）

**Interfaces:**
- Consumes: Task 5 的 `DistillRunDetail.errorMessage` / `DistillRunListItem.errorMessage`。
- Produces: 用户可见的 llm_error 错误展示。

- [ ] **Step 1: 写失败测试（源代码层文本断言）**

追加到 `tests/web-ui.test.ts`（既有 readFileSync App.tsx + toContain 模式，参照 line 82-87）：

```ts
test('DistillRunModal renders llm_error errorMessage', () => {
  const src = readFileSync(join(import.meta.dir, '..', 'src', 'web', 'App.tsx'), 'utf8')
  // llm_error 分支展示 errorMessage（非空白兜底）
  expect(src).toContain('detail.errorMessage')
  expect(src).toContain('无错误描述')
})

test('DistillRunRow renders truncated errorMessage for llm_error', () => {
  const src = readFileSync(join(import.meta.dir, '..', 'src', 'web', 'App.tsx'), 'utf8')
  // 列表行 llm_error 时显示截断错误
  expect(src).toContain("r.outcome === 'llm_error'")
  expect(src).toContain('r.errorMessage')
  expect(src).toContain('textOverflow')
})
```

注：若 `tests/web-ui.test.ts` 顶部未 import `readFileSync`/`join`，加 `import { readFileSync } from 'node:fs'` + `import { join } from 'node:path'`（参照既有测试的 import）。

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/web-ui.test.ts -t "llm_error errorMessage\\|truncated errorMessage"`
Expected: FAIL（`detail.errorMessage` / `无错误描述` / `r.errorMessage` 等文本不在 App.tsx）

- [ ] **Step 3: 改 DistillRunModal 产出区 llm_error 分支**

`src/web/App.tsx:700-705`，llm_error 分支从纯文案改为展示 errorMessage：

```tsx
              {detail.outcome === 'empty_output' ? <span>LLM 返回 0 候选</span>
                : detail.outcome === 'llm_error' ? (
                  <div>
                    <span style={{ color: '#c00' }}>LLM 调用失败</span>
                    {detail.errorMessage ? (
                      <pre style={{ background: '#fff4f4', color: '#c00', padding: 8, margin: '4px 0', whiteSpace: 'pre-wrap', borderLeft: '3px solid #c00' }}>{detail.errorMessage}</pre>
                    ) : <span style={{ color: '#999', marginLeft: 8 }}>（无错误描述）</span>}
                  </div>
                )
                : detail.outcome === 'skipped_no_new_turns' ? <span>该 job 无新 turn，未调用 LLM</span>
                : Array.isArray(cands) ? cands.map((c, i) => (
                    <pre key={i} style={{ background: '#f7f7f7', padding: 8, margin: '4px 0', whiteSpace: 'pre-wrap' }}>{JSON.stringify(c, null, 2)}</pre>
                  )) : <span>（无产出解析）</span>}
```

- [ ] **Step 4: 改 DistillRunRow 加截断错误**

`src/web/App.tsx` 的 `DistillRunRow` 组件（line 513+），在 outcome 徽标 + 计数链展示之后、组件返回的闭合前，加一行截断错误。先 Read 该组件当前结构定位插入点，在 outcome/计数行下方加：

```tsx
              {r.outcome === 'llm_error' && r.errorMessage && (
                <div style={{ color: '#c00', fontSize: 12, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {r.errorMessage}
                </div>
              )}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `bun test tests/web-ui.test.ts`
Expected: PASS（2 条新 + 既有绿）

- [ ] **Step 6: typecheck + 全量回归**

Run: `bun run typecheck && bun test`
Expected: typecheck 干净；全量绿（470+ 新增测试）。

- [ ] **Step 7: Commit**

```bash
git add src/web/App.tsx tests/web-ui.test.ts
git commit -m "feat(web): DistillRunModal/Row 展示 llm_error 错误描述"
```

---

## Self-Review

**1. Spec coverage:**
- 数据模型（error_message 列）-> Task 1 ✓
- 透传路径（wrappedCall + DistillResult + 三路径取值表）-> Task 2 ✓
- source input 清空修复 -> Task 2 Step 5 ✓
- store 层（Record/Row/ListRow + save/get/list）-> Task 3 ✓
- scheduler（解构 + saveDistillRun 传 + llm_error 写 last_error）-> Task 4 ✓
- server 端点 -> Task 5 ✓
- /api/status lastError 修复 -> Task 4 Step 4（llm_error 写 job.last_error）✓
- Web UI（Modal 完整 + Row 截断 + 历史兜底）-> Task 6 ✓
- 测试策略 15 条 -> Task 2 (4) + Task 3 (3) + Task 4 (2) + Task 5 (3) + Task 6 (2) + Task 1 (2) = 16 条 ✓
- 顶层 catch errorMessage：Task 2 Step 7 实现，不可达路径不写独立测试（靠既有 never-throws 测试 + 代码审查），spec §测试 #4 细化 ✓

**2. Placeholder scan:** 无 TBD/TODO；所有代码块完整；无"参照 Task N"（既有调用更新已展开）。

**3. Type consistency:**
- `errorMessage: string | null` 在 DistillResult / DistillRunRecord / DistillRunRow / DistillRunListRow / DistillRunListItem / DistillRunDetail 一致 ✓
- `lastErrorMessage`（distiller 内部变量）vs `errorMessage`（接口字段）命名区分 ✓
- scheduler 解构 `errorMessage` 与 distiller 返回字段名一致 ✓
- Task 4 的 `outcome` 变量提取后 saveDistillRun 与 last_error 判断共用 ✓

## 执行顺序依赖

Task 1（db）-> Task 2（distiller，独立）-> Task 3（store，依赖 Task 1）-> Task 4（scheduler，依赖 Task 2+3）-> Task 5（server+web-api，依赖 Task 3）-> Task 6（Web UI，依赖 Task 5）。

Task 2 与 Task 1 无依赖可并行，但为 review 清晰按序。Task 3 完成后 typecheck 会因 Task 4 未改而暂时失败（saveDistillRun 调用缺 errorMessage）--Task 4 完成后 typecheck 全绿，这是预期的跨 task 状态。

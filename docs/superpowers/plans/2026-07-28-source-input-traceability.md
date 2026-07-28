# Source-Input Traceability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户在 Web UI 审批每条记忆时，能一键查看「蒸馏时喂给模型的过滤版 transcript」——产生这条记忆的原始输入。

**Architecture:** distiller 蒸馏时把内部已算的 `filteredTurns`（`filterTranscriptForDistill` 输出）随候选一起返回；`tick` 在有候选入库时 best-effort UPSERT 进新副表 `memory_distill_inputs`（按 `distill_job_id`，无 FK，与 events 清理债务解耦）。Web UI 卡片加「查看原始输入」按钮，点击懒加载 `GET /api/memories/:id/source-input`，弹出近全屏遮罩层按 role 分色展示。

**Tech Stack:** Bun + Hono + Drizzle + bun:sqlite + React 19 + bun:test

## Global Constraints

- **测试门槛**：`bun run typecheck && bun test` 必须全绿才能 push（CLAUDE.md 硬规则）。
- **TDD**：每个任务先写失败测试（红），再写实现（绿），再 commit。
- **best-effort 写入**：`saveSourceInput` 失败只 `console.warn`、不重试、不阻塞 `tick` 标 done（与 `logDiscards`/`setSessionOffset` 同级）。
- **无 FK**：`memory_distill_inputs.distill_job_id` 是逻辑键非 FK，解耦 `memory_distill_jobs` 未来清理。
- **不回填**：存量记忆无快照，端点返回 `available:false`，不撒谎。
- **按钮显示条件**：仅 `m.distillJobId` 非空时显示「查看原始输入」（手动记忆 `distillJobId=null` 不显示）。
- **状态可见性**：遮罩层 loading / error / unavailable 三态都要有文案，绝不空白 stall（CLAUDE.md 硬规则）。
- **快照忠实**：存的是 `distillTranscript` 内部 `filtered` 变量本身，不经二次加工。
- **懒加载**：turns 走专用端点，不塞进 `GET /api/memories` 列表（避免 3s 轮询响应膨胀）。
- **Windows EBUSY**：DB 测试沿用既有「每测试独立子目录 + afterEach 关 raw handle」模式（见 `tests/scheduler.test.ts:19-36`）。

---

## File Structure

- **Create:** 无新源码文件；改动既有文件。
- **Modify:**
  - `src/db/schema.ts` — 新增 `memoryDistillInputs` 表定义。
  - `src/db/client.ts` — drizzle schema 注册 + `CREATE TABLE IF NOT EXISTS` DDL。
  - `src/memory/distiller.ts` — `distillTranscript` 返回 `DistillResult`（含 `filteredTurns`）。
  - `src/memory/store.ts` — 新增 `saveSourceInput` + `getSourceInput`。
  - `src/scheduler.ts` — `tick` 解构 `filteredTurns` + best-effort 写快照。
  - `src/server.ts` — 新增 `GET /api/memories/:id/source-input` 路由。
  - `src/web/api.ts` — 新增 `getSourceInput` client + `SourceInput`/`SourceTurn` 类型 + `MemoryItem.distillJobId`。
  - `src/web/ui-utils.ts` — 新增 `formatSourceTurn` 纯函数。
  - `src/web/App.tsx` — 卡片按钮 + `<SourceInputModal>` 组件 + App 状态接线。
- **Test (modify/extend):**
  - `tests/schema.test.ts` — 新表存在性。
  - `tests/distiller.test.ts` — `filteredTurns` 忠实 + 既有 14 处断言改 `.candidates`。
  - `tests/store-crud.test.ts` — `saveSourceInput` insert/UPSERT + `getSourceInput` 命中/反序列化失败。
  - `tests/scheduler.test.ts` — 有候选写快照 / 0 候选不写 / 写失败可吞。
  - `tests/server.test.ts` — 端点四态 + 列表不含 turns。
  - `tests/web-api.test.ts` — `getSourceInput` URL/方法。
  - `tests/ui-utils.test.ts` — `formatSourceTurn` 映射。
  - `tests/web-ui.test.ts` — App.tsx 源码文本断言兜底。

---

### Task 1: Schema + migration — `memory_distill_inputs` 表

**Files:**
- Modify: `src/db/schema.ts`（末尾追加表定义）
- Modify: `src/db/client.ts`（schema 注册 + DDL 块）
- Test: `tests/schema.test.ts`

**Interfaces:**
- Produces: `memoryDistillInputs` drizzle 表对象（后续任务 import 用），列：`distillJobId`(PK) / `turnsJson` / `turnCount` / `charCount` / `ts`。

- [ ] **Step 1: Write the failing test**

追加到 `tests/schema.test.ts` 末尾：

```ts
test('fresh db has memory_distill_inputs table with required columns', () => {
  db = openDb(join(dir, 'mdi.db'))
  const tables = db.$client.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_distill_inputs'").all() as { name: string }[]
  expect(tables.length).toBe(1)
  const cols = db.$client.prepare('PRAGMA table_info(memory_distill_inputs)').all() as { name: string }[]
  expect(cols.some((c) => c.name === 'distill_job_id')).toBe(true)
  expect(cols.some((c) => c.name === 'turns_json')).toBe(true)
  expect(cols.some((c) => c.name === 'turn_count')).toBe(true)
  expect(cols.some((c) => c.name === 'char_count')).toBe(true)
  expect(cols.some((c) => c.name === 'ts')).toBe(true)
})

test('memory_distill_inputs has no FK to memory_distill_jobs (decoupled cleanup)', () => {
  db = openDb(join(dir, 'mdifk.db'))
  const fks = db.$client.prepare('PRAGMA foreign_key_list(memory_distill_inputs)').all()
  expect(fks.length).toBe(0)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/schema.test.ts -t "memory_distill_inputs"`
Expected: FAIL — `no such table: memory_distill_inputs`。

- [ ] **Step 3: Add table definition to schema**

在 `src/db/schema.ts` 末尾（`memorySessionOffsets` 表定义之后）追加：

```ts
export const memoryDistillInputs = sqliteTable(
  'memory_distill_inputs',
  {
    distillJobId: text('distill_job_id').primaryKey(),
    turnsJson: text('turns_json').notNull(),
    turnCount: integer('turn_count').notNull(),
    charCount: integer('char_count').notNull(),
    ts: integer('ts').notNull(),
  },
)
```

- [ ] **Step 4: Register in drizzle schema + add DDL**

在 `src/db/client.ts`：

(a) 第 5 行 import 加 `memoryDistillInputs`：

```ts
import { memories, memoryDistillJobs, memoryDistillEvents, memoryDiscards, memorySessionOffsets, memoryDistillInputs } from './schema'
```

(b) 第 14 行 drizzle 构造的 schema 对象加 `memoryDistillInputs`：

```ts
  const db = drizzle(raw, { schema: { memories, memoryDistillJobs, memoryDistillEvents, memoryDiscards, memorySessionOffsets, memoryDistillInputs } })
```

(c) 在 `raw.exec(\`...\`)` DDL 块内（`memory_session_offsets` 表 DDL 之后、闭合反引号之前）追加：

```sql
    CREATE TABLE IF NOT EXISTS memory_distill_inputs (
      distill_job_id TEXT PRIMARY KEY,
      turns_json     TEXT NOT NULL,
      turn_count     INTEGER NOT NULL,
      char_count     INTEGER NOT NULL,
      ts             INTEGER NOT NULL
    );
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/schema.test.ts -t "memory_distill_inputs"`
Expected: PASS（2 个新测试绿）。

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.ts src/db/client.ts tests/schema.test.ts
git commit -m "feat(db): add memory_distill_inputs table for source-input snapshots"
```

---

### Task 2: `distillTranscript` returns `DistillResult` (含 `filteredTurns`)

**Files:**
- Modify: `src/memory/distiller.ts:76-176`
- Modify: `src/scheduler.ts:133`（唯一生产调用方）
- Test: `tests/distiller.test.ts`（新增 1 + 改 14 处断言）

**Interfaces:**
- Consumes: `filterTranscriptForDistill`（`src/memory/pure.ts`，已有，不改）。
- Produces: `distillTranscript` 返回 `Promise<DistillResult>`，其中 `DistillResult = { candidates: DistillCandidate[]; filteredTurns: TranscriptTurn[] }`。`filteredTurns` === 内部 `filterTranscriptForDistill(input.turns)` 输出。失败降级返回 `{ candidates: [], filteredTurns: [] }`。

- [ ] **Step 1: Write the failing test**

在 `tests/distiller.test.ts` 末尾追加：

```ts
test('distillTranscript returns filteredTurns equal to filterTranscriptForDistill output (snapshot fidelity)', async () => {
  // 快照忠实：返回的 filteredTurns 必须等于内部 filterTranscriptForDistill(turns)。
  // 存的就是当时喂给模型的，零偏差。
  const { filterTranscriptForDistill } = await import('@/memory/pure')
  const turns = [
    { role: 'user', content: 'read the file' },
    { role: 'tool', content: 'X'.repeat(5000), toolName: 'Read', toolInputPath: '/a.ts' },
    { role: 'assistant', content: 'ok' },
  ]
  const result = await distillTranscript({
    turns, runtime: 'claude-code', cwd: '/r',
    callLLM: async () => JSON.stringify({ candidates: [{ title: '[category:x] t', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] }),
  })
  expect(result.filteredTurns).toEqual(filterTranscriptForDistill(turns))
  // 过滤版里文件类 tool 结果被压成占位，不再含原文
  expect(result.filteredTurns[1]!.content).toContain('[file: /a.ts')
  expect(result.filteredTurns[1]!.content).not.toContain('X'.repeat(100))
})

test('distillTranscript failure degrades to empty filteredTurns', async () => {
  const result = await distillTranscript({
    turns: [{ role: 'user', content: 'hi' }],
    runtime: 'claude-code', cwd: '/r',
    callLLM: async () => { throw new Error('api down') },
  })
  expect(result.candidates).toEqual([])
  expect(result.filteredTurns).toEqual([])
})
```

- [ ] **Step 2: Run new test to verify it fails**

Run: `bun test tests/distiller.test.ts -t "filteredTurns"`
Expected: FAIL — `result.filteredTurns` is `undefined`（当前返回数组）。

- [ ] **Step 3: Change `distillTranscript` return type + body**

在 `src/memory/distiller.ts`：

(a) 在 `DistillInput` 接口之后（`renderUserPrompt` 函数之前）新增 `DistillResult`：

```ts
export interface DistillResult {
  candidates: DistillCandidate[]
  filteredTurns: TranscriptTurn[]   // 实际喂给模型的过滤版，零偏差快照源
}
```

(b) 把 `distillTranscript` 签名与函数体改为返回 `DistillResult`：

```ts
export async function distillTranscript(input: DistillInput): Promise<DistillResult> {
  try {
    const signals = detectErrorSignals(input.turns)
    const filtered = filterTranscriptForDistill(input.turns)
    const userPrompt = renderUserPrompt(filtered, input.runtime, input.cwd, signals)
    const parsed = await callWithRetry({
      call: input.callLLM,
      system: DISTILLER_SYSTEM_PROMPT,
      user: userPrompt,
      shouldRetry: distillShouldRetry,
    }) as { candidates?: unknown } | undefined
    if (!parsed || !Array.isArray(parsed.candidates)) return { candidates: [], filteredTurns: filtered }
    const out: DistillCandidate[] = []
    for (const c of parsed.candidates) {
      if (!c || typeof c !== 'object') continue
      const o = c as Record<string, unknown>
      if (typeof o.title !== 'string' || typeof o.bodyMd !== 'string') continue
      if (!o.title.includes('[category:')) continue
      const scope = o.scope === 'global' ? 'global' : 'project'
      const rt = o.runtime === 'claude-code' || o.runtime === 'opencode' ? o.runtime : null
      const action =
        o.distillAction === 'update_of' ||
        o.distillAction === 'duplicate_of' ||
        o.distillAction === 'conflict_with'
          ? o.distillAction
          : 'new'
      const rawSubject = o.subject
      const subject: 'codebase' | 'domain' =
        rawSubject === 'domain' ? 'domain' : 'codebase'
      out.push({
        title: o.title,
        bodyMd: o.bodyMd,
        scopeType: scope,
        runtime: rt as RuntimeTag,
        distillAction: action,
        subject,
      })
    }
    return { candidates: out, filteredTurns: filtered }
  } catch {
    // Never throw: distill failures degrade to "no candidates this round".
    return { candidates: [], filteredTurns: [] }
  }
}
```

注意：成功路径返回 `{ candidates: out, filteredTurns: filtered }`；`!parsed` 空候选路径返回 `{ candidates: [], filteredTurns: filtered }`（仍返回这次喂的过滤 turns，但 tick 只在有候选入库时才落快照）；catch 降级返回 `{ candidates: [], filteredTurns: [] }`。

- [ ] **Step 4: Update production caller in scheduler.ts**

`src/scheduler.ts:133` 把：

```ts
      const candidates: DistillCandidate[] = await distillTranscript({
        turns: newTurns,  // 只喂新增 turn，不再全量
        runtime: job.runtime as 'claude-code' | 'opencode',
        cwd: job.cwd ?? '',
        callLLM: deps.callLLM,
      })
```

改为：

```ts
      const { candidates, filteredTurns } = await distillTranscript({
        turns: newTurns,  // 只喂新增 turn，不再全量
        runtime: job.runtime as 'claude-code' | 'opencode',
        cwd: job.cwd ?? '',
        callLLM: deps.callLLM,
      })
```

（`DistillCandidate` import 仍被 `dedupCandidates` 签名用，保留。）

- [ ] **Step 5: Update 14 existing assertions in distiller.test.ts**

把所有 `result.length` / `result[0]` / `result)` 断言改为经 `.candidates`。逐处替换：

- 行 26 `expect(result.length).toBe(1)` → `expect(result.candidates.length).toBe(1)`
- 行 27 `expect(result[0]!.title)` → `expect(result.candidates[0]!.title)`
- 行 37 `expect(result).toEqual([])` → `expect(result.candidates).toEqual([])`
- 行 46 `expect(result).toEqual([])` → `expect(result.candidates).toEqual([])`
- 行 56 `expect(result.length).toBe(1)` → `expect(result.candidates.length).toBe(1)`
- 行 57 `expect(result[0]!.title)` → `expect(result.candidates[0]!.title)`
- 行 72 `expect(result.length).toBe(1)` → `expect(result.candidates.length).toBe(1)`
- 行 73 `expect(result[0]!.title)` → `expect(result.candidates[0]!.title)`
- 行 82 `expect(result).toEqual([])` → `expect(result.candidates).toEqual([])`
- 行 130 `expect(result.length).toBe(1)` → `expect(result.candidates.length).toBe(1)`
- 行 131 `expect(result[0]!.subject)` → `expect(result.candidates[0]!.subject)`
- 行 140 `expect(result.length).toBe(1)` → `expect(result.candidates.length).toBe(1)`
- 行 141 `expect(result[0]!.subject)` → `expect(result.candidates[0]!.subject)`
- 行 156 `expect(result[0]!.subject)` → `expect(result.candidates[0]!.subject)`

（行 93、107 的 filter 测试不捕获 result，不改。）

- [ ] **Step 6: Run all distiller + scheduler tests to verify pass**

Run: `bun test tests/distiller.test.ts tests/scheduler.test.ts`
Expected: PASS（新增 2 + 既有全绿；scheduler 的 tick 测试因 `candidates` 变量名未变仍绿）。

- [ ] **Step 7: Commit**

```bash
git add src/memory/distiller.ts src/scheduler.ts tests/distiller.test.ts
git commit -m "feat(distiller): return filteredTurns snapshot alongside candidates"
```

---

### Task 3: store — `saveSourceInput` + `getSourceInput`

**Files:**
- Modify: `src/memory/store.ts`
- Test: `tests/store-crud.test.ts`

**Interfaces:**
- Consumes: `memoryDistillInputs` 表（Task 1）；`TranscriptTurn` 类型（`./pure`）。
- Produces:
  - `saveSourceInput(db, distillJobId, turns: TranscriptTurn[]): Promise<void>` — UPSERT（`onConflictDoUpdate` on `distillJobId`）。
  - `getSourceInput(db, distillJobId): Promise<{ turns: TranscriptTurn[]; turnCount: number; charCount: number } | null>` — 反序列化失败返回 null。

- [ ] **Step 1: Write the failing tests**

在 `tests/store-crud.test.ts` 顶部 import 行（行 7）追加 `saveSourceInput, getSourceInput`：

```ts
import { createCandidate, listApprovedByScope, getMemoryById, listForDedupByScope, DEDUP_EXISTING_LIMIT, logDiscards, getSessionOffset, setSessionOffset, saveSourceInput, getSourceInput } from '@/memory/store'
```

并在文件末尾追加测试：

```ts
import { memoryDistillInputs } from '@/db/schema'

test('saveSourceInput inserts a row, getSourceInput reads it back', async () => {
  const turns = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi there' },
  ]
  await saveSourceInput(db, 'job-1', turns)
  const snap = await getSourceInput(db, 'job-1')
  expect(snap).not.toBeNull()
  expect(snap!.turnCount).toBe(2)
  expect(snap!.charCount).toBe('hello'.length + 'hi there'.length)
  expect(snap!.turns.length).toBe(2)
  expect(snap!.turns[0]!.content).toBe('hello')
})

test('saveSourceInput UPSERT overwrites on same distillJobId (no duplicate rows)', async () => {
  await saveSourceInput(db, 'job-2', [{ role: 'user', content: 'first' }])
  await saveSourceInput(db, 'job-2', [{ role: 'user', content: 'second' }, { role: 'user', content: 'third' }])
  const rows = await db.select().from(memoryDistillInputs).where(eq(memoryDistillInputs.distillJobId, 'job-2'))
  expect(rows.length).toBe(1)  // UPSERT 覆盖，不产生两行
  const snap = await getSourceInput(db, 'job-2')
  expect(snap!.turnCount).toBe(2)  // 第二次的值
  expect(snap!.turns[0]!.content).toBe('second')
})

test('getSourceInput returns null for missing job', async () => {
  const snap = await getSourceInput(db, 'no-such-job')
  expect(snap).toBeNull()
})

test('getSourceInput returns null on malformed turns_json (deser failure, no crash)', async () => {
  // 直接写一行坏 JSON，模拟历史/损坏数据
  db.insert(memoryDistillInputs).values({
    distillJobId: 'job-bad', turnsJson: 'not-valid-json{', turnCount: 0, charCount: 0, ts: 1,
  }).run()
  const snap = await getSourceInput(db, 'job-bad')
  expect(snap).toBeNull()
})
```

（`eq` 已在文件顶部 import。）

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/store-crud.test.ts -t "saveSourceInput|getSourceInput"`
Expected: FAIL — `saveSourceInput is not a function`（未导出）。

- [ ] **Step 3: Implement `saveSourceInput` + `getSourceInput`**

在 `src/memory/store.ts`：

(a) 第 4 行 import 加 `memoryDistillInputs`：

```ts
import { memories, memoryDiscards, memorySessionOffsets, memoryDistillInputs } from '@/db/schema'
```

(b) 在 `src/memory/store.ts` 顶部既有的 `./pure` import 块里加 `type TranscriptTurn`（当前未导入）。把：

```ts
import {
  canTransition,
  type InjectableMemorySet,
  type MemoryScope,
  type MemoryStatus,
  type RuntimeTag,
} from './pure'
```
改为：

```ts
import {
  canTransition,
  type InjectableMemorySet,
  type MemoryScope,
  type MemoryStatus,
  type RuntimeTag,
  type TranscriptTurn,
} from './pure'
```

(c) 在 `setSessionOffset` 函数之后（文件末尾）追加：

```ts
// ---------------------------------------------------------------------------
// 原始输入溯源：蒸馏时把喂给模型的过滤版 turns 快照存 memory_distill_inputs
// （按 distill_job_id，无 FK，与 events 清理债务解耦）。saveSourceInput 是
// best-effort 写（调用方 tick 吞错）；getSourceInput 反序列化失败返回 null。
// ---------------------------------------------------------------------------

export async function saveSourceInput(
  db: DbClient, distillJobId: string, turns: TranscriptTurn[],
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

export async function getSourceInput(
  db: DbClient, distillJobId: string,
): Promise<{ turns: TranscriptTurn[]; turnCount: number; charCount: number } | null> {
  const rows = await db.select().from(memoryDistillInputs)
    .where(eq(memoryDistillInputs.distillJobId, distillJobId)).limit(1)
  if (rows.length === 0) return null
  const r = rows[0]!
  try {
    const parsed = JSON.parse(r.turnsJson)
    if (!Array.isArray(parsed)) return null
    return { turns: parsed as TranscriptTurn[], turnCount: r.turnCount, charCount: r.charCount }
  } catch {
    return null
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/store-crud.test.ts -t "saveSourceInput|getSourceInput"`
Expected: PASS（4 个新测试绿）。

- [ ] **Step 5: Commit**

```bash
git add src/memory/store.ts tests/store-crud.test.ts
git commit -m "feat(store): saveSourceInput + getSourceInput for distill snapshots"
```

---

### Task 4: scheduler — `tick` best-effort 写快照

**Files:**
- Modify: `src/scheduler.ts`（import + tick 写入分支）
- Test: `tests/scheduler.test.ts`

**Interfaces:**
- Consumes: `distillTranscript` 返回的 `filteredTurns`（Task 2）；`saveSourceInput`（Task 3）。
- Produces: `tick` 在 `keepWithClass.length > 0` 时 UPSERT 快照，失败 warn 不阻塞。

- [ ] **Step 1: Write the failing tests**

在 `tests/scheduler.test.ts` import 区（行 8）把：

```ts
import { memoryDistillJobs, memoryDistillEvents, memories, memoryDiscards, memorySessionOffsets } from '@/db/schema'
```
改为：
```ts
import { memoryDistillJobs, memoryDistillEvents, memories, memoryDiscards, memorySessionOffsets, memoryDistillInputs } from '@/db/schema'
```

（`memoryDistillInputs` 用于断言快照行；`saveSourceInput` 由 `tick` 内部调用，测试不直接用，无需 import。）

在文件末尾追加三个测试：

```ts
// ---------------------------------------------------------------------------
// 原始输入溯源：tick 在有候选入库时 best-effort 写 memory_distill_inputs 快照。
// 0 候选入库不写；写失败只 warn、job 仍 done。
// ---------------------------------------------------------------------------

test('tick writes source-input snapshot when candidates are kept', async () => {
  const { jobId } = await enqueueDistillJob(db, { sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0 })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  await tick(db, {
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'we refund within 14 days' }], fullLength: 1 }),
    callLLM: async () => JSON.stringify({ candidates: [{ title: '[category:invariant] refund 14d', bodyMd: '14d', scope: 'project', runtime: null, distillAction: 'new' }] }),
    createCandidate: async () => ({ id: 'c1', status: 'candidate', version: 1 } as any),
  })
  const snaps = await db.select().from(memoryDistillInputs).where(eq(memoryDistillInputs.distillJobId, jobId))
  expect(snaps.length).toBe(1)
  expect(snaps[0]!.turnCount).toBe(1)
  expect(snaps[0]!.turnsJson).toContain('we refund within 14 days')
})

test('tick does NOT write source-input snapshot when 0 candidates kept (all discarded)', async () => {
  // 与既有 public-knowledge 丢弃测试（行 248）同 mock 模式：1 候选 + 无 existing ->
  // dedup 短路（不调 LLM），judgeValue 判 public-knowledge -> 丢弃，0 候选入库。
  const { jobId } = await enqueueDistillJob(db, { sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0 })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  let callCount = 0
  await tick(db, {
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'x' }], fullLength: 1 }),
    callLLM: async () => {
      callCount++
      if (callCount === 1) return JSON.stringify({ candidates: [{ title: '[category:x] js array map', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] })
      if (callCount === 2) return JSON.stringify({ verdicts: [{ index: 0, category: 'public-knowledge' }] })
      return JSON.stringify({ verdicts: [{ index: 0, isDuplicate: false }] })
    },
    createCandidate: async () => ({ id: 'c1', status: 'candidate', version: 1 } as any),
  })
  const snaps = await db.select().from(memoryDistillInputs).where(eq(memoryDistillInputs.distillJobId, jobId))
  expect(snaps.length).toBe(0)  // 0 候选入库，不写快照
  const rows = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, jobId))
  expect(rows[0]!.status).toBe('done')
})

test('tick still marks done when saveSourceInput throws (warn, non-blocking)', async () => {
  const { jobId } = await enqueueDistillJob(db, { sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0 })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  // 包一层 db.insert：仅对 memory_distill_inputs 表的 insert 抛错，其余透传。
  // 与既有 setSessionOffset-throws 测试（行 506-530）同模式：monkey-patch + flag + finally 还原。
  const realInsert = db.insert.bind(db)
  let inputsThrows = false
  db.insert = ((table: unknown) => {
    const builder = realInsert(table as any)
    if (inputsThrows && table === memoryDistillInputs) {
      throw new Error('mocked distill_inputs insert failure')
    }
    return builder
  }) as any
  try {
    inputsThrows = true
    await tick(db, {
      loadTranscript: async () => ({ turns: [{ role: 'user', content: 'x' }], fullLength: 1 }),
      callLLM: async () => JSON.stringify({ candidates: [{ title: '[category:x] t', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] }),
      createCandidate: async () => ({ id: 'c1', status: 'candidate', version: 1 } as any),
    })
    const rows = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, jobId))
    expect(rows[0]!.status).toBe('done')  // 写失败可吞，job 仍 done
  } finally {
    inputsThrows = false
    db.insert = realInsert
  }
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/scheduler.test.ts -t "source-input snapshot|saveSourceInput throws"`
Expected: FAIL — `tick writes` 测试断言 `snaps.length === 1` 但当前 tick 不写快照（0 行）。

- [ ] **Step 3: Add best-effort write branch to tick**

在 `src/scheduler.ts`：

(a) 第 6 行 import 加 `saveSourceInput`：

```ts
import { listForDedupByScope, logDiscards, setSessionOffset, saveSourceInput, type DiscardRecord } from '@/memory/store'
```

(b) 在 tick 的 createCandidate 循环之后、`status='done'` 更新之前（当前代码 `for (const k of keepWithClass) { ... }` 结束后、`await db.update(memoryDistillJobs).set({ status: 'done' ...})` 之前），插入：

```ts
      // 原始输入溯源：有候选入库时 best-effort 快照喂给模型的过滤版 turns。
      // 失败只 warn、不阻塞 done（与 logDiscards / setSessionOffset 同级）。
      if (keepWithClass.length > 0) {
        try { await saveSourceInput(db, job.id, filteredTurns) }
        catch (e) { console.warn('memside: saveSourceInput failed', e) }
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/scheduler.test.ts`
Expected: PASS（3 个新测试 + 既有全绿）。

- [ ] **Step 5: Commit**

```bash
git add src/scheduler.ts tests/scheduler.test.ts
git commit -m "feat(scheduler): best-effort source-input snapshot on candidate creation"
```

---

### Task 5: server — `GET /api/memories/:id/source-input`

**Files:**
- Modify: `src/server.ts`
- Test: `tests/server.test.ts`

**Interfaces:**
- Consumes: `getMemoryById`（已有）、`getSourceInput`（Task 3）。
- Produces: `GET /api/memories/:id/source-input` 返回 `{ available: boolean, ... }`。记忆不存在 404；`distillJobId` 为 null 或无快照行 -> `{ available: false }`；有快照 -> `{ available: true, title, bodyMd, valueClass, sourceCwd, createdAt, turnCount, charCount, turns }`。

- [ ] **Step 1: Write the failing tests**

在 `tests/server.test.ts` 顶部 import 行（行 5）追加 `getSourceInput`（用于预置快照行）：

```ts
import { createCandidate, promoteCandidate, getSourceInput } from '@/memory/store'
```

并在文件末尾追加测试：

```ts
test('GET /api/memories/:id/source-input returns available:true with turns when snapshot exists', async () => {
  const c = await createCandidate(db, { scopeType: 'project', scopeId: '/r', title: '[category:x] t', bodyMd: 'b', tags: [], sourceKind: 'conversation', runtime: null, sourceCwd: '/r', distillJobId: 'job-snap' })
  await getSourceInput(db, 'job-snap', [{ role: 'user', content: 'the original input' }])
  const r = await req(`/api/memories/${c.id}/source-input`)
  expect(r.status).toBe(200)
  expect(r.body.available).toBe(true)
  expect(r.body.title).toContain('[category:x]')
  expect(r.body.turnCount).toBe(1)
  expect(r.body.turns[0]!.content).toBe('the original input')
})

test('GET /api/memories/:id/source-input returns available:false when memory has no distillJobId (manual)', async () => {
  const c = await createCandidate(db, { scopeType: 'global', scopeId: null, title: 'manual', bodyMd: 'b', tags: [], sourceKind: 'manual', runtime: null })
  const r = await req(`/api/memories/${c.id}/source-input`)
  expect(r.status).toBe(200)
  expect(r.body.available).toBe(false)
})

test('GET /api/memories/:id/source-input returns available:false when snapshot row missing', async () => {
  const c = await createCandidate(db, { scopeType: 'project', scopeId: '/r', title: 't', bodyMd: 'b', tags: [], sourceKind: 'conversation', runtime: null, sourceCwd: '/r', distillJobId: 'job-nosnap' })
  // 不写快照行
  const r = await req(`/api/memories/${c.id}/source-input`)
  expect(r.status).toBe(200)
  expect(r.body.available).toBe(false)
})

test('GET /api/memories/:id/source-input returns 404 when memory missing', async () => {
  const r = await req('/api/memories/nope/source-input')
  expect(r.status).toBe(404)
})

test('GET /api/memories list response does NOT contain turns (lazy load only)', async () => {
  const c = await createCandidate(db, { scopeType: 'project', scopeId: '/r', title: 't', bodyMd: 'b', tags: [], sourceKind: 'conversation', runtime: null, sourceCwd: '/r', distillJobId: 'job-list' })
  await getSourceInput(db, 'job-list', [{ role: 'user', content: 'SHOULD_NOT_APPEAR_IN_LIST' }])
  const r = await req('/api/memories')
  const body = JSON.stringify(r.body)
  expect(body).not.toContain('SHOULD_NOT_APPEAR_IN_LIST')
  expect(body).not.toContain('turns_json')
  expect(body).not.toContain('"turns"')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/server.test.ts -t "source-input"`
Expected: FAIL — 404（路由不存在，Hono 默认）。

- [ ] **Step 3: Add the route**

在 `src/server.ts` 顶部 import 行（行 6）加 `getSourceInput`：

```ts
import { promoteCandidate, patchMemory, createCandidate, getMemoryById, getSourceInput } from '@/memory/store'
```

在 `app.get('/api/memories/:id', ...)` 路由之后追加：

```ts
  // 原始输入溯源：懒加载产生这条记忆的「蒸馏时喂模型的过滤版 transcript」。
  // 不塞进列表接口（避免 3s 轮询响应膨胀）。无 distillJobId（手动/历史）或无快照行
  // -> available:false（不回填、不撒谎）；有快照 -> 返回 turns + memory 摘要。
  app.get('/api/memories/:id/source-input', async (c) => {
    const got = await getMemoryById(deps.db, c.req.param('id'))
    if (!got) return c.json({ error: 'not found' }, 404)
    const m = got.memory
    if (!m.distillJobId) return c.json({ available: false })
    const snap = await getSourceInput(deps.db, m.distillJobId)
    if (!snap) return c.json({ available: false })
    return c.json({
      available: true,
      title: m.title,
      bodyMd: m.bodyMd,
      valueClass: m.valueClass,
      sourceCwd: m.sourceCwd,
      createdAt: m.createdAt,
      turnCount: snap.turnCount,
      charCount: snap.charCount,
      turns: snap.turns,
    })
  })
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/server.test.ts`
Expected: PASS（5 个新测试 + 既有全绿）。

- [ ] **Step 5: Commit**

```bash
git add src/server.ts tests/server.test.ts
git commit -m "feat(server): GET /api/memories/:id/source-input lazy-load endpoint"
```

---

### Task 6: web api client — `getSourceInput` + `MemoryItem.distillJobId`

**Files:**
- Modify: `src/web/api.ts`
- Test: `tests/web-api.test.ts`

**Interfaces:**
- Consumes: `GET /api/memories/:id/source-input`（Task 5）。
- Produces: `getSourceInput(id, fetchFn)` client；`SourceInput` / `SourceTurn` 类型；`MemoryItem.distillJobId?: string | null`。

- [ ] **Step 1: Write the failing test**

在 `tests/web-api.test.ts` 顶部 import 行（行 2）追加 `getSourceInput`：

```ts
import { listMemories, promoteMemory, patchMemory, getSourceInput } from '@/web/api'
```

并在文件末尾追加：

```ts
test('getSourceInput calls GET /api/memories/:id/source-input', async () => {
  let captured: { url: string; method: string } | null = null
  const fetchFn = (async (url: string, init: any) => {
    captured = { url, method: init?.method ?? 'GET' }
    return new Response(JSON.stringify({ available: true, title: 't', turns: [{ role: 'user', content: 'x' }], turnCount: 1, charCount: 1 }), { status: 200 })
  }) as any
  const data = await getSourceInput('42', fetchFn)
  expect(captured!.url).toBe('/api/memories/42/source-input')
  expect(captured!.method).toBe('GET')
  expect(data.available).toBe(true)
  expect(data.turns!.length).toBe(1)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/web-api.test.ts -t "getSourceInput"`
Expected: FAIL — `getSourceInput is not exported`。

- [ ] **Step 3: Add types + client function**

在 `src/web/api.ts`：

(a) 在 `MemoryItem` 接口（行 15-27）末尾加 `distillJobId` 字段：

```ts
export interface MemoryItem {
  id: string
  title: string
  bodyMd?: string
  status: string
  scopeType?: string
  runtime?: string | null
  sourceCwd?: string | null
  sourceKind?: string
  distillJobId?: string | null
  createdAt?: number
  version?: number
  valueClass?: string | null
}
```

(b) 在文件末尾（`bulkPromote` 之后）追加类型 + 函数：

```ts
export interface SourceTurn {
  role: string
  content: string
  isError?: boolean
  toolName?: string
  toolInputPath?: string
}

export interface SourceInput {
  available: boolean
  title?: string
  bodyMd?: string
  valueClass?: string | null
  sourceCwd?: string | null
  createdAt?: number
  turnCount?: number
  charCount?: number
  turns?: SourceTurn[]
}

/**
 * GET /api/memories/:id/source-input - 懒加载产生这条记忆的「蒸馏时喂模型的过滤版
 * transcript」。遮罩层点击时拉取；不进列表轮询。available:false 表示无快照
 * （手动记忆 / 历史记忆 / 写失败）。
 */
export async function getSourceInput(id: string, fetchFn: FetchLike = fetch): Promise<SourceInput> {
  const res = await fetchFn(`/api/memories/${id}/source-input`)
  return (await res.json()) as SourceInput
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/web-api.test.ts`
Expected: PASS（1 个新测试 + 既有全绿）。

- [ ] **Step 5: Commit**

```bash
git add src/web/api.ts tests/web-api.test.ts
git commit -m "feat(web): getSourceInput client + MemoryItem.distillJobId"
```

---

### Task 7: App.tsx — `<SourceInputModal>` + 卡片按钮 + `formatSourceTurn`

**Files:**
- Modify: `src/web/ui-utils.ts`（新增 `formatSourceTurn` 纯函数）
- Modify: `src/web/App.tsx`（卡片按钮 + 遮罩层组件 + App 状态接线）
- Test: `tests/ui-utils.test.ts`（纯函数）、`tests/web-ui.test.ts`（源码文本兜底）

**Interfaces:**
- Consumes: `getSourceInput` + `SourceInput`/`SourceTurn`（Task 6）。
- Produces: `formatSourceTurn(turn)` -> `{ label, color }`；`<SourceInputModal>` 组件；卡片「查看原始输入」按钮（仅 `distillJobId` 非空显示）。

- [ ] **Step 1: Write the failing test for `formatSourceTurn`**

在 `tests/ui-utils.test.ts` 顶部 import 行（行 2）追加 `formatSourceTurn`：

```ts
import { formatMemoryTime, sortCandidatesByTime, formatSourceTurn } from '@/web/ui-utils'
```

并在文件末尾追加：

```ts
// --- formatSourceTurn ---
// 原始输入遮罩层按 role 分色渲染的纯映射。CLAUDE.md「首选可断言面」：抽纯函数层测，
// React 组件不单测，靠 tests/web-ui.test.ts 源码文本兜底。

test('formatSourceTurn: user -> 蓝色标签', () => {
  const r = formatSourceTurn({ role: 'user', content: 'x' })
  expect(r.label).toBe('user')
  expect(r.color).toBe('#1565c0')
})

test('formatSourceTurn: assistant -> 深色标签', () => {
  const r = formatSourceTurn({ role: 'assistant', content: 'x' })
  expect(r.label).toBe('assistant')
  expect(r.color).toBe('#222')
})

test('formatSourceTurn: tool (non-error) -> 灰色标签', () => {
  const r = formatSourceTurn({ role: 'tool', content: 'x' })
  expect(r.label).toBe('tool')
  expect(r.color).toBe('#666')
})

test('formatSourceTurn: tool error -> 红色标签', () => {
  const r = formatSourceTurn({ role: 'tool', content: 'boom', isError: true })
  expect(r.label).toBe('tool')
  expect(r.color).toBe('#c00')
})

test('formatSourceTurn: unknown role -> 灰色 + 原角色名', () => {
  const r = formatSourceTurn({ role: 'system', content: 'x' })
  expect(r.label).toBe('system')
  expect(r.color).toBe('#666')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/ui-utils.test.ts -t "formatSourceTurn"`
Expected: FAIL — `formatSourceTurn is not exported`。

- [ ] **Step 3: Implement `formatSourceTurn`**

在 `src/web/ui-utils.ts` 末尾追加：

```ts
/**
 * 原始输入遮罩层：把一个 transcript turn 映射成 { label, color }，供按 role 分色渲染。
 * user 蓝、assistant 深、tool 灰（error 红）、其余灰 + 原角色名。纯函数，可单测。
 *
 * 设计依据：docs/superpowers/specs/2026-07-28-source-input-traceability-design.md §7。
 */
export function formatSourceTurn(turn: { role: string; isError?: boolean }): { label: string; color: string } {
  if (turn.role === 'user') return { label: 'user', color: '#1565c0' }
  if (turn.role === 'assistant') return { label: 'assistant', color: '#222' }
  if (turn.role === 'tool') return { label: 'tool', color: turn.isError ? '#c00' : '#666' }
  return { label: turn.role, color: '#666' }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/ui-utils.test.ts`
Expected: PASS（5 个新测试 + 既有全绿）。

- [ ] **Step 5: Write the failing source-text assertion test**

在 `tests/web-ui.test.ts` 末尾追加：

```ts
// 原始输入溯源（2026-07-28）：卡片「查看原始输入」按钮 + 遮罩层组件。
// React 组件不单测，源码文本断言锁住 UI 锚点，refactor 删除即变红。
test('App.tsx has source-input view button + modal (source text)', () => {
  expect(src).toContain('查看原始输入')
  expect(src).toContain('SourceInputModal')
})

test('App.tsx source-input modal shows unavailable / loading / error states', () => {
  // 状态可见性（CLAUDE.md 硬规则）：不得静默 stall
  expect(src).toContain('无原始输入快照')
  expect(src).toContain('加载中')
})
```

- [ ] **Step 6: Run test to verify it fails**

Run: `bun test tests/web-ui.test.ts -t "source-input"`
Expected: FAIL — App.tsx 不含 `查看原始输入`。

- [ ] **Step 7: Add modal + button to App.tsx**

在 `src/web/App.tsx`：

(a) 第 2 行 import 追加 `getSourceInput` + `SourceInput` + `SourceTurn`：

```ts
import { listMemories, promoteMemory, patchMemory, getStatus, bulkPromote, getSourceInput, type MemoryItem, type MemsideStatus, type SourceInput, type SourceTurn } from './api'
import { formatMemoryTime, sortCandidatesByTime, formatSourceTurn } from './ui-utils'
```

(b) 在 `App` 组件内 `const [error, setError] = useState<string | null>(null)` 之后加遮罩层状态：

```ts
  const [sourceInputFor, setSourceInputFor] = useState<string | null>(null)
```

(c) 在 `candidates.map` 渲染处，给 `MemoryCard` 传 `onViewSource`：

```tsx
      {candidates.map((m) => (
        <MemoryCard
          key={m.id}
          m={m}
          onApprove={() => approve(m.id)}
          onReject={() => reject(m.id)}
          onEdit={(t, b, s) => edit(m.id, t, b, s)}
          onViewSource={() => setSourceInputFor(m.id)}
        />
      ))}
```

(d) 在 `candidates.map` 的闭合 `)}` 之后、最外层 `</div>` 之前，渲染遮罩层：

```tsx
      {sourceInputFor ? (
        <SourceInputModal memoryId={sourceInputFor} onClose={() => setSourceInputFor(null)} />
      ) : null}
```

(e) 修改 `MemoryCard` 组件签名，加 `onViewSource` prop 与按钮。把组件声明改为：

```tsx
function MemoryCard({
  m,
  onApprove,
  onReject,
  onEdit,
  onViewSource,
}: {
  m: MemoryItem
  onApprove: () => void
  onReject: () => void
  onEdit: (title: string, bodyMd: string, scopeType: 'project' | 'global') => Promise<void>
  onViewSource: () => void
}) {
```

在非编辑态的按钮区（`<button onClick={() => { setEditError(null); setEditing(true) }}>编辑</button>` 之后）加：

```tsx
            {m.distillJobId ? (
              <button onClick={onViewSource} style={{ marginLeft: 8 }}>
                查看原始输入
              </button>
            ) : null}
```

(f) 在文件末尾（`MemoryCard` 组件之后）新增 `SourceInputModal` 组件：

```tsx
function SourceInputModal({ memoryId, onClose }: { memoryId: string; onClose: () => void }) {
  const [data, setData] = useState<SourceInput | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setData(null)
    getSourceInput(memoryId)
      .then((d) => { if (!cancelled) setData(d) })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [memoryId])

  // ESC 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
        background: 'rgba(0,0,0,0.5)', display: 'flex',
        alignItems: 'flex-start', justifyContent: 'center', padding: 40,
        overflow: 'auto', zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff', borderRadius: 8, maxWidth: 900, width: '100%',
          maxHeight: '85vh', overflow: 'auto', padding: 20,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <strong>{data?.title ?? '原始输入'}</strong>
          <button onClick={onClose} style={{ fontSize: 18, lineHeight: 1 }}>×</button>
        </div>

        {loading ? (
          <p style={{ color: '#666' }}>加载中…</p>
        ) : error ? (
          <p style={{ color: '#c00' }}>无法加载原始输入: {error}</p>
        ) : data && data.available ? (
          <>
            <p style={{ fontSize: 12, color: '#888', marginBottom: 12 }}>
              蒸馏时喂给模型的过滤版（文件类工具已压缩、超长已截断）· {data.turnCount ?? 0} turn · 约 {data.charCount ?? 0} 字
            </p>
            {data.bodyMd ? <p style={{ color: '#555', marginBottom: 12 }}>{data.bodyMd}</p> : null}
            <div>
              {(data.turns ?? []).map((t: SourceTurn, i: number) => {
                const { label, color } = formatSourceTurn(t)
                return (
                  <div key={i} style={{ marginBottom: 8, border: '1px solid #eee', borderRadius: 4, padding: 8 }}>
                    <span style={{ color, fontWeight: 600, fontSize: 12 }}>[{label}]</span>
                    <pre style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 13 }}>{t.content}</pre>
                  </div>
                )
              })}
            </div>
          </>
        ) : (
          <p style={{ color: '#666' }}>该记忆无原始输入快照</p>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 8: Run web-ui test to verify it passes**

Run: `bun test tests/web-ui.test.ts`
Expected: PASS（2 个新测试 + 既有全绿）。

- [ ] **Step 9: Commit**

```bash
git add src/web/ui-utils.ts src/web/App.tsx tests/ui-utils.test.ts tests/web-ui.test.ts
git commit -m "feat(web): source-input modal + view button + formatSourceTurn"
```

---

## Final Verification

- [ ] **Step 1: Run full test suite + typecheck**

Run: `bun run typecheck && bun test`
Expected: 全绿（既有 304 + 新增约 20 测试）。

- [ ] **Step 2: Manual smoke (optional, 无法自动化)**

```bash
bun run src/cli.ts start   # daemon
bun run dev:web            # 另开终端
# 结束一个 claude code 会话 -> 候选出现 -> 点「查看原始输入」-> 遮罩层展示过滤版 turns
```

- [ ] **Step 3: Push + open PR**

```bash
git push -u origin feat/source-input-traceability
gh pr create --base master --title "feat: source-input traceability" --body "..."
```

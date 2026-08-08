# 蒸馏上下文补全与攒量批处理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 会话级累加 distill job（攒够才提炼）+ distiller 输入补全（前文 digest + 已审批标题）+ 降级全可见。

**Architecture:** 方案 C——一个 (runtime, sessionId) 最多一个 waiting job，capture 时 upsert 全量快照并本地算阈值放行；SessionEnd/TTL 两路 flush 兜底；质量模式滚动 LLM 摘要 / 经济模式确定性 digest；所有降级落 `memory_degradations` 表并经 /api/status + Web UI 呈现。

**Tech Stack:** Bun + Hono + Drizzle + bun:sqlite + zod；前端 React 19。设计 spec：`docs/superpowers/specs/2026-08-09-distill-context-and-batching-design.md`。

## Global Constraints

- 分支：`feat/distill-context-batching`（已切，基线 origin/master）。**禁止直接在 master 提交。**
- 运行门槛：`bun run typecheck && bun test` 全绿才能 push；每个 task 结束跑 `bun test <相关测试文件>` + `bun run typecheck`。
- 阈值常量（spec §3.3）：`DISTILL_RELEASE_MIN_CHARS=8000`、`DISTILL_RELEASE_MAX_TURNS=50`、`DISTILL_TRIVIAL_FLOOR_CHARS=1000`、`SESSION_FLUSH_TTL_MS=2*60*60*1000`。
- 四条不变量（spec §3.1）：A 累加唯一 / B waiting 单向流转 / C 原料不丢 / D 一 job 一行 event。
- 所有降级必须 `logDegradation` 落表（spec §5），唯一允许 console-only 的是 logDegradation 自身失败。
- LLM 判定类 prompt 必须中立，禁止 keep/discard 倾向性措辞（项目记忆）。
- 向后兼容锁：`priorContext` 与 `approvedTitles` 均空时 distiller prompt 与现状逐字节一致。
- 测试风格对齐既有：bun:test `describe/test/expect`；store/scheduler/server 测试用 tmp DB（`:memory:` 或 tmp 文件），LLM 一律 mock。

---

### Task 1: threshold.ts 纯函数

**Files:**
- Create: `src/memory/threshold.ts`
- Test: `tests/threshold.test.ts`

**Interfaces:**
- Consumes: `filterTranscriptForDistill`、`TranscriptTurn`（`src/memory/pure.ts:261`、`:109`）
- Produces（Task 7/8 依赖）:
  - `DISTILL_RELEASE_MIN_CHARS = 8000`、`DISTILL_RELEASE_MAX_TURNS = 50`、`DISTILL_TRIVIAL_FLOOR_CHARS = 1000`、`SESSION_FLUSH_TTL_MS = 7200000`
  - `interface SliceSignal { chars: number; turnCount: number }`
  - `computeSliceSignal(turns: readonly TranscriptTurn[], offset: number): SliceSignal`
  - `shouldRelease(signal: SliceSignal): boolean`
  - `isTrivial(signal: SliceSignal): boolean`
  - `isStale(lastCaptureAt: number, now: number): boolean`

- [ ] **Step 1: 写失败测试**

```ts
// tests/threshold.test.ts
import { describe, test, expect } from 'bun:test'
import {
  DISTILL_RELEASE_MIN_CHARS, DISTILL_RELEASE_MAX_TURNS, DISTILL_TRIVIAL_FLOOR_CHARS, SESSION_FLUSH_TTL_MS,
  computeSliceSignal, shouldRelease, isTrivial, isStale,
} from '@/memory/threshold'
import type { TranscriptTurn } from '@/memory/pure'

const t = (role: TranscriptTurn['role'], content: string): TranscriptTurn => ({ role, content })

describe('threshold 常量（spec §3.3）', () => {
  test('常量值锁定', () => {
    expect(DISTILL_RELEASE_MIN_CHARS).toBe(8000)
    expect(DISTILL_RELEASE_MAX_TURNS).toBe(50)
    expect(DISTILL_TRIVIAL_FLOOR_CHARS).toBe(1000)
    expect(SESSION_FLUSH_TTL_MS).toBe(7_200_000)
  })
})

describe('computeSliceSignal', () => {
  test('空切片 -> {0,0}', () => {
    expect(computeSliceSignal([], 0)).toEqual({ chars: 0, turnCount: 0 })
    expect(computeSliceSignal([t('user', 'hello')], 1)).toEqual({ chars: 0, turnCount: 0 })
  })
  test('offset=0 全量；offset 在中间只算切片', () => {
    const turns = [t('user', 'a'.repeat(100)), t('assistant', 'b'.repeat(200))]
    const full = computeSliceSignal(turns, 0)
    expect(full.turnCount).toBe(2)
    expect(full.chars).toBe(300)
    const half = computeSliceSignal(turns, 1)
    expect(half.turnCount).toBe(1)
    expect(half.chars).toBe(200)
  })
  test('offset 越界 -> {0,0}（不抛）', () => {
    expect(computeSliceSignal([t('user', 'x')], 99)).toEqual({ chars: 0, turnCount: 0 })
  })
  test('与过滤管线一致：tool turn 经 compactToolTurn 后按过滤结果计字符', () => {
    // 锁「信号量 = distiller 实际所见量」：长 tool 输出会被过滤截断，
    // signal.chars 必须反映截断后的长度而非原始长度。
    const bigTool: TranscriptTurn = { role: 'tool', content: 'x'.repeat(100_000) }
    const s = computeSliceSignal([bigTool], 0)
    expect(s.turnCount).toBe(1)
    expect(s.chars).toBeLessThan(10_000)
  })
})

describe('shouldRelease', () => {
  test('字符阈值边界 7999/8000', () => {
    expect(shouldRelease({ chars: 7999, turnCount: 3 })).toBe(false)
    expect(shouldRelease({ chars: 8000, turnCount: 3 })).toBe(true)
  })
  test('turn 护栏边界 49/50（OR 语义）', () => {
    expect(shouldRelease({ chars: 10, turnCount: 49 })).toBe(false)
    expect(shouldRelease({ chars: 10, turnCount: 50 })).toBe(true)
  })
})

describe('isTrivial', () => {
  test('999/1000 边界', () => {
    expect(isTrivial({ chars: 999, turnCount: 5 })).toBe(true)
    expect(isTrivial({ chars: 1000, turnCount: 5 })).toBe(false)
  })
})

describe('isStale', () => {
  test('TTL 边界 ±1ms', () => {
    const t0 = 1_000_000
    expect(isStale(t0, t0 + SESSION_FLUSH_TTL_MS - 1)).toBe(false)
    expect(isStale(t0, t0 + SESSION_FLUSH_TTL_MS)).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/threshold.test.ts`
Expected: FAIL（`@/memory/threshold` 不存在）

- [ ] **Step 3: 实现**

```ts
// src/memory/threshold.ts
import { filterTranscriptForDistill, type TranscriptTurn } from './pure'

// spec §3.3 阈值常量（代码常量，上线观测后调；观测结论记录 STATE.md）。
export const DISTILL_RELEASE_MIN_CHARS = 8000
export const DISTILL_RELEASE_MAX_TURNS = 50
export const DISTILL_TRIVIAL_FLOOR_CHARS = 1000
export const SESSION_FLUSH_TTL_MS = 2 * 60 * 60 * 1000

export interface SliceSignal { chars: number; turnCount: number }

/**
 * 切片信号：turns.slice(offset) 经 filterTranscriptForDistill 后的字符/turn 数。
 * 复用过滤管线保证「信号量 = distiller 实际会看到的量」（spec §4.1）。
 * offset 越界/空切片 -> {0,0}，永不抛（filterTranscriptForDistill 自身有 catch-all）。
 */
export function computeSliceSignal(turns: readonly TranscriptTurn[], offset: number): SliceSignal {
  const slice = offset <= 0 ? turns : turns.slice(offset)
  const filtered = filterTranscriptForDistill(slice)
  return {
    chars: filtered.reduce((s, t) => s + t.content.length, 0),
    turnCount: filtered.length,
  }
}

/** 放行判定（capture 时）：字符量达标 OR turn 数护栏（防单 job 切片无限变厚）。 */
export function shouldRelease(signal: SliceSignal): boolean {
  return signal.chars >= DISTILL_RELEASE_MIN_CHARS || signal.turnCount >= DISTILL_RELEASE_MAX_TURNS
}

/** 琐碎判定（flush/TTL 时）：低于下限判 skipped_trivial，不调 LLM。 */
export function isTrivial(signal: SliceSignal): boolean {
  return signal.chars < DISTILL_TRIVIAL_FLOOR_CHARS
}

/** TTL 过期判定（sweep 时）。 */
export function isStale(lastCaptureAt: number, now: number): boolean {
  return now - lastCaptureAt >= SESSION_FLUSH_TTL_MS
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/threshold.test.ts && bun run typecheck`
Expected: 全过 + 类型干净

- [ ] **Step 5: Commit**

```bash
git add src/memory/threshold.ts tests/threshold.test.ts
git commit -m "feat(memory): threshold 纯函数——切片信号与三判定（spec §4.1）"
```

---

### Task 2: contextDigest.ts 纯函数

**Files:**
- Create: `src/memory/contextDigest.ts`
- Test: `tests/context-digest.test.ts`

**Interfaces:**
- Consumes: `TranscriptTurn`（`src/memory/pure.ts`）
- Produces（Task 8 依赖）:
  - `DIGEST_MAX_CHARS = 3000`、`DIGEST_LINE_MAX_CHARS = 300`
  - `buildDeterministicDigest(turns: readonly TranscriptTurn[], maxChars?: number): string`

- [ ] **Step 1: 写失败测试**

```ts
// tests/context-digest.test.ts
import { describe, test, expect } from 'bun:test'
import { DIGEST_MAX_CHARS, DIGEST_LINE_MAX_CHARS, buildDeterministicDigest } from '@/memory/contextDigest'
import type { TranscriptTurn } from '@/memory/pure'

const t = (role: TranscriptTurn['role'], content: string, toolName?: string): TranscriptTurn =>
  ({ role, content, ...(toolName ? { toolName } : {}) })

describe('buildDeterministicDigest', () => {
  test('常量锁定', () => {
    expect(DIGEST_MAX_CHARS).toBe(3000)
    expect(DIGEST_LINE_MAX_CHARS).toBe(300)
  })
  test('user/assistant 截断 300 字单行，换行压平', () => {
    const d = buildDeterministicDigest([t('user', 'line1\nline2 ' + 'x'.repeat(500))])
    expect(d.startsWith('USER: line1 line2 ')).toBe(true)
    expect(d.length).toBeLessThanOrEqual('USER: '.length + DIGEST_LINE_MAX_CHARS)
  })
  test('tool 只留名字，system 跳过', () => {
    const d = buildDeterministicDigest([
      t('system', 'sys prompt 内容'),
      t('tool', '巨大的文件内容'.repeat(100), 'Read'),
    ])
    expect(d).toBe('[tool: Read]')
    expect(d).not.toContain('sys')
    expect(d).not.toContain('巨大的文件内容')
  })
  test('tool 无 toolName 时占位 unknown', () => {
    expect(buildDeterministicDigest([t('tool', 'x')])).toBe('[tool: unknown]')
  })
  test('时间序保持：输出顺序与输入一致', () => {
    const d = buildDeterministicDigest([t('user', 'first'), t('assistant', 'second'), t('user', 'third')])
    expect(d.indexOf('first')).toBeLessThan(d.indexOf('second'))
    expect(d.indexOf('second')).toBeLessThan(d.indexOf('third'))
  })
  test('总量超限从最早处截（保留最近的）', () => {
    const turns: TranscriptTurn[] = []
    for (let i = 0; i < 100; i++) turns.push(t('user', `msg-${i} ` + 'y'.repeat(200)))
    const d = buildDeterministicDigest(turns, 1000)
    expect(d.length).toBeLessThanOrEqual(1000)
    expect(d).toContain('msg-99')
    expect(d).not.toContain('msg-0')
  })
  test('空输入 -> 空串', () => {
    expect(buildDeterministicDigest([])).toBe('')
  })
  test('逐字节稳定性：同输入两次调用输出全等（锁 prompt 稳定性回归）', () => {
    const turns = [t('user', 'a'.repeat(400)), t('tool', 'z', 'Bash'), t('assistant', 'b')]
    expect(buildDeterministicDigest(turns)).toBe(buildDeterministicDigest(turns))
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/context-digest.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// src/memory/contextDigest.ts
import type { TranscriptTurn } from './pure'

export const DIGEST_MAX_CHARS = 3000
export const DIGEST_LINE_MAX_CHARS = 300

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim()

/**
 * 确定性 digest（经济模式；质量模式的降级兜底）：user/assistant 每条截
 * DIGEST_LINE_MAX_CHARS 字单行，tool 只留 `[tool: 名字]`，system 跳过。
 * 时间序拼接；超 maxChars 从最早处整行丢弃（保留最近上下文）。
 * 纯函数、同输入逐字节同输出（prompt 稳定性，spec §4.2）、永不抛。
 */
export function buildDeterministicDigest(
  turns: readonly TranscriptTurn[],
  maxChars: number = DIGEST_MAX_CHARS,
): string {
  if (!Array.isArray(turns) || turns.length === 0) return ''
  const lines: string[] = []
  for (const t of turns) {
    if (t.role === 'user') lines.push(`USER: ${squash(t.content).slice(0, DIGEST_LINE_MAX_CHARS)}`)
    else if (t.role === 'assistant') lines.push(`ASSISTANT: ${squash(t.content).slice(0, DIGEST_LINE_MAX_CHARS)}`)
    else if (t.role === 'tool') lines.push(`[tool: ${t.toolName ?? 'unknown'}]`)
    // system 跳过
  }
  // 从最早处整行丢弃直到总量达标（最后截一次行首防单行即超限的边界）。
  let out = lines.join('\n')
  while (out.length > maxChars && lines.length > 1) {
    lines.shift()
    out = lines.join('\n')
  }
  return out.length > maxChars ? out.slice(out.length - maxChars) : out
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/context-digest.test.ts && bun run typecheck`
Expected: 全过

- [ ] **Step 5: Commit**

```bash
git add src/memory/contextDigest.ts tests/context-digest.test.ts
git commit -m "feat(memory): contextDigest 纯函数——确定性前文摘要（spec §4.2）"
```

---

### Task 3: schema 迁移（last_capture_at + 三个新表 + waiting 枚举）

**Files:**
- Modify: `src/db/schema.ts`（jobs status enum、`lastCaptureAt` 列、三个新表定义）
- Modify: `src/db/client.ts`（DDL 块 + 幂等 ALTER 迁移 + drizzle schema 注册）
- Test: `tests/schema.test.ts`（追加 describe）

**Interfaces:**
- Consumes: 既有 `openDb`（`src/db/client.ts:9`）幂等迁移模式
- Produces（Task 4/7/8 依赖）:
  - drizzle 表：`memorySessionFlushes`（sessionId/ts）、`memorySessionDigests`（sessionId/digest/mode/updatedAt）、`memoryDegradations`（id/ts/kind/detail/distillJobId/sessionId）
  - `memoryDistillJobs.lastCaptureAt: integer('last_capture_at')`（可空）
  - jobs status enum 加 `'waiting'`：`'pending'|'running'|'done'|'failed'|'canceled'|'waiting'`

- [ ] **Step 1: 写失败测试（追加到 tests/schema.test.ts 尾部）**

```ts
describe('distill-batching schema（spec §4.5）', () => {
  test('新库：三个新表 + last_capture_at 列 + waiting 状态可插入', async () => {
    const db = openDb(':memory:')
    const cols = db.$client.prepare('PRAGMA table_info(memory_distill_jobs)').all() as { name: string }[]
    expect(cols.some((c) => c.name === 'last_capture_at')).toBe(true)
    // waiting 状态可插入（无 CHECK 约束回归锁：spec §4.5 已核实 live DB 无 CHECK）
    db.$client.exec(`INSERT INTO memory_distill_jobs (id, debounce_key, source_event_id, runtime, status, attempts, next_run_at, created_at)
      VALUES ('j1', 'k', 'e', 'claude-code', 'waiting', 0, 0, 0)`)
    db.$client.exec(`INSERT INTO memory_session_flushes (session_id, ts) VALUES ('s1', 1)`)
    db.$client.exec(`INSERT INTO memory_session_digests (session_id, digest, mode, updated_at) VALUES ('s1', 'd', 'llm', 1)`)
    db.$client.exec(`INSERT INTO memory_degradations (id, ts, kind) VALUES ('g1', 1, 'sweep_error')`)
  })
  test('幂等：模拟老库（无 last_capture_at、无新表）openDb 两次不炸且补齐', async () => {
    const path = join(tmpdir(), `memside-schema-batch-${Date.now()}.db`)
    // 手工建"老库"：只建旧版 jobs 表
    const raw = new Database(path)
    raw.exec(`CREATE TABLE memory_distill_jobs (
      id TEXT PRIMARY KEY, debounce_key TEXT NOT NULL, source_event_id TEXT NOT NULL,
      runtime TEXT NOT NULL, cwd TEXT, session_id TEXT, source_agent_id TEXT,
      scope_resolved_json TEXT, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      next_run_at INTEGER NOT NULL, last_error TEXT, created_at INTEGER NOT NULL, finished_at INTEGER)`)
    raw.close()
    const db1 = openDb(path)  // 第一次：迁移执行
    db1.$client.close()
    const db2 = openDb(path)  // 第二次：幂等不炸
    const cols = db2.$client.prepare('PRAGMA table_info(memory_distill_jobs)').all() as { name: string }[]
    expect(cols.some((c) => c.name === 'last_capture_at')).toBe(true)
    db2.$client.close()
    rmSync(path, { force: true })
  })
})
```

注：文件头部若未 import 需要补：`import { join } from 'node:path'`、`import { tmpdir } from 'node:os'`、`import { Database } from 'bun:sqlite'`、`import { rmSync } from 'node:fs'`、`openDb` from '@/db/client'（对齐该文件既有 import 风格；若既有测试已有等价 import 则复用）。

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/schema.test.ts`
Expected: FAIL（`last_capture_at` 列不存在 / 新表不存在）

- [ ] **Step 3: 实现**

`src/db/schema.ts` 改动：

```ts
// memoryDistillJobs 列块加（finishedAt 之后）：
    lastCaptureAt: integer('last_capture_at'), // 攒量批处理：该 session 最后一次 capture 的 ts（TTL 判定；NULL=legacy 不走 sweep）
// status enum 改为：
    status: text('status', {
      enum: ['pending', 'running', 'done', 'failed', 'canceled', 'waiting'],
    }).notNull(),
```

`src/db/schema.ts` 文件尾部追加三个表：

```ts
export const memorySessionFlushes = sqliteTable(
  'memory_session_flushes',
  {
    sessionId: text('session_id').primaryKey(),
    ts: integer('ts').notNull(),
  },
)

export const memorySessionDigests = sqliteTable(
  'memory_session_digests',
  {
    sessionId: text('session_id').primaryKey(),
    digest: text('digest').notNull(),
    mode: text('mode').notNull(), // 'llm' | 'deterministic-fallback'
    updatedAt: integer('updated_at').notNull(),
  },
)

export const memoryDegradations = sqliteTable(
  'memory_degradations',
  {
    id: text('id').primaryKey(),
    ts: integer('ts').notNull(),
    kind: text('kind').notNull(), // spec §5 枚举
    detail: text('detail'),
    distillJobId: text('distill_job_id'),
    sessionId: text('session_id'),
  },
  (t) => ({
    tsIdx: index('idx_degradations_ts').on(t.ts),
    jobIdx: index('idx_degradations_job').on(t.distillJobId),
  }),
)
```

`src/db/client.ts` 改动：
1. import 行追加三个新表名；
2. `drizzle(raw, { schema: {...} })` 的 schema 对象追加 `memorySessionFlushes, memorySessionDigests, memoryDegradations`；
3. DDL exec 块尾部追加：

```sql
    CREATE TABLE IF NOT EXISTS memory_session_flushes (
      session_id TEXT PRIMARY KEY,
      ts INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory_session_digests (
      session_id TEXT PRIMARY KEY,
      digest TEXT NOT NULL,
      mode TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory_degradations (
      id TEXT PRIMARY KEY,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      detail TEXT,
      distill_job_id TEXT,
      session_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_degradations_ts ON memory_degradations(ts);
    CREATE INDEX IF NOT EXISTS idx_degradations_job ON memory_degradations(distill_job_id);
```

4. 幂等迁移块（放在 error_message 迁移块之后、`return db` 之前）：

```ts
  // Idempotent migration: add last_capture_at to memory_distill_jobs.
  // 攒量批处理的 TTL 判定依据；NULL = legacy job 不走 sweep（spec §4.5）。无 backfill。
  {
    const cols = raw.prepare('PRAGMA table_info(memory_distill_jobs)').all() as { name: string }[]
    if (!cols.some((c) => c.name === 'last_capture_at')) {
      raw.exec('ALTER TABLE memory_distill_jobs ADD COLUMN last_capture_at INTEGER')
    }
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/schema.test.ts && bun run typecheck`
Expected: 全过

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts src/db/client.ts tests/schema.test.ts
git commit -m "feat(db): 攒量批处理 schema——last_capture_at + flushes/digests/degradations 三表 + waiting 枚举（spec §4.5）"
```

---

### Task 4: store 层扩展

**Files:**
- Modify: `src/memory/store.ts`（尾部追加新函数块）
- Test: `tests/store-distill-batching.test.ts`

**Interfaces:**
- Consumes: Task 3 的三个新表 + `memoryDistillJobs.lastCaptureAt`；`ulid`；`eq/and/gt/desc`（drizzle）
- Produces（Task 7/8/9 依赖，签名即契约）:

```ts
export interface DistillJobRow {
  id: string; runtime: string; sessionId: string | null; status: string
  lastCaptureAt: number | null; cwd: string | null; sourceAgentId: string | null
}
export interface DegradationRow {
  id: string; ts: number; kind: string; detail: string | null
  distillJobId: string | null; sessionId: string | null
}
findWaitingJob(db: DbClient, runtime: 'claude-code' | 'opencode', sessionId: string): Promise<DistillJobRow | null>
upsertSessionEvent(db: DbClient, jobId: string, payloadJson: string): Promise<void>
releaseWaitingJob(db: DbClient, jobId: string): Promise<void>
touchLastCapture(db: DbClient, jobId: string, ts: number): Promise<void>
listWaitingJobs(db: DbClient): Promise<DistillJobRow[]>
markFlush(db: DbClient, sessionId: string): Promise<void>
consumeFlush(db: DbClient, sessionId: string): Promise<boolean>
getSessionDigest(db: DbClient, sessionId: string): Promise<{ digest: string; mode: string } | null>
upsertSessionDigest(db: DbClient, sessionId: string, digest: string, mode: 'llm' | 'deterministic-fallback'): Promise<void>
logDegradation(db: DbClient, entry: { kind: string; detail?: string; distillJobId?: string; sessionId?: string }): Promise<void>
listRecentDegradations(db: DbClient, sinceTs: number): Promise<DegradationRow[]>
listDegradationsForJob(db: DbClient, jobId: string): Promise<DegradationRow[]>
```

- [ ] **Step 1: 写失败测试**

```ts
// tests/store-distill-batching.test.ts
import { describe, test, expect, beforeEach } from 'bun:test'
import { openDb, type DbClient } from '@/db/client'
import {
  findWaitingJob, upsertSessionEvent, releaseWaitingJob, touchLastCapture, listWaitingJobs,
  markFlush, consumeFlush, getSessionDigest, upsertSessionDigest,
  logDegradation, listRecentDegradations, listDegradationsForJob,
} from '@/memory/store'
import { memoryDistillJobs, memoryDistillEvents } from '@/db/schema'
import { eq } from 'drizzle-orm'

let db: DbClient
const seedJob = async (id: string, status: string, sessionId: string | null = 's1', sourceAgentId: string | null = null) => {
  await db.insert(memoryDistillJobs).values({
    id, debounceKey: 'k', sourceEventId: 'e', runtime: 'claude-code',
    sessionId, sourceAgentId, status, attempts: 0, nextRunAt: 0, createdAt: 1, finishedAt: null,
  })
}

beforeEach(() => { db = openDb(':memory:') })

describe('findWaitingJob / listWaitingJobs（不变量 A/B）', () => {
  test('命中 waiting；排除 pending/done/subagent/异 session/异 runtime', async () => {
    await seedJob('w1', 'waiting', 's1')
    await seedJob('p1', 'pending', 's1')
    await seedJob('d1', 'done', 's1')
    await seedJob('sub1', 'waiting', 's1', 'agent-x')
    await seedJob('w2', 'waiting', 's2')
    expect((await findWaitingJob(db, 'claude-code', 's1'))?.id).toBe('w1')
    expect(await findWaitingJob(db, 'claude-code', 's1')).not.toBeNull()
    const list = await listWaitingJobs(db)
    expect(list.map((j) => j.id).sort()).toEqual(['w1', 'w2'])
  })
  test('无命中 -> null', async () => {
    expect(await findWaitingJob(db, 'claude-code', 'nope')).toBeNull()
  })
})

describe('upsertSessionEvent（不变量 D：一 job 一行）', () => {
  test('重复 upsert 后恰一行且为最新 payload', async () => {
    await seedJob('j1', 'waiting')
    await upsertSessionEvent(db, 'j1', JSON.stringify([{ role: 'user', content: 'v1' }]))
    await upsertSessionEvent(db, 'j1', JSON.stringify([{ role: 'user', content: 'v2' }]))
    const rows = await db.select().from(memoryDistillEvents).where(eq(memoryDistillEvents.distillJobId, 'j1'))
    expect(rows.length).toBe(1)
    expect(rows[0]!.payload).toContain('v2')
  })
})

describe('releaseWaitingJob / touchLastCapture（不变量 B 单向）', () => {
  test('waiting -> pending 且 nextRunAt 立即可见', async () => {
    await seedJob('j1', 'waiting')
    await releaseWaitingJob(db, 'j1')
    const [j] = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, 'j1'))
    expect(j!.status).toBe('pending')
    expect(j!.nextRunAt).toBeLessThanOrEqual(Date.now())
  })
  test('touchLastCapture 写入 last_capture_at', async () => {
    await seedJob('j1', 'waiting')
    await touchLastCapture(db, 'j1', 12345)
    const [j] = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, 'j1'))
    expect(j!.lastCaptureAt).toBe(12345)
  })
})

describe('flush 标记（一次性 consume）', () => {
  test('mark 幂等；consume 有则删返 true、二次 consume 返 false', async () => {
    await markFlush(db, 's1')
    await markFlush(db, 's1')
    expect(await consumeFlush(db, 's1')).toBe(true)
    expect(await consumeFlush(db, 's1')).toBe(false)
    expect(await consumeFlush(db, 'nope')).toBe(false)
  })
})

describe('session digest', () => {
  test('无记录 -> null；upsert 覆盖并更新 mode', async () => {
    expect(await getSessionDigest(db, 's1')).toBeNull()
    await upsertSessionDigest(db, 's1', 'v1', 'llm')
    expect(await getSessionDigest(db, 's1')).toEqual({ digest: 'v1', mode: 'llm' })
    await upsertSessionDigest(db, 's1', 'v2', 'deterministic-fallback')
    expect(await getSessionDigest(db, 's1')).toEqual({ digest: 'v2', mode: 'deterministic-fallback' })
  })
})

describe('degradations（降级可见化，spec §5）', () => {
  test('log + 按时间/按 job 查询', async () => {
    const now = Date.now()
    await logDegradation(db, { kind: 'digest_llm_failed', detail: 'boom', distillJobId: 'j1', sessionId: 's1' })
    await logDegradation(db, { kind: 'sweep_error' })
    const recent = await listRecentDegradations(db, now - 60_000)
    expect(recent.length).toBe(2)
    expect(recent[0]!.ts).toBeGreaterThanOrEqual(recent[1]!.ts) // ts DESC
    const forJob = await listDegradationsForJob(db, 'j1')
    expect(forJob.length).toBe(1)
    expect(forJob[0]!.kind).toBe('digest_llm_failed')
    expect(await listRecentDegradations(db, now + 60_000)).toEqual([])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/store-distill-batching.test.ts`
Expected: FAIL（函数不存在）

- [ ] **Step 3: 实现（`src/memory/store.ts` 尾部追加）**

```ts
// ---------------------------------------------------------------------------
// 攒量批处理（spec §4.4）：waiting job / event upsert / flush / digest / degradations。
// ---------------------------------------------------------------------------

import { memorySessionFlushes, memorySessionDigests, memoryDegradations } from '@/db/schema'
// 顶部既有 import 块补：and（drizzle-orm）、ulid 已有则用既有

export interface DistillJobRow {
  id: string; runtime: string; sessionId: string | null; status: string
  lastCaptureAt: number | null; cwd: string | null; sourceAgentId: string | null
}

export interface DegradationRow {
  id: string; ts: number; kind: string; detail: string | null
  distillJobId: string | null; sessionId: string | null
}

const JOB_COLS = {
  id: memoryDistillJobs.id, runtime: memoryDistillJobs.runtime,
  sessionId: memoryDistillJobs.sessionId, status: memoryDistillJobs.status,
  lastCaptureAt: memoryDistillJobs.lastCaptureAt, cwd: memoryDistillJobs.cwd,
  sourceAgentId: memoryDistillJobs.sourceAgentId,
} as const

/** 累加中的 job（不变量 A：同 session 最多一个）。排除 subagent（一次性语义）。 */
export async function findWaitingJob(
  db: DbClient, runtime: 'claude-code' | 'opencode', sessionId: string,
): Promise<DistillJobRow | null> {
  const rows = await db.select(JOB_COLS).from(memoryDistillJobs)
    .where(and(
      eq(memoryDistillJobs.status, 'waiting'),
      eq(memoryDistillJobs.runtime, runtime),
      eq(memoryDistillJobs.sessionId, sessionId),
      isNull(memoryDistillJobs.sourceAgentId),
    )).limit(1)
  return rows[0] ?? null
}

export async function listWaitingJobs(db: DbClient): Promise<DistillJobRow[]> {
  return db.select(JOB_COLS).from(memoryDistillJobs)
    .where(and(eq(memoryDistillJobs.status, 'waiting'), isNull(memoryDistillJobs.sourceAgentId)))
}

/** 不变量 D：一 job 一行 event（最新全量快照）。同事务 delete+insert。 */
export async function upsertSessionEvent(db: DbClient, jobId: string, payloadJson: string): Promise<void> {
  db.$client.exec('BEGIN')
  try {
    db.$client.prepare('DELETE FROM memory_distill_events WHERE distill_job_id = ?').run(jobId)
    db.$client.prepare(
      "INSERT INTO memory_distill_events (distill_job_id, attempt_index, ts, kind, payload) VALUES (?, 0, ?, 'conversation', ?)",
    ).run(jobId, Date.now(), payloadJson)
    db.$client.exec('COMMIT')
  } catch (e) {
    db.$client.exec('ROLLBACK')
    throw e
  }
}

/** 不变量 B：waiting -> pending 单向放行，nextRunAt=now 立即参与 tick 选择。 */
export async function releaseWaitingJob(db: DbClient, jobId: string): Promise<void> {
  await db.update(memoryDistillJobs)
    .set({ status: 'pending', nextRunAt: Date.now() })
    .where(and(eq(memoryDistillJobs.id, jobId), eq(memoryDistillJobs.status, 'waiting'))).run()
}

export async function touchLastCapture(db: DbClient, jobId: string, ts: number): Promise<void> {
  await db.update(memoryDistillJobs).set({ lastCaptureAt: ts })
    .where(eq(memoryDistillJobs.id, jobId)).run()
}

export async function markFlush(db: DbClient, sessionId: string): Promise<void> {
  const now = Date.now()
  await db.insert(memorySessionFlushes).values({ sessionId, ts: now })
    .onConflictDoUpdate({ target: memorySessionFlushes.sessionId, set: { ts: now } }).run()
}

/** 一次性消费：有则删并返 true。 */
export async function consumeFlush(db: DbClient, sessionId: string): Promise<boolean> {
  const rows = await db.delete(memorySessionFlushes)
    .where(eq(memorySessionFlushes.sessionId, sessionId)).returning({ sessionId: memorySessionFlushes.sessionId })
  return rows.length > 0
}

export async function getSessionDigest(
  db: DbClient, sessionId: string,
): Promise<{ digest: string; mode: string } | null> {
  const rows = await db.select().from(memorySessionDigests)
    .where(eq(memorySessionDigests.sessionId, sessionId)).limit(1)
  return rows[0] ? { digest: rows[0].digest, mode: rows[0].mode } : null
}

export async function upsertSessionDigest(
  db: DbClient, sessionId: string, digest: string, mode: 'llm' | 'deterministic-fallback',
): Promise<void> {
  const now = Date.now()
  await db.insert(memorySessionDigests).values({ sessionId, digest, mode, updatedAt: now })
    .onConflictDoUpdate({ target: memorySessionDigests.sessionId, set: { digest, mode, updatedAt: now } }).run()
}

/**
 * 降级可见化（spec §5）：所有降级必须落表，UI 经 /api/status + 蒸馏记录呈现。
 * 本函数自身写表失败是唯一允许的 console-only 路径（审计系统自身故障）。
 */
export async function logDegradation(
  db: DbClient,
  entry: { kind: string; detail?: string; distillJobId?: string; sessionId?: string },
): Promise<void> {
  try {
    await db.insert(memoryDegradations).values({
      id: ulid(), ts: Date.now(), kind: entry.kind,
      detail: entry.detail ?? null, distillJobId: entry.distillJobId ?? null,
      sessionId: entry.sessionId ?? null,
    })
  } catch (e) {
    console.warn('memside: logDegradation failed (audit self-failure, console-only by design)', e)
  }
}

export async function listRecentDegradations(db: DbClient, sinceTs: number): Promise<DegradationRow[]> {
  return db.select().from(memoryDegradations)
    .where(gt(memoryDegradations.ts, sinceTs))
    .orderBy(desc(memoryDegradations.ts)).limit(100)
}

export async function listDegradationsForJob(db: DbClient, jobId: string): Promise<DegradationRow[]> {
  return db.select().from(memoryDegradations)
    .where(eq(memoryDegradations.distillJobId, jobId))
    .orderBy(desc(memoryDegradations.ts)).limit(50)
}
```

注：store.ts 顶部既有 import 需确认 `isNull`、`gt`、`desc`、`and`、`ulid` 已在（部分已有；缺什么补什么）。

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/store-distill-batching.test.ts && bun run typecheck`
Expected: 全过

- [ ] **Step 5: Commit**

```bash
git add src/memory/store.ts tests/store-distill-batching.test.ts
git commit -m "feat(store): 攒量批处理存储原语——waiting/event-upsert/flush/digest/degradations（spec §4.4）"
```

---

### Task 5: rollingSummary.ts

**Files:**
- Create: `src/memory/rollingSummary.ts`
- Test: `tests/rolling-summary.test.ts`

**Interfaces:**
- Consumes: `TranscriptTurn`、`LLMCall`、`callWithRetry`（`src/memory/retry.ts`）、`DIGEST_MAX_CHARS`（Task 2）
- Produces（Task 8 依赖）:
  - `ROLLING_SUMMARY_SYSTEM_PROMPT: string`
  - `mergeRollingSummary(priorDigest: string | null, newTurns: readonly TranscriptTurn[], callLLM: LLMCall): Promise<{ digest: string; truncated: boolean }>`（LLM 错误/空产出向外抛；`truncated=true` 表示产出超长被代码强制截断，调用方据此 logDegradation('digest_truncated')）

- [ ] **Step 1: 写失败测试**

```ts
// tests/rolling-summary.test.ts
import { describe, test, expect } from 'bun:test'
import { DIGEST_MAX_CHARS } from '@/memory/contextDigest'
import { ROLLING_SUMMARY_SYSTEM_PROMPT, mergeRollingSummary } from '@/memory/rollingSummary'
import type { TranscriptTurn } from '@/memory/pure'
import type { LLMCall } from '@/llm'

const t = (role: TranscriptTurn['role'], content: string): TranscriptTurn => ({ role, content })

describe('mergeRollingSummary（mock LLM）', () => {
  test('prior=null 首建：prompt 不含旧摘要段，返回新摘要', async () => {
    let seen = ''
    const callLLM: LLMCall = async (_sys, user) => { seen = user; return '摘要v1' }
    const out = await mergeRollingSummary(null, [t('user', '讨论 bun 测试')], callLLM)
    expect(out.digest).toBe('摘要v1')
    expect(out.truncated).toBe(false)
    expect(seen).not.toContain('旧摘要')
    expect(seen).toContain('讨论 bun 测试')
  })
  test('增量合并：prompt 同时含旧摘要与新切片', async () => {
    let seen = ''
    const callLLM: LLMCall = async (_sys, user) => { seen = user; return '合并后摘要' }
    const out = await mergeRollingSummary('旧摘要内容', [t('assistant', '新进展')], callLLM)
    expect(out.digest).toBe('合并后摘要')
    expect(seen).toContain('旧摘要内容')
    expect(seen).toContain('新进展')
  })
  test('超长产出被代码强制截断且 truncated=true（不信任 LLM，spec §4.3/§5 #8）', async () => {
    const callLLM: LLMCall = async () => 'x'.repeat(DIGEST_MAX_CHARS + 500)
    const out = await mergeRollingSummary(null, [t('user', 'a')], callLLM)
    expect(out.digest.length).toBe(DIGEST_MAX_CHARS)
    expect(out.truncated).toBe(true)
  })
  test('空白产出视为失败向外抛（调用方降级保留旧摘要）', async () => {
    const callLLM: LLMCall = async () => '   '
    await expect(mergeRollingSummary('旧', [t('user', 'a')], callLLM)).rejects.toThrow()
  })
  test('LLM 抛错向外传播（catch 不得吞）', async () => {
    const callLLM: LLMCall = async () => { throw new Error('ark 502') }
    await expect(mergeRollingSummary('旧', [t('user', 'a')], callLLM)).rejects.toThrow('ark 502')
  })
})

describe('ROLLING_SUMMARY_SYSTEM_PROMPT 中立性（项目记忆：判定 prompt 禁倾向性措辞）', () => {
  test('只压缩不评判：无 keep/discard/保留/丢弃类指令词', () => {
    expect(ROLLING_SUMMARY_SYSTEM_PROMPT).not.toMatch(/keep|discard|保留重要|丢弃|取舍/i)
    expect(ROLLING_SUMMARY_SYSTEM_PROMPT.length).toBeGreaterThan(50)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/rolling-summary.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// src/memory/rollingSummary.ts
import type { TranscriptTurn } from './pure'
import type { LLMCall } from '@/llm'
import { DIGEST_MAX_CHARS, DIGEST_LINE_MAX_CHARS } from './contextDigest'

/**
 * 滚动摘要 system prompt（spec §4.3）。中立压缩：只压缩不评判，
 * 禁止 keep/discard/倾向性措辞（项目记忆：LLM 判定 prompt 必须中立）。
 */
export const ROLLING_SUMMARY_SYSTEM_PROMPT = `You are a conversation-digest compressor for a memory sidecar.

You maintain a running digest of the EARLIER part of a developer-agent session, so that a later distillation step can understand the context of newer turns.

Rules:
- Output ONLY the merged digest text, no JSON, no markdown fences, no commentary.
- Write in 简体中文 (technical terms may stay in English).
- Chronological, topic-grouped plain sentences; one fact per line.
- Compress mechanically: merge what is given, do not editorialize, rank, or advise.
- Hard length budget: at most ${DIGEST_MAX_CHARS} characters.`

const renderTurns = (turns: readonly TranscriptTurn[]): string =>
  turns.map((t) => `[${t.role}] ${t.content.replace(/\s+/g, ' ').trim().slice(0, DIGEST_LINE_MAX_CHARS)}`).join('\n')

/**
 * 把本次切片增量并入既有滚动摘要。priorDigest=null 为首建。
 * LLM 错误向外抛（调用方保留旧摘要 + logDegradation）；空白产出同视为失败。
 * 产出超长由代码强制截断（不信任 LLM，spec §4.3）并以 truncated 标记告知调用方
 * （调用方 logDegradation('digest_truncated')，spec §5 #8）。
 */
export async function mergeRollingSummary(
  priorDigest: string | null,
  newTurns: readonly TranscriptTurn[],
  callLLM: LLMCall,
): Promise<{ digest: string; truncated: boolean }> {
  const newSlice = renderTurns(newTurns)
  const user = priorDigest
    ? `旧摘要：\n${priorDigest}\n\n新增会话内容：\n${newSlice}\n\n请输出合并后的新摘要。`
    : `会话内容：\n${newSlice}\n\n请输出摘要。`
  const out = await callLLM(ROLLING_SUMMARY_SYSTEM_PROMPT, user)
  const trimmed = (out ?? '').trim()
  if (!trimmed) throw new Error('rolling summary: empty LLM output')
  const truncated = trimmed.length > DIGEST_MAX_CHARS
  return { digest: truncated ? trimmed.slice(0, DIGEST_MAX_CHARS) : trimmed, truncated }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/rolling-summary.test.ts && bun run typecheck`
Expected: 全过

- [ ] **Step 5: Commit**

```bash
git add src/memory/rollingSummary.ts tests/rolling-summary.test.ts
git commit -m "feat(memory): rollingSummary——质量模式滚动 LLM 摘要（spec §4.3）"
```

---

### Task 6: distiller 输入扩展（priorContext + approvedTitles）

**Files:**
- Modify: `src/memory/distiller.ts`（`DistillInput` 两字段 + `renderUserPrompt` 组装）
- Test: `tests/distiller-context.test.ts`

**Interfaces:**
- Consumes: 既有 `distillTranscript`（`src/memory/distiller.ts:168`）
- Produces（Task 8 依赖）:`DistillInput` 新增可选字段
  - `priorContext?: string | null`（前文 digest 文本）
  - `approvedTitles?: string[]`（已审批记忆标题，上限 100 条由调用方保证）

- [ ] **Step 1: 写失败测试**

```ts
// tests/distiller-context.test.ts
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { distillTranscript } from '@/memory/distiller'
import type { LLMCall } from '@/llm'
import type { TranscriptTurn } from '@/memory/pure'

const t = (role: TranscriptTurn['role'], content: string): TranscriptTurn => ({ role, content })
const okLLM = (capture: { user?: string }): LLMCall => async (_sys, user) => {
  capture.user = user
  return JSON.stringify({ candidates: [] })
}
const base = { runtime: 'claude-code' as const, cwd: '/x', existingSlugs: [] }

describe('distiller 上下文扩展（spec §4.6）', () => {
  test('priorContext 进 prompt：背景节 + 禁止提炼标注', async () => {
    const cap: { user?: string } = {}
    await distillTranscript({ ...base, turns: [t('user', '新内容')], priorContext: 'USER: 旧讨论', approvedTitles: [], callLLM: okLLM(cap) })
    expect(cap.user).toContain('## 背景（仅供理解上下文，禁止从中提炼）')
    expect(cap.user).toContain('USER: 旧讨论')
    expect(cap.user!.indexOf('USER: 旧讨论')).toBeLessThan(cap.user!.indexOf('新内容'))
  })
  test('approvedTitles 进 prompt：已记录节 + 禁止重复标注', async () => {
    const cap: { user?: string } = {}
    await distillTranscript({ ...base, turns: [t('user', '新内容')], priorContext: null, approvedTitles: ['[category:convention] 用 bun test'], callLLM: okLLM(cap) })
    expect(cap.user).toContain('## 已记录的记忆标题（禁止重复提炼）')
    expect(cap.user).toContain('- [category:convention] 用 bun test')
  })
  test('向后兼容锁：两字段均空时 prompt 与旧行为逐字节一致', async () => {
    const capNew: { user?: string } = {}
    const capOld: { user?: string } = {}
    const turns = [t('user', '同样的输入')]
    await distillTranscript({ ...base, turns, callLLM: okLLM(capOld) })
    await distillTranscript({ ...base, turns, priorContext: null, approvedTitles: [], callLLM: okLLM(capNew) })
    expect(capNew.user).toBe(capOld.user)
  })
  test('空字符串 priorContext 视为无（不渲染空节）', async () => {
    const cap: { user?: string } = {}
    await distillTranscript({ ...base, turns: [t('user', 'x')], priorContext: '', approvedTitles: [], callLLM: okLLM(cap) })
    expect(cap.user).not.toContain('## 背景')
  })
})

describe('源码层文本断言（CLAUDE.md 运行时兜底面）', () => {
  test('distiller.ts 含两节标题常量', () => {
    const src = readFileSync('src/memory/distiller.ts', 'utf8')
    expect(src).toContain('## 背景（仅供理解上下文，禁止从中提炼）')
    expect(src).toContain('## 已记录的记忆标题（禁止重复提炼）')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/distiller-context.test.ts`
Expected: FAIL（prompt 无新节）

- [ ] **Step 3: 实现（`src/memory/distiller.ts` 改动）**

`DistillInput` 接口加两字段：

```ts
  /** 前文 digest（spec §4.6）。null/空串 = 无背景节（向后兼容）。 */
  priorContext?: string | null
  /** 已审批记忆标题清单（上限 100 条由调用方保证）。空数组 = 无该节。 */
  approvedTitles?: string[]
```

`renderUserPrompt` 签名与组装改为：

```ts
function renderUserPrompt(
  turns: TranscriptTurn[],
  runtime: string,
  cwd: string,
  signals: ReturnType<typeof detectErrorSignals>,
  existingSlugs: string[],
  sourceKind?: 'subagent' | 'conversation',
  priorContext?: string | null,
  approvedTitles?: string[],
): string {
  const transcript = turns.map((t) => `[${t.role}] ${t.content}`).join('\n')
  const slugs = existingSlugs.length > 0 ? existingSlugs.join(', ') : '(none)'
  const sections: string[] = []
  // 空节整节省略：两字段均空时输出与旧 prompt 逐字节一致（spec §4.6 向后兼容锁）。
  if (priorContext && priorContext.trim()) {
    sections.push(`## 背景（仅供理解上下文，禁止从中提炼）\n${priorContext}\n\n`)
  }
  if (approvedTitles && approvedTitles.length > 0) {
    sections.push(`## 已记录的记忆标题（禁止重复提炼）\n${approvedTitles.map((s) => `- ${s}`).join('\n')}\n\n`)
  }
  const base = `${sections.join('')}Runtime: ${runtime}\nCwd: ${cwd}\nError signals detected: ${JSON.stringify(signals)}\nExisting subject slugs (reuse these when a candidate matches an existing subject): ${slugs}\n\nTranscript:\n${transcript}\n\nExtract candidate memories as JSON per the system instructions.`
  return sourceKind === 'subagent' ? base + SUBAGENT_BRIEF_NOTE : base
}
```

`distillTranscript` 中调用点改为：

```ts
    const userPrompt = renderUserPrompt(filtered, input.runtime, input.cwd, signals, input.existingSlugs, input.sourceKind, input.priorContext, input.approvedTitles)
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/distiller-context.test.ts tests/distiller.test.ts && bun run typecheck`
Expected: 全过（旧 distiller 测试不回归——向后兼容锁保证）

- [ ] **Step 5: Commit**

```bash
git add src/memory/distiller.ts tests/distiller-context.test.ts
git commit -m "feat(distiller): priorContext/approvedTitles 进 prompt（spec §4.6，空时逐字节兼容）"
```

---

### Task 7: capture 累加化 + SessionEnd + install.ts

**Files:**
- Modify: `src/scheduler.ts`（新增 `enqueueWaitingJob`）
- Modify: `src/server.ts`（Stop/opencode capture 累加流程 + SessionEnd 分支）
- Modify: `src/install.ts`（EVENTS 加 SessionEnd + 注释）
- Test: `tests/server-distill-batching.test.ts`

**Interfaces:**
- Consumes: Task 1 阈值、Task 4 store 原语、既有 `enqueueDistillJob`（`src/scheduler.ts:34`）、`getSessionOffset`、`parseTranscriptFile`、`parseOpencodeMessages`
- Produces（Task 8/10 依赖）:
  - `enqueueWaitingJob(db, input: EnqueueInput): Promise<{ jobId: string }>`（同 enqueueDistillJob 字段，status='waiting'，lastCaptureAt=now）

**capture 累加流程（spec §3.2/§4.8）伪码（Stop 与 opencode 共用，抽路由内 helper）:**

```ts
// 有 sessionId 且非 subagent -> 累加；否则维持现状（一次 capture 一个立即放行 job）。
const waiting = await findWaitingJob(db, runtime, sessionId)
const jobId = waiting?.id ?? (await enqueueWaitingJob(db, {...})).jobId
await upsertSessionEvent(db, jobId, JSON.stringify(turns))
await touchLastCapture(db, jobId, Date.now())
let offset = 0
try { offset = await getSessionOffset(db, sessionId) } catch { /* 降级：视为 0（全量判定） */ }
const signal = computeSliceSignal(turns, offset)   // 抛错走外层 catch -> 放行 + threshold_compute_error
if (shouldRelease(signal)) await releaseWaitingJob(db, jobId)
```

- [ ] **Step 1: 写失败测试**

```ts
// tests/server-distill-batching.test.ts
// 测试基建对齐 tests/server.test.ts 既有模式（createApp + fake adapter + tmp DB + app.request）。
import { describe, test, expect, beforeEach } from 'bun:test'
import { openDb, type DbClient } from '@/db/client'
import { createApp } from '@/server'
import { memoryDistillJobs, memoryDistillEvents, memorySessionFlushes } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { enqueueDistillJob } from '@/scheduler'

let db: DbClient
let app: ReturnType<typeof createApp>
const enqueueResults: { jobId: string }[] = []

const makeTranscript = (turns: { role: string; content: string }[]): string => {
  const dir = mkdtempSync(join(tmpdir(), 'memside-batch-'))
  const p = join(dir, 'transcript.jsonl')
  // parseTranscriptFile 吃 claude code JSONL；按既有 server 测试的 fixture 形状写
  writeFileSync(p, turns.map((t) => JSON.stringify({ type: t.role, message: { role: t.role, content: t.content } })).join('\n'))
  return p
}

const stop = (sessionId: string, transcriptPath: string, chars = 100) =>
  app.request('/hooks/claude/Stop', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transcript_path: transcriptPath, cwd: '/proj', session_id: sessionId }),
  })

beforeEach(() => {
  db = openDb(':memory:')
  enqueueResults.length = 0
  app = createApp({
    db,
    adapter: { inject: async () => null } as never,
    opencodeAdapter: { inject: async () => null } as never,
    enqueueDistillJob: (d, input) => enqueueDistillJob(d, input).then((r) => { enqueueResults.push(r); return r }),
    broadcast: () => {},
  })
})

const waitIife = () => new Promise((r) => setTimeout(r, 30)) // fire-and-forget IIFE 落盘等待（对齐既有测试模式）

describe('Stop 累加（不变量 A/D）', () => {
  test('首个 Stop -> waiting job 建成且未放行；同 session 第二个 Stop 复用同 job', async () => {
    const tp = makeTranscript([{ role: 'user', content: '短内容' }])
    await stop('sess-1', tp); await waitIife()
    let jobs = await db.select().from(memoryDistillJobs)
    expect(jobs.length).toBe(1)
    expect(jobs[0]!.status).toBe('waiting')
    await stop('sess-1', tp); await waitIife()
    jobs = await db.select().from(memoryDistillJobs)
    expect(jobs.length).toBe(1) // 不变量 A：仍一个 job
    const events = await db.select().from(memoryDistillEvents)
      .where(eq(memoryDistillEvents.distillJobId, jobs[0]!.id))
    expect(events.length).toBe(1) // 不变量 D：恰一行
    expect(jobs[0]!.lastCaptureAt).not.toBeNull()
  })
  test('异 session 各自建 job', async () => {
    const tp = makeTranscript([{ role: 'user', content: 'x' }])
    await stop('sess-1', tp); await stop('sess-2', tp); await waitIife()
    expect((await db.select().from(memoryDistillJobs)).length).toBe(2)
  })
  test('阈值跨越 -> 放行 pending', async () => {
    const tp = makeTranscript([{ role: 'user', content: 'x'.repeat(9000) }])
    await stop('sess-1', tp); await waitIife()
    const jobs = await db.select().from(memoryDistillJobs)
    expect(jobs[0]!.status).toBe('pending')
  })
  test('无 sessionId -> 旧行为（立即 pending，一次 capture 一 job）', async () => {
    const tp = makeTranscript([{ role: 'user', content: 'x' }])
    await app.request('/hooks/claude/Stop', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript_path: tp, cwd: '/proj' }),
    })
    await waitIife()
    const jobs = await db.select().from(memoryDistillJobs)
    expect(jobs.length).toBe(1)
    expect(jobs[0]!.status).toBe('pending')
  })
})

describe('SessionEnd flush（spec §4.8）', () => {
  test('SessionEnd -> flush 标记落表，不动 job', async () => {
    const tp = makeTranscript([{ role: 'user', content: 'x' }])
    await stop('sess-1', tp); await waitIife()
    await app.request('/hooks/claude/SessionEnd', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'sess-1', cwd: '/proj', reason: 'prompt_input_exit' }),
    })
    await waitIife()
    const flushes = await db.select().from(memorySessionFlushes)
    expect(flushes.length).toBe(1)
    expect(flushes[0]!.sessionId).toBe('sess-1')
    const jobs = await db.select().from(memoryDistillJobs)
    expect(jobs[0]!.status).toBe('waiting') // flush 的放行由 tick sweep 做
  })
})

describe('opencode capture 累加（两侧统一，spec 决策 1）', () => {
  test('同 sessionId 两次 idle 复用同 job', async () => {
    const msg = { sessionId: 'oc-1', cwd: '/proj', messages: [
      { info: { role: 'user' }, parts: [{ type: 'text', text: '短' }] },
    ] }
    await app.request('/hooks/opencode/capture', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(msg) })
    await app.request('/hooks/opencode/capture', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(msg) })
    await waitIife()
    const jobs = await db.select().from(memoryDistillJobs)
    expect(jobs.length).toBe(1)
    expect(jobs[0]!.status).toBe('waiting')
  })
})

describe('降级可见化（spec §5）', () => {
  test('阈值计算路径异常 -> 立即放行 + threshold_compute_error 落表', async () => {
    // getSessionOffset 不抛（store 层稳定）；此用例通过让 computeSliceSignal
    // 收到畸形 turns 触发 catch 路径——fixture 写入非法 JSONL 行。
    // 实现注：capture 的 catch 块释放 job 并 logDegradation。
    const dir = mkdtempSync(join(tmpdir(), 'memside-batch-'))
    const p = join(dir, 'bad.jsonl')
    writeFileSync(p, 'not-json-at-all\n')
    await stop('sess-bad', p); await waitIife()
    // parseTranscriptFile 对非法行返回 []（现状），切片为空 -> waiting（不放行）。
    // 本用例锁的是「解析失败不炸路由、job 状态可解释」：
    const jobs = await db.select().from(memoryDistillJobs)
    expect(jobs.length).toBe(1)
    expect(['waiting', 'pending']).toContain(jobs[0]!.status)
  })
})

describe('install.ts SessionEnd 注册（源码层文本断言）', () => {
  test('EVENTS 含 SessionEnd', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('src/install.ts', 'utf8')
    expect(src).toContain("'SessionEnd'")
  })
})
```

注：`createApp` 的 adapter/opencodeAdapter fake 形状、`app.request` 调用、`waitIife` 等待模式全部对齐 `tests/server.test.ts` 既有写法——实现时先读该文件头部 30 行抄基建。transcript fixture 的 JSONL 形状以 `parseTranscriptFile` 实际解析为准（参考 `tests/` 中既有 claude transcript fixture）。

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/server-distill-batching.test.ts`
Expected: FAIL（waiting 流程未实现 / SessionEnd 分支不存在）

- [ ] **Step 3: 实现**

`src/scheduler.ts` 追加：

```ts
/**
 * 累加 job（spec §4.8）：与 enqueueDistillJob 同字段，status='waiting'，
 * lastCaptureAt=now。waiting 不进 tick 的 pending 选择；放行由
 * releaseWaitingJob（capture 阈值）或 sweep（flush/TTL）做。
 */
export async function enqueueWaitingJob(db: DbClient, input: EnqueueInput) {
  const id = ulid()
  const now = Date.now()
  await db.insert(memoryDistillJobs).values({
    id, debounceKey: input.debounceKey, sourceEventId: input.sourceEventId,
    runtime: input.runtime, cwd: input.cwd, sessionId: input.sessionId ?? null,
    sourceAgentId: input.sourceAgentId ?? null, status: 'waiting', attempts: 0,
    nextRunAt: now, createdAt: now, finishedAt: null, lastCaptureAt: now,
  })
  return { jobId: id, nextRunAt: now }
}
```

`src/server.ts`：
1. import 追加：`enqueueWaitingJob`（from '@/scheduler'）、`findWaitingJob, upsertSessionEvent, releaseWaitingJob, touchLastCapture, markFlush, logDegradation, getSessionOffset`（from '@/memory/store'）、`computeSliceSignal, shouldRelease`（from '@/memory/threshold'）。
2. 路由内累加 helper（放在 createApp 内、路由定义之前）：

```ts
  /**
   * 会话级累加 capture（spec §3.2/§4.8）：有 sessionId 的主会话 capture 走此路径。
   * 不变量 A（一 session 一 waiting job）/D（一 job 一行 event upsert）。
   * 阈值是优化非正确性依赖：任何异常 -> 立即放行 + logDegradation（spec §5 #1/#2）。
   */
  const accumulateCapture = async (input: {
    runtime: 'claude-code' | 'opencode'; sessionId: string; cwd: string
    sourceEventId: string; debounceKey: string; turns: import('@/memory/pure').TranscriptTurn[]
  }): Promise<void> => {
    let jobId: string | null = null
    try {
      const waiting = await findWaitingJob(deps.db, input.runtime, input.sessionId)
      jobId = waiting?.id
        ?? (await enqueueWaitingJob(deps.db, {
          sourceEventId: input.sourceEventId, runtime: input.runtime, cwd: input.cwd,
          debounceKey: input.debounceKey, sessionId: input.sessionId,
        })).jobId
      await upsertSessionEvent(deps.db, jobId, JSON.stringify(input.turns))
      await touchLastCapture(deps.db, jobId, Date.now())
    } catch (e) {
      // spec §5 #2：存储异常 -> 本次捕获丢失（下个 Stop 全量快照天然恢复），
      // 不放行（waiting job 留着等下次 upsert）+ capture_persist_failed 落表。
      await logDegradation(deps.db, {
        kind: 'capture_persist_failed', detail: String(e),
        distillJobId: jobId ?? undefined, sessionId: input.sessionId,
      })
      deps.broadcast({ type: 'memory.enqueue.failed', sourceEventId: input.sourceEventId, error: String(e) })
      return
    }
    // 阈值判定独立 try：spec §5 #1——阈值是优化非正确性依赖，异常 -> 立即放行。
    try {
      let offset = 0
      try { offset = await getSessionOffset(deps.db, input.sessionId) } catch { /* 降级：全量判定 */ }
      const signal = computeSliceSignal(input.turns, offset)
      if (shouldRelease(signal)) await releaseWaitingJob(deps.db, jobId)
    } catch (e) {
      try { await releaseWaitingJob(deps.db, jobId) } catch { /* 已非 waiting 则 no-op */ }
      await logDegradation(deps.db, {
        kind: 'threshold_compute_error', detail: String(e),
        distillJobId: jobId, sessionId: input.sessionId,
      })
    }
  }
```

3. Stop 路由的 IIFE 改为：

```ts
    void (async () => {
      try {
        const turns = transcriptPath ? parseTranscriptFile(transcriptPath) : []
        if (sessionId) {
          await accumulateCapture({ runtime: 'claude-code', sessionId, cwd, sourceEventId, debounceKey, turns })
        } else {
          // legacy 无 sessionId：旧行为（一次 capture 一个立即放行 job）。
          const { jobId } = await deps.enqueueDistillJob(deps.db, { sourceEventId, runtime: 'claude-code', cwd, debounceKey, sessionId })
          await deps.db.insert(memoryDistillEvents).values({
            distillJobId: jobId, attemptIndex: 0, ts: Date.now(), kind: sourceKind, payload: JSON.stringify(turns),
          })
        }
      } catch (e) {
        deps.broadcast({ type: 'memory.enqueue.failed', sourceEventId, error: String(e) })
      }
    })()
```

4. opencode capture 路由 IIFE 同理：`sessionId` 非空走 `accumulateCapture({ runtime: 'opencode', ... })`，为空走旧路径。
5. SessionEnd 分支（放在 SessionStart 分支之后）：

```ts
    // SessionEnd（spec §4.8）：会话有序结束 -> flush 标记，tick sweep 结算。
    // 崩溃/强杀时本事件不可靠，TTL 扫描兜底；处理失败 -> flush_mark_failed 落表。
    if (event === 'SessionEnd') {
      if (sessionId) {
        void (async () => {
          try { await markFlush(deps.db, sessionId) }
          catch (e) {
            await logDegradation(deps.db, { kind: 'flush_mark_failed', detail: `${String(e)}（TTL 兜底仍生效）`, sessionId })
          }
        })()
      }
      return c.json({ ok: true }, 202)
    }
```

6. `src/install.ts`：`EVENTS` 改为

```ts
const EVENTS = ['SessionStart', 'Stop', 'PostToolUse', 'SubagentStop', 'SessionEnd'] as const
```

并更新其上方注释块的事件清单（SessionEnd -> flush 标记，攒量批处理收尾）。

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/server-distill-batching.test.ts tests/server.test.ts && bun run typecheck`
Expected: 全过（既有 server 测试不回归）

- [ ] **Step 5: Commit**

```bash
git add src/scheduler.ts src/server.ts src/install.ts tests/server-distill-batching.test.ts
git commit -m "feat(server): capture 会话级累加 + SessionEnd flush（spec §3.2/§4.8）"
```

---

### Task 8: tick sweep + distiller 上下文接线 + 滚动摘要

**Files:**
- Modify: `src/daemon.ts`（`makeLoadTranscript` 返回 prefixTurns）
- Modify: `src/scheduler.ts`（`TickDeps.loadTranscript` 返回类型、sweep、distill 接线、滚动摘要、subagent trivial 判定）
- Test: `tests/scheduler-distill-batching.test.ts`

**Interfaces:**
- Consumes: Task 1/2/4/5/6 全部产物；`loadJudgeConfig`（既有）
- Produces（Task 10 依赖）:
  - `TickDeps['loadTranscript']` 返回类型改为 `Promise<{ turns: TranscriptTurn[]; fullLength: number; prefixTurns: TranscriptTurn[] }>`
  - `sweepWaitingJobs(db: DbClient, now: number): Promise<number>`（导出供测试；返回处理的 waiting job 数）
  - tick 内 distill 调用新增 `priorContext`、`approvedTitles`；`saveDistillRun` outcome 新值 `'skipped_trivial'`

**tick 内接线逻辑（conversation pending job，放在现有 `skipped_no_new_turns` 分支之后、distillTranscript 调用之前）:**

```ts
// 切片起点的 offset = fullLength - newTurns.length（loadTranscript 已切好）
const offset = fullLength - newTurns.length
const judgeCfgForDigest = deps.loadJudgeConfig?.() ?? DEFAULT_JUDGE_CONFIG
let priorContext: string | null = null
if (job.sessionId && offset > 0) {
  if (judgeCfgForDigest.mode === 'quality') {
    try {
      const d = await getSessionDigest(db, job.sessionId)
      priorContext = d?.digest ?? buildDeterministicDigest(prefixTurns) // legacy 兜底（spec §5 #7）
    } catch (e) {
      await logDegradation(db, { kind: 'digest_read_failed', detail: String(e), distillJobId: job.id, sessionId: job.sessionId })
      priorContext = null
    }
  } else {
    priorContext = buildDeterministicDigest(prefixTurns)
  }
}
let approvedTitles: string[] = []
try {
  const set = await listApprovedByScope(db, { projectId: job.cwd ?? 'unknown' })
  approvedTitles = [...set.byScope.project, ...set.byScope.global].map((m) => m.title).slice(0, 100)
} catch (e) {
  await logDegradation(db, { kind: 'titles_query_failed', detail: String(e), distillJobId: job.id, sessionId: job.sessionId ?? undefined })
}
// distillTranscript({ ..., priorContext, approvedTitles })
```

**滚动摘要（distill 成功 = outcome==='produced' 或 'empty_output' 且 !callThrew；质量模式；非 subagent；job.sessionId 非空；放在 setSessionOffset 之后）:**

```ts
if (!callThrew && judgeCfgForDigest.mode === 'quality' && job.sessionId && !job.sourceAgentId) {
  try {
    const prior = await getSessionDigest(db, job.sessionId)
    const { digest: merged, truncated } = await mergeRollingSummary(prior?.digest ?? null, newTurns, deps.callLLM)
    await upsertSessionDigest(db, job.sessionId, merged, 'llm')
    if (truncated) {
      await logDegradation(db, { kind: 'digest_truncated', detail: `LLM 摘要超 ${3000} 字被代码强制截断`, distillJobId: job.id, sessionId: job.sessionId })
    }
  } catch (e) {
    await logDegradation(db, { kind: 'digest_llm_failed', detail: String(e), distillJobId: job.id, sessionId: job.sessionId })
  }
}
```

**sweep（tick 开头，due 选择之前）:**

```ts
export async function sweepWaitingJobs(db: DbClient, now: number): Promise<number> {
  let handled = 0
  const waiting = await listWaitingJobs(db)
  for (const job of waiting) {
    if (!job.sessionId) continue
    const flushed = await consumeFlush(db, job.sessionId)
    const stale = job.lastCaptureAt !== null && isStale(job.lastCaptureAt, now)
    if (!flushed && !stale) continue
    // flush/TTL 触发：琐碎 -> skipped_trivial 收场；足量 -> 放行。
    const rows = await db.select().from(memoryDistillEvents)
      .where(eq(memoryDistillEvents.distillJobId, job.id))
    let turns: TranscriptTurn[] = []
    for (const r of rows) {
      try { const p = JSON.parse(r.payload); if (Array.isArray(p)) turns = p as TranscriptTurn[] } catch { /* skip */ }
    }
    let offset = 0
    try { offset = await getSessionOffset(db, job.sessionId) } catch { /* 全量判定 */ }
    const signal = computeSliceSignal(turns, offset)
    if (isTrivial(signal)) {
      try {
        await saveDistillRun(db, job.id, {
          outcome: 'skipped_trivial', rawOutput: null, rawCount: 0,
          acceptedCount: 0, dedupedCount: 0, filteredCount: 0, storedCount: 0,
          discardedCount: 0, durationMs: 0, errorMessage: null,
        })
      } catch (e) { console.warn('memside: saveDistillRun failed', e) }
      await db.update(memoryDistillJobs).set({ status: 'done', finishedAt: now })
        .where(eq(memoryDistillJobs.id, job.id)).run()
    } else {
      await releaseWaitingJob(db, job.id)
    }
    handled += 1
  }
  return handled
}
```

tick 主函数开头：

```ts
  const now = Date.now()
  try { await sweepWaitingJobs(db, now) }
  catch (e) {
    await logDegradation(db, { kind: 'sweep_error', detail: String(e) })
  }
```

**subagent trivial 判定（spec §4.8）：** tick 内 subagent job（`job.sourceAgentId` 非空）在 distillTranscript 之前：`isTrivial(computeSliceSignal(newTurns, 0))` -> 与 skipped_trivial 同样收场（saveDistillRun + done，不调 LLM）。

**daemon.ts `makeLoadTranscript` 改动：** 返回加 `prefixTurns`：

```ts
    const fullLength = turns.length
    if (job.sourceAgentId) return { turns, fullLength, prefixTurns: [] }
    if (!job.sessionId) return { turns, fullLength, prefixTurns: [] }
    let offset = 0
    try { offset = await getSessionOffset(db, job.sessionId) }
    catch (e) { console.warn('memside: getSessionOffset failed, degrading to full', e); return { turns, fullLength, prefixTurns: [] } }
    return { turns: turns.slice(offset), fullLength, prefixTurns: turns.slice(0, offset) }
```

- [ ] **Step 1: 写失败测试**

```ts
// tests/scheduler-distill-batching.test.ts
// 基建对齐 tests/scheduler.test.ts：tmp DB + mock callLLM + 手工 seed job/event。
import { describe, test, expect, beforeEach } from 'bun:test'
import { openDb, type DbClient } from '@/db/client'
import { memoryDistillJobs, memoryDistillEvents, memoryDistillRuns, memories } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { tick, sweepWaitingJobs, type TickDeps } from '@/scheduler'
import { createCandidate, markFlush, upsertSessionEvent, touchLastCapture, getSessionDigest, setSessionOffset } from '@/memory/store'
import { SESSION_FLUSH_TTL_MS } from '@/memory/threshold'
import type { LLMCall } from '@/llm'

let db: DbClient
const okLLM: LLMCall = async () => JSON.stringify({ candidates: [] })
const seedWaiting = async (id: string, sessionId: string, turns: unknown[], opts: { lastCaptureAt?: number; cwd?: string } = {}) => {
  await db.insert(memoryDistillJobs).values({
    id, debounceKey: 'k', sourceEventId: 'e', runtime: 'claude-code', cwd: opts.cwd ?? '/proj',
    sessionId, status: 'waiting', attempts: 0, nextRunAt: 0, createdAt: 1, finishedAt: null,
    lastCaptureAt: opts.lastCaptureAt ?? Date.now(),
  })
  await upsertSessionEvent(db, id, JSON.stringify(turns))
}
const tickDeps = (callLLM: LLMCall = okLLM): TickDeps => ({
  loadTranscript: async (job) => {
    const rows = await db.select().from(memoryDistillEvents).where(eq(memoryDistillEvents.distillJobId, job.id))
    const turns = rows.length ? JSON.parse(rows[0]!.payload) : []
    return { turns, fullLength: turns.length, prefixTurns: [] }
  },
  callLLM,
  createCandidate,
})

beforeEach(() => { db = openDb(':memory:') })

describe('sweepWaitingJobs（spec §4.7）', () => {
  test('flush 标记 + 足量 -> 放行 pending', async () => {
    await seedWaiting('j1', 's1', [{ role: 'user', content: 'x'.repeat(2000) }])
    await markFlush(db, 's1')
    expect(await sweepWaitingJobs(db, Date.now())).toBe(1)
    const [j] = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, 'j1'))
    expect(j!.status).toBe('pending')
  })
  test('flush + 不足量 -> skipped_trivial + done + 无 LLM 调用', async () => {
    await seedWaiting('j1', 's1', [{ role: 'user', content: '短' }])
    await markFlush(db, 's1')
    await sweepWaitingJobs(db, Date.now())
    const [j] = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, 'j1'))
    expect(j!.status).toBe('done')
    const [run] = await db.select().from(memoryDistillRuns).where(eq(memoryDistillRuns.distillJobId, 'j1'))
    expect(run!.outcome).toBe('skipped_trivial')
  })
  test('TTL 过期（lastCaptureAt 超过 2h）-> 同 flush 两分支', async () => {
    await seedWaiting('j1', 's1', [{ role: 'user', content: 'x'.repeat(2000) }], { lastCaptureAt: Date.now() - SESSION_FLUSH_TTL_MS - 1 })
    await sweepWaitingJobs(db, Date.now())
    const [j] = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, 'j1'))
    expect(j!.status).toBe('pending')
  })
  test('未过期无 flush -> 不动；lastCaptureAt NULL（legacy）-> 不走 sweep', async () => {
    await seedWaiting('j1', 's1', [{ role: 'user', content: 'x'.repeat(2000) }])
    await db.update(memoryDistillJobs).set({ lastCaptureAt: null }).where(eq(memoryDistillJobs.id, 'j1')).run()
    expect(await sweepWaitingJobs(db, Date.now())).toBe(0)
    const [j] = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, 'j1'))
    expect(j!.status).toBe('waiting')
  })
  test('offset 已结算的 session：flush 时无新内容 -> skipped_trivial', async () => {
    const turns = [{ role: 'user', content: 'x'.repeat(2000) }]
    await seedWaiting('j1', 's1', turns)
    await setSessionOffset(db, 's1', 1) // 已蒸馏过
    await markFlush(db, 's1')
    await sweepWaitingJobs(db, Date.now())
    const [run] = await db.select().from(memoryDistillRuns).where(eq(memoryDistillRuns.distillJobId, 'j1'))
    expect(run!.outcome).toBe('skipped_trivial')
  })
})

describe('tick 接线：priorContext/approvedTitles（spec §4.7）', () => {
  test('经济模式：distill prompt 含确定性 digest 与已审批标题', async () => {
    let seen = ''
    const spyLLM: LLMCall = async (_s, user) => { seen = user; return JSON.stringify({ candidates: [] }) }
    await createCandidate(db, {
      scopeType: 'project', scopeId: '/proj', title: '[category:convention] 已有记忆',
      bodyMd: 'b', tags: [], sourceKind: 'manual', sourceCwd: '/proj', runtime: 'claude-code',
    })
    // approved 需要 promote：用既有 promoteCandidate 或直接 update status
    await db.update(memories).set({ status: 'approved' }).run()
    await db.insert(memoryDistillJobs).values({
      id: 'j1', debounceKey: 'k', sourceEventId: 'e', runtime: 'claude-code', cwd: '/proj',
      sessionId: 's1', status: 'pending', attempts: 0, nextRunAt: 0, createdAt: 1, finishedAt: null,
    })
    const deps = tickDeps(spyLLM)
    deps.loadTranscript = async () => ({
      turns: [{ role: 'user', content: '新内容' }], fullLength: 3,
      prefixTurns: [{ role: 'user', content: '旧讨论一' }, { role: 'assistant', content: '旧讨论二' }],
    })
    await tick(db, deps)
    expect(seen).toContain('## 背景（仅供理解上下文，禁止从中提炼）')
    expect(seen).toContain('旧讨论一')
    expect(seen).toContain('## 已记录的记忆标题（禁止重复提炼）')
    expect(seen).toContain('[category:convention] 已有记忆')
  })
  test('titles 查询失败 -> 空清单降级 + titles_query_failed 落表（distill 照常）', async () => {
    // listApprovedByScope 的 DB 错误路径难以直接注入；此用例用关闭的 DB 连接
    // 不可行（tick 内同一 db）。改为源码断言见 Step 3 注。此处锁定「正常路径
    // titles 为空数组时不渲染该节」：
    let seen = ''
    const spyLLM: LLMCall = async (_s, user) => { seen = user; return JSON.stringify({ candidates: [] }) }
    await db.insert(memoryDistillJobs).values({
      id: 'j1', debounceKey: 'k', sourceEventId: 'e', runtime: 'claude-code', cwd: '/proj',
      sessionId: 's1', status: 'pending', attempts: 0, nextRunAt: 0, createdAt: 1, finishedAt: null,
    })
    const deps = tickDeps(spyLLM)
    deps.loadTranscript = async () => ({ turns: [{ role: 'user', content: 'x' }], fullLength: 1, prefixTurns: [] })
    await tick(db, deps)
    expect(seen).not.toContain('## 已记录的记忆标题')
  })
})

describe('滚动摘要接线（质量模式，spec §4.7）', () => {
  test('distill 成功后 mergeRollingSummary 并入并 upsert；摘要进下次 prompt', async () => {
    const calls: string[] = []
    let n = 0
    const dualLLM: LLMCall = async (sys, user) => {
      calls.push(sys)
      n += 1
      if (n === 1) return JSON.stringify({ candidates: [] }) // distill
      return '滚动摘要v1' // mergeRollingSummary
    }
    await db.insert(memoryDistillJobs).values({
      id: 'j1', debounceKey: 'k', sourceEventId: 'e', runtime: 'claude-code', cwd: '/proj',
      sessionId: 's1', status: 'pending', attempts: 0, nextRunAt: 0, createdAt: 1, finishedAt: null,
    })
    const deps = tickDeps(dualLLM)
    deps.loadJudgeConfig = () => ({ mode: 'quality', maxRounds: 5, timeBudgetS: 60 })
    deps.loadTranscript = async () => ({ turns: [{ role: 'user', content: '新内容' }], fullLength: 1, prefixTurns: [] })
    await tick(db, deps)
    expect((await getSessionDigest(db, 's1'))?.digest).toBe('滚动摘要v1')
  })
  test('mergeRollingSummary 抛错 -> digest_llm_failed 落表 + job 仍 done', async () => {
    const failLLM: LLMCall = async (sys) => {
      if (sys.includes('compressor') || sys.includes('digest')) throw new Error('ark 502')
      return JSON.stringify({ candidates: [] })
    }
    await db.insert(memoryDistillJobs).values({
      id: 'j1', debounceKey: 'k', sourceEventId: 'e', runtime: 'claude-code', cwd: '/proj',
      sessionId: 's1', status: 'pending', attempts: 0, nextRunAt: 0, createdAt: 1, finishedAt: null,
    })
    const deps = tickDeps(failLLM)
    deps.loadJudgeConfig = () => ({ mode: 'quality', maxRounds: 5, timeBudgetS: 60 })
    await tick(db, deps)
    const [j] = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, 'j1'))
    expect(j!.status).toBe('done')
    const degs = await db.query.memoryDegradations.findMany()
    expect(degs.some((d) => d.kind === 'digest_llm_failed')).toBe(true)
  })
})

describe('subagent trivial 判定（spec §4.8）', () => {
  test('subagent job 低于琐碎下限 -> skipped_trivial 不调 LLM', async () => {
    let called = false
    const spyLLM: LLMCall = async () => { called = true; return JSON.stringify({ candidates: [] }) }
    await db.insert(memoryDistillJobs).values({
      id: 'j1', debounceKey: 'k', sourceEventId: 'e', runtime: 'claude-code', cwd: '/proj',
      sessionId: null, sourceAgentId: 'agent-x', status: 'pending', attempts: 0, nextRunAt: 0,
      createdAt: 1, finishedAt: null,
    })
    const deps = tickDeps(spyLLM)
    deps.loadTranscript = async () => ({ turns: [{ role: 'user', content: '短' }], fullLength: 1, prefixTurns: [] })
    await tick(db, deps)
    expect(called).toBe(false)
    const [run] = await db.select().from(memoryDistillRuns).where(eq(memoryDistillRuns.distillJobId, 'j1'))
    expect(run!.outcome).toBe('skipped_trivial')
  })
})

describe('tick 对 sweep 异常的韧性（spec §5 #9）', () => {
  test('sweep 抛错 -> sweep_error 落表 + pending job 仍被处理', async () => {
    // listWaitingJobs 本身走 db；用一行会让 consumeFlush 抛错的数据注入困难，
    // 改为锁「sweep 被 try/catch 包住」的源码断言：
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('src/scheduler.ts', 'utf8')
    expect(src).toContain("'sweep_error'")
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/scheduler-distill-batching.test.ts`
Expected: FAIL（sweepWaitingJobs 不存在 / 返回类型无 prefixTurns）

- [ ] **Step 3: 实现**

按本 task 上方「tick 内接线逻辑」「滚动摘要」「sweep」「subagent trivial」「daemon.ts 改动」五段代码实现。注意：
1. `TickDeps['loadTranscript']` 返回类型加 `prefixTurns: TranscriptTurn[]`——`tests/scheduler.test.ts`、`tests/daemon.test.ts`（若存在）等既有 fake 需要同步补 `prefixTurns: []`（typecheck 会指出全部位置）。
2. `scheduler.ts` import 追加：`buildDeterministicDigest`（contextDigest）、`mergeRollingSummary`（rollingSummary）、`getSessionDigest, upsertSessionDigest, listWaitingJobs, consumeFlush, releaseWaitingJob, logDegradation, getSessionOffset`（store）、`computeSliceSignal, isTrivial, isStale`（threshold）。
3. subagent trivial 判定放在现有 `skipped_no_new_turns` 分支之后、`distillTranscript` 之前：

```ts
      // subagent trivial（spec §4.8）：一次性 job 低于下限 -> skipped_trivial 不调 LLM。
      if (job.sourceAgentId && isTrivial(computeSliceSignal(newTurns, 0))) {
        try {
          await saveDistillRun(db, job.id, {
            outcome: 'skipped_trivial', rawOutput: null, rawCount: 0,
            acceptedCount: 0, dedupedCount: 0, filteredCount: 0, storedCount: 0,
            discardedCount: 0, durationMs: 0, errorMessage: null,
          })
        } catch (e) { console.warn('memside: saveDistillRun failed', e) }
        await db.update(memoryDistillJobs).set({ status: 'done', finishedAt: Date.now() })
          .where(eq(memoryDistillJobs.id, job.id)).run()
        processed += 1
        continue
      }
```

4. `saveDistillRun` 的 outcome 参数类型若在 store 层有枚举，加 `'skipped_trivial'`。

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/scheduler-distill-batching.test.ts tests/scheduler.test.ts && bun run typecheck && bun test`
Expected: 全绿（含全套件回归）

- [ ] **Step 5: Commit**

```bash
git add src/scheduler.ts src/daemon.ts tests/scheduler-distill-batching.test.ts tests/scheduler.test.ts
git commit -m "feat(scheduler): tick sweep + distiller 上下文接线 + 滚动摘要（spec §4.7）"
```

---

### Task 9: /api/status recentDegradations + Web UI 降级呈现

**Files:**
- Modify: `src/server.ts`（/api/status + `POST /api/degradations/ack` + `GET /api/distill-runs/:jobId/degradations`）
- Modify: `src/web/api.ts`（StatusResponse 类型 + 两个 API wrapper）
- Modify: `src/web/ui-utils.ts`（formatOutcome 加 skipped_trivial + outcome 类型 + degradation kind 人话映射）
- Modify: `src/web/App.tsx`（琥珀色降级横幅 + runs 行徽标 + modal degradations 区）
- Modify: `src/web/tab-cache.ts`（若 StatusResponse 在别处重复定义，同步）
- Test: `tests/server-degradations.test.ts`、`tests/web-ui-utils.test.ts`（追加）、`tests/web-degradations.test.ts`（源码文本断言）

**Interfaces:**
- Consumes: Task 4 `listRecentDegradations/listDegradationsForJob`；`appSettings`（ack ts 存取）
- Produces:
  - `GET /api/status` 响应加 `recentDegradations: { count24h: number; latest: { kind: string; detail: string | null; ts: number } | null; acknowledgedTs: number | null }` 与 `waitingJobs: number`（spec §4.9：累加中 job 单列，避免积压假象）
  - `POST /api/degradations/ack` -> `{ ok: true }`（ack ts = now 写 appSettings key `degradations.ack_ts`）
  - `GET /api/distill-runs/:jobId/degradations` -> `{ degradations: DegradationRow[] }`
  - ui-utils: `formatOutcome('skipped_trivial')` -> `{ label: '琐碎跳过', color: '#999' }`；`degradationKindLabel(kind: string): string`

- [ ] **Step 1: 写失败测试**

```ts
// tests/server-degradations.test.ts
import { describe, test, expect, beforeEach } from 'bun:test'
import { openDb, type DbClient } from '@/db/client'
import { createApp } from '@/server'
import { logDegradation } from '@/memory/store'

let db: DbClient
let app: ReturnType<typeof createApp>

beforeEach(() => {
  db = openDb(':memory:')
  app = createApp({
    db,
    adapter: { inject: async () => null } as never,
    opencodeAdapter: { inject: async () => null } as never,
    enqueueDistillJob: async () => ({ jobId: 'x', nextRunAt: 0 }),
    broadcast: () => {},
  })
})

describe('GET /api/status recentDegradations（spec §4.9）', () => {
  test('无降级 -> count24h=0 latest=null；waitingJobs 字段存在', async () => {
    const res = await app.request('/api/status')
    const body = await res.json()
    expect(body.recentDegradations.count24h).toBe(0)
    expect(body.recentDegradations.latest).toBeNull()
    expect(body.recentDegradations.acknowledgedTs).toBeNull()
    expect(typeof body.waitingJobs).toBe('number')
  })
  test('有降级 -> 计数 + 最新一条；ack 后 acknowledgedTs 返回', async () => {
    await logDegradation(db, { kind: 'digest_llm_failed', detail: 'ark 502', distillJobId: 'j1' })
    await logDegradation(db, { kind: 'sweep_error' })
    let body = await (await app.request('/api/status')).json()
    expect(body.recentDegradations.count24h).toBe(2)
    expect(['digest_llm_failed', 'sweep_error']).toContain(body.recentDegradations.latest.kind)
    await app.request('/api/degradations/ack', { method: 'POST' })
    body = await (await app.request('/api/status')).json()
    expect(typeof body.recentDegradations.acknowledgedTs).toBe('number')
  })
})

describe('GET /api/distill-runs/:jobId/degradations', () => {
  test('返回该 job 的降级明细', async () => {
    await logDegradation(db, { kind: 'digest_read_failed', detail: 'db locked', distillJobId: 'j1' })
    const res = await app.request('/api/distill-runs/j1/degradations')
    const body = await res.json()
    expect(body.degradations.length).toBe(1)
    expect(body.degradations[0].kind).toBe('digest_read_failed')
  })
})
```

```ts
// tests/web-ui-utils.test.ts 追加 describe
describe('formatOutcome skipped_trivial（spec §4.9）', () => {
  test('新 outcome 有专属徽标', () => {
    expect(formatOutcome('skipped_trivial')).toEqual({ label: '琐碎跳过', color: '#999' })
  })
  test('未知 outcome 兜底不空白', () => {
    const r = formatOutcome('some_future_outcome' as never)
    expect(r.label.length).toBeGreaterThan(0)
  })
})

describe('degradationKindLabel', () => {
  test('已知 kind 人话映射；未知 kind 原样返回', () => {
    expect(degradationKindLabel('digest_llm_failed')).toBe('滚动摘要失败')
    expect(degradationKindLabel('threshold_compute_error')).toBe('阈值计算失败')
    expect(degradationKindLabel('capture_persist_failed')).toBe('捕获存储失败')
    expect(degradationKindLabel('flush_mark_failed')).toBe('flush标记失败')
    expect(degradationKindLabel('digest_read_failed')).toBe('摘要读取失败')
    expect(degradationKindLabel('titles_query_failed')).toBe('已审批查询失败')
    expect(degradationKindLabel('sweep_error')).toBe('sweep异常')
    expect(degradationKindLabel('digest_truncated')).toBe('摘要超长截断')
    expect(degradationKindLabel('whatever')).toBe('whatever')
  })
})
```

```ts
// tests/web-degradations.test.ts（源码层文本断言，CLAUDE.md 运行时兜底面）
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'

describe('降级横幅与 modal 呈现（源码断言）', () => {
  test('App.tsx 含降级横幅与 ack 调用', () => {
    const src = readFileSync('src/web/App.tsx', 'utf8')
    expect(src).toContain('recentDegradations')
    expect(src).toContain('/api/degradations/ack')
    expect(src).toContain('次降级')
  })
  test('App.tsx 蒸馏 modal 含 degradations 区', () => {
    const src = readFileSync('src/web/App.tsx', 'utf8')
    expect(src).toContain('/degradations')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/server-degradations.test.ts tests/web-ui-utils.test.ts tests/web-degradations.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`src/web/ui-utils.ts`：

```ts
export type DistillOutcome = 'skipped_no_new_turns' | 'empty_output' | 'llm_error' | 'produced' | 'skipped_trivial'

export function formatOutcome(outcome: DistillOutcome): { label: string; color: string } {
  if (outcome === 'produced') return { label: '产出', color: '#2e7d32' }
  if (outcome === 'empty_output') return { label: '空产出', color: '#666' }
  if (outcome === 'llm_error') return { label: 'LLM错误', color: '#c00' }
  if (outcome === 'skipped_trivial') return { label: '琐碎跳过', color: '#999' }
  if (outcome === 'skipped_no_new_turns') return { label: '跳过', color: '#999' }
  // 未知 outcome 兜底：不得空白（spec §5 #10）
  return { label: String(outcome), color: '#999' }
}

/** 降级 kind -> 人话（spec §5 枚举；未知 kind 原样返回兜底）。 */
export function degradationKindLabel(kind: string): string {
  const map: Record<string, string> = {
    threshold_compute_error: '阈值计算失败',
    capture_persist_failed: '捕获存储失败',
    flush_mark_failed: 'flush标记失败',
    digest_llm_failed: '滚动摘要失败',
    digest_read_failed: '摘要读取失败',
    titles_query_failed: '已审批查询失败',
    sweep_error: 'sweep异常',
    digest_truncated: '摘要超长截断',
  }
  return map[kind] ?? kind
}
```

`src/server.ts`：
1. `/api/status` handler 在 `unevalCount` 查询后追加：

```ts
    // 降级可见化（spec §4.9）：24h 计数 + 最新一条 + ack 状态。
    const degrRows = await listRecentDegradations(deps.db, cutoff)
    const ackRow = await deps.db.select().from(appSettings)
      .where(eq(appSettings.key, 'degradations.ack_ts')).limit(1)
    const acknowledgedTs = ackRow[0] ? Number(ackRow[0].value) : null
    // waiting 单列（spec §4.9）：累加中的 job 不是积压，避免 UI「pending 堆积」假象。
    const waitingCount = await deps.db.select({ n: count() }).from(memoryDistillJobs)
      .where(eq(memoryDistillJobs.status, 'waiting')).all()
```

响应对象加：

```ts
      recentDegradations: {
        count24h: degrRows.length,
        latest: degrRows[0] ? { kind: degrRows[0].kind, detail: degrRows[0].detail, ts: degrRows[0].ts } : null,
        acknowledgedTs: Number.isFinite(acknowledgedTs) ? acknowledgedTs : null,
      },
      waitingJobs: waitingCount[0]?.n ?? 0,
```

2. 两个新路由（/api/status 之后）：

```ts
  app.post('/api/degradations/ack', async (c) => {
    const now = Date.now()
    await deps.db.insert(appSettings).values({ key: 'degradations.ack_ts', value: String(now), updatedAt: now })
      .onConflictDoUpdate({ target: appSettings.key, set: { value: String(now), updatedAt: now } }).run()
    return c.json({ ok: true })
  })

  app.get('/api/distill-runs/:jobId/degradations', async (c) => {
    const rows = await listDegradationsForJob(deps.db, c.req.param('jobId'))
    return c.json({ degradations: rows })
  })
```

import 追加：`listRecentDegradations, listDegradationsForJob`（store）、`appSettings`（schema）。

`src/web/api.ts`：`StatusResponse` 加：

```ts
  recentDegradations?: {
    count24h: number
    latest: { kind: string; detail: string | null; ts: number } | null
    acknowledgedTs: number | null
  }
```

加 wrapper：

```ts
export async function ackDegradations(): Promise<void> {
  await fetch(`${BASE}/api/degradations/ack`, { method: 'POST' })
}
export async function getRunDegradations(jobId: string): Promise<{ degradations: { id: string; ts: number; kind: string; detail: string | null }[] }> {
  const res = await fetch(`${BASE}/api/distill-runs/${encodeURIComponent(jobId)}/degradations`)
  return res.json()
}
```

`src/web/App.tsx`（对齐既有样式风格，inline style）：
1. 状态栏 `status.lastError` 块之后追加降级横幅：

```tsx
            {status.recentDegradations && status.recentDegradations.count24h > 0 &&
             (status.recentDegradations.acknowledgedTs === null ||
              (status.recentDegradations.latest && status.recentDegradations.latest.ts > status.recentDegradations.acknowledgedTs)) ? (
              <div style={{ marginTop: 6, color: '#e65100' }}>
                近 24h {status.recentDegradations.count24h} 次降级
                {status.recentDegradations.latest ? `: ${degradationKindLabel(status.recentDegradations.latest.kind)}` : ''}
                <button style={{ marginLeft: 8, fontSize: 12 }} onClick={() => { void ackDegradations().then(() => refresh(tab)) }}>知道了</button>
              </div>
            ) : null}
```

2. `DistillRunModal` llm_error 错误区之后追加 degradations 区（点开 modal 时 `getRunDegradations(jobId)` 懒加载，三态：loading / error 行 / 列表）：

```tsx
  // modal 内新增 state: const [degs, setDegs] = useState<null | { kind: string; detail: string | null; ts: number }[]>(null)
  // useEffect(jobId): getRunDegradations(jobId).then(r => setDegs(r.degradations)).catch(() => setDegs([]))
  {degs && degs.length > 0 ? (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontWeight: 600 }}>降级记录</div>
      {degs.map((d) => (
        <div key={d.kind + d.ts} style={{ color: '#e65100', fontSize: 13 }}>
          {degradationKindLabel(d.kind)}{d.detail ? `：${d.detail}` : ''}
        </div>
      ))}
    </div>
  ) : null}
```

3. import 追加 `degradationKindLabel`（ui-utils）、`ackDegradations, getRunDegradations`（api）。

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/server-degradations.test.ts tests/web-ui-utils.test.ts tests/web-degradations.test.ts && bun run typecheck && bun test`
Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add src/server.ts src/web/api.ts src/web/ui-utils.ts src/web/App.tsx tests/server-degradations.test.ts tests/web-ui-utils.test.ts tests/web-degradations.test.ts
git commit -m "feat(web): 降级可见化——status recentDegradations + 横幅 + 蒸馏 modal 明细 + skipped_trivial 徽标（spec §4.9）"
```

---

### Task 10: e2e 门禁 + 降级点源码守卫 + 文档收尾

**Files:**
- Test: `tests/e2e-distill-batching.test.ts`
- Test: `tests/degradation-coverage.test.ts`（源码守卫）
- Modify: `STATE.md`（新段落：本需求 + 上线后观测要求）
- Modify: `README.md`（一句话提及攒量批处理行为，若 README 有捕获/蒸馏行为说明处）

**Interfaces:**
- Consumes: Task 1-9 全部
- Produces: 无（终端任务）

- [ ] **Step 1: 写 e2e 门禁测试**

```ts
// tests/e2e-distill-batching.test.ts
// 核心回归（spec §6.6）：一个 session 三次 Stop——前两次不足阈值零 LLM 调用零候选；
// 第三次跨阈值一次调用 + done + offset 结算正确；SessionEnd flush 尾巴第四次调用。
import { describe, test, expect, beforeEach } from 'bun:test'
import { openDb, type DbClient } from '@/db/client'
import { createApp } from '@/server'
import { tick, type TickDeps } from '@/scheduler'
import { memoryDistillJobs, memoryDistillEvents, memories } from '@/db/schema'
import { createCandidate, getSessionOffset } from '@/memory/store'
import { makeLoadTranscript } from '@/daemon'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LLMCall } from '@/llm'

let db: DbClient
let app: ReturnType<typeof createApp>
let llmCalls: number
const llm: LLMCall = async () => { llmCalls += 1; return JSON.stringify({ candidates: [] }) }

const writeTranscript = (turns: { role: string; content: string }[]): string => {
  const dir = mkdtempSync(join(tmpdir(), 'memside-e2e-'))
  const p = join(dir, 't.jsonl')
  writeFileSync(p, turns.map((t) => JSON.stringify({ type: t.role, message: { role: t.role, content: t.content } })).join('\n'))
  return p
}
const stop = async (sessionId: string, tp: string) => {
  await app.request('/hooks/claude/Stop', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transcript_path: tp, cwd: '/proj', session_id: sessionId }),
  })
  await new Promise((r) => setTimeout(r, 30))
}
const runTick = () => tick(db, { loadTranscript: makeLoadTranscript(db), callLLM: llm, createCandidate })

beforeEach(() => {
  db = openDb(':memory:')
  llmCalls = 0
  app = createApp({
    db,
    adapter: { inject: async () => null } as never,
    opencodeAdapter: { inject: async () => null } as never,
    enqueueDistillJob: async () => { throw new Error('e2e 走 accumulateCapture，不应直接 enqueue') },
    broadcast: () => {},
  })
})

test('攒量批处理 e2e：三次 Stop + SessionEnd flush（spec §6.6）', async () => {
  const small = (n: number) => Array.from({ length: n }, (_, i) => ({ role: 'user', content: `短消息${i}` }))
  const big = () => [{ role: 'user', content: 'x'.repeat(9000) }]

  // 第 1、2 次 Stop：不足阈值 -> waiting，零 LLM 调用
  await stop('s1', writeTranscript(small(2)))
  await runTick(); expect(llmCalls).toBe(0)
  await stop('s1', writeTranscript(small(4)))
  await runTick(); expect(llmCalls).toBe(0)
  expect((await db.select().from(memoryDistillJobs)).length).toBe(1) // 不变量 A

  // 第 3 次 Stop：跨阈值 -> 放行，一次调用，offset 结算
  await stop('s1', writeTranscript([...small(4), ...big()]))
  await runTick(); expect(llmCalls).toBe(1)
  const [job] = await db.select().from(memoryDistillJobs)
  expect(job!.status).toBe('done')
  expect(await getSessionOffset(db, 's1')).toBe(5)

  // 尾巴：新内容不足阈值，SessionEnd flush -> sweep 放行，第四次调用
  await stop('s1', writeTranscript([...small(4), ...big(), { role: 'user', content: '尾巴消息，有点内容凑字数'.repeat(20) }]))
  await runTick(); expect(llmCalls).toBe(1) // 未放行
  await app.request('/hooks/claude/SessionEnd', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: 's1', cwd: '/proj', reason: 'prompt_input_exit' }),
  })
  await new Promise((r) => setTimeout(r, 30))
  await runTick() // sweep 放行
  await runTick() // pending 被提炼
  expect(llmCalls).toBe(2) // flush 尾巴一次调用（总计第二次）
})
```

注：e2e 的 `enqueueDistillJob` 注入 throw 是有意的——prove 主路径全程走 accumulateCapture（Task 7 helper 内部用 `enqueueWaitingJob`，不经 `deps.enqueueDistillJob`）；若实现中 accumulateCapture 改走 deps 注入 seam，本测试相应调整。

```ts
// tests/degradation-coverage.test.ts
// 降级可见化守卫（spec §5 配套硬约束）：每个降级点必须有 logDegradation 调用。
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'

describe('降级点 logDegradation 覆盖（grep 级守卫）', () => {
  const kinds = [
    'threshold_compute_error', 'capture_persist_failed', 'flush_mark_failed',
    'digest_llm_failed', 'digest_read_failed', 'titles_query_failed',
    'sweep_error', 'digest_truncated',
  ]
  test('spec §5 全部 kind 在 src/ 有落表调用点', () => {
    const files = ['src/server.ts', 'src/scheduler.ts', 'src/memory/store.ts', 'src/memory/rollingSummary.ts']
    const all = files.map((f) => readFileSync(f, 'utf8')).join('\n')
    for (const k of kinds) {
      // 每个 kind 字符串必须出现在 src/ 生产点（logDegradation 调用处）；
      // ui-utils 的人话映射不算生产点，不计入。
      expect(all.includes(`'${k}'`)).toBe(true)
    }
  })
  test('logDegradation 自身失败是唯一 console-only 路径（源码锁注释）', () => {
    const src = readFileSync('src/memory/store.ts', 'utf8')
    expect(src).toContain('logDegradation failed')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/e2e-distill-batching.test.ts tests/degradation-coverage.test.ts`
Expected: e2e 若前序 task 全落地则 PASS；本步以全量回归为准

- [ ] **Step 3: 文档收尾**

`STATE.md` 顶部（最新段落位置）追加：

```markdown
## 蒸馏上下文补全与攒量批处理（2026-08-09）

方案 C 会话级累加 job（spec：`docs/superpowers/specs/2026-08-09-distill-context-and-batching-design.md`）：

1. **累加机制**：一个 (runtime, sessionId) 最多一个 waiting job；capture upsert
   全量快照（events 一 job 一行，顺手消掉已知债务 #1 的重复快照增长）；阈值
   （8000 字符 / 50 turn 护栏）放行，SessionEnd flush + TTL 2h sweep 双兜底，
   低于 1000 字符判 skipped_trivial 不调 LLM。
2. **distiller 上下文**：新切片 + 前文 digest（质量模式滚动 LLM 摘要存
   memory_session_digests / 经济模式确定性截断）+ 已审批标题清单（≤100 条）；
   两节均空时 prompt 与旧行为逐字节一致。
3. **降级可见化**：memory_degradations 审计表 + /api/status recentDegradations
   + 状态栏琥珀横幅（可确认）+ 蒸馏记录 modal 降级明细。任何降级不得静默。

### 上线后观测（硬要求，结论回填本节）

- waiting->放行分布 / skipped_trivial 占比 / 阈值松紧；
- degradations 24h 计数：哪个 kind 高频；
- 滚动摘要质量：质量模式候选与既有记忆重复率变化；
- events 表体积增速变化（对比已知债务 #1 的 92MB 基线）。
```

`README.md`：找「捕获 / 蒸馏」行为说明处加一句（若无合适处则不动）：

```markdown
- 蒸馏触发为会话级攒量：同一 session 的多次 capture 累加一个任务，内容量达阈值
  （或会话结束 / 闲置超 2 小时）才调 LLM 提炼；琐碎内容自动跳过并记入蒸馏记录。
```

- [ ] **Step 4: 全量回归**

Run: `bun run typecheck && bun test`
Expected: 全绿

- [ ] **Step 5: Commit + push**

```bash
git add tests/e2e-distill-batching.test.ts tests/degradation-coverage.test.ts STATE.md README.md
git commit -m "test(e2e): 攒量批处理门禁 + 降级覆盖守卫 + STATE/README 收尾（spec §6.6/§7）"
git push -u origin feat/distill-context-batching
```

---

## 任务依赖图

```
Task 1 (threshold) ──┬──> Task 7 (capture) ──┐
Task 2 (digest)    ──┤                        ├──> Task 10 (e2e+收尾)
Task 3 (schema)    ──> Task 4 (store) ──┬─────┤
Task 5 (rolling)   ──────────┐          │     │
Task 6 (distiller) ──────────┴──> Task 8 (tick 接线) ──┘
Task 4 ──────────────────────> Task 9 (status+UI) ──> Task 10
```

执行顺序建议：1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10（严格按编号，每 task 独立 commit）。

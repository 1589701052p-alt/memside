# 蒸馏解析失败可视化 + subagent 兜底治理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** distill 解析失败从 empty_output 拆出为独立 `parse_error` outcome（原始输出+错误描述落盘、进消息中心折叠、状态栏红条覆盖）；SubagentStop 删除「退回主会话」兜底，缺失时改写带取证现场的 `subagent_transcript_missing` degradation。

**Architecture:** retry 层加纯观测回调 `onAttempt` 透出每 attempt 原始文本/错误 → distiller 新增 `parseError`/`lastRawText` 透出 → scheduler 按真值表分类 outcome 并存 raw_text（新列）→ server/Web 呈现。SubagentStop 侧：`resolveSubagentTranscript` 取代带兜底的 `loadSubagentTranscript`，空 turns 时走 logDegradation（双写通知）。

**Tech Stack:** Bun + Hono + Drizzle + bun:sqlite + React 19；测试一律 `bun test`。

**Spec:** `docs/superpowers/specs/2026-08-15-distill-parse-error-visibility-design.md`

## Global Constraints

- 测试一律 `bun test`（严禁 npm test）；门槛：`bun run typecheck && bun test` 全绿才能 commit/push。本机 PowerShell 5.1 不支持 `&&`，命令链在 Bash 工具里跑。
- 新枚举值逐字对齐 spec §9：outcome `parse_error`；degradation kind `subagent_transcript_missing`；通知 kind/title `'parse_error'`；UI 文案「解析失败」「subagent 记录缺失」「模型原始输出」「（无留存）」。
- `capRawText` 常量：`RAW_TEXT_CAP_CHARS = 24_000`，头 8000 / 尾 16000。
- 任何回调/审计写入失败只 `console.warn`，不得炸主流程（best-effort 契约，与 logDegradation 同模式）。
- 列表端点（`listRecentDistillRuns` / `listDistillRunsPage`）不得带 rawText；只有详情端点 `GET /api/distill-runs/:jobId` 带。
- 历史 empty_output-rawNULL 存量行不回分类（非目标）。

---

### Task 1: retry.ts `onAttempt` 观测回调

**Files:**
- Modify: `src/memory/retry.ts`
- Test: `tests/retry.test.ts`

**Interfaces:**
- Produces（Task 2 依赖）:
  ```ts
  export interface RetryOpts {
    call: LLMCall
    system: string
    user: string
    shouldRetry: (parsed: unknown) => string | null
    maxRetries?: number
    /** 每次未抛错的 attempt 后回调：raw=原始文本，error=parse/校验错误（接受为 null）。
     *  纯观测（distiller 据此判 parse_error 并留存原始输出）。call 抛错的 attempt 不触发。 */
    onAttempt?: (info: { raw: string; error: string | null }) => void
  }
  ```

- [ ] **Step 1: 写失败测试**（追加到 tests/retry.test.ts 尾部）

```ts
test('onAttempt: parse失败/校验失败/通过三触发点 + 抛错不触发 + 回调抛错不影响流程', async () => {
  const { callWithRetry } = await import('@/memory/retry')
  // 三触发点
  const seen: { raw: string; error: string | null }[] = []
  let n = 0
  const call = async () => {
    n++
    if (n === 1) return 'not json at all'
    if (n === 2) return '{"foo":1}'
    return '{"candidates":[]}'
  }
  const r = await callWithRetry({
    call, system: 's', user: 'u',
    shouldRetry: (p) => (p && typeof p === 'object' && Array.isArray((p as any).candidates) ? null : '形状不对'),
    onAttempt: (info) => seen.push(info),
  })
  expect(r).toEqual({ candidates: [] })
  expect(seen.length).toBe(3)
  expect(seen[0].raw).toBe('not json at all')
  expect(seen[0].error).toContain('不是合法 JSON')
  expect(seen[1].raw).toBe('{"foo":1}')
  expect(seen[1].error).toBe('形状不对')
  expect(seen[2].error).toBeNull()

  // 抛错 attempt 不触发
  const seen2: unknown[] = []
  await callWithRetry({
    call: async () => { throw new Error('boom') }, system: 's', user: 'u',
    shouldRetry: () => null, maxRetries: 0,
    onAttempt: (i) => seen2.push(i),
  })
  expect(seen2.length).toBe(0)

  // 回调抛错不影响返回
  const r3 = await callWithRetry({
    call: async () => '{"candidates":[]}', system: 's', user: 'u',
    shouldRetry: () => null,
    onAttempt: () => { throw new Error('observer exploded') },
  })
  expect(r3).toEqual({ candidates: [] })
})
```

- [ ] **Step 2: 跑测试确认红**

Run: `bun test tests/retry.test.ts`
Expected: FAIL（onAttempt 未实现，seen 为空）

- [ ] **Step 3: 实现**（src/memory/retry.ts）

RetryOpts 加上方接口注释的 `onAttempt` 字段；函数体加私有助手并在三个位置触发：

```ts
function fireAttempt(opts: RetryOpts, raw: string, error: string | null): void {
  if (!opts.onAttempt) return
  try { opts.onAttempt({ raw, error }) } catch (e) { console.warn('memside: retry onAttempt callback failed', e) }
}
```

- JSON.parse catch 块内（组成 `error` 字符串后、`continue` 前）：`fireAttempt(opts, raw, error)`
- `retryError !== null` 分支（拼 currentUser 前）：`fireAttempt(opts, raw, retryError)`
- `retryError === null` 接受路径（`return parsed` 前）：`fireAttempt(opts, raw, null)`

call 抛错路径不触发。既有返回语义一字不动。

- [ ] **Step 4: 跑测试确认绿 + 全量**

Run: `bun test tests/retry.test.ts && bun run typecheck`（在 Bash 工具）
Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add src/memory/retry.ts tests/retry.test.ts
git commit -m "feat(retry): onAttempt 观测回调透出每 attempt 原始文本/错误（spec 2026-08-15 §5.1）"
```

---

### Task 2: distiller `parseError`/`lastRawText` 透出

**Files:**
- Modify: `src/memory/distiller.ts`（DistillResult 接口约 115-127 行；distillTranscript 约 190-273 行）
- Test: `tests/distiller.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `RetryOpts.onAttempt`
- Produces（Task 5 依赖）：`DistillResult` 新增两字段——
  ```ts
  /** 解析失败描述（末次 attempt 的 parse/校验错误）。仅「调用未抛错但重试耗尽未获合法结构」时非 null。 */
  parseError: string | null
  /** 末次未抛错 attempt 的原始输出文本。仅解析失败路径非 null（供 raw_text 落盘）。 */
  lastRawText: string | null
  ```

- [ ] **Step 1: 写失败测试**（追加到 tests/distiller.test.ts；mock callLLM 的既有模式参照文件内其他用例）

```ts
test('parseError: 三次返回非 JSON -> parseError 非空 + lastRawText=末次文本 + callThrew=false', async () => {
  const raws = ['garbage-1', 'garbage-2', 'garbage-3']
  let n = 0
  const res = await distillTranscript({
    turns: [{ role: 'user', content: '记住：部署前必须跑 bun test' }],
    runtime: 'claude-code', cwd: '/r',
    callLLM: async () => raws[Math.min(n++, 2)],
    existingSlugs: [],
  })
  expect(res.candidates).toEqual([])
  expect(res.callThrew).toBe(false)
  expect(res.parseError).toContain('不是合法 JSON')
  expect(res.lastRawText).toBe('garbage-3')
})

test('parseError: 合法 JSON 但 candidates 非数组且重试耗尽 -> parseError=校验错误', async () => {
  const res = await distillTranscript({
    turns: [{ role: 'user', content: 'x'.repeat(50) }],
    runtime: 'claude-code', cwd: '/r',
    callLLM: async () => '{"foo":1}',
    existingSlugs: [],
  })
  expect(res.candidates).toEqual([])
  expect(res.callThrew).toBe(false)
  expect(res.parseError).not.toBeNull()
  expect(res.lastRawText).toBe('{"foo":1}')
})

test('parseError 回归锁: attempt0 垃圾 + attempt1 合法 -> parseError=null（错误被成功覆盖）', async () => {
  let n = 0
  const res = await distillTranscript({
    turns: [{ role: 'user', content: '记住：部署前必须跑 bun test' }],
    runtime: 'claude-code', cwd: '/r',
    callLLM: async () => (++n === 1
      ? 'garbage'
      : '{"candidates":[{"title":"[category:convention] 部署前必须跑 bun test","bodyMd":"用户明确陈述","scope":"project"}]}'),
    existingSlugs: [],
  })
  expect(res.candidates.length).toBe(1)
  expect(res.parseError).toBeNull()
  expect(res.lastRawText).toBeNull()
})

test('parseError 回归锁: 合法 {\"candidates\":[]} 真空 -> parseError=null；全抛错 -> llm_error 路径 parseError=null', async () => {
  const empty = await distillTranscript({
    turns: [{ role: 'user', content: '今天天气不错' }], runtime: 'claude-code', cwd: '/r',
    callLLM: async () => '{"candidates":[]}', existingSlugs: [],
  })
  expect(empty.candidates).toEqual([])
  expect(empty.parseError).toBeNull()

  const threw = await distillTranscript({
    turns: [{ role: 'user', content: '记住：部署前必须跑 bun test' }], runtime: 'claude-code', cwd: '/r',
    callLLM: async () => { throw new Error('Connection error.') }, existingSlugs: [],
  })
  expect(threw.callThrew).toBe(true)
  expect(threw.parseError).toBeNull()
  expect(threw.lastRawText).toBeNull()
})
```

- [ ] **Step 2: 跑测试确认红**

Run: `bun test tests/distiller.test.ts`
Expected: FAIL（DistillResult 无 parseError 字段）

- [ ] **Step 3: 实现**

`DistillResult` 接口加 `parseError` / `lastRawText` 两字段（注释用 Produces 块里的逐字文案）。

`distillTranscript` 内：
1. `let callThrew = false` 声明旁加：
   ```ts
   let lastAttemptRaw: string | null = null
   let lastAttemptError: string | null = null
   ```
2. `callWithRetry({...})` 调用加：
   ```ts
   onAttempt: ({ raw, error }) => { lastAttemptRaw = raw; lastAttemptError = error },
   ```
3. 早退分支（`if (!parsed || !Array.isArray(parsed.candidates))`）返回值改为：
   ```ts
   return { candidates: [], filteredTurns: filtered, rawOutput, rawCount: 0, callThrew,
     errorMessage: callThrew ? lastErrorMessage : null,
     // 未抛错却拿不到合法结构 = 解析失败（spec 2026-08-15 §4）。callThrew 与 parseError
     // 互斥：末次 attempt 非抛即报。防御兜底 '解析失败：无错误描述' 理论不可达。
     parseError: callThrew ? null : (lastAttemptError ?? '解析失败：无错误描述'),
     lastRawText: callThrew ? null : lastAttemptRaw }
   ```
4. 成功路径（`return { candidates: out, ... }`）加 `parseError: null, lastRawText: null`。
5. 顶层 catch 返回值加 `parseError: null, lastRawText: null`。

- [ ] **Step 4: 跑测试确认绿 + 全量 typecheck**

Run: `bun test tests/distiller.test.ts && bun run typecheck`
Expected: 全绿（注意：scheduler.ts 解构 DistillResult 不需改，TS 结构化类型不受影响）

- [ ] **Step 5: Commit**

```bash
git add src/memory/distiller.ts tests/distiller.test.ts
git commit -m "feat(distiller): DistillResult 透出 parseError/lastRawText——解析失败不再假扮空产出（spec 2026-08-15 §4）"
```

---

### Task 3: pure.ts `capRawText` 截断纯函数

**Files:**
- Modify: `src/memory/pure.ts`（文件尾部追加新节）
- Test: `tests/pure-raw-cap.test.ts`（新建）

**Interfaces:**
- Produces（Task 5 依赖）:
  ```ts
  export const RAW_TEXT_CAP_CHARS = 24_000
  export function capRawText(raw: string | null): string | null
  ```

- [ ] **Step 1: 写失败测试**（新建 tests/pure-raw-cap.test.ts）

```ts
import { test, expect } from 'bun:test'
import { capRawText, RAW_TEXT_CAP_CHARS } from '@/memory/pure'

test('capRawText: null/空串 -> null；不超 cap 原样', () => {
  expect(capRawText(null)).toBeNull()
  expect(capRawText('')).toBeNull()
  const s = 'x'.repeat(1000)
  expect(capRawText(s)).toBe(s)
})

test('capRawText: 超 cap -> 头 8000 + 标记 + 尾 16000', () => {
  const raw = 'H'.repeat(10_000) + 'M'.repeat(10_000) + 'T'.repeat(10_000)
  const out = capRawText(raw)!
  expect(out.startsWith('H'.repeat(8000))).toBe(true)
  expect(out.endsWith('T'.repeat(16_000))).toBe(true)
  expect(out).toContain('…[截断 6000 字]…')
  expect(out.length).toBe(8000 + `\n…[截断 6000 字]…\n`.length + 16_000)
})
```

- [ ] **Step 2: 跑测试确认红**

Run: `bun test tests/pure-raw-cap.test.ts`
Expected: FAIL（capRawText 不存在）

- [ ] **Step 3: 实现**（src/memory/pure.ts 尾部追加）

```ts
// ---------------------------------------------------------------------------
// parse_error 原始输出截断（spec 2026-08-15 §5.6）。尾部权重更大：
// max_tokens 截断的断口在尾部；头部保留以识别围栏/散文。
// ---------------------------------------------------------------------------

export const RAW_TEXT_CAP_CHARS = 24_000
const RAW_TEXT_HEAD_CHARS = 8_000

/** null/空串 -> null；<= cap 原样；超 cap 保留头 8000 + 尾 16000 并标记省略字数。 */
export function capRawText(raw: string | null): string | null {
  if (!raw) return null
  if (raw.length <= RAW_TEXT_CAP_CHARS) return raw
  const head = raw.slice(0, RAW_TEXT_HEAD_CHARS)
  const tail = raw.slice(-(RAW_TEXT_CAP_CHARS - RAW_TEXT_HEAD_CHARS))
  const omitted = raw.length - RAW_TEXT_CAP_CHARS
  return `${head}\n…[截断 ${omitted} 字]…\n${tail}`
}
```

- [ ] **Step 4: 跑测试确认绿**

Run: `bun test tests/pure-raw-cap.test.ts && bun run typecheck`
Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add src/memory/pure.ts tests/pure-raw-cap.test.ts
git commit -m "feat(pure): capRawText——parse_error 原始输出头尾截断纯函数（spec 2026-08-15 §5.6）"
```

---

### Task 4: store + schema + 迁移 + parse_error 通知

**Files:**
- Modify: `src/db/schema.ts`（memoryDistillRuns 表定义，约 131-150 行）
- Modify: `src/db/client.ts`（迁移区，digest_ms 块之后，约 298-306 行后）
- Modify: `src/memory/store.ts`（588 / 590-603 / 605-621 / 623-644 / 646-658 / 1181 / 1203-1245）
- Test: `tests/schema.test.ts`、`tests/store-crud.test.ts`、`tests/store-notifications.test.ts`

**Interfaces:**
- Consumes: 无（纯存储层）
- Produces（Task 5/7/9 依赖）:
  ```ts
  export type DistillOutcome = 'skipped_no_new_turns' | 'skipped_trivial' | 'empty_output' | 'llm_error' | 'parse_error' | 'produced'
  // DistillRunRecord 加: rawText?: string | null
  // DistillRunRow 加:    rawText: string | null
  export const NOTIFICATION_KINDS = ['degradation', 'llm_error', 'parse_error'] as const
  export type NotificationKind = typeof NOTIFICATION_KINDS[number]
  /** scheduler parse_error 路径专用：自身吞错只 warn，不炸蒸馏。 */
  export async function logParseErrorNotification(db: DbClient, input: { jobId: string; message: string }): Promise<void>
  ```

- [ ] **Step 1: 写失败测试**

tests/schema.test.ts 加列存在性断言（参照文件内 error_message/digest_ms 既有模式）：

```ts
test('memory_distill_runs has raw_text column (spec 2026-08-15 §5.4)', () => {
  const db = openDb(':memory:')  // 按文件内既有 helper 名称
  const cols = db.$client.prepare('PRAGMA table_info(memory_distill_runs)').all() as { name: string }[]
  expect(cols.some((c) => c.name === 'raw_text')).toBe(true)
})
```

tests/store-crud.test.ts 加往返 + 迁移幂等：

```ts
test('saveDistillRun/getDistillRun: rawText 往返；非 parse_error 为 null；listRecentDistillRuns 不带 rawText', async () => {
  // 参照文件内既有 saveDistillRun 用例的 seed 模式（先建 job 行）
  await saveDistillRun(db, jobId, {
    outcome: 'parse_error', rawOutput: null, rawCount: 0, acceptedCount: 0,
    dedupedCount: 0, filteredCount: 0, storedCount: 0, discardedCount: 0,
    durationMs: 100, errorMessage: '不是合法 JSON：...', rawText: 'garbage-output',
  })
  const row = await getDistillRun(db, jobId)
  expect(row!.outcome).toBe('parse_error')
  expect(row!.rawText).toBe('garbage-output')
  const list = await listRecentDistillRuns(db, {})
  expect('rawText' in list[0]).toBe(false)
})

test('raw_text 迁移幂等：缺列老库 openDb 两次不炸（spec 2026-08-15 §5.4）', async () => {
  // 参照 tests/client-backfill-subagent.test.ts 的手法：手工建无 raw_text 的老表 -> openDb 包一层 -> 再 openDb 一次
})
```

tests/store-notifications.test.ts 加折叠断言：

```ts
test('insertNotification: parse_error 按 body 折叠（同 llm_error 语义），已读不折叠', async () => {
  const id1 = await insertNotification(db, { kind: 'parse_error', title: 'parse_error', body: 'Unexpected token' })
  const id2 = await insertNotification(db, { kind: 'parse_error', title: 'parse_error', body: 'Unexpected token' })
  expect(id2).toBe(id1)  // 折叠返回原 id
  const id3 = await insertNotification(db, { kind: 'parse_error', title: 'parse_error', body: 'different error' })
  expect(id3).not.toBe(id1)
})

test('logParseErrorNotification: 落库 kind=parse_error + refId=jobId', async () => {
  await logParseErrorNotification(db, { jobId: 'J1', message: '不是合法 JSON：…' })
  const page = await listNotificationsPage(db, { kind: 'parse_error' })
  expect(page.items.length).toBe(1)
  expect(page.items[0].kind).toBe('parse_error')
  expect(page.items[0].refId).toBe('J1')
})
```

- [ ] **Step 2: 跑测试确认红**

Run: `bun test tests/schema.test.ts tests/store-crud.test.ts tests/store-notifications.test.ts`
Expected: FAIL（列不存在 / 函数不存在）

- [ ] **Step 3: 实现**

1. `src/db/schema.ts` memoryDistillRuns 加（放 errorMessage 行后）：
   ```ts
   rawText: text('raw_text'),   // 新增：nullable；parse_error 时存模型原始输出（capRawText 截断），其余 null
   ```
2. `src/db/client.ts` digest_ms 迁移块后加：
   ```ts
   // Idempotent migration: add raw_text to pre-existing memory_distill_runs.
   // parse_error 时存模型原始输出截断（spec 2026-08-15 §5.4）。无 backfill（老行 NULL）。
   {
     const cols = raw.prepare('PRAGMA table_info(memory_distill_runs)').all() as { name: string }[]
     if (!cols.some((c) => c.name === 'raw_text')) {
       raw.exec('ALTER TABLE memory_distill_runs ADD COLUMN raw_text TEXT')
     }
   }
   ```
3. `src/memory/store.ts`：
   - `DistillOutcome` 联合类型加 `'parse_error'`（放 `'llm_error'` 后）。
   - `DistillRunRecord` 加 `rawText?: string | null`；`DistillRunRow` 加 `rawText: string | null`。
   - `saveDistillRun`：`values({...})` 与 `onConflictDoUpdate.set` 各加 `rawText: record.rawText ?? null`。
   - `rowToRun`：返回对象加 `rawText: r.rawText ?? null`。
   - `NOTIFICATION_KINDS` 加 `'parse_error'`。
   - `insertNotification` 折叠分支：`input.kind === 'llm_error'` 改为 `(input.kind === 'llm_error' || input.kind === 'parse_error')`，且该分支内 `eq(notifications.kind, 'llm_error')` 改为 `eq(notifications.kind, input.kind)`。
   - 新增（紧跟 logLlmErrorNotification 后）：
     ```ts
     /** scheduler parse_error 路径专用（spec 2026-08-15 §5.4）：自身吞错只 warn，不炸蒸馏。 */
     export async function logParseErrorNotification(db: DbClient, input: { jobId: string; message: string }): Promise<void> {
       try {
         await insertNotification(db, { kind: 'parse_error', title: 'parse_error', body: input.message, refType: 'distill_job', refId: input.jobId })
       } catch (e) { console.warn('memside: parse_error notification insert failed', e) }
     }
     ```

- [ ] **Step 4: 跑测试确认绿 + 全量**

Run: `bun test tests/schema.test.ts tests/store-crud.test.ts tests/store-notifications.test.ts && bun run typecheck`
Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts src/db/client.ts src/memory/store.ts tests/schema.test.ts tests/store-crud.test.ts tests/store-notifications.test.ts
git commit -m "feat(store): raw_text 列 + parse_error outcome/通知 kind + 按 body 折叠（spec 2026-08-15 §5.4）"
```

---

### Task 5: scheduler tick outcome 分类与接线

**Files:**
- Modify: `src/scheduler.ts`（解构约 332 行；outcome 约 432 行；saveDistillRun 约 434-453；last_error 块约 458-464）
- Test: `tests/scheduler.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `DistillResult.parseError/lastRawText`；Task 3 的 `capRawText`；Task 4 的 `logParseErrorNotification`、`DistillRunRecord.rawText`
- Produces: 无新接口（行为变更）

- [ ] **Step 1: 写失败测试**（追加 tests/scheduler.test.ts；seed/驱动 tick 的模式参照文件内既有 llm_error 用例）

```ts
test('tick: 调用未抛错但三次解析全败 -> outcome=parse_error + rawText 落盘 + last_error 回写 + parse_error 通知', async () => {
  // 参照文件内既有 tick 测试 seed 一个 pending job（turns 非空、过阈值），
  // mock callLLM 返回 'total garbage not json'
  // tick 后断言：
  // 1. memory_distill_runs 行 outcome === 'parse_error'
  // 2. 该行 errorMessage 含 '不是合法 JSON'，rawText === 'total garbage not json'
  // 3. memory_distill_jobs.last_error 非空
  // 4. notifications 表有 kind='parse_error' 且 refId=jobId 的行
})

test('tick: 合法 {"candidates":[]} -> outcome=empty_output 且 rawText 为 null（真空回归锁）', async () => {
  // mock callLLM 返回 '{"candidates":[]}'
  // 断言 outcome === 'empty_output'，rawText/errorMessage 为 null，无 parse_error 通知
})

test('tick: capRawText 接线——超长垃圾输出落盘时已截断（头8000+尾16000）', async () => {
  // mock callLLM 返回 'x'.repeat(30000)（非 JSON）
  // 断言 runs.rawText 长度 < 25000 且含 '…[截断 6000 字]…'
})
```

- [ ] **Step 2: 跑测试确认红**

Run: `bun test tests/scheduler.test.ts`
Expected: FAIL（outcome 分类无 parse_error 分支）

- [ ] **Step 3: 实现**（src/scheduler.ts）

1. import 行加 `logParseErrorNotification`（既有 `@/memory/store` import 列表内）与 `capRawText`（`@/memory/pure`）。
2. 解构行（约 332）：
   ```ts
   const { candidates, filteredTurns, rawOutput, rawCount, callThrew, errorMessage, parseError, lastRawText } = distillOut
   ```
3. outcome 分类（约 432）：
   ```ts
   // spec 2026-08-15 §4 真值表：candidates 优先；callThrew -> llm_error；
   // 未抛错但解析耗尽 -> parse_error；合法空 -> empty_output。
   const outcome = candidates.length === 0
     ? (callThrew ? 'llm_error' : parseError ? 'parse_error' : 'empty_output')
     : 'produced'
   const runErrorMessage = outcome === 'llm_error' ? errorMessage
     : outcome === 'parse_error' ? parseError : null
   ```
4. saveDistillRun 调用：`durationMs, errorMessage` 改为 `durationMs, errorMessage: runErrorMessage`，并加 `rawText: outcome === 'parse_error' ? capRawText(lastRawText) : null`。
5. last_error + 通知块（约 458）改为：
   ```ts
   // llm_error / parse_error 都把错误写进 job.last_error 并发通知（spec 2026-08-15 §5.5）。
   // best-effort：失败只 warn，不阻塞 done。
   if ((outcome === 'llm_error' || outcome === 'parse_error') && runErrorMessage) {
     try {
       await db.update(memoryDistillJobs).set({ lastError: runErrorMessage })
         .where(eq(memoryDistillJobs.id, job.id)).run()
       if (outcome === 'parse_error') {
         await logParseErrorNotification(db, { jobId: job.id, message: runErrorMessage })
       } else {
         await logLlmErrorNotification(db, { jobId: job.id, message: runErrorMessage })
       }
     } catch (e) { console.warn('memside: set lastError failed', e) }
   }
   ```

- [ ] **Step 4: 跑测试确认绿 + 全量**

Run: `bun test tests/scheduler.test.ts && bun run typecheck && bun test`
Expected: 全绿（全量防 tick 回归）

- [ ] **Step 5: Commit**

```bash
git add src/scheduler.ts tests/scheduler.test.ts
git commit -m "feat(scheduler): outcome 真值表加 parse_error——raw_text 落盘 + last_error 回写 + 通知（spec 2026-08-15 §5.5）"
```

---

### Task 6: transcript.ts `resolveSubagentTranscript`（带取证，不兜底）

**Files:**
- Modify: `src/claude/transcript.ts`（尾部追加新函数；`loadSubagentTranscript` **本任务保留不删**，Task 7 切换后删除）
- Test: `tests/transcript.test.ts`（尾部追加新 describe；旧 loadSubagentTranscript 用例本任务不动）

**Interfaces:**
- Produces（Task 7 依赖）:
  ```ts
  export interface SubagentResolveDiag {
    agentId: string
    transcriptPath: string
    derivedPath: string | null
    derivedExists: boolean
    derivedTurns: number
    mainTranscriptExists: boolean
    subagentsDirEntries: string[]
  }
  export function resolveSubagentTranscript(
    transcriptPath: string, agentId: string | null | undefined,
  ): { turns: TranscriptTurn[]; diag: SubagentResolveDiag }
  ```

- [ ] **Step 1: 写失败测试**（追加 tests/transcript.test.ts；tmp 目录夹具模式参照既有 loadSubagentTranscript 用例）

```ts
// --- resolveSubagentTranscript (spec 2026-08-15 §5.2)：不兜底主会话，带取证 diag ---
test('resolveSubagentTranscript: 文件存在 -> turns + diag 全字段', () => {
  // 夹具：main.jsonl + main/subagents/agent-AG.jsonl（内容同既有用例）
  const { turns, diag } = resolveSubagentTranscript(mainPath, 'AG')
  expect(turns.length).toBeGreaterThan(0)
  expect(diag.derivedExists).toBe(true)
  expect(diag.derivedTurns).toBe(turns.length)
  expect(diag.mainTranscriptExists).toBe(true)
  expect(diag.subagentsDirEntries).toContain('agent-AG.jsonl')
  expect(diag.derivedPath).toContain('agent-AG.jsonl')
})

test('resolveSubagentTranscript: 文件缺失 -> 空 turns，不读主会话（行为锁）', () => {
  // 夹具同上但无 agent-NOPE.jsonl；主会话文件有内容
  const { turns, diag } = resolveSubagentTranscript(mainPath, 'NOPE')
  expect(turns).toEqual([])          // 旧行为会退回主会话返回非空——此断言锁死新行为
  expect(diag.derivedExists).toBe(false)
  expect(diag.derivedTurns).toBe(0)
  expect(diag.mainTranscriptExists).toBe(true)   // 主文件存在也不读
  expect(diag.subagentsDirEntries).toContain('agent-AG.jsonl')  // 目录现场仍取证
})

test('resolveSubagentTranscript: 畸形输入永不抛 + 目录不存在时 listing 为 []', () => {
  expect(resolveSubagentTranscript('', 'AG').turns).toEqual([])
  expect(resolveSubagentTranscript(join(dir, 'nope.jsonl'), 'AG').diag.subagentsDirEntries).toEqual([])
  expect(resolveSubagentTranscript(join(dir, 'x.jsonl'), '').diag.derivedPath).toBeNull()
})
```

- [ ] **Step 2: 跑测试确认红**

Run: `bun test tests/transcript.test.ts`
Expected: FAIL（resolveSubagentTranscript 未导出）

- [ ] **Step 3: 实现**（src/claude/transcript.ts 尾部追加；确认顶部 `node:fs` import 含 `readdirSync`，没有则加）

```ts
/**
 * 解析 subagent 自有 transcript（spec 2026-08-15 §5.2）：不再有「退回主会话」兜底——
 * 主会话内容由其自有累加 job 蒸馏，兜底既重复又会把 origin 强制降级。
 * 文件缺失/为空一律空 turns + 取证 diag（供 subagent_transcript_missing degradation）。
 * 永不抛（collector 热路径契约同 parseTranscriptFile）。
 */
export interface SubagentResolveDiag {
  agentId: string
  transcriptPath: string
  /** subagentFilePathFromPayload 推导结果；推不出为 null */
  derivedPath: string | null
  /** derivedPath 存在且为文件 */
  derivedExists: boolean
  /** 文件解析出的 turn 数（0 = 缺失或空/无有效 turn） */
  derivedTurns: number
  /** transcript_path 指向的主会话文件是否存在（不读内容） */
  mainTranscriptExists: boolean
  /** <base>/subagents/ 目录当时真实 basename（cap 30）；目录不存在/不可读为 [] */
  subagentsDirEntries: string[]
}

export function resolveSubagentTranscript(
  transcriptPath: string,
  agentId: string | null | undefined,
): { turns: TranscriptTurn[]; diag: SubagentResolveDiag } {
  const diag: SubagentResolveDiag = {
    agentId: agentId ?? '', transcriptPath,
    derivedPath: null, derivedExists: false, derivedTurns: 0,
    mainTranscriptExists: false, subagentsDirEntries: [],
  }
  try {
    diag.mainTranscriptExists = !!transcriptPath && existsSync(transcriptPath)
    const subPath = subagentFilePathFromPayload(transcriptPath, agentId)
    diag.derivedPath = subPath
    // 目录现场清单（抓「文件为什么不存在」的现行：命名漂移/目录缺失一目了然）
    if (transcriptPath.endsWith('.jsonl')) {
      const sep = transcriptPath.includes('\\') && !transcriptPath.includes('/') ? '\\' : '/'
      const dir = `${transcriptPath.slice(0, -'.jsonl'.length)}${sep}subagents`
      try {
        if (existsSync(dir)) diag.subagentsDirEntries = readdirSync(dir).slice(0, 30)
      } catch { /* 目录不可读保持 [] */ }
    }
    if (subPath && existsSync(subPath)) {
      diag.derivedExists = true
      const turns = parseTranscriptFile(subPath)
      diag.derivedTurns = turns.length
      return { turns, diag }
    }
    return { turns: [], diag }
  } catch {
    return { turns: [], diag }
  }
}
```

- [ ] **Step 4: 跑测试确认绿 + 全量**

Run: `bun test tests/transcript.test.ts && bun run typecheck`
Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add src/claude/transcript.ts tests/transcript.test.ts
git commit -m "feat(transcript): resolveSubagentTranscript——不兜底主会话 + 取证 diag（spec 2026-08-15 §5.2）"
```

---

### Task 7: server.ts SubagentStop 删兜底 + 取证 degradation

**Files:**
- Modify: `src/server.ts`（SubagentStop 分支约 262-293 行；store import 行）
- Modify: `src/claude/transcript.ts`（删除 `loadSubagentTranscript`，约 200-226 行）
- Test: `tests/server.test.ts`（SubagentStop 用例约 162-220 行重写）、`tests/transcript.test.ts`（旧 loadSubagentTranscript 用例约 269-298 行删除）

**Interfaces:**
- Consumes: Task 6 的 `resolveSubagentTranscript` / `SubagentResolveDiag`；既有 `logDegradation(db, { kind, detail?, distillJobId?, sessionId? })`
- Produces: degradation kind `subagent_transcript_missing`；detail JSON = diag 全字段 + `payloadKeys: string[]`

- [ ] **Step 1: 重写失败测试**

tests/transcript.test.ts：删除旧 `loadSubagentTranscript` 三个用例（269-298 附近）与 import 中的该符号。

tests/server.test.ts SubagentStop 区重写：

```ts
test('collector SubagentStop: subagent 文件命中 -> 入队 + 存 event + broadcast（旧行为守卫）', async () => {
  // 保留既有「agent_id path hit」夹具（tmp 目录 main.jsonl + main/subagents/agent-AG.jsonl）
  // POST /hooks/claude/SubagentStop { agent_id: 'AG', transcript_path: mainPath, sourceEventId: 'e3' }
  // 断言：202；enqueueDistillJob 被调且 sourceAgentId='AG'；events 表有该 job 的行；无 degradation 行
})

test('collector SubagentStop: 文件缺失 -> 不入队 + subagent_transcript_missing degradation（含取证）+ 通知双写', async () => {
  // 夹具只有 main.jsonl（无 subagents 目录或无该 agent 文件）
  // POST /hooks/claude/SubagentStop { agent_id: 'NOPE', transcript_path: mainPath, session_id: 's1' }
  // 断言：202；enqueueDistillJob 未被调；memory_degradations 有 kind='subagent_transcript_missing'
  //   且 sessionId='s1'，detail JSON 含 agentId='NOPE'、derivedExists=false、payloadKeys 数组；
  //   notifications 表新增 kind='degradation'、title='subagent_transcript_missing' 的行
})

test('collector SubagentStop: payload 缺 agent_id -> 同样走 degradation（不再只 console.warn）', async () => {
  // POST 不带 agent_id
  // 断言：202；degradation 行 detail 的 agentId=''、derivedPath=null
})
```

- [ ] **Step 2: 跑测试确认红**

Run: `bun test tests/server.test.ts tests/transcript.test.ts`
Expected: FAIL（旧用例仍在断言兜底行为 / 新行为未实现）

- [ ] **Step 3: 实现**

1. `src/server.ts`：import 把 `loadSubagentTranscript` 换成 `resolveSubagentTranscript`；store import 加 `logDegradation`（若无）。SubagentStop 分支替换为：

```ts
    // SubagentStop（spec 2026-08-15 §5.3）：只蒸馏 subagent 自有 transcript；
    // 文件缺失/为空不再退回主会话（主会话内容由其自有累加 job 负责，兜底既重复
    // 又把 origin 强制降级），改写 subagent_transcript_missing degradation 带取证现场。
    if (event === 'SubagentStop') {
      const agentId: string = body.agent_id ?? ''
      const transcriptPath: string = body.transcript_path ?? ''
      const sourceEventId: string = body.sourceEventId ?? `${event}-${Date.now()}`
      const debounceKey = `${cwd}:${event}`
      void (async () => {
        try {
          const { turns, diag } = resolveSubagentTranscript(transcriptPath, agentId)
          if (turns.length > 0) {
            const { jobId } = await deps.enqueueDistillJob(deps.db, {
              sourceEventId, runtime: 'claude-code', cwd, debounceKey, sourceAgentId: agentId || null,
            })
            await deps.db.insert(memoryDistillEvents).values({
              distillJobId: jobId, attemptIndex: 0, ts: Date.now(),
              kind: 'conversation', payload: JSON.stringify(turns),
            })
          } else {
            const detail = JSON.stringify({ ...diag, payloadKeys: Object.keys(body) })
            await logDegradation(deps.db, {
              kind: 'subagent_transcript_missing', detail,
              sessionId: body.session_id ?? undefined,
            })
            console.warn('memside: subagent transcript missing, distill skipped', detail)
          }
        } catch (e) {
          deps.broadcast({ type: 'memory.enqueue.failed', sourceEventId, error: String(e) })
        }
      })()
      deps.broadcast({ type: 'memory.capture', sourceEventId })
      return c.json({ ok: true }, 202)
    }
```

2. `src/claude/transcript.ts`：删除 `loadSubagentTranscript` 函数及其 docstring。

- [ ] **Step 4: 跑测试确认绿 + 全量**

Run: `bun test tests/server.test.ts tests/transcript.test.ts && bun run typecheck && bun test`
Expected: 全绿（全量防 collector 回归）

- [ ] **Step 5: Commit**

```bash
git add src/server.ts src/claude/transcript.ts tests/server.test.ts tests/transcript.test.ts
git commit -m "fix(server): SubagentStop 删除主会话兜底——缺失时写 subagent_transcript_missing 取证 degradation（spec 2026-08-15 §5.3）"
```

---

### Task 8: server.ts status/通知过滤覆盖 parse_error

**Files:**
- Modify: `src/server.ts`（/api/status 约 463-466 与 492；通知 kind 过滤约 563-571）
- Test: `tests/server.test.ts`（status 用例约 744-774 扩展）、`tests/server-notifications.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `NOTIFICATION_KINDS`（含 parse_error）
- Produces: `/api/status` 的 `unreadLlmErrors`/`latestUnreadLlmError` 语义扩为「覆盖 llm_error + parse_error」（字段名不变）

- [ ] **Step 1: 写失败测试**

tests/server.test.ts（参照 744 行附近既有「按类未读计数」用例的 seed 模式）：

```ts
test('GET /api/status: unreadLlmErrors 覆盖 parse_error；latestUnreadLlmError 取两类中最新', async () => {
  // seed：insertNotification llm_error body='Connection error.' ts 较早 + parse_error body='不是合法 JSON：x' ts 较新
  const r = await app.request('/api/status')
  const body = await r.json()
  expect(body.unreadLlmErrors).toBe(2)
  expect(body.latestUnreadLlmError.body).toBe('不是合法 JSON：x')
})
```

tests/server-notifications.test.ts：

```ts
test('GET /api/notifications?kind=parse_error 合法且只回 parse_error；kind=foo 仍 400', async () => {
  // seed 一条 parse_error + 一条 llm_error
  const ok = await app.request('/api/notifications?kind=parse_error')
  expect(ok.status).toBe(200)
  const data = await ok.json()
  expect(data.items.every((n: any) => n.kind === 'parse_error')).toBe(true)
  const bad = await app.request('/api/notifications?kind=foo')
  expect(bad.status).toBe(400)
})
```

- [ ] **Step 2: 跑测试确认红**

Run: `bun test tests/server.test.ts tests/server-notifications.test.ts`
Expected: FAIL（parse_error 不计入/400）

- [ ] **Step 3: 实现**（src/server.ts）

1. latestErrRows 查询（约 463-466）：`eq(notifications.kind, 'llm_error')` 改为 `inArray(notifications.kind, ['llm_error', 'parse_error'])`（确认顶部 drizzle import 含 `inArray`，没有则加）。
2. `unreadLlmErrors: unreadByKind['llm_error'] ?? 0`（约 492）改为：
   ```ts
   unreadLlmErrors: (unreadByKind['llm_error'] ?? 0) + (unreadByKind['parse_error'] ?? 0),
   ```
   并在附近注释更新语义：「覆盖 llm_error + parse_error（spec 2026-08-15 §5.7），字段名不变」。
3. 通知 kind 过滤（约 565-567）：合法值加 `'parse_error'`（局部类型与校验数组同步）。

- [ ] **Step 4: 跑测试确认绿 + 全量**

Run: `bun test tests/server.test.ts tests/server-notifications.test.ts && bun run typecheck`
Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add src/server.ts tests/server.test.ts tests/server-notifications.test.ts
git commit -m "feat(server): status 未读计数/最新报错与通知过滤覆盖 parse_error（spec 2026-08-15 §5.7）"
```

---

### Task 9: Web UI 呈现（徽标 / 消息中心 / modal 原始输出）

**Files:**
- Modify: `src/web/api.ts`（DistillOutcome 约 230 行；DistillRunDetail 约 252-254；通知 kind 联合约 369 行）
- Modify: `src/web/ui-utils.ts`（DistillOutcome 约 48；formatOutcome 约 58-66；degradationKindLabel 约 69-81；notificationTitle 约 303-308）
- Modify: `src/web/App.tsx`（消息筛选下拉约 602-605；chip 标签约 643；DistillRunModal 产出区约 1529-1545）
- Test: `tests/web-ui-utils.test.ts`（formatOutcome/notificationTitle/degradationKindLabel）、`tests/web-ui.test.ts`（App.tsx 源码断言）

**Interfaces:**
- Consumes: Task 4 的通知 kind；Task 8 的 status 语义。`DistillRunDetail` 加 `rawText?: string | null`（详情端点直通 getDistillRun 自动带出）
- Produces: 无（UI 终端）

- [ ] **Step 1: 写失败测试**

tests/web-ui-utils.test.ts：

```ts
test('formatOutcome: parse_error -> 解析失败红徽标', () => {
  expect(formatOutcome('parse_error')).toEqual({ label: '解析失败', color: '#c00' })
})

test('notificationTitle: parse_error -> 解析失败；degradationKindLabel 新映射', () => {
  expect(notificationTitle({ kind: 'parse_error', title: 'parse_error' })).toBe('解析失败')
  expect(degradationKindLabel('subagent_transcript_missing')).toBe('subagent 记录缺失')
})
```

tests/web-ui.test.ts（源码层文本断言，参照文件内既有模式）：

```ts
test('App.tsx: 消息中心含 parse_error 筛选项与三分支 chip；modal 含「模型原始输出」区', () => {
  const src = readFileSync('src/web/App.tsx', 'utf8')  // 按文件内既有读取方式
  expect(src).toContain('<option value="parse_error">解析失败</option>')
  expect(src).toContain("n.kind === 'parse_error' ? '解析失败'")
  expect(src).toContain('模型原始输出')
  expect(src).toContain('（无留存）')
})
```

- [ ] **Step 2: 跑测试确认红**

Run: `bun test tests/web-ui-utils.test.ts tests/web-ui.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

1. `src/web/api.ts`：`DistillOutcome` 加 `'parse_error'`；通知 kind 联合（约 369）加 `'parse_error'`；`DistillRunDetail` 加：
   ```ts
   /** parse_error 时详情端点带出的模型原始输出（截断存储）；其余 outcome 为 null/缺省。 */
   rawText?: string | null
   ```
2. `src/web/ui-utils.ts`：
   - `DistillOutcome` 加 `'parse_error'`；`formatOutcome` 在 llm_error 行后加：
     ```ts
     if (outcome === 'parse_error') return { label: '解析失败', color: '#c00' }
     ```
   - `degradationKindLabel` 的 map 加：`subagent_transcript_missing: 'subagent 记录缺失',`
   - `notificationTitle` 加分支（llm_error 行后）：
     ```ts
     if (n.kind === 'parse_error') return '解析失败'
     ```
3. `src/web/App.tsx`：
   - 筛选下拉（约 604 行后）加：`<option value="parse_error">解析失败</option>`
   - chip 标签（约 643）改三分支：
     ```tsx
     {n.kind === 'llm_error' ? 'LLM错误' : n.kind === 'parse_error' ? '解析失败' : '降级'}
     ```
     （chip 颜色逻辑不动：parse_error 落到 `#c00` 红色家族。）
   - DistillRunModal 产出区（约 1531-1541 的 if-else 链）在 llm_error 分支后插入：
     ```tsx
     : detail.outcome === 'parse_error' ? (
       <div>
         <span style={{ color: '#c00' }}>模型输出解析失败（重试 3 次均未获合法 JSON）</span>
         {detail.errorMessage ? (
           <pre style={{ background: '#fff4f4', color: '#c00', padding: 8, margin: '4px 0', whiteSpace: 'pre-wrap', borderLeft: '3px solid #c00' }}>{detail.errorMessage}</pre>
         ) : <span style={{ color: '#999', marginLeft: 8 }}>（无错误描述）</span>}
         <div style={{ marginTop: 8 }}>
           <strong>模型原始输出</strong>
           {detail.rawText ? (
             <pre style={{ background: '#f7f7f7', padding: 8, margin: '4px 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 320, overflow: 'auto', fontSize: 12 }}>{detail.rawText}</pre>
           ) : <span style={{ color: '#999', marginLeft: 8 }}>（无留存）</span>}
         </div>
       </div>
     )
     ```

- [ ] **Step 4: 跑测试确认绿 + 全量**

Run: `bun test tests/web-ui-utils.test.ts tests/web-ui.test.ts && bun run typecheck && bun test`
Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add src/web/api.ts src/web/ui-utils.ts src/web/App.tsx tests/web-ui-utils.test.ts tests/web-ui.test.ts
git commit -m "feat(web): parse_error 徽标/消息中心/详情 modal 原始输出区 + subagent 记录缺失人话（spec 2026-08-15 §5.8）"
```

---

### Task 10: 收尾——全量验证 + STATE.md 落档

**Files:**
- Modify: `STATE.md`

**Interfaces:**
- Consumes: Task 1-9 全部
- Produces: 无

- [ ] **Step 1: 全量门槛**

Run: `bun run typecheck && bun test`
Expected: 全绿（0 失败）

- [ ] **Step 2: STATE.md 落档**

文件顶部（最新一节位置）追加本节，含：本轮三项改动一句话总结；spec/plan 路径；**上线后观测清单**（逐字）：

```markdown
## 蒸馏解析失败可视化 + subagent 兜底治理（2026-08-15）

设计 spec / 计划见 `docs/superpowers/specs|plans/2026-08-15-distill-parse-error-visibility*`。
parse_error 独立 outcome（raw_text 落盘 + 消息中心折叠 + 状态栏红条覆盖）；
SubagentStop 删除主会话兜底，缺失改写 subagent_transcript_missing 取证 degradation。

### 上线后观测（硬要求，结论回填本节）

1. parse_error 24h 计数与占比；raw_text 抽样判型（截断断口 / 围栏 / 散文），给后续 retry prompt 调优定罪。
2. `subagent_transcript_missing` 降解的 dir listing 对照 agentId——抓 phantom agent 文件缺失现行。
3. empty_output 是否回归纯真空（抽样应全部 raw_output_json 非 NULL）。
4. parse_error 通知折叠效果：同签名是否收成一条。
```

- [ ] **Step 3: Commit**

```bash
git add STATE.md
git commit -m "docs: 解析失败可视化 + subagent 兜底治理落档 STATE.md（spec 2026-08-15）"
```

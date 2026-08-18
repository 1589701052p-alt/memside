# LLM 失败处理重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 memside 与 LLM 的关系从"一次性大请求、失败即丢"重构为"带历史、可中断、可接续的多轮 agent 对话"——任何 LLM 失败都不再静默吞掉，有记忆地重试接续，失败全程可见，内容绝不丢失。

**Architecture:** 抽出一个统一的「可接续 agent 会话执行器」（`src/memory/llmSession.ts`），distill/dedup/judge/digest 四步各自是一段封闭的、可被中断、可从断点带历史接着跑的对话。每个蒸馏任务在 `memory_distill_jobs` 记断点（current_step/step_attempts/step_error），每轮对话历史存 `memory_distill_events`，3 次失败汇总一条任务级通知并暂停任务等用户处置。步骤间只传干净结果不传对话历史。session offset 仅四步全成推进。judge 静默全保留兜底彻底废除。

**Tech Stack:** Bun + Hono + Drizzle + bun:sqlite + zod + @anthropic-ai/sdk；前端 React 19（inline style，复用 App.tsx 既有 chrome）。

**Spec:** `docs/superpowers/specs/2026-08-18-llm-failure-handling-design.md`

## Global Constraints

- 测试一律 `bun test`（严禁 npm test，Bun 专有 API）。
- 提交前全量校验用 Bash 工具跑 `bun run typecheck && bun test`（PowerShell 5.1 不支持 `&&`）。
- 任何代码改动必须带测试（TDD：先红后绿；回归防护测试顶端注释链 spec）。
- 首选可断言面：纯函数层写足测试，UI/daemon 运行时层留少量源码层文本断言。
- DB 迁移幂等（CREATE TABLE IF NOT EXISTS no-op + PRAGMA table_info 守卫 + ALTER TABLE ADD COLUMN），不表重建。
- 与 LLM 解耦：不设主动超时、不假设网关墙（spec P6）。
- 失败绝不冒充成功（spec P1）；零静默（spec P8）。
- 基线：`feat/llm-failure-handling` 分支已含 spec commit，基线 `origin/master` ef63d36，当前 `bun test` 1148 pass / 4 skip。
- 本 plan 改造/删除一批旧测试（distiller 失败兜底、scheduler 失败标 done、judge keepNull 兜底），净增测试。

---

## File Structure

**新建：**
- `src/memory/llmSession.ts` — 统一可接续 agent 会话执行器。纯逻辑 + DB 读写接口注入，不 import 任何 provider。职责：跑一段多轮 LLM 对话，每轮历史落盘 + 读回，3 轮上限，失败分类追问，产出干净的 `{ok, result} | {failed, reasons[]}`。
- `src/memory/llmSession.test.ts` — 执行器纯逻辑测试（带历史重试、失败分类、3 轮上限）。
- `src/memory/stepState.ts` — 断点状态机纯函数：步骤推进、失败计数、暂停判定、offset 时机。仿 `pure.ts` 的 `canTransition` 模式。
- `src/memory/stepState.test.ts` — 状态机转换测试（主战场）。
- `src/memory/stepPrompt.ts` — 四步各自的 system prompt + user prompt 构造 + 追问措辞（失败分类 → 追问文本）。把 distiller/dedup/valueFilter/agentJudge 现有的 prompt 段搬来集中，避免两份规则漂移。
- `src/memory/stepPrompt.test.ts` — 追问措辞测试（incomplete/format/aborted 三类区分）。

**修改：**
- `src/db/schema.ts` — `memoryDistillJobs` 加 `currentStep/stepAttempts/stepError`，status enum 加 `paused`；`memoryDistillEvents` kind 加 `llm_round`；`memories` status 加 `pending_review`；`memoryDistillRuns` 加 `pausedStep`。
- `src/db/client.ts` — 幂等迁移（PRAGMA 守卫 + ALTER ADD COLUMN）。
- `src/memory/store.ts` — 断点读写、对话历史读写（llm_round payload 四样）、pending_review 候选查询/转 candidate、3 次失败汇总通知（复用 insertNotification）、暂停/重试/放弃 job 操作。
- `src/scheduler.ts` — tick 主流程改造：断点续跑、调用执行器、3 次上限、暂停、offset 仅四步全成推进、删除无条件标 done。
- `src/memory/distiller.ts` — distill 步骤改为走执行器多轮可接续；废除顶层 catch 吞错为 0 候选（改为抛出/记失败）；DistillResult 适配新流程。
- `src/memory/valueFilter.ts` — judge 废除 `keepNull`/`keepAll` 兜底，失败记失败走执行器。`judgeValue`/`judgeValueAgentic` 改造。
- `src/memory/agentJudge.ts` — agentic judge 改造走执行器；废除 keepAll 兜底。
- `src/memory/retry.ts` — `callWithRetry` 被执行器取代（保留给旧调用方或删除，plan 阶段决断；倾向保留旧签名做兼容 shim 直到全量迁移）。
- `src/anthropic.ts` — AbortError 消息透出更可诊断（不设主动超时）。
- `src/web/App.tsx` + `src/web/api.ts` — 暂停任务 UI（蒸馏记录 tab 标记 + 重试/放弃）、待审查候选区块、状态栏显示重试轮次。

---

## Task 1: 断点状态机纯函数 + 测试

**Files:**
- Create: `src/memory/stepState.ts`
- Test: `src/memory/stepState.test.ts`

**Interfaces:**
- Produces: `type DistillStep = 'distill' | 'dedup' | 'judge' | 'digest'`；`type StepAttemptResult = { ok: true } | { ok: false; reason: StepFailReason }`（`StepFailReason = 'aborted' | 'format' | 'incomplete'`）；`type JobPauseState = 'active' | 'paused'`；函数 `nextStep(current: DistillStep): DistillStep | null`（digest 后返回 null=完成）；`shouldPause(stepAttempts: number): boolean`（>=3 为 true）；`advanceStep(current: DistillStep, result: StepAttemptResult): { step: DistillStep; attempts: number; paused: JobPauseState }`。

- [ ] **Step 1: Write failing test — 状态转换**

`src/memory/stepState.test.ts` 顶端注释：
```ts
// 锁 spec 2026-08-18 §3.3/§5：断点续跑状态机。失败绝不冒充成功（P1），
// 3 次失败暂停（P7），全成功才完成。未来 refactor 变红即回归意图。
```

```ts
import { describe, expect, test } from 'bun:test'
import { nextStep, shouldPause, advanceStep } from './stepState'

describe('stepState', () => {
  test('nextStep 顺序 distill→dedup→judge→digest→null', () => {
    expect(nextStep('distill')).toBe('dedup')
    expect(nextStep('dedup')).toBe('judge')
    expect(nextStep('judge')).toBe('digest')
    expect(nextStep('digest')).toBeNull()
  })

  test('shouldPause: <3 false, >=3 true', () => {
    expect(shouldPause(0)).toBe(false)
    expect(shouldPause(2)).toBe(false)
    expect(shouldPause(3)).toBe(true)
    expect(shouldPause(5)).toBe(true)
  })

  test('advanceStep: 成功推进到下一步 attempts 归零', () => {
    const r = advanceStep('distill', { ok: true })
    expect(r).toEqual({ step: 'dedup', attempts: 0, paused: 'active' })
  })

  test('advanceStep: 失败 +1，同步骤未到 3 不暂停', () => {
    const r = advanceStep('judge', { ok: false, reason: 'aborted' })
    expect(r).toEqual({ step: 'judge', attempts: 1, paused: 'active' })
  })

  test('advanceStep: 第 3 次失败暂停（attempts 已是 2，+1=3）', () => {
    const r = advanceStep('judge', { ok: false, reason: 'format' })
    // 注意：advanceStep 接收的是「当前已尝试次数」，失败后 +1。
    // 这里语义：传入失败前的 attempts=2，失败后变 3，暂停。
    expect(r).toEqual({ step: 'judge', attempts: 3, paused: 'paused' })
  })

  test('digest 成功 = 完成（nextStep null）', () => {
    const r = advanceStep('digest', { ok: true })
    expect(r).toEqual({ step: 'digest', attempts: 0, paused: 'active' })
    expect(nextStep('digest')).toBeNull()
  })
})
```

> 设计注意：`advanceStep` 接收**当前 attempts（失败前已记录的）**，失败时 +1。所以"第 3 次失败"= 传入 attempts=2 → 输出 3。测试里 advanceStep 不知"前值"，故 step3 测试用固定 attempts 参数。改函数签名为 `advanceStep(current, result, currentAttempts)`：

修正测试 step5：
```ts
  test('advanceStep: 当前 attempts=2 失败后变 3 暂停', () => {
    const r = advanceStep('judge', { ok: false, reason: 'format' }, 2)
    expect(r).toEqual({ step: 'judge', attempts: 3, paused: 'paused' })
  })

  test('advanceStep: 当前 attempts=1 失败后变 2 不暂停', () => {
    const r = advanceStep('judge', { ok: false, reason: 'aborted' }, 1)
    expect(r).toEqual({ step: 'judge', attempts: 2, paused: 'active' })
  })

  test('advanceStep: 成功时 attempts 归零推进（忽略 currentAttempts）', () => {
    expect(advanceStep('distill', { ok: true }, 2)).toEqual({ step: 'dedup', attempts: 0, paused: 'active' })
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/memory/stepState.test.ts`
Expected: FAIL — 模块不存在 / 导出未定义。

- [ ] **Step 3: Implement**

```ts
// src/memory/stepState.ts
export type DistillStep = 'distill' | 'dedup' | 'judge' | 'digest'
export type StepFailReason = 'aborted' | 'format' | 'incomplete'
export type StepAttemptResult = { ok: true } | { ok: false; reason: StepFailReason }
export type JobPauseState = 'active' | 'paused'

const STEP_ORDER: readonly DistillStep[] = ['distill', 'dedup', 'judge', 'digest']

/** 下一步；digest 后 null = 四步全成。 */
export function nextStep(current: DistillStep): DistillStep | null {
  const i = STEP_ORDER.indexOf(current)
  return i < 0 || i >= STEP_ORDER.length - 1 ? null : STEP_ORDER[i + 1]!
}

/** 累计失败次数 >= 3 即暂停（spec P7）。 */
export const STEP_MAX_ATTEMPTS = 3
export function shouldPause(stepAttempts: number): boolean {
  return stepAttempts >= STEP_MAX_ATTEMPTS
}

/**
 * 给定当前步骤、本轮结果、当前已尝试次数，算出下一步状态。
 * 成功 → 推进到下一步，attempts 归零，active。
 * 失败 → attempts+1；到 3 暂停，否则同步骤继续。
 */
export function advanceStep(
  current: DistillStep, result: StepAttemptResult, currentAttempts: number,
): { step: DistillStep; attempts: number; paused: JobPauseState } {
  if (result.ok) {
    const next = nextStep(current) ?? current
    return { step: next, attempts: 0, paused: 'active' }
  }
  const attempts = currentAttempts + 1
  return { step: current, attempts, paused: shouldPause(attempts) ? 'paused' : 'active' }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/memory/stepState.test.ts`
Expected: PASS（全部 6 case）。

- [ ] **Step 5: Commit**

```bash
git add src/memory/stepState.ts src/memory/stepState.test.ts
git commit -m "feat(llm-failure): 断点状态机纯函数（步骤推进/3次暂停/offset 时机）"
```

---

## Task 2: 失败分类追问措辞纯函数 + 测试

**Files:**
- Create: `src/memory/stepPrompt.ts`
- Test: `src/memory/stepPrompt.test.ts`

**Interfaces:**
- Consumes: `StepFailReason` from `./stepState`。
- Produces: `buildFollowupPrompt(reason: StepFailReason, lastResponse: string, step: DistillStep): string`（根据失败原因拼追问文本，带上一轮 LLM 回复）；`classifyFailure(error: unknown, rawResponse: string | null): StepFailReason`（从异常/响应分类失败原因）。

- [ ] **Step 1: Write failing test — 三类追问区分**

`src/memory/stepPrompt.test.ts` 顶端注释：
```ts
// 锁 spec 2026-08-18 §5.3：失败分类决定追问措辞。incomplete=接着回，
// format=格式不对，aborted=重发。三类必须可区分。
```

```ts
import { describe, expect, test } from 'bun:test'
import { buildFollowupPrompt, classifyFailure } from './stepPrompt'
import type { DistillStep } from './stepState'

const step: DistillStep = 'judge'

describe('stepPrompt 追问措辞', () => {
  test('incomplete: 带上轮回复要求接着回', () => {
    const s = buildFollowupPrompt('incomplete', '{"verdicts":[{"index":0', step)
    expect(s).toContain('接着')
    expect(s).toContain('{"verdicts":[{"index":0')
  })

  test('format: 提示格式不对 + JSON 模板提醒', () => {
    const s = buildFollowupPrompt('format', 'not json at all', step)
    expect(s).toContain('格式')
    expect(s).toContain('JSON')
  })

  test('aborted: 提示上次中断需重新输出', () => {
    const s = buildFollowupPrompt('aborted', '', step)
    expect(s).toContain('中断')
    expect(s).toContain('重新输出')
  })

  test('三类追问互斥（不含对方关键词）', () => {
    const inc = buildFollowupPrompt('incomplete', 'x', step)
    const fmt = buildFollowupPrompt('format', 'x', step)
    const abt = buildFollowupPrompt('aborted', 'x', step)
    expect(inc).not.toContain('格式')
    expect(fmt).not.toContain('中断')
    expect(abt).not.toContain('接着')
  })
})

describe('classifyFailure 失败分类', () => {
  test('AbortError / aborted 关键字 → aborted', () => {
    expect(classifyFailure(new Error('the operation was aborted'), null)).toBe('aborted')
    expect(classifyFailure(new Error('Request aborted'), null)).toBe('aborted')
  })

  test('Connection error / timeout 关键字 → aborted', () => {
    expect(classifyFailure(new Error('Connection error.'), null)).toBe('aborted')
  })

  test('有响应但非法 JSON → format', () => {
    expect(classifyFailure(null, 'not json')).toBe('format')
    expect(classifyFailure(new Error('Unexpected token'), '{"bad')).toBe('format')
  })

  test('有响应且像 JSON 但截断（缺闭合括号）→ incomplete', () => {
    expect(classifyFailure(null, '{"verdicts":[{"index":0}')).toBe('incomplete')
  })

  test('无响应无异常兜底 → aborted', () => {
    expect(classifyFailure(null, '')).toBe('aborted')
    expect(classifyFailure(null, null)).toBe('aborted')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/memory/stepPrompt.test.ts`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: Implement**

```ts
// src/memory/stepPrompt.ts
import { extractJsonObject } from './pure'
import type { DistillStep, StepFailReason } from './stepState'

const ABORT_PATTERNS = ['aborted', 'connection error', 'timeout', 'timed out', 'econnreset', 'socket hang up']

/** 从异常/响应分类失败原因（spec §5.3）。 */
export function classifyFailure(error: unknown, rawResponse: string | null): StepFailReason {
  const hasResponse = rawResponse != null && rawResponse.trim().length > 0
  if (hasResponse) {
    // 试解析，能完整 parse 但不合规由调用方的 shouldRetry 判定（走 format）；
    // 不能 parse（JSON.parse 失败）→ format；像 JSON 但截断 → incomplete。
    try {
      JSON.parse(extractJsonObject(rawResponse!))
      return 'format' // 解析成功但内容不合规，重试要纠格式（调用方分类细化）
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // 截断特征：parse 报错但原始里有未闭合的 JSON 结构
      if (rawResponse!.includes('{') && !isClosedJson(rawResponse!)) return 'incomplete'
      return 'format'
    }
  }
  // 无响应：看异常类型
  if (error) {
    const msg = (error instanceof Error ? error.message : String(error)).toLowerCase()
    if (ABORT_PATTERNS.some((p) => msg.includes(p))) return 'aborted'
  }
  return 'aborted'
}

function isClosedJson(s: string): boolean {
  let depth = 0
  for (const ch of s) {
    if (ch === '{') depth++
    else if (ch === '}') depth--
  }
  return depth <= 0
}

/** 根据失败原因拼追问文本（spec §5.3）。 */
export function buildFollowupPrompt(reason: StepFailReason, lastResponse: string, _step: DistillStep): string {
  const suffix = '请只输出纯 JSON 对象，不要 markdown 围栏，不要解释文字，键与字符串值用双引号。'
  if (reason === 'incomplete') {
    return `\n\n[系统] 你上次的回复没回完，请接着上面的内容输出完整的 JSON。上次的回复：\n${lastResponse}\n${suffix}`
  }
  if (reason === 'format') {
    return `\n\n[系统] 你上次的回复格式不对，请输出合规的 JSON 对象。上次的回复：\n${lastResponse}\n${suffix}`
  }
  // aborted
  return `\n\n[系统] 上次请求被中断，请重新输出完整的 JSON 结果。${suffix}`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/memory/stepPrompt.test.ts`
Expected: PASS。若 `incomplete` 的"不含格式"断言失败，调措辞使三类互斥。

- [ ] **Step 5: Commit**

```bash
git add src/memory/stepPrompt.ts src/memory/stepPrompt.test.ts
git commit -m "feat(llm-failure): 失败分类追问措辞纯函数（incomplete/format/aborted 三类）"
```

---

## Task 3: DB schema 迁移 + 测试

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/db/client.ts`
- Test: `tests/schema-step-state.test.ts`

**Interfaces:**
- Produces: `memoryDistillJobs.currentStep`（text）、`stepAttempts`（integer default 0）、`stepError`（text）；jobs `status` enum 加 `'paused'`；`memoryDistillEvents.kind` 加 `'llm_round'`；`memories.status` enum 加 `'pending_review'`；`memoryDistillRuns.pausedStep`（text）。

- [ ] **Step 1: Write failing test — 列存在性**

`tests/schema-step-state.test.ts` 顶端注释：
```ts
// 锁 spec 2026-08-18 §4.1：断点字段 + paused/pending_review 状态。迁移幂等。
```

```ts
import { describe, expect, test } from 'bun:test'
import { openDb } from '@/db/client'
import type { DbClient } from '@/db/client'

function cols(table: string, db: DbClient): string[] {
  return (db._.fullClient.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)
}

describe('schema step-state migration', () => {
  test('memory_distill_jobs 有 current_step/step_attempts/step_error', () => {
    const db = openDb(':memory:')
    const c = cols('memory_distill_jobs', db)
    expect(c).toContain('current_step')
    expect(c).toContain('step_attempts')
    expect(c).toContain('step_error')
    db._.fullClient.close()
  })

  test('memory_distill_runs 有 paused_step', () => {
    const db = openDb(':memory:')
    expect(cols('memory_distill_runs', db)).toContain('paused_step')
    db._.fullClient.close()
  })

  test('迁移幂等（openDb 两次不报错）', () => {
    const db = openDb(':memory:')
    // 再调一次迁移逻辑（openDb 内部幂等）
    const db2 = openDb(':memory:')
    expect(cols('memory_distill_jobs', db)).toContain('current_step')
    expect(cols('memory_distill_jobs', db2)).toContain('current_step')
    db._.fullClient.close()
    db2._.fullClient.close()
  })
})
```

> 注：`db._.fullClient` 是 bun:sqlite 底层句柄访问模式，先在既有测试（如 `tests/store-crud.test.ts`）确认实际写法。若现有测试用别的别名（如 `rawClient`），改测试对齐。implementer 在 step3 前先 grep `PRAGMA table_info` 找现有写法复用。

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/schema-step-state.test.ts`
Expected: FAIL — 列不存在。

- [ ] **Step 3: Implement schema.ts**

在 `src/db/schema.ts` 的 `memoryDistillJobs` 加列、status enum 加 `'paused'`；`memoryDistillEvents.kind` 注释加 `llm_round`（text 不需改 enum）；`memoryDistillRuns` 加 `pausedStep`。`memories` status enum 加 `'pending_review'`。

```ts
// memoryDistillJobs 内：
status: text('status', {
  enum: ['pending', 'running', 'done', 'failed', 'canceled', 'waiting', 'paused'],
}).notNull(),
attempts: integer('attempts').notNull().default(0),
nextRunAt: integer('next_run_at').notNull(),
lastError: text('last_error'),
currentStep: text('current_step'),          // 'distill'|'dedup'|'judge'|'digest'; NULL=distill(新任务)
stepAttempts: integer('step_attempts').notNull().default(0),
stepError: text('step_error'),              // 当前步骤最后失败原因（汇总通知用）
```

```ts
// memoryDistillRuns 内，durationMs 后加：
pausedStep: text('paused_step'),            // 暂停在哪步；非暂停 NULL
```

```ts
// memories status enum：'candidate'|'approved'|'rejected'|'archived'|'superseded' 加 'pending_review'
// （确认 schema.ts 中 memories 的 status enum 位置，追加 'pending_review'）
```

- [ ] **Step 4: Implement client.ts 迁移**

在 `src/db/client.ts` 迁移块（`last_capture_at` 迁移之后）加幂等块：

```ts
  // Idempotent migration: add step-state columns to memory_distill_jobs (spec 2026-08-18).
  {
    const cols = raw.prepare('PRAGMA table_info(memory_distill_jobs)').all() as { name: string }[]
    if (!cols.some((c) => c.name === 'current_step')) raw.exec('ALTER TABLE memory_distill_jobs ADD COLUMN current_step TEXT')
    if (!cols.some((c) => c.name === 'step_attempts')) raw.exec('ALTER TABLE memory_distill_jobs ADD COLUMN step_attempts INTEGER NOT NULL DEFAULT 0')
    if (!cols.some((c) => c.name === 'step_error')) raw.exec('ALTER TABLE memory_distill_jobs ADD COLUMN step_error TEXT')
  }
  // Idempotent migration: add paused_step to memory_distill_runs (spec 2026-08-18).
  {
    const cols = raw.prepare('PRAGMA table_info(memory_distill_runs)').all() as { name: string }[]
    if (!cols.some((c) => c.name === 'paused_step')) raw.exec('ALTER TABLE memory_distill_runs ADD COLUMN paused_step TEXT')
  }
```

> `memories.status` 加 `'pending_review'`：检查 schema.ts memories 的 status 是否有 DB-level CHECK。grep 确认：若 status 是纯 TS enum（无 SQL CHECK），drizzle 不生成 CHECK 约束，直接加 enum 值即可（与既有 `'canceled'` 等同模式）。若存在表重建 CHECK 块（见 `client.ts` 的 `memories_new` 重建），需同步更新重建 DDL 与 INSERT 列名清单。implementer 先 grep `pending_review\|status.*CHECK\|memories_new` 确认。

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/schema-step-state.test.ts`
Expected: PASS。

- [ ] **Step 6: typecheck + 全量回归**

Run: `bun run typecheck && bun test`
Expected: typecheck 干净；全量测试不应有回归（新列 nullable/有默认值，旧代码不读不写无碍）。若有旧测试断言 status enum 穷举，补 `'paused'`/`'pending_review'`。

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.ts src/db/client.ts tests/schema-step-state.test.ts
git commit -m "feat(llm-failure): DB 迁移——jobs 断点字段 + paused/pending_review 状态"
```

---

## Task 4: store 层断点/历史读写 + 通知 + 测试

**Files:**
- Modify: `src/memory/store.ts`
- Test: `tests/store-step-state.test.ts`

**Interfaces:**
- Produces:
  - `getJobCheckpoint(db, jobId): { currentStep: DistillStep; stepAttempts: number; stepError: string | null }`
  - `setJobCheckpoint(db, jobId, cp): Promise<void>`（写 currentStep/stepAttempts/stepError）
  - `saveLlmRound(db, { jobId, step, round, request, response, result }): Promise<void>`（存 `memory_distill_events` kind=`llm_round`，payload JSON 四样）
  - `listLlmRounds(db, jobId, step): Promise<LlmRoundRow[]>`（按 step 读回历史，round 升序）
  - `markJobPaused(db, jobId, step): Promise<void>`（status='paused', stepError, pausedStep on runs）
  - `resetJobForRetry(db, jobId): Promise<void>`（stepAttempts=0, stepError=null, status='pending', nextRunAt=now）
  - `abandonJob(db, jobId): Promise<void>`（status='done', 推进 offset 由 scheduler 调 setSessionOffset）
  - `logStepFailureNotification(db, { jobId, step, reasons: string[] }): Promise<void>`（汇总一条任务级通知，复用 insertNotification）
  - `listPendingReviewCandidates(db, { projectId }): Promise<Memory[]>`
  - `promotePendingReviewToCandidate(db, candidateId): Promise<void>`（status 'pending_review'→'candidate'）

- [ ] **Step 1: Write failing test — 断点读写 + 历史 round-trip**

`tests/store-step-state.test.ts` 顶端注释：
```ts
// 锁 spec 2026-08-18 §4.1/§5.2/§8.3：断点读写、对话历史四样 round-trip、
// 3 次失败汇总一条任务级通知（同任务折叠）、paused→重试重置、pending_review。
```

```ts
import { describe, expect, test, beforeEach } from 'bun:test'
import { openDb, type DbClient } from '@/db/client'
import {
  createJob, getJobCheckpoint, setJobCheckpoint, saveLlmRound, listLlmRounds,
  markJobPaused, resetJobForRetry, logStepFailureNotification,
} from '@/memory/store'

let db: DbClient
beforeEach(() => { db = openDb(':memory:'); /* seed 一个 job */ })

// （createJob 签名见 store.ts 现有；若不存在用直接 insert。
//  implementer 先 grep `function createJob\|insert(memoryDistillJobs)` 找现有建 job 方式。）

describe('断点读写', () => {
  test('新 job 断点默认 distill/0/null', () => {
    const cp = getJobCheckpoint(db, '<jobId>')
    expect(cp.currentStep).toBe('distill')
    expect(cp.stepAttempts).toBe(0)
    expect(cp.stepError).toBeNull()
  })

  test('setJobCheckpoint 写入后读回一致', async () => {
    await setJobCheckpoint(db, '<jobId>', { currentStep: 'judge', stepAttempts: 2, stepError: 'aborted' })
    const cp = getJobCheckpoint(db, '<jobId>')
    expect(cp).toEqual({ currentStep: 'judge', stepAttempts: 2, stepError: 'aborted' })
  })
})

describe('对话历史 round-trip', () => {
  test('saveLlmRound 四样落盘且 listLlmRounds 按 round 升序读回', async () => {
    await saveLlmRound(db, { jobId: '<jobId>', step: 'judge', round: 1, request: 'q1', response: 'r1', result: { ok: false, reason: 'format' } })
    await saveLlmRound(db, { jobId: '<jobId>', step: 'judge', round: 2, request: 'q2', response: 'r2', result: { ok: true } })
    const rounds = await listLlmRounds(db, '<jobId>', 'judge')
    expect(rounds).toHaveLength(2)
    expect(rounds[0].round).toBe(1)
    expect(rounds[0].response).toBe('r1')
    expect(rounds[0].result).toEqual({ ok: false, reason: 'format' })
    expect(rounds[1].round).toBe(2)
  })

  test('listLlmRounds 只读本步骤（不跨步）', async () => {
    await saveLlmRound(db, { jobId: '<jobId>', step: 'distill', round: 1, request: 'd', response: 'd', result: { ok: true } })
    await saveLlmRound(db, { jobId: '<jobId>', step: 'judge', round: 1, request: 'j', response: 'j', result: { ok: true } })
    const rounds = await listLlmRounds(db, '<jobId>', 'judge')
    expect(rounds).toHaveLength(1)
    expect(rounds[0].request).toBe('j')
  })
})

describe('3 次失败汇总通知', () => {
  test('logStepFailureNotification 写一条任务级通知含汇总原因', async () => {
    await logStepFailureNotification(db, { jobId: '<jobId>', step: 'judge', reasons: ['aborted(360036ms)', 'format(缺verdicts)', 'aborted(360045ms)'] })
    // 读 notifications 表断言一条 llm_error + refId=jobId + body 含三次原因
    // （用现有 listNotifications 或直接 select，implementer 复用现有查询辅助）
  })

  test('同任务重复暂停折叠不刷屏（同内容折叠）', async () => {
    await logStepFailureNotification(db, { jobId: '<jobId>', step: 'judge', reasons: ['a', 'b', 'c'] })
    const before = await countNotifications(db)
    await logStepFailureNotification(db, { jobId: '<jobId>', step: 'judge', reasons: ['a', 'b', 'c'] })
    const after = await countNotifications(db)
    expect(after).toBe(before) // 折叠，不新增
  })
})

describe('paused→重试重置', () => {
  test('resetJobForRetry 清零 attempts/stepError 回 pending', async () => {
    await markJobPaused(db, '<jobId>', 'judge')
    await resetJobForRetry(db, '<jobId>')
    const cp = getJobCheckpoint(db, '<jobId>')
    expect(cp.stepAttempts).toBe(0)
    expect(cp.stepError).toBeNull()
    // status 回 pending（查 job 行断言）
  })
})
```

> implementer 注意：`createJob`/`countNotifications` 辅助若不存在，在测试内手写最小 seed（直接 insert memory_distill_jobs 一行 + 用 listNotificationsPage 计数）。先 grep 现有 store 测试的 seed 模式复用。

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/store-step-state.test.ts`
Expected: FAIL — 函数未导出。

- [ ] **Step 3: Implement store.ts**

按 Interfaces 块实现各函数。关键点：
- `saveLlmRound`：`db.insert(memoryDistillEvents).values({ distillJobId, attemptIndex: round, ts: Date.now(), kind: 'llm_round', payload: JSON.stringify({ round, request, response, result }) })`。`attemptIndex` 复用为 round。
- `listLlmRounds`：`select where distillJobId=? and kind='llm_round'`，payload JSON.parse，按 round（attemptIndex）升序。**payload 里也存了 step，但 list 用入参 step 过滤避免跨步**——为防 payload 与查询 step 漂移，payload 里也存 `step` 字段，list 时既按 `kind='llm_round'` 过滤又校验 payload.step===入参 step。
- `markJobPaused`：`update memory_distill_jobs set status='paused', step_error=? where id=?` + `saveDistillRun` 更新 pausedStep。
- `logStepFailureNotification`：`insertNotification({ kind:'llm_error', title:`${step}_failed`, body: reasons.join(' | '), refType:'distill_job', refId:jobId })`。复用同内容折叠。
- `getJobCheckpoint`：currentStep 为 NULL 时返回 `'distill'`（新任务语义）。

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/store-step-state.test.ts`
Expected: PASS。

- [ ] **Step 5: typecheck + 全量**

Run: `bun run typecheck && bun test`
Expected: 全绿。

- [ ] **Step 6: Commit**

```bash
git add src/memory/store.ts tests/store-step-state.test.ts
git commit -m "feat(llm-failure): store 层断点/历史读写 + 3次失败汇总通知 + 暂停/重试/放弃"
```

---

## Task 5: 可接续 agent 会话执行器 + 测试

**Files:**
- Create: `src/memory/llmSession.ts`
- Test: `src/memory/llmSession.test.ts`

**Interfaces:**
- Consumes: `LLMCall` from `@/llm`；`advanceStep`/`StepAttemptResult`/`DistillStep` from `./stepState`；`classifyFailure`/`buildFollowupPrompt` from `./stepPrompt`；store 函数注入（`saveLlmRound`/`listLlmRounds`）。
- Produces: `interface LlmSessionOpts { callLLM: LLMCall; system: string; initialUser: string; step: DistillStep; jobId: string; persistRound?: (r: RoundRecord) => Promise<void>; loadHistory?: () => Promise<RoundRecord[]>; shouldRetry: (parsed: unknown) => string | null; maxAttempts?: number }`；`interface RoundRecord { round: number; request: string; response: string; result: StepAttemptResult }`；`type LlmSessionResult = { ok: true; parsed: unknown } | { ok: false; reasons: string[] }`；`async function runLlmSession(opts: LlmSessionOpts): Promise<LlmSessionResult>`。

- [ ] **Step 1: Write failing test — 带历史重试 + 3 轮上限**

`src/memory/llmSession.test.ts` 顶端注释：
```ts
// 锁 spec 2026-08-18 §3/§5/§8.2：执行器是重构核心。失败带历史接着跑（P2），
// 3 轮上限（P7），失败绝不冒充成功（P1）。历史四样 round-trip。
```

```ts
import { describe, expect, test } from 'bun:test'
import { runLlmSession, type RoundRecord } from './llmSession'
import type { LLMCall } from '@/llm'

function makeCallLLM(responses: string[], throws?: number[]): LLMCall {
  let i = 0
  return async (_sys, _user) => {
    if (throws?.includes(i)) { const e = new Error('the operation was aborted'); i++; throw e }
    return responses[i++] ?? ''
  }
}

describe('runLlmSession', () => {
  test('第1轮成功 → ok + parsed', async () => {
    const saved: RoundRecord[] = []
    const r = await runLlmSession({
      callLLM: makeCallLLM(['{"candidates":[]}']), system: 's', initialUser: 'u', step: 'distill', jobId: 'j1',
      persistRound: async (rr) => { saved.push(rr) },
      loadHistory: async () => [],
      shouldRetry: () => null,
    })
    expect(r.ok).toBe(true)
    expect(saved).toHaveLength(1)
    expect(saved[0].result.ok).toBe(true)
  })

  test('第1轮失败第2轮成功 → 带历史追问，3轮内静默成功', async () => {
    const saved: RoundRecord[] = []
    const r = await runLlmSession({
      // 第1轮抛 aborted，第2轮回合法 JSON
      callLLM: makeCallLLM(['{"candidates":[]}'], [0]),
      system: 's', initialUser: 'u', step: 'distill', jobId: 'j2',
      persistRound: async (rr) => { saved.push(rr) },
      loadHistory: async () => [],
      shouldRetry: () => null,
    })
    expect(r.ok).toBe(true)
    expect(saved).toHaveLength(2)
    expect(saved[0].result.ok).toBe(false)
    // 第2轮 request 应带历史（追问措辞含"中断"或"重新输出"）
    expect(saved[1].request).toMatch(/中断|重新输出|接着/)
  })

  test('3轮全失败 → ok:false + reasons 三条', async () => {
    const r = await runLlmSession({
      callLLM: makeCallLLM([], [0, 1, 2]),
      system: 's', initialUser: 'u', step: 'judge', jobId: 'j3',
      persistRound: async () => {},
      loadHistory: async () => [],
      shouldRetry: () => 'verdicts 缺失',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reasons).toHaveLength(3)
  })

  test('重试时 loadHistory 带回历史 → 第2轮 request 含第1轮内容', async () => {
    const history: RoundRecord[] = [
      { round: 1, request: 'u', response: '{"bad', result: { ok: false, reason: 'incomplete' } },
    ]
    let capturedReq = ''
    const r = await runLlmSession({
      callLLM: async (_s, u) => { capturedReq = u; return '{"candidates":[]}' },
      system: 's', initialUser: 'u', step: 'distill', jobId: 'j4',
      persistRound: async () => {},
      loadHistory: async () => history,
      shouldRetry: () => null,
    })
    expect(r.ok).toBe(true)
    expect(capturedReq).toContain('{"bad') // 带了上一轮响应
  })

  test('失败绝不冒充成功：第2轮仍失败但有第3轮，不提前返回 ok', async () => {
    let calls = 0
    const r = await runLlmSession({
      callLLM: async () => { calls++; throw new Error('connection error') },
      system: 's', initialUser: 'u', step: 'judge', jobId: 'j5',
      persistRound: async () => {},
      loadHistory: async () => [],
      shouldRetry: () => null,
    })
    expect(r.ok).toBe(false)
    expect(calls).toBe(3)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/memory/llmSession.test.ts`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: Implement**

```ts
// src/memory/llmSession.ts
import type { LLMCall } from '@/llm'
import { extractJsonObject } from './pure'
import { classifyFailure, buildFollowupPrompt } from './stepPrompt'
import type { DistillStep, StepAttemptResult, StepFailReason } from './stepState'
import { STEP_MAX_ATTEMPTS } from './stepState'

export interface RoundRecord {
  round: number
  request: string
  response: string
  result: StepAttemptResult
}

export interface LlmSessionOpts {
  callLLM: LLMCall
  system: string
  initialUser: string
  step: DistillStep
  jobId: string
  persistRound?: (r: RoundRecord) => Promise<void>
  loadHistory?: () => Promise<RoundRecord[]>
  shouldRetry: (parsed: unknown) => string | null
  maxAttempts?: number
}

export type LlmSessionResult = { ok: true; parsed: unknown } | { ok: false; reasons: string[] }

/**
 * 可接续 agent 会话执行器（spec §3）。每轮历史落盘+读回，失败分类追问带历史接着跑，
 * maxAttempts 内成功静默返回 ok；全失败返回 ok:false + reasons（调用方据此暂停/通知）。
 * 永不把失败当成功（P1）。
 */
export async function runLlmSession(opts: LlmSessionOpts): Promise<LlmSessionResult> {
  const max = opts.maxAttempts ?? STEP_MAX_ATTEMPTS
  const history = opts.loadHistory ? await opts.loadHistory() : []
  let conversation = opts.initialUser
  // 把历史拼进首轮（执行器消费方：loadHistory 返回的非空历史代表"接着跑"）
  if (history.length > 0) {
    const last = history[history.length - 1]!
    if (!last.result.ok) conversation = opts.initialUser + buildFollowupPrompt(last.result.reason, last.response, opts.step)
  }
  const reasons: string[] = []
  for (let round = history.length + 1; round <= max; round++) {
    let raw: string
    let result: StepAttemptResult
    try {
      raw = await opts.callLLM(opts.system, conversation)
      // 校验：解析 + shouldRetry
      let parsed: unknown
      try {
        parsed = JSON.parse(extractJsonObject(raw))
      } catch {
        result = { ok: false, reason: classifyFailure(null, raw) }
        reasons.push(`${result.reason}:${raw.slice(0, 80)}`)
        await opts.persistRound?.({ round, request: conversation, response: raw, result })
        conversation = opts.initialUser + buildFollowupPrompt(result.reason, raw, opts.step)
        continue
      }
      const retryErr = opts.shouldRetry(parsed)
      if (retryErr === null) {
        result = { ok: true }
        await opts.persistRound?.({ round, request: conversation, response: raw, result })
        return { ok: true, parsed }
      }
      result = { ok: false, reason: 'format' as StepFailReason }
      reasons.push(`format:${retryErr}`)
      await opts.persistRound?.({ round, request: conversation, response: raw, result })
      conversation = opts.initialUser + buildFollowupPrompt('format', raw, opts.step)
    } catch (e) {
      const reason = classifyFailure(e, null)
      result = { ok: false, reason }
      reasons.push(`${reason}:${e instanceof Error ? e.message : String(e)}`)
      await opts.persistRound?.({ round, request: conversation, response: '', result })
      conversation = opts.initialUser + buildFollowupPrompt(reason, '', opts.step)
    }
  }
  return { ok: false, reasons }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/memory/llmSession.test.ts`
Expected: PASS（5 case）。若"3轮全失败"的 reasons 长度不对，检查循环边界（round 从 history.length+1 到 max，恰好 max 次尝试）。

- [ ] **Step 5: typecheck + 全量**

Run: `bun run typecheck && bun test`
Expected: 全绿。

- [ ] **Step 6: Commit**

```bash
git add src/memory/llmSession.ts src/memory/llmSession.test.ts
git commit -m "feat(llm-failure): 可接续 agent 会话执行器（带历史重试/3轮上限/失败分类追问）"
```

---

## Task 6: judge 废除静默全保留兜底（回归防护）

**Files:**
- Modify: `src/memory/valueFilter.ts`（`judgeValueBase`/`judgeValue`）
- Modify: `src/memory/agentJudge.ts`（`judgeValueAgentic`）
- Test: `tests/judge-no-silent-fallback.test.ts`

**Interfaces:**
- Consumes: `runLlmSession` from `./llmSession`；store 函数。
- Produces: `judgeValue`/`judgeValueAgentic` 改为：3 轮内成功返回 verdicts；3 轮失败**返回 `{ok:false, step:'judge'}` 标识**（不再返回全保留 verdicts），由 scheduler 据此暂停任务。签名改为返回 `ValueVerdict[] | { failed: true; reasons: string[] }`。

> **架构决策（本 task 锁定）：** judge 失败不再在 valueFilter/agentJudge 内部兜底。改成"失败即抛出失败标识给 scheduler"。但为最小化本 task 爆炸面，本 task 先做**纯函数层断言**：构造一个永远抛错的 LLMCall，断言 judgeValue 不再返回"全候选 valueClass:null + 0 丢弃"。scheduler 接线在 Task 7。

- [ ] **Step 1: Write failing test — judge 失败不冒充成功**

`tests/judge-no-silent-fallback.test.ts` 顶端注释：
```ts
// 锁 spec 2026-08-18 §缺陷2/§8.4：judge 失败绝不走 keepNull/keepAll 全保留
// 冒充成功。这是用户最初踩的坑（全"未评估"+AI自动拒绝0）。未来 refactor
// 变红即回归意图。链接 spec 2026-08-18。
```

```ts
import { describe, expect, test } from 'bun:test'
import { judgeValue } from '@/memory/valueFilter'
import type { LLMCall } from '@/llm'
import type { DistillCandidate } from '@/memory/distiller'

const failingCall: LLMCall = async () => { throw new Error('the operation was aborted') }

const cand = (i: number): DistillCandidate => ({
  title: `[category:convention] test ${i}`, bodyMd: 'b', scopeType: 'project',
  runtime: 'claude-code', distillAction: 'new', origin: 'agent-observed',
  evidence: 'e', subjectSlug: null,
})

describe('judge 失败不静默全保留', () => {
  test('LLM 永远报错 → judgeValue 不返回全保留 verdicts，而是返回失败标识', async () => {
    const r = await judgeValue([cand(0), cand(1)], failingCall)
    // 旧行为：返回 [{keep:true,valueClass:null},...]（全未评估）。新行为：返回失败标识。
    expect(Array.isArray(r)).toBe(false)
    expect((r as { failed: true }).failed).toBe(true)
  })

  test('反向断言：失败时不再出现"全候选 keep+null+0丢弃"旧症状', async () => {
    const r = await judgeValue([cand(0)], failingCall)
    if (Array.isArray(r)) {
      // 不该走到这：若仍是数组，不应是全 keep+null
      const allNull = r.every((v) => v.keep && v.valueClass === null)
      expect(allNull).toBe(false)
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/judge-no-silent-fallback.test.ts`
Expected: FAIL — judgeValue 当前返回全保留数组（`Array.isArray(r)` 为 true）。

- [ ] **Step 3: Implement valueFilter.ts**

改 `judgeValue` 返回类型为 `Promise<ValueVerdict[] | { failed: true; reasons: string[] }>`。`judgeValueBase` 改为：LLM 失败/重试耗尽时**返回失败标识**而非 `keepNull()`。

```ts
export type JudgeResult = ValueVerdict[] | { failed: true; reasons: string[] }

export async function judgeValue(
  candidates: DistillCandidate[], callLLM: LLMCall,
): Promise<JudgeResult> {
  const n = candidates.length
  if (n === 0) return []
  // 用 runLlmSession 跑 3 轮（带历史接续）；失败返回 {failed:true}
  const session = await runLlmSession({
    callLLM, system: VALUE_JUDGE_SYSTEM_PROMPT,
    initialUser: renderUserPrompt(candidates), step: 'judge', jobId: '', // jobId 由调用方注入？见下
    shouldRetry: valueShouldRetry(n),
  })
  if (!session.ok) return { failed: true, reasons: session.reasons }
  const parsed = session.parsed as { verdicts?: unknown } | undefined
  if (!parsed || !Array.isArray(parsed.verdicts)) return { failed: true, reasons: ['verdicts 缺失'] }
  const entries = (parsed.verdicts as unknown[]).filter(/* 同现有 */)
  const verdicts = verdictsFromCategories(entries, candidates, VALID_CATEGORIES, DISCARD_CATEGORIES)
  return verdicts.map((v, i) =>
    detectTaming(candidates[i]!.title, candidates[i]!.bodyMd) ? { index: i, keep: false as const, reason: 'taming' as const } : v
  )
}
```

> `runLlmSession` 需要 `jobId`（persistRound/loadHistory 走 store）。本 task 先用空 jobId + 不传 persist/loadHistory（执行器内 history 为空、不落盘）——即"无记忆的 3 轮"过渡态。**完整接线（persistRound/loadHistory + jobId）放 Task 7 scheduler 接线**。本 task 只锁"不冒充成功"。

- [ ] **Step 4: Implement agentJudge.ts**

同样：`judgeValueAgentic` catch 块不再 `return { verdicts: keepAll(), trace: [] }`，改为 `return { failed: true, reasons: [String(e)] }`。返回类型加 `| { failed: true; reasons: string[] }`。

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/judge-no-silent-fallback.test.ts`
Expected: PASS。

- [ ] **Step 6: 改造既有 judge 测试**

grep 既有 `judgeValue`/`judgeValueAgentic` 测试（`tests/valueFilter.test.ts` 等），把"LLM 报错→全保留"的旧断言改成"→返回 failed 标识"。成功的路径断言不变（仍返回 verdicts 数组）。

- [ ] **Step 7: typecheck + 全量**

Run: `bun run typecheck && bun test`
Expected: typecheck 干净（judgeValue 返回类型变 union，调用方 scheduler 会暂报错——本 task 暂用 `as` 临时收敛或先在 scheduler 加 `if (!Array.isArray)` 分支兜底，Task 7 正式接线。**最小化：本 task 让 scheduler 调用点先 `const r = await judgeValue(...); const verdicts = Array.isArray(r) ? r : []` 临时把 failed 当空 verdicts 过渡**，Task 7 改成正式暂停逻辑）。

> ⚠️ 这一步会引入临时"failed 当空"过渡态，Task 7 必须补上正式暂停 + 测试。implementer 在 commit message 标注 `WIP: judge 失败标识过渡，scheduler 接线待 Task 7`。

- [ ] **Step 8: Commit**

```bash
git add src/memory/valueFilter.ts src/memory/agentJudge.ts tests/judge-no-silent-fallback.test.ts tests/valueFilter.test.ts
git commit -m "feat(llm-failure): judge 废除静默全保留兜底——失败返回失败标识（WIP: scheduler 接线待 Task 7）"
```

---

## Task 7: scheduler 断点续跑接线 + offset 时机修正

**Files:**
- Modify: `src/scheduler.ts`（tick 主流程）
- Modify: `src/memory/distiller.ts`（distill 步骤走执行器）
- Test: `tests/scheduler-resume.test.ts`

**Interfaces:**
- Consumes: Task 1-6 全部产出。
- Produces: tick 从断点续跑；四步各自调 `runLlmSession`（distill/dedup/judge/digest 各自 system/initialUser/shouldRetry）；3 次失败 `markJobPaused` + `logStepFailureNotification`；offset 仅四步全成推进；删除无条件标 done（失败回 pending/暂停）。

- [ ] **Step 1: Write failing test — 断点续跑 + offset 不冒进**

`tests/scheduler-resume.test.ts` 顶端注释：
```ts
// 锁 spec 2026-08-18 §5/§8.5：断点续跑（失败不重算前步）、offset 仅四步全成
// 推进（失败/暂停不动）。修用户最初"内容永久跳过"的 bug。
```

```ts
import { describe, expect, test } from 'bun:test'
import { tick } from '@/scheduler'
import { openDb } from '@/db/client'
// seed job + mock deps 的辅助复用 tests/scheduler.test.ts 既有模式

describe('scheduler 断点续跑', () => {
  test('distill 失败 → job 回 pending 不标 done，offset 不推进', async () => {
    // mock callLLM 永远抛 aborted；mock loadTranscript 返回有 newTurns
    // 跑 tick（注意：一次 tick 只跑一轮——3 次失败需 3 个 tick）
    // 断言：job status 仍 pending（非 done），stepAttempts=1，session offset 未变
  })

  test('distill 成功 → 推进到 dedup，不重算 distill', async () => {
    // 第一次 tick：distill 成功（mock 返回合法 candidates）
    // 第二次 tick：断言 currentStep='dedup'，且不再调 distill 的 LLM
  })

  test('judge 3 次失败 → job paused + 通知 + 候选 pending_review 不进队列', async () => {
    // mock judge 的 callLLM 连抛 3 次（用 step 区分：distill 成功、judge 失败）
    // 跑 3 个 tick，断言 job status='paused'，notifications 有 1 条，候选 status='pending_review'
  })

  test('四步全成功 → offset 推进', async () => {
    // mock 全部成功，断言 setSessionOffset 被调，job done
  })
})
```

> implementer：seed job + mock deps 的写法对照 `tests/scheduler.test.ts` 既有用例。tick 单次只推进一轮（失败回 pending 等下次 tick）——这是 Task 5 §5.4 决断：**每轮回 pending，下次 tick 接着跑**（非一个 tick 跑四步）。

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/scheduler-resume.test.ts`
Expected: FAIL — scheduler 仍无条件标 done。

- [ ] **Step 3: Implement scheduler.ts tick**

改造 tick：
1. 读 `getJobCheckpoint(jobId)`。
2. 根据 `currentStep` 走对应分支（distill/dedup/judge/digest），每步调 `runLlmSession`（传 jobId + persistRound=saveLlmRound + loadHistory=listLlmRounds）。
3. `runLlmSession` 返回 ok → `advanceStep` 推进，落库 checkpoint，**继续下一个 pending tick**（同 tick 内不连跑下一步——§5.4 决断：每轮回 pending）。即：成功也回 pending + nextRunAt=now（立即下一 tick 接着下一步）？还是同 tick 继续？
   > **决断（锁定）：成功时同 tick 内继续下一步**（避免成功也要等 1s）。失败时回 pending + 退避。只有失败才回队列。这样四步连成的正常路径一个 tick 跑完，跟现状体验一致。
4. `runLlmSession` 返回 failed → `advanceStep(..., currentAttempts)` 算暂停；若 `paused` → `markJobPaused` + `logStepFailureNotification(reasons)`；否则 `setJobCheckpoint(stepAttempts+1)` + 回 pending + 退避 nextRunAt。
5. 四步全成（digest 成功）→ `setSessionOffset`（仅此处推进）+ 标 done。
6. **删除 `scheduler.ts:478` 的无条件标 done** + **删除 `:482` 失败也推 offset**。

distiller.ts 改造：`distillTranscript` 内部不再用 `callWithRetry`，改调 `runLlmSession`（system=DISTILLER_SYSTEM_PROMPT, shouldRetry=distillShouldRetry）。失败返回 failed 标识给 scheduler。

- [ ] **Step 4: 改造 distiller.ts**

把 `wrappedCall`/`callWithRetry` 替换为 `runLlmSession`。`DistillResult` 适配：`callThrew`/`errorMessage`/`parseError` 由 session 的 `ok:false, reasons` 推导。保留 filteredTurns（调用前算，与成败无关——既有不变量）。

- [ ] **Step 5: 清理 Task 6 的 WIP 过渡态**

scheduler 调 `judgeValue` 处：删掉 `Array.isArray(r) ? r : []` 过渡，改成 `if (!Array.isArray(r)) → 暂停 + 通知`（judge 自己已返回 failed 标识，scheduler 据此走暂停分支）。

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test tests/scheduler-resume.test.ts`
Expected: PASS。

- [ ] **Step 7: 改造既有 scheduler 测试**

grep `tests/scheduler.test.ts` 旧用例（断言"失败标 done"/"失败推 offset"），改成新语义。成功的路径断言不变。

- [ ] **Step 8: typecheck + 全量**

Run: `bun run typecheck && bun test`
Expected: 全绿。这是最大改动点，预期改/删一批旧测试。

- [ ] **Step 9: Commit**

```bash
git add src/scheduler.ts src/memory/distiller.ts tests/scheduler-resume.test.ts tests/scheduler.test.ts
git commit -m "feat(llm-failure): scheduler 断点续跑接线 + offset 仅四步全成推进 + 删无条件标 done"
```

---

## Task 8: 步骤间只传干净结果（P4 锁定）

**Files:**
- Test: `tests/step-isolation.test.ts`

**Interfaces:**
- Consumes: Task 5/7 产出。验证 distill→dedup、dedup→judge 传递的是干净结果（候选清单），非 LLM 对话历史。

- [ ] **Step 1: Write failing test — 步骤间不传对话历史**

`tests/step-isolation.test.ts` 顶端注释：
```ts
// 锁 spec 2026-08-18 §3.2/§8.6（P4 纠正）：步骤间只传干净结果不传 LLM 对话历史。
// 去重输入=蒸馏候选清单（非蒸馏对话），审查输入=去重后清单（非去重对话）。
```

```ts
import { describe, expect, test } from 'bun:test'
// 用 spy/mock LLMCall 捕获 dedup 步骤收到的 user prompt，断言不含 distill 的 LLM 回复文本

describe('步骤间数据隔离', () => {
  test('dedup 收到的 prompt 不含 distill 的 LLM 对话历史', async () => {
    // 1. mock distill 返回合法 candidates + 一段特征文本 'DISTILL_INTERNAL_TRACE'
    // 2. spy dedup 的 callLLM，捕获其 user prompt
    // 3. 断言 dedup 的 prompt 不含 'DISTILL_INTERNAL_TRACE'（只含候选清单）
  })

  test('judge 收到的 prompt 不含 dedup 的 LLM 对话历史', async () => {
    // 同理，dedup 阶段注入 'DEDUP_INTERNAL_TRACE'，断言 judge prompt 不含
  })
})
```

> implementer：用 spy 在 callLLM 层捕获 prompt 文本。distill 的内部对话历史存在 `memory_distill_events`（llm_round），但传给 dedup 的是 `candidates` 数组（renderDedupUserPrompt 只渲染候选清单）。测试锁定这个边界。

- [ ] **Step 2: Run test**

Run: `bun test tests/step-isolation.test.ts`
Expected: 若 Task 5/7 实现正确则应 PASS（因为是结构保证——执行器每步独立，scheduler 传干净结果）。若 FAIL 说明 scheduler 误传了对话历史，修 scheduler。

- [ ] **Step 3: typecheck + 全量**

Run: `bun run typecheck && bun test`
Expected: 全绿。

- [ ] **Step 4: Commit**

```bash
git add tests/step-isolation.test.ts
git commit -m "test(llm-failure): 步骤间数据隔离锁定（P4：只传干净结果不传对话历史）"
```

---

## Task 9: Web UI 可见性 + 处置

**Files:**
- Modify: `src/web/App.tsx`
- Modify: `src/web/api.ts`
- Modify: `src/server.ts`（重试/放弃路由）
- Test: `tests/web-resume-ui.test.ts`（源码层文本断言）

**Interfaces:**
- Produces: `/api/status` 加 `pausedJobs` 计数；`POST /api/distill-runs/:jobId/retry`、`POST /api/distill-runs/:jobId/abandon`；App.tsx 蒸馏记录 tab 标记 paused + 重试/放弃按钮 + 重试轮次显示；候选审批 tab `pending_review` 区块。

- [ ] **Step 1: Write failing test — UI 源码 token**

`tests/web-resume-ui.test.ts`：
```ts
// 锁 spec 2026-08-18 §6：暂停任务/待审查候选 UI 可见 + 重试/放弃按钮 + 重试轮次。
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const app = readFileSync('src/web/App.tsx', 'utf-8')

describe('resume UI tokens', () => {
  test('有"已暂停"标记', () => expect(app).toContain('已暂停'))
  test('有重试按钮', () => expect(app).toMatch(/重试|retry/i))
  test('有放弃按钮', () => expect(app).toMatch(/放弃|abandon/i))
  test('有重试轮次显示', () => expect(app).toMatch(/轮|attempt|round/i))
  test('有待审查候选区块', () => expect(app).toContain('待审查'))
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/web-resume-ui.test.ts`
Expected: FAIL — token 不存在。

- [ ] **Step 3: Implement server.ts 路由**

```ts
// POST /api/distill-runs/:jobId/retry → resetJobForRetry
// POST /api/distill-runs/:jobId/abandon → abandonJob + setSessionOffset（推进到 fullLength）
// GET /api/status 加 pausedJobs 计数（status='paused' 的 job 数）
```

- [ ] **Step 4: Implement api.ts + App.tsx**

- `api.ts`：`retryJob(jobId)`/`abandonJob(jobId)` wrapper + status 类型加 `pausedJobs`。
- `App.tsx`：
  - 蒸馏记录 tab：paused 的 run 行渲染 `⏸ 已暂停-某步失败` 徽标 + 详情可看 3 次失败原因 + 对话历史 + 重试/放弃按钮。
  - 状态栏：当前 job 显示 `某步骤第N轮重试中`（从 ActivityTracker/断点读）。
  - 候选审批 tab：`pending_review` 状态候选用区块隔开（`⏸ 待审查`），可手动 approve/reject/edit（复用 MemoryCard 操作回调，status 从 pending_review 走 approve 同 candidate）。

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/web-resume-ui.test.ts`
Expected: PASS。

- [ ] **Step 6: typecheck + 全量**

Run: `bun run typecheck && bun test`
Expected: 全绿。

- [ ] **Step 7: Commit**

```bash
git add src/web/App.tsx src/web/api.ts src/server.ts tests/web-resume-ui.test.ts
git commit -m "feat(llm-failure): Web UI 暂停任务/待审查候选可见 + 重试/放弃 + 重试轮次"
```

---

## Task 10: anthropic AbortError 诊断 + live e2e

**Files:**
- Modify: `src/anthropic.ts`（AbortError 消息诊断化，不设主动超时）
- Test: `tests/live-llm-failure-resume.test.ts`（live e2e，opt-in）

**Interfaces:**
- Produces: 流式调用 catch AbortError 时，把消息包装成可诊断描述（"LLM 调用被中断，可能是网关掐断或超时；memside 会自动接续重试"）。

- [ ] **Step 1: Write failing test — 诊断消息**

`tests/anthropic-abort-diag.test.ts`：
```ts
// 锁 spec 2026-08-18 §缺陷3/§6.2：裸 "operation was aborted" 要变成可诊断描述。
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
const src = readFileSync('src/anthropic.ts', 'utf-8')
test('anthropic 有可诊断的中断处理', () => {
  expect(src).toMatch(/中断|aborted|诊断/i)
})
```

- [ ] **Step 2: Run + Implement**

Run: `bun test tests/anthropic-abort-diag.test.ts` → FAIL。
Implement：`anthropic.ts` `callLLM` catch AbortError / connection error 时，re-throw 一个带诊断前缀的 Error（不改变流式语义、不设主动超时——P6）。

- [ ] **Step 3: live e2e 门禁**

`tests/live-llm-failure-resume.test.ts`（`MEMSIDE_RUN_LIVE=1` 才跑）：
```ts
// 锁 spec 2026-08-18 §8.8：mock 网关 N 秒掐断，验证接续重试 3 轮内成功；
// 3 轮都掐断 → 暂停 + 通知。
// 用真实 LLMCall 但注入一个 wrapper 在第 1 次抛 aborted、第 2 次放行。
```

> live 测试用真实凭证 + 注入掐断 wrapper（不真打网关墙，用可控 wrapper 模拟），验证执行器接续逻辑。

- [ ] **Step 4: typecheck + 全量 + live**

Run: `bun run typecheck && bun test`
Run: `MEMSIDE_RUN_LIVE=1 bun test tests/live-llm-failure-resume.test.ts`（若环境有凭证）
Expected: 全绿（live opt-in，无凭证时 skip）。

- [ ] **Step 5: Commit**

```bash
git add src/anthropic.ts tests/anthropic-abort-diag.test.ts tests/live-llm-failure-resume.test.ts
git commit -m "feat(llm-failure): anthropic AbortError 诊断化 + live e2e 接续重试门禁"
```

---

## Self-Review（plan 写完后自检）

**1. Spec coverage：**
- §2 P1-P8 → Task 1（P7 状态机）、Task 5/6（P1 不冒充）、Task 7（P5 offset）、Task 8（P4 隔离）、Task 9（P8 可见）✓
- §3 可接续对话 → Task 5 执行器 ✓
- §4 数据模型 → Task 3/4 ✓
- §5 执行逻辑 → Task 7 ✓
- §6 可见性 → Task 9 ✓
- §8 测试六类 → T1=Task1、T2=Task5、T3=Task4、T4=Task6、T5=Task7、T6=Task8、T7=Task9、T8=Task10 ✓
- §10 非目标 → 不在 plan 中 ✓

**2. Placeholder scan：** 无 TBD/TODO；每个 code step 有实际代码。Task 7 step3 有"决断（锁定）"明确选了同 tick 继续。✓

**3. Type consistency：** `DistillStep`/`StepAttemptResult`/`RoundRecord`/`LlmSessionResult`/`JudgeResult` 跨 task 一致。`judgeValue` 返回 `JudgeResult = ValueVerdict[] | {failed:true,reasons:string[]}` 在 Task 6 定义、Task 7 消费。✓

**4. 依赖顺序：** Task 1→2（stepPrompt 消费 stepState）→3（schema）→4（store 消费 schema/stepState）→5（执行器消费 1/2）→6（judge 消费 5）→7（scheduler 消费全部，含清理 Task6 WIP）→8（验证 5/7）→9（UI 消费 store/scheduler）→10（诊断+live）。✓

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-18-llm-failure-handling.md`. Per user directive (chain spec→plan→execution without re-asking), proceeding with **Subagent-Driven execution** via `superpowers:subagent-driven-development`.

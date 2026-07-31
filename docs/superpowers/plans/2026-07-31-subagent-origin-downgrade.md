# subagent 蒸馏 origin 强制降级 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 subagent 蒸馏任务产出的候选记忆 origin 一律为 `agent-observed`(不再被错标成 user-stated/user-claimed),并回填存量。

**Architecture:** distiller 的 `DistillInput` 加可选 `sourceKind`(默认 `'conversation'`);`distillTranscript` 解析每条候选时,若 `sourceKind==='subagent'` 则把 origin 强制改为 `'agent-observed'`(在现有贴金防护之后,最防御)。scheduler 调 distillTranscript 时传 `sourceKind: job.sourceAgentId ? 'subagent' : 'conversation'`(复用已在用的谓词)。client.ts openDb 迁移块加一条幂等 UPDATE 回填存量 subagent candidate。

**Tech Stack:** Bun + TypeScript + bun:sqlite + drizzle-orm + bun:test

## Global Constraints

- 来源 spec:`docs/superpowers/specs/2026-07-31-subagent-origin-downgrade-design.md`(已 commit)。
- `sourceKind` 必须**可选 + 默认 `'conversation'`**--全仓 27 个 distillTranscript 测试调用点不传它,强制必填会破坏既有套件(spec §3.1)。
- 降级行必须放在贴金防护(`if (origin !== 'agent-observed' && evidence === null) origin = 'agent-observed'`)**之后**,确保 subagent 覆盖一切(spec §3.2)。
- **evidence 不动**:LLM 摘的句子保留作观察依据,只摘 origin 帽子(spec §3.2)。
- 回填 UPDATE 必须放在 client.ts 的 `origin` 列 ALTER 迁移块**之后**(确保列已存在),且范围限定 `status='candidate'`(spec §3.4)。
- 每任务结束 `bun run typecheck && bun test` 必须全绿才能进下一任务(CLAUDE.md)。
- 不碰 valueFilter / prompt / store schema / Web UI(spec §2 非目标)。

---

### Pre-execution gate: 清理 .superpowers/sdd/

CLAUDE.md 强制:spec、plan 落档后、开始写代码前,必须删除 `.superpowers/sdd/` 下所有文件(设计阶段中间产物)。当前目录下有遗留的 `2026-07-31-opencode-support`(opencode 已合并、stale)。

- [ ] **Step 0: 清理 sdd**

```bash
rm -rf .superpowers/sdd/
```

确认 `.superpowers/sdd/` 不存在或为空后再开始 Task 1。

---

### Task 1: distiller 加 sourceKind 字段 + subagent origin 降级

**Files:**
- Modify: `src/memory/distiller.ts`(`DistillInput` 接口 90-98 行;`distillTranscript` 逐候选循环 217 行附近)
- Test: `tests/distiller.test.ts`(末尾追加 3 个 test)

**Interfaces:**
- Consumes: 无(本任务自包含)
- Produces: `DistillInput.sourceKind?: 'subagent' | 'conversation'`(可选,默认 `'conversation'`);`distillTranscript` 在 subagent 输入下保证 `candidate.origin === 'agent-observed'`。Task 2 依赖此字段与行为。

- [ ] **Step 1: 写失败测试 1(核心回归锁)**

在 `tests/distiller.test.ts` 末尾追加:

```ts
test('distillTranscript 强制降级 subagent 候选 origin 为 agent-observed（核心回归锁）', async () => {
  // spec §3.2：subagent 的 role:user 是主 agent task brief，非真人陈述。
  // 即使 LLM 标 user-stated 且 evidence 非空（贴金防护不会降级），subagent 仍强制降级。
  const result = await distillTranscript({
    turns: [{ role: 'user', content: 'You are implementing Task 1: ...' }],
    runtime: 'claude-code', cwd: '/x', existingSlugs: [],
    sourceKind: 'subagent',
    callLLM: async () => JSON.stringify({ candidates: [{
      title: '[category:convention] 不改任务范围外代码', bodyMd: 'b',
      scope: 'project', runtime: 'claude-code', distillAction: 'new',
      origin: 'user-stated', evidence: 'Do not change anything outside this task scope',
    }] }),
  })
  expect(result.candidates[0]!.origin).toBe('agent-observed')
  // evidence 保留作观察依据（spec §3.2：只摘 origin 帽子，不动 evidence）
  expect(result.candidates[0]!.evidence).toBe('Do not change anything outside this task scope')
})
```

- [ ] **Step 2: 写失败测试 2(守默认方向)**

追加:

```ts
test('distillTranscript 不传 sourceKind 时 conversation 路径保留 user-stated（守默认方向）', async () => {
  // spec §3.1：sourceKind 可选默认 'conversation'。主会话 user-stated 不被降级，
  // 既有行为不变（27 个既有调用点都不传 sourceKind）。
  const result = await distillTranscript({
    turns: [{ role: 'user', content: '任何改动必须走分支+PR' }],
    runtime: 'claude-code', cwd: '/x', existingSlugs: [],
    callLLM: async () => JSON.stringify({ candidates: [{
      title: '[category:convention] 任何改动必须走分支+PR', bodyMd: 'b',
      scope: 'project', runtime: 'claude-code', distillAction: 'new',
      origin: 'user-stated', evidence: '任何改动必须走分支+PR',
    }] }),
  })
  expect(result.candidates[0]!.origin).toBe('user-stated')
})
```

- [ ] **Step 3: 写失败测试 3(subagent 也覆盖 user-confirmed)**

追加:

```ts
test('distillTranscript subagent 也覆盖 user-confirmed（不只 stated）', async () => {
  // spec §3.2：subagent 降级对 stated 与 confirmed 一视同仁。user-confirmed + 非空 evidence
  // 时贴金防护不会降级，唯有 subagent 标志把它压成 agent-observed。
  const result = await distillTranscript({
    turns: [{ role: 'user', content: 'You are implementing Task 2: ...' }],
    runtime: 'claude-code', cwd: '/x', existingSlugs: [],
    sourceKind: 'subagent',
    callLLM: async () => JSON.stringify({ candidates: [{
      title: '[category:architecture] x', bodyMd: 'b',
      scope: 'project', runtime: 'claude-code', distillAction: 'new',
      origin: 'user-confirmed', evidence: '用户采纳：本地 plugin 文件（推荐）',
    }] }),
  })
  expect(result.candidates[0]!.origin).toBe('agent-observed')
})
```

- [ ] **Step 4: 跑测试确认全失败**

Run: `bun test tests/distiller.test.ts`
Expected: 3 个新测试 FAIL。测试 1/3 因 `origin` 仍为 `'user-stated'`/`'user-confirmed'` 失败(distiller 还没读 sourceKind);测试 2 应当 PASS(默认行为本就保留 user-stated)--若测试 2 FAIL 说明 TS 报 `sourceKind` 不在类型里,亦属预期失败。

- [ ] **Step 5: 加 sourceKind 字段到 DistillInput**

修改 `src/memory/distiller.ts` 的 `DistillInput` 接口(90-98 行),在 `callLLM` 字段后加:

```ts
export interface DistillInput {
  turns: TranscriptTurn[]
  runtime: 'claude-code' | 'opencode'
  cwd: string
  /** 该 scope 现有 slug 清单（scheduler 查询注入），prompt 附给模型促复用（spec D3）。 */
  existingSlugs: string[]
  /** Injected seam; production wires the real Anthropic call, tests pass a mock. */
  callLLM: LLMCall
  /** 来源类型。subagent -> 候选 origin 强制降级 agent-observed；可选，默认 'conversation'（spec §3.1）。 */
  sourceKind?: 'subagent' | 'conversation'
}
```

- [ ] **Step 6: 加 subagent 降级行**

在 `distillTranscript` 的逐候选循环里,找到贴金防护那一行(约 217 行):

```ts
      // 贴金防护（spec §R1）：摘不出原话就不许戴 user-stated/user-confirmed 的帽子。
      if (origin !== 'agent-observed' && evidence === null) origin = 'agent-observed'
```

在其**之后**、`out.push({` **之前**加:

```ts
      // subagent 降级（spec §3.2）：subagent 的 role:user 是主 agent 派发的 task brief，
      // 非真人陈述。强制 agent-observed，不享受 stated 免疫。evidence 保留作观察依据。
      if (input.sourceKind === 'subagent') origin = 'agent-observed'
```

- [ ] **Step 7: 跑测试确认全过**

Run: `bun test tests/distiller.test.ts`
Expected: 全部 PASS(含 3 个新测试 + 既有 origin/evidence 测试不被破坏)。

- [ ] **Step 8: typecheck + 全量回归**

Run: `bun run typecheck && bun test`
Expected: 全绿。既有 27 个 distillTranscript 调用点因 sourceKind 可选不受影响。

- [ ] **Step 9: Commit**

```bash
git add src/memory/distiller.ts tests/distiller.test.ts
git commit -m "fix(distiller): subagent 候选 origin 强制降级 agent-observed

subagent 蒸馏的 role:user 是主 agent task brief 非真人陈述。
DistillInput 加可选 sourceKind（默认 conversation）；subagent 时
origin 一律降级 agent-observed（贴金防护之后，最防御），evidence 保留。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: scheduler 接线传 sourceKind

**Files:**
- Modify: `src/scheduler.ts`(`tick` 内 `distillTranscript` 调用 158-164 行)
- Test: `tests/scheduler.test.ts`(末尾追加 1 个 test)

**Interfaces:**
- Consumes: Task 1 的 `DistillInput.sourceKind` 字段及其降级行为。
- Produces: scheduler 对 subagent job(`job.sourceAgentId` 非空)调用 distillTranscript 时传 `sourceKind:'subagent'`,使产出的候选 origin 为 `agent-observed`。

- [ ] **Step 1: 写失败测试**

在 `tests/scheduler.test.ts` 末尾追加(参照既有「tick 入库候选携带 origin/evidence」测试 289-314 行的 harness):

```ts
test('tick 对 subagent job 的候选强制降级 origin 为 agent-observed', async () => {
  // spec §3.3：job.sourceAgentId 非空 -> distillTranscript 收到 sourceKind='subagent'
  // -> 候选 origin 被降级。用既有 tick harness：enqueue subagent job + fake loadTranscript
  // + callCount 分派 mock。distill 返回 origin='user-stated'；dedup 无 existing 短路；
  // judgeValue 返回 keep。断言 createCandidate 收到的 input.origin === 'agent-observed'。
  const { jobId } = await enqueueDistillJob(db, {
    sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1',
    debounceMs: 0, sourceAgentId: 'agent-1',
  })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  let captured: any = null
  let callCount = 0
  await tick(db, {
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'You are implementing Task 1' }], fullLength: 1 }),
    callLLM: async () => {
      callCount++
      if (callCount === 1) return JSON.stringify({ candidates: [{ title: '[category:convention] t', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new', origin: 'user-stated', evidence: 'Do not change anything outside this task scope' }] })
      return JSON.stringify({ verdicts: [{ index: 0, category: 'decision' }] })
    },
    createCandidate: async (_db, input) => { captured = input; return { id: 'c1', status: 'candidate', version: 1 } as any },
  })
  expect(captured).not.toBeNull()
  expect(captured.origin).toBe('agent-observed')
  expect(captured.sourceKind).toBe('subagent')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/scheduler.test.ts -t "subagent job"`
Expected: FAIL,`captured.origin` 为 `'user-stated'`(scheduler 还没传 sourceKind,distiller 默认 conversation 不降级)。

- [ ] **Step 3: 接线传 sourceKind**

修改 `src/scheduler.ts` 的 `distillTranscript` 调用(158-164 行),在 `callLLM: deps.callLLM,` 之后加一行:

```ts
      const { candidates, filteredTurns, rawOutput, rawCount, callThrew, errorMessage } = await distillTranscript({
        turns: newTurns,  // 只喂新增 turn，不再全量
        runtime: job.runtime as 'claude-code' | 'opencode',
        cwd: job.cwd ?? '',
        existingSlugs,
        callLLM: deps.callLLM,
        sourceKind: job.sourceAgentId ? 'subagent' : 'conversation',
      })
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/scheduler.test.ts -t "subagent job"`
Expected: PASS。

- [ ] **Step 5: typecheck + 全量回归**

Run: `bun run typecheck && bun test`
Expected: 全绿。

- [ ] **Step 6: Commit**

```bash
git add src/scheduler.ts tests/scheduler.test.ts
git commit -m "fix(scheduler): subagent job 传 sourceKind 触发 distiller origin 降级

job.sourceAgentId 非空时传 sourceKind='subagent'（复用 :186/:200
已在用的谓词），让 distiller 把候选 origin 降级 agent-observed。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: client.ts 幂等回填存量 subagent candidate

**Files:**
- Modify: `src/db/client.ts`(openDb 迁移块,`origin`/`evidence` ALTER 块之后,约 239 行后)
- Test: `tests/client-backfill-subagent.test.ts`(新建)

**Interfaces:**
- Consumes: 无(纯 DB 迁移,独立于 Task 1/2)。
- Produces: openDb 每次打开时,把 `source_kind='subagent' AND status='candidate'` 的行 origin 回填为 `'agent-observed'`(幂等)。

> **说明:** 回填 SQL 在 spec §3.4 基础上加 `AND (origin IS NULL OR origin != 'agent-observed')` 守卫。语义不变(仍覆盖 spec §6 的 NULL 行),但避免重复打开 DB 时对已翻转行产生 WAL 写放大。这是对 spec SQL 的严格改进,实现时按下方代码块为准。

- [ ] **Step 1: 写失败测试**

新建 `tests/client-backfill-subagent.test.ts`:

```ts
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { openDb, type DbClient } from '@/db/client'
import { memories } from '@/db/schema'
import { eq } from 'drizzle-orm'

const root = join(import.meta.dir, '.tmp-backfill-subagent')

beforeAll(() => { rmSync(root, { recursive: true, force: true }); mkdirSync(root, { recursive: true }) })
afterAll(() => { rmSync(root, { recursive: true, force: true }) })

test('backfill 把 subagent candidate origin 降级为 agent-observed，conversation 不动，且幂等', async () => {
  const path = join(root, 'b.db')
  let db: DbClient = openDb(path)
  // seed：一条 subagent candidate 错标 user-stated；一条 conversation candidate 正常 user-stated
  await db.insert(memories).values({
    id: '01BACKFILL', scopeType: 'project', scopeId: '/r',
    title: '[category:convention] t', bodyMd: 'b', tags: '[]',
    status: 'candidate', sourceKind: 'subagent', sourceCwd: '/r', runtime: null,
    createdAt: 1, version: 1, origin: 'user-stated', evidence: 'task brief',
  })
  await db.insert(memories).values({
    id: '02BACKFILL', scopeType: 'project', scopeId: '/r',
    title: '[category:convention] t2', bodyMd: 'b', tags: '[]',
    status: 'candidate', sourceKind: 'conversation', sourceCwd: '/r', runtime: null,
    createdAt: 2, version: 1, origin: 'user-stated', evidence: 'real user',
  })
  db.$client.close()

  // 重开：迁移块跑回填
  db = openDb(path)
  const sub = await db.select().from(memories).where(eq(memories.id, '01BACKFILL'))
  expect(sub[0]!.origin).toBe('agent-observed')     // subagent 被降级
  const conv = await db.select().from(memories).where(eq(memories.id, '02BACKFILL'))
  expect(conv[0]!.origin).toBe('user-stated')       // conversation 不动

  // 幂等：再重开一次，值不变
  db.$client.close()
  db = openDb(path)
  const sub2 = await db.select().from(memories).where(eq(memories.id, '01BACKFILL'))
  expect(sub2[0]!.origin).toBe('agent-observed')
  db.$client.close()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/client-backfill-subagent.test.ts`
Expected: FAIL,`sub[0]!.origin` 仍为 `'user-stated'`(回填 UPDATE 还没加)。

- [ ] **Step 3: 加回填迁移块**

在 `src/db/client.ts` 的 `origin`/`evidence` ALTER 迁移块(231-239 行的 `{ ... }` 块)**之后**、`error_message` ALTER 块(240 行起)**之前**,插入新迁移块:

```ts
  // Idempotent backfill: subagent 蒸馏候选 origin 强制降级 agent-observed（spec §3.4）。
  // subagent 的 role:user 是主 agent task brief，非真人陈述。范围限定 candidate
  // （approved origin 仅影响 UI 徽标；rejected 无意义）。放在 origin ALTER 块之后确保列已存在。
  // 守卫 (origin IS NULL OR origin != 'agent-observed')：幂等 + 覆盖 NULL 行 + 避免重复 WAL 写。
  {
    raw.exec("UPDATE memories SET origin = 'agent-observed' WHERE source_kind = 'subagent' AND status = 'candidate' AND (origin IS NULL OR origin != 'agent-observed')")
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/client-backfill-subagent.test.ts`
Expected: PASS。

- [ ] **Step 5: typecheck + 全量回归**

Run: `bun run typecheck && bun test`
Expected: 全绿。

- [ ] **Step 6: Commit**

```bash
git add src/db/client.ts tests/client-backfill-subagent.test.ts
git commit -m "fix(client): 回填存量 subagent candidate origin 为 agent-observed

openDb 迁移块加幂等 UPDATE：source_kind='subagent' AND
status='candidate' 的行 origin 翻 agent-observed（守卫避免重复
WAL 写，覆盖 NULL 行）。需重启 daemon 生效。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: 全量回归 + STATE.md 收尾

**Files:**
- Modify: `STATE.md`(追加本轮工作记录段)

**Interfaces:** 无(验证 + 文档收尾)。

- [ ] **Step 1: 全量门禁**

Run: `bun run typecheck && bun test`
Expected: 全绿(本任务预期在 Task 1-3 后已绿,此处为合并前最终确认)。

- [ ] **Step 2: STATE.md 追加工作记录**

在 `STATE.md` 末尾追加一段(参照既有「## ...」段落风格):

```markdown
## subagent 蒸馏 origin 强制降级（2026-07-31）

修复 subagent 蒸馏任务候选 origin 错标：subagent transcript 的 role:user 是
主 agent 派发的 task brief（非真人陈述），distiller 不知来源导致 47/52 条候选
被错标 user-stated/confirmed，被双重保护（derivable 免疫 + decision 兜底）锁定
只能逐条人工拒。设计 spec / 计划见 `docs/superpowers/specs|plans/
2026-07-31-subagent-origin-downgrade*`。

1. `DistillInput.sourceKind`（distiller.ts）可选字段默认 'conversation'；subagent
   时候选 origin 强制降级 agent-observed（贴金防护之后，最防御），evidence 保留。
2. scheduler tick 调 distillTranscript 传 `sourceKind: job.sourceAgentId ? 'subagent'
   : 'conversation'`（复用 :186/:200 谓词）。
3. client.ts openDb 加幂等回填 UPDATE（source_kind='subagent' AND status='candidate'
   -> origin='agent-observed'，守卫覆盖 NULL 行 + 避免重复 WAL 写）。

后果：降级后这些候选失去 stated 双重保护，回正常价值判定（临时指令可能被丢、
持久约定以 agent-observed 身份留下）。主会话侧 5 条 conversation 错标本轮不碰，
留人工。回填需重启 daemon 生效（与已知债务 #4 同款）。
```

- [ ] **Step 3: Commit**

```bash
git add STATE.md
git commit -m "docs(state): 记录 subagent origin 降级修复

Co-Authored-By: Claude <noreply@anthropic.com>"
```

- [ ] **Step 4: 推远端开 PR**

```bash
git push -u origin fix/subagent-origin-downgrade
gh pr create --base master --title "fix: subagent 蒸馏 origin 强制降级 agent-observed" --body "..."
```

PR body 末尾加:`🤖 Generated with [Claude Code](https://claude.com/claude-code)`

---

## Self-Review

**Spec coverage:**
- §3.1 DistillInput.sourceKind 可选默认 conversation -> Task 1 Step 5 ✓
- §3.2 贴金防护后降级 + evidence 不动 -> Task 1 Step 6 + 测试 1 的 evidence 断言 ✓
- §3.3 scheduler 传 sourceKind -> Task 2 Step 3 ✓
- §3.4 client 回填 UPDATE + 范围 candidate + 放 origin ALTER 之后 -> Task 3 Step 3 ✓
- §6 NULL 行被设 agent-observed -> 回填守卫 `(origin IS NULL OR ...)` ✓
- §7 测试 1-5 -> Task 1(3 单测)+ Task 2(1 集成)+ Task 3(1 幂等)✓
- §2 非目标(不动 valueFilter/prompt/store/UI)-> Global Constraints 锁定 ✓

**Placeholder scan:** 无 TBD/TODO;所有代码块完整。✓

**Type consistency:** `sourceKind` 在 DistillInput(Task 1)与 scheduler 调用(Task 2)拼写一致;scheduler 复用的 `job.sourceAgentId` 谓词与既有 :186/:200 一致;回填 SQL 列名 `source_kind`/`status`/`origin` 与 schema.ts 一致。✓

**测试 3 设计注记:** spec §7.1 测试 3 原写「subagent + user-confirmed + 空 evidence」。空 evidence 时贴金防护本就会降级,无法区分 subagent 标志是否生效。本计划改为「subagent + user-confirmed + 非空 evidence」--唯有 subagent 标志能把它压成 agent-observed,才是真正锁住降级独立生效的判别性测试。语义更严,已在上文 Step 3 落实。

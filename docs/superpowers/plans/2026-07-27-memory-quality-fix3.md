# 记忆质量修复第三轮 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 distiller 的 subject 判定流入 valueFilter prompt，补强 dogfood 场景下 derivable 判定精度；distiller subject 提示词加通用启发+占位符示例（防过拟合）。

**Architecture:** 不动第二轮条件门逻辑，只把 subject 信号从 distiller 透传到 valueFilter user prompt（每条候选带 `(subject: xxx)` 标记）+ valueFilter system prompt 加中性描述关联 derivable。valueFilter 仍跑完整 6 类，不跳过、不代码覆盖。distiller 提示词加通用判定启发 + 占位符示例让 subject 判定更准。

**Tech Stack:** Bun + Hono + Drizzle + bun:sqlite；LLMCall seam vendor-neutral；测试 bun:test。

## Global Constraints

- LLMCall seam 保持 vendor-neutral：核心模块只 `import type { LLMCall } from '@/llm'`。
- valueFilter 提示词受 neutrality 禁词约束：`VALUE_JUDGE_SYSTEM_PROMPT` 不得含 `discard/keep/dangerous/unsure/cautious/careful/reject/don't/avoid/important/valuable`（tests/valueFilter.test.ts:83-95 锁定）。本轮**第一次动 valueFilter 提示词措辞**，新措辞逐词核对。
- valueFilter 仍跑完整 6 类判定：不跳过、不代码覆盖。subject 只进 prompt 当提示，不进代码层 keep/discard 决策。
- 不动第二轮条件门逻辑（`cat ∈ PROTECTED && subject === 'domain'`）。
- 不加新 schema、不加新 LLM 调用、不加纯函数启发式。
- 前两轮修复（条件门/输入过滤/dedup bodyMd/64k 预算）全保留不回退。
- 测试随每次改动落地（TDD：先红后绿）；`bun run typecheck && bun test` 全绿才能 push。
- 分支 `feat/memory-quality-fix3`（已从最新 `origin/master` 切出），PR 目标 `master`。

---

## File Structure

| 文件 | 责任 | 本轮改动 |
|---|---|---|
| `src/memory/distiller.ts` | transcript -> DistillCandidate[] | DISTILLER_SYSTEM_PROMPT subject 指引追加通用启发+占位符示例 |
| `src/memory/valueFilter.ts` | 候选价值分类 + 条件门 | renderUserPrompt 加 subject 标记；VALUE_JUDGE_SYSTEM_PROMPT 加中性描述 |
| `tests/distiller.test.ts` | distiller 单测 | 新增 subject 启发+示例+防过拟合断言 |
| `tests/valueFilter.test.ts` | valueFilter 单测 | 新增 subject 标记+中性描述断言；neutrality 仍绿 |
| `tests/scheduler.test.ts` | e2e 门禁 | 新增 subject=codebase 设计决策被 derivable 丢弃 e2e |

---

## Task 1: distiller subject 提示词加固（通用启发 + 占位符示例）

**Files:**
- Modify: `src/memory/distiller.ts`（DISTILLER_SYSTEM_PROMPT，第 30 行"拿不准时标 codebase。"之后追加）
- Test: `tests/distiller.test.ts`

**Interfaces:**
- Consumes: 无（首个任务）
- Produces: DISTILLER_SYSTEM_PROMPT 含 subject 通用启发 + 占位符示例。无接口变更。

- [ ] **Step 1: 在 tests/distiller.test.ts 末尾追加 3 个新测试**

```ts
test('DISTILLER_SYSTEM_PROMPT has subject judgement heuristic (grep-able concrete things)', () => {
  // TDD（第三轮 §B）：dogfood 场景 subject 偏 domain，加判定启发让 LLM 区分
  // "仓库内能 grep 到的具体东西" vs "仓库外业务概念"。
  expect(DISTILLER_SYSTEM_PROMPT).toContain('grep')
  expect(DISTILLER_SYSTEM_PROMPT).toContain('具体东西')
})

test('DISTILLER_SYSTEM_PROMPT has generic placeholder subject examples', () => {
  // TDD（第三轮 §B）：通用占位符示例（X 模块的 Y 函数 / W 配置为值 V 等），
  // 示判定模式而非具体答案。
  expect(DISTILLER_SYSTEM_PROMPT).toContain('X 模块的 Y 函数')
  expect(DISTILLER_SYSTEM_PROMPT).toContain('W 配置为值 V')
  expect(DISTILLER_SYSTEM_PROMPT).toContain('外部系统 X 的 SLA 要求 Y')
})

test('DISTILLER_SYSTEM_PROMPT subject examples do not hardcode real memory symbols (anti-overfitting)', () => {
  // TDD（第三轮 §B 防过拟合硬约束）：示例不得针对已有记忆。断言 prompt 的示例区
  // 不含当前 dogfood 产物的真实符号--否则等于 hardcode 答案，换仓库就失效。
  // 注意：主体 prompt 仍会提到 valueFilter/daemon 等（作为 category 说明），这里只
  // 断言"通用示例"这一段不含这些词。取 subject 示例段（"通用示例"到段尾）校验。
  const prompt = DISTILLER_SYSTEM_PROMPT
  const exampleStart = prompt.indexOf('通用示例')
  expect(exampleStart).toBeGreaterThan(-1)
  const exampleSection = prompt.slice(exampleStart)
  // 真实记忆符号不得出现在示例段
  for (const real of ['valueFilter', 'token 预算', 'dedup', '64k', '条件门']) {
    expect(exampleSection).not.toContain(real)
  }
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test tests/distiller.test.ts`
Expected: FAIL - 3 个新测试失败（prompt 还没加启发/示例）。

- [ ] **Step 3: 在 DISTILLER_SYSTEM_PROMPT 追加 subject 启发 + 占位符示例**

`src/memory/distiller.ts`：找到"拿不准时标 codebase。"（第 30 行），在其**之后**（"Cross-cutting properties:"**之前**）插入：

```
判定时问自己：这条规则的主语，是这个仓库里能 grep 到的具体东西（文件、函数、配置项、模块名、某个常量值），还是一个仓库之外的业务/领域概念？
- 如果主语是仓库内的具体东西，即使规则本身听起来像"通用经验"，它也是 codebase--因为脱离这个仓库它就失去所指对象，或可从源码重新读出。
- 如果主语是仓库外的业务/领域概念（用户业务规则、外部系统契约、法规、跨项目共识），且换一个仓库依然成立，才是 domain。

通用示例（仅示判定模式，勿照抄内容）：
  codebase: "X 模块的 Y 函数以 Z 方式调用" -- 主语是仓库内符号
  codebase: "本项目把 W 配置为值 V" -- 主语是仓库内配置项
  codebase: "A 组件的 B 行为在 C 条件下触发" -- 主语是仓库内组件
  domain: "用户业务的退款须在发货后 N 天内" -- 主语是外部业务规则
  domain: "外部系统 X 的 SLA 要求 Y" -- 主语是仓库外契约
  domain: "法规要求 Z" -- 主语是仓库外法规
```

注意：插入位置在"拿不准时标 codebase。"这一行之后，空一行，再插上述内容，再空一行，然后是原来的"Cross-cutting properties:"。保持现有 prompt 其余部分字节不变。

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test tests/distiller.test.ts`
Expected: PASS（全部，含 3 个新测试 + 现有测试。特别注意 `DISTILLER_SYSTEM_PROMPT rejects codebase implementation details` 仍绿--追加内容不影响"被开发仓库自身源码的实现细节"断言）。

- [ ] **Step 5: typecheck**

Run: `bun run typecheck`
Expected: 干净（纯提示词文本追加，无类型变更）。

- [ ] **Step 6: Commit**

```bash
git add src/memory/distiller.ts tests/distiller.test.ts
git commit -m "feat(distiller): subject judgement heuristic + generic placeholder examples"
```

---

## Task 2: valueFilter 接收 subject 信号（prompt 标记 + 中性描述）

**Files:**
- Modify: `src/memory/valueFilter.ts`（renderUserPrompt 第 59-61 行 + VALUE_JUDGE_SYSTEM_PROMPT 第 28 行后）
- Test: `tests/valueFilter.test.ts`

**Interfaces:**
- Consumes: Task 1 的 DISTILLER_SYSTEM_PROMPT（无直接依赖，但同分支）。
- Produces: valueFilter user prompt 每条候选带 `(subject: xxx)` 标记；VALUE_JUDGE_SYSTEM_PROMPT 含 subject 中性描述。

- [ ] **Step 1: 在 tests/valueFilter.test.ts 末尾追加 3 个新测试**

```ts
test('judgeValue user prompt includes subject hint per candidate', async () => {
  // TDD（第三轮 §C）：valueFilter 判 derivable 缺"当前仓库"参照系。把 distiller 的
  // subject 信号透传到 user prompt，LLM 拿到 codebase/domain 标记后判 derivable 更准。
  let captured = ''
  const cCodebase: DistillCandidate = { title: '[category:architecture] x', bodyMd: 'b', scopeType: 'project', runtime: null, distillAction: 'new', subject: 'codebase' }
  const cDomain: DistillCandidate = { title: '[category:invariant] y', bodyMd: 'b', scopeType: 'project', runtime: null, distillAction: 'new', subject: 'domain' }
  await judgeValue([cCodebase, cDomain], async (_sys, user) => { captured = user; return verdictsJson({ index: 0, category: 'derivable' }, { index: 1, category: 'decision' }) })
  expect(captured).toContain('(subject: codebase)')
  expect(captured).toContain('(subject: domain)')
})

test('judgeValue user prompt defaults missing subject to codebase hint', async () => {
  // TDD（第三轮 §C）：subject 缺失时 prompt 标记应为 codebase（与 gate defaulting 一致）。
  let captured = ''
  const c = { title: '[category:x] y', bodyMd: 'b', scopeType: 'project', runtime: null, distillAction: 'new' } as DistillCandidate
  await judgeValue([c], async (_sys, user) => { captured = user; return verdictsJson({ index: 0, category: 'decision' }) })
  expect(captured).toContain('(subject: codebase)')
})

test('VALUE_JUDGE_SYSTEM_PROMPT has subject hint neutral description', () => {
  // TDD（第三轮 §C）：system prompt 加中性描述关联 subject 与 derivable。neutrality
  // 约束：不得含 keep/discard/reject/avoid/important/valuable/unsure/cautious/careful/don't/dangerous。
  expect(VALUE_JUDGE_SYSTEM_PROMPT).toContain('subject hint')
  expect(VALUE_JUDGE_SYSTEM_PROMPT).toContain('codebase-subject candidate')
  expect(VALUE_JUDGE_SYSTEM_PROMPT).toContain('design decisions')
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test tests/valueFilter.test.ts`
Expected: FAIL - 3 个新测试失败（prompt 还没加 subject 标记/中性描述）。

- [ ] **Step 3: 改 renderUserPrompt 加 subject 标记**

`src/memory/valueFilter.ts` 第 59-61 行：

旧：
```ts
function renderUserPrompt(candidates: DistillCandidate[]): string {
  return candidates.map((c, i) => `[${i}] ${c.title}\n${c.bodyMd}`).join('\n---\n')
}
```
新：
```ts
function renderUserPrompt(candidates: DistillCandidate[]): string {
  return candidates.map((c, i) => `[${i}] (subject: ${c.subject ?? 'codebase'}) ${c.title}\n${c.bodyMd}`).join('\n---\n')
}
```

（`c.subject ?? 'codebase'`：缺失默认 codebase，与第二轮 gate defaulting 一致。）

- [ ] **Step 4: 改 VALUE_JUDGE_SYSTEM_PROMPT 加中性描述**

`src/memory/valueFilter.ts`：在第 28 行（topology 定义 `from any single vantage point.`）之后、第 30 行（`Pick the best-fitting category...`）之前，插入空行 + 中性描述：

旧（第 27-30 行）：
```
6. topology - a cross-boundary connection (cross-module/service/team/repo) invisible
   from any single vantage point.

Pick the best-fitting category for each candidate. 输出格式如下...
```
新：
```
6. topology - a cross-boundary connection (cross-module/service/team/repo) invisible
   from any single vantage point.

Each candidate is marked with a subject hint: codebase (describes the current repository's own code/config/modules) or domain (describes something outside the repository). Apply the 6 categories above as written - a codebase-subject candidate that describes this repository's own design decisions, implementation rules, or internal behavior is derivable.

Pick the best-fitting category for each candidate. 输出格式如下...
```

**neutrality 逐词核对**（硬约束）：新句子含 `subject hint / codebase / describes / current repository / own code/config/modules / domain / outside / Apply / 6 categories / as written / codebase-subject candidate / design decisions / implementation rules / internal behavior / is derivable`。逐词排查禁词列表 `discard/keep/dangerous/unsure/cautious/careful/reject/don't/avoid/important/valuable`：**均不含**。`design` 不是禁词，`is derivable` 不含禁词。安全。

- [ ] **Step 5: 运行测试确认通过 + neutrality 仍绿**

Run: `bun test tests/valueFilter.test.ts`
Expected: PASS（全部，含 3 个新测试 + 现有测试）。**特别确认** `VALUE_JUDGE_SYSTEM_PROMPT is neutral (no bias words)` 仍绿--这是硬约束。同时 `VALUE_JUDGE_SYSTEM_PROMPT has sharpened derivable + public-knowledge definitions` 仍绿（新追加不影响 `THIS repository's current code/files/docs` 和 `do not belong here` 断言）。

- [ ] **Step 6: typecheck**

Run: `bun run typecheck`
Expected: 干净（renderUserPrompt 改动无类型变更；`c.subject ?? 'codebase'` 类型安全）。

- [ ] **Step 7: Commit**

```bash
git add src/memory/valueFilter.ts tests/valueFilter.test.ts
git commit -m "feat(valueFilter): pass subject hint into prompt + neutral derivable description"
```

---

## Task 3: e2e 门禁 - subject=codebase 设计决策被 derivable 丢弃

**Files:**
- Modify: `tests/scheduler.test.ts`

**Interfaces:**
- Consumes: Task 1-2 全部。scheduler tick 调用序不变（distill->dedup->judgeValue），subject 透传不感知。
- Produces: e2e 锁定 subject=codebase 设计决策候选被 derivable 丢弃。

- [ ] **Step 1: 在 tests/scheduler.test.ts 末尾追加 e2e 测试**

```ts
test('tick: codebase-subject design-decision candidate is derivable-discarded (e2e subject-driven derivable)', async () => {
  // TDD（第三轮 §D）：dogfood 场景下"关于当前仓库自身设计决策"的候选被 LLM 当 decision
  // 保留。现在 distiller 标 subject=codebase，valueFilter prompt 带 subject 标记 +
  // 中性描述关联 derivable -> LLM 判 derivable -> 丢弃。锁住 subject 信号端到端流转。
  // 根因见 spec §1.2（valueFilter 判 derivable 缺仓库参照系，靠 distiller subject 补强）。
  const { jobId } = await enqueueDistillJob(db, { sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0 })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  let createCalls = 0
  let callCount = 0
  await tick(db, {
    loadTranscript: async () => [{ role: 'user', content: 'token budget widened to 64k' }],
    callLLM: async () => {
      callCount++
      if (callCount === 1) return JSON.stringify({ candidates: [{ title: '[category:architecture] token 预算从 12k 扩到 64k', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new', subject: 'codebase' }] })
      // dedup short-circuits (1 candidate, no existing) -> call 2 is judgeValue;
      // subject=codebase + 仓库自身设计决策 -> derivable
      return JSON.stringify({ verdicts: [{ index: 0, category: 'derivable' }] })
    },
    createCandidate: async () => { createCalls++; return { id: 'c1', status: 'candidate', version: 1 } as any },
  })
  expect(callCount).toBe(2) // distill + judgeValue; dedup short-circuits
  expect(createCalls).toBe(0) // discarded, not created
  const rows = await db.select().from(memoryDiscards)
  expect(rows.length).toBe(1)
  expect(rows[0]!.reason).toBe('derivable')
})
```

注意：检查 scheduler.test.ts 顶部已 import `memoryDiscards`（第 8 行已有）、`enqueueDistillJob`/`tick`（第 6 行已有）。无需补 import。

- [ ] **Step 2: 运行测试确认通过**

Run: `bun test tests/scheduler.test.ts`
Expected: PASS。本任务是**确认**而非驱动--Task 2 已把 subject 信号接入 prompt，scheduler 路径透传 subject，故新 e2e（codebase 设计决策被 derivable 丢弃、createCalls=0、discards=1）应直接绿。若 FAIL，回查 Task 2 的 renderUserPrompt 是否加了 subject 标记 + VALUE_JUDGE_SYSTEM_PROMPT 是否加了中性描述。

注意：此测试 mock 的 judgeValue 直接返回 `category: 'derivable'`，所以它验证的是"subject=codebase 信号能流到 judgeValue 阶段且候选被丢弃"的端到端管道，而非 LLM 真的会判 derivable（LLM 行为由 Task 2 的 prompt 断言锁定，单测无法测真实 LLM）。这条 e2e 锁的是管道完整性 + 条件门不误救 codebase 候选。

- [ ] **Step 3: typecheck + 全量回归**

Run: `bun run typecheck && bun test`
Expected: typecheck 干净；`bun test` 全绿（所有任务改动汇合后无遗漏，前两轮测试全绿不回退）。

- [ ] **Step 4: Commit**

```bash
git add tests/scheduler.test.ts
git commit -m "test(scheduler): e2e subject-driven derivable (codebase design-decision discarded)"
```

---

## 完成后（非本计划任务，执行阶段之后）

- 推远端 + 开 PR 合并回 `master`（PR 标题 `feat(memory): 记忆质量修复第三轮 - subject 驱动 derivable`）。
- 合并后本地 `git branch -d feat/memory-quality-fix3` + `git fetch --prune`。
- 重启 daemon 验证：dogfood 场景下 codebase-subject 的仓库自身设计决策候选明显减少（derivable 拦截率上升）。

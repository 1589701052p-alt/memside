# 记忆质量修复第二轮 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 valueFilter 逻辑门只保护"外部业务领域"硬规则、不再保护"当前仓库自身代码"复述；dedup 跨批比对带 bodyMd 提升近义合并率；distill 输入预算 12k->64k、per-turn cap 翻倍。

**Architecture:** distiller 给每条候选标瞬态 `subject: 'codebase'|'domain'` 字段（不入库）；valueFilter gate 从无条件改为 `cat ∈ PROTECTED && subject === 'domain'`；dedup existing 比对带 bodyMd + prompt 加"同规则不同侧面=重复"指引；pure.ts 预算与 cap 放宽。subject 缺失/异常一律默认 codebase（精度优先，条件门单调向好）。

**Tech Stack:** Bun + Hono + Drizzle + bun:sqlite + zod；LLMCall seam vendor-neutral；测试 bun:test。

## Global Constraints

- LLMCall seam 保持 vendor-neutral：核心模块（distiller/dedup/valueFilter/scheduler）只 `import type { LLMCall } from '@/llm'`，不 import SDK。
- valueFilter 提示词受 neutrality 禁词约束：`VALUE_JUDGE_SYSTEM_PROMPT` 不得含 `discard/keep/dangerous/unsure/cautious/careful/reject/don't/avoid/important/valuable`（tests/valueFilter.test.ts:83 锁定）。本轮**不动 valueFilter 提示词**。
- 不引入新 schema 变更：`subject` 是 `DistillCandidate` 的瞬态字段，不进 `memories` 表、不持久化。
- `subject` 缺失/非法一律视为 `'codebase'`（不保护，走正常 derivable 判定）。
- 测试随每次改动落地（TDD：先红后绿）；`bun run typecheck && bun test` 全绿才能 push。
- 分支 `feat/memory-quality-fix2`（已从最新 `origin/master` 切出），PR 目标 `master`。

---

## File Structure

| 文件 | 责任 | 本轮改动 |
|---|---|---|
| `src/memory/distiller.ts` | transcript -> 带 subject 的 DistillCandidate[] | 提示词加 subject 字段+指引；invariant 定义收紧；distillShouldRetry 加 subject 校验；解析默认 codebase |
| `src/memory/valueFilter.ts` | 候选价值分类 + 条件门 | gate 两处加 `subject === 'domain'` 条件；缺失默认 codebase |
| `src/memory/dedup.ts` | 语义去重 | renderUserPrompt existing 行带 bodyMd；prompt 加同规则不同侧面指引 |
| `src/memory/store.ts` | listForDedupByScope | 多 SELECT bodyMd 列；ExistingMemoryForDedup 加字段 |
| `src/memory/pure.ts` | filterTranscriptForDistill 纯函数 | DEFAULT_DISTILL_INPUT_BUDGET_TOKENS 64k；per-turn cap 翻倍 |
| `tests/valueFilter.test.ts` | 条件门单测 | cand() 默认 domain；新增 codebase 不保护测试 |
| `tests/dedup.test.ts` | dedup 单测 | existing 带 bodyMd；同规则不同侧面合并 |
| `tests/distiller.test.ts` | distiller 单测 | subject 校验+默认；invariant 定义收紧 |
| `tests/pure-transcript-filter.test.ts` | 预算/cap 单测 | 64k + cap 翻倍后边界更新 |
| `tests/scheduler.test.ts` | e2e 门禁 | 第一轮测试加 subject=domain；新增反向 codebase 被丢弃 |

---

## Task 1: DistillCandidate 加 subject 字段 + distiller 提示词/解析/校验

**Files:**
- Modify: `src/memory/distiller.ts`（接口 + 提示词 + 校验 + 解析）
- Test: `tests/distiller.test.ts`

**Interfaces:**
- Consumes: 无（首个任务）
- Produces: `DistillCandidate.subject: 'codebase' | 'domain'`（必填，后续所有任务依赖此字段）。distiller 解析时 LLM 返回的 candidate JSON 里 subject 缺失/非法 -> 默认 `'codebase'`。

- [ ] **Step 1: 更新 `cand()` helper 与现有测试以带 subject**

`tests/distiller.test.ts` 现有 mock candidate JSON 不带 subject。本轮 distiller 解析会默认 codebase，现有测试断言不变（只验 title/scopeType），所以**现有 mock 无需改**。但为锁定 subject 解析行为，先加新测试。

在 `tests/distiller.test.ts` 末尾追加：

```ts
test('distillTranscript defaults missing subject to codebase', async () => {
  // TDD: 第二轮条件门要求 DistillCandidate 带 subject。LLM 漏标时 distiller
  // 必须默认 codebase（精度优先：不保护，走 derivable 判定）。
  const result = await distillTranscript({
    turns: [{ role: 'user', content: 'x' }],
    runtime: 'claude-code', cwd: '/repo',
    callLLM: async () => JSON.stringify({ candidates: [{ title: '[category:invariant] x', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' }] }),
  })
  expect(result.length).toBe(1)
  expect(result[0]!.subject).toBe('codebase')
})

test('distillTranscript parses explicit subject=domain', async () => {
  const result = await distillTranscript({
    turns: [{ role: 'user', content: 'x' }],
    runtime: 'claude-code', cwd: '/repo',
    callLLM: async () => JSON.stringify({ candidates: [{ title: '[category:invariant] x', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new', subject: 'domain' }] }),
  })
  expect(result.length).toBe(1)
  expect(result[0]!.subject).toBe('domain')
})

test('distillTranscript retries when subject is invalid', async () => {
  // TDD: distillShouldRetry 必须对非法 subject 触发重试；第二次返回合法值。
  let calls = 0
  const result = await distillTranscript({
    turns: [{ role: 'user', content: 'x' }],
    runtime: 'claude-code', cwd: '/repo',
    callLLM: async () => {
      calls++
      if (calls === 1) return JSON.stringify({ candidates: [{ title: '[category:invariant] x', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new', subject: 'bogus' }] })
      return JSON.stringify({ candidates: [{ title: '[category:invariant] x', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new', subject: 'domain' }] })
    },
  })
  expect(calls).toBe(2)
  expect(result[0]!.subject).toBe('domain')
})

test('DISTILLER_SYSTEM_PROMPT contains subject field + DOMAIN-not-codebase invariant def', () => {
  expect(DISTILLER_SYSTEM_PROMPT).toContain('"subject"')
  expect(DISTILLER_SYSTEM_PROMPT).toContain('codebase = ')
  expect(DISTILLER_SYSTEM_PROMPT).toContain('domain = ')
  expect(DISTILLER_SYSTEM_PROMPT).toContain("DOMAIN (NOT about this codebase's own implementation)")
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test tests/distiller.test.ts`
Expected: FAIL - `result[0].subject` 是 undefined（接口还没加字段、解析还没补）；prompt 断言找不到 `"subject"` 等。

- [ ] **Step 3: 改 `DistillCandidate` 接口 + 提示词 + 校验 + 解析**

`src/memory/distiller.ts`：

**3a. 接口加 subject（第 46-52 行附近）：**

```ts
export interface DistillCandidate {
  title: string
  bodyMd: string
  scopeType: MemoryScope
  runtime: RuntimeTag
  distillAction: 'new' | 'update_of' | 'duplicate_of' | 'conflict_with'
  /** 瞬态：规则对象是当前仓库自身代码(codebase) 还是外部业务领域(domain)。
   *  valueFilter 条件门据此决定是否强制保留 protected category。不入库。
   *  distiller 漏标/非法时默认 'codebase'（精度优先：不保护）。 */
  subject: 'codebase' | 'domain'
}
```

**3b. invariant 定义收紧（第 14 行）：**

旧：
```
2. [category:invariant] - hard business rules / constraints that must always hold
```
新：
```
2. [category:invariant] - hard business rules about the user's DOMAIN (NOT about this codebase's own implementation) that must always hold
```

**3c. 提示词加 subject 字段 + 判定指引。** 在 `Cross-cutting properties:` 之前（第 23 行前）插入 subject 指引；在输出 schema 的 candidate 对象（第 37-42 行附近）加 `"subject"` 字段。

在 `Cross-cutting properties:` 行**之前**插入：

```
对每条候选标记 subject：
- codebase = 这条规则描述的是当前仓库自身的代码、配置、模块行为或实现逻辑。
  判据：规则的主语是仓库内的具体组件/符号/流程（如 valueFilter、daemon、scheduler、
  某个函数的调用约定）。脱离这个仓库，规则就失去所指对象。
- domain = 这条规则描述的是仓库之外的东西：用户的业务规则、外部系统契约、法规约束、
  跨项目的领域知识。判据：换一个仓库这条规则依然成立、依然有意义。

拿不准时标 codebase。
```

输出 schema 的 candidate 对象改为（在 `distillAction` 后加 `subject`）：

```json
{
  "title": "[category:convention] 每个 PR 必须在 CHANGELOG.md 的 Unreleased 部分加一条",
  "bodyMd": "项目约定：PR 合并前需在 CHANGELOG.md 的 Unreleased 段落补充变更条目。",
  "scope": "project",
  "runtime": "claude-code",
  "distillAction": "new",
  "subject": "codebase"
}
```

**3d. `distillShouldRetry` 加 subject 校验（第 79-93 行）：** 在 `if (!c.title.includes('[category:'))` 校验之后，加：

```ts
    const subj = (c as { subject?: unknown }).subject
    if (subj !== undefined && subj !== 'codebase' && subj !== 'domain') {
      return `候选 ${i} 的 subject 非法（必须是 codebase 或 domain）`
    }
```

注意：subject **允许缺失**（`undefined` 通过校验，解析时默认 codebase）；只拦截非法值。

**3e. 解析时补 subject（第 108-128 行 out.push 处）：** 在 `out.push({ ... })` 里加 subject，缺失/非法默认 codebase：

```ts
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
```

（`rawSubject === 'domain'` 才取 domain；其余一切（undefined / 'codebase' / 非法串）都归 codebase。与 shouldRetry 配合：非法值会被 retry 拦截先重试，exhausted 后 fall through 到这里仍默认 codebase。）

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test tests/distiller.test.ts`
Expected: PASS（全部，含 4 个新测试）。

- [ ] **Step 5: typecheck（此时 valueFilter/dedup/scheduler 测试会因 cand/newCand 缺 subject 类型报错，预期）**

Run: `bun run typecheck`
Expected: FAIL - `tests/valueFilter.test.ts`、`tests/dedup.test.ts`、`tests/scheduler.test.ts` 里构造 `DistillCandidate` 的字面量缺 subject。**这是预期的**，后续任务修复。仅确认 distiller.test.ts 自身绿即可，本步不要求全绿。

- [ ] **Step 6: Commit**

```bash
git add src/memory/distiller.ts tests/distiller.test.ts
git commit -m "feat(distiller): add subject field (codebase|domain) + tighten invariant def"
```

---

## Task 2: valueFilter 条件门（subject === 'domain' 才保护）

**Files:**
- Modify: `src/memory/valueFilter.ts`（gate 两处）
- Test: `tests/valueFilter.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `DistillCandidate.subject`。
- Produces: `judgeValue` 的 force-keep 条件变为 `cat ∈ PROTECTED && subject === 'domain'`。

- [ ] **Step 1: 更新 `cand()` helper 默认 subject=domain + 改现有 protected 测试 + 加新测试**

`tests/valueFilter.test.ts`：

**1a. `cand()` helper（第 5-6 行）加默认 subject=domain**（保现有 protected 测试语义不变）：

```ts
const cand = (title: string, bodyMd = 'b'): DistillCandidate =>
  ({ title, bodyMd, scopeType: 'project', runtime: null, distillAction: 'new', subject: 'domain' })
```

**1b. 现有 `prot()` helper（第 121 行）继承 cand 的 domain 默认**，无需改。

**1c. 新增 codebase 不保护测试 + 缺失默认 codebase 测试。** 在 `tests/valueFilter.test.ts` 末尾追加：

```ts
test('subject gate: codebase invariant is discarded when LLM says derivable', async () => {
  // TDD（第二轮核心）：逻辑门不再无条件保护 protected category。codebase 类的
  // invariant（如 valueFilter 必须强制保留 invariant）是代码复述，LLM 判 derivable
  // 时必须丢弃，不能被门救回。根因见 spec §1.1。
  const c: DistillCandidate = { title: '[category:invariant] valueFilter 必须强制保留 invariant', bodyMd: 'b', scopeType: 'project', runtime: null, distillAction: 'new', subject: 'codebase' }
  const v = await judgeValue([c], async () => verdictsJson({ index: 0, category: 'derivable' }))
  expect(v).toEqual([{ index: 0, keep: false, reason: 'derivable' }])
})

test('subject gate: missing subject defaults to codebase (not protected)', async () => {
  // TDD：subject 缺失/非法一律视为 codebase（精度优先）。直接构造一个缺 subject
  // 的候选（绕过 cand helper）模拟 distiller 漏标。
  const c = { title: '[category:invariant] x', bodyMd: 'b', scopeType: 'project', runtime: null, distillAction: 'new' } as DistillCandidate
  const v = await judgeValue([c], async () => verdictsJson({ index: 0, category: 'derivable' }))
  expect(v).toEqual([{ index: 0, keep: false, reason: 'derivable' }])
})

test('subject gate: codebase protected categories also discarded (integration/compliance)', async () => {
  const cc = (cat: string): DistillCandidate => ({ title: `[category:${cat}] codebase rule`, bodyMd: 'b', scopeType: 'project', runtime: null, distillAction: 'new', subject: 'codebase' })
  const v = await judgeValue([cc('integration'), cc('compliance')], async () => verdictsJson(
    { index: 0, category: 'derivable' },
    { index: 1, category: 'public-knowledge' },
  ))
  expect(v).toEqual([
    { index: 0, keep: false, reason: 'derivable' },
    { index: 1, keep: false, reason: 'public-knowledge' },
  ])
})

test('subject gate: domain invariant still force-kept even when LLM throws', async () => {
  // 回归：domain 类 protected 仍受保护（keepNull 路径也按 subject 判定）。
  const v = await judgeValue([prot('invariant')], async () => { throw new Error('down') })
  expect(v).toEqual([{ index: 0, keep: true, valueClass: 'decision' }])
})
```

注意：现有 `judgeValue force-keeps protected invariant even when LLM says derivable`（第 136 行）、`force-keeps protected integration/compliance`（第 141 行）、`force-keeps protected category even when LLM throws`（第 152 行）三个测试用 `prot()` -> cand -> subject=domain，**断言不变，应仍绿**（domain 类仍保护）。本步不删它们。

- [ ] **Step 2: 运行测试确认新测试失败、旧 protected 测试仍绿**

Run: `bun test tests/valueFilter.test.ts`
Expected: FAIL - 3 个新 codebase 测试失败（gate 还没加 subject 条件，codebase invariant 仍被 force-keep+decision，与期望的 discard 不符）；现有 domain protected 测试 PASS。

- [ ] **Step 3: 改 valueFilter gate 两处加 subject === 'domain' 条件**

`src/memory/valueFilter.ts`：

**3a. `keepNull()`（第 102-108 行）：**

旧：
```ts
  const keepNull = (): ValueVerdict[] =>
    candidates.map((c, i) => {
      const cat = parseCategory(c.title)
      return (cat && VALUE_PROTECTED_CATEGORIES.has(cat))
        ? { index: i, keep: true, valueClass: 'decision' as ValueClass }
        : { index: i, keep: true, valueClass: null }
    })
```
新：
```ts
  const keepNull = (): ValueVerdict[] =>
    candidates.map((c, i) => {
      const cat = parseCategory(c.title)
      const subj = c.subject === 'domain' ? 'domain' : 'codebase'
      return (cat && VALUE_PROTECTED_CATEGORIES.has(cat) && subj === 'domain')
        ? { index: i, keep: true, valueClass: 'decision' as ValueClass }
        : { index: i, keep: true, valueClass: null }
    })
```

**3b. 正常路径（第 132-138 行）：**

旧：
```ts
    return candidates.map((c, i) => {
      const cat = parseCategory(c.title)
      if (cat && VALUE_PROTECTED_CATEGORIES.has(cat)) {
        return { index: i, keep: true, valueClass: 'decision' as ValueClass }
      }
      return byIndex.get(i) ?? { index: i, keep: true, valueClass: null }
    })
```
新：
```ts
    return candidates.map((c, i) => {
      const cat = parseCategory(c.title)
      const subj = c.subject === 'domain' ? 'domain' : 'codebase'
      if (cat && VALUE_PROTECTED_CATEGORIES.has(cat) && subj === 'domain') {
        return { index: i, keep: true, valueClass: 'decision' as ValueClass }
      }
      return byIndex.get(i) ?? { index: i, keep: true, valueClass: null }
    })
```

（`c.subject === 'domain' ? 'domain' : 'codebase'` 把 undefined/非法一律归 codebase，与 spec §6 降级矩阵一致。）

- [ ] **Step 4: 运行测试确认全绿**

Run: `bun test tests/valueFilter.test.ts`
Expected: PASS（全部，含 3 个新 codebase 测试 + 现有 domain protected 测试）。

- [ ] **Step 5: 确认 neutrality 测试仍绿**

Run: `bun test tests/valueFilter.test.ts --grep "neutral"`
Expected: PASS（本轮不动 valueFilter 提示词，禁词约束不受影响）。

- [ ] **Step 6: Commit**

```bash
git add src/memory/valueFilter.ts tests/valueFilter.test.ts
git commit -m "feat(valueFilter): condition gate - protect protected category only when subject=domain"
```

---

## Task 3: dedup 跨批增强（existing 带 bodyMd + prompt 同规则不同侧面）

**Files:**
- Modify: `src/memory/dedup.ts`（ExistingMemoryForDedup 加字段 + renderUserPrompt + prompt）
- Modify: `src/memory/store.ts`（listForDedupByScope 多 SELECT bodyMd）
- Test: `tests/dedup.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `DistillCandidate.subject`（dedup 不看，但 `newCand` 字面量需补 subject 才能过 typecheck）。
- Produces: `ExistingMemoryForDedup` 加 `bodyMd: string`；`DEDUP_SYSTEM_PROMPT` 加同规则不同侧面指引。

- [ ] **Step 1: 更新测试 fixture + 加新测试**

`tests/dedup.test.ts`：

**1a. `existing` fixture（第 5-7 行）加 bodyMd；`newCand`（第 8-11 行）加 subject=domain：**

```ts
const existing: ExistingMemoryForDedup[] = [
  { id: 'A', title: '[category:invariant] refund within 14 days', bodyMd: '14d refund window', scopeType: 'project', scopeId: '/r', status: 'approved' },
]
const newCand: DistillCandidate = {
  title: '[category:process] 退款必须在发货后14天内', bodyMd: '14天退款窗口',
  scopeType: 'project', runtime: null, distillAction: 'new', subject: 'domain',
}
```

**1b. 末尾追加新测试：**

```ts
test('renderUserPrompt includes existing bodyMd (cross-batch dedup has full context)', async () => {
  // TDD（第二轮）：跨批比对原本只发 title，同义候选 title 强调不同侧面时 LLM 看不出
  // 重复。existing 必须带 bodyMd 让 LLM 有完整上下文。根因见 spec §1.1 第 2 点。
  let captured = ''
  await judgeDuplicates({
    newCandidates: [newCand], existing,
    callLLM: async (_sys, user) => { captured = user; return JSON.stringify({ verdicts: [{ index: 0, isDuplicate: false }] }) },
  })
  expect(captured).toContain('14d refund window') // existing 的 bodyMd
})

test('DEDUP_SYSTEM_PROMPT mentions same-rule-different-facet = duplicate', () => {
  expect(DEDUP_SYSTEM_PROMPT).toContain('不同角度')
  expect(DEDUP_SYSTEM_PROMPT).toContain('只保留最完整的一条')
})

test('judgeDuplicates merges same-rule-different-facet siblings', async () => {
  // TDD：同一规则从"为什么/实现/触发"不同角度各写一条，prompt 指引 + 完整 body
  // 应让 LLM 判为重复，只留第一条。
  const a: DistillCandidate = { title: '[category:invariant] 退款须在发货后14天内', bodyMd: '14天退款窗口', scopeType: 'project', runtime: null, distillAction: 'new', subject: 'domain' }
  const b: DistillCandidate = { title: '[category:invariant] 退款规则的14天期限不可被丢弃', bodyMd: '退款期限是14天', scopeType: 'project', runtime: null, distillAction: 'new', subject: 'domain' }
  const v = await judgeDuplicates({
    newCandidates: [a, b], existing: [],
    callLLM: async () => JSON.stringify({ verdicts: [{ index: 0, isDuplicate: false }, { index: 1, isDuplicate: true, duplicateOfId: 'new-0' }] }),
  })
  expect(v).toEqual([
    { index: 0, duplicate: false },
    { index: 1, duplicate: true, duplicateOfId: 'new-0' },
  ])
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test tests/dedup.test.ts`
Expected: FAIL - `existing` fixture 缺 bodyMd 类型报错（typecheck 阶段）；`renderUserPrompt includes existing bodyMd` 断言找不到 body；prompt 断言找不到"不同角度"。

- [ ] **Step 3: 改 `ExistingMemoryForDedup` + `renderUserPrompt` + prompt**

`src/memory/dedup.ts`：

**3a. interface 加 bodyMd（第 6-12 行）：**

```ts
export interface ExistingMemoryForDedup {
  id: string
  title: string
  bodyMd: string
  scopeType: MemoryScope
  scopeId: string | null
  status: MemoryStatus
}
```

**3b. `renderUserPrompt` existing 行带 bodyMd（第 40 行）：**

旧：
```ts
    ? existing.map((e) => `id=${e.id} | ${e.title}`).join('\n')
```
新：
```ts
    ? existing.map((e) => `id=${e.id} | ${e.title}\n${e.bodyMd}`).join('\n')
```

**3c. `DEDUP_SYSTEM_PROMPT` 加同规则不同侧面指引。** 在 `tagged with a different [category:] prefix.` 之后（第 26 行之后）插入：

```
同一规则从"为什么这么做 / 实现要点 / 触发条件"等不同角度各写一条，仍是重复--只保留最完整的一条。例如以下三条都表达同一规则，只有第一条应保留：
  [category:invariant] 退款须在发货后14天内
  [category:invariant] 退款规则的14天期限不可被LLM以derivable丢弃
  [category:compliance] 14天退款窗口必须强制保留并标记valueClass
```

**3d. `listForDedupByScope`（store.ts:138-158）多 SELECT bodyMd。** `cols` 加 `bodyMd: memories.bodyMd`；`out.push` 加 `bodyMd: r.bodyMd`：

```ts
  const cols = { id: memories.id, title: memories.title, bodyMd: memories.bodyMd, scopeType: memories.scopeType, scopeId: memories.scopeId, status: memories.status }
```
```ts
    out.push({ id: r.id, title: r.title, bodyMd: r.bodyMd, scopeType: r.scopeType as MemoryScope, scopeId: r.scopeId, status: r.status as MemoryStatus })
```

同时更新 store.ts:131-137 的 docstring：把 "projecting only {id,title,scopeType,scopeId,status} (no body/runtime, to keep the dedup prompt small)" 改为 "projecting {id,title,bodyMd,scopeType,scopeId,status} (no runtime; bodyMd now included so cross-batch dedup sees full context per spec §3.4)"。

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test tests/dedup.test.ts`
Expected: PASS（全部，含 3 个新测试）。

- [ ] **Step 5: typecheck（确认 store.ts 改动无类型错）**

Run: `bun run typecheck`
Expected: 仍可能有 scheduler.test.ts 的 subject 相关报错（Task 5 修），但 dedup/store 自身无新错。

- [ ] **Step 6: Commit**

```bash
git add src/memory/dedup.ts src/memory/store.ts tests/dedup.test.ts
git commit -m "feat(dedup): existing carries bodyMd + prompt merges same-rule-different-facet"
```

---

## Task 4: token 预算 64k + per-turn cap 翻倍

**Files:**
- Modify: `src/memory/pure.ts`（常量）
- Test: `tests/pure-transcript-filter.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `DEFAULT_DISTILL_INPUT_BUDGET_TOKENS = 64000`；`NON_TOOL_CAP_CHARS = 8000`；`TOOL_RESULT_CAP_CHARS = 3000`。

- [ ] **Step 1: 读现有预算/cap 边界测试，确定要改的断言**

Run: `bun test tests/pure-transcript-filter.test.ts` 先确认基线绿。然后读该文件找出所有引用 12000/4000/1500 的断言。

- [ ] **Step 2: 更新预算/cap 边界测试**

`tests/pure-transcript-filter.test.ts`：把所有引用旧常量值的测试改成新值。典型：

- 原"预算 12000 下 drop X"的测试 -> 改成预算 64000 下不 drop（或用更小 budget 参数局部验证 drop 逻辑）。`filterTranscriptForDistill(turns, budgetTokens)` 第二参数可显式传小值测 drop 逻辑，不受默认值影响。
- per-turn cap 测试：原断言 `4000` 截断点改 `8000`，`1500` 改 `3000`。

末尾追加一个锁定新默认值的测试：

```ts
test('DEFAULT_DISTILL_INPUT_BUDGET_TOKENS is 64000 (second-round widen)', () => {
  // TDD（第二轮）：用户确认不省 token，预算 12k->64k 给 distiller 更完整上下文判
  // subject/category。见 spec §3.5。
  expect(DEFAULT_DISTILL_INPUT_BUDGET_TOKENS).toBe(64000)
})

test('per-turn caps widened: non-tool 8000, tool 3000', async () => {
  // TDD：cap 翻倍。非文件 tool 结果截断到 3000；user/assistant 截断到 8000。
  const longTool = 'x'.repeat(5000)
  const longUser = 'y'.repeat(10000)
  const out = filterTranscriptForDistill([
    { role: 'tool', content: longTool, toolName: 'Bash' },
    { role: 'user', content: longUser },
  ])
  expect(out[0]!.content.length).toBeLessThanOrEqual(3000 + '…[truncated]'.length)
  expect(out[1]!.content.length).toBeLessThanOrEqual(8000 + '…[truncated]'.length)
})
```

（`import { filterTranscriptForDistill, DEFAULT_DISTILL_INPUT_BUDGET_TOKENS } from '@/memory/pure'` -- 确认测试文件已 import 这两个；若未 import DEFAULT_DISTILL_INPUT_BUDGET_TOKENS 则补。）

- [ ] **Step 3: 运行测试确认新测试失败、旧测试按预期**

Run: `bun test tests/pure-transcript-filter.test.ts`
Expected: FAIL - 新默认值测试失败（还是 12000）；新 cap 测试失败（还是 4000/1500）。

- [ ] **Step 4: 改 pure.ts 常量**

`src/memory/pure.ts`（第 172-176 行）：

旧：
```ts
export const DEFAULT_DISTILL_INPUT_BUDGET_TOKENS = 12000

const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const TOOL_RESULT_CAP_CHARS = 1500
const NON_TOOL_CAP_CHARS = 4000
```
新：
```ts
export const DEFAULT_DISTILL_INPUT_BUDGET_TOKENS = 64000

const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const TOOL_RESULT_CAP_CHARS = 3000
const NON_TOOL_CAP_CHARS = 8000
```

- [ ] **Step 5: 运行测试确认全绿**

Run: `bun test tests/pure-transcript-filter.test.ts`
Expected: PASS（全部）。

- [ ] **Step 6: Commit**

```bash
git add src/memory/pure.ts tests/pure-transcript-filter.test.ts
git commit -m "feat(pure): widen distill budget 12k->64k + per-turn cap doubled"
```

---

## Task 5: e2e 门禁更新 + 反向测试（scheduler 层）

**Files:**
- Modify: `tests/scheduler.test.ts`

**Interfaces:**
- Consumes: Task 1-4 全部。scheduler `tick` 调用序不变（distill->dedup->judgeValue），subject 透传不感知。
- Produces: e2e 锁定 domain invariant 保留 / codebase invariant 被 derivable 丢弃。

- [ ] **Step 1: 更新第一轮 e2e 测试加 subject=domain + 加反向测试 + dedup bodyMd e2e**

`tests/scheduler.test.ts`：

**1a. 第一轮 `protected invariant candidate survives` 测试（第 333-354 行）的 distill mock 加 `subject: 'domain'`：**

第 342 行的 candidates JSON 改为：
```ts
      if (callCount === 1) return JSON.stringify({ candidates: [{ title: '[category:invariant] 退款须在发货后14天内', bodyMd: '14d', scope: 'project', runtime: null, distillAction: 'new', subject: 'domain' }] })
```
其余断言（callCount===2、valueClass==='decision'、discards 0 行）不变。

**1b. 末尾追加反向 e2e + dedup bodyMd e2e：**

```ts
test('tick: codebase invariant candidate is discarded when LLM says derivable (e2e subject gate)', async () => {
  // TDD（第二轮核心 e2e）：codebase 类 invariant（代码复述）不再被逻辑门保护。
  // distill 产出 subject=codebase，judgeValue LLM 判 derivable -> 丢弃入 discards，
  // createCandidate 不被调用。与上一条 domain 测试互为正反锚点。
  const { jobId } = await enqueueDistillJob(db, { sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0 })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  let createCalls = 0
  let callCount = 0
  await tick(db, {
    loadTranscript: async () => [{ role: 'user', content: 'valueFilter must force-keep invariant' }],
    callLLM: async () => {
      callCount++
      if (callCount === 1) return JSON.stringify({ candidates: [{ title: '[category:invariant] valueFilter 必须强制保留 invariant', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new', subject: 'codebase' }] })
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

test('tick: dedup existing bodyMd flows into cross-batch comparison (e2e)', async () => {
  // TDD（第二轮）：已入库 existing 候选带 bodyMd 进 dedup prompt。先建一条 existing
  // candidate，再 enqueue 新 job 产出同义候选，断言 dedup 把新候选判为重复、不创建。
  const ex = await realCreateCandidate(db, { scopeType: 'project', scopeId: '/r', title: '[category:invariant] 退款须在发货后14天内', bodyMd: '14天退款窗口', tags: [], sourceKind: 'manual', runtime: null, sourceCwd: '/r' })
  await db.update(memories).set({ status: 'candidate' }).where(eq(memories.id, ex.id)).run()
  const { jobId } = await enqueueDistillJob(db, { sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0 })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  let createCalls = 0
  let captured = ''
  let callCount = 0
  await tick(db, {
    loadTranscript: async () => [{ role: 'user', content: 'refund rule' }],
    callLLM: async (_sys, user) => {
      callCount++
      if (callCount === 1) return JSON.stringify({ candidates: [{ title: '[category:invariant] 退款规则14天期限', bodyMd: '14d', scope: 'project', runtime: null, distillAction: 'new', subject: 'domain' }] })
      if (callCount === 2) { captured = user; return JSON.stringify({ verdicts: [{ index: 0, isDuplicate: true, duplicateOfId: ex.id }] }) }
      return JSON.stringify({ verdicts: [{ index: 0, category: 'decision' }] })
    },
    createCandidate: async () => { createCalls++; return { id: 'c1', status: 'candidate', version: 1 } as any },
  })
  expect(captured).toContain('14天退款窗口') // existing bodyMd 进了 dedup prompt
  expect(createCalls).toBe(0) // 新候选被判重复，不创建
})
```

注意：检查 scheduler.test.ts 顶部已 import `memories`（第 8 行已有），`realCreateCandidate`（第 7 行已有）。无需补 import。

- [ ] **Step 2: 运行测试确认通过（条件门已在 Task 2 生效）**

Run: `bun test tests/scheduler.test.ts`
Expected: PASS。本任务的 e2e 是**确认**而非驱动--Task 2 已把条件门改好，scheduler 路径透传 subject，故新反向 e2e（codebase invariant 被 derivable 丢弃、createCalls=0、discards=1）应直接绿。若新测试 FAIL，说明 Task 2 的 gate 改动未覆盖某路径--回查 Task 2 的 `keepNull()` 与正常路径两处是否都加了 `subj === 'domain'`。

- [ ] **Step 3: typecheck + 全量回归**

Run: `bun run typecheck && bun test`
Expected: typecheck 干净；`bun test` 全绿（所有任务的改动汇合后无遗漏）。

- [ ] **Step 4: Commit**

```bash
git add tests/scheduler.test.ts
git commit -m "test(scheduler): e2e subject gate (domain keeps / codebase discards) + dedup bodyMd"
```

---

## 完成后（非本计划任务，执行阶段之后）

- 推远端 + 开 PR 合并回 `master`（PR 标题 `feat(memory): 记忆质量修复第二轮 - 条件门 + dedup 跨批增强 + 64k 预算`）。
- 合并后本地 `git branch -d feat/memory-quality-fix2` + `git fetch --prune`。
- 重启 daemon 验证：新候选不再出现"代码复述被保护"，5 条同义 invariant 合成 ≤1 条且走 derivable。

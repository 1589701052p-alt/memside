# 价值判定器 prompt 精度修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复价值判定器 prompt 两个实测缺陷——fleeting 误用于永久项目规则、derivable 对「已写进仓库文档的规矩」判决跨批漂移。

**Architecture:** 纯 prompt 文本改动：只改 `src/memory/valueFilter.ts` 的 `VALUE_JUDGE_RULES` 常量（两处插入，不删不改既有字句）。agent 判定器经共享常量自动继承。字节锁测试同步更新为新权威文本。

**Tech Stack:** Bun + TypeScript，测试 bun:test（严禁 npm test）。

**Spec:** `docs/superpowers/specs/2026-08-14-value-judge-prompt-accuracy-design.md`（§3 权威文本表是唯一事实来源，实现逐字照抄）

## Global Constraints

- `VALUE_JUDGE_RULES` 新文本**逐字照抄 spec §3 权威表**，含标点与换行，不得改写、润色或「修正」。
- 不动 `VALUE_JUDGE_HEADER`、`VALUE_JUDGE_OUTPUT_SECTION`、`AGENT_PROTOCOL_SECTION`、`verdictsFromCategories`、`detectTaming` 及任何映射代码。
- 标点风格：连字符 ` - `（禁 em-dash）、箭头 `->`、直引号；续行 3 空格缩进。
- 测试一律 `bun test`；push 前 `bun run typecheck && bun test` 全绿。
- commit 信息按 `fix(...)`/`docs(...)` 规范，中文描述。

---

### Task 1: prompt 文本修改（TDD：先更新测试锁为红，再改源码到绿）

**Files:**
- Test: `tests/value-filter-prompt.test.ts`
- Modify: `src/memory/valueFilter.ts:19-48`（仅 `VALUE_JUDGE_RULES` 模板字面量）

**Interfaces:**
- Consumes: 无（本任务是唯一代码改动任务）。
- Produces: `VALUE_JUDGE_RULES` 新文本（导出签名不变，仍为 `export const VALUE_JUDGE_RULES: string`）；`VALUE_JUDGE_SYSTEM_PROMPT` / `AGENT_JUDGE_SYSTEM_PROMPT` 因拼接自动携带新文本，调用方零感知。

- [ ] **Step 1: 更新测试为「新权威文本」——全量替换 `tests/value-filter-prompt.test.ts` 为以下内容**

```ts
// 回归防护:Task 5 把 VALUE_JUDGE_SYSTEM_PROMPT 拆成 头+RULES+输出段 重组,
// 重组后必须与原字面量逐字节一致(判定规则文本语义零变更,spec Global Constraints)。
// 2026-08-14(spec value-judge-prompt-accuracy):RULES 段插入 fleeting/derivable
// 两条新 HARD RULE(实测 fleeting 误判永久规则、derivable 边界跨批漂移),
// 本锁同步更新为新权威文本。
import { test, expect } from 'bun:test'
import { VALUE_JUDGE_SYSTEM_PROMPT, VALUE_JUDGE_RULES } from '@/memory/valueFilter'

const ORIGINAL = `You are memside-value-judge. Assign exactly one category to each candidate memory.

Each candidate carries an origin tag: user-stated (the user said it in this session),
user-confirmed (the agent proposed it and the user explicitly adopted it), or
agent-observed (the agent derived it on its own).

Retain categories (assign the best fit):
1. user-rule - an explicit rule or hard constraint the user laid down: workflow rules,
   quality bars, safety constraints.
2. decision - the WHY behind a choice the user made or adopted: abandoned alternatives,
   driving constraints.
3. preference - the user's personal preferences and collaboration habits.
4. convention - an unwritten team/repo norm that holds steady without being stated by
   the user in this session.
5. trap - counterintuitive behavior, known gotchas, postmortem lessons from incidents.
6. topology - a cross-boundary connection (cross-module/service/repo) invisible from
   any single vantage point.

Drop categories (assign only when the stated test passes):
7. public-knowledge - TEST: could an engineer who never read this repo and never saw
   this session write this entry from general knowledge or official docs alone?
   ("Python dicts preserve insertion order" -> yes; "refunds only within 14 days of
   shipment in this product" -> no.)
8. derivable - TEST: reading only this repository's code/docs/config, never this
   conversation, could one re-derive this entry's content? ("the token mask retains the
   first 6 and last 4 chars" -> yes; "the credential chain puts UI first because stale
   env vars once caused a 401 outage" -> no - the code shows the order, not the why.)
   "Docs" includes this project's own rulebooks and specs (CLAUDE.md, README,
   STATE.md, docs/, and test files that grep-guard a rule): a standing rule already
   written there is derivable even when it also reads as a convention or process
   norm - assign derivable, not convention. ("tests must run with bun test, per
   CLAUDE.md" -> derivable; "reviewers here prefer merge commits over squash,
   nowhere written down" -> convention.)
   HARD RULE: never assign derivable to a candidate whose origin is user-stated or
   user-confirmed.
9. fleeting - TEST: in a brand-new session three months from now, would this entry
   still bind or inform? ("let's stop here for today" -> no; "every change lands via
   branch + PR" -> yes.)
   HARD RULE: fleeting is ONLY for session logistics (scheduling, "for today",
   "after lunch") and for guidance the entry itself marks as superseded. A standing
   rule, workflow, or quality gate of this project - however small - still binds
   three months from now by definition; never assign fleeting to one. ("never commit
   directly to master" -> not fleeting; "we'll merge PR #58 after lunch" ->
   fleeting.)

输出格式如下（仅示范结构，勿照抄内容；只输出这一个 JSON 对象，无 markdown 围栏，无解释文字）：
{
  "verdicts": [
    {"index": 0, "category": "decision"},
    {"index": 1, "category": "public-knowledge"}
  ]
}
Emit one verdict per candidate, keyed by index.`

test('拆分重组后 VALUE_JUDGE_SYSTEM_PROMPT 与原字面量字节一致', () => {
  expect(VALUE_JUDGE_SYSTEM_PROMPT).toBe(ORIGINAL)
})

test('VALUE_JUDGE_RULES 含六留三丢全部 9 类与 stated 禁考 Q2 硬规则', () => {
  for (const s of ['user-rule', 'decision', 'preference', 'convention', 'trap', 'topology',
    'public-knowledge', 'derivable', 'fleeting', 'HARD RULE']) {
    expect(VALUE_JUDGE_RULES).toContain(s)
  }
})

// 回归锁(2026-08-14 审计):fleeting 曾把「LLM prompt 必须中立」等永久规则误判丢弃;
// derivable 曾对「已写进 CLAUDE.md 的 TDD 规则」判决跨批漂移。两条新 HARD RULE 的
// 关键措辞被回退时本测试必须变红。
test('VALUE_JUDGE_RULES 含 fleeting 长期规则禁判与 derivable 文档化边界两条新硬规则', () => {
  for (const s of [
    'HARD RULE: fleeting is ONLY for session logistics',
    'never assign fleeting to one',
    '"Docs" includes this project\'s own rulebooks and specs',
    'assign derivable, not convention',
  ]) {
    expect(VALUE_JUDGE_RULES).toContain(s)
  }
})
```

- [ ] **Step 2: 跑测试确认红**

Run: `bun test tests/value-filter-prompt.test.ts`
Expected: FAIL —— 字节锁测试报 `VALUE_JUDGE_SYSTEM_PROMPT` 与 ORIGINAL 不一致（源码还是旧文本）；意图断言测试报缺少新 HARD RULE 文本。

- [ ] **Step 3: 改源码——`src/memory/valueFilter.ts` 的 `VALUE_JUDGE_RULES` 常量整体替换为 spec §3 权威文本**

把第 19–48 行的模板字面量（`export const VALUE_JUDGE_RULES = \`...\``）替换为以下内容（与 spec §3 逐字一致；差异仅两处插入：derivable 的 "Docs" 边界段、
fleeting 的 HARD RULE 段）：

```ts
export const VALUE_JUDGE_RULES = `Each candidate carries an origin tag: user-stated (the user said it in this session),
user-confirmed (the agent proposed it and the user explicitly adopted it), or
agent-observed (the agent derived it on its own).

Retain categories (assign the best fit):
1. user-rule - an explicit rule or hard constraint the user laid down: workflow rules,
   quality bars, safety constraints.
2. decision - the WHY behind a choice the user made or adopted: abandoned alternatives,
   driving constraints.
3. preference - the user's personal preferences and collaboration habits.
4. convention - an unwritten team/repo norm that holds steady without being stated by
   the user in this session.
5. trap - counterintuitive behavior, known gotchas, postmortem lessons from incidents.
6. topology - a cross-boundary connection (cross-module/service/repo) invisible from
   any single vantage point.

Drop categories (assign only when the stated test passes):
7. public-knowledge - TEST: could an engineer who never read this repo and never saw
   this session write this entry from general knowledge or official docs alone?
   ("Python dicts preserve insertion order" -> yes; "refunds only within 14 days of
   shipment in this product" -> no.)
8. derivable - TEST: reading only this repository's code/docs/config, never this
   conversation, could one re-derive this entry's content? ("the token mask retains the
   first 6 and last 4 chars" -> yes; "the credential chain puts UI first because stale
   env vars once caused a 401 outage" -> no - the code shows the order, not the why.)
   "Docs" includes this project's own rulebooks and specs (CLAUDE.md, README,
   STATE.md, docs/, and test files that grep-guard a rule): a standing rule already
   written there is derivable even when it also reads as a convention or process
   norm - assign derivable, not convention. ("tests must run with bun test, per
   CLAUDE.md" -> derivable; "reviewers here prefer merge commits over squash,
   nowhere written down" -> convention.)
   HARD RULE: never assign derivable to a candidate whose origin is user-stated or
   user-confirmed.
9. fleeting - TEST: in a brand-new session three months from now, would this entry
   still bind or inform? ("let's stop here for today" -> no; "every change lands via
   branch + PR" -> yes.)
   HARD RULE: fleeting is ONLY for session logistics (scheduling, "for today",
   "after lunch") and for guidance the entry itself marks as superseded. A standing
   rule, workflow, or quality gate of this project - however small - still binds
   three months from now by definition; never assign fleeting to one. ("never commit
   directly to master" -> not fleeting; "we'll merge PR #58 after lunch" ->
   fleeting.)`
```

注意：模板字面量内无反引号、无 `${`，无需转义；上一行 `export const VALUE_JUDGE_HEADER` 与下一行 `const VALUE_JUDGE_OUTPUT_SECTION` 均不得改动。

- [ ] **Step 4: 跑测试确认绿**

Run: `bun test tests/value-filter-prompt.test.ts`
Expected: PASS（3 个测试全过）。

- [ ] **Step 5: 跑判定相关套件确认零回归**

Run: `bun test tests/value-filter-prompt.test.ts tests/valueFilter.test.ts tests/agent-judge.test.ts tests/scheduler.test.ts`
Expected: PASS（这些套件 mock LLM 返回，不锁 prompt 文本；若有意外失败，停下上报，不得擅自改无关测试）。

- [ ] **Step 6: Commit**

```bash
git add tests/value-filter-prompt.test.ts src/memory/valueFilter.ts
git commit -m "fix(value-filter): fleeting 禁判永久规则 + derivable 钉死文档化边界（spec 2026-08-14）"
```

---

### Task 2: STATE.md 落档 + 全量验证

**Files:**
- Modify: `STATE.md`（新节追加到文件**末尾**——本仓库惯例，最新节在底部）

**Interfaces:**
- Consumes: Task 1 的 commit（prompt 新文本已生效）。
- Produces: 无代码产出；STATE.md 新节为下次 session 的上下文。

- [ ] **Step 1: STATE.md 末尾追加以下新节**

```markdown
## 价值判定器 prompt 精度修复（2026-08-14）

审计 live DB 最近 50 候选 + 50 自动丢弃（详见 spec §1）发现两个系统性 prompt 缺陷并修复
（设计 spec / 计划见 `docs/superpowers/specs|plans/2026-08-14-value-judge-prompt-accuracy*`）：

1. **fleeting 误用于永久规则**（实测 D17 prompt 中立硬约束 / D21 push 终验门槛 / D4 review
   报告格式被误判丢弃）：fleeting 加 HARD RULE——只许用于会话性琐事与条目自身标明已被
   取代的指导；长期项目规则 / 工作流 / 质量门槛永远不得判 fleeting。保留 superseded 口子
   兼容 agent 协议段「被取代方判 fleeting」的合法用法。
2. **derivable 边界跨批漂移**（TDD 规则 / STATE.md 追加顺序 / UI 文案照抄三组同事实相反
   判决）：derivable 的 "docs" 显式钉死包含 CLAUDE.md / README / STATE.md / docs/ / 测试
   守卫——已写进仓库文档的长期规矩一律 derivable（用户裁决方向：CLAUDE.md 每会话本就
   注入，重复记忆是噪音）；stated 免疫 HARD RULE 一字不动。

纯 prompt 文本改动：仅 `VALUE_JUDGE_RULES` 两处插入，agent 判定器经共享常量自动继承；
映射代码 / taming / 失败兜底 / 输出段零改动。字节锁测试更新为新权威文本 + 两条意图断言
回归锁。`bun run typecheck && bun test` 全绿（实测数字见下方校验行）。

### 上线后观测（硬要求，结论回填本节）

- 24–48h 内 `memory_discards` 新行 reason='fleeting' 是否仍命中长期规则措辞（预期近零）；
- 文档化规矩类候选判决是否收敛到 derivable（不再出现 convention/user-rule 留存版）；
- convention 留存是否异常减少（"nowhere written down" 类被误丢的副作用信号）。

### Follow-up

1. 蒸馏器 origin 打标准确性（C16 类：正文写"用户明确要求"却标 agent-observed）——
   考虑 distiller prompt 加 origin 硬规则，独立 spec。
2. 存量误判条目（D4/D17/D21/D37）在 Web UI「AI自动拒绝」tab 手动提升，不重判。
```

注意：STATE.md 校验行里的测试实测数字必须在 Step 2 跑完后回填真实值（CLAUDE.md
硬约束：落档数字必须实测，不得虚构占位）。

- [ ] **Step 2: 全量验证并回填实测数字**

Run: `bun run typecheck && bun test`
Expected: typecheck 干净；bun test 全绿。把「全绿（实测数字见下方校验行）」中的
占位表述替换为实测「N/N 全绿」。

- [ ] **Step 3: Commit**

```bash
git add STATE.md
git commit -m "docs: 价值判定器 prompt 精度修复落档（spec 2026-08-14）"
```

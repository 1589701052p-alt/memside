# 出处驱动的价值判定（origin-driven value judgment）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把价值判定的锚点从「domain vs codebase」换成「用户陈述 vs 可重新推导」——distiller 输出 origin/evidence，judgeValue 重写为 6 留 3 丢九分类（用户陈述类免疫 derivable），evidence 上审批卡片。

**Architecture:** distiller 每条候选带 `origin`（user-stated/user-confirmed/agent-observed）+ `evidence`（原话摘句，贴金防护：摘不出原话降级 observed）；judgeValue 单次 LLM 调用输出九分类（6 价值筐 + public-knowledge/derivable/fleeting 三丢弃理由，各配考题与锚点），代码硬兜底「stated/confirmed 被判 derivable → 改判 keep+decision」；taming 守卫与失败全保留兜底不动；memories 加 origin/evidence 两列（幂等 ALTER），透传到 Web UI 审批卡片。

**Tech Stack:** Bun + Hono + Drizzle + bun:sqlite + zod；前端 Vite + React 19（inline style）。测试 bun:test。

**设计 spec:** `docs/superpowers/specs/2026-07-30-origin-driven-value-judgment-design.md`

## Global Constraints

- 每个 task 落 commit 前必须 `bun run typecheck && bun test` 全绿（CLAUDE.md 强制）。
- 测试先行：每个 task 先写失败测试再实现（CLAUDE.md 测试随改动落地）。
- judge prompt 中性硬约束：`VALUE_JUDGE_SYSTEM_PROMPT` 不得出现 `discard`/`keep`/`dangerous`/`unsure`/`cautious`/`careful`/`reject`/`don't`/`avoid`/`important`/`valuable`（现有 valueFilter.test.ts 中性测试锁定，新 prompt 用词用 retain/drop/assign）。
- `memories` 表 CHECK 约束无法 ALTER：加列只走幂等 `ALTER TABLE ... ADD COLUMN`（nullable、无 CHECK），新建表 DDL 同步更新；**不碰** subagent 表重建块（origin/evidence ALTER 块放在重建块之后，所有升级路径殊途同归）。
- `memory_discards.reason` 是自由文本列，`fleeting` 直接写入，无迁移。
- 分支 `feat/origin-value-judgment`（已基于 origin/master 切好），严禁直推 master。
- 注释 / 提交信息用中文或中英混合，与既有代码风格一致。

---

### Task 1: distiller 输出 origin/evidence，ruleObject 退役

**Files:**
- Modify: `src/memory/distiller.ts`
- Test: `tests/distiller.test.ts`
- Test（连带修 helper，类型变更波及）: `tests/dedup.test.ts`、`tests/scheduler.test.ts`、`tests/e2e.test.ts`

**Interfaces:**
- Produces（后续 task 依赖）:
  ```ts
  export type DistillOrigin = 'user-stated' | 'user-confirmed' | 'agent-observed'
  export interface DistillCandidate {
    title: string
    bodyMd: string
    scopeType: MemoryScope
    runtime: RuntimeTag
    distillAction: 'new' | 'update_of' | 'duplicate_of' | 'conflict_with'
    origin: DistillOrigin        // LLM 漏标/非法/贴金（stated 但 evidence 空）→ 'agent-observed'
    evidence: string | null      // 出处原句摘抄；空串/非串 → null
    subjectSlug: string | null
  }
  ```
  `ruleObject` 字段从 `DistillCandidate` **删除**（valueFilter 在 Task 2 摘除消费点；dedup.ts 源码不消费 ruleObject，仅测试 helper 携带，同步删）。

- [ ] **Step 1: 写失败测试**（tests/distiller.test.ts 新增；先删/改旧的 ruleObject 三测试：`defaults missing ruleObject to codebase`、`parses explicit ruleObject=domain`、`retries when ruleObject is invalid`——ruleObject 退役后这三个测试整体删除）

```ts
test('distillTranscript parses origin/evidence (user-stated)', async () => {
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
  expect(result.candidates[0]!.evidence).toBe('任何改动必须走分支+PR')
})

test('distillTranscript downgrades stated-origin with empty evidence to agent-observed (贴金防护)', async () => {
  // 回归锁（spec §R1）：标了 user-stated 却摘不出原话 -> 降级 agent-observed，
  // 防止弱模型乱贴高价值标签骗取 derivable 免疫。
  const result = await distillTranscript({
    turns: [{ role: 'user', content: 'x' }],
    runtime: 'claude-code', cwd: '/x', existingSlugs: [],
    callLLM: async () => JSON.stringify({ candidates: [{
      title: '[category:convention] t', bodyMd: 'b', origin: 'user-stated', evidence: '  ',
    }] }),
  })
  expect(result.candidates[0]!.origin).toBe('agent-observed')
  expect(result.candidates[0]!.evidence).toBeNull()
})

test('distillTranscript defaults missing/invalid origin to agent-observed after retry', async () => {
  // 非法 origin 触发一次 retry（shouldRetry）；retry 耗尽后降级 agent-observed 不丢候选。
  let calls = 0
  const result = await distillTranscript({
    turns: [{ role: 'user', content: 'x' }],
    runtime: 'claude-code', cwd: '/x', existingSlugs: [],
    callLLM: async () => { calls++; return JSON.stringify({ candidates: [{
      title: '[category:convention] t', bodyMd: 'b', origin: 'bogus',
    }] }) },
  })
  expect(calls).toBeGreaterThan(1)
  expect(result.candidates[0]!.origin).toBe('agent-observed')
})

test('DISTILLER_SYSTEM_PROMPT carries origin/evidence rules and drops the blanket repo-detail REJECT', () => {
  // prompt 文本断言（与既有 distiller prompt 测试同模式）：
  // 含 origin/evidence 说明 + 贴金硬约束；「用户亲口陈述的关于本仓库的规则/决策/约束必须记」；
  // 不再有 ruleObject 段。
  expect(DISTILLER_SYSTEM_PROMPT).toContain('user-stated')
  expect(DISTILLER_SYSTEM_PROMPT).toContain('user-confirmed')
  expect(DISTILLER_SYSTEM_PROMPT).toContain('agent-observed')
  expect(DISTILLER_SYSTEM_PROMPT).toContain('evidence')
  expect(DISTILLER_SYSTEM_PROMPT).toContain('必须记')
  expect(DISTILLER_SYSTEM_PROMPT).not.toContain('ruleObject')
})
```

- [ ] **Step 2: 跑测试确认失败** `bun test tests/distiller.test.ts`（origin/evidence 未实现，红）

- [ ] **Step 3: 实现**（src/memory/distiller.ts）

类型与解析：

```ts
export type DistillOrigin = 'user-stated' | 'user-confirmed' | 'agent-observed'

export interface DistillCandidate {
  title: string
  bodyMd: string
  scopeType: MemoryScope
  runtime: RuntimeTag
  distillAction: 'new' | 'update_of' | 'duplicate_of' | 'conflict_with'
  /** 出处（spec §R1）。LLM 漏标/非法 → 'agent-observed'（精度优先：不保护）。 */
  origin: DistillOrigin
  /** 出处原句摘抄。stated/confirmed 但 evidence 空 → origin 降级 agent-observed（贴金防护）。 */
  evidence: string | null
  /** 主题归组键（spec §4.3）。LLM 漏标/非法时 normalizeSubjectSlug 降级为 null。 */
  subjectSlug: string | null
}
```

`distillShouldRetry`：删 ruleObject 校验，加 origin 校验（紧跟 slug 校验之后）：

```ts
const og = (c as { origin?: unknown }).origin
if (og !== undefined && og !== 'user-stated' && og !== 'user-confirmed' && og !== 'agent-observed') {
  return `候选 ${i} 的 origin 非法（必须是 user-stated/user-confirmed/agent-observed）`
}
```

解析循环（替换 `const rawSubject = o.ruleObject` 段）：

```ts
const rawOrigin = o.origin
let origin: DistillOrigin =
  rawOrigin === 'user-stated' || rawOrigin === 'user-confirmed' ? rawOrigin : 'agent-observed'
const evidence =
  typeof o.evidence === 'string' && o.evidence.trim() ? o.evidence.trim() : null
// 贴金防护（spec §R1）：摘不出原话就不许戴 user-stated/user-confirmed 的帽子。
if (origin !== 'agent-observed' && evidence === null) origin = 'agent-observed'
out.push({
  title: o.title, bodyMd: o.bodyMd, scopeType: scope, runtime: rt as RuntimeTag,
  distillAction: action, origin, evidence, subjectSlug: normalizeSubjectSlug(o.subjectSlug),
})
```

prompt 改动（`DISTILLER_SYSTEM_PROMPT`）：

1. **删除** ruleObject 整段（「对每条候选标记 ruleObject」到示例结束）。
2. **替换**「Also REJECT 被开发仓库自身源码的实现细节…」整句为：

   ```
   不要复述 agent 读到的文件内容或符号细节（那些翻翻代码就能重新知道，不算记忆）。
   但用户亲口陈述的关于本仓库的规则、决策、约束、偏好必须记——用户说过就是价值，
   与它在代码里能否看到无关。
   ```
3. 在 subjectSlug 段之后新增 origin/evidence 段：

   ```
   对每条候选标记 origin（出处）：
   - user-stated = 用户原话明确说出的规则、决策、约束、偏好。
   - user-confirmed = agent 提出、用户明确采纳（"对"/"就这么办"/"可以"）。
   - agent-observed = 其余一切（agent 从工具报错/代码阅读/事件自行总结）。

   每条候选必须带 evidence：从 transcript 摘抄的出处原句（不超过 1 句；user-confirmed
   摘 agent 提议句 + 用户采纳句；agent-observed 摘观察依据的对话片段）。
   硬约束：找不到原话出处，就不许标 user-stated / user-confirmed，只能标 agent-observed。
   ```
4. JSON 模板里 `"ruleObject": "codebase"` 换成 `"origin": "user-stated", "evidence": "每个 PR 必须在 CHANGELOG.md 的 Unreleased 部分加一条"`。

- [ ] **Step 4: 修连带测试 helper**（ruleObject 字段从 DistillCandidate 删除后，以下文件的候选字面量同步删 `ruleObject: '...'`、按需补 `origin: 'agent-observed', evidence: null`）：tests/dedup.test.ts（4+ 处）、tests/scheduler.test.ts（cand helper）、tests/e2e.test.ts（若有候选字面量）。

- [ ] **Step 5: 跑全量** `bun run typecheck && bun test` 全绿。

- [ ] **Step 6: Commit**

```bash
git add src/memory/distiller.ts tests/distiller.test.ts tests/dedup.test.ts tests/scheduler.test.ts tests/e2e.test.ts
git commit -m "feat(distiller): 候选输出 origin/evidence，ruleObject 退役（spec §R1）"
```

---

### Task 2: valueFilter 重写——九分类 judge（6 留 3 丢）+ stated 免疫兜底

**Files:**
- Modify: `src/memory/valueFilter.ts`
- Test: `tests/valueFilter.test.ts`（大改）

**Interfaces:**
- Consumes: `DistillCandidate.origin` / `.evidence`（Task 1）。
- Produces（后续 task 依赖）:
  ```ts
  export type ValueClass = 'user-rule' | 'decision' | 'preference' | 'convention' | 'trap' | 'topology'
  export type DiscardReason = 'public-knowledge' | 'derivable' | 'taming' | 'fleeting'
  // judgeValue(candidates, callLLM) 签名不变；ValueVerdict 形状不变。
  ```
  **删除导出**：`VALUE_PROTECTED_CATEGORIES`、`parseCategory`（grep 确认仅 valueFilter 自身与测试消费；invariant×domain 强制保留逻辑整体退役，spec §模块改动点 2）。

- [ ] **Step 1: 写失败测试**（tests/valueFilter.test.ts；旧的 protected/parseCategory/ruleObject 相关测试删除，下列新增）

```ts
const cand = (title: string, origin: 'user-stated' | 'user-confirmed' | 'agent-observed' = 'agent-observed'): DistillCandidate =>
  ({ title, bodyMd: 'b', scopeType: 'project', runtime: null, distillAction: 'new',
     origin, evidence: origin === 'agent-observed' ? null : '原话出处', subjectSlug: null })

test('judgeValue maps user-rule/preference to keep:true with valueClass（扩编筐）', async () => {
  const v = await judgeValue([cand('a'), cand('b')], async () => verdictsJson(
    { index: 0, category: 'user-rule' }, { index: 1, category: 'preference' },
  ))
  expect(v).toEqual([
    { index: 0, keep: true, valueClass: 'user-rule' },
    { index: 1, keep: true, valueClass: 'preference' },
  ])
})

test('judgeValue maps fleeting to keep:false（新丢弃理由）', async () => {
  const v = await judgeValue([cand('a')], async () => verdictsJson({ index: 0, category: 'fleeting' }))
  expect(v).toEqual([{ index: 0, keep: false, reason: 'fleeting' }])
})

test('judgeValue 代码硬兜底：user-stated 被判 derivable → 改判 keep+decision（7-30 误杀回归锁）', async () => {
  // 回归锁（spec §R2）：2026-07-30 事故——用户确认的「凭证链优先级」等被 LLM 判
  // derivable 全数误杀。prompt 禁考 Q2 之外，代码层必须再兜一道。
  const v = await judgeValue([cand('[category:architecture] 凭证链优先级', 'user-confirmed')],
    async () => verdictsJson({ index: 0, category: 'derivable' }))
  expect(v).toEqual([{ index: 0, keep: true, valueClass: 'decision' }])
})

test('judgeValue：agent-observed 被判 derivable 正常丢弃（兜底不误伤）', async () => {
  const v = await judgeValue([cand('[category:data-semantics] 打码前6后4')],
    async () => verdictsJson({ index: 0, category: 'derivable' }))
  expect(v).toEqual([{ index: 0, keep: false, reason: 'derivable' }])
})

test('judgeValue fleeting 可丢弃 user-stated（Q3 是 AI 对用户话语的判断权）', async () => {
  const v = await judgeValue([cand('今天先到这吧', 'user-stated')],
    async () => verdictsJson({ index: 0, category: 'fleeting' }))
  expect(v).toEqual([{ index: 0, keep: false, reason: 'fleeting' }])
})

test('judgeValue LLM 失败兜底：stated/confirmed → keep+decision；observed → keep+null', async () => {
  const v = await judgeValue(
    [cand('a', 'user-stated'), cand('b', 'user-confirmed'), cand('c')],
    async () => { throw new Error('api down') },
  )
  expect(v).toEqual([
    { index: 0, keep: true, valueClass: 'decision' },
    { index: 1, keep: true, valueClass: 'decision' },
    { index: 2, keep: true, valueClass: null },
  ])
})

test('judgeValue user prompt carries origin tag per candidate', async () => {
  let captured = ''
  await judgeValue([cand('[category:x] t', 'user-stated')],
    async (_sys, user) => { captured = user; return verdictsJson({ index: 0, category: 'user-rule' }) })
  expect(captured).toContain('origin: user-stated')
})

test('VALUE_JUDGE_SYSTEM_PROMPT 含三考题 + Q2 禁用规则 + 9 类定义，且无 ruleObject', () => {
  const p = VALUE_JUDGE_SYSTEM_PROMPT
  for (const s of ['user-rule', 'preference', 'fleeting', 'derivable', 'public-knowledge',
    'user-stated', 'user-confirmed', 'agent-observed']) expect(p).toContain(s)
  expect(p).not.toContain('ruleObject')
  // 中性硬约束（沿用既有 banned 词表）
  const lower = p.toLowerCase()
  for (const w of ['discard', 'keep', 'dangerous', 'unsure', 'cautious', 'careful', 'reject',
    "don't", 'avoid', 'important', 'valuable']) {
    expect(lower).not.toContain(w)
  }
})
```

（保留并适配既有测试：fence-wrapped JSON、retry-on-invalid、missing index→keep+null、空候选不调 LLM、taming override 系列——把 `category: 'decision'` 等旧断言保留即可，ruleObject hint 从 user prompt 消失需同步改 `user prompt includes title and bodyMd` 等断言。）

- [ ] **Step 2: 跑测试确认失败** `bun test tests/valueFilter.test.ts`

- [ ] **Step 3: 实现**（src/memory/valueFilter.ts 关键改动）

类型与常量：

```ts
export type ValueClass = 'user-rule' | 'decision' | 'preference' | 'convention' | 'trap' | 'topology'
export type DiscardReason = 'public-knowledge' | 'derivable' | 'taming' | 'fleeting'

const VALID_CATEGORIES = new Set([
  'user-rule', 'decision', 'preference', 'convention', 'trap', 'topology',
  'public-knowledge', 'derivable', 'fleeting',
])
const DISCARD_CATEGORIES = new Set(['public-knowledge', 'derivable', 'fleeting'])
const VALUE_CLASS_MAP: Record<string, ValueClass> = {
  'user-rule': 'user-rule', decision: 'decision', preference: 'preference',
  convention: 'convention', trap: 'trap', topology: 'topology',
}
```

新 `VALUE_JUDGE_SYSTEM_PROMPT`（**逐字用词自查 banned 词表后再提交**；retain/drop 措辞，不得出现 keep/discard）：

```ts
export const VALUE_JUDGE_SYSTEM_PROMPT = `You are memside-value-judge. Assign exactly one category to each candidate memory.

Each candidate carries an origin tag: user-stated (the user said it in this session),
user-confirmed (the agent proposed it and the user explicitly adopted it), or
agent-observed (the agent derived it on its own).

Retain categories (assign the best fit):
1. user-rule - an explicit rule or hard constraint the user laid down: workflow rules,
   quality bars, safety constraints.
2. decision - the WHY behind a choice the user made or adopted: rejected alternatives,
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
   HARD RULE: never assign derivable to a candidate whose origin is user-stated or
   user-confirmed.
9. fleeting - TEST: in a brand-new session three months from now, would this entry
   still bind or inform? ("let's stop here for today" -> no; "every change lands via
   branch + PR" -> yes.)

输出格式如下（仅示范结构，勿照抄内容；只输出这一个 JSON 对象，无 markdown 围栏，无解释文字）：
{
  "verdicts": [
    {"index": 0, "category": "decision"},
    {"index": 1, "category": "public-knowledge"}
  ]
}
Emit one verdict per candidate, keyed by index.`
```

`renderUserPrompt`（ruleObject hint 换成 origin，附 evidence 供 Q3 判断）：

```ts
function renderUserPrompt(candidates: DistillCandidate[]): string {
  return candidates.map((c, i) =>
    `[${i}] (origin: ${c.origin}) ${c.title}\n${c.bodyMd}${c.evidence ? `\n出处: ${c.evidence}` : ''}`,
  ).join('\n---\n')
}
```

`judgeValueBase`：删 `parseCategory` / `VALUE_PROTECTED_CATEGORIES` 及其全部消费；`keepNull` 改为：

```ts
const keepNull = (): ValueVerdict[] =>
  candidates.map((c, i) => ({
    index: i,
    keep: true,
    // R3 失败兜底（spec）：用户陈述类给 decision（免疫批量拒绝），observed 给 null。
    valueClass: c.origin === 'agent-observed' ? null : ('decision' as ValueClass),
  }))
```

verdict 映射（judgeValueBase 主路径内）加代码硬兜底：

```ts
if (DISCARD_CATEGORIES.has(o.category)) {
  // 代码硬兜底（spec §R2，7-30 误杀回归锁）：用户陈述类免疫 derivable。
  // prompt 已禁考 Q2；LLM 违规时这里改判 keep+decision。
  if (o.category === 'derivable' && candidates[o.index]!.origin !== 'agent-observed') {
    byIndex.set(o.index, { index: o.index, keep: true, valueClass: 'decision' })
  } else {
    byIndex.set(o.index, { index: o.index, keep: false, reason: o.category as DiscardReason })
  }
} else {
  byIndex.set(o.index, { index: o.index, keep: true, valueClass: VALUE_CLASS_MAP[o.category] })
}
```

返回值末段（原 protected force-keep 位置）简化为：

```ts
return candidates.map((c, i) => byIndex.get(i) ?? {
  index: i, keep: true,
  valueClass: c.origin === 'agent-observed' ? null : ('decision' as ValueClass),
})
```

taming override（judgeValue 外层）原样不动。

- [ ] **Step 4: 跑全量** `bun run typecheck && bun test` 全绿（注意 scheduler.test.ts / store-discard.test.ts 若有 DiscardReason 联合类型断言需同步加 `'fleeting'`）。

- [ ] **Step 5: Commit**

```bash
git add src/memory/valueFilter.ts tests/valueFilter.test.ts
git commit -m "feat(value-filter): 九分类 judge 重写（6 留 3 丢 + stated 免疫 derivable 兜底）（spec §R2）"
```

---

### Task 3: memories 加 origin/evidence 列（schema + 幂等迁移 + store 读写）

**Files:**
- Modify: `src/db/schema.ts`、`src/db/client.ts`、`src/memory/store.ts`
- Test: `tests/schema.test.ts`、`tests/store-crud.test.ts`

**Interfaces:**
- Consumes: `DistillOrigin`（Task 1）、`DiscardReason`（Task 2）。
- Produces（后续 task 依赖）:
  ```ts
  // store.ts
  MemoryInput: + origin?: DistillOrigin | null; + evidence?: string | null
  Memory:      + origin: DistillOrigin | null; + evidence: string | null
  DiscardRecord.reason: DiscardReason（替代原手抄联合类型）
  ```

- [ ] **Step 1: 写失败测试**（tests/schema.test.ts 新增；tests/store-crud.test.ts 的 all-columns 断言数组加 `'origin'`/`'evidence'`）

```ts
test('memories has origin/evidence columns after openDb (fresh + reopened)', () => {
  const db1 = openDb(tmpPath)
  const cols1 = (db1 as any)._.session ?? null // 不用内部 API；用 better-sqlite 直查：
  // 实现：tests 里直接 new Database(tmpPath) PRAGMA table_info(memories)
  // 断言含 origin、evidence；close 后再次 openDb（走迁移分支）仍幂等不抛。
})
```

（tests/schema.test.ts 已有同模式迁移测试——新列断言照其既有 helper 写，不引入新工具。store-crud 新增：createCandidate 传 origin/evidence 后 getMemoryById 读回一致；不传则为 null。）

- [ ] **Step 2: 跑测试确认失败** `bun test tests/schema.test.ts tests/store-crud.test.ts`

- [ ] **Step 3: 实现**

`src/db/schema.ts` memories 表 subjectSlug 之后加：

```ts
origin: text('origin'),   // nullable: user-stated|user-confirmed|agent-observed；老行 NULL = 未标注
evidence: text('evidence'), // nullable: 出处原句摘抄；老行 NULL
```

`src/db/client.ts`：

1. 新建表 DDL 的 `subject_slug TEXT,` 之后加 `origin TEXT,` `evidence TEXT,`。
2. **在 subagent 表重建块之后**加迁移块（顺序是正确性依赖：重建产出的表也没这两列，统一由这里 ALTER 补齐；spec §数据模型「表重建注意」以本顺序落地——重建块不动，降低迁移风险）：

```ts
// Idempotent migration: add origin/evidence to pre-existing memories tables.
// 出处驱动价值判定（spec §数据模型）。无 backfill（老行 NULL = 未标注）。
// 刻意放在 subagent 表重建块之后：旧库若走重建，memories_new 同样没有这两列，
// 由这里的 ALTER 统一补齐——fresh DDL / 重建 / 直接 ALTER 三条路径殊途同归。
{
  const cols = raw.prepare('PRAGMA table_info(memories)').all() as { name: string }[]
  if (!cols.some((c) => c.name === 'origin')) {
    raw.exec('ALTER TABLE memories ADD COLUMN origin TEXT')
  }
  if (!cols.some((c) => c.name === 'evidence')) {
    raw.exec('ALTER TABLE memories ADD COLUMN evidence TEXT')
  }
}
```

`src/memory/store.ts`：

```ts
import type { DistillOrigin } from './distiller'
import type { DiscardReason, ValueClass } from './valueFilter'

// MemoryInput 加：
/** 出处（spec §R1）；缺省/null = 未标注（老行/手动记忆/promoteDiscard 提升行）。 */
origin?: DistillOrigin | null
/** 出处原句摘抄；缺省/null = 无。 */
evidence?: string | null

// Memory 加：
origin: DistillOrigin | null
evidence: string | null

// createCandidate insert values 加：
origin: input.origin ?? null, evidence: input.evidence ?? null,
// rowToMemory 加：
origin: (r.origin ?? null) as DistillOrigin | null, evidence: r.evidence ?? null,
// createCandidate 返回用的 rowToMemory 字面量同步加 origin/evidence。

// DiscardRecord.reason 类型替换为 DiscardReason（含 'fleeting'）：
reason: DiscardReason
```

- [ ] **Step 4: 跑全量** `bun run typecheck && bun test` 全绿。

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts src/db/client.ts src/memory/store.ts tests/schema.test.ts tests/store-crud.test.ts
git commit -m "feat(store): memories 加 origin/evidence 列（幂等迁移）+ DiscardReason 加 fleeting（spec §数据模型）"
```

---

### Task 4: scheduler 接线——origin/evidence 随候选入库

**Files:**
- Modify: `src/scheduler.ts:194-210`（createCandidate 调用点）
- Test: `tests/scheduler.test.ts`

**Interfaces:**
- Consumes: `DistillCandidate.origin/.evidence`（Task 1）、`MemoryInput.origin/.evidence`（Task 3）。
- Produces: 无新接口（tick 行为变化：入库候选带 origin/evidence）。

- [ ] **Step 1: 写失败测试**（tests/scheduler.test.ts 新增）

```ts
test('tick 入库候选携带 origin/evidence（用户陈述类端到端入库）', async () => {
  // 用既有 scheduler.test.ts 的 tick harness（enqueue job + fake loadTranscript +
  // dispatch-by-system-prompt 的 callLLM mock）。distill mock 返回一条
  // origin='user-stated', evidence='任何改动必须走分支+PR' 的候选；
  // dedup mock 返回非重复；judge mock 返回 user-rule。
  // 断言：createCandidate 收到的 input.origin === 'user-stated'、
  // input.evidence === '任何改动必须走分支+PR'、input.valueClass === 'user-rule'。
})
```

- [ ] **Step 2: 跑测试确认失败** `bun test tests/scheduler.test.ts`

- [ ] **Step 3: 实现**（src/scheduler.ts createCandidate 调用点加两行）

```ts
await deps.createCandidate(db, {
  // …既有字段不动…
  valueClass: k.valueClass,
  subjectSlug: k.cand.subjectSlug,
  origin: k.cand.origin,      // 新增（spec §模块改动点 3）
  evidence: k.cand.evidence,  // 新增
})
```

同时更新 tick 内 value filter 段的注释（protected categories 描述已过期）：

```ts
// Value filter: 九分类（spec §R2）。public-knowledge/derivable/fleeting => discard
// (audit-logged)；6 价值筐 => keep with valueClass。用户陈述类免疫 derivable
// （judgeValue 代码兜底）。judgeValue swallows its own LLM errors
// （stated→decision / observed→null），never bubbles.
```

- [ ] **Step 4: 跑全量** `bun run typecheck && bun test` 全绿。

- [ ] **Step 5: Commit**

```bash
git add src/scheduler.ts tests/scheduler.test.ts
git commit -m "feat(scheduler): origin/evidence 随 createCandidate 入库（spec §模块改动点 3）"
```

---

### Task 5: server 透传断言 + web-api 类型

**Files:**
- Modify: `src/web/api.ts:15-30`（MemoryItem）
- Test: `tests/server.test.ts`、`tests/web-api.test.ts`

**Interfaces:**
- Consumes: `Memory.origin/.evidence`（Task 3）。
- Produces（Task 6 依赖）:
  ```ts
  // web/api.ts MemoryItem 加：
  origin?: string | null
  evidence?: string | null
  ```

- [ ] **Step 1: 写失败测试**

tests/server.test.ts（先读 `GET /api/memories` 处理器确认它直接序列化 store `Memory`——预期 server 零改动；本测试是透传锁定）：

```ts
test('GET /api/memories 透传 origin/evidence', async () => {
  // seed 一条 origin='user-stated', evidence='原话' 的候选（store.createCandidate），
  // req GET /api/memories?status=candidate，断言 items[0].origin / .evidence 一致。
})
```

tests/web-api.test.ts：listMemories 返回带 origin/evidence 的 fixture，断言字段穿出。

- [ ] **Step 2: 跑测试确认**——若 server 透传测试直接绿（rowToMemory 已带新字段），保留测试作锁定并在 commit message 注明「server 零改动，测试锁定透传」；若红则按红的字段补齐（预期不需要）。

- [ ] **Step 3: 实现**（src/web/api.ts MemoryItem 加两字段）

```ts
export interface MemoryItem {
  // …既有字段…
  valueClass?: string | null
  /** 出处（spec §R1）；老行/手动记忆为 null。 */
  origin?: string | null
  /** 出处原句摘抄。 */
  evidence?: string | null
}
```

- [ ] **Step 4: 跑全量** `bun run typecheck && bun test` 全绿。

- [ ] **Step 5: Commit**

```bash
git add src/web/api.ts tests/server.test.ts tests/web-api.test.ts
git commit -m "feat(web-api): MemoryItem 加 origin/evidence + server 透传锁定测试"
```

---

### Task 6: Web UI——origin 徽标 + evidence 出处行 + 6 筐徽标 + fleeting 文案

**Files:**
- Modify: `src/web/ui-utils.ts`、`src/web/App.tsx:19-27`（VALUE_LABEL/priorityRank）、`src/web/App.tsx` MemoryCard 卡片区（~:505-510）、DiscardCard（~:576）
- Test: `tests/ui-utils.test.ts`、`tests/web-ui.test.ts`

**Interfaces:**
- Consumes: `MemoryItem.origin/.evidence`（Task 5）。
- Produces:
  ```ts
  // ui-utils.ts
  export function originBadge(origin: string | null | undefined): { label: string; color: string } | null
  export function discardReasonLabel(reason: string): string
  ```

- [ ] **Step 1: 写失败测试**（tests/ui-utils.test.ts）

```ts
test('originBadge: user-stated/user-confirmed/agent-observed/null 映射', () => {
  expect(originBadge('user-stated')).toEqual({ label: '用户陈述', color: '#6a1b9a' })
  expect(originBadge('user-confirmed')).toEqual({ label: '用户采纳', color: '#00838f' })
  expect(originBadge('agent-observed')).toEqual({ label: 'agent 观察', color: '#999' })
  expect(originBadge(null)).toBeNull()
  expect(originBadge(undefined)).toBeNull()
})

test('discardReasonLabel: 四理由中文化 + 未知原样', () => {
  expect(discardReasonLabel('public-knowledge')).toBe('公开知识')
  expect(discardReasonLabel('derivable')).toBe('可从代码推导')
  expect(discardReasonLabel('taming')).toBe('驯化指令')
  expect(discardReasonLabel('fleeting')).toBe('一次性/琐事')
  expect(discardReasonLabel('bogus')).toBe('bogus')
})
```

tests/web-ui.test.ts：MemoryCard 源码层文本断言（与既有同模式）——`App.tsx` 含 `出处：` 与 `originBadge(`；VALUE_LABEL 含 `'user-rule'`、`preference`。

- [ ] **Step 2: 跑测试确认失败** `bun test tests/ui-utils.test.ts tests/web-ui.test.ts`

- [ ] **Step 3: 实现**

`src/web/ui-utils.ts` 追加：

```ts
/** 出处徽标（审批卡片用）。null/undefined（老行未标注）不显示。纯函数，可单测。 */
export function originBadge(origin: string | null | undefined): { label: string; color: string } | null {
  if (origin === 'user-stated') return { label: '用户陈述', color: '#6a1b9a' }
  if (origin === 'user-confirmed') return { label: '用户采纳', color: '#00838f' }
  if (origin === 'agent-observed') return { label: 'agent 观察', color: '#999' }
  return null
}

/** AI 自动拒绝理由中文化（DiscardCard 用）。未知 reason 原样显示（向后兼容）。 */
export function discardReasonLabel(reason: string): string {
  const m: Record<string, string> = {
    'public-knowledge': '公开知识',
    derivable: '可从代码推导',
    taming: '驯化指令',
    fleeting: '一次性/琐事',
  }
  return m[reason] ?? reason
}
```

`src/web/App.tsx`：

1. import 行加 `originBadge, discardReasonLabel`。
2. VALUE_LABEL / priorityRank 扩 6 筐（spec §模块改动点 6：user-rule=decision=高；preference=convention=trap=topology=中）：

```ts
const VALUE_LABEL: Record<string, string> = {
  'user-rule': '高·规矩', decision: '高·决策',
  preference: '中·偏好', convention: '中·约定', trap: '中·陷阱', topology: '中·拓扑',
}
function priorityRank(vc: string | null | undefined): number {
  if (vc === 'user-rule' || vc === 'decision') return 0
  if (vc && VALUE_LABEL[vc]) return 1
  return 2
}
```

3. MemoryCard 卡片区（valueBadge 行之后）加 origin 徽标 + evidence 出处行：

```tsx
{(() => { const ob = originBadge(m.origin); return ob ? (
  <span style={{ marginLeft: 8, fontSize: 12, color: ob.color }}>{ob.label}</span>
) : null })()}
{m.evidence ? (
  <p style={{ color: '#6a1b9a', fontSize: 13, margin: '4px 0' }}>出处：{m.evidence}</p>
) : null}
```

4. DiscardCard：`{d.reason}` → `{discardReasonLabel(d.reason)}`。

- [ ] **Step 4: 跑全量** `bun run typecheck && bun test` 全绿；另 `bun run dev:web` 手测一遍审批 tab 徽标/出处行渲染（daemon 有旧数据时老行无徽标为预期）。

- [ ] **Step 5: Commit**

```bash
git add src/web/ui-utils.ts src/web/App.tsx tests/ui-utils.test.ts tests/web-ui.test.ts
git commit -m "feat(web): 审批卡片 origin 徽标 + evidence 出处行 + 6 筐徽标 + fleeting 中文文案"
```

---

### Task 7: e2e 门禁回归测试（7-30 误杀事故锁）

**Files:**
- Test: `tests/origin-value-judgment.test.ts`（新建）

**Interfaces:**
- Consumes: 全部前序 task（tick 端到端：distill → dedup → judgeValue → 入库/审计）。

- [ ] **Step 1: 写测试**（直接写全量；本 task 是门禁，无实现代码）

```ts
import { test, expect } from 'bun:test'
// 复用 tests/scheduler.test.ts 的 tick harness 模式：
// openDb(:memory:) 或 tmp 文件 -> enqueueDistillJob -> tick(db, { loadTranscript, callLLM, createCandidate })

// 门禁 1（spec §测试策略 e2e）：用户陈述的本仓库决策在 LLM 误判 derivable 时
// 仍入库且不进 discards —— 2026-07-30 误杀事故回归锁。
test('门禁：user-confirmed 候选被 judge 误判 derivable → 仍入库 valueClass=decision、无 discards 行', async () => {
  // callLLM 按 system prompt 分发：
  //   sys 含 'memside-distiller'    -> candidates: [{title:'[category:architecture] 凭证链优先级 UI>settings>env',
  //                                  bodyMd:'用户确认，因 env 残留曾致 401', origin:'user-confirmed',
  //                                  evidence:'凭证链 UI 优先', scope:'project', runtime:'claude-code'}]
  //   sys 含 'memside-value-judge'  -> verdicts: [{index:0, category:'derivable'}]（模拟 LLM 违规）
  //   其余（dedup）                 -> verdicts: [{index:0, duplicate:false}]
  // 断言：memories 表 1 行 candidate，origin='user-confirmed'，value_class='decision'；
  //       memory_discards 0 行。
})

// 门禁 2：fleeting 丢弃进审计表且可提升（spec §测试策略）。
test('门禁：agent-observed 琐事被判 fleeting → 进 memory_discards，promoteDiscard 可捞回', async () => {
  // distill 返回 origin='agent-observed' 候选；judge mock 返回 category:'fleeting'。
  // 断言：memories 0 行；memory_discards 1 行 reason='fleeting'；
  //       promoteDiscard(db, discardId) 返回 candidate 行。
})
```

- [ ] **Step 2: 跑测试** `bun test tests/origin-value-judgment.test.ts`（应直接绿；红说明前序 task 有缺口，回修对应 task，不在本 task 内补实现）。

- [ ] **Step 3: 跑全量** `bun run typecheck && bun test` 全绿。

- [ ] **Step 4: Commit**

```bash
git add tests/origin-value-judgment.test.ts
git commit -m "test(e2e): 出处驱动价值判定门禁（7-30 误杀回归锁 + fleeting 丢弃可提升）"
```

---

### Task 8: 全量验证 + STATE.md 记录

**Files:**
- Modify: `STATE.md`

- [ ] **Step 1:** `bun run typecheck && bun test` 全绿（最终门禁）。
- [ ] **Step 2:** STATE.md 追加本轮段落（设计 spec/计划链接、规则全集摘要、7-30 回归锁、deferred：grep 预检第二期 / 存量重判 / evidence 入注入块）。
- [ ] **Step 3: Commit**

```bash
git add STATE.md
git commit -m "docs(state): 记录出处驱动价值判定交付（8-task）"
```

---

## Self-Review 记录

- **Spec 覆盖**：R0（Task 2 taming 不动）/ R1（Task 1）/ R2 三生考+6 筐+双保险（Task 2、兜底 Task 2+7）/ R3（Task 2 keepNull）/ R4（不动）；数据模型（Task 3）；模块改动点 1-6（Task 1/2/4/3/5/6）；测试策略（各 task + Task 7）；非目标未夹带。✅
- **Placeholder 扫描**：无 TBD/TODO；所有代码步骤含实际代码。Task 5 Step 2 的「若红则补齐」是有意的透传探针（server 预期零改动，spec 允许透传）。✅
- **类型一致性**：`DistillOrigin`（Task 1 定义）→ store（Task 3）→ web-api 用 `string|null`（Task 5，与 valueClass 同模式）→ ui-utils 接 `string|null|undefined`（Task 6）一致；`DiscardReason` 加 fleeting（Task 2 定义）→ store.DiscardRecord（Task 3 消费）一致；`ValueClass` 6 值（Task 2）→ VALUE_LABEL 6 键（Task 6）一致。✅
- **与 spec 的一处有意偏差**：spec §数据模型说「更新 memories_new DDL 保持一致」，本计划改为「重建块不动 + origin/evidence ALTER 放在重建块之后」——所有升级路径最终 schema 一致（fresh DDL 有列；重建路径 ALTER 补；直接 ALTER 路径补），且不动已验证的重建逻辑，风险更低。Task 3 迁移块注释已写明该决策。✅

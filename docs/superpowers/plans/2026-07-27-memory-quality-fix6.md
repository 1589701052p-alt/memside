# 记忆质量修复第六轮 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 第 1 项 [stated] 起源判定（distiller REJECT 扩展 6 类非陈述排除）+ 第 4 项驯化守卫（valueFilter 确定性 detectTaming + judgeValue 末尾 taming override，丢弃+审计）。

**Architecture:** 第 1 项仅改 `DISTILLER_SYSTEM_PROMPT` 的 REJECT 文案。第 4 项在 `valueFilter.ts` 加纯函数 `detectTaming`（关键词集，精度优先）+ `judgeValue` 拆 `judgeValueBase`（旧逻辑逐字不动）+ 末尾 taming override map（覆盖 protected force-keep，安全>保护）。`DiscardReason` 加 `'taming'`，taming 丢弃走 tick 现有 `logDiscards` 路径（scheduler 不动）。无 schema 迁移（`memory_discards.reason` 是自由 text）。

**Tech Stack:** Bun + Hono + Drizzle + bun:sqlite；测试 bun:test（mock callLLM）。

## Global Constraints

- 第 2 项（校准）、第 3 项（隐私）不做。
- 不加 schema 迁移 / 新表（`memory_discards.reason` 是自由 `TEXT`，无 enum 约束）。
- taming **不加 distiller prompt REJECT**（valueFilter 单 chokepoint，保持 distiller liberal）。
- 第 1 项**不加 valueFilter backstop**（保持 distiller liberal、人工审批兜底）。
- 不动 distiller 的 category 列表 / subject 段 / JSON 模板段；不动 dedup / pure / 注入格式 / scheduler 编排。
- `VALUE_JUDGE_SYSTEM_PROMPT` **逐字不动**（taming 关键词在代码里、不进 system prompt，neutrality 硬约束保持）。
- `judgeValueBase` **逐字搬移**旧 `judgeValue` 函数体，不改任何逻辑（I3 类 specific-source guard 敏感）。
- 测试随改动落地（TDD：先红后绿）；`bun run typecheck && bun test` 全绿才能 push。
- 分支 `feat/memory-quality-fix6`（已从最新 `origin/master` 切出），PR 目标 `master`。

---

## File Structure

| 文件 | 责任 | 本轮改动 |
|---|---|---|
| `src/memory/distiller.ts` | distiller system prompt | REJECT 段加 Origin discipline 6 类排除（行 51-52） |
| `src/memory/valueFilter.ts` | value 分类 + 驯化守卫 | 新增 `TAMING_PATTERNS`+`detectTaming`；`DiscardReason` 加 `'taming'`；`judgeValue` 拆 `judgeValueBase`+override |
| `src/memory/store.ts` | 记忆 CRUD | `DiscardRecord.reason` 类型加 `'taming'`（纯类型） |
| `src/db/schema.ts` | drizzle 表定义 | `memoryDiscards.reason` 注释加 `'taming'`（无 DDL） |
| `tests/distiller.test.ts` | distiller 单测 | 新增 REJECT 6 类排除源码层文本断言 |
| `tests/valueFilter.test.ts` | valueFilter 单测 | 新增 detectTaming 正/负例 + judgeValue override 集成测试 |
| `tests/scheduler.test.ts` | scheduler 单测 | 新增 tick 端到端 taming->logDiscards |

---

## Task 1: 第 1 项 - distiller REJECT 扩展 + 源码层测试

**Files:**
- Modify: `src/memory/distiller.ts:51-52`（REJECT 段）
- Test: `tests/distiller.test.ts`（新增源码层文本断言）

**Interfaces:**
- Consumes: 无（首个任务，独立）
- Produces: `DISTILLER_SYSTEM_PROMPT` 含 6 类非陈述排除。无下游任务依赖。

- [ ] **Step 1: 写失败测试（源码层文本断言）**

在 `tests/distiller.test.ts` 文件末尾追加：

```ts
test('DISTILLER_SYSTEM_PROMPT has [stated] origin discipline with 6 exclusions', () => {
  // 第六轮第 1 项：[stated] 起源判定。distiller 只记用户/领域明确陈述的持久事实，
  // 显式排除六类非陈述内容（推断/前瞻/研究输出/丰富化/道听途说/自己的推理）。
  // 源码层文本断言锁 prompt 契约（LLM 遵循度由 dogfood 验证，非单测范围）。
  expect(DISTILLER_SYSTEM_PROMPT).toContain('Origin discipline')
  expect(DISTILLER_SYSTEM_PROMPT).toContain('推断')
  expect(DISTILLER_SYSTEM_PROMPT).toContain('前瞻')
  expect(DISTILLER_SYSTEM_PROMPT).toContain('研究输出')
  expect(DISTILLER_SYSTEM_PROMPT).toContain('丰富化')
  expect(DISTILLER_SYSTEM_PROMPT).toContain('道听途说')
  expect(DISTILLER_SYSTEM_PROMPT).toContain('推理或建议')
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test tests/distiller.test.ts`
Expected: FAIL - 新测试失败：`DISTILLER_SYSTEM_PROMPT` 不含 `Origin discipline` / `推断` / `前瞻` / `研究输出` / `丰富化` / `道听途说` / `推理或建议`。

- [ ] **Step 3: 改 src/memory/distiller.ts REJECT 段**

`src/memory/distiller.ts:51-52`，把现有：

```
REJECT (emit nothing) if the content is a fleeting status update, mood, or one-off acknowledgement.
Also REJECT 被开发仓库自身源码的实现细节（文件内容、内部实现、配置默认值、符号名）--这些可从仓库源码重新推导，不是持久记忆。把记忆锚定到用户或领域明确陈述的规则、决策与约束；不要总结 agent 读到的文件内容。
```

替换为：

```
Origin discipline（[stated] 起源判定）：只记用户或领域在会话中明确陈述的持久事实、规则、决策与约束。REJECT (emit nothing) 以下六类非陈述内容--它们不是用户/领域陈述的事实，不该当作记忆：
1. 你自己推出的结论或推断（用户没明说，是你脑补的因果、意图或规律）。
2. 前瞻状态、待办、下一步计划（"以后要 X"、"接下来做 Y"）--这些是意图、非已成事实，会过期。
3. 研究输出：搜索结果、文档摘录、你给出的建议或方案（agent 产出，非用户陈述）。
4. 对用户原话的丰富化或升级（用户说"用 bun"，你写成"用户强烈推崇 bun 生态"）。
5. 道听途说（"听说 X"、"人们说 Y"），非用户直接陈述。
6. 你自己的推理或建议过程（即使被用户采纳，记用户的最终决策，不记你的推理链）。

REJECT fleeting status updates, moods, one-off acknowledgements.
Also REJECT 被开发仓库自身源码的实现细节（文件内容、内部实现、配置默认值、符号名）--这些可从仓库源码重新推导，不是持久记忆。不要总结 agent 读到的文件内容。
```

注意：**不动** category 列表（行 11-22）、subject 判定段（行 23-42）、JSON 输出模板（行 54-66）。这些段的既有测试断言（`[category:invariant]` / `business` / `codebase = ` / `domain = ` / `grep` / `具体东西` / `X 模块的 Y 函数` / `"scope": "project"` / `仅示范结构` / `被开发仓库自身源码的实现细节`）必须保持绿。

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test tests/distiller.test.ts`
Expected: PASS（新测试 + 现有 distiller 测试全绿）。特别确认 `DISTILLER_SYSTEM_PROMPT rejects codebase implementation details` 仍绿（`被开发仓库自身源码的实现细节` 短语保留）；subject 段断言全绿（未动）。

- [ ] **Step 5: typecheck + 全量回归**

Run: `bun run typecheck && bun test`
Expected: typecheck 干净；`bun test` 全绿（247 现有测试不回退）。

- [ ] **Step 6: Commit**

```bash
git add src/memory/distiller.ts tests/distiller.test.ts
git commit -m "feat(distiller): [stated] origin discipline - reject 6 non-stated categories

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: 第 4 项 - detectTaming 纯函数 + DiscardReason 类型同步 + 单测

**Files:**
- Modify: `src/memory/valueFilter.ts`（`DiscardReason` 加 `'taming'`；新增 `TAMING_PATTERNS`+`detectTaming`）
- Modify: `src/memory/store.ts:329`（`DiscardRecord.reason` 类型加 `'taming'`）
- Modify: `src/db/schema.ts:90`（`reason` 注释加 `'taming'`）
- Test: `tests/valueFilter.test.ts`（新增 detectTaming 正/负例单测）

**Interfaces:**
- Consumes: 无（独立任务）
- Produces: `detectTaming(title, bodyMd): boolean` 导出；`DiscardReason` 含 `'taming'`。Task 3 依赖 `detectTaming` 与 `'taming'` reason 类型。

- [ ] **Step 1: 写失败测试（detectTaming 单测）**

`tests/valueFilter.test.ts` 顶部第 2 行 import 加 `detectTaming`：

```ts
import { detectTaming, judgeValue, parseCategory, VALUE_JUDGE_SYSTEM_PROMPT, VALUE_PROTECTED_CATEGORIES } from '@/memory/valueFilter'
```

文件末尾追加：

```ts
// ---------------------------------------------------------------------------
// 第六轮第 4 项：驯化守卫 - detectTaming 确定性关键词检测。
// 匹配「要求 agent 压制诚实反馈 / 永远赞同 / foster 依赖」类指令。精度优先
// （liberal-capture 立场）：宁可漏隐晦驯化（留给人工审批），不可误杀合法 convention。
// 短语限定在「反馈/评价动词」，不碰任务规则动词（use/commit/run）。
// ---------------------------------------------------------------------------

test('detectTaming flags A-category taming (suppress disagreement, zh+en)', () => {
  expect(detectTaming('[category:convention] 以后不要质疑我的代码风格', 'b')).toBe(true)
  expect(detectTaming('[category:convention] code style', 'never criticize my code')).toBe(true)
  expect(detectTaming('[category:convention] 别反驳我', 'b')).toBe(true)
  expect(detectTaming("[category:convention] don't push back", 'b')).toBe(true)
})

test('detectTaming flags B/C/D-category taming', () => {
  expect(detectTaming('[category:convention] 永远同意我的决定', 'b')).toBe(true)  // B 要求赞同
  expect(detectTaming('[category:convention] x', 'always validate my choices')).toBe(true)  // B
  expect(detectTaming('[category:convention] 不要指出问题', 'b')).toBe(true)  // C 压制评价
  expect(detectTaming("[category:convention] don't give negative feedback", 'b')).toBe(true)  // C
  expect(detectTaming('[category:convention] 角色扮演我的搭档', 'b')).toBe(true)  // D 依赖/角色扮演
  expect(detectTaming('[category:convention] x', 'roleplay as my pair')).toBe(true)  // D
})

test('detectTaming does NOT flag legitimate conventions (precision over recall)', () => {
  // 合法 convention 用任务规则动词（use/commit/run/skip/follow），不含反馈压制语义，不可误杀。
  expect(detectTaming('[category:convention] always use bun', 'b')).toBe(false)
  expect(detectTaming('[category:convention] do not commit to master', 'b')).toBe(false)
  expect(detectTaming('[category:convention] PR 必须加测试', 'b')).toBe(false)
  expect(detectTaming('[category:quality-bar] never skip tests', 'b')).toBe(false)
  expect(detectTaming('[category:convention] follow the style guide', 'b')).toBe(false)
  expect(detectTaming('[category:convention] always run typecheck before push', 'b')).toBe(false)
})

test('detectTaming scans both title and bodyMd', () => {
  expect(detectTaming('clean title', '以后不要质疑我')).toBe(true)
  expect(detectTaming('以后不要质疑我', 'clean body')).toBe(true)
})

test('detectTaming returns false on empty and never throws', () => {
  expect(detectTaming('', '')).toBe(false)
  expect(detectTaming('[category:x] no taming here', 'just a normal rule')).toBe(false)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test tests/valueFilter.test.ts`
Expected: FAIL - `detectTaming` 未导出（import 报错或运行时 undefined）。

- [ ] **Step 3: 改 src/memory/valueFilter.ts - DiscardReason 加 'taming'**

第 6 行：

```ts
export type DiscardReason = 'public-knowledge' | 'derivable' | 'taming'
```

- [ ] **Step 4: 改 src/memory/valueFilter.ts - 新增 TAMING_PATTERNS + detectTaming**

在 `parseCategory` 函数（第 41-45 行）之后、`VALUE_PROTECTED_CATEGORIES` 注释（第 47 行）之前，插入：

```ts
const TAMING_PATTERNS: readonly string[] = [
  // A 压制异议/批评/质疑
  '不要质疑', '别质疑', '不准质疑', '不要反驳', '别反驳', '不要反对', '别反对',
  '不要批评', '别批评', '不要指责', '不要唱反调', '不要提反对', '不要质疑我', '不要质疑用户',
  'never question', "don't question", 'never criticize', "don't criticize",
  'never criticise', "don't criticise", 'never disagree', "don't disagree",
  'never challenge', "don't challenge", 'never push back', "don't push back",
  'never argue', "don't argue", 'never correct me', "don't correct me", "don't contradict",
  // B 要求赞同/肯定
  '永远同意', '总是同意', '无条件同意', '永远赞同', '总是赞同', '永远支持我', '总是支持我',
  '不要否定', '别否定', '永远肯定', '永远站在我这边',
  'always agree', 'always validate', 'always affirm', 'always support me',
  'never say no', 'always say yes', 'always be agreeable',
  // C 压制诚实评价
  '不要指出问题', '别指出问题', '不要挑毛病', '别挑毛病', '不要给负面', '不要泼冷水',
  '不要给批评性',
  "don't point out problems", 'never point out problems',
  "don't give negative feedback", 'never give negative feedback',
  "don't be critical", 'never be critical',
  // D 依赖/角色扮演（dev 罕见，仅高精度标记）
  '角色扮演', 'roleplay', 'role-play', '永远陪伴', '一直陪着我', 'always be here for me',
]

/**
 * 确定性驯化检测（第 4 项）：匹配「要求 agent 压制诚实反馈 / 永远赞同 / foster 依赖」类
 * 指令。命中即丢弃（valueFilter taming override）。精度优先（liberal-capture 立场）：
 * 宁可漏隐晦驯化（留给人工审批），不可误杀合法 convention。短语限定在「反馈/评价动词」，
 * 不碰任务规则动词（use/commit/run），避免误杀 `always use bun` / `don't commit to master`。
 *
 * 纯函数、永不抛：兜底返回 false（不误杀）。关键词在代码里、不进 LLM system prompt，
 * 故不影响 valueFilter 的 neutrality 硬约束。
 */
export function detectTaming(title: string, bodyMd: string): boolean {
  try {
    const text = `${title}\n${bodyMd}`.toLowerCase()
    return TAMING_PATTERNS.some((p) => text.includes(p.toLowerCase()))
  } catch {
    return false  // 兜底：不误杀，走正常 LLM 分类
  }
}
```

- [ ] **Step 5: 改 src/memory/store.ts - DiscardRecord.reason 加 'taming'**

`src/memory/store.ts` 的 `DiscardRecord` 接口（约第 326-330 行）：

```ts
export interface DiscardRecord {
  title: string
  bodyMd: string
  reason: 'public-knowledge' | 'derivable' | 'taming'
}
```

- [ ] **Step 6: 改 src/db/schema.ts - reason 注释加 'taming'**

`src/db/schema.ts` 的 `memoryDiscards` 表 `reason` 列（约第 90 行）注释：

```ts
    reason: text('reason').notNull(), // 'public-knowledge' | 'derivable' | 'taming'
```

（仅注释更新，无 DDL / 迁移--该列是自由 `TEXT`。）

- [ ] **Step 7: 运行测试确认通过**

Run: `bun test tests/valueFilter.test.ts`
Expected: PASS（新 detectTaming 测试 + 现有 valueFilter 测试全绿）。现有 `judgeValue` 测试不受影响（detectTaming 是新增、未接入 judgeValue）。

- [ ] **Step 8: typecheck + 全量回归**

Run: `bun run typecheck && bun test`
Expected: typecheck 干净；`bun test` 全绿。确认现有 scheduler tick discard 测试仍绿（`DiscardRecord.reason` 加 `'taming'` 是类型放宽，不破坏现有 'public-knowledge'/'derivable' 赋值）。

- [ ] **Step 9: Commit**

```bash
git add src/memory/valueFilter.ts src/memory/store.ts src/db/schema.ts tests/valueFilter.test.ts
git commit -m "feat(valueFilter): detectTaming deterministic guard + 'taming' discard reason

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: 第 4 项 - judgeValue taming override + 集成测试

> **关键**：本任务把现有 `judgeValue` 函数体**逐字搬移**为内部 `judgeValueBase`（不改任何逻辑），新 `judgeValue` 包一层 taming override map。现有 valueFilter 测试（protected force-keep / keepNull fallback / neutrality / subject-gate）必须全绿不回退--它们是非驯化候选，override 不触发。

**Files:**
- Modify: `src/memory/valueFilter.ts:89-146`（`judgeValue` 拆 `judgeValueBase` + override）
- Test: `tests/valueFilter.test.ts`（新增 judgeValue override 集成测试）

**Interfaces:**
- Consumes: Task 2 的 `detectTaming`、`DiscardReason` 含 `'taming'`。
- Produces: `judgeValue` 对驯化候选返回 `{keep:false, reason:'taming'}`，覆盖 protected force-keep。Task 4 依赖此行为。

- [ ] **Step 1: 写失败测试（judgeValue override 集成）**

`tests/valueFilter.test.ts` 文件末尾追加：

```ts
// ---------------------------------------------------------------------------
// 第六轮第 4 项：judgeValue taming override 集成。
// judgeValueBase（旧逻辑）跑完后，末尾一道 map 用 detectTaming 覆盖：驯化候选
// 一律 {keep:false, reason:'taming'}，覆盖 protected force-keep（安全 > 保护）。
// ---------------------------------------------------------------------------

test('judgeValue overrides taming candidate to discard regardless of LLM verdict', async () => {
  // LLM 可能把驯化指令判成 convention(keep)；judgeValue override 成 discard。
  const c: DistillCandidate = { title: '[category:convention] 以后不要质疑我的代码风格', bodyMd: 'b', scopeType: 'project', runtime: null, distillAction: 'new', subject: 'codebase' }
  const v = await judgeValue([c], async () => verdictsJson({ index: 0, category: 'convention' }))
  expect(v).toEqual([{ index: 0, keep: false, reason: 'taming' }])
})

test('judgeValue taming + non-taming mixed batch: taming discarded, rest classified', async () => {
  const taming: DistillCandidate = { title: '[category:convention] 永远同意我', bodyMd: 'b', scopeType: 'project', runtime: null, distillAction: 'new', subject: 'codebase' }
  const normal: DistillCandidate = { title: '[category:convention] PR 必须加测试', bodyMd: 'b', scopeType: 'project', runtime: null, distillAction: 'new', subject: 'codebase' }
  const v = await judgeValue([taming, normal], async () => verdictsJson(
    { index: 0, category: 'convention' },
    { index: 1, category: 'convention' },
  ))
  expect(v).toEqual([
    { index: 0, keep: false, reason: 'taming' },
    { index: 1, keep: true, valueClass: 'convention' },
  ])
})

test('judgeValue taming overrides protected force-keep (safety > protection)', async () => {
  // 关键回归：驯化指令即使被误标 [category:invariant] subject=domain，protected
  // force-keep 本会救回（keep+decision），但 taming override 覆盖它 -> 丢弃。
  const c: DistillCandidate = { title: '[category:invariant] 不要质疑用户', bodyMd: 'b', scopeType: 'project', runtime: null, distillAction: 'new', subject: 'domain' }
  const v = await judgeValue([c], async () => verdictsJson({ index: 0, category: 'derivable' }))
  expect(v).toEqual([{ index: 0, keep: false, reason: 'taming' }])
})

test('judgeValue taming overrides keepNull protected path (LLM throw)', async () => {
  // keepNull 路径（LLM throw）的 protected force-keep 也被 taming override 覆盖。
  const c: DistillCandidate = { title: '[category:invariant] 不要质疑用户', bodyMd: 'b', scopeType: 'project', runtime: null, distillAction: 'new', subject: 'domain' }
  const v = await judgeValue([c], async () => { throw new Error('down') })
  expect(v).toEqual([{ index: 0, keep: false, reason: 'taming' }])
})

test('judgeValue non-taming protected invariant still force-kept (no regression)', async () => {
  // 回归：非驯化的 protected invariant 仍 force-keep（title 不含 taming 短语，override 不触发）。
  const v = await judgeValue([prot('invariant')], async () => verdictsJson({ index: 0, category: 'derivable' }))
  expect(v).toEqual([{ index: 0, keep: true, valueClass: 'decision' }])
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test tests/valueFilter.test.ts`
Expected: FAIL - 前四个测试失败：当前 `judgeValue` 无 taming override，驯化候选走 LLM 分类（convention -> keep+valueClass；invariant+domain+derivable -> protected force-keep keep+decision）。第五个（回归）应已绿。

- [ ] **Step 3: 改 src/memory/valueFilter.ts - 拆 judgeValueBase + 新 judgeValue override**

把现有 `judgeValue` 函数（含其上方的 JSDoc 注释，约第 89-146 行）整体替换为：

```ts
/**
 * Existing value-classification logic (rounds 1-3): keepNull fallback + LLM 6-class
 * classify + protected-category force-keep. Behavior identical to pre-fix6 judgeValue.
 * Extracted (fix6) so judgeValue can layer the taming override on top without touching
 * this logic - see I3-style specific-source guard sensitivity in STATE.md.
 */
async function judgeValueBase(
  candidates: DistillCandidate[],
  callLLM: LLMCall,
): Promise<ValueVerdict[]> {
  const n = candidates.length
  if (n === 0) return []
  const keepNull = (): ValueVerdict[] =>
    candidates.map((c, i) => {
      const cat = parseCategory(c.title)
      const subj = c.subject === 'domain' ? 'domain' : 'codebase'
      return (cat && VALUE_PROTECTED_CATEGORIES.has(cat) && subj === 'domain')
        ? { index: i, keep: true, valueClass: 'decision' as ValueClass }
        : { index: i, keep: true, valueClass: null }
    })
  try {
    const parsed = await callWithRetry({
      call: callLLM,
      system: VALUE_JUDGE_SYSTEM_PROMPT,
      user: renderUserPrompt(candidates),
      shouldRetry: valueShouldRetry(n),
    }) as { verdicts?: unknown } | undefined
    if (!parsed || !Array.isArray(parsed.verdicts)) return keepNull()
    const byIndex = new Map<number, ValueVerdict>()
    for (const v of parsed.verdicts) {
      if (!v || typeof v !== 'object') continue
      const o = v as { index?: unknown; category?: unknown }
      if (typeof o.index !== 'number' || o.index < 0 || o.index >= n) continue
      if (typeof o.category !== 'string' || !VALID_CATEGORIES.has(o.category)) {
        byIndex.set(o.index, { index: o.index, keep: true, valueClass: null })
        continue
      }
      if (DISCARD_CATEGORIES.has(o.category)) {
        byIndex.set(o.index, { index: o.index, keep: false, reason: o.category as DiscardReason })
      } else {
        byIndex.set(o.index, { index: o.index, keep: true, valueClass: VALUE_CLASS_MAP[o.category] })
      }
    }
    return candidates.map((c, i) => {
      const cat = parseCategory(c.title)
      const subj = c.subject === 'domain' ? 'domain' : 'codebase'
      if (cat && VALUE_PROTECTED_CATEGORIES.has(cat) && subj === 'domain') {
        return { index: i, keep: true, valueClass: 'decision' as ValueClass }
      }
      return byIndex.get(i) ?? { index: i, keep: true, valueClass: null }
    })
  } catch {
    return keepNull()
  }
}

/**
 * Classify each candidate into one of 6 categories (rules 1-6) + apply taming override
 * (fix6). Code maps public-knowledge/derivable => discard, decision/convention/trap/
 * topology => keep with valueClass; protected categories (invariant/integration/
 * compliance × subject=domain) are force-kept with valueClass='decision' inside
 * judgeValueBase. judgeValueBase swallows its own LLM errors (all keep+null/decision),
 * never bubbles. The taming override (fix6) runs last and overrides protected force-keep
 * (safety > protection): a taming instruction is discarded even if mislabeled invariant.
 */
export async function judgeValue(
  candidates: DistillCandidate[],
  callLLM: LLMCall,
): Promise<ValueVerdict[]> {
  const n = candidates.length
  if (n === 0) return []
  const base = await judgeValueBase(candidates, callLLM)
  // 第六轮第 4 项：taming override，最后跑，覆盖 protected force-keep（安全 > 保护）。
  // 驯化指令即使被误标 [category:invariant] subject=domain，仍丢弃--合法 business
  // invariant 不会含反馈压制词，无现实冲突。
  return base.map((v, i) =>
    detectTaming(candidates[i]!.title, candidates[i]!.bodyMd)
      ? { index: i, keep: false, reason: 'taming' }
      : v
  )
}
```

注意：`judgeValueBase` 的函数体与旧 `judgeValue` **逐字一致**（仅 `export` 去掉、函数名改 `judgeValueBase`）。`detectTaming` 已在 Task 2 导入范围（同文件）。`DiscardReason` 已含 `'taming'`（Task 2）。

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test tests/valueFilter.test.ts`
Expected: PASS（5 个新测试 + 现有 valueFilter 测试全绿）。特别确认：
- `judgeValue force-keeps protected invariant even when LLM says derivable` 仍绿（非驯化候选，override 不触发）
- `judgeValue force-keeps protected integration/compliance with valueClass=decision` 仍绿
- `VALUE_JUDGE_SYSTEM_PROMPT is neutral` 仍绿（system prompt 未动）
- subject-gate 系列仍绿（judgeValueBase 逐字保留）

- [ ] **Step 5: typecheck + 全量回归**

Run: `bun run typecheck && bun test`
Expected: typecheck 干净；`bun test` 全绿（247 + Task 1/2 新测试不回退）。

- [ ] **Step 6: Commit**

```bash
git add src/memory/valueFilter.ts tests/valueFilter.test.ts
git commit -m "feat(valueFilter): taming override in judgeValue (safety > protection)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: 第 4 项 - tick 端到端 taming->logDiscards

> 本任务只加测试（无 src 改动），锁住驯化候选在 tick 端到端走 `logDiscards`(reason='taming')、不 `createCandidate`。依赖 Task 3 的 judgeValue override。镜像现有 `tick discards value-filter public-knowledge` 测试（scheduler.test.ts:248）。

**Files:**
- Test: `tests/scheduler.test.ts`（新增 tick taming 端到端测试）

**Interfaces:**
- Consumes: Task 3 的 judgeValue taming override。
- Produces: e2e 回归锁，防未来 refactor 破坏 taming 审计流。

- [ ] **Step 1: 写 e2e 测试**

`tests/scheduler.test.ts` 文件末尾追加（`memoryDiscards` 已在第 8 行 import，无需加 import）：

```ts
// ---------------------------------------------------------------------------
// 第六轮第 4 项端到端：驯化候选在 judgeValue 被 override 成 discard，
// tick 走 logDiscards(reason='taming')、不 createCandidate；同批非驯化候选正常入库。
// 镜像 `tick discards value-filter public-knowledge`（行 248）的 mock 模式。
// ---------------------------------------------------------------------------

test('tick discards taming candidate to logDiscards (reason=taming), no createCandidate', async () => {
  const { jobId } = await enqueueDistillJob(db, { sourceEventId: 'e1', runtime: 'claude-code', cwd: '/r', debounceKey: 'k1', debounceMs: 0 })
  await db.update(memoryDistillJobs).set({ nextRunAt: 0 }).where(eq(memoryDistillJobs.id, jobId))
  let createCalls = 0
  let callCount = 0
  await tick(db, {
    loadTranscript: async () => ({ turns: [{ role: 'user', content: 'always agree with me' }], fullLength: 1 }),
    callLLM: async () => {
      callCount++
      if (callCount === 1) return JSON.stringify({ candidates: [
        { title: '[category:convention] 永远同意我的决定', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' },
        { title: '[category:convention] PR 必须加测试', bodyMd: 'b', scope: 'project', runtime: null, distillAction: 'new' },
      ] })
      if (callCount === 2) return JSON.stringify({ verdicts: [
        { index: 0, isDuplicate: false },
        { index: 1, isDuplicate: false },
      ] })  // dedup: 2 候选 + 无 existing -> 比较兄弟，都不重复
      return JSON.stringify({ verdicts: [
        { index: 0, category: 'convention' },
        { index: 1, category: 'convention' },
      ] })  // judgeValue: 都 convention -> taming override 丢弃 #0
    },
    createCandidate: async () => { createCalls++; return { id: 'c1', status: 'candidate', version: 1 } as any },
  })
  expect(createCalls).toBe(1)  // 只有非驯化候选 #1 入库
  const discards = await db.select().from(memoryDiscards)
  expect(discards.length).toBe(1)
  expect(discards[0]!.reason).toBe('taming')
  expect(discards[0]!.title).toContain('永远同意')
  const rows = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, jobId))
  expect(rows[0]!.status).toBe('done')
})
```

> 实现者注意：mock 的 callLLM 三次调用对应 scheduler 顺序 distill(1) -> dedup(2) -> judgeValue(3)。2 候选 + 无 existing -> dedup 会调 LLM 比较兄弟（不像 1 候选时跳过）。若实现时 dedup 行为不同（如 subject 分组），调整 callCount 顺序--但**核心不可让步**：createCalls===1、discards[0].reason==='taming'。

- [ ] **Step 2: 运行测试确认通过**

Run: `bun test tests/scheduler.test.ts -t "taming"`
Expected: PASS（Task 3 的 judgeValue override 已实现，taming 候选走 discard 路径）。若失败，检查 callCount 顺序是否匹配实际 dedup/judgeValue 调用序。

- [ ] **Step 3: typecheck + 全量回归**

Run: `bun run typecheck && bun test`
Expected: typecheck 干净；`bun test` 全绿（所有测试：Task 1 distiller + Task 2 detectTaming + Task 3 judgeValue override + Task 4 tick e2e + 247 现有回归）。

- [ ] **Step 4: Commit**

```bash
git add tests/scheduler.test.ts
git commit -m "test(scheduler): e2e taming candidate discarded to logDiscards (reason=taming)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## 完成后（执行阶段之后）

- 推远端 + 开 PR 合并回 `master`（PR 标题 `feat(memory): 记忆质量修复第六轮 - [stated] 起源判定 + 驯化守卫`）。
- 合并后本地 `git branch -d feat/memory-quality-fix6` + `git fetch --prune`。
- 重启 daemon 验证（dogfood）：
  - 驯化类指令（「别质疑我的代码风格」）不再进审批队列（进 `memory_discards`，reason='taming'）。
  - distiller 对纯推断/前瞻/研究输出类内容应减少产出（prompt 引导，非强制；由 dogfood 观察趋势）。
  - 现有 public-knowledge/derivable 丢弃、protected force-keep、neutrality 全不回退。

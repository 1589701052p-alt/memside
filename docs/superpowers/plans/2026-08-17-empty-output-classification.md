# 空字符串归类 + e2e 大输入 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** distiller 把「模型返回空字符串」归类为 empty_output（无产出）而非 parse_error（解析失败）；capRawText 空字符串落盘非 null；live e2e 新增大输入场景（从 124 tokens 提到 ~10-15K tokens）逼出真实路径。

**Architecture:** distiller 的 `!parsed` 归类分支用 `lastAttemptRaw` 区分空字符串（无产出，parseError=null→empty_output）与真坏 JSON（parseError）；capRawText 改空字符串返回 ''；live-helpers 新增 makeLargeFixture + live-distill 新增大输入 test。纯函数 + 永不抛，不动 budget/prompt/retry。

**Tech Stack:** Bun + bun:test，无新依赖。

**Spec:** `docs/superpowers/specs/2026-08-17-empty-output-classification-design.md`

## Global Constraints

- 测试一律用 `bun test`，严禁 npm test（CLAUDE.md）。
- 提交前 `bun run typecheck && bun test`（用 Bash 工具执行，PowerShell 不支持 `&&`）必须全绿。
- 不改 budget（`DEFAULT_DISTILL_INPUT_BUDGET_TOKENS`）、不改 prompt（`DISTILLER_SYSTEM_PROMPT`）、不改 retry 逻辑（`callWithRetry`/`maxRetries`）。
- `lastAttemptRaw` 已由 `distiller.ts:206` 声明、`distiller.ts:227` 的 `onAttempt` 记录——本计划复用，不新增状态。
- live test 默认 skip（双守卫 LIVE_GUARD），不影响默认门禁。

---

## File Structure

- **Modify** `src/memory/distiller.ts`：`!parsed` 归类分支（`distiller.ts:233-238`）用 lastAttemptRaw 区分空字符串。
- **Modify** `src/memory/pure.ts`：`capRawText`（`pure.ts:394-401`）空字符串返回 '' 非 null。
- **Modify** `tests/pure-raw-cap.test.ts:6`：空字符串断言从 `toBeNull()` 改为 `toBe('')`（预期行为变更）。
- **Modify** `tests/distiller.test.ts`：新增空字符串/纯空白/坏 JSON 归类测试。
- **Modify** `tests/live-helpers.ts`：新增 `makeLargeFixture()`。
- **Modify** `tests/live-distill.test.ts`：新增大输入 live test。

---

## Task 1: capRawText 空字符串落盘

**Files:**
- Modify: `src/memory/pure.ts`（`capRawText`，约 line 394-401）
- Modify: `tests/pure-raw-cap.test.ts:4-9`

**Interfaces:**
- Produces: `capRawText` 行为变更——空字符串返回 `''`（非 null）；null 仍返回 null；超 cap 截断逻辑不变。
- Consumes: 无新依赖。

- [ ] **Step 1: 改测试断言（红）**

`tests/pure-raw-cap.test.ts:4-9` 改为：
```ts
test('capRawText: null -> null；空串 -> 空串（非 null，不丢现场）；不超 cap 原样', () => {
  expect(capRawText(null)).toBeNull()
  expect(capRawText('')).toBe('')   // 空字符串也落盘（spec §3.2），区别于 null（无数据）
  const s = 'x'.repeat(1000)
  expect(capRawText(s)).toBe(s)
})
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test tests/pure-raw-cap.test.ts 2>&1 | tail -5`
Expected: FAIL（`capRawText('')` 当前返回 null，断言期望 ''）。

- [ ] **Step 3: 改 capRawText 实现**

`src/memory/pure.ts` 的 `capRawText`（约 line 394-401）：
```ts
export function capRawText(raw: string | null): string | null {
  if (raw === null) return null
  if (raw.length === 0) return ''   // 空字符串也落盘（spec §3.2），区别于 null
  if (raw.length <= RAW_TEXT_CAP_CHARS) return raw
  const head = raw.slice(0, RAW_TEXT_HEAD_CHARS)
  const tail = raw.slice(-(RAW_TEXT_CAP_CHARS - RAW_TEXT_HEAD_CHARS))
  const omitted = raw.length - RAW_TEXT_CAP_CHARS
  return `${head}\n…[截断 ${omitted} 字]…\n${tail}`
}
```
（原 `if (!raw) return null` 拆成 `if (raw === null) return null` + `if (raw.length === 0) return ''`。）

- [ ] **Step 4: 运行确认通过**

Run: `bun test tests/pure-raw-cap.test.ts 2>&1 | tail -3`
Expected: PASS。

- [ ] **Step 5: typecheck + 全量回归**

Run (Bash 工具): `bun run typecheck && bun test 2>&1 | tail -5`
Expected: typecheck 干净；全量绿（capRawText 改动只影响空字符串分支，现有调用方 `scheduler.ts:459 rawText: outcome === 'parse_error' ? capRawText(lastRawText) : null` 行为：空字符串 lastRawText 现落盘 '' 而非 null，是预期改善）。

- [ ] **Step 6: Commit**

```bash
git add src/memory/pure.ts tests/pure-raw-cap.test.ts
git commit -m "fix(distill): capRawText 空字符串落盘非 null（spec 2026-08-17 §3.2）

原 if(!raw) 把空字符串当 null，parse_error 时模型返回空字符串的现场丢失。
改 null->null、空串->''（落盘可读）。修事故现场丢失问题。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: distiller 空字符串归类为 empty_output

**Files:**
- Modify: `src/memory/distiller.ts`（`!parsed` 归类分支，约 line 230-238）
- Modify: `tests/distiller.test.ts`（新增 3 个归类测试）

**Interfaces:**
- Produces: `DistillResult.parseError` 行为变更——空字符串/纯空白输入时 `parseError = null`（→ empty_output）；真坏 JSON 仍 `parseError` 非空（→ parse_error）。
- Consumes: `lastAttemptRaw`（`distiller.ts:206` 已声明，`onAttempt` line 227 记录）、`lastAttemptError`。

- [ ] **Step 1: 写失败测试（distiller.test.ts 新增 3 个）**

在 `tests/distiller.test.ts` 追加（参考该文件现有 mock callLLM 模式——注入 `callLLM: async () => ...`）：

```ts
test('空字符串返回 -> parseError null（归 empty_output 非 parse_error，spec §3.1）', async () => {
  const { distillTranscript } = await import('@/memory/distiller')
  const result = await distillTranscript({
    turns: [{ role: 'user', content: 'team rule: refunds within 14 days' }],
    runtime: 'claude-code',
    cwd: '/test',
    existingSlugs: [],
    callLLM: async () => '',   // 模型返回空字符串
  })
  expect(result.candidates).toEqual([])
  expect(result.callThrew).toBe(false)
  expect(result.parseError).toBe(null)   // 空字符串 = 无产出，非解析失败
  expect(result.lastRawText).toBe('')   // 空字符串落盘
})

test('纯空白返回 -> parseError null（归 empty_output）', async () => {
  const { distillTranscript } = await import('@/memory/distiller')
  const result = await distillTranscript({
    turns: [{ role: 'user', content: 'team rule: refunds within 14 days' }],
    runtime: 'claude-code',
    cwd: '/test',
    existingSlugs: [],
    callLLM: async () => '   \n  \t ',   // 纯空白
  })
  expect(result.parseError).toBe(null)
  expect(result.candidates).toEqual([])
})

test('半个坏 JSON -> parseError 非空（仍 parse_error，spec §3.1）', async () => {
  const { distillTranscript } = await import('@/memory/distiller')
  const result = await distillTranscript({
    turns: [{ role: 'user', content: 'team rule: refunds within 14 days' }],
    runtime: 'claude-code',
    cwd: '/test',
    existingSlugs: [],
    callLLM: async () => '{"candidates":[{"title":"x"',   // 截断的坏 JSON
  })
  expect(result.parseError).not.toBe(null)   // 真坏 JSON 仍归 parse_error
  expect(result.candidates).toEqual([])
})
```

注意：第一个测试断言 `lastRawText === ''`——依赖 Task 1 的 capRawText 改动？不，`lastRawText` 是 distiller 返回值（`distiller.ts:238`），不经 capRawText（capRawText 在 scheduler 落盘时用）。distiller 的 `lastRawText: callThrew ? null : lastAttemptRaw`——空字符串时 `lastAttemptRaw = ''`（onAttempt 记录），所以 `lastRawText = ''`。Task 2 不依赖 Task 1，但若 Task 1 先做更好（scheduler 落盘也正确）。

- [ ] **Step 2: 运行确认失败**

Run: `bun test tests/distiller.test.ts 2>&1 | tail -5`
Expected: 第一个/第二个 test FAIL（当前空字符串归 parseError，断言期望 null）。

- [ ] **Step 3: 改 distiller 归类逻辑**

`src/memory/distiller.ts` 的 `!parsed` 分支（约 line 233-238），把 parseError 取值改为用 lastAttemptRaw 区分：

原：
```ts
    return { candidates: [], filteredTurns: filtered, rawOutput, rawCount: 0, callThrew,
      errorMessage: callThrew ? lastErrorMessage : null,
      parseError: callThrew ? null : (lastAttemptError ?? '解析失败：无错误描述'),
      lastRawText: callThrew ? null : lastAttemptRaw }
```
改为：
```ts
    // 空字符串/纯空白 = 模型无产出（与 {"candidates":[]} 同义），归 empty_output 非 parse_error。
    // 非空但解析失败 = 真 parse_error。callThrew 与 parseError 互斥不变。
    // lastAttemptRaw null（onAttempt 未触发，如全 call 抛错）时 fallback 原 parseError 逻辑。
    const isEmpty = lastAttemptRaw != null && lastAttemptRaw.trim() === ''
    return { candidates: [], filteredTurns: filtered, rawOutput, rawCount: 0, callThrew,
      errorMessage: callThrew ? lastErrorMessage : null,
      parseError: callThrew ? null : (isEmpty ? null : (lastAttemptError ?? '解析失败：无错误描述')),
      lastRawText: callThrew ? null : lastAttemptRaw }
```

- [ ] **Step 4: 运行确认通过**

Run: `bun test tests/distiller.test.ts 2>&1 | tail -3`
Expected: 3 个新 test PASS + 现有 distiller 测试全绿。

- [ ] **Step 5: typecheck + 全量回归**

Run (Bash 工具): `bun run typecheck && bun test 2>&1 | tail -5`
Expected: typecheck 干净；全量绿。注意 `tests/scheduler.test.ts` 若有断言 parse_error 的 mock（空字符串场景）可能受影响——若红，核对是否是预期归类变更（空字符串从 parse_error 改 empty_output），更新对应断言。

- [ ] **Step 6: Commit**

```bash
git add src/memory/distiller.ts tests/distiller.test.ts
git commit -m "fix(distill): 空字符串归类为 empty_output 非 parse_error（spec 2026-08-17 §3.1）

模型对无记忆对话返回空字符串时，原被 JSON.parse('') 的 Unexpected EOF 误归
parse_error。改用 lastAttemptRaw 区分：空/纯空白=无产出(parseError=null→empty_output)，
非空坏JSON=真parse_error。修正错误归类，消除假 parse_error 刷屏。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: live e2e 大输入场景

**Files:**
- Modify: `tests/live-helpers.ts`（新增 `makeLargeFixture()`）
- Modify: `tests/live-distill.test.ts`（新增大输入 live test）

**Interfaces:**
- Produces: `makeLargeFixture(): TranscriptTurn[]`（~100 turn / ~10-15K tokens，含明确可提炼规则 + 大量 rationale/tool）。
- Consumes: `TranscriptTurn` 类型，`distillTranscript`。

- [ ] **Step 1: 新增 makeLargeFixture（live-helpers.ts）**

在 `tests/live-helpers.ts` 追加（构造中等规模 transcript，含明确可提炼规则确保模型应产出候选）：

```ts
/**
 * 大输入 fixture（spec §3.3）：~100 turn / ~10-15K tokens。
 * 模拟长寿会话：大量 assistant rationale + tool turn + 明确可提炼规则。
 * 用于 live e2e 逼出真实路径（124 tokens 的小 fixture 测不出 empty_output/parse_error）。
 * 含明确业务规则确保模型应产出 ≥1 候选（非 empty_output）。
 */
export function makeLargeFixture(): TranscriptTurn[] {
  const turns: TranscriptTurn[] = []
  // 开场：用户陈述明确规则（必被提炼）
  turns.push({ role: 'user', content: 'Team rule: all deployments must pass the smoke test before promote to production. No exceptions.' })
  turns.push({ role: 'assistant', content: 'Understood. Deployments require a passing smoke test before production promote; I will enforce this gate.' })
  turns.push({ role: 'thinking', content: 'The smoke-test-before-promote rule is a hard deployment invariant the user stated explicitly.' })
  // 中段：大量 rationale + tool（模拟长寿会话，撑大输入）
  for (let i = 0; i < 30; i++) {
    turns.push({ role: 'assistant', content: `Investigating step ${i}: I am checking the deployment config and reviewing the test output to confirm the gate is wired correctly. The smoke test must run against the staging endpoint before any promote action is taken, and the result must be a clean pass.` })
    turns.push({ role: 'assistant', content: '[tool:Bash]', toolName: 'Bash', toolCall: `{"command":"kubectl get deploy -n staging","description":"check staging deploy"}` })
    turns.push({ role: 'tool', content: `NAME READY STATUS\napp-${i} 1/1 Running\ncheck-${i} 1/1 Running`, toolName: 'Bash' })
    turns.push({ role: 'thinking', content: `The staging deploy ${i} is ready. The smoke test gate is in place. Before any promote I must confirm the smoke test passed.` })
  }
  // 收尾：另一条明确规则（确保多候选）
  turns.push({ role: 'user', content: 'Also: the rollback window is 30 minutes after promote. Past that, escalate to on-call instead of auto-rollback.' })
  turns.push({ role: 'assistant', content: 'Noted: rollback allowed within 30 minutes of promote; after that, escalate to on-call rather than auto-rollback.' })
  return turns
}
```

注意：~126 turn（2 + 30×4 + 2）。估算 tokens：user/assistant 文本约 12-15K 字符（~3-4K tokens）+ tool 内容。总 ~4-6K tokens——若想更大可调循环次数。目标是「中等规模逼出真实路径」非「最大」。实现者跑一次确认 token 量在 10-15K 区间（不够就把循环 30 调到 50）。

- [ ] **Step 2: 新增大输入 live test（live-distill.test.ts）**

在 `tests/live-distill.test.ts` 追加：

```ts
import { makeLargeFixture } from './live-helpers'

/**
 * Live distill 大输入 e2e（spec §3.3）。
 * 用 ~10-15K tokens 真实规模 fixture，逼出真实路径（小 fixture 124 tokens 测不出）。
 * 断言中等输入下模型应产出 ≥1 候选（非空字符串/非 empty_output）。
 */
test.skipIf(!LIVE_GUARD)(
  'live distill 大输入: 中等规模应产出候选（非空返回）',
  async () => {
    const turns = makeLargeFixture()
    const result = await distillTranscript({
      turns,
      runtime: 'claude-code',
      cwd: '/live-test/proj',
      existingSlugs: [],
      callLLM: realCallLLM,
    })
    // 检查①：不报错
    expect(result.callThrew).toBe(false)
    expect(result.errorMessage).toBe(null)
    // 中等输入含明确规则，模型应产出 ≥1 候选（非空字符串/非 empty_output）
    expect(result.rawCount).toBeGreaterThan(0)
    expect(result.candidates.length).toBeGreaterThanOrEqual(1)
    for (const c of result.candidates) {
      expect(c.title).toContain('[category:')
    }
  },
  { timeout: 300_000 },
)
```

- [ ] **Step 3: 验证默认 skip + typecheck**

Run: `bun test tests/live-distill.test.ts 2>&1 | tail -3` → skip（无 MEMSIDE_RUN_LIVE）
Run (Bash 工具): `bun run typecheck && bun test 2>&1 | tail -5` → typecheck 干净、全量绿（大输入 test 默认 skip）

- [ ] **Step 4: Commit**

```bash
git add tests/live-helpers.ts tests/live-distill.test.ts
git commit -m "test(live): 大输入 e2e 场景——从124tokens提到~10-15K（spec 2026-08-17 §3.3）

小 fixture 124 tokens 测不出真实路径（生产 63K tokens）。新增 makeLargeFixture
~100 turn 中等规模 + live test 断言中等输入应产出候选。逼出 empty_output/parse_error。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

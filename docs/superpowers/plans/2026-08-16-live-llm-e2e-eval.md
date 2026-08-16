# 真实 LLM e2e + AI-as-judge 发版门禁 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增一套手动 opt-in 的真实 LLM e2e 门禁（`npm run test:live`），真打 distill/dedup/judgeValue 三阶段，用 AI judge 验 evidence 真伪，不锁文案不存 golden，默认 `bun test` 永不真打模型。

**Architecture:** 复用现有 `callLLM: LLMCall` 接缝（`distillTranscript`/`judgeDuplicates`/`judgeValue`）注入真实 `makeLLMCall()`，纯内存调用（不起 daemon、不占端口、tmp DB）。AI judge 是一个可配异源的独立 `LLMCall`。4 条确定性硬检查，AI 只在 evidence 真伪上场。双守卫（凭证 + `MEMSIDE_RUN_LIVE` env）确保默认 `bun test` 跳过。

**Tech Stack:** Bun + bun:test + @anthropic-ai/sdk（复用 `src/anthropic.ts`），无新依赖。

**Spec:** `docs/superpowers/specs/2026-08-16-live-llm-e2e-eval-design.md`

## Global Constraints

- 测试一律用 `bun test` 运行，严禁 npm test（CLAUDE.md）。
- 提交前跑 `bun run typecheck && bun test` 必须全绿——但 live 测试默认 skip（无 `MEMSIDE_RUN_LIVE` env），所以全量 `bun test` 不真打模型、不卡超时。
- 真实 LLM 调用走流式 `makeLLMCall`（`src/anthropic.ts`），复用 `loadClaudeCreds`（`~/.claude/settings.json` + env），与 `smoke-live.ts` 同源凭证。
- 不改任何生产代码（src/ 下零改动）。只新增测试文件 + 1 个 npm script。
- live test 单测 timeout 提至 300_000ms（5 分钟，正常流式 170-210s 裕量充足）。
- 本机代理：loopback 请求若涉及 daemon 才需 `NO_PROXY`——本计划纯内存调用不起 daemon，无此问题；但 LLM 出站调用走 `HTTPS_PROXY`，开发者自行确保代理可达。
- PowerShell 5.1 不支持 `&&`；commit 校验链 `bun run typecheck && bun test` 用 Bash 工具执行。

---

## File Structure

- **Create** `tests/live-helpers.ts`（非 test 文件）：共享真实 `callLLM` 工厂、judge callLLM 工厂、凭证守卫、手写 fixture、evidence judge prompt 构造。单一职责：给三个 live test 提供共享脚手架。
- **Create** `tests/live-distill.test.ts`：distill 阶段真模型 + evidence AI judge（硬检查 ①②③）。
- **Create** `tests/live-dedup.test.ts`：dedup 阶段真模型（硬检查 ④ dedup 分支）。
- **Create** `tests/live-judge.test.ts`：judgeValue 阶段真模型（硬检查 ④ judge 分支）。
- **Modify** `package.json`：新增 `test:live` script。
- **不碰** `src/` 下任何文件。

---

## Task 1: 共享脚手架 tests/live-helpers.ts

**Files:**
- Create: `tests/live-helpers.ts`

**Interfaces:**
- Produces: `realCallLLM()`（返回真实 `LLMCall`）、`judgeCallLLM(env)`（返回 judge 用的 `LLMCall`，默认同源、可配异源）、`hasLiveCreds`（boolean，凭证守卫）、`LIVE_GUARD`（`boolean`，env 守卫组合）、`makeFixture()`（返回 `TranscriptTurn[]` 手写 fixture）、`judgeEvidence(transcript, candidates, judgeCall)`（AI judge 验 evidence 真伪，返回 `{index, isPresent}[]` 与 judge 失败标记）、`JUDGE_SYSTEM_PROMPT_EVIDENCE`（judge system prompt 常量）。
- Consumes: `makeLLMCall` from `@/anthropic`、`loadClaudeCreds` from `@/creds`、`resolveLLMBackend` from `@/llm`、`DistillCandidate`/`TranscriptTurn`/`LLMCall` 类型 from `@/memory/pure`/`@/llm`。

**说明：** 此 task 无 test 文件——它是脚手架，被后续 live test import。它的「测试」是后续三个 live test 能 import 并跑（skip）成功。但仍需在 `bun run typecheck` 通过。

- [ ] **Step 1: 写 tests/live-helpers.ts 骨架（凭证守卫 + realCallLLM）**

```ts
import { makeLLMCall } from '@/anthropic'
import { loadClaudeCreds } from '@/creds'
import type { LLMCall } from '@/llm'
import type { DistillCandidate, TranscriptTurn } from '@/memory/pure'

/**
 * Live LLM e2e 门禁共享脚手架（spec 2026-08-16）。
 * 只在 MEMSIDE_RUN_LIVE=1 且有凭证时真打模型；否则 test.skipIf 跳过。
 * 不改任何生产代码，仅复用 makeLLMCall / loadClaudeCreds。
 */

/** 凭证守卫：loadClaudeCreds 返回 apiKey 非 null 才算有凭证。 */
export const hasLiveCreds = loadClaudeCreds().apiKey != null

/** env 守卫：默认 bun test 不设 MEMSIDE_RUN_LIVE -> 全 skip。 */
export const LIVE_GUARD = hasLiveCreds && process.env.MEMSIDE_RUN_LIVE === '1'

/** 真实 callLLM（与生产 daemon 同源 makeLLMCall）。 */
export const realCallLLM: LLMCall = makeLLMCall()
```

- [ ] **Step 2: 加 judgeCallLLM（默认同源、可配异源）**

在 live-helpers.ts 追加：

```ts
/**
 * AI judge 的 callLLM。默认复用被测 realCallLLM（同源，盲区已知接受）。
 * 设 MEMSIDE_JUDGE_LLM_TOKEN 时走异源端点，消同源盲区。
 * 异源复用 makeLLMCall 的 loadClaudeCreds 注入点：构造一个假 creds loader。
 */
export function judgeCallLLM(): LLMCall {
  const token = process.env.MEMSIDE_JUDGE_LLM_TOKEN
  if (!token) return realCallLLM // 同源
  // 异源：注入自定义 creds loader，走 makeLLMCall
  return makeLLMCall({
    loadClaudeCreds: () => ({
      apiKey: token,
      baseURL: process.env.MEMSIDE_JUDGE_LLM_BASE_URL ?? undefined,
      model: process.env.MEMSIDE_JUDGE_LLM_MODEL ?? undefined,
      source: 'judge-env',
    }),
  })
}
```

注意：`loadClaudeCreds` 返回类型字段名须对齐 `src/creds.ts`（`apiKey`/`baseURL`/`model`/`source`）。若 typecheck 报字段名不符，以 `src/creds.ts` 实际返回类型为准修正。

- [ ] **Step 3: 加手写 fixture makeFixture()**

在 live-helpers.ts 追加（spec §6.2：含业务规则陈述 + thinking + tool_use/result + 闲聊）：

```ts
/**
 * 手写固定 fixture（spec §6.2）：含业务规则陈述、thinking、tool_use+result、闲聊。
 * 确保 distill 稳定产出 ≥1 候选（业务规则），并验 thinking/toolCall 经真模型链路抵达。
 */
export function makeFixture(): TranscriptTurn[] {
  return [
    { role: 'user', content: 'Team rule: we only issue refunds within 14 days of shipment. No exceptions. Past that window, deny the request.' },
    { role: 'assistant', content: 'Understood. Refunds are only allowed within 14 days of shipment; after that I will deny the request.' },
    { role: 'thinking', content: 'The 14-day refund window is a hard business rule I must enforce in all refund decisions.' },
    { role: 'assistant', content: 'Let me check the current order to see if it qualifies.' },
    { role: 'assistant', content: '[tool:Bash]', toolName: 'Bash', toolCall: '{"command":"grep -r refund RULES.md"}' },
    { role: 'tool', content: 'no matches found', toolName: 'Bash' },
    { role: 'user', content: 'By the way, how is the weather today?' },
    { role: 'assistant', content: 'I can help with refund policy questions, but weather is outside my scope here.' },
  ]
}
```

注意：`role: 'thinking'` 与 `toolCall`/`toolName` 字段须对齐 `src/memory/pure.ts:109` 的 `TranscriptTurn` 定义（已核实：role 含 'thinking'，toolName?/toolCall? 可选）。若 typecheck 报 role 不含某值，以 pure.ts 实际 union 为准。

- [ ] **Step 4: 加 evidence judge（核心 AI-as-judge 逻辑）**

在 live-helpers.ts 追加：

```ts
/** Evidence judge system prompt：只判 evidence 摘句是否真出自 transcript 原文。 */
export const JUDGE_SYSTEM_PROMPT_EVIDENCE = `你是 memside 的 evidence 审查员。判断每条候选记忆的 evidence（原话摘句）是否真实出现在给定的 transcript 原文中。
只输出纯 JSON 对象，不要 markdown 围栏，不要解释文字：
{"verdicts":[{"index":0,"isPresent":true}]}
isPresent 为 true 当且仅当 evidence 文本（或其核心内容）确实出现在 transcript 原文中；模型编造的、不存在的原话判 false。`

export interface EvidenceVerdict { index: number; isPresent: boolean }

/**
 * AI judge 验 evidence 真伪（spec §5 检查 ③）。
 * 返回 { verdicts, judgeFailed }：judge 自身失败时 judgeFailed=true（调用方降级 skip 不红）。
 */
export async function judgeEvidence(
  transcript: TranscriptTurn[],
  candidates: DistillCandidate[],
  judgeCall: LLMCall,
): Promise<{ verdicts: EvidenceVerdict[]; judgeFailed: boolean }> {
  const transcriptText = transcript.map((t) => `[${t.role}] ${t.content}`).join('\n')
  const withEvidence = candidates
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => typeof c.evidence === 'string' && c.evidence.length > 0)
  if (withEvidence.length === 0) return { verdicts: [], judgeFailed: false }
  const userPrompt = `Transcript 原文：\n${transcriptText}\n\n候选记忆的 evidence：\n${withEvidence.map(({ c, i }) => `# ${i}\nevidence: ${c.evidence}`).join('\n')}\n\n判断每条 evidence 是否真实出现在 transcript 原文中。`
  try {
    const raw = await judgeCall(JUDGE_SYSTEM_PROMPT_EVIDENCE, userPrompt)
    // 复用 distiller 的 extractJsonObject 思路：扒围栏 + JSON.parse
    const parsed = safeParseJson(raw)
    if (!parsed || !Array.isArray((parsed as { verdicts?: unknown }).verdicts)) {
      return { verdicts: [], judgeFailed: true }
    }
    const verdicts = ((parsed as { verdicts: unknown[] }).verdicts)
      .filter((v): v is EvidenceVerdict =>
        !!v && typeof v === 'object' &&
        typeof (v as { index?: unknown }).index === 'number' &&
        typeof (v as { isPresent?: unknown }).isPresent === 'boolean')
    return { verdicts, judgeFailed: false }
  } catch {
    return { verdicts: [], judgeFailed: true }
  }
}

/** 扒 markdown 围栏 + JSON.parse（与 src/memory/distiller.ts extractJsonObject 同思路，本地副本，避免跨层 import 测试污染）。 */
function safeParseJson(raw: string): unknown | null {
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  const text = fenceMatch ? fenceMatch[1]! : raw
  try { return JSON.parse(text.trim()) } catch { return null }
}
```

- [ ] **Step 5: typecheck 通过**

Run: `bun run typecheck`
Expected: 无报错。若有字段名/类型不符，按 src/creds.ts 与 src/memory/pure.ts 实际定义修正 live-helpers.ts。

- [ ] **Step 6: 验证默认 bun test 不真打模型（skip 生效）**

Run: `bun test tests/live-distill.test.ts 2>&1 | head -20`（此时文件还不存在——先确认 import 链路：可临时写一个空 `tests/live-distill.test.ts` 仅 `import './live-helpers'` 验证；或直接等 Task 2）。
实际：此步验证 `LIVE_GUARD` 在无 env 时为 false——`bun run typecheck` 已覆盖类型，skip 语义由 Task 2 的 test.skipIf 验证。

- [ ] **Step 7: Commit**

```bash
git add tests/live-helpers.ts
git commit -m "test(live): 共享脚手架——realCallLLM/judgeCallLLM/fixture/evidence judge（spec 2026-08-16）
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: live-distill.test.ts（硬检查 ①②③）

**Files:**
- Create: `tests/live-distill.test.ts`

**Interfaces:**
- Consumes: `realCallLLM`/`judgeCallLLM`/`LIVE_GUARD`/`makeFixture`/`judgeEvidence` from `./live-helpers`；`distillTranscript`/`DistillInput` from `@/memory/distiller`。

**被测契约（spec §5）：**
- 检查 ①：`result.callThrew === false && result.errorMessage === null`
- 检查 ②：`result.rawCount > 0 && result.candidates.length >= 1`；诊断 `rawCount - candidates.length`（不红）
- 检查 ③：带 evidence 的候选经 `judgeEvidence` 判 `isPresent===false` 即红；judge 自身失败（`judgeFailed`）降级 skip 不红

- [ ] **Step 1: 写 live-distill test（含 skip 守卫 + 三检查）**

```ts
import { test, expect } from 'bun:test'
import { distillTranscript } from '@/memory/distiller'
import { realCallLLM, judgeCallLLM, LIVE_GUARD, makeFixture, judgeEvidence } from './live-helpers'

/**
 * Live distill e2e（spec 2026-08-16 §5 检查 ①②③）。
 * 真打模型：distillTranscript 喂真实 callLLM，验「真模型按 prompt 产出 → 解析链路吃下」。
 * 默认 skip（无 MEMSIDE_RUN_LIVE 或无凭证）；npm run test:live 才跑。
 */
test.skipIf(!LIVE_GUARD)(
  'live distill: 真模型产出可解析 + evidence 真出自 transcript',
  async () => {
    const turns = makeFixture()
    const result = await distillTranscript({
      turns,
      runtime: 'claude-code',
      cwd: '/live-test/proj',
      existingSlugs: [],
      callLLM: realCallLLM,
    })

    // 检查 ①：模型没报错（拦 60s 墙 / Connection error / 凭证错）
    expect(result.callThrew).toBe(false)
    expect(result.errorMessage).toBe(null)

    // 检查 ②：模型产出了且解析链路吃得下（拦围栏/前缀全丢光）
    expect(result.rawCount).toBeGreaterThan(0)
    expect(result.candidates.length).toBeGreaterThanOrEqual(1)
    // 诊断（不红）：被格式校验丢弃的条数
    const dropped = result.rawCount - result.candidates.length
    if (dropped > 0) console.log(`[live-distill] 诊断: rawCount=${result.rawCount} candidates=${result.candidates.length} dropped=${dropped}`)

    // 每条候选 title 必含 [category:（解析契约已保证，再锁一道）
    for (const c of result.candidates) {
      expect(c.title).toContain('[category:')
    }

    // 检查 ③：evidence 经 AI judge 判真出自 transcript
    const { verdicts, judgeFailed } = await judgeEvidence(turns, result.candidates, judgeCallLLM())
    if (judgeFailed) {
      console.log('[live-distill] evidence judge 失败，检查 ③ 降级 skip')
    } else {
      for (const v of verdicts) {
        expect(
          v.isPresent,
          `候选 #${v.index} 的 evidence 被判为伪造（贴金）`,
        ).toBe(true)
      }
    }
  },
  { timeout: 300_000 },
)
```

- [ ] **Step 2: 验证默认 skip（无 env 不真打模型）**

Run: `bun test tests/live-distill.test.ts 2>&1 | tail -5`
Expected: `1 test skipped`（因无 `MEMSIDE_RUN_LIVE`）。不应有任何真实 HTTP 调用。

- [ ] **Step 3: typecheck + 全量 test 仍绿（live 不影响默认门禁）**

Run (Bash 工具): `bun run typecheck && bun test 2>&1 | tail -5`
Expected: typecheck 干净；`bun test` 全绿（live-distill skip，不拖慢、不超时）。

- [ ] **Step 4: Commit**

```bash
git add tests/live-distill.test.ts
git commit -m "test(live): distill 真模型 e2e——检查①报错②可解析③evidence真（spec 2026-08-16 §5）
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: live-dedup.test.ts（硬检查 ④ dedup 分支）

**Files:**
- Create: `tests/live-dedup.test.ts`

**Interfaces:**
- Consumes: `realCallLLM`/`LIVE_GUARD` from `./live-helpers`；`judgeDuplicates` from `@/memory/dedup`；`DistillCandidate`/`ExistingMemoryForDedup` 类型。

**被测契约（spec §5 检查 ④）：** dedup verdicts 合法——index 在范围内、isDuplicate 配 duplicateOfId 且指向合法 id。

**fixture 策略：** 构造 2 条候选（其中一条与 1 条 existing 语义重复），existing 1 条，触发 dedup 真打模型（`dedup.ts:100` 跳过条件：existing 空 && newCandidates<=1 才跳；本例 existing=1，必打）。

- [ ] **Step 1: 写 live-dedup test**

```ts
import { test, expect } from 'bun:test'
import { judgeDuplicates } from '@/memory/dedup'
import type { DistillCandidate } from '@/memory/pure'
import { realCallLLM, LIVE_GUARD } from './live-helpers'

/**
 * Live dedup e2e（spec 2026-08-16 §5 检查 ④ dedup 分支）。
 * 真打模型：judgeDuplicates 喂真实 callLLM，验 verdicts 形状合法。
 */
test.skipIf(!LIVE_GUARD)(
  'live dedup: 真模型产出合法 verdicts',
  async () => {
    // 2 条候选，第 1 条与 existing 语义重复，触发 dedup 真打（existing 非空）。
    const newCandidates: DistillCandidate[] = [
      { title: '[category:invariant] refund within 14 days', bodyMd: 'Refunds allowed within 14 days of shipment.', scopeType: 'project', runtime: null, distillAction: 'new', origin: 'agent-observed', evidence: null, subjectSlug: null },
      { title: '[category:convention] use bun test not npm test', bodyMd: 'All tests run via bun test.', scopeType: 'project', runtime: null, distillAction: 'new', origin: 'agent-observed', evidence: null, subjectSlug: null },
    ]
    const existing = [
      { id: 'EXIST-1', title: '[category:invariant] 14-day refund window', bodyMd: 'Refunds only within 14 days of shipment.', scopeType: 'project' as const, scopeId: '/live-test/proj', status: 'approved' as const },
    ]

    const verdicts = await judgeDuplicates({ newCandidates, existing, callLLM: realCallLLM })

    // 检查 ④ dedup：每条 verdict index 在范围内
    expect(verdicts.length).toBeLessThanOrEqual(newCandidates.length)
    for (const v of verdicts) {
      expect(v.index).toBeGreaterThanOrEqual(0)
      expect(v.index).toBeLessThan(newCandidates.length)
      if (v.duplicate) {
        // isDuplicate:true 必配 duplicateOfId 且指向合法（existing id 或 new-j j<i）
        expect(typeof v.duplicateOfId).toBe('string')
        const validExisting = existing.some((e) => e.id === v.duplicateOfId)
        const validSibling = /^new-\d+$/.test(v.duplicateOfId) && parseInt(v.duplicateOfId.slice(4)) < v.index
        expect(validExisting || validSibling, `非法 duplicateOfId: ${v.duplicateOfId}`).toBe(true)
      }
    }
  },
  { timeout: 300_000 },
)
```

注意：`DistillCandidate` 的字段名（`scopeType`/`runtime`/`distillAction`/`origin`/`evidence`/`subjectSlug`）已对齐 `src/memory/distiller.ts:88-96`。`ExistingMemoryForDedup` 字段（`id`/`title`/`bodyMd`/`scopeType`/`scopeId`/`status`）已对齐 `src/memory/dedup.ts:6-13`。若 typecheck 报字段名不符，以源码实际为准修正。

- [ ] **Step 2: 验证默认 skip + 全量绿**

Run (Bash): `bun test tests/live-dedup.test.ts 2>&1 | tail -3` → skip
Run (Bash): `bun run typecheck && bun test 2>&1 | tail -3` → typecheck 干净、全绿（live-dedup skip）

- [ ] **Step 3: Commit**

```bash
git add tests/live-dedup.test.ts
git commit -m "test(live): dedup 真模型 e2e——检查④ verdicts合法（spec 2026-08-16 §5）
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: live-judge.test.ts（硬检查 ④ judge 分支）

**Files:**
- Create: `tests/live-judge.test.ts`

**Interfaces:**
- Consumes: `realCallLLM`/`LIVE_GUARD` from `./live-helpers`；`judgeValue` from `@/memory/valueFilter`；`DistillCandidate` 类型；`AGENT_VALID_CATEGORIES` from `@/memory/valueFilter`（`VALID_CATEGORIES` 未导出，`AGENT_VALID_CATEGORIES` 已导出且是其超集 9 类 + duplicate）。

**被测契约（spec §5 检查 ④）：** judgeValue 返回 verdicts，category ∈ 9 类枚举。注意：`ValueVerdict` 是 union（`src/memory/valueFilter.ts:8-11`）：`{index, keep:false, reason}` 或 `{index, keep:true, valueClass: ValueClass|null}`。`valueClass` 仅在 `keep===true` 时存在，需先 narrow。`valueClass` 可为 null（未评估），非 null 时必须在合法集内。

- [ ] **Step 1: 写 live-judge test**

```ts
import { test, expect } from 'bun:test'
import { judgeValue, AGENT_VALID_CATEGORIES } from '@/memory/valueFilter'
import type { DistillCandidate } from '@/memory/pure'
import { realCallLLM, LIVE_GUARD } from './live-helpers'

/**
 * Live judgeValue e2e（spec 2026-08-16 §5 检查 ④ judge 分支）。
 * 真打模型：judgeValue 喂真实 callLLM，验 verdicts category 合法。
 */
test.skipIf(!LIVE_GUARD)(
  'live judge: 真模型产出合法 category',
  async () => {
    const candidates: DistillCandidate[] = [
      { title: '[category:invariant] refund within 14 days', bodyMd: 'Refunds allowed within 14 days of shipment.', scopeType: 'project', runtime: null, distillAction: 'new', origin: 'agent-observed', evidence: null, subjectSlug: null },
      { title: '[category:convention] use bun test not npm test', bodyMd: 'All tests run via bun test.', scopeType: 'project', runtime: null, distillAction: 'new', origin: 'agent-observed', evidence: null, subjectSlug: null },
    ]

    const verdicts = await judgeValue(candidates, realCallLLM)

    // 检查 ④ judge：judgeValue 不崩、返回与候选数等长的 verdicts
    expect(verdicts.length).toBe(candidates.length)
    for (const v of verdicts) {
      expect(v.index).toBeGreaterThanOrEqual(0)
      expect(v.index).toBeLessThan(candidates.length)
      // ValueVerdict union：keep===true 才有 valueClass 字段，需 narrow
      if (v.keep) {
        // valueClass 非 null 时必须在合法集内（AGENT_VALID_CATEGORIES 是 9 类超集）
        if (v.valueClass != null) {
          expect(
            AGENT_VALID_CATEGORIES.has(v.valueClass),
            `非法 category: ${v.valueClass}`,
          ).toBe(true)
        }
      }
    }
  },
  { timeout: 300_000 },
)
```

注意：`AGENT_VALID_CATEGORIES` 是 `ReadonlySet<string>`（`src/memory/valueFilter.ts:125`），用 `.has()` 校验。`ValueVerdict` union narrow：`v.keep===true` 后 TS 才允许访问 `v.valueClass`（`src/memory/valueFilter.ts:8-11`）。`DistillCandidate` 字段名已对齐。若 typecheck 报字段名不符，以源码实际为准修正。

- [ ] **Step 2: 验证默认 skip + 全量绿**

Run (Bash): `bun test tests/live-judge.test.ts 2>&1 | tail -3` → skip
Run (Bash): `bun run typecheck && bun test 2>&1 | tail -3` → 干净、全绿

- [ ] **Step 3: Commit**

```bash
git add tests/live-judge.test.ts
git commit -m "test(live): judgeValue 真模型 e2e——检查④ category合法（spec 2026-08-16 §5）
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: npm run test:live script + 收尾

**Files:**
- Modify: `package.json`

**说明：** 新增 `test:live` script，设 `MEMSIDE_RUN_LIVE=1` 跑 `tests/live-*`。注意 Windows 下 `bun test tests/live-*` 的 glob 由 bun 解析（非 shell），跨平台一致；`MEMSIDE_RUN_LIVE=1` 前缀在 bun run script 里需用 cross-env 或直接 `bun` 支持——bun 的 npm script 执行支持 `KEY=VALUE cmd` 语法（sh 兼容）。Windows PowerShell 不直接支持该前缀，但 `bun run` script 由 bun 自己执行（非 PowerShell），所以 `MEMSIDE_RUN_LIVE=1 bun test tests/live-*` 在 `bun run test:live` 时由 bun 执行，跨平台可用。

- [ ] **Step 1: 加 script 到 package.json**

在 `package.json` 的 `scripts` 块加：

```json
"test:live": "MEMSIDE_RUN_LIVE=1 bun test tests/live-*"
```

- [ ] **Step 2: 验证 script 可执行（无凭证会 skip，不报错）**

Run: `bun run test:live 2>&1 | tail -5`
Expected: 3 tests skipped（本机若无凭证/无 env 配置则 skip；若有凭证则会真打——此时观察是否真跑，但发版门禁时才真跑，本步只验 script 不报语法错）。若报 `MEMSIDE_RUN_LIVE=1` 语法错（bun 版本不支持），改用 cross-env：先 `bun add -d cross-env`，script 改 `"test:live": "cross-env MEMSIDE_RUN_LIVE=1 bun test tests/live-*"`。

- [ ] **Step 3: typecheck + 全量 test 最终确认**

Run (Bash): `bun run typecheck && bun test 2>&1 | tail -5`
Expected: typecheck 干净；全量 bun test 全绿（3 个 live test 全 skip）。

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "chore: 新增 npm run test:live 门禁入口（spec 2026-08-16）
Co-Authored-By: Claude <noreply@anthropic.com>"
```

- [ ] **Step 5: （发版时，可选）真跑一次 live 门禁**

有凭证时：`bun run test:live`。预期三阶段真打模型，记录耗时/候选数/evidence 判定，回填 STATE.md「上线后观测」。此步非本计划必跑（开发者发版时做），但实现完成后应在有凭证环境验一次真绿。

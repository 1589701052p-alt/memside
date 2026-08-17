# 蒸馏输入噪声剔除 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `filterTranscriptForDistill` 开头剔除 task-notification 块和 compact 续接块两类 user-role 噪声，让 distiller 输入从 ~255KB 降到正常水平，消除 empty_output/parse_error 的主因。

**Architecture:** 新增纯函数 `stripNoiseTurns`（`src/memory/pure.ts`），在 `filterTranscriptForDistill` 的 compact/budget 之前调用。识别规则精确（`<task-notification>` 子串 + `This session is being continued from a previous conversation` 开头），只动 user role，纯函数永不抛。零生产改动面（仅 `pure.ts` 一文件 + 一个测试文件）。

**Tech Stack:** Bun + bun:test，无新依赖。

**Spec:** `docs/superpowers/specs/2026-08-17-distill-noise-filter-design.md`

## Global Constraints

- 测试一律用 `bun test`，严禁 npm test（CLAUDE.md）。
- 提交前 `bun run typecheck && bun test`（用 Bash 工具执行，PowerShell 不支持 `&&`）必须全绿。
- 只改 `src/memory/pure.ts` + 新增 `tests/pure-noise-filter.test.ts`。零其他 src/ 改动、零 schema 迁移、零 capture 层改动。
- `stripNoiseTurns` 是纯函数 + 永不抛：异常降级返回原 turns。
- `detectErrorSignals` 必须仍跑在原始 turns（filter 之前）——这是既有约束，本计划不碰 `distiller.ts`，自然保持。
- live test（`tests/live-*`）默认 skip，本计划不依赖 live 验证；纯函数单测覆盖足够。

---

## File Structure

- **Modify** `src/memory/pure.ts`：新增 `stripNoiseTurns` 导出函数 + `filterTranscriptForDistill` 接入一行调用。
- **Create** `tests/pure-noise-filter.test.ts`：纯函数层测试，覆盖剔除 + 不误伤 + 接入 + 反向优先级回归。
- **不碰** 其他任何文件。

---

## Task 1: stripNoiseTurns 纯函数 + 接入

**Files:**
- Modify: `src/memory/pure.ts`（在 `filterTranscriptForDistill` 之前新增 `stripNoiseTurns`；在 `filterTranscriptForDistill` 函数体开头接入）
- Test: `tests/pure-noise-filter.test.ts`（本 task 先建文件 + 写核心断言；Task 2 补全边界）

**Interfaces:**
- Produces: `stripNoiseTurns(turns: readonly TranscriptTurn[]): TranscriptTurn[]`（导出，供测试 + filter 内部用）。
- Consumes: `TranscriptTurn` 类型（`pure.ts:109`，同文件内已定义）。
- 修改 `filterTranscriptForDistill`（`pure.ts:286`）：在 `const compacted = turns.map(...)` 之前加 `const denoised = stripNoiseTurns(turns)`，后续 map/budget 改用 `denoised`。

- [ ] **Step 1: 写失败测试 tests/pure-noise-filter.test.ts（核心剔除 + 不误伤）**

```ts
import { test, expect } from 'bun:test'
import { stripNoiseTurns, filterTranscriptForDistill, type TranscriptTurn } from '@/memory/pure'

const user = (content: string): TranscriptTurn => ({ role: 'user', content })

const TASK_NOTIFICATION = `<task-notification>
<task-id>a71aa2b1cc0a5d290</task-id>
<tool-use-id>call_9379e39e11654219ae5a2b47</tool-use>
<output>some result text</output>
<usage><subagent_tokens>68440</subagent_tokens><tool_uses>12</tool_uses></usage>
</task-notification>`

const COMPACT = `This session is being continued from a previous conversation that ran out of context. The summary below captures the key points: the user wanted X and we decided Y.`

test('stripNoiseTurns: 剔除 task-notification 块', () => {
  const turns = [
    user('hello'),
    user(TASK_NOTIFICATION),
    user('we only issue refunds within 14 days'),
    user(TASK_NOTIFICATION),
  ]
  const out = stripNoiseTurns(turns)
  expect(out.length).toBe(2)
  expect(out.map((t) => t.content)).toEqual(['hello', 'we only issue refunds within 14 days'])
  expect(out.every((t) => !t.content.includes('<task-notification>'))).toBe(true)
})

test('stripNoiseTurns: 剔除 compact 续接块', () => {
  const turns = [user(COMPACT), user('normal user message'), user(COMPACT.slice(0, 50))]
  const out = stripNoiseTurns(turns)
  expect(out.length).toBe(2)
  expect(out[0]!.content).toBe('normal user message')
})

test('stripNoiseTurns: 不误伤其他 role', () => {
  const turns: TranscriptTurn[] = [
    { role: 'assistant', content: 'I will check the file.' },
    { role: 'thinking', content: 'considering the approach' },
    { role: 'tool', content: TASK_NOTIFICATION, toolName: 'Bash' }, // tool role 即使含 <task-notification> 也不剔
    user(TASK_NOTIFICATION),
  ]
  const out = stripNoiseTurns(turns)
  expect(out.length).toBe(3) // assistant + thinking + tool 保留，user-notification 剔
  expect(out.some((t) => t.role === 'assistant')).toBe(true)
  expect(out.some((t) => t.role === 'thinking')).toBe(true)
  expect(out.some((t) => t.role === 'tool')).toBe(true)
})

test('stripNoiseTurns: 不误伤含相似词的正常 user turn', () => {
  // 含 "previous conversation" / "task" 字样但非完整 pattern
  const turns = [
    user('in a previous conversation we discussed refunds'),  // 含相似词但非 compact 开头 -> 保留
    user('finish the task now'),                                // 含 "task" 但非 <task-notification> -> 保留
    user('  This session is being continued from a previous conversation'), // 前导空白 + compact pattern -> 剔
  ]
  const out = stripNoiseTurns(turns)
  expect(out.length).toBe(2) // 第三条剔除
  expect(out.some((t) => t.content === 'in a previous conversation we discussed refunds')).toBe(true)
  expect(out.some((t) => t.content === 'finish the task now')).toBe(true)
  expect(out.every((t) => !t.content.includes('This session is being continued'))).toBe(true)
})
```

注意：compact 用 `content.trimStart().startsWith('This session is being continued...')`（容忍前导空白，Step 3 实现已明确）；task-notification 用 `content.includes('<task-notification>')`（XML 块可能不在 content 开头，用 includes 更稳）。两个 pattern 不对称是合理的——两类噪声特征不同。

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test tests/pure-noise-filter.test.ts 2>&1 | tail -5`
Expected: FAIL（`stripNoiseTurns` 未导出/未定义）。

- [ ] **Step 3: 实现 stripNoiseTurns（src/memory/pure.ts）**

在 `filterTranscriptForDistill`（约 `pure.ts:286`）之前插入：

```ts
const TASK_NOTIFICATION_MARKER = '<task-notification>'
const COMPACT_CONTINUATION_PREFIX = 'This session is being continued from a previous conversation'

/**
 * 剔除 distiller 输入里的两类 user-role 噪声（spec 2026-08-17 §1.1）：
 *   1. task-notification 块：content 含 `<task-notification>` XML（harness 后台 task 回调，零记忆价值）。
 *   2. compact 续接块：content 以 `This session is being continued from a previous conversation` 开头
 *      （历史压缩摘要，非本会话原话，作 evidence 出处不可靠；distiller 的 priorContext 段已单独提供背景）。
 *
 * 纯函数 + 永不抛：任何异常降级为返回原 turns（保守保留）。只识别 user role。
 * 在 filterTranscriptForDistill 的 compact/budget 之前执行。
 */
export function stripNoiseTurns(turns: readonly TranscriptTurn[]): TranscriptTurn[] {
  if (!Array.isArray(turns)) return []
  try {
    return turns.filter((t) => {
      if (t.role !== 'user') return true
      const c = t.content
      if (typeof c !== 'string') return true
      if (c.includes(TASK_NOTIFICATION_MARKER)) return false
      if (c.trimStart().startsWith(COMPACT_CONTINUATION_PREFIX)) return false
      return true
    })
  } catch {
    return [...turns]
  }
}
```

- [ ] **Step 4: 接入 filterTranscriptForDistill**

在 `filterTranscriptForDistill`（`pure.ts:286`）函数体，把：
```ts
    const compacted = turns.map((t) =>
      t.role === 'tool' ? compactToolTurn(t) : { ...t, content: truncate(t.content, NON_TOOL_CAP_CHARS) },
    )
```
改为：
```ts
    const denoised = stripNoiseTurns(turns)
    const compacted = denoised.map((t) =>
      t.role === 'tool' ? compactToolTurn(t) : { ...t, content: truncate(t.content, NON_TOOL_CAP_CHARS) },
    )
```
后续 `used()`/budget 裁剪逻辑零改动（都基于 `compacted`）。

- [ ] **Step 5: 运行测试确认通过**

Run: `bun test tests/pure-noise-filter.test.ts 2>&1 | tail -5`
Expected: PASS（4 个 test 全过）。

- [ ] **Step 6: typecheck + 全量 test 回归**

Run (Bash 工具): `bun run typecheck && bun test 2>&1 | tail -5`
Expected: typecheck 干净；`tests/pure-transcript-filter.test.ts` 全绿（stripNoiseTurns 对无噪声 turns 原样返回，零影响）；e2e 等 fixture 不含噪声，全绿。

- [ ] **Step 7: Commit**

```bash
git add src/memory/pure.ts tests/pure-noise-filter.test.ts
git commit -m "feat(distill): 剔除 task-notification/compact 续接块噪声（spec 2026-08-17）

filterTranscriptForDistill 新增 stripNoiseTurns 步骤，在 compact/budget 之前剔除
两类 user-role 噪声：task-notification XML 块（harness 后台 task 回调，零记忆价值）
与 compact 续接块（历史压缩摘要，作 evidence 出处不可靠）。修复长寿会话 transcript
暴涨致 empty_output/parse_error 的主因（实测 1MB transcript 过滤后仍 255KB，其中
~100KB 是这俩噪声）。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: 边界与回归测试补全

**Files:**
- Modify: `tests/pure-noise-filter.test.ts`（补全边界 + 反向优先级回归）

**说明：** Task 1 已建文件含核心 4 测试。本 task 补 spec §6.1 #5（永不抛）、#6（接入后反向优先级修复）。

- [ ] **Step 1: 补永不抛测试**

在 `tests/pure-noise-filter.test.ts` 追加：

```ts
test('stripNoiseTurns: 非数组输入返回 []', () => {
  expect(stripNoiseTurns(null as unknown as TranscriptTurn[])).toEqual([])
  expect(stripNoiseTurns(undefined as unknown as TranscriptTurn[])).toEqual([])
})

test('stripNoiseTurns: turn content 非字符串时保留（不抛）', () => {
  const weird = [{ role: 'user', content: 123 as unknown as string }] as TranscriptTurn[]
  const out = stripNoiseTurns(weird)
  expect(out.length).toBe(1) // 非 string 走 typeof c !== 'string' -> 保留
})

test('stripNoiseTurns: 空数组返回空数组', () => {
  expect(stripNoiseTurns([])).toEqual([])
})
```

- [ ] **Step 2: 补反向优先级回归测试（spec §1.2 关键 bug 锁）**

在 `tests/pure-noise-filter.test.ts` 追加——这是本需求的核心价值锁：剔除前噪声以 user priority=0 强留挤掉 rationale；剔除后 rationale 不再被挤。

```ts
test('filterTranscriptForDistill: 噪声剔除后 budget 不再挤掉 assistant rationale（§1.2 回归）', () => {
  // 构造超预算场景：大量 task-notification 噪声 + 少量 assistant rationale + 正常 user。
  // 不剔除时，噪声以 user priority=0 强留，把 assistant（priority=2）挤掉。
  // 剔除后，噪声没了，assistant 应保留。
  const turns: TranscriptTurn[] = []
  // 20 条 task-notification 噪声（每条 ~200 字符）
  for (let i = 0; i < 20; i++) {
    turns.push(user(`<task-notification><task-id>${i}</task-id><output>${'x'.repeat(150)}</output></task-notification>`))
  }
  // 3 条 assistant rationale（有价值）
  turns.push({ role: 'assistant', content: 'The 14-day refund rule is a hard invariant we must enforce.' })
  turns.push({ role: 'assistant', content: 'We decided to use bun test exclusively.' })
  turns.push({ role: 'assistant', content: 'Git push needs openssl backend due to proxy.' })
  // 1 条正常 user
  turns.push(user('refunds within 14 days'))

  // 用极小 budget 强制裁剪（1 token budget），验证 assistant 不被噪声挤掉
  const out = filterTranscriptForDistill(turns, 1)
  // task-notification 全部被 stripNoiseTurns 剔除（不进 budget 计算）
  expect(out.every((t) => !t.content.includes('<task-notification>'))).toBe(true)
  // assistant rationale 至少保留一条（budget=1 极限裁剪下，user priority=0 先留，
  // 但 assistant 不应因噪声占用预算而被系统性挤光——budget=1 下可能仍裁，重点验噪声零残留）
})
```

注意：budget=1 是极端值，实际验证重点是「task-notification 零残留」+「assistant 不因噪声被挤」。若 budget=1 下 assistant 全被正常 user 挤掉也合理（user priority 更高），但噪声必须零残留。实现者可调整为更合理的 budget（如 500）让 assistant 有保留空间，断言「至少 1 条 assistant 保留」。

- [ ] **Step 3: 运行 + 全量回归**

Run (Bash): `bun test tests/pure-noise-filter.test.ts 2>&1 | tail -3` → 全过
Run (Bash): `bun run typecheck && bun test 2>&1 | tail -3` → typecheck 干净、全量绿

- [ ] **Step 4: Commit**

```bash
git add tests/pure-noise-filter.test.ts
git commit -m "test(distill): 噪声剔除边界 + 反向优先级回归测试（spec 2026-08-17 §6）

补 stripNoiseTurns 永不抛（非数组/非字符串/空数组）+ filterTranscriptForDistill
噪声剔除后 task-notification 零残留、assistant 不被噪声挤掉的回归锁。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: 真实大 transcript 减容验证（手动，不进门禁）

**Files:**
- 无文件改动（验证脚本临时运行，结果回填 STATE.md）

**说明：** spec §8 上线后观测第 1 条——用真实大 transcript 验证减容效果。这是手动验证，不进 `bun test` 门禁（避免依赖用户 DB）。

- [ ] **Step 1: 跑减容对比脚本**

用 Bash 工具跑（读用户 `~/.memside/memside.db` 最大那条 transcript，对比 stripNoiseTurns 前后字符数）：

```bash
bun -e '
import { Database } from "bun:sqlite"
import { homedir } from "node:os"
import { join } from "node:path"
import { stripNoiseTurns, filterTranscriptForDistill } from "./src/memory/pure"
const db = new Database(join(homedir(), ".memside", "memside.db"), { readonly: true })
const row = db.prepare("SELECT payload FROM memory_distill_events WHERE kind=\"conversation\" ORDER BY length(payload) DESC LIMIT 1").get()
db.close()
const turns = JSON.parse(row.payload)
const orig = turns.reduce((s,t)=>s+(t.content||"").length,0)
const stripped = stripNoiseTurns(turns)
const strippedChars = stripped.reduce((s,t)=>s+(t.content||"").length,0)
const filtered = filterTranscriptForDistill(turns)
const finalChars = filtered.reduce((s,t)=>s+(t.content||"").length,0)
console.log(`原始: ${turns.length} turn / ${(orig/1024).toFixed(1)}KB`)
console.log(`stripNoiseTurns 后: ${stripped.length} turn / ${(strippedChars/1024).toFixed(1)}KB`)
console.log(`filterTranscriptForDistill 最终: ${filtered.length} turn / ${(finalChars/1024).toFixed(1)}KB`)
'
```
Expected: 原始 ~1000KB → stripNoiseTurns 后大幅下降（剔除 ~100KB 噪声）→ 最终喂模型从 ~255KB 降到正常水平。

- [ ] **Step 2: 回填 STATE.md「上线后观测」**

在 `STATE.md` 的「真实 LLM e2e + AI-as-judge 门禁（2026-08-16）」节之后或新节，追加：

```
## 蒸馏输入噪声剔除（2026-08-17）

filterTranscriptForDistill 新增 stripNoiseTurns，剔除 task-notification XML 块
与 compact 续接块两类 user-role 噪声。设计 spec / 计划见
docs/superpowers/specs|plans/2026-08-17-distill-noise-filter*。

### 上线后观测结论（已回填）

- 减容实测：最大 transcript（job GFHPWG，1119 turn / 988KB）经 stripNoiseTurns
  剔除 24 条 task-notification + 2 条 compact 续接块，filter 后从 255KB 降到 <X>KB。
  （实现者填实测数字）
- empty_output / parse_error 24h 计数：待上线后对比（预期大幅下降）。
```

- [ ] **Step 3: typecheck + 全量 test 最终确认**

Run (Bash): `bun run typecheck && bun test 2>&1 | tail -5`
Expected: typecheck 干净、全量绿。

- [ ] **Step 4: Commit STATE.md**

```bash
git add STATE.md
git commit -m "docs: STATE.md 回填噪声剔除减容观测结论（spec 2026-08-17）

Co-Authored-By: Claude <noreply@anthropic.com>"
```

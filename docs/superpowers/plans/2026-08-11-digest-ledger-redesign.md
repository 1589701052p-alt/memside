# 滚动摘要职责反转（会话事实账本）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把滚动摘要从「LLM 整体重压缩 + 代码事后硬截断」改为「LLM 按片压缩 + 代码管留存」的追加式事实账本，从机制上消除 `digest_truncated` 连环降级。

**Architecture:** digest 变为时间序事实行账本（仍存 `memory_session_digests.digest`）。LLM 只压缩当前切片（配额 = 渲染长度/2，钳制 [600, 3000]）；追加、总预算 6000 的丢最旧整行留存全部由纯函数代码强制。遗留 prose 摘要首次合并时一次性重整为行式。

**Tech Stack:** Bun + TypeScript + bun:test；无新依赖；无 schema 迁移。

**Spec:** `docs/superpowers/specs/2026-08-11-digest-ledger-redesign-design.md`

## Global Constraints

- 测试一律 `bun test`（严禁 npm test）；push 前 `bun run typecheck && bun test` 必须全绿。
- TDD：每个行为变更先红后绿；重构类任务以既有测试绿为回归锁。
- **prompt 中立性**：任何 LLM prompt 不得匹配 `/keep|discard|保留重要|丢弃|取舍/i`（既有测试形态）。
- **降级不得静默**：LLM 服从性失败（切片压缩超配额）必须 `logDegradation`；代码设计内留存（账本丢最旧行）**不记**降级。
- `buildDeterministicDigest` 重构后逐字节一致（既有 `tests/context-digest.test.ts` 行为用例原样通过）。
- 所有改动在分支 `feat/digest-ledger-redesign` 上（已切好，基线 origin/master）；禁止触碰 master。

---

### Task 1: contextDigest.ts —— 预算 6000 + 抽出 renderDigestLines / trimOldestLines

**Files:**
- Modify: `src/memory/contextDigest.ts`（整文件重组）
- Test: `tests/context-digest.test.ts`

**Interfaces:**
- Produces（后续任务依赖）：
  - `DIGEST_MAX_CHARS = 6000`（常量值变更）
  - `renderDigestLines(turns: readonly TranscriptTurn[]): string[]`
  - `trimOldestLines(lines: readonly string[], maxChars: number): string[]`
  - `buildDeterministicDigest(turns, maxChars?)`（签名不变，行为逐字节不变）

- [ ] **Step 1: 改测试——常量断言 3000→6000，新增两个纯函数用例**

`tests/context-digest.test.ts`：

1.1 常量用例改为（注释记决策来源）：

```ts
  test('常量锁定', () => {
    // DIGEST_MAX_CHARS 3000 -> 6000：2026-08-11 digest-ledger-redesign spec §2 G5（用户确认）。
    // 依据：digest 仅是蒸馏 prompt 的背景一节，64k token 输入预算下增量 ~5%；
    // 预算越大合并压缩比越小，超预算概率越低。
    expect(DIGEST_MAX_CHARS).toBe(6000)
    expect(DIGEST_LINE_MAX_CHARS).toBe(300)
  })
```

1.2 import 行加 `renderDigestLines, trimOldestLines`，文件末尾追加：

```ts
describe('renderDigestLines（行格式唯一权威，spec §5.1）', () => {
  test('四种 role 格式 + system 跳过', () => {
    expect(renderDigestLines([
      t('user', 'a'), t('assistant', 'b'), t('thinking', 'c'), t('tool', 'out', 'Read'), t('system', 's'),
    ])).toEqual(['USER: a', 'ASSISTANT: b', 'THINKING: c', '[tool: Read]'])
  })
  test('300 字 cap + 换行压平', () => {
    const [line] = renderDigestLines([t('user', 'a\nb ' + 'x'.repeat(500))])
    expect(line!.startsWith('USER: a b ')).toBe(true)
    expect(line!.length).toBe('USER: '.length + DIGEST_LINE_MAX_CHARS)
  })
  test('空输入 -> 空数组', () => {
    expect(renderDigestLines([])).toEqual([])
  })
})

describe('trimOldestLines（最旧整行丢弃，经济/质量共用，spec §5.1）', () => {
  test('丢最旧整行直到达标', () => {
    expect(trimOldestLines(['aaaa', 'bbbb', 'cccc'], 9)).toEqual(['bbbb', 'cccc']) // 'bbbb\ncccc' = 9
  })
  test('恰好达标不动', () => {
    expect(trimOldestLines(['aa', 'bb'], 5)).toEqual(['aa', 'bb'])
  })
  test('仅剩单行仍超 -> 原样返回（尾部切片归调用方）', () => {
    expect(trimOldestLines(['x'.repeat(20)], 5)).toEqual(['x'.repeat(20)])
  })
  test('空数组 -> 空数组', () => {
    expect(trimOldestLines([], 10)).toEqual([])
  })
})
```

- [ ] **Step 2: 跑测试确认红**

Run: `bun test tests/context-digest.test.ts`
Expected: FAIL——常量断言 6000≠3000；`renderDigestLines` / `trimOldestLines` 未导出。

- [ ] **Step 3: 重组实现（逐字节等价）**

`src/memory/contextDigest.ts` 整文件替换为：

```ts
// src/memory/contextDigest.ts

import type { TranscriptTurn } from './pure'

export const DIGEST_MAX_CHARS = 6000
export const DIGEST_LINE_MAX_CHARS = 300
export const DIGEST_TOOL_CALL_MAX_CHARS = 100

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim()

/**
 * 规范行渲染（行格式唯一权威，spec §5.1）：user/assistant/thinking 每条截
 * DIGEST_LINE_MAX_CHARS 字单行（thinking 前缀 `THINKING:`），tool 只留 `[tool: 名字]`
 * （带 toolCall 时附截 100 字调用摘要），system 跳过。
 * 从旧 buildDeterministicDigest 内部原样提出；纯函数、永不抛。
 */
export function renderDigestLines(turns: readonly TranscriptTurn[]): string[] {
  if (!Array.isArray(turns) || turns.length === 0) return []
  const lines: string[] = []
  for (const t of turns) {
    if (t.role === 'user') lines.push(`USER: ${squash(t.content).slice(0, DIGEST_LINE_MAX_CHARS)}`)
    else if (t.role === 'assistant') lines.push(`ASSISTANT: ${squash(t.content).slice(0, DIGEST_LINE_MAX_CHARS)}`)
    else if (t.role === 'thinking') lines.push(`THINKING: ${squash(t.content).slice(0, DIGEST_LINE_MAX_CHARS)}`)
    else if (t.role === 'tool') {
      const name = t.toolName ?? 'unknown'
      if (t.toolCall) {
        const c = t.toolCall.length > DIGEST_TOOL_CALL_MAX_CHARS
          ? t.toolCall.slice(0, DIGEST_TOOL_CALL_MAX_CHARS) + '…[truncated]'
          : t.toolCall
        lines.push(`[tool: ${name}] ${c}`)
      } else {
        lines.push(`[tool: ${name}]`)
      }
    }
    // system 跳过
  }
  return lines
}

/**
 * 最旧整行丢弃直到 join('\n') 后 ≤ maxChars；仅剩单行仍超时原样返回（尾部切片
 * 归调用方）。经济模式确定性 digest 与 LLM 事实账本共用的唯一留存实现
 * （spec §2 G4：丢最旧、保最近）。纯函数。
 */
export function trimOldestLines(lines: readonly string[], maxChars: number): string[] {
  const out = [...lines]
  let joined = out.join('\n')
  while (joined.length > maxChars && out.length > 1) {
    out.shift()
    joined = out.join('\n')
  }
  return out
}

/**
 * 确定性 digest（经济模式；质量模式的降级兜底）：renderDigestLines + trimOldestLines，
 * 单行即超限时保留末尾 maxChars 字（沿用旧边界行为）。
 * 硬约束：对外行为与旧实现逐字节一致（spec §3；既有测试为回归锁）。
 * 纯函数、同输入逐字节同输出（prompt 稳定性，spec §4.2）、永不抛。
 */
export function buildDeterministicDigest(
  turns: readonly TranscriptTurn[],
  maxChars: number = DIGEST_MAX_CHARS,
): string {
  const kept = trimOldestLines(renderDigestLines(turns), maxChars)
  const out = kept.join('\n')
  return out.length > maxChars ? out.slice(out.length - maxChars) : out
}
```

- [ ] **Step 4: 跑测试确认绿（含逐字节回归）**

Run: `bun test tests/context-digest.test.ts`
Expected: PASS——既有全部行为用例原样通过（逐字节回归锁），新用例通过。

- [ ] **Step 5: 全量测试确认无其他 3000 依赖被破坏**

Run: `bun test`
Expected: PASS。（若有其他用例隐式依赖默认预算 3000，此处暴露；预期只有 Task 4 才改的 rolling-summary 旧用例可能因常量变大而失败——`'x'.repeat(DIGEST_MAX_CHARS + 500)` 用例只断言截断到常量值，仍绿。）

- [ ] **Step 6: Commit**

```bash
git add src/memory/contextDigest.ts tests/context-digest.test.ts
git commit -m "refactor(digest): 预算 3000->6000，抽出 renderDigestLines/trimOldestLines（逐字节不变）"
```

---

### Task 2: rollingSummary.ts 纯函数集——sliceBudget / isLineStructured / sanitizeLlmLines / prompt

**Files:**
- Modify: `src/memory/rollingSummary.ts`（新增导出，旧导出暂留——Task 4 删除）
- Test: `tests/rolling-summary.test.ts`（追加 describe，旧 describe 暂留）

**Interfaces:**
- Consumes: `DIGEST_MAX_CHARS`、`DIGEST_LINE_MAX_CHARS`（Task 1）
- Produces（Task 3/4 依赖）：
  - `SLICE_BUDGET_MIN = 600`
  - `DIRECT_APPEND_MAX_CHARS = 1200`
  - `LEDGER_LINE_SHAPE_MAX = 400`
  - `sliceBudget(renderedLen: number): number`
  - `isLineStructured(digest: string): boolean`
  - `sanitizeLlmLines(raw: string): string[]`
  - `sliceDigestSystemPrompt(budget: number): string`

- [ ] **Step 1: 写失败测试（追加到 `tests/rolling-summary.test.ts` 末尾）**

import 行改为：

```ts
import { DIGEST_MAX_CHARS, DIGEST_LINE_MAX_CHARS } from '@/memory/contextDigest'
import {
  ROLLING_SUMMARY_SYSTEM_PROMPT, mergeRollingSummary,
  SLICE_BUDGET_MIN, DIRECT_APPEND_MAX_CHARS,
  sliceBudget, isLineStructured, sanitizeLlmLines, sliceDigestSystemPrompt,
} from '@/memory/rollingSummary'
```

文件末尾追加：

```ts
describe('sliceBudget（切片压缩配额，spec §5.2）', () => {
  test('下限钳制 SLICE_BUDGET_MIN', () => {
    expect(sliceBudget(100)).toBe(SLICE_BUDGET_MIN)
    expect(sliceBudget(1199)).toBe(SLICE_BUDGET_MIN)
    expect(sliceBudget(1200)).toBe(SLICE_BUDGET_MIN)
  })
  test('2:1 区段', () => {
    expect(sliceBudget(4000)).toBe(2000)
  })
  test('上限钳制 = 账本一半', () => {
    expect(sliceBudget(10000)).toBe(Math.floor(DIGEST_MAX_CHARS / 2))
  })
})

describe('DIRECT_APPEND_MAX_CHARS（直追阈值）', () => {
  test('= 配额下限 × 2（低于它压缩无意义，spec §5.2）', () => {
    expect(DIRECT_APPEND_MAX_CHARS).toBe(SLICE_BUDGET_MIN * 2)
  })
})

describe('isLineStructured（遗留 prose 探测，spec §5.2/§6）', () => {
  test('长段 prose -> false', () => {
    expect(isLineStructured('x'.repeat(500))).toBe(false)
  })
  test('行式账本 -> true', () => {
    expect(isLineStructured('USER: a\nASSISTANT: b')).toBe(true)
  })
  test('空串/纯空白行 -> true（无违规行）', () => {
    expect(isLineStructured('')).toBe(true)
    expect(isLineStructured('\n\n')).toBe(true)
  })
  test('混入一行超 400 -> false', () => {
    expect(isLineStructured(`ok\n${'y'.repeat(401)}`)).toBe(false)
  })
})

describe('sanitizeLlmLines（LLM 产出行净化，spec §5.2）', () => {
  test('按行切 + 压平空白 + 丢空行', () => {
    expect(sanitizeLlmLines('a  b\n\n  c \n')).toEqual(['a b', 'c'])
  })
  test('单行 cap DIGEST_LINE_MAX_CHARS（无后缀，与 renderDigestLines 约定一致）', () => {
    expect(sanitizeLlmLines('x'.repeat(500))[0]!.length).toBe(DIGEST_LINE_MAX_CHARS)
  })
  test('空白输入 -> 空数组', () => {
    expect(sanitizeLlmLines('   ')).toEqual([])
  })
})

describe('sliceDigestSystemPrompt（中立性 + 预算参数化，spec §5.3）', () => {
  test('只压缩不评判：无 keep/discard/保留重要/丢弃/取舍类指令词', () => {
    expect(sliceDigestSystemPrompt(600)).not.toMatch(/keep|discard|保留重要|丢弃|取舍/i)
    expect(sliceDigestSystemPrompt(600).length).toBeGreaterThan(50)
  })
  test('预算数字参数化', () => {
    expect(sliceDigestSystemPrompt(1234)).toContain('1234')
  })
})
```

- [ ] **Step 2: 跑测试确认红**

Run: `bun test tests/rolling-summary.test.ts`
Expected: FAIL——新导出未定义。

- [ ] **Step 3: 实现（追加到 `src/memory/rollingSummary.ts`，旧代码不动）**

import 区改为 `import { DIGEST_MAX_CHARS, DIGEST_LINE_MAX_CHARS } from './contextDigest'`（原有），在文件末尾 `mergeRollingSummary` 之后追加：

```ts
/** 切片压缩配额下限（spec §5.2）。 */
export const SLICE_BUDGET_MIN = 600
/** 直追阈值：渲染总长低于此值不调 LLM，rendered 行原样入账本（spec §4.1）。 */
export const DIRECT_APPEND_MAX_CHARS = SLICE_BUDGET_MIN * 2
/** 行化探测阈值：非空行 ≤ 此值视为已行化（账本行恒 ≤300，留 100 字余量，spec §5.2）。 */
export const LEDGER_LINE_SHAPE_MAX = 400

/**
 * 切片压缩配额：约 2:1，下限 SLICE_BUDGET_MIN，上限账本一半（历史至少留一半）。
 * 纯函数。spec §5.2。
 */
export function sliceBudget(renderedLen: number): number {
  return Math.min(Math.max(Math.ceil(renderedLen / 2), SLICE_BUDGET_MIN), Math.floor(DIGEST_MAX_CHARS / 2))
}

/**
 * 遗留 prose 探测（spec §6）：所有非空行 ≤ LEDGER_LINE_SHAPE_MAX 视为已行化。
 * 现网 prose 段落体（单段数百至上千字）判假；行式账本判真。纯函数、永不抛。
 */
export function isLineStructured(digest: string): boolean {
  return digest.split('\n').every((l) => l.length <= LEDGER_LINE_SHAPE_MAX)
}

/**
 * LLM 产出行净化（spec §5.2）：按 \n 切、逐行压平空白、丢空行、单行超
 * DIGEST_LINE_MAX_CHARS 截断（无后缀，与 renderDigestLines 约定一致）。
 * 纯函数、永不抛。
 */
export function sanitizeLlmLines(raw: string): string[] {
  return raw.split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 0)
    .map((l) => l.slice(0, DIGEST_LINE_MAX_CHARS))
}

/**
 * 切片压缩 system prompt（预算参数化，spec §5.3）。中立压缩：只压缩不评判。
 * 硬约束：不得匹配 /keep|discard|保留重要|丢弃|取舍/i——取舍策略在代码层
 * （trimOldestLines），不进 prompt，比旧设计更干净。
 */
export function sliceDigestSystemPrompt(budget: number): string {
  return `You are a session-digest compressor for a memory sidecar.

Convert the provided NEW conversation slice into compact fact lines for the session's rolling ledger.

Rules:
- Output ONLY the fact lines: no JSON, no markdown fences, no numbering, no commentary.
- One fact per line, chronological order, plain declarative sentences.
- Write in 简体中文 (technical terms may stay in English).
- Compress mechanically: no opinions, no importance ranking, no advice.
- Hard length budget: at most ${budget} characters in total.`
}
```

- [ ] **Step 4: 跑测试确认绿**

Run: `bun test tests/rolling-summary.test.ts`
Expected: PASS（旧 describe 也保持绿）。

- [ ] **Step 5: Commit**

```bash
git add src/memory/rollingSummary.ts tests/rolling-summary.test.ts
git commit -m "feat(digest): 账本纯函数集 sliceBudget/isLineStructured/sanitizeLlmLines/切片 prompt"
```

---

### Task 3: updateSessionLedger 编排（mock LLM 全用例）

**Files:**
- Modify: `src/memory/rollingSummary.ts`（新增 `updateSessionLedger` + `LedgerUpdateResult`）
- Test: `tests/rolling-summary.test.ts`（追加编排 describe）

**Interfaces:**
- Consumes: Task 1 的 `renderDigestLines` / `trimOldestLines` / `DIGEST_MAX_CHARS`；Task 2 全部纯函数；`import type { TranscriptTurn } from './pure'`；`import type { LLMCall } from '@/llm'`
- Produces（Task 4 依赖）：

```ts
export interface LedgerUpdateResult {
  digest: string
  truncated: boolean                              // 仅「切片压缩产出超配额被按行裁剪」
  overshoot: { budget: number; actual: number } | null
}
export async function updateSessionLedger(
  priorLedger: string | null,
  newTurns: readonly TranscriptTurn[],
  callLLM: LLMCall,
): Promise<LedgerUpdateResult>
```

- [ ] **Step 1: 写失败测试（追加到 `tests/rolling-summary.test.ts` 末尾）**

import 行补 `updateSessionLedger` 与 `TranscriptTurn` 已有则跳过。追加工具函数与用例：

```ts
// 大切片 fixture：每 turn 渲染后 'USER: ' + 300 = 306 字；5 turn joined = 1534 ≥ 1200 -> LLM 路径。
const bigSlice = (): TranscriptTurn[] =>
  Array.from({ length: 5 }, (_, i) => t('user', `topic-${i} ` + 'x'.repeat(400)))

describe('updateSessionLedger 编排（mock LLM，spec §4.1）', () => {
  test('正常追加：prior 行式 + LLM 压缩新切片，结果 = 旧行 + 新行', async () => {
    let seen = ''
    const callLLM: LLMCall = async (_sys, user) => { seen = user; return '新事实1\n新事实2' }
    const out = await updateSessionLedger('USER: 旧事实', bigSlice(), callLLM)
    expect(out.digest).toBe('USER: 旧事实\n新事实1\n新事实2')
    expect(out.truncated).toBe(false)
    expect(out.overshoot).toBeNull()
  })
  test('衔接段：prior 有行时 prompt 含最后 ≤5 行 + 「不要重复」；prior=null 时不含', async () => {
    let seen = ''
    const callLLM: LLMCall = async (_sys, user) => { seen = user; return '事实' }
    await updateSessionLedger('USER: 旧事实', bigSlice(), callLLM)
    expect(seen).toContain('USER: 旧事实')
    expect(seen).toContain('不要重复')
    await updateSessionLedger(null, bigSlice(), callLLM)
    expect(seen).not.toContain('不要重复')
  })
  test('全局预算裁剪：追加后超 6000 -> 丢最旧行，truncated=false（设计内留存，spec §7 #3）', async () => {
    const prior = Array.from({ length: 30 }, (_, i) => `旧-${String(i).padStart(2, '0')} ` + 'p'.repeat(290)).join('\n')
    // 30 行 × 296 字 + 29 换行 = 8909 字；裁剪后 ≤6000
    const callLLM: LLMCall = async () => '新事实'
    const out = await updateSessionLedger(prior, bigSlice(), callLLM)
    expect(out.digest.length).toBeLessThanOrEqual(DIGEST_MAX_CHARS)
    expect(out.digest).toContain('新事实')
    expect(out.digest).not.toContain('旧-00')
    expect(out.truncated).toBe(false)
    expect(out.overshoot).toBeNull()
  })
  test('超配额：产出超 budget -> 按行裁掉最旧、保留最新，truncated=true + overshoot 数值', async () => {
    // rendered 1534 -> budget = ceil(1534/2) = 767
    const callLLM: LLMCall = async () =>
      Array.from({ length: 10 }, (_, i) => `fact-${i} ` + 'z'.repeat(190)).join('\n') // 10×197+9=1979 > 767
    const out = await updateSessionLedger(null, bigSlice(), callLLM)
    expect(out.truncated).toBe(true)
    expect(out.overshoot).toEqual({ budget: 767, actual: 1979 })
    expect(out.digest).toContain('fact-9')   // 最新保留
    expect(out.digest).not.toContain('fact-0') // 最旧被裁
    expect(out.digest.length).toBeLessThanOrEqual(767)
  })
  test('小切片直追：rendered < 1200 -> callLLM 零调用，rendered 行原样入账本', async () => {
    let called = 0
    const callLLM: LLMCall = async () => { called += 1; return '不该出现' }
    const out = await updateSessionLedger('USER: 旧', [t('user', '短内容')], callLLM)
    expect(called).toBe(0)
    expect(out.digest).toBe('USER: 旧\nUSER: 短内容')
    expect(out.truncated).toBe(false)
  })
  test('遗留 prose 重整：prompt 含 prose 全文 + 满额预算 6000，产出替换账本', async () => {
    const prose = '这是一段很长的段落体摘要。'.repeat(40) // 单行 >400 -> 判 prose
    let seenSys = ''
    let seenUser = ''
    const callLLM: LLMCall = async (sys, user) => { seenSys = sys; seenUser = user; return '整理1\n整理2' }
    const out = await updateSessionLedger(prose, bigSlice(), callLLM)
    expect(seenSys).toContain('6000')
    expect(seenUser).toContain('旧摘要（需一并整理）')
    expect(seenUser).toContain('这是一段很长的段落体摘要。')
    expect(out.digest).toBe('整理1\n整理2') // 替换，无 prose 残留
    expect(out.truncated).toBe(false)
  })
  test('重整路径产出超 6000 -> 按行裁剪 + overshoot', async () => {
    const prose = '长段落。'.repeat(100)
    const callLLM: LLMCall = async () =>
      Array.from({ length: 30 }, (_, i) => `行-${i} ` + 'q'.repeat(290)).join('\n') // 远超 6000
    const out = await updateSessionLedger(prose, bigSlice(), callLLM)
    expect(out.truncated).toBe(true)
    expect(out.overshoot!.budget).toBe(DIGEST_MAX_CHARS)
    expect(out.digest.length).toBeLessThanOrEqual(DIGEST_MAX_CHARS)
    expect(out.digest).toContain('行-29')
  })
  test('空/空白产出视为失败向外抛（调用方留旧账本）', async () => {
    const callLLM: LLMCall = async () => '   '
    await expect(updateSessionLedger(null, bigSlice(), callLLM)).rejects.toThrow()
  })
  test('LLM 抛错向外传播（catch 不得吞）', async () => {
    const callLLM: LLMCall = async () => { throw new Error('ark 502') }
    await expect(updateSessionLedger(null, bigSlice(), callLLM)).rejects.toThrow('ark 502')
  })
  test('无可渲染行（全 system）-> 不调 LLM，返回 prior 原值', async () => {
    let called = 0
    const callLLM: LLMCall = async () => { called += 1; return 'x' }
    const withPrior = await updateSessionLedger('USER: 旧', [t('system', 's')], callLLM)
    expect(called).toBe(0)
    expect(withPrior.digest).toBe('USER: 旧')
    const noPrior = await updateSessionLedger(null, [t('system', 's')], callLLM)
    expect(noPrior.digest).toBe('')
  })
  test('性质断言：任意非空 mock 产出，digest 恒 ≤ DIGEST_MAX_CHARS', async () => {
    const nasties = [
      'x'.repeat(20000),                                  // 巨长单行
      Array.from({ length: 100 }, (_, i) => `l${i} ${'y'.repeat(280)}`).join('\n'), // 海量行
      'a\n\n\nb',                                          // 稀疏
    ]
    for (const raw of nasties) {
      const callLLM: LLMCall = async () => raw
      const out = await updateSessionLedger('USER: 旧', bigSlice(), callLLM)
      expect(out.digest.length).toBeLessThanOrEqual(DIGEST_MAX_CHARS)
    }
  })
})
```

- [ ] **Step 2: 跑测试确认红**

Run: `bun test tests/rolling-summary.test.ts`
Expected: FAIL——`updateSessionLedger` 未定义。

- [ ] **Step 3: 实现（追加到 `src/memory/rollingSummary.ts` 末尾）**

import 区补齐：`import type { TranscriptTurn } from './pure'`、`import type { LLMCall } from '@/llm'`、`import { renderDigestLines, trimOldestLines } from './contextDigest'`（与既有 contextDigest import 合并）。

```ts
/** updateSessionLedger 返回形状（spec §5.2）。 */
export interface LedgerUpdateResult {
  digest: string
  /** 仅表示「切片压缩产出超配额被按行裁剪」；全局预算裁剪是设计内留存，不置位。 */
  truncated: boolean
  overshoot: { budget: number; actual: number } | null
}

const joinLen = (lines: readonly string[]): number => lines.join('\n').length

/**
 * 会话事实账本编排（spec §4.1，取代 mergeRollingSummary）：
 * - 无可渲染行 -> 原样返回，不调 LLM；
 * - rendered < DIRECT_APPEND_MAX_CHARS -> 直追，不调 LLM；
 * - prior 为遗留 prose（!isLineStructured）-> 一次性重整调用（满额预算），产出替换账本；
 * - 正常路径 -> LLM 按片压缩（配额 sliceBudget，prompt 附账本最后 ≤5 行衔接），
 *   产出超配额按行裁掉最旧（truncated + overshoot）；
 * - 追加后全局预算 DIGEST_MAX_CHARS 由 trimOldestLines 强制（设计内留存，不报 truncated）。
 * LLM 抛错 / 空产出向外抛（调用方留旧账本 + digest_llm_failed）。
 */
export async function updateSessionLedger(
  priorLedger: string | null,
  newTurns: readonly TranscriptTurn[],
  callLLM: LLMCall,
): Promise<LedgerUpdateResult> {
  const rendered = renderDigestLines(newTurns)
  if (rendered.length === 0) {
    return { digest: priorLedger ?? '', truncated: false, overshoot: null }
  }
  const renderedLen = joinLen(rendered)

  // 遗留 prose：一次性重整（spec §6），预算用满额。
  if (priorLedger !== null && !isLineStructured(priorLedger)) {
    const budget = DIGEST_MAX_CHARS
    const user = `旧摘要（需一并整理）：\n${priorLedger}\n\n新增会话内容：\n${rendered.join('\n')}\n\n请输出整理后的全部事实行。`
    const out = await callLLM(sliceDigestSystemPrompt(budget), user)
    const trimmed = (out ?? '').trim()
    if (!trimmed) throw new Error('ledger restructure: empty LLM output')
    let lines = sanitizeLlmLines(trimmed)
    const actual = joinLen(lines)
    let overshoot: LedgerUpdateResult['overshoot'] = null
    if (actual > budget) {
      lines = trimOldestLines(lines, budget)
      overshoot = { budget, actual }
    }
    return { digest: lines.join('\n'), truncated: overshoot !== null, overshoot }
  }

  const priorLines = priorLedger ? priorLedger.split('\n').filter((l) => l.length > 0) : []
  let newLines: string[]
  let overshoot: LedgerUpdateResult['overshoot'] = null

  if (renderedLen < DIRECT_APPEND_MAX_CHARS) {
    newLines = rendered
  } else {
    const budget = sliceBudget(renderedLen)
    const tail = priorLines.slice(-5)
    const contextSection = tail.length > 0
      ? `已有摘要结尾（仅供衔接参考，不要重复其中内容）：\n${tail.join('\n')}\n\n`
      : ''
    const user = `${contextSection}新增会话内容：\n${rendered.join('\n')}\n\n请输出事实行。`
    const out = await callLLM(sliceDigestSystemPrompt(budget), user)
    const trimmed = (out ?? '').trim()
    if (!trimmed) throw new Error('ledger slice digest: empty LLM output')
    newLines = sanitizeLlmLines(trimmed)
    const actual = joinLen(newLines)
    if (actual > budget) {
      newLines = trimOldestLines(newLines, budget)
      overshoot = { budget, actual }
    }
  }

  const digest = trimOldestLines([...priorLines, ...newLines], DIGEST_MAX_CHARS).join('\n')
  return { digest, truncated: overshoot !== null, overshoot }
}
```

- [ ] **Step 4: 跑测试确认绿**

Run: `bun test tests/rolling-summary.test.ts`
Expected: PASS（含 Task 2 用例与旧 describe）。

- [ ] **Step 5: typecheck + 全量**

Run: `bun run typecheck && bun test`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add src/memory/rollingSummary.ts tests/rolling-summary.test.ts
git commit -m "feat(digest): updateSessionLedger 编排——LLM 按片压缩 + 代码管留存"
```

---

### Task 4: scheduler 接线 + 删旧导出 + 既有测试对齐 + UI 标签

**Files:**
- Modify: `src/scheduler.ts:16`（import）、`src/scheduler.ts:444-459`（接线区）
- Modify: `src/memory/rollingSummary.ts`（删 `ROLLING_SUMMARY_SYSTEM_PROMPT` / `mergeRollingSummary`）
- Modify: `tests/rolling-summary.test.ts`（删旧 describe + 修 header 注释与 import）
- Modify: `tests/scheduler-distill-batching.test.ts:169-206`（滚动摘要接线组）
- Modify: `src/web/ui-utils.ts:78`、`tests/web-ui-utils.test.ts:26`
- Modify: `tests/e2e-distill-batching.test.ts:9`（注释更名）

**Interfaces:**
- Consumes: `updateSessionLedger` / `LedgerUpdateResult`（Task 3）、`logDegradation` / `upsertSessionDigest` / `getSessionDigest`（store 既有）

- [ ] **Step 1: 改 scheduler 接线**

`src/scheduler.ts:16` import 改为：

```ts
import { updateSessionLedger } from '@/memory/rollingSummary'
```

`src/scheduler.ts:15` 的 contextDigest import 去掉 `DIGEST_MAX_CHARS`（detail 不再引用它）：

```ts
import { buildDeterministicDigest } from '@/memory/contextDigest'
```

`src/scheduler.ts:444-459` 区域整段替换为：

```ts
      // 滚动账本维护（spec 2026-08-11-digest-ledger-redesign §4.1）：distill 成功（未抛错）+
      // 质量模式 + 会话 job（非 subagent）才把本次切片并入会话事实账本。LLM/写库失败只降级
      // 落表（digest_llm_failed），不影响 job 已 done 的事实。切片压缩超配额由代码按行裁剪并
      // 落 digest_truncated；全局预算由 trimOldestLines 丢最旧整行强制，属设计内留存，不记降级。
      if (!callThrew && judgeCfg.mode === 'quality' && job.sessionId && !job.sourceAgentId) {
        try {
          const prior = await getSessionDigest(db, job.sessionId)
          const { digest: merged, truncated, overshoot } = await updateSessionLedger(prior?.digest ?? null, newTurns, deps.callLLM)
          if (merged !== (prior?.digest ?? '')) {
            await upsertSessionDigest(db, job.sessionId, merged, 'llm')
          }
          if (truncated && overshoot) {
            await logDegradation(db, { kind: 'digest_truncated', detail: `切片压缩产出 ${overshoot.actual} 字超配额 ${overshoot.budget} 字，按行裁剪保留最新`, distillJobId: job.id, sessionId: job.sessionId })
          }
        } catch (e) {
          await logDegradation(db, { kind: 'digest_llm_failed', detail: String(e), distillJobId: job.id, sessionId: job.sessionId })
        }
      }
```

- [ ] **Step 2: 删 rollingSummary.ts 旧导出**

删除 `ROLLING_SUMMARY_SYSTEM_PROMPT` 常量与 `mergeRollingSummary` 函数（连同各自注释块）。文件头注释改为：

```ts
// src/memory/rollingSummary.ts
// 会话事实账本（spec 2026-08-11-digest-ledger-redesign）：LLM 只做按片压缩（配额 2:1），
// 追加与全局预算留存（丢最旧、保最近）由代码强制。旧「全量旧摘要+新切片整体重压缩」
// （mergeRollingSummary）已删除：压缩比随会话长度单调上升、超预算连环降级、摘要重压缩渐糊。
```

- [ ] **Step 3: 清理 tests/rolling-summary.test.ts**

删除两个旧 describe：`mergeRollingSummary（mock LLM）` 与 `ROLLING_SUMMARY_SYSTEM_PROMPT 中立性（...）`。import 行去掉 `ROLLING_SUMMARY_SYSTEM_PROMPT, mergeRollingSummary`。文件头注释改为：

```ts
// tests/rolling-summary.test.ts
// 会话事实账本回归锁（spec 2026-08-11-digest-ledger-redesign §9）：纯函数集
// （sliceBudget/isLineStructured/sanitizeLlmLines/prompt 中立性）+ updateSessionLedger
// 编排（直追/压缩/超配额裁剪/全局留存/prose 重整/失败路径/性质断言）。
```

- [ ] **Step 4: 对齐 scheduler-distill-batching.test.ts 滚动摘要接线组**

`tests/scheduler-distill-batching.test.ts:11` import 追加 `upsertSessionDigest`：

```ts
import { createCandidate, markFlush, upsertSessionEvent, getSessionDigest, setSessionOffset, upsertSessionDigest } from '@/memory/store'
```

`:169-206` 的 `describe('滚动摘要接线（质量模式，spec §4.7）', ...)` 整组替换为：

```ts
describe('滚动账本接线（质量模式，spec 2026-08-11-digest-ledger-redesign §4.1/§5.4）', () => {
  // 大切片 fixture：5 长 turn -> 渲染后 1534 字 ≥ 1200 -> 走 LLM 压缩路径。
  const longTurns = () => Array.from({ length: 5 }, (_, i) => ({ role: 'user' as const, content: `topic-${i} ` + 'x'.repeat(400) }))

  test('distill 成功后小切片直追入账本（免 digest LLM 调用）', async () => {
    let n = 0
    const spyLLM: LLMCall = async () => { n += 1; return JSON.stringify({ candidates: [] }) }
    await db.insert(memoryDistillJobs).values({
      id: 'j1', debounceKey: 'k', sourceEventId: 'e', runtime: 'claude-code', cwd: '/proj',
      sessionId: 's1', status: 'pending', attempts: 0, nextRunAt: 0, createdAt: 1, finishedAt: null,
    })
    const deps = tickDeps(spyLLM)
    deps.loadJudgeConfig = () => QUALITY
    deps.loadTranscript = async () => ({ turns: [{ role: 'user', content: '新内容' }], fullLength: 1, prefixTurns: [] })
    await tick(db, deps)
    expect(n).toBe(1) // 仅 distill；小切片直追不调 digest LLM
    expect((await getSessionDigest(db, 's1'))?.digest).toBe('USER: 新内容')
  })

  test('大切片走 LLM 压缩；产出超配额 -> 按行裁剪 + digest_truncated 落表（含配额/实际）', async () => {
    const dualLLM: LLMCall = async (sys) => {
      if (sys.includes('compressor')) {
        return Array.from({ length: 10 }, (_, i) => `fact-${i} ` + 'z'.repeat(190)).join('\n') // 1979 > budget 767
      }
      return JSON.stringify({ candidates: [] })
    }
    await db.insert(memoryDistillJobs).values({
      id: 'j1', debounceKey: 'k', sourceEventId: 'e', runtime: 'claude-code', cwd: '/proj',
      sessionId: 's1', status: 'pending', attempts: 0, nextRunAt: 0, createdAt: 1, finishedAt: null,
    })
    const deps = tickDeps(dualLLM)
    deps.loadJudgeConfig = () => QUALITY
    deps.loadTranscript = async () => ({ turns: longTurns(), fullLength: 5, prefixTurns: [] })
    await tick(db, deps)
    const degs = await db.query.memoryDegradations.findMany()
    const tr = degs.find((d) => d.kind === 'digest_truncated')
    expect(tr).toBeDefined()
    expect(tr!.detail).toContain('超配额 767')
    expect(tr!.detail).toContain('1979')
    const dig = await getSessionDigest(db, 's1')
    expect(dig!.digest).toContain('fact-9')      // 最新保留
    expect(dig!.digest).not.toContain('fact-0')  // 最旧被裁
  })

  test('账本追加后超全局预算 -> 丢最旧行达标，不记 digest_truncated（设计内留存）', async () => {
    // 20 行 × 299 字 + 19 换行 = 5999 字，行式（每行 ≤400）；追加分片后超 6000。
    const prior = Array.from({ length: 20 }, (_, i) => `old-${String(i).padStart(2, '0')} ` + 'p'.repeat(292)).join('\n')
    await upsertSessionDigest(db, 's1', prior, 'llm')
    let digestLLMCalled = false
    const spyLLM: LLMCall = async (sys) => {
      if (sys.includes('compressor')) digestLLMCalled = true
      return JSON.stringify({ candidates: [] })
    }
    await db.insert(memoryDistillJobs).values({
      id: 'j1', debounceKey: 'k', sourceEventId: 'e', runtime: 'claude-code', cwd: '/proj',
      sessionId: 's1', status: 'pending', attempts: 0, nextRunAt: 0, createdAt: 1, finishedAt: null,
    })
    const deps = tickDeps(spyLLM)
    deps.loadJudgeConfig = () => QUALITY
    deps.loadTranscript = async () => ({ turns: [{ role: 'user', content: '新增' }], fullLength: 1, prefixTurns: [] })
    await tick(db, deps)
    expect(digestLLMCalled).toBe(false) // 小切片直追
    const dig = await getSessionDigest(db, 's1')
    expect(dig!.digest.length).toBeLessThanOrEqual(6000)
    expect(dig!.digest).toContain('USER: 新增')
    expect(dig!.digest).not.toContain('old-00') // 最旧整行丢弃
    const degs = await db.query.memoryDegradations.findMany()
    expect(degs.some((d) => d.kind === 'digest_truncated')).toBe(false)
  })

  test('digest LLM 抛错 -> digest_llm_failed 落表 + job 仍 done', async () => {
    // 判别 digest 调用：sliceDigestSystemPrompt 含 'compressor'，distill 系统 prompt 不含。
    // 必须用大切片：小切片直追不调 digest LLM，抛错路径不可达。
    const failLLM: LLMCall = async (sys) => {
      if (sys.includes('compressor')) throw new Error('ark 502')
      return JSON.stringify({ candidates: [] })
    }
    await db.insert(memoryDistillJobs).values({
      id: 'j1', debounceKey: 'k', sourceEventId: 'e', runtime: 'claude-code', cwd: '/proj',
      sessionId: 's1', status: 'pending', attempts: 0, nextRunAt: 0, createdAt: 1, finishedAt: null,
    })
    const deps = tickDeps(failLLM)
    deps.loadJudgeConfig = () => QUALITY
    deps.loadTranscript = async () => ({ turns: longTurns(), fullLength: 5, prefixTurns: [] })
    await tick(db, deps)
    const [j] = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, 'j1'))
    expect(j!.status).toBe('done')
    const degs = await db.query.memoryDegradations.findMany()
    expect(degs.some((d) => d.kind === 'digest_llm_failed')).toBe(true)
  })
})
```

注意：`:236` 起的 `digest_read_failed` 用例不动——其依赖的「维护阶段 getSessionDigest 抛错 → catch → digest_llm_failed 共现」在新接线下语义不变（getSessionDigest 仍在 try 块第一行）。

- [ ] **Step 5: UI 标签 + e2e 注释**

`src/web/ui-utils.ts:78`：

```ts
    digest_truncated: '摘要压缩超限',
```

`tests/web-ui-utils.test.ts:26`：

```ts
    expect(degradationKindLabel('digest_truncated')).toBe('摘要压缩超限')
```

`tests/e2e-distill-batching.test.ts:9` 注释中 `mergeRollingSummary` 更名为 `updateSessionLedger`（仅注释，两处：行 9 与行 36 附近「钉经济模式」注释若提及亦同步）。

- [ ] **Step 6: 全量验证**

Run: `bun run typecheck && bun test`
Expected: PASS。重点确认：`tests/degradation-coverage.test.ts` 绿（`'digest_truncated'` 仍在 scheduler.ts 生产点）；`tests/e2e-distill-batching.test.ts` 绿（经济模式不受影响）。

- [ ] **Step 7: Commit**

```bash
git add src/scheduler.ts src/memory/rollingSummary.ts src/web/ui-utils.ts tests/rolling-summary.test.ts tests/scheduler-distill-batching.test.ts tests/web-ui-utils.test.ts tests/e2e-distill-batching.test.ts
git commit -m "feat(digest): scheduler 接账本编排，删旧重压缩路径，降级语义收窄为切片超配额"
```

---

### Task 5: STATE.md 落档 + 终验

**Files:**
- Modify: `STATE.md`（文件顶部追加新节，遵循既有格式：标题含日期、编号要点、上线后观测清单）

**Interfaces:**
- Consumes: 全部前序任务已绿

- [ ] **Step 1: 写 STATE.md 新节（追加到文件顶部既有最新节之前，对齐现存排序）**

内容要点（照实写，数字与本文档一致）：

```markdown
## 滚动摘要职责反转：会话事实账本（2026-08-11）

实测 4/4 `digest_truncated` 连环降级（单 session）+ 复现证明超预算是系统性偏差
（11840 字输入 -> 3834 字产出，128% of budget，stop_reason=end_turn）。根治：
LLM 只做按片压缩（配额 = 渲染长度/2，钳制 [600, 3000]），全局预算 6000 与留存
（丢最旧、保最近，trimOldestLines 两模式共用）收归代码。spec / plan 见
`docs/superpowers/specs|plans/2026-08-11-digest-ledger-redesign*`。

1. `DIGEST_MAX_CHARS` 3000 -> 6000（用户确认；蒸馏 prompt 背景节占比增量 ~5%）。
2. `contextDigest.ts` 抽出 `renderDigestLines` / `trimOldestLines`；
   `buildDeterministicDigest` 重组，逐字节不变（既有测试为回归锁）。
3. `rollingSummary.ts` 重写为 `updateSessionLedger`：小切片（渲染 <1200 字）直追
   免 LLM；大切片 LLM 压缩（prompt 附账本最后 ≤5 行衔接）；产出超配额按行裁最旧
   + `digest_truncated`（detail 含 actual/budget 数值）；追加后全局裁剪不记降级。
4. 遗留 prose 摘要 `isLineStructured` 探测，首次合并一次性重整（满额预算），无迁移脚本。
5. 删除 `mergeRollingSummary` / `ROLLING_SUMMARY_SYSTEM_PROMPT`；UI 标签改「摘要压缩超限」。
6. `bun run typecheck && bun test` N/N 全绿（填实际数）。

### 上线后观测（硬要求，结论回填本节）

- `digest_truncated` 24h 计数（预期近零；仍高频 -> sliceBudget 比例偏紧，纯函数一行可调）；
- 账本长度分布（length(digest) 贴 6000 频率，评估预算再调）；
- 跨片指代质量：候选与既有记忆重复率是否因「只看切片 + 尾 5 行衔接」上升；
- 对照 2026-08-09 观测清单的 degradations kind 分布变化。
```

- [ ] **Step 2: 终验门槛**

Run: `bun run typecheck && bun test`
Expected: 全绿。把实际通过数回填到 STATE.md 第 6 条。

- [ ] **Step 3: Commit**

```bash
git add STATE.md
git commit -m "docs(state): 滚动摘要职责反转落档（全绿基线 + 观测清单）"
```

- [ ] **Step 4: push 分支（PR 由调度方在 whole-branch review 后统一创建）**

```bash
git push -c http.sslBackend=openssl -u origin feat/digest-ledger-redesign
```

---

## Self-Review 记录（计划作者自查）

1. **Spec 覆盖**：§5.1→Task 1；§5.2→Task 2/3；§5.3→Task 2；§5.4→Task 4；§5.5→Task 4；§6→Task 3（重整分支+用例）；§7 失败矩阵→Task 3/4 用例逐条对应（#1 不可发生由性质断言覆盖、#2→超配额用例、#3→全局裁剪用例、#4/#5→抛错用例、#7→重整超限用例、#8→无可渲染行用例）；§8 耦合文件→Task 1-4 全覆盖；§9 测试策略 18 条→Task 1（4）、Task 2（1,3,5,6,16,17）、Task 3（2 部分,7-15）、Task 4（18）；§10 观测→Task 5。无缺口。
2. **占位符扫描**：无 TBD/TODO；所有代码步骤含完整代码。
3. **类型一致性**：`LedgerUpdateResult`（Task 3 定义）与 Task 4 scheduler 解构一致；`sliceBudget`/`isLineStructured`/`sanitizeLlmLines`/`sliceDigestSystemPrompt`/`DIRECT_APPEND_MAX_CHARS`/`SLICE_BUDGET_MIN` 跨任务签名一致；`trimOldestLines` 返回 `string[]`、调用方 `.join('\n')` 与 spec §5.1 一致。

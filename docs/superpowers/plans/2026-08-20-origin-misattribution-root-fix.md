# Origin 误标根治：捕获层来源归因（Implementation Plan）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 捕获层恢复 claude/opencode transcript 的说话人归因（真人 vs 机器注入），让 `origin=user-stated` 只能锚定真人陈述，根治 loop 重放 prompt 被误标 user-stated 后被双重保护永久锁死的事故。

**Architecture:** 三层根治——(1) 捕获层把非人类 user 行重标 `role:"system"`（复用既有空槽，下游 turnPriority/renderUserPrompt/detectErrorSignals 天然接住）；(2) 蒸馏器 prompt 加硬规则绑定 `[user]`/`[system]` 标签与 origin；(3) `parseDistillCandidates` 加「无真人行强制降级」代码兜底。

**Tech Stack:** Bun + bun:test；零新依赖；零 schema 迁移。

**Spec:** `docs/superpowers/specs/2026-08-20-origin-misattribution-root-fix-design.md`

## Global Constraints

- 测试一律 `bun test` 运行（严禁 npm test）；`bun run typecheck && bun test` 必须全绿才能 commit/push，该命令链在 Bash 工具执行（PowerShell 5.1 不支持 `&&`）。
- 解析器 / 纯函数永不抛契约：任何畸形输入降级不崩。
- 无 DB 回填：只修前向，不碰存量 memories 行。
- `valueFilter.ts` 零改动。
- marker 字面量逐字：`--- BEGIN INJECTED MEMORY ---`。
- D1：无来源字段的 user 字符串行保守判 `system`。D2：来源判定用 OR（`origin.kind === "human"` **或** `promptSource === "typed"` 才判 user）。
- 所有 commit 在 worktree 分支 `worktree-fix-origin-misattribution` 上，禁止直推 master。

---

### Task 1: `isInjectedMemoryBlock` 纯函数 + marker 常量

**Files:**
- Modify: `src/memory/pure.ts`（`formatMemoryBlock` 附近，紧邻既有 marker 使用处）
- Test: `tests/pure-injected-marker.test.ts`（新建）

**Interfaces:**
- Produces: `INJECTED_MEMORY_MARKER: string`（导出常量）、`isInjectedMemoryBlock(content: unknown): boolean`（永不抛，非 string 入参 false）。后续 Task 3/4 消费。

- [ ] **Step 1: Write the failing test**

```ts
// tests/pure-injected-marker.test.ts
import { test, expect } from 'bun:test'
import { isInjectedMemoryBlock, INJECTED_MEMORY_MARKER, formatMemoryBlock } from '@/memory/pure'

/**
 * 注入记忆块 marker 识别（spec 2026-08-20 §3.3）。
 * 背景：SessionStart 注入的记忆块泄进 transcript 当 user 行（实测 200 文件 15 中），
 * 且这些行无任何官方来源字段——marker 是唯一可识别信号（claude+opencode 共用）。
 * marker 漂移（formatMemoryBlock 改格式）必须让本文件变红，强制同步。
 */

test('INJECTED_MEMORY_MARKER 字面量锁定（漂移即红）', () => {
  expect(INJECTED_MEMORY_MARKER).toBe('--- BEGIN INJECTED MEMORY ---')
})

test('formatMemoryBlock 产出含 marker（marker 漂移守卫）', () => {
  const row = {
    id: 'm1', scopeType: 'global' as const, scopeId: null, runtime: 'claude-code' as const,
    title: '[category:invariant] x', bodyMd: 'y', createdAt: 0, version: 1, tags: [],
  }
  const block = formatMemoryBlock({ byScope: { project: [], global: [row] } })
  expect(block).toContain(INJECTED_MEMORY_MARKER)
})

test('含 BEGIN marker → true', () => {
  expect(isInjectedMemoryBlock('## Learned context (auto-injected, advisory)\n\n--- BEGIN INJECTED MEMORY ---')).toBe(true)
})

test('完整注入块 → true', () => {
  expect(isInjectedMemoryBlock('--- BEGIN INJECTED MEMORY ---\n- [x] some memory\n--- END INJECTED MEMORY ---')).toBe(true)
})

test('普通用户文本 → false', () => {
  expect(isInjectedMemoryBlock('we only issue refunds within 14 days')).toBe(false)
})

test('loop 注解 / task 通知 → false', () => {
  expect(isInjectedMemoryBlock('[1 prior /loop wakeup found nothing actionable; loop is healthy.]')).toBe(false)
  expect(isInjectedMemoryBlock('<task-notification><task-id>a</task-id></task-notification>')).toBe(false)
})

test('非 string 入参 → false（永不抛）', () => {
  expect(isInjectedMemoryBlock(null)).toBe(false)
  expect(isInjectedMemoryBlock(undefined)).toBe(false)
  expect(isInjectedMemoryBlock(123)).toBe(false)
  expect(isInjectedMemoryBlock({})).toBe(false)
})
```

注意：`formatMemoryBlock` 入参是 `InjectableMemorySet`（`{ byScope: { project, global } }`，行形状 `InjectableMemoryRow`——`id/scopeType/scopeId/runtime/title/bodyMd/createdAt/version/tags`）。上述 fixture 已按实际签名写好；若实现期签名有出入，按 `src/memory/pure.ts:4-20` 实际形状修正，断言意图不变：产出块含 marker。

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/pure-injected-marker.test.ts`
Expected: FAIL（`isInjectedMemoryBlock` / `INJECTED_MEMORY_MARKER` 未导出）

- [ ] **Step 3: Write minimal implementation**

在 `src/memory/pure.ts` 的 `formatMemoryBlock` 函数附近（紧邻 `'--- BEGIN INJECTED MEMORY ---'` 字面量使用处，`pure.ts:102` 一带）加：

```ts
/** 注入记忆块起始 marker（spec 2026-08-20 §3.3）。与 formatMemoryBlock 的围栏逐字一致。 */
export const INJECTED_MEMORY_MARKER = '--- BEGIN INJECTED MEMORY ---'

/**
 * 判定 content 是否是（或含）memside 注入的记忆块（spec 2026-08-20 §3.3）。
 * claude transcript 里注入块无官方来源字段，marker 是唯一识别信号；
 * opencode 无任何来源字段，marker 是唯一识别信号。永不抛：非 string 一律 false。
 */
export function isInjectedMemoryBlock(content: unknown): boolean {
  try {
    return typeof content === 'string' && content.includes(INJECTED_MEMORY_MARKER)
  } catch {
    return false
  }
}
```

同时把 `formatMemoryBlock` 内的 `'--- BEGIN INJECTED MEMORY ---'` 字面量（`pure.ts:102` 与 `:105` 的 END 行保留字面量或一并抽常量）替换为 `INJECTED_MEMORY_MARKER` 引用，保证单一事实来源（产出与检测不漂移）。END marker 若不抽常量，保持字面量并留一行注释指向 `INJECTED_MEMORY_MARKER`。

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/pure-injected-marker.test.ts`
Expected: PASS（全部用例）

- [ ] **Step 5: Run full suite（formatMemoryBlock 字面量替换可能牵动既有字节锁测试）**

Run: `bun test`
Expected: 全绿。若 `pure-inject.test.ts` 等既有测试因替换字面量变红，检查是替换引入了行为差（不该有——常量与字面量逐字相等）还是测试锁了别的，修实现不修测试意图。

- [ ] **Step 6: Commit**

```bash
git add src/memory/pure.ts tests/pure-injected-marker.test.ts
git commit -m "feat(capture): isInjectedMemoryBlock 纯函数 + marker 单一事实来源"
```

---

### Task 2: `stripNoiseTurns` 放宽到 system role

**Files:**
- Modify: `src/memory/pure.ts`（`stripNoiseTurns`，`:302-316`）
- Test: `tests/pure-noise-filter.test.ts`（追加用例）

**Interfaces:**
- Consumes: Task 1 无依赖（本任务不涉及 marker）。
- Produces: `stripNoiseTurns` 行为变更——user 与 **system** role 的 task-notification / compact 噪声都剔除；assistant/thinking/tool 不动。签名不变。

- [ ] **Step 1: Write the failing test**

在 `tests/pure-noise-filter.test.ts` 末尾追加（复用文件顶部的 `TASK_NOTIFICATION` / `COMPACT` 常量）：

```ts
// ---------------------------------------------------------------------------
// system role 噪声剔除（spec 2026-08-20 §7.2）：捕获层把非人类 user 行重标
// role:"system"（loop 重放 / 注入记忆 / task 通知 / peer / 无字段行）后，
// task-notification / compact 噪声以 system 身份抵达，stripNoiseTurns 的
// role 判断须放宽到 system，否则噪声从新通道漏回蒸馏输入。
// 非噪声 system 内容（loop 重放 prompt 本体）保留——供 agent-observed 观察。
// ---------------------------------------------------------------------------

test('stripNoiseTurns: 剔除 system role 的 task-notification 块', () => {
  const turns: TranscriptTurn[] = [
    { role: 'system', content: TASK_NOTIFICATION },
    { role: 'system', content: '检查 Task 5 implementer 是否完成' },
  ]
  const out = stripNoiseTurns(turns)
  expect(out.length).toBe(1)
  expect(out[0]!.role).toBe('system')
  expect(out[0]!.content).toBe('检查 Task 5 implementer 是否完成')
})

test('stripNoiseTurns: 剔除 system role 的 compact 续接块', () => {
  const turns: TranscriptTurn[] = [
    { role: 'system', content: COMPACT },
    { role: 'user', content: 'normal' },
  ]
  const out = stripNoiseTurns(turns)
  expect(out.length).toBe(1)
  expect(out[0]!.content).toBe('normal')
})

test('stripNoiseTurns: 非噪声 system 内容保留（供 agent-observed）', () => {
  const turns: TranscriptTurn[] = [
    { role: 'system', content: '[1 prior /loop wakeup found nothing actionable; loop is healthy.]' },
  ]
  const out = stripNoiseTurns(turns)
  expect(out.length).toBe(1)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/pure-noise-filter.test.ts`
Expected: 新增用例 FAIL（现状 `t.role !== 'user'` 早返回，system 噪声保留）

- [ ] **Step 3: Write minimal implementation**

`stripNoiseTurns` 的 filter 回调改一行判断（`pure.ts:306`）：

```ts
return turns.filter((t) => {
  if (t.role !== 'user' && t.role !== 'system') return true
  // ...其余不动（marker 判断 / compact 前缀判断逐字保留）
})
```

同步更新 `stripNoiseTurns` 的 docstring：把「只识别 user role」改为「识别 user 与 system role（system 为 2026-08-20 捕获层重标引入的新通道）」。

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/pure-noise-filter.test.ts`
Expected: PASS（新旧用例全绿）

- [ ] **Step 5: Commit**

```bash
git add src/memory/pure.ts tests/pure-noise-filter.test.ts
git commit -m "feat(filter): stripNoiseTurns 放宽到 system role 噪声（新通道防漏）"
```

---

### Task 3: claude 捕获层来源判定（核心）

**Files:**
- Modify: `src/claude/transcript.ts`（`parseTranscriptFile` 的 user 字符串分支，`:117-122`；docstring `:53-80`）
- Test: `tests/transcript.test.ts`（追加用例 + 更新受行为变更影响的既有 fixture）

**Interfaces:**
- Consumes: Task 1 的 `isInjectedMemoryBlock`（`import { isInjectedMemoryBlock } from '@/memory/pure'`）。
- Produces: `parseTranscriptFile` 行为——user 字符串行按来源判 role（见下）；`TranscriptTurn.role` 产出 `system`。后续 Task 4/6 依赖此语义。

- [ ] **Step 1: Write the failing test**

在 `tests/transcript.test.ts` 追加（复用文件顶部 `writeJsonl` helper）：

```ts
// ---------------------------------------------------------------------------
// 来源归因（spec 2026-08-20 §3.2，D1/D2）：claude transcript 的 user 行带
// 来源字段（origin.kind / promptSource / isMeta，实测 2.1.235 taxonomy：
// 真人 = origin.kind=human + promptSource=typed；loop 重放 = promptSource=system
// + isMeta；task 通知 = origin.kind=task-notification；注入记忆块 = 无字段）。
// 捕获层此前全部映 role:"user"，导致 loop 重放 prompt 被蒸馏器误标
// user-stated 后被双重保护锁死（事故候选 01M0EMPV13JY139C35XJDD8JYP）。
// ---------------------------------------------------------------------------

test('真人行（origin.kind=human + promptSource=typed）→ role:"user"', () => {
  const p = writeJsonl({
    type: 'user',
    origin: { kind: 'human' },
    promptSource: 'typed',
    message: { role: 'user', content: 'we only issue refunds within 14 days' },
  })
  const turns = parseTranscriptFile(p)
  expect(turns).toEqual([{ role: 'user', content: 'we only issue refunds within 14 days' }])
})

test('D2 OR 路径：仅 origin.kind=human（promptSource 缺席）→ role:"user"', () => {
  const p = writeJsonl({
    type: 'user',
    origin: { kind: 'human' },
    message: { role: 'user', content: 'human words' },
  })
  expect(parseTranscriptFile(p)[0]!.role).toBe('user')
})

test('D2 OR 路径：仅 promptSource=typed（origin 缺席）→ role:"user"', () => {
  const p = writeJsonl({
    type: 'user',
    promptSource: 'typed',
    message: { role: 'user', content: 'human words' },
  })
  expect(parseTranscriptFile(p)[0]!.role).toBe('user')
})

test('loop 重放 prompt（promptSource=system + isMeta）→ role:"system"', () => {
  const p = writeJsonl({
    type: 'user',
    promptSource: 'system',
    isMeta: true,
    message: { role: 'user', content: '检查 Task 5 implementer (a11a0f3be1ceeb11c) 是否完成。若完成则处理 report（DONE→生成 review package 派 task reviewer）' },
  })
  const turns = parseTranscriptFile(p)
  expect(turns).toEqual([{ role: 'system', content: '检查 Task 5 implementer (a11a0f3be1ceeb11c) 是否完成。若完成则处理 report（DONE→生成 review package 派 task reviewer）' }])
})

test('loop 注解（isMeta、无 origin）→ role:"system"', () => {
  const p = writeJsonl({
    type: 'user',
    isMeta: true,
    message: { role: 'user', content: '[1 prior /loop wakeup found nothing actionable; loop is healthy.]' },
  })
  expect(parseTranscriptFile(p)[0]!.role).toBe('system')
})

test('task-notification 行（origin.kind=task-notification）→ role:"system"', () => {
  const p = writeJsonl({
    type: 'user',
    origin: { kind: 'task-notification' },
    promptSource: 'system',
    message: { role: 'user', content: '<task-notification><task-id>a</task-id></task-notification>' },
  })
  expect(parseTranscriptFile(p)[0]!.role).toBe('system')
})

test('peer 行（origin.kind=peer）→ role:"system"', () => {
  const p = writeJsonl({
    type: 'user',
    origin: { kind: 'peer', from: 'general-purpose' },
    promptSource: 'system',
    isMeta: true,
    message: { role: 'user', content: '正在修测试红，快好了。' },
  })
  expect(parseTranscriptFile(p)[0]!.role).toBe('system')
})

test('注入记忆块（无字段、content 含 marker）→ role:"system"', () => {
  const p = writeJsonl({
    type: 'user',
    message: { role: 'user', content: '## Learned context (auto-injected, advisory)\n\n--- BEGIN INJECTED MEMORY ---\n- [x] old memory\n--- END INJECTED MEMORY ---' },
  })
  expect(parseTranscriptFile(p)[0]!.role).toBe('system')
})

test('D1 保守：无任何来源字段的纯文本 → role:"system"', () => {
  const p = writeJsonl({
    type: 'user',
    message: { role: 'user', content: 'some untagged text' },
  })
  expect(parseTranscriptFile(p)[0]!.role).toBe('system')
})

test('来源判定永不抛：origin 为畸形值（string）时降级 system', () => {
  const p = writeJsonl({
    type: 'user',
    origin: 'garbage-not-an-object',
    message: { role: 'user', content: 'text' },
  })
  expect(parseTranscriptFile(p)[0]!.role).toBe('system')
})
```

同时更新受行为变更影响的既有测试（它们的 fixture 无来源字段，旧行为期待 `role:"user"`，按 D1 现在是 `role:"system"`）。**测试意图是「解析器映射形状」，不是「来源判定」，因此给 fixture 补真 人字段使其继续验证原意图**：

- `tests/transcript.test.ts:44`（`user string prompt -> {role:"user"}`）：fixture 加 `origin: { kind: 'human' }, promptSource: 'typed'`。
- 同文件内其余以无字段 user 字符串行构造、并断言 `role:"user"` 的用例（`:131`（JSONL malformed 行混排）、`:146`（顺序保留）、`:162`（CRLF）等，逐一核对）：fixture 同样加 `origin: { kind: 'human' }, promptSource: 'typed'`，期望不变。
- 只断言 `role:"tool"` / `role:"assistant"` / `role:"thinking"` 的用例零改动。

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/transcript.test.ts`
Expected: 新增来源判定用例 FAIL（现状全映 user）；被更新的既有用例若先跑会 PASS（fixture 已带 human 字段）

- [ ] **Step 3: Write minimal implementation**

`src/claude/transcript.ts`：

新增模块级判定函数（置于 `parseTranscriptFile` 上方）：

```ts
/**
 * user 行来源判定（spec 2026-08-20 §3.2，D1/D2）。claude transcript 的 user 行
 * 带来源字段（实测 2.1.235）：真人 = origin.kind=human / promptSource=typed（D2 OR）；
 * loop 重放 = promptSource=system + isMeta；task 通知 = origin.kind=task-notification；
 * 注入记忆块 = 无字段（靠 INJECTED_MEMORY_MARKER 内容识别）。无任何字段的行
 * 保守判 system（D1：误降级可丢优于误升级锁死）。永不抛：畸形 origin 降级 system。
 */
function userRowRole(row: Record<string, unknown>, content: string): 'user' | 'system' {
  try {
    if (isInjectedMemoryBlock(content)) return 'system'
    const origin = row.origin
    if (origin && typeof origin === 'object' && !Array.isArray(origin)) {
      if ((origin as { kind?: unknown }).kind === 'human') return 'user'
    }
    if (row.promptSource === 'typed') return 'user'
    return 'system'
  } catch {
    return 'system'
  }
}
```

`parseTranscriptFile` 的 user 字符串分支（`:121-122`，实际代码里行对象已收窄为 `const r = row as { type?: unknown; message?: unknown }`）改：

```ts
if (typeof content === 'string') {
  // 来源判定（spec 2026-08-20 §3.2）：传原始未收窄的 row 才能读 origin/promptSource。
  turns.push({ role: userRowRole(row as Record<string, unknown>, content), content })
}
```

（`userRowRole` 收 `row`（原始 `unknown` 行对象 cast 成 `Record<string, unknown>`），不收收窄后的 `r`——`r` 的类型没有 origin/promptSource 字段。`isInjectedMemoryBlock` 从 `@/memory/pure` import，与既有 `captureToolCall` import 合并。）

同步更新 `parseTranscriptFile` 的 docstring：在 Row mapping 的 `type:"user"` 条目补一句「content 为字符串的行按来源字段判 role：真人（origin.kind=human / promptSource=typed）→ user，其余（loop 重放 / 注入记忆块 / task 通知 / peer / 无字段）→ system（spec 2026-08-20）」。

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/transcript.test.ts`
Expected: PASS（新增 + 更新后的既有用例全绿）

- [ ] **Step 5: Run full suite（捕获层行为变更可能牵动 e2e / scheduler fixture）**

Run: `bun test`
Expected: 全绿。若有测试因 fixture 无字段 user 行现在产出 `role:"system"` 变红：该类测试意图若是「真人输入」则 fixture 补 human 字段；若断言的就是旧扁平行为，按 D1 新语义修正期望并留注释。

- [ ] **Step 6: Commit**

```bash
git add src/claude/transcript.ts tests/transcript.test.ts
git commit -m "feat(capture): claude 捕获层来源归因——真人 user 行与机器注入行分离（D1/D2）"
```

---

### Task 4: opencode 捕获层注入块判定

**Files:**
- Modify: `src/opencode/transcript.ts`（`parseOpencodeMessages` 的 text part 分支，`:44-46`）
- Test: `tests/opencode-transcript.test.ts`（追加用例）

**Interfaces:**
- Consumes: Task 1 的 `isInjectedMemoryBlock`。
- Produces: `parseOpencodeMessages` 行为——user 角色 text part 含注入块 marker → `role:"system"`；其余 user text part 不变（`role:"user"`）。

- [ ] **Step 1: Write the failing test**

在 `tests/opencode-transcript.test.ts` 追加：

```ts
// ---------------------------------------------------------------------------
// 注入记忆块判定（spec 2026-08-20 §3.4）：opencode 无官方来源字段，marker
// 是唯一识别信号。messages.transform 注入的记忆块泄进 user message 若仍标
// role:"user"，蒸馏器会把已注入旧记忆当真人新规则重复提炼（自我复读）。
// ---------------------------------------------------------------------------

test('user text part 含注入记忆块 marker → role:"system"', () => {
  const messages = [
    {
      info: { role: 'user' as const },
      parts: [{ type: 'text', text: '## Learned context (auto-injected, advisory)\n\n--- BEGIN INJECTED MEMORY ---\n- [x] old memory\n--- END INJECTED MEMORY ---' }],
    },
  ]
  const turns = parseOpencodeMessages(messages)
  expect(turns.length).toBe(1)
  expect(turns[0]!.role).toBe('system')
})

test('user text part 普通文本 → role:"user"（不变）', () => {
  const messages = [
    { info: { role: 'user' as const }, parts: [{ type: 'text', text: 'hello there' }] },
  ]
  const turns = parseOpencodeMessages(messages)
  expect(turns[0]).toEqual({ role: 'user', content: 'hello there' })
})

test('assistant text part 不受注入判定影响', () => {
  const messages = [
    { info: { role: 'assistant' as const }, parts: [{ type: 'text', text: '--- BEGIN INJECTED MEMORY --- mention in reply' }] },
  ]
  const turns = parseOpencodeMessages(messages)
  expect(turns[0]!.role).toBe('assistant')
})
```

（若该测试文件已有 message 构造 helper，复用之；fixture 形状以文件内既有用例为准。）

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/opencode-transcript.test.ts`
Expected: 第一条 FAIL（现状 user text part 恒 `role:"user"`）

- [ ] **Step 3: Write minimal implementation**

`src/opencode/transcript.ts` 的 text part 分支（`:44-46`）改：

```ts
if (p.type === 'text') {
  const text = (p as any).text ?? ''
  // 注入记忆块 → system（spec 2026-08-20 §3.4）：opencode 无来源字段，
  // marker 是唯一识别信号；防自我复读。assistant 文本不受影响。
  const role = m.info.role === 'user' && isInjectedMemoryBlock(text) ? 'system' : m.info.role
  turns.push({ role, content: text })
}
```

（`isInjectedMemoryBlock` 从 `@/memory/pure` import，与既有 `captureToolCall` import 合并。同步更新函数 docstring 加一行注入块判定说明。）

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/opencode-transcript.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/opencode/transcript.ts tests/opencode-transcript.test.ts
git commit -m "feat(capture): opencode 注入记忆块判 system（防自我复读）"
```

---

### Task 5: 蒸馏器 prompt 硬规则 + 无真人行代码兜底

**Files:**
- Modify: `src/memory/distiller.ts`（`DISTILLER_SYSTEM_PROMPT` origin 段 `:28-35`；`parseDistillCandidates` `:213-254`；`distillTranscript` 透传 `:293`）
- Test: `tests/distiller-origin-attribution.test.ts`（新建）

**Interfaces:**
- Consumes: `TranscriptTurn.role` 含 `system`（Task 3/4 产出；类型层面 `pure.ts:110` 已有，无需改）。
- Produces: `parseDistillCandidates(parsed, sourceKind?, hasHumanUserTurn=true)` 第三参（模块私有，签名变更）；`distillTranscript` 行为——`input.turns` 无 `role:"user"` 行时候选 origin 强制 `agent-observed`。

- [ ] **Step 1: Write the failing test**

```ts
// tests/distiller-origin-attribution.test.ts
import { test, expect } from 'bun:test'
import { distillTranscript, DISTILLER_SYSTEM_PROMPT } from '@/memory/distiller'

/**
 * Origin 归因三层防线（spec 2026-08-20 §3.5/§3.6）。
 * 事故背景：/loop 会话里 loop 框架把 prompt 机械重放成 user 行（promptSource=system），
 * 捕获层旧代码映 role:"user"，蒸馏器误标 origin=user-stated，valueFilter 双重保护
* （derivable 免疫 + decision 兜底）把 skill 派生/会话物流候选永久锁死删不掉。
 * 修复：捕获层重标 system（Task 3）+ prompt 硬规则（本任务）+ 无真人行兜底（本任务）。
 */

test('prompt 硬规则：[user] 锚定 user-stated / [system] 至多 agent-observed（文本锁）', () => {
  expect(DISTILLER_SYSTEM_PROMPT).toContain('[user]')
  expect(DISTILLER_SYSTEM_PROMPT).toContain('[system]')
  expect(DISTILLER_SYSTEM_PROMPT).toContain('只能锚定在')
  expect(DISTILLER_SYSTEM_PROMPT).toContain('BEGIN INJECTED MEMORY')
  expect(DISTILLER_SYSTEM_PROMPT).toContain('重复提炼')
})

test('纯 loop 会话（turns 全 system）：LLM 标 user-stated → 强制降级 agent-observed', async () => {
  const fakeResponse = {
    candidates: [
      {
        title: '[category:process] 子代理任务报告的处理分支：DONE/DONE_WITH_CONCERNS/NEEDS_CONTEXT/BLOCKED',
        bodyMd: '按 report 状态分支处理。',
        scope: 'project', runtime: null, distillAction: 'new',
        origin: 'user-stated',
        evidence: '按 report 状态分支处理 Task 1 结果',
      },
    ],
  }
  let seenPrompt = ''
  const result = await distillTranscript({
    turns: [
      { role: 'system', content: '检查 Task 5 implementer (a11a0f3be1ceeb11c) 是否完成。若完成则处理 report（DONE→生成 review package 派 task reviewer）' },
      { role: 'assistant', content: '唤醒已触发。正在检查 Task 5。' },
    ],
    runtime: 'claude-code', cwd: '/repo', existingSlugs: [],
    callLLM: async (_sys: string, user: string) => { seenPrompt = user; return JSON.stringify(fakeResponse) },
  })
  // 兜底：无真人行 → 强制 agent-observed（LLM 标注被推翻）
  expect(result.candidates.length).toBe(1)
  expect(result.candidates[0]!.origin).toBe('agent-observed')
  // prompt 标签：system 行以 [system] 抵达（供 prompt 硬规则约束 LLM）
  expect(seenPrompt).toContain('[system] 检查 Task 5')
})

test('有真人行：origin 保留 LLM 标注（贴金防护不变）', async () => {
  const fakeResponse = {
    candidates: [
      {
        title: '[category:convention] 测试一律 bun test',
        bodyMd: '本仓库测试一律用 bun test 运行。',
        scope: 'project', runtime: null, distillAction: 'new',
        origin: 'user-stated',
        evidence: '测试一律用 bun test 运行',
      },
    ],
  }
  const result = await distillTranscript({
    turns: [
      { role: 'user', content: '测试一律用 bun test 运行' },
      { role: 'assistant', content: '明白。' },
    ],
    runtime: 'claude-code', cwd: '/repo', existingSlugs: [],
    callLLM: async () => JSON.stringify(fakeResponse),
  })
  expect(result.candidates[0]!.origin).toBe('user-stated')
})

test('真人行 + 纯 tool 会话判 hasHumanUserTurn 以原始 turns 为准（过滤前）', async () => {
  // 一条 user（真人）+ 大量 tool turns：兜底不该触发（真人发过言）
  const fakeResponse = {
    candidates: [{
      title: '[category:invariant] x', bodyMd: 'y', scope: 'project',
      runtime: null, distillAction: 'new', origin: 'user-stated', evidence: 'x',
    }],
  }
  const turns = [
    { role: 'user', content: 'run the tests please' },
    ...Array.from({ length: 5 }, () => ({ role: 'tool' as const, content: 'ok output', isError: false })),
  ]
  const result = await distillTranscript({
    turns, runtime: 'claude-code', cwd: '/repo', existingSlugs: [],
    callLLM: async () => JSON.stringify(fakeResponse),
  })
  expect(result.candidates[0]!.origin).toBe('user-stated')
})

test('subagent 降级与无真人行兜底叠加：均为 agent-observed，互不干扰', async () => {
  const fakeResponse = {
    candidates: [{
      title: '[category:process] x', bodyMd: 'y', scope: 'project',
      runtime: null, distillAction: 'new', origin: 'user-confirmed', evidence: 'x',
    }],
  }
  const result = await distillTranscript({
    turns: [{ role: 'user', content: 'task brief from main agent' }],  // subagent brief（有 user 行但非真人）
    runtime: 'claude-code', cwd: '/repo', existingSlugs: [],
    sourceKind: 'subagent',
    callLLM: async () => JSON.stringify(fakeResponse),
  })
  expect(result.candidates[0]!.origin).toBe('agent-observed')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/distiller-origin-attribution.test.ts`
Expected: prompt 文本锁 FAIL（硬规则未加）；纯 loop 会话 FAIL（兜底未实现，origin 保留 user-stated）

- [ ] **Step 3: Write minimal implementation**

`src/memory/distiller.ts` 三处改动：

(1) `DISTILLER_SYSTEM_PROMPT` origin 段（`:28-35`）之后追加硬规则段（插在「每条候选必须带 evidence」段之前）：

```
Transcript 行标签区分说话人：[user] = 真人陈述；[system] = 机器注入内容
（loop 框架重放的 prompt、--- BEGIN INJECTED MEMORY --- 注入的既有记忆块、
task 通知、peer 消息）。硬规则：user-stated / user-confirmed 只能锚定在
[user]（真人陈述）行的原话上；[system] 行的内容不是真人陈述，至多标
agent-observed；[system] 注入记忆块是你之前注入的旧记忆，不得当新规则
重复提炼，也不得作为 evidence 出处。
```

(2) `parseDistillCandidates` 加第三参 + 兜底（`:213` 签名、`:241` 后）：

```ts
function parseDistillCandidates(
  parsed: unknown,
  sourceKind?: 'subagent' | 'conversation',
  hasHumanUserTurn: boolean = true,
): { candidates: DistillCandidate[]; rawCount: number } | null {
  // ...原有循环不动，在 subagent 降级之后加：
    // 无真人行兜底（spec 2026-08-20 §3.6）：会话里一条真人 [user] 行都没有时
    // （纯 loop 会话），任何 stated/confirmed 都不可能成立，强制降级。
    // 默认 true 向后兼容（独立调用/旧测试不降级）。
    if (!hasHumanUserTurn) origin = 'agent-observed'
```

(3) `distillTranscript` 计算并透传（`:293` 前）：

```ts
// 无真人行兜底的数据来源（spec §3.6）：用过滤前原始 turns 判——预算裁剪可能
// 丢真人行，而「会话里有没有真人发言」是 session 级事实，不该被裁剪影响。
const hasHumanUserTurn = input.turns.some((t) => t.role === 'user')
```

`:293` 的调用改 `parseDistillCandidates(session.parsed, input.sourceKind, hasHumanUserTurn)`。

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/distiller-origin-attribution.test.ts`
Expected: PASS

- [ ] **Step 5: Run full suite**

Run: `bun test`
Expected: 全绿（现有 distiller 测试的 turns 均含 role:"user"，hasHumanUserTurn=true，语义不变）

- [ ] **Step 6: Commit**

```bash
git add src/memory/distiller.ts tests/distiller-origin-attribution.test.ts
git commit -m "feat(distill): origin 硬规则——[user] 锚定 stated + 无真人行强制降级兜底"
```

---

### Task 6: e2e 回归锁 + 全量验证 + STATE.md 收尾

**Files:**
- Test: `tests/distiller-origin-attribution.test.ts`（追加 e2e 用例）
- Modify: `STATE.md`（新段落）

**Interfaces:**
- Consumes: Task 3（捕获层判 role）+ Task 5（蒸馏器兜底）。
- Produces: 全链路回归锁——真实形状 transcript 文件 → parseTranscriptFile → distillTranscript → origin 正确。

- [ ] **Step 1: Write the failing-then-passing e2e test（事故复现回归锁）**

在 `tests/distiller-origin-attribution.test.ts` 追加（复刻事故会话的完整形状：真人早期发言不在 distill 窗口、loop 重放以 promptSource=system 抵达）：

```ts
// ---------------------------------------------------------------------------
// 事故复现回归锁（spec 2026-08-20 §1）：复刻 distill job 01M0EKC0AGBAENJQ8KWS3E4PDQ
// 的输入形状——/loop 会话，真人早已离场，turns 全是 loop 重放（promptSource=system）
// 与 assistant/tool 轮转。全链路：JSONL 文件 → parseTranscriptFile → distillTranscript，
// 断言捕获层重标 system + 蒸馏器兜底降级 origin，双重防线同时生效。
// ---------------------------------------------------------------------------

import { parseTranscriptFile } from '@/claude/transcript'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

test('e2e 事故复现：/loop 会话 transcript → 捕获层 system + origin 强制降级', async () => {
  const dir = join(import.meta.dir, '.tmp-origin-e2e')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const p = join(dir, 'loop-session.jsonl')
  // 复刻实测 transcript 行形状（去掉长字段，保留来源字段与内容）
  const rows = [
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '正在等待 Task 5。' }] } },
    { type: 'user', promptSource: 'system', isMeta: true, message: { role: 'user', content: '检查 Task 5 implementer (a11a0f3be1ceeb11c) 是否完成。若完成则处理 report（DONE→生成 review package 派 task reviewer；DONE_WITH_CONCERNS→先读 concerns；NEEDS_CONTEXT→补上下文重派；BLOCKED→裁决）' } },
    { type: 'user', isMeta: true, message: { role: 'user', content: '[1 prior /loop wakeup found nothing actionable; loop is healthy.]' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '唤醒已触发。正在检查 Task 5。' }] } },
    // 工具结果行（toolUseResult 形态走 array 分支 → role:tool）
    { type: 'user', toolUseResult: { success: true }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '4cb64a8 refactor commit' }] } },
  ]
  writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')

  // 第一道防线：捕获层
  const turns = parseTranscriptFile(p)
  const roles = turns.map((t) => t.role)
  expect(roles).toEqual(['assistant', 'system', 'system', 'assistant', 'tool'])
  expect(turns.some((t) => t.role === 'user')).toBe(false)  // 无真人行

  // 第二道防线：蒸馏器兜底（LLM 顽固标 user-stated 也被推翻）
  const fakeResponse = {
    candidates: [{
      title: '[category:process] 子代理任务报告的处理分支：DONE/DONE_WITH_CONCERNS/NEEDS_CONTEXT/BLOCKED',
      bodyMd: '按 report 状态分支处理任务结果。',
      scope: 'project', runtime: null, distillAction: 'new',
      origin: 'user-stated',
      evidence: '按 report 状态分支处理 Task 1 结果',
    }],
  }
  const result = await distillTranscript({
    turns, runtime: 'claude-code', cwd: '/repo', existingSlugs: [],
    callLLM: async () => JSON.stringify(fakeResponse),
  })
  expect(result.candidates.length).toBe(1)
  expect(result.candidates[0]!.origin).toBe('agent-observed')

  rmSync(dir, { recursive: true, force: true })
})
```

- [ ] **Step 2: Run test（应直接 PASS——Task 3/5 已实现；若红则上游任务有缺口，回上游修）**

Run: `bun test tests/distiller-origin-attribution.test.ts`
Expected: PASS

- [ ] **Step 3: Run full gate**

Run（Bash 工具）：`bun run typecheck && bun test`
Expected: typecheck 干净 + 全量测试 0 fail

- [ ] **Step 4: Update STATE.md**

在 `STATE.md` 顶部（`# STATE.md` 标题后）插入新段落，记录：事故根因摘要（loop 重放 prompt 被映 role:user → 误标 user-stated → 双重保护锁死）、三层根治（捕获层来源归因 D1/D2 / prompt 硬规则 / 无真人行兜底）、执行方式、`bun run typecheck && bun test` 计数（基线 1315 pass / 6 skip → 实际数字）、「上线后观测」清单（从 spec §8 摘录：候选 origin 分布、注入块不再自我复读、derivable 误伤观测、/loop 新会话 origin 正确降级）。风格对齐文件内既有段落。

- [ ] **Step 5: Commit**

```bash
git add tests/distiller-origin-attribution.test.ts STATE.md
git commit -m "test(e2e): /loop 事故复现回归锁 + STATE.md 收尾"
```

---

## 验收清单

- [ ] `bun run typecheck && bun test` 全绿（Bash 工具执行）
- [ ] `tests/pure-injected-marker.test.ts` 锁 marker 单一事实来源
- [ ] `tests/transcript.test.ts` 覆盖实测 taxonomy 全分支（human/loop/task-notification/peer/注入块/无字段/畸形 origin）
- [ ] `tests/distiller-origin-attribution.test.ts` 锁 prompt 硬规则文本 + 无真人行兜底 + e2e 事故复现
- [ ] 无 DB 迁移、无新依赖、`valueFilter.ts` 零改动
- [ ] 所有 commit 在 `worktree-fix-origin-misattribution` 分支
- [ ] spec §8 上线后观测清单已写入 STATE.md

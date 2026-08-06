# Agentic 价值判定器 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让价值判定器能读到当前项目仓库(agent 终审),根治候选记忆灌水,并提供经济/质量双模式与存量回扫。

**Architecture:** 管线改为「蒸馏(subagent prompt 小改) → 逐字去重(免费) → dedup LLM(不动) → judge 二选一(经济=现有单发 / 质量=带只读工具的 agent 循环)」。agent 循环走纯文本 JSON 协议(不用 vendor tool-use API),工具沙箱锁死在 job.cwd。配置存 app_settings 表,Web UI 可切模式、调预算。存量回扫复用同一判定器。

**Tech Stack:** Bun + Hono + Drizzle + bun:sqlite + React(inline style)。

**Spec:** `docs/superpowers/specs/2026-08-06-agentic-value-judge-design.md`

## Global Constraints

- 测试一律 `bun test` 运行,**严禁 npm test**;每任务 `bun run typecheck && bun test` 全绿才 commit。
- 分支 `feat/agentic-value-judge`(已建),**禁止直推 master**;commit 消息中文、类型前缀(feat/fix/test)。
- **判定规则文本语义零变更**:`VALUE_JUDGE_SYSTEM_PROMPT` 现有判定段逐字保留(Task 5 重构后必须字节不变,有测试锁)。
- **任何故障倒向「保留」,绝不倒向「丢弃」**(LLM 报错/格式乱/预算耗尽/目录缺失 → 候选全留)。
- agent 工具**只读**,沙箱锁死项目目录;拒绝越界时返回错误文本,不抛异常炸循环。
- 不用各 vendor 原生 tool-use API;纯文本 JSON 约定,复用 `extractJsonObject` 围栏剥离。
- Web UI 沿用 `src/web/App.tsx` 现有 inline-style 结构,不引入新样式框架。
- `memory_discards.reason` 是自由文本列,新增 `'exact-duplicate'`/`'duplicate'` **免迁移**。
- 审计脚本 `scripts/audit-candidates*.ts` 属分析残留,不纳入本分支任何 commit。

---

### Task 1: 逐字去重(纯函数 + 接线 + 审计)

**Files:**
- Create: `src/memory/exactDedup.ts`
- Modify: `src/memory/valueFilter.ts:6`(DiscardReason 联合类型加 `'exact-duplicate'`)
- Modify: `src/scheduler.ts:167-174`(dedupCandidates 之前插入逐字去重)
- Modify: `src/web/ui-utils.ts:103-110`(新理由中文标签)
- Test: `tests/exact-dedup.test.ts`

**Interfaces:**
- Consumes: `listForDedupByScope(db, {scopeType, scopeId})`(store.ts:182,返回含 title 的存量 candidate+approved);`logDiscards(db, jobId, DiscardRecord[])`(store.ts:412);`resolveScopeId`(scheduler.ts:57 内部函数)。
- Produces: `normalizeTitleForDup(title: string): string`;`findExactDuplicates(candidates: DistillCandidate[], existingTitles: string[]): ExactDupDrop[]`;`exactDedupCandidates(db: DbClient, candidates: DistillCandidate[], jobCwd: string | null): Promise<{ kept: DistillCandidate[]; drops: { cand: DistillCandidate; matchedExisting: boolean }[] }>`。Task 5 的 scheduler dispatch 在 `exactDedupCandidates` 之后运行。

- [ ] **Step 1: 写失败测试**

```ts
// tests/exact-dedup.test.ts
// 回归防护:本文件锁「逐字去重只合并规范化后逐字相同的标题」——
// 审计实证(parseTranscriptFile 前缀组 9 条实为多个不同事实),模糊匹配必误杀。
// spec: docs/superpowers/specs/2026-08-06-agentic-value-judge-design.md §4.1
import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { openDb } from '@/db/client'
import { normalizeTitleForDup, findExactDuplicates, exactDedupCandidates } from '@/memory/exactDedup'
import { createCandidate } from '@/memory/store'
import type { DistillCandidate } from '@/memory/distiller'

const cand = (title: string, scopeType: 'project' | 'global' = 'project'): DistillCandidate => ({
  title, bodyMd: 'b', scopeType, runtime: 'claude-code',
  distillAction: 'new', origin: 'agent-observed', evidence: null, subjectSlug: null,
})

test('normalizeTitleForDup: 去前缀/标点/空白/大小写后逐字相同', () => {
  const a = normalizeTitleForDup('[category:convention] 每个 PR 必须在 CHANGELOG.md 的 Unreleased 段添加一条条目')
  const b = normalizeTitleForDup('[category:process] 每个PR必须在CHANGELOG.md的Unreleased段添加一条条目')
  expect(a).toBe(b)
  expect(a).not.toBe(normalizeTitleForDup('[category:convention] 每个 PR 必须更新 CHANGELOG'))
})

test('findExactDuplicates: 同批重复留最早,其余进 drops', () => {
  const drops = findExactDuplicates(
    [cand('[category:a] 同一条规则 X'), cand('[category:b] 同一条规则 X'), cand('[category:a] 不同规则 Y')],
    [],
  )
  expect(drops).toEqual([{ index: 1, matchedExisting: false }])
})

test('findExactDuplicates: 与存量重复(含大小写/前缀差异)命中 matchedExisting', () => {
  const drops = findExactDuplicates(
    [cand('[category:b] 已审批过的规则 Z')],
    ['[category:a] 已审批过的规则 Z'],
  )
  expect(drops).toEqual([{ index: 0, matchedExisting: true }])
})

test('findExactDuplicates: 标题相近但内容不同,绝不合并(误杀回归锁)', () => {
  const drops = findExactDuplicates(
    [cand('[category:architecture] parseTranscriptFile 采用从不抛出设计保护收集器热路径'),
     cand('[category:architecture] parseTranscriptFile 跳过 tool_use 行导致缺乏工具上下文')],
    [],
  )
  expect(drops).toEqual([])
})

// --- DB 接线测试(种子模式同 store-crud.test.ts) ---
const root = join(import.meta.dir, '.tmp-exact-dedup')
let dir = ''
let db: ReturnType<typeof openDb>
beforeAll(() => { rmSync(root, { recursive: true, force: true }); mkdirSync(root, { recursive: true }) })
beforeEach(() => { dir = join(root, Math.random().toString(36).slice(2)); mkdirSync(dir, { recursive: true }); db = openDb(join(dir, 't.db')) })
afterEach(() => { db.$client.close() })

test('exactDedupCandidates: 跨批对同 scope 存量(candidate+approved)查重', async () => {
  await createCandidate(db, {
    scopeType: 'project', scopeId: '/proj', title: '[category:a] 存量规则 W', bodyMd: 'b',
    tags: [], sourceKind: 'conversation', sourceCwd: '/proj', runtime: 'claude-code',
  })
  const { kept, drops } = await exactDedupCandidates(db,
    [cand('[category:b] 存量规则 W'), cand('[category:a] 全新规则 V')], '/proj')
  expect(kept.map((c) => c.title)).toEqual(['[category:a] 全新规则 V'])
  expect(drops).toHaveLength(1)
  expect(drops[0]!.matchedExisting).toBe(true)
})

test('exactDedupCandidates: global 候选只跟 global 存量比,不串 project', async () => {
  await createCandidate(db, {
    scopeType: 'project', scopeId: '/proj', title: '[category:a] 同名规则 G', bodyMd: 'b',
    tags: [], sourceKind: 'conversation', sourceCwd: '/proj', runtime: 'claude-code',
  })
  const { kept } = await exactDedupCandidates(db, [cand('[category:a] 同名规则 G', 'global')], '/proj')
  expect(kept).toHaveLength(1)  // project 存量的同名不阻挡 global 候选
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/exact-dedup.test.ts`
Expected: FAIL(`@/memory/exactDedup` 模块不存在)

- [ ] **Step 3: 实现 exactDedup.ts**

```ts
// src/memory/exactDedup.ts
import type { DbClient } from '@/db/client'
import type { DistillCandidate } from '@/memory/distiller'
import { listForDedupByScope } from '@/memory/store'
import type { MemoryScope } from '@/memory/pure'

/**
 * 逐字级标题规范化(spec §4.1):去 [category:xxx] 前缀 → 去全部空白/标点/符号 → 转小写。
 * 只做逐字相同合并,零语义判断——前缀相近但内容不同的标题(parseTranscriptFile 组)
 * 规范化后仍不同,绝不误合并。
 */
export function normalizeTitleForDup(title: string): string {
  return title
    .replace(/\[category:[^\]]*\]/gi, '')
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .toLowerCase()
}

export interface ExactDupDrop {
  /** 被合并候选在输入数组中的下标。 */
  index: number
  /** true = 与同 scope 存量重复;false = 与同批更早候选重复。 */
  matchedExisting: boolean
}

/**
 * 找出应合并的候选:同批内规范化标题逐字相同留最早;与 existingTitles 逐字相同即合并。
 * 空规范化结果(纯前缀标题)不参与比对,保守保留。
 */
export function findExactDuplicates(
  candidates: DistillCandidate[],
  existingTitles: string[],
): ExactDupDrop[] {
  const existingKeys = new Set(existingTitles.map(normalizeTitleForDup).filter((k) => k.length > 0))
  const batchSeen = new Set<string>()
  const drops: ExactDupDrop[] = []
  for (let i = 0; i < candidates.length; i++) {
    const key = normalizeTitleForDup(candidates[i]!.title)
    if (!key) continue
    if (batchSeen.has(key)) { drops.push({ index: i, matchedExisting: false }); continue }
    batchSeen.add(key)
    if (existingKeys.has(key)) drops.push({ index: i, matchedExisting: true })
  }
  return drops
}

function resolveScopeId(scopeType: MemoryScope, cwd: string | null): string | null {
  return scopeType === 'project' ? (cwd ?? 'unknown') : null
}

/**
 * 按 (scopeType, scopeId) 分组(与 scheduler.dedupCandidates 同规则,防 scopeId 漂移),
 * 每组查存量 candidate+approved 标题做逐字比对。返回幸存者与合并项。
 * listForDedupByScope 的 DB 错误上抛(基础设施故障 → job 重试,与 dedupCandidates 一致)。
 */
export async function exactDedupCandidates(
  db: DbClient,
  candidates: DistillCandidate[],
  jobCwd: string | null,
): Promise<{ kept: DistillCandidate[]; drops: { cand: DistillCandidate; matchedExisting: boolean }[] }> {
  if (candidates.length === 0) return { kept: [], drops: [] }
  const groups = new Map<string, { scopeType: MemoryScope; scopeId: string | null; idxs: number[] }>()
  candidates.forEach((c, i) => {
    const scopeId = resolveScopeId(c.scopeType, jobCwd)
    const key = `${c.scopeType}:${scopeId ?? ''}`
    if (!groups.has(key)) groups.set(key, { scopeType: c.scopeType, scopeId, idxs: [] })
    groups.get(key)!.idxs.push(i)
  })
  const dropByIndex = new Map<number, boolean>()  // index -> matchedExisting
  for (const g of groups.values()) {
    const existing = await listForDedupByScope(db, { scopeType: g.scopeType, scopeId: g.scopeId })
    const sub = g.idxs.map((i) => candidates[i]!)
    for (const d of findExactDuplicates(sub, existing.map((e) => e.title))) {
      dropByIndex.set(g.idxs[d.index]!, d.matchedExisting)
    }
  }
  const kept: DistillCandidate[] = []
  const drops: { cand: DistillCandidate; matchedExisting: boolean }[] = []
  candidates.forEach((c, i) => {
    const m = dropByIndex.get(i)
    if (m === undefined) kept.push(c)
    else drops.push({ cand: c, matchedExisting: m })
  })
  return { kept, drops }
}
```

- [ ] **Step 4: DiscardReason 扩展 + UI 标签**

`src/memory/valueFilter.ts:6` 改为:

```ts
export type DiscardReason = 'public-knowledge' | 'derivable' | 'taming' | 'fleeting' | 'exact-duplicate' | 'duplicate'
```

(`'duplicate'` 本任务不用,Task 5 agent 判定用;一次扩齐避免两任务改同一行。)

`src/web/ui-utils.ts` 的 `discardReasonLabel` 映射加两行:

```ts
    'exact-duplicate': '逐字重复',
    duplicate: '与已有记忆重复',
```

- [ ] **Step 5: scheduler 接线**

`src/scheduler.ts` import 加 `exactDedupCandidates`,在 `// Dedup FIRST` 注释段**之前**插入:

```ts
      // 逐字去重(spec §4.1):规范化逐字相同才合并,零语义判断;合并项走审计表。
      // 先于 LLM dedup,省调用;drops 不进后续任何 LLM 判定。
      const exact = await exactDedupCandidates(db, candidates, job.cwd ?? null)
      if (exact.drops.length > 0) {
        try {
          await logDiscards(db, job.id, exact.drops.map((d) => ({
            title: d.cand.title, bodyMd: d.cand.bodyMd, reason: 'exact-duplicate',
            scopeType: d.cand.scopeType,
            scopeId: resolveScopeId(d.cand.scopeType, job.cwd ?? null),
            sourceCwd: job.cwd ?? null,
            runtime: d.cand.runtime,
            sourceKind: job.sourceAgentId ? 'subagent' : 'conversation',
          })))
        } catch (e) { console.warn('memside: logDiscards failed', e) }
      }
```

并把 `dedupCandidates(db, deps.callLLM, candidates, job.cwd ?? null)` 的输入从 `candidates` 改为 `exact.kept`;`saveDistillRun` 的 `discardedCount` 改为 `discarded.length + exact.drops.length`。

- [ ] **Step 6: 跑测试确认通过 + 全量回归**

Run: `bun test tests/exact-dedup.test.ts && bun run typecheck && bun test`
Expected: 新测试 PASS;既有 582 测试全绿(scheduler 既有测试不受影响——其 mock 候选无逐字重复)

- [ ] **Step 7: Commit**

```bash
git add src/memory/exactDedup.ts src/memory/valueFilter.ts src/scheduler.ts src/web/ui-utils.ts tests/exact-dedup.test.ts
git commit -m "feat(memory): 逐字去重——规范化标题逐字相同才合并,走审计表"
```

---

### Task 2: 蒸馏器 subagent prompt 改进(任务工单约束不产记忆)

**Files:**
- Modify: `src/memory/distiller.ts:116-126`(renderUserPrompt 加 sourceKind 参数 + 追加段)、`:158-165`(调用处传 sourceKind)
- Test: `tests/distiller-subagent-note.test.ts`

**Interfaces:**
- Consumes: 无新依赖(`DistillInput.sourceKind` 已存在,distiller.ts:99)。
- Produces: `SUBAGENT_BRIEF_NOTE: string`(导出常量,供源码文本断言);`renderUserPrompt` 末参加 `sourceKind?: 'subagent' | 'conversation'`(模块内函数,外部不可见)。

- [ ] **Step 1: 写失败测试**

```ts
// tests/distiller-subagent-note.test.ts
// 回归防护:subagent 的 role:user 是任务工单,其一次性约束(改哪些文件/验收标准)
// 不得产记忆——2026-08-06 候选审计实证此类灌水占 subagent 候选大头。
// spec: docs/superpowers/specs/2026-08-06-agentic-value-judge-design.md §4.2
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { distillTranscript, SUBAGENT_BRIEF_NOTE } from '@/memory/distiller'
import type { TranscriptTurn } from '@/memory/pure'

const turns: TranscriptTurn[] = [{ role: 'user', content: '任务:只许改 src/x.ts', isError: false }]
const okLLM = async () => '{"candidates": []}'

test('sourceKind=subagent 时 user prompt 含任务工单警示段', async () => {
  let seen = ''
  await distillTranscript({
    turns, runtime: 'claude-code', cwd: '/p', existingSlugs: [],
    callLLM: async (_s, u) => { seen = u; return okLLM() },
    sourceKind: 'subagent',
  })
  expect(seen).toContain(SUBAGENT_BRIEF_NOTE)
  expect(seen).toContain('任务工单')
})

test('sourceKind=conversation 时 user prompt 不含警示段(主会话一字不动)', async () => {
  let seen = ''
  await distillTranscript({
    turns, runtime: 'claude-code', cwd: '/p', existingSlugs: [],
    callLLM: async (_s, u) => { seen = u; return okLLM() },
    sourceKind: 'conversation',
  })
  expect(seen).not.toContain('任务工单')
})

test('源码层断言:警示段含「不得提取为候选记忆」硬约束与失效语义', () => {
  const src = readFileSync(join(import.meta.dir, '../src/memory/distiller.ts'), 'utf8')
  expect(src).toContain('不得提取为候选记忆')
  expect(src).toContain('任务结束时即失效')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/distiller-subagent-note.test.ts`
Expected: FAIL(`SUBAGENT_BRIEF_NOTE` 未导出)

- [ ] **Step 3: 实现**

`src/memory/distiller.ts` 在 `DISTILLER_SYSTEM_PROMPT` 之后加:

```ts
/**
 * subagent 蒸馏专用警示段(spec §4.2):追加在 user prompt 末尾。role:user 是主 agent
 * 派发的任务工单,其中一次性任务约束(改哪些文件/验收标准)任务结束即失效,不得产记忆。
 * 只动 user prompt,系统 prompt 一字不动。
 */
export const SUBAGENT_BRIEF_NOTE = `\n\n注意:本 transcript 来自 subagent。其中 role:user 的发言是主 agent 派发的任务工单,不是真人陈述。工单中只针对本次任务的约束(允许修改哪些文件、做到什么程度、验收标准)在任务结束时即失效,不得提取为候选记忆;只有跨会话持续成立的规则、决策、踩坑才可提取。`
```

`renderUserPrompt` 签名末加 `sourceKind?: 'subagent' | 'conversation'`,return 改为:

```ts
  const base = `Runtime: ${runtime}\nCwd: ${cwd}\nError signals detected: ${JSON.stringify(signals)}\nExisting subject slugs (reuse these when a candidate matches an existing subject): ${slugs}\n\nTranscript:\n${transcript}\n\nExtract candidate memories as JSON per the system instructions.`
  return sourceKind === 'subagent' ? base + SUBAGENT_BRIEF_NOTE : base
```

`distillTranscript` 调用处改为 `renderUserPrompt(filtered, input.runtime, input.cwd, signals, input.existingSlugs, input.sourceKind)`。

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `bun test tests/distiller-subagent-note.test.ts && bun run typecheck && bun test`
Expected: 全绿(distiller 既有测试的 mock 均 conversation,user prompt 不变)

- [ ] **Step 5: Commit**

```bash
git add src/memory/distiller.ts tests/distiller-subagent-note.test.ts
git commit -m "feat(distiller): subagent 蒸馏警示段——任务工单一次性约束不产记忆"
```

---

### Task 3: 三个只读仓库工具(沙箱 + 封顶)

**Files:**
- Create: `src/memory/repoTools.ts`
- Test: `tests/repo-tools.test.ts`

**Interfaces:**
- Consumes: 仅 node:fs/node:path(无新依赖,不引入 ripgrep——Windows 环境不保证存在)。
- Produces: `makeRepoTools(rootDir: string): RepoTools`;`RepoTools.execute(tool: string, args: Record<string, unknown>): Promise<string>`(返回喂给模型的纯文本;**永不抛**,出错返回错误文本)。Task 4 的 agentLoop 依赖 `RepoTools` 类型与 `execute` 签名。封顶常量导出:`GREP_MAX_HITS=20`、`GREP_TOTAL_CAP=4000`、`READ_MAX_LINES=200`、`LIST_MAX_ENTRIES=200`。

- [ ] **Step 1: 写失败测试**

```ts
// tests/repo-tools.test.ts
// 回归防护:agent 工具必须只读 + 沙箱——越界/逃逸一律拒绝且永不抛(炸循环即灌水管线停摆)。
// spec: docs/superpowers/specs/2026-08-06-agentic-value-judge-design.md §4.3
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeRepoTools } from '@/memory/repoTools'

const root = join(import.meta.dir, '.tmp-repo-tools')
beforeAll(() => {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true })
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, 'CLAUDE.md'), '# 规则\n禁止直推 master\n第三行\n')
  writeFileSync(join(root, 'src', 'a.ts'), 'export const sslBackend = 1\n'.repeat(300))
  writeFileSync(join(root, 'node_modules', 'dep', 'x.js'), 'sslBackend 不该被搜到\n')
  writeFileSync(join(root, '.git', 'y'), 'sslBackend 不该被搜到\n')
})
afterAll(() => { rmSync(root, { recursive: true, force: true }) })

const tools = () => makeRepoTools(root)

test('read: 正常读取 + 行数封顶 200', async () => {
  const out = await tools().execute('read', { path: 'src/a.ts', startLine: 1 })
  expect(out).toContain('sslBackend')
  expect(out.split('\n').length).toBeLessThanOrEqual(201)  // 200 行 + 可能的截断说明行
})

test('read: ../ 逃逸与绝对路径越界返回错误文本,不抛', async () => {
  const esc = await tools().execute('read', { path: '../../etc/passwd' })
  expect(esc).toContain('拒绝')
  const abs = await tools().execute('read', { path: 'C:/Windows/win.ini' })
  expect(abs).toContain('拒绝')
})

test('read: 文件不存在返回错误文本,不抛', async () => {
  expect(await tools().execute('read', { path: 'nope.md' })).toContain('不存在')
})

test('grep: 字面量命中 + 跳过 node_modules/.git', async () => {
  const out = await tools().execute('grep', { pattern: 'sslBackend' })
  expect(out).toContain('src')
  expect(out).not.toContain('node_modules')
  expect(out).not.toContain('.git')
})

test('grep: 无命中返回明确文本', async () => {
  expect(await tools().execute('grep', { pattern: '绝不可能存在的字符串xyz' })).toContain('0 处命中')
})

test('list: 列目录 + 条目数封顶', async () => {
  const out = await tools().execute('list', { path: '.' })
  expect(out).toContain('CLAUDE.md')
  expect(out).toContain('src')
})

test('未知工具名返回错误文本,不抛', async () => {
  expect(await tools().execute('write', { path: 'x' })).toContain('未知工具')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/repo-tools.test.ts`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现 repoTools.ts**

```ts
// src/memory/repoTools.ts
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'

export const GREP_MAX_HITS = 20
export const GREP_HIT_CONTEXT_CHARS = 200
export const GREP_TOTAL_CAP = 4000
export const READ_MAX_LINES = 200
export const LIST_MAX_ENTRIES = 200
const SKIP_DIRS = new Set(['.git', 'node_modules'])
const GREP_FILE_SIZE_CAP = 1_000_000

export interface RepoTools {
  /** 执行只读工具,返回喂给模型的纯文本;永不抛(错误即文本)。 */
  execute(tool: string, args: Record<string, unknown>): Promise<string>
}

/**
 * agent 判定器的三只手(spec §4.3):grep/read/list,全部只读,沙箱锁死 rootDir。
 * 路径解析(含符号链接)后必须仍以 root 为前缀,越界返回「拒绝」文本——
 * 错误永远以文本形式回到对话,不抛异常炸 agent 循环。
 */
export function makeRepoTools(rootDir: string): RepoTools {
  const root = realpathSync(rootDir)
  const resolveInside = (p: string): string | null => {
    try {
      const abs = path.resolve(root, p)
      if (abs !== root && !abs.startsWith(root + path.sep)) return null
      return realpathSync(abs)  // 解析符号链接后再校验一次
    } catch { return null }
  }
  const insideRoot = (real: string) => real === root || real.startsWith(root + path.sep)

  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), out)
      } else out.push(path.join(dir, e.name))
      if (out.length > 20_000) break  // 超大仓库防爆
    }
    return out
  }

  const grep = (pattern: string, sub?: string): string => {
    const base = sub ? resolveInside(sub) : root
    if (!base || !insideRoot(base)) return `拒绝:路径越出项目目录`
    const files = statSync(base).isDirectory() ? walk(base) : [base]
    const hits: string[] = []
    let total = 0
    for (const f of files) {
      if (hits.length >= GREP_MAX_HITS || total >= GREP_TOTAL_CAP) break
      try {
        if (statSync(f).size > GREP_FILE_SIZE_CAP) continue
        const text = readFileSync(f, 'utf8')
        const lines = text.split('\n')
        for (let i = 0; i < lines.length && hits.length < GREP_MAX_HITS && total < GREP_TOTAL_CAP; i++) {
          if (!lines[i]!.includes(pattern)) continue
          const snippet = lines[i]!.slice(0, GREP_HIT_CONTEXT_CHARS)
          const rel = path.relative(root, f)
          const entry = `${rel}:${i + 1}: ${snippet}`
          hits.push(entry)
          total += entry.length
        }
      } catch { continue }  // 二进制/编码问题跳过
    }
    if (hits.length === 0) return `0 处命中`
    const more = hits.length >= GREP_MAX_HITS ? `\n(已达 ${GREP_MAX_HITS} 处封顶,可能还有更多)` : ''
    return hits.join('\n') + more
  }

  const read = (p: string, startLine?: number, endLine?: number): string => {
    const real = resolveInside(p)
    if (!real || !insideRoot(real)) return `拒绝:路径越出项目目录`
    try {
      if (!statSync(real).isFile()) return `不存在:不是文件 ${p}`
      const lines = readFileSync(real, 'utf8').split('\n')
      const s = Math.max(1, startLine ?? 1)
      const e = Math.min(lines.length, endLine ?? s + READ_MAX_LINES - 1, s + READ_MAX_LINES - 1)
      const body = lines.slice(s - 1, e).join('\n')
      const tail = e < lines.length ? `\n(共 ${lines.length} 行,已显示 ${s}-${e})` : ''
      return body + tail
    } catch { return `不存在:${p}` }
  }

  const list = (p?: string): string => {
    const real = p ? resolveInside(p) : root
    if (!real || !insideRoot(real)) return `拒绝:路径越出项目目录`
    try {
      const entries = readdirSync(real).slice(0, LIST_MAX_ENTRIES)
      return entries.join('\n')
    } catch { return `不存在:${p ?? '.'}` }
  }

  return {
    async execute(tool, args) {
      try {
        switch (tool) {
          case 'grep': return grep(String(args.pattern ?? ''), args.path === undefined ? undefined : String(args.path))
          case 'read': return read(String(args.path ?? ''),
            typeof args.startLine === 'number' ? args.startLine : undefined,
            typeof args.endLine === 'number' ? args.endLine : undefined)
          case 'list': return list(args.path === undefined ? undefined : String(args.path))
          default: return `未知工具:${tool}(可用:grep/read/list)`
        }
      } catch (e) {
        return `工具执行失败:${e instanceof Error ? e.message : String(e)}`
      }
    },
  }
}
```

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `bun test tests/repo-tools.test.ts && bun run typecheck && bun test`
Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add src/memory/repoTools.ts tests/repo-tools.test.ts
git commit -m "feat(memory): agent 只读仓库工具 grep/read/list(沙箱+封顶)"
```

---

### Task 4: agent 循环(JSON 协议 + 对话累积 + 预算 + 兜底)

**Files:**
- Create: `src/memory/agentLoop.ts`
- Test: `tests/agent-loop.test.ts`

**Interfaces:**
- Consumes: `LLMCall`(llm.ts:17);`RepoTools`(Task 3);`extractJsonObject`(pure.ts);**故意不复用 `callWithRetry`**(retry.ts 每次重试从原始 prompt 重拼,丢弃试错历史——spec §4.4 已论证)。
- Produces: `runAgentLoop(opts: AgentLoopOpts): Promise<AgentLoopResult>`;类型 `AgentStep`、`AgentLoopResult`、`AgentLoopOpts`。Task 5 的 agentJudge 消费 `AgentStep[]` 作 trace 落盘。

- [ ] **Step 1: 写失败测试**

```ts
// tests/agent-loop.test.ts
// 回归防护:agent 循环的核心资产是「对话累积」——每轮必须带上之前全部工具结果,
// 格式纠错是追加而非重置(callWithRetry 式重置会让 agent 每轮失忆)。
// spec: docs/superpowers/specs/2026-08-06-agentic-value-judge-design.md §4.4
import { test, expect } from 'bun:test'
import { runAgentLoop } from '@/memory/agentLoop'
import type { RepoTools } from '@/memory/repoTools'

const fakeTools = (result = 'grep 结果文本'): RepoTools => ({
  execute: async () => result,
})

test('收敛:工具结果累积进下一轮 prompt,final 结束循环', async () => {
  const seenUsers: string[] = []
  const callLLM = async (_s: string, u: string) => {
    seenUsers.push(u)
    return seenUsers.length === 1
      ? '{"tool": "grep", "args": {"pattern": "sslBackend"}}'
      : '{"final": {"verdicts": [{"index": 0, "category": "trap"}]}}'
  }
  const r = await runAgentLoop({
    callLLM, system: 'sys', user: '初始材料', tools: fakeTools(), maxRounds: 10, timeBudgetMs: 60_000,
  })
  expect(r.stopReason).toBe('final')
  expect(r.final).toEqual({ verdicts: [{ index: 0, category: 'trap' }] })
  expect(seenUsers).toHaveLength(2)
  expect(seenUsers[1]).toContain('grep 结果文本')   // 累积:第二轮看到工具结果
  expect(seenUsers[1]).toContain('初始材料')        // 累积:初始材料仍在
  expect(r.trace.map((t) => t.kind)).toEqual(['tool', 'final'])
})

test('格式错误:追加纠正消息而非重置对话', async () => {
  const seenUsers: string[] = []
  const callLLM = async (_s: string, u: string) => {
    seenUsers.push(u)
    if (seenUsers.length === 1) return '不是 JSON 的胡言乱语'
    if (seenUsers.length === 2) return '{"tool": "list", "args": {}}'
    return '{"final": {"verdicts": []}}'
  }
  const r = await runAgentLoop({
    callLLM, system: 'sys', user: '材料', tools: fakeTools(), maxRounds: 10, timeBudgetMs: 60_000,
  })
  expect(r.stopReason).toBe('final')
  expect(seenUsers[1]).toContain('格式不对')        // 纠正消息
  expect(seenUsers[2]).toContain('材料')            // 对话未重置
})

test('轮次预算耗尽:强制收尾;仍无 final 则 final=null', async () => {
  const seenUsers: string[] = []
  const callLLM = async (_s: string, u: string) => {
    seenUsers.push(u)
    return '{"tool": "grep", "args": {"pattern": "x"}}'  // 永远要查,永不下判
  }
  const r = await runAgentLoop({
    callLLM, system: 'sys', user: '材料', tools: fakeTools(), maxRounds: 3, timeBudgetMs: 60_000,
  })
  expect(r.stopReason).toBe('rounds-budget')
  expect(r.final).toBeNull()
  expect(seenUsers.some((u) => u.includes('预算已尽'))).toBe(true)  // 收到强制收尾消息
})

test('强制收尾一轮成功:final 可取,stopReason 仍记 rounds-budget', async () => {
  let calls = 0
  const callLLM = async () => {
    calls++
    return calls <= 3 ? '{"tool": "grep", "args": {"pattern": "x"}}' : '{"final": {"verdicts": []}}'
  }
  const r = await runAgentLoop({
    callLLM, system: 'sys', user: '材料', tools: fakeTools(), maxRounds: 3, timeBudgetMs: 60_000,
  })
  expect(r.stopReason).toBe('rounds-budget')
  expect(r.final).toEqual({ verdicts: [] })
})

test('LLM 抛错:stopReason=llm-error,final=null,不炸调用方', async () => {
  const r = await runAgentLoop({
    callLLM: async () => { throw new Error('HTTP 502') },
    system: 'sys', user: '材料', tools: fakeTools(), maxRounds: 5, timeBudgetMs: 60_000,
  })
  expect(r.stopReason).toBe('llm-error')
  expect(r.final).toBeNull()
})

test('工具执行出错:错误文本塞回对话,循环继续', async () => {
  const seenUsers: string[] = []
  const callLLM = async (_s: string, u: string) => {
    seenUsers.push(u)
    return seenUsers.length === 1
      ? '{"tool": "write", "args": {}}'
      : '{"final": {"verdicts": []}}'
  }
  const r = await runAgentLoop({
    callLLM, system: 'sys', user: '材料',
    tools: { execute: async (t) => `未知工具:${t}` }, maxRounds: 5, timeBudgetMs: 60_000,
  })
  expect(r.stopReason).toBe('final')
  expect(seenUsers[1]).toContain('未知工具')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/agent-loop.test.ts`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现 agentLoop.ts**

```ts
// src/memory/agentLoop.ts
import { extractJsonObject } from './pure'
import type { LLMCall } from '@/llm'
import type { RepoTools } from './repoTools'

export interface AgentStep {
  kind: 'tool' | 'final' | 'correction'
  /** 该轮模型回复的原文(截断 500 字符,落盘用)。 */
  text: string
  toolName?: string
  /** 工具结果(截断 500 字符,落盘用)。 */
  toolResult?: string
}

export interface AgentLoopResult {
  /** 模型的最终判决 JSON(已 parse)。预算耗尽且强制收尾失败 / LLM 报错时为 null。 */
  final: unknown | null
  trace: AgentStep[]
  stopReason: 'final' | 'rounds-budget' | 'time-budget' | 'llm-error'
}

export interface AgentLoopOpts {
  callLLM: LLMCall
  system: string
  user: string
  tools: RepoTools
  maxRounds: number
  timeBudgetMs: number
}

const TRACE_CAP = 500

/**
 * 通用 agent 循环(spec §4.4)。与 callWithRetry 的根本区别:对话全程累积——
 * 初始材料、模型每轮回复、每次工具结果、每条纠正消息全部留在 user 侧文本里,
 * 模型看得到自己的完整试错历史(不会重复查同一词);格式纠错是末尾追加,不重置。
 *
 * 协议:模型每轮必须只输出一个 JSON 对象——
 *   {"tool": "grep"|"read"|"list", "args": {...}}  或  {"final": {...}}
 * 预算(maxRounds / timeBudgetMs)耗尽:追加强制收尾消息再试最后一轮;
 * 仍无 final -> final=null(调用方走全保留兜底)。
 */
export async function runAgentLoop(opts: AgentLoopOpts): Promise<AgentLoopResult> {
  const trace: AgentStep[] = []
  const deadline = Date.now() + opts.timeBudgetMs
  let conversation = opts.user
  let rounds = 0
  const FORCE_FINAL = '\n\n[系统] 预算已尽,请立即用已获取的信息输出 {"final": ...},不得再调用工具。'

  const callOnce = async (forced: boolean): Promise<'continue' | AgentLoopResult> => {
    let raw: string
    try {
      raw = await opts.callLLM(opts.system, conversation)
    } catch {
      return { final: null, trace, stopReason: 'llm-error' }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(extractJsonObject(raw))
    } catch {
      if (forced) return { final: null, trace, stopReason: rounds >= opts.maxRounds ? 'rounds-budget' : 'time-budget' }
      rounds++
      trace.push({ kind: 'correction', text: raw.slice(0, TRACE_CAP) })
      conversation += `\n\n[assistant]\n${raw}\n\n[系统] 你刚才的回复格式不对:必须只输出一个 JSON 对象(tool 或 final),不要 markdown 围栏,不要解释文字。`
      return 'continue'
    }
    const o = parsed as Record<string, unknown>
    if (o && typeof o === 'object' && 'final' in o) {
      trace.push({ kind: 'final', text: raw.slice(0, TRACE_CAP) })
      return { final: o.final, trace, stopReason: forced ? (rounds >= opts.maxRounds ? 'rounds-budget' : 'time-budget') : 'final' }
    }
    if (o && typeof o === 'object' && typeof o.tool === 'string') {
      if (forced) {
        // 强制收尾轮仍要工具:拒绝执行,记 correction,返回预算耗尽。
        trace.push({ kind: 'correction', text: raw.slice(0, TRACE_CAP) })
        return { final: null, trace, stopReason: rounds >= opts.maxRounds ? 'rounds-budget' : 'time-budget' }
      }
      rounds++
      const result = await opts.tools.execute(o.tool, (o.args ?? {}) as Record<string, unknown>)
      trace.push({ kind: 'tool', text: raw.slice(0, TRACE_CAP), toolName: o.tool, toolResult: result.slice(0, TRACE_CAP) })
      conversation += `\n\n[assistant]\n${raw}\n\n[工具结果]\n${result}`
      return 'continue'
    }
    if (forced) return { final: null, trace, stopReason: rounds >= opts.maxRounds ? 'rounds-budget' : 'time-budget' }
    rounds++
    trace.push({ kind: 'correction', text: raw.slice(0, TRACE_CAP) })
    conversation += `\n\n[assistant]\n${raw}\n\n[系统] 你刚才的回复格式不对:JSON 必须含 "tool" 或 "final" 键。`
    return 'continue'
  }

  while (rounds < opts.maxRounds && Date.now() < deadline) {
    const r = await callOnce(false)
    if (r !== 'continue') return r
  }
  // 预算耗尽:强制收尾最后一轮。
  conversation += FORCE_FINAL
  return callOnce(true) as Promise<AgentLoopResult>
}
```

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `bun test tests/agent-loop.test.ts && bun run typecheck && bun test`
Expected: 全绿(注意「强制收尾一轮成功」用例:maxRounds=3 时第 4 次调用是 forced,final 可取且 stopReason='rounds-budget')

- [ ] **Step 5: Commit**

```bash
git add src/memory/agentLoop.ts tests/agent-loop.test.ts
git commit -m "feat(memory): 通用 agent 循环——对话累积+JSON 协议+双预算+全保留兜底"
```

---

### Task 5: agent 判定器 + 调度分发(规则 prompt 复用 + 判决映射 + 模式二选一)

**Files:**
- Create: `src/memory/agentJudge.ts`、`src/memory/judgeConfig.ts`
- Modify: `src/memory/valueFilter.ts`(拆出 `VALUE_JUDGE_RULES` 常量;抽共享判决映射 `verdictsFromCategories`;导出新集合)
- Modify: `src/scheduler.ts:170-174`(judgeValue 调用处改模式分发)
- Modify: `src/web/ui-utils.ts:103-110`(`duplicate` 标签——Task 1 已加,本任务确认即可)
- Test: `tests/value-filter-prompt.test.ts`(新增,锁 prompt 字节不变)、`tests/agent-judge.test.ts`(新增)、`tests/scheduler-judge-dispatch.test.ts`(新增)

**Interfaces:**
- Consumes: `runAgentLoop`/`AgentStep`(Task 4);`makeRepoTools`(Task 3);`judgeValue`/`ValueVerdict`/`detectTaming`(valueFilter);`listApprovedByScope`(store.ts:125,取已审批标题清单);`DEFAULT_JUDGE_CONFIG`(本任务新建)。
- Produces:
  - `judgeConfig.ts`: `interface JudgeConfig { mode: 'quality' | 'economy'; maxRounds: number; timeBudgetS: number }`;`DEFAULT_JUDGE_CONFIG: JudgeConfig = { mode: 'quality', maxRounds: 30, timeBudgetS: 300 }`。Task 6 的 settings 持久化、Task 7 的回扫都 import 这两个。
  - `agentJudge.ts`: `judgeValueAgentic(candidates: DistillCandidate[], opts: AgentJudgeOpts): Promise<AgentJudgeResult>`;`AgentJudgeOpts = { callLLM: LLMCall; rootDir: string | null; approvedTitles: string[]; sourceKind: 'conversation' | 'subagent'; maxRounds: number; timeBudgetMs: number }`;`AgentJudgeResult = { verdicts: ValueVerdict[]; trace: AgentStep[] }`。**永不抛**(故障全保留兜底)。
  - `valueFilter.ts` 新导出: `VALUE_JUDGE_RULES: string`(判定规则段原文);`AGENT_VALID_CATEGORIES: ReadonlySet<string>`(9 类 + `'duplicate'`);`verdictsFromCategories(entries, candidates, validCategories): ValueVerdict[]`。
  - `TickDeps` 新增可选字段 `loadJudgeConfig?: () => JudgeConfig`(Task 6 daemon 接线;缺省 = `DEFAULT_JUDGE_CONFIG` 即质量模式)。

- [ ] **Step 1: 写「prompt 字节不变」回归锁测试(先锁现状,再重构)**

```ts
// tests/value-filter-prompt.test.ts
// 回归防护:Task 5 把 VALUE_JUDGE_SYSTEM_PROMPT 拆成 头+RULES+输出段 重组,
// 重组后必须与原字面量逐字节一致(判定规则文本语义零变更,spec Global Constraints)。
import { test, expect } from 'bun:test'
import { VALUE_JUDGE_SYSTEM_PROMPT, VALUE_JUDGE_RULES } from '@/memory/valueFilter'

const ORIGINAL = `You are memside-value-judge. Assign exactly one category to each candidate memory.

Each candidate carries an origin tag: user-stated (the user said it in this session),
user-confirmed (the agent proposed it and the user explicitly adopted it), or
agent-observed (the agent derived it on its own).
...(此处完整粘贴 valueFilter.ts:13-53 现有字面量,逐字)...
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
```

(实施时把 `ORIGINAL` 补全为当前 valueFilter.ts:13-53 的完整字符串。)

- [ ] **Step 2: 跑确认失败(VALUE_JUDGE_RULES 未导出)**

Run: `bun test tests/value-filter-prompt.test.ts`
Expected: FAIL

- [ ] **Step 3: 重构 valueFilter.ts(拆 prompt + 抽共享映射,行为零变更)**

把 `VALUE_JUDGE_SYSTEM_PROMPT` 拆为三段再拼回:

```ts
const VALUE_JUDGE_HEADER = `You are memside-value-judge. Assign exactly one category to each candidate memory.\n\n`
export const VALUE_JUDGE_RULES = `Each candidate carries an origin tag: ...（现有第 14-44 行逐字）...still bind or inform? ("let's stop here for today" -> no; "every change lands via branch + PR" -> yes.)`
const VALUE_JUDGE_OUTPUT_SECTION = `\n\n输出格式如下（仅示范结构，勿照抄内容；只输出这一个 JSON 对象，无 markdown 围栏，无解释文字）：\n...(现有第 46-53 行逐字)...\nEmit one verdict per candidate, keyed by index.`
export const VALUE_JUDGE_SYSTEM_PROMPT = VALUE_JUDGE_HEADER + VALUE_JUDGE_RULES + VALUE_JUDGE_OUTPUT_SECTION
```

抽共享判决映射(`judgeValueBase` 内的逐条映射逻辑原样搬入,stated 免疫兜底、幻觉类别兜底语义不变):

```ts
export const AGENT_VALID_CATEGORIES: ReadonlySet<string> = new Set([
  'user-rule', 'decision', 'preference', 'convention', 'trap', 'topology',
  'public-knowledge', 'derivable', 'fleeting', 'duplicate',
])

/**
 * 逐条 verdict 映射(经济/质量共用):discard 类 -> keep:false;retain 类 -> keep+valueClass;
 * 非法类别/缺漏下标 -> 保守 keep(stated->decision,observed->null);
 * stated 免疫硬兜底:origin 非 agent-observed 被判 derivable -> 改判 keep+decision
 * (spec §R2 回归锁;duplicate 不免疫——用户复述一条已审批记忆同样是重复)。
 */
export function verdictsFromCategories(
  entries: { index: number; category: string }[],
  candidates: DistillCandidate[],
  validCategories: ReadonlySet<string>,
  discardCategories: ReadonlySet<string>,
): ValueVerdict[] {
  const n = candidates.length
  const byIndex = new Map<number, ValueVerdict>()
  for (const v of entries) {
    if (typeof v.index !== 'number' || v.index < 0 || v.index >= n) continue
    if (!validCategories.has(v.category)) {
      byIndex.set(v.index, { index: v.index, keep: true,
        valueClass: candidates[v.index]!.origin === 'agent-observed' ? null : 'decision' })
      continue
    }
    if (discardCategories.has(v.category)) {
      if (v.category === 'derivable' && candidates[v.index]!.origin !== 'agent-observed') {
        byIndex.set(v.index, { index: v.index, keep: true, valueClass: 'decision' })
      } else {
        byIndex.set(v.index, { index: v.index, keep: false, reason: v.category as DiscardReason })
      }
    } else {
      byIndex.set(v.index, { index: v.index, keep: true, valueClass: VALUE_CLASS_MAP[v.category] })
    }
  }
  return candidates.map((c, i) => byIndex.get(i) ?? {
    index: i, keep: true,
    valueClass: c.origin === 'agent-observed' ? null : 'decision',
  })
}
```

`judgeValueBase` 改用 `verdictsFromCategories`(discard 集 = 现有三类);`judgeValue` 的 taming override 不动。

- [ ] **Step 4: 跑 valueFilter 全部既有测试 + 新回归锁**

Run: `bun test tests/value-filter-prompt.test.ts tests/origin-value-judgment.test.ts && bun run typecheck && bun test`
Expected: 全绿(字节锁通过 = 重构零行为变更)

- [ ] **Step 5: 写 agentJudge 失败测试**

```ts
// tests/agent-judge.test.ts
// 回归防护:agent 判定器=质量模式终审。锁:duplicate 第 10 类映射、
// stated 免疫(derivable 改判)与 duplicate 不免疫、LLM 故障全保留兜底、永不抛。
// spec: docs/superpowers/specs/2026-08-06-agentic-value-judge-design.md §4.5
import { test, expect } from 'bun:test'
import { judgeValueAgentic } from '@/memory/agentJudge'
import { DEFAULT_JUDGE_CONFIG } from '@/memory/judgeConfig'
import type { DistillCandidate } from '@/memory/distiller'

const cand = (title: string, origin: DistillCandidate['origin'] = 'agent-observed'): DistillCandidate => ({
  title, bodyMd: 'b', scopeType: 'project', runtime: 'claude-code',
  distillAction: 'new', origin, evidence: null, subjectSlug: null,
})
const base = {
  rootDir: null as string | null,  // 无仓库路径 -> 无工具循环也能判(工具全部返回错误文本)
  approvedTitles: [] as string[],
  sourceKind: 'conversation' as const,
  maxRounds: 5, timeBudgetMs: 60_000,
}

test('final verdicts 正常映射:retain 留 + duplicate 丢', async () => {
  const callLLM = async () => '{"final": {"verdicts": [{"index": 0, "category": "trap"}, {"index": 1, "category": "duplicate"}]}}'
  const { verdicts } = await judgeValueAgentic([cand('A'), cand('B')], { ...base, callLLM })
  expect(verdicts[0]).toEqual({ index: 0, keep: true, valueClass: 'trap' })
  expect(verdicts[1]).toEqual({ index: 1, keep: false, reason: 'duplicate' })
})

test('stated 免疫:用户陈述被判 derivable 改判 keep+decision;被判 duplicate 不免疫', async () => {
  const callLLM = async () => '{"final": {"verdicts": [{"index": 0, "category": "derivable"}, {"index": 1, "category": "duplicate"}]}}'
  const { verdicts } = await judgeValueAgentic(
    [cand('用户说的规则', 'user-stated'), cand('用户复述已审批规则', 'user-stated')], { ...base, callLLM })
  expect(verdicts[0]).toEqual({ index: 0, keep: true, valueClass: 'decision' })
  expect(verdicts[1]).toEqual({ index: 1, keep: false, reason: 'duplicate' })
})

test('LLM 全程报错:全保留兜底(stated->decision, observed->null),不抛', async () => {
  const callLLM = async () => { throw new Error('HTTP 502') }
  const { verdicts, trace } = await judgeValueAgentic(
    [cand('X', 'user-stated'), cand('Y', 'agent-observed')], { ...base, callLLM })
  expect(verdicts).toEqual([
    { index: 0, keep: true, valueClass: 'decision' },
    { index: 1, keep: true, valueClass: null },
  ])
  expect(trace.length).toBeGreaterThan(0)
})

test('DEFAULT_JUDGE_CONFIG: 质量模式默认 + 预算 30 轮/300 秒', () => {
  expect(DEFAULT_JUDGE_CONFIG).toEqual({ mode: 'quality', maxRounds: 30, timeBudgetS: 300 })
})
```

- [ ] **Step 6: 跑确认失败**

Run: `bun test tests/agent-judge.test.ts`
Expected: FAIL(模块不存在)

- [ ] **Step 7: 实现 judgeConfig.ts + agentJudge.ts**

```ts
// src/memory/judgeConfig.ts
/** 判定模式与 agent 预算(spec §4.6)。Task 6 落 app_settings;缺配置一律用默认。 */
export interface JudgeConfig {
  mode: 'quality' | 'economy'
  /** 每批候选工具轮次上限。 */
  maxRounds: number
  /** 每批候选时间预算(秒)。 */
  timeBudgetS: number
}
export const DEFAULT_JUDGE_CONFIG: JudgeConfig = { mode: 'quality', maxRounds: 30, timeBudgetS: 300 }
```

```ts
// src/memory/agentJudge.ts
import type { DistillCandidate } from '@/memory/distiller'
import type { LLMCall } from '@/llm'
import { runAgentLoop, type AgentStep } from './agentLoop'
import { makeRepoTools, type RepoTools } from './repoTools'
import {
  VALUE_JUDGE_HEADER, VALUE_JUDGE_RULES, AGENT_VALID_CATEGORIES,
  verdictsFromCategories, detectTaming, type ValueVerdict,
} from './valueFilter'

const AGENT_PROTOCOL_SECTION = `
10. duplicate - TEST: is this entry already covered by an existing approved memory
   (titles listed in the user message)? Same rule or fact, even if worded differently.
   Unlike derivable, duplicate MAY be assigned to user-stated/user-confirmed candidates:
   a user restating an already-approved rule is still a duplicate.

你可以使用三个只读工具亲手查验项目仓库(根目录见用户消息)再下判决。derivable 判定
应以亲手查验为准,不要凭猜。已审批记忆标题清单用于判 duplicate(语义重复即可,
不要求逐字相同);若两条候选或候选与清单互相矛盾,以更新、更持久的为准,被取代方判
fleeting。来源为 subagent 的候选:其 user 发言是任务工单,重点核对是否一次性任务约束。

每轮必须且只能输出一个 JSON 对象(无 markdown 围栏,无解释文字),二选一:
{"tool": "grep", "args": {"pattern": "要搜的文本", "path": "可选子路径"}}
{"tool": "read", "args": {"path": "文件路径", "startLine": 1, "endLine": 200}}
{"tool": "list", "args": {"path": "可选目录路径"}}
{"final": {"verdicts": [{"index": 0, "category": "decision"}, ...]}}
final 必须给每条候选一个 verdict(按输入 index);工具结果会以 [工具结果] 形式回给你。`

export const AGENT_JUDGE_SYSTEM_PROMPT = VALUE_JUDGE_HEADER + VALUE_JUDGE_RULES + AGENT_PROTOCOL_SECTION

export interface AgentJudgeOpts {
  callLLM: LLMCall
  /** 项目根目录;null = 无仓库可读(工具全部返回错误文本,agent 仍可凭材料判)。 */
  rootDir: string | null
  /** 同 scope(project ∪ global)已审批记忆标题清单(判 duplicate/矛盾用)。 */
  approvedTitles: string[]
  sourceKind: 'conversation' | 'subagent'
  maxRounds: number
  timeBudgetMs: number
}

export interface AgentJudgeResult {
  verdicts: ValueVerdict[]
  trace: AgentStep[]
}

const AGENT_DISCARD_CATEGORIES: ReadonlySet<string> = new Set(['public-knowledge', 'derivable', 'fleeting', 'duplicate'])

function renderAgentUserPrompt(candidates: DistillCandidate[], opts: AgentJudgeOpts): string {
  const cs = candidates.map((c, i) =>
    `[${i}] (origin: ${c.origin}, source: ${opts.sourceKind}) ${c.title}\n${c.bodyMd}${c.evidence ? `\n出处: ${c.evidence}` : ''}`,
  ).join('\n---\n')
  const titles = opts.approvedTitles.length > 0 ? opts.approvedTitles.join('\n') : '(none)'
  return `项目根目录: ${opts.rootDir ?? '(无可读仓库)'}\n已审批记忆标题:\n${titles}\n\n候选记忆:\n${cs}\n\n按系统指示逐条判定;需要查证时先用工具。`
}

/**
 * 质量模式判定器(spec §4.5):agent 终审全部候选。永不抛——任何故障
 * (LLM 报错/预算耗尽/格式乱)倒向 R3 全保留兜底。taming 守卫最后跑,覆盖 stated 免疫。
 */
export async function judgeValueAgentic(
  candidates: DistillCandidate[],
  opts: AgentJudgeOpts,
): Promise<AgentJudgeResult> {
  const n = candidates.length
  if (n === 0) return { verdicts: [], trace: [] }
  const keepAll = (): ValueVerdict[] =>
    candidates.map((c, i) => ({
      index: i, keep: true,
      valueClass: c.origin === 'agent-observed' ? null : 'decision',
    }))
  try {
    const tools: RepoTools = makeRepoTools(opts.rootDir ?? '/')
    const loop = await runAgentLoop({
      callLLM: opts.callLLM,
      system: AGENT_JUDGE_SYSTEM_PROMPT,
      user: renderAgentUserPrompt(candidates, opts),
      tools, maxRounds: opts.maxRounds, timeBudgetMs: opts.timeBudgetMs,
    })
    const final = loop.final as { verdicts?: unknown } | null
    if (!final || !Array.isArray(final.verdicts)) return { verdicts: keepAll(), trace: loop.trace }
    const entries = (final.verdicts as unknown[]).filter(
      (v): v is { index: number; category: string } =>
        !!v && typeof v === 'object' &&
        typeof (v as { index?: unknown }).index === 'number' &&
        typeof (v as { category?: unknown }).category === 'string',
    )
    const mapped = verdictsFromCategories(entries, candidates, AGENT_VALID_CATEGORIES, AGENT_DISCARD_CATEGORIES)
    const verdicts = mapped.map((v, i) =>
      detectTaming(candidates[i]!.title, candidates[i]!.bodyMd)
        ? { index: i, keep: false as const, reason: 'taming' as const }
        : v,
    )
    return { verdicts, trace: loop.trace }
  } catch {
    return { verdicts: keepAll(), trace: [] }
  }
}
```

(注意 `verdictsFromCategories` 需从 valueFilter 导出 `VALUE_CLASS_MAP` 可见性——将其改为模块内共享即可,不必导出。)

- [ ] **Step 8: scheduler 模式分发 + trace 落盘**

`src/scheduler.ts`:import 加 `judgeValueAgentic`、`DEFAULT_JUDGE_CONFIG`、`JudgeConfig`、`AgentStep`、`existsSync`(node:fs)、`listApprovedByScope`。`TickDeps` 加:

```ts
  /** 判定配置(模式+预算);缺省 DEFAULT_JUDGE_CONFIG(质量模式)。Task 6 daemon 接 app_settings。 */
  loadJudgeConfig?: () => JudgeConfig
```

`const verdicts = await judgeValue(deduped, deps.callLLM)` 替换为:

```ts
      const judgeCfg = deps.loadJudgeConfig?.() ?? DEFAULT_JUDGE_CONFIG
      let verdicts: ValueVerdict[]
      let agentTrace: AgentStep[] | null = null
      if (judgeCfg.mode === 'economy' || deduped.length === 0) {
        verdicts = await judgeValue(deduped, deps.callLLM)
      } else {
        // 质量模式(spec §4.5):agent 终审。已审批标题清单查询失败 -> 空清单降级;
        // job.cwd 目录不存在 -> rootDir=null(工具全部返错文本,agent 凭材料判)。
        let approvedTitles: string[] = []
        try {
          const set = await listApprovedByScope(db, { projectId: job.cwd ?? 'unknown' })
          approvedTitles = [...set.byScope.project, ...set.byScope.global].map((m) => m.title).slice(0, 100)
        } catch (e) { console.warn('memside: listApprovedByScope failed', e) }
        const rootDir = job.cwd && existsSync(job.cwd) ? job.cwd : null
        const r = await judgeValueAgentic(deduped, {
          callLLM: deps.callLLM, rootDir, approvedTitles,
          sourceKind: job.sourceAgentId ? 'subagent' : 'conversation',
          maxRounds: judgeCfg.maxRounds, timeBudgetMs: judgeCfg.timeBudgetS * 1000,
        })
        verdicts = r.verdicts
        agentTrace = r.trace
      }
```

`saveDistillRun` 的 `rawOutput` 实参改为(trace 合并,形状向后兼容:`.candidates` 键不动,加可选 `agentTrace`):

```ts
          rawOutput: agentTrace
            ? { ...(rawOutput && typeof rawOutput === 'object' ? rawOutput as Record<string, unknown> : { raw: rawOutput ?? null }), agentTrace }
            : rawOutput,
```

- [ ] **Step 9: 写调度分发测试**

```ts
// tests/scheduler-judge-dispatch.test.ts
// 回归防护:模式开关必须选对执行者;缺配置默认质量;agent 故障不得让 job 失败(全保留)。
// spec: docs/superpowers/specs/2026-08-06-agentic-value-judge-design.md §4.6/§6
import { test, expect } from 'bun:test'
// (种子 job + mock loadTranscript + mock callLLM,模式同 tests/scheduler.test.ts 现有 harness)

test('缺 loadJudgeConfig -> 默认质量模式(agent 路径,候选全保留入库)', async () => { /* callLLM 第一次返回蒸馏 JSON(1 候选),第二次(agent 首轮)返回 {"final":{"verdicts":[{"index":0,"category":"trap"}]}};断言 createCandidate 被调且 valueClass='trap' */ })

test('mode=economy -> 走单发 judge(第二次调用返回 9 类 verdicts JSON)', async () => { /* 断言 economy 下 agent 协议不出现:第二次调用的 system 含 VALUE_JUDGE 单发输出段、不含「每轮必须且只能输出一个 JSON 对象」 */ })

test('质量模式 agent LLM 报错 -> 候选仍入库(全保留兜底),job done 非 failed', async () => { /* callLLM 第二次起抛错;断言 createCandidate 被调,job status=done */ })
```

(实施时按 scheduler.test.ts 现有 harness 展开这三个用例的完整代码;上面注释即逐步指令。)

- [ ] **Step 10: 全量回归**

Run: `bun test tests/agent-judge.test.ts tests/scheduler-judge-dispatch.test.ts tests/value-filter-prompt.test.ts && bun run typecheck && bun test`
Expected: 全绿

- [ ] **Step 11: Commit**

```bash
git add src/memory/agentJudge.ts src/memory/judgeConfig.ts src/memory/valueFilter.ts src/scheduler.ts tests/value-filter-prompt.test.ts tests/agent-judge.test.ts tests/scheduler-judge-dispatch.test.ts
git commit -m "feat(memory): agent 判定器(质量模式)+调度模式分发,duplicate 第 10 类"
```

---

### Task 6: 配置面(模式 + 预算持久化 + server + Web UI + daemon 接线)

**Files:**
- Modify: `src/settings.ts`(judge 配置读写)
- Modify: `src/server.ts`(`GET/PUT /api/settings/judge`,注册在 `/api/settings/llm` 组旁,server.ts:489-548)
- Modify: `src/web/api.ts`(两个 wrapper)
- Modify: `src/web/App.tsx`(设置区加「判定」小节,沿用现有 inline-style)
- Modify: `src/daemon.ts`(tickDeps 接 `loadJudgeConfig`)
- Test: `tests/settings-judge.test.ts`(新增)、`tests/settings-api.test.ts`(追加用例)

**Interfaces:**
- Consumes: `JudgeConfig`/`DEFAULT_JUDGE_CONFIG`(Task 5);`appSettings` 表读写模式(settings.ts:44-67 的 upsert 模式)。
- Produces: `loadJudgeConfig(db: DbClient): JudgeConfig`(非法/缺失逐字段回默认;maxRounds 夹取 1..200,timeBudgetS 夹取 30..3600);`saveJudgeConfig(db: DbClient, patch: Partial<JudgeConfig>): void`;daemon `TickDeps.loadJudgeConfig` 实装。Task 7 的回扫从 server 拿同一 `loadJudgeConfig`。

- [ ] **Step 1: 写失败测试**

```ts
// tests/settings-judge.test.ts
// 回归防护:判定配置逐字段容错回默认(脏数据不得把判定器配死);夹取范围防 0 轮/天价预算。
import { test, expect } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/db/client'
import { loadJudgeConfig, saveJudgeConfig } from '../src/settings'
import { DEFAULT_JUDGE_CONFIG } from '@/memory/judgeConfig'
import { appSettings } from '@/db/schema'

function tmpDb() { return openDb(join(mkdtempSync(join(tmpdir(), 'memside-judge-cfg-')), 't.db')) }

test('未配置 -> 全默认(质量/30/300)', () => {
  expect(loadJudgeConfig(tmpDb())).toEqual(DEFAULT_JUDGE_CONFIG)
})

test('保存后读回;部分字段保存其余回默认', () => {
  const db = tmpDb()
  saveJudgeConfig(db, { mode: 'economy' })
  expect(loadJudgeConfig(db)).toEqual({ mode: 'economy', maxRounds: 30, timeBudgetS: 300 })
})

test('脏数据容错:非法 mode/非数字/超范围逐字段回默认或夹取', () => {
  const db = tmpDb()
  const up = (key: string, value: string) =>
    db.insert(appSettings).values({ key, value, updatedAt: Date.now() })
      .onConflictDoUpdate({ target: appSettings.key, set: { value } }).run()
  up('judge.mode', 'banana')
  up('judge.max_rounds', '999')
  up('judge.time_budget_s', 'abc')
  expect(loadJudgeConfig(db)).toEqual({ mode: 'quality', maxRounds: 200, timeBudgetS: 300 })
})
```

- [ ] **Step 2: 跑确认失败**

Run: `bun test tests/settings-judge.test.ts`
Expected: FAIL(函数未导出)

- [ ] **Step 3: 实现 settings.ts 读写**

`src/settings.ts` 末尾追加:

```ts
import type { JudgeConfig } from '@/memory/judgeConfig'
import { DEFAULT_JUDGE_CONFIG } from '@/memory/judgeConfig'

const JUDGE_KEYS = { mode: 'judge.mode', maxRounds: 'judge.max_rounds', timeBudgetS: 'judge.time_budget_s' } as const
const MAX_ROUNDS_RANGE = [1, 200] as const
const TIME_BUDGET_RANGE = [30, 3600] as const

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

/** 判定配置读取:缺失/非法逐字段回默认;数字夹取到合法区间。 */
export function loadJudgeConfig(db: DbClient): JudgeConfig {
  const rows = db.select().from(appSettings).all()
  const map = new Map(rows.map((r) => [r.key, r.value]))
  const mode = map.get(JUDGE_KEYS.mode)
  const rounds = Number(map.get(JUDGE_KEYS.maxRounds))
  const budget = Number(map.get(JUDGE_KEYS.timeBudgetS))
  return {
    mode: mode === 'quality' || mode === 'economy' ? mode : DEFAULT_JUDGE_CONFIG.mode,
    maxRounds: Number.isFinite(rounds) && map.has(JUDGE_KEYS.maxRounds)
      ? clamp(Math.round(rounds), MAX_ROUNDS_RANGE[0], MAX_ROUNDS_RANGE[1]) : DEFAULT_JUDGE_CONFIG.maxRounds,
    timeBudgetS: Number.isFinite(budget) && map.has(JUDGE_KEYS.timeBudgetS)
      ? clamp(Math.round(budget), TIME_BUDGET_RANGE[0], TIME_BUDGET_RANGE[1]) : DEFAULT_JUDGE_CONFIG.timeBudgetS,
  }
}

/** 判定配置字段级保存(提供的字段才写,同 saveUiLlmConfig 的字段级语义)。 */
export function saveJudgeConfig(db: DbClient, patch: Partial<JudgeConfig>): void {
  const upsert = (key: string, value: string) => {
    db.insert(appSettings).values({ key, value, updatedAt: Date.now() })
      .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: Date.now() } }).run()
  }
  if (patch.mode !== undefined) upsert(JUDGE_KEYS.mode, patch.mode)
  if (patch.maxRounds !== undefined) upsert(JUDGE_KEYS.maxRounds, String(patch.maxRounds))
  if (patch.timeBudgetS !== undefined) upsert(JUDGE_KEYS.timeBudgetS, String(patch.timeBudgetS))
}
```

- [ ] **Step 4: server 端点 + settings-api 追加用例**

`src/server.ts` 在 `/api/settings/llm` 组后追加:

```ts
  app.get('/api/settings/judge', (c) => c.json(loadJudgeConfig(db)))

  app.put('/api/settings/judge', async (c) => {
    const body = await c.req.json().catch(() => null)
    if (!body || typeof body !== 'object') return c.json({ error: 'invalid body' }, 400)
    const b = body as Record<string, unknown>
    if (b.mode !== undefined && b.mode !== 'quality' && b.mode !== 'economy') return c.json({ error: 'invalid mode' }, 400)
    for (const k of ['maxRounds', 'timeBudgetS'] as const) {
      if (b[k] !== undefined && (typeof b[k] !== 'number' || !Number.isFinite(b[k]))) return c.json({ error: `invalid ${k}` }, 400)
    }
    saveJudgeConfig(db, b as Partial<JudgeConfig>)
    broadcast('settings')
    return c.json(loadJudgeConfig(db))
  })
```

(import 加 `loadJudgeConfig, saveJudgeConfig`;`broadcast('settings')` 沿用现有 WS 广播约定——若现有设置保存无广播则省略,与邻近代码保持一致。)

`tests/settings-api.test.ts` 追加:GET 默认 → PUT `{mode:'economy', maxRounds:10}` → GET 读回;PUT 非法 mode → 400。

- [ ] **Step 5: Web UI(设置区「判定」小节)**

`src/web/api.ts` 加:

```ts
export interface JudgeConfigDto { mode: 'quality' | 'economy'; maxRounds: number; timeBudgetS: number }
export async function fetchJudgeConfig(): Promise<JudgeConfigDto> {
  const res = await fetch('/api/settings/judge')
  return res.json()
}
export async function saveJudgeConfig(patch: Partial<JudgeConfigDto>): Promise<JudgeConfigDto> {
  const res = await fetch('/api/settings/judge', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
  })
  return res.json()
}
```

`src/web/App.tsx` 在 LLM 设置区旁加「判定」小节(复用现有输入框/按钮 inline-style):模式下拉(质量=agent 终审 / 经济=单发判定)、两个数字输入(轮次上限 1-200、时间预算 30-3600 秒)、保存按钮、保存后回显当前生效值。加一条源码文本断言测试(沿用现有 web 文本断言模式):

```ts
// tests 追加到现有 web 断言文件或新建 tests/web-judge-settings.test.ts:
// 锁「判定」小节存在且默认展示质量模式,防止 UI 回退。
expect(appSrc).toContain('判定')
expect(appSrc).toContain('/api/settings/judge')
```

- [ ] **Step 6: daemon 接线**

`src/daemon.ts` tickDeps 组装处加(import `loadJudgeConfig` from './settings'):

```ts
    loadJudgeConfig: () => loadJudgeConfig(db),
```

- [ ] **Step 7: 全量回归**

Run: `bun test tests/settings-judge.test.ts tests/settings-api.test.ts && bun run typecheck && bun test`
Expected: 全绿

- [ ] **Step 8: Commit**

```bash
git add src/settings.ts src/server.ts src/web/api.ts src/web/App.tsx src/daemon.ts tests/settings-judge.test.ts tests/settings-api.test.ts
git commit -m "feat(settings): 判定模式+agent 预算配置面(持久化/server/UI/daemon 接线)"
```

---

### Task 7: 存量回扫(按钮 + 后台批处理 + 进度 + 审计)

**Files:**
- Modify: `src/memory/store.ts`(新增 `listAllCandidatesForRescan`、`updateJudgedFields`)
- Create: `src/memory/rescan.ts`
- Modify: `src/server.ts`(`POST /api/rescan` + `/api/status` 加 rescan 进度)
- Modify: `src/web/api.ts`、`src/web/App.tsx`(候选 tab「回扫存量」按钮 + 进度行)
- Test: `tests/rescan.test.ts`(新增)、`tests/server.test.ts`(追加 202/409 用例)

**Interfaces:**
- Consumes: `judgeValue`(经济)/`judgeValueAgentic`(质量,Task 5);`loadJudgeConfig`(Task 6);`logDiscards`(store.ts:412);`listApprovedByScope`;`memoryDistillJobs` 表直接 insert(schema.ts)。
- Produces:
  - `store.ts`: `listAllCandidatesForRescan(db: DbClient): Promise<Memory[]>`(status='candidate',createdAt 升序);`updateJudgedFields(db: DbClient, id: string, patch: { valueClass?: ValueClass | null; origin?: string | null }): Promise<void>`(仅填 NULL 字段,不覆盖已有值)。
  - `rescan.ts`: `rescanCandidates(db: DbClient, deps: RescanDeps, onProgress?: (done: number, total: number) => void): Promise<RescanReport>`;`RescanDeps = { callLLM: LLMCall; loadJudgeConfig: () => JudgeConfig }`;`RescanReport = { processed: number; discarded: number; skipped: number; keptUpdated: number }`。

- [ ] **Step 1: 写失败测试**

```ts
// tests/rescan.test.ts
// 回归防护:回扫是「重判」不是「清库」——判丢进 discards+status=rejected(双写,可恢复),
// 判留只补 NULL 字段,目录缺失跳过,重跑不重复判(已 rejected 离开候选池)。
// spec: docs/superpowers/specs/2026-08-06-agentic-value-judge-design.md §4.7
import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { openDb } from '@/db/client'
import { memories, memoryDiscards } from '@/db/schema'
import { createCandidate, getMemoryById } from '@/memory/store'
import { rescanCandidates } from '@/memory/rescan'
import { DEFAULT_JUDGE_CONFIG } from '@/memory/judgeConfig'

const root = join(import.meta.dir, '.tmp-rescan')
let dir = ''
let db: ReturnType<typeof openDb>
beforeAll(() => { rmSync(root, { recursive: true, force: true }); mkdirSync(root, { recursive: true }) })
beforeEach(() => { dir = join(root, Math.random().toString(36).slice(2)); mkdirSync(dir, { recursive: true }); db = openDb(join(dir, 't.db')) })
afterEach(() => { db.$client.close() })

// 经济模式单发 judge 的 mock:第一条判丢(derivable),其余判留(decision)
const economyLLM = async () => '{"verdicts": [{"index": 0, "category": "derivable"}, {"index": 1, "category": "decision"}]}'

test('回扫:判丢进 discards + status=rejected;判留补 valueClass;目录缺失跳过', async () => {
  await createCandidate(db, {
    scopeType: 'project', scopeId: dir, title: '[category:a] 实现复述一条', bodyMd: 'b',
    tags: [], sourceKind: 'conversation', sourceCwd: dir, runtime: 'claude-code', origin: 'agent-observed',
  })
  await createCandidate(db, {
    scopeType: 'project', scopeId: dir, title: '[category:trap] 真坑一条', bodyMd: 'b',
    tags: [], sourceKind: 'conversation', sourceCwd: dir, runtime: 'claude-code', origin: 'agent-observed',
  })
  await createCandidate(db, {
    scopeType: 'project', scopeId: '/不存在/已删除目录', title: '[category:a] 目录没了', bodyMd: 'b',
    tags: [], sourceKind: 'conversation', sourceCwd: '/不存在/已删除目录', runtime: 'claude-code',
  })
  const report = await rescanCandidates(db, {
    callLLM: economyLLM, loadJudgeConfig: () => ({ ...DEFAULT_JUDGE_CONFIG, mode: 'economy' }),
  })
  expect(report).toEqual({ processed: 3, discarded: 1, skipped: 1, keptUpdated: 1 })
  const discards = await db.select().from(memoryDiscards)
  expect(discards).toHaveLength(1)
  expect(discards[0]!.reason).toBe('derivable')
  const rows = await db.select().from(memories)
  const byTitle = new Map(rows.map((r) => [r.title, r]))
  expect(byTitle.get('[category:a] 实现复述一条')!.status).toBe('rejected')
  expect(byTitle.get('[category:trap] 真坑一条')!.status).toBe('candidate')
  expect(byTitle.get('[category:trap] 真坑一条')!.valueClass).toBe('decision')
  expect(byTitle.get('[category:a] 目录没了')!.status).toBe('candidate')  // 跳过不动
})

test('重跑幂等:已 rejected 的不再处理', async () => {
  await createCandidate(db, {
    scopeType: 'project', scopeId: dir, title: '[category:a] 实现复述一条', bodyMd: 'b',
    tags: [], sourceKind: 'conversation', sourceCwd: dir, runtime: 'claude-code', origin: 'agent-observed',
  })
  const deps = { callLLM: economyLLM, loadJudgeConfig: () => ({ ...DEFAULT_JUDGE_CONFIG, mode: 'economy' }) }
  await rescanCandidates(db, deps)
  const second = await rescanCandidates(db, deps)
  expect(second.processed).toBe(0)
  expect(await db.select().from(memoryDiscards)).toHaveLength(1)  // 没有第二条审计
})
```

- [ ] **Step 2: 跑确认失败**

Run: `bun test tests/rescan.test.ts`
Expected: FAIL(模块不存在)

- [ ] **Step 3: store 两个新函数**

`src/memory/store.ts` 末尾追加:

```ts
/** 回扫用:全部候选(createdAt 升序,先老后新)。 */
export async function listAllCandidatesForRescan(db: DbClient): Promise<Memory[]> {
  const rows = await db.select().from(memories).where(eq(memories.status, 'candidate'))
    .orderBy(asc(memories.createdAt)).all()
  return rows.map(rowToMemory)  // 复用文件内既有行映射(若无统一映射函数,按邻近函数投影)
}

/** 回扫判留回填:只填 NULL 字段(value_class/origin),不覆盖已有值。 */
export async function updateJudgedFields(
  db: DbClient, id: string, patch: { valueClass?: ValueClass | null; origin?: string | null },
): Promise<void> {
  const rows = await db.select().from(memories).where(eq(memories.id, id)).limit(1).all()
  const m = rows[0]
  if (!m) return
  const set: Record<string, unknown> = {}
  if (m.valueClass === null && patch.valueClass !== undefined) set.valueClass = patch.valueClass
  if (m.origin === null && patch.origin) set.origin = patch.origin
  if (Object.keys(set).length > 0) await db.update(memories).set(set).where(eq(memories.id, id)).run()
}
```

(import 按文件现有头部补 `ValueClass`;`asc` 已在用。)

- [ ] **Step 4: 实现 rescan.ts**

```ts
// src/memory/rescan.ts
import { existsSync } from 'node:fs'
import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import { memoryDistillJobs } from '@/db/schema'
import type { LLMCall } from '@/llm'
import type { DistillCandidate } from '@/memory/distiller'
import type { MemoryScope } from '@/memory/pure'
import { judgeValue } from '@/memory/valueFilter'
import { judgeValueAgentic } from '@/memory/agentJudge'
import { DEFAULT_JUDGE_CONFIG, type JudgeConfig } from '@/memory/judgeConfig'
import {
  listAllCandidatesForRescan, listApprovedByScope, logDiscards, updateJudgedFields,
  type Memory,
} from '@/memory/store'

export interface RescanDeps {
  callLLM: LLMCall
  loadJudgeConfig: () => JudgeConfig
}

export interface RescanReport {
  processed: number
  discarded: number
  skipped: number
  keptUpdated: number
}

const RESCAN_BATCH = 15

const toCandidate = (m: Memory): DistillCandidate => ({
  title: m.title, bodyMd: m.bodyMd, scopeType: m.scopeType as MemoryScope,
  runtime: m.runtime, distillAction: 'new',
  origin: (m as { origin?: DistillCandidate['origin'] | null }).origin ?? 'agent-observed',
  evidence: (m as { evidence?: string | null }).evidence ?? null,
  subjectSlug: (m as { subjectSlug?: string | null }).subjectSlug ?? null,
})

/**
 * 存量回扫(spec §4.7):按当前判定模式重判全部候选。判丢 -> memory_discards(可恢复)
 * + memories.status='rejected'(离开候选池,天然不重复判);判留 -> 只补 NULL 的
 * value_class/origin;仓库目录已删除的跳过不动。任何单批故障倒向保留(该批只记 keptUpdated)。
 */
export async function rescanCandidates(
  db: DbClient, deps: RescanDeps,
  onProgress?: (done: number, total: number) => void,
): Promise<RescanReport> {
  const all = await listAllCandidatesForRescan(db)
  const report: RescanReport = { processed: 0, discarded: 0, skipped: 0, keptUpdated: 0 }
  if (all.length === 0) return report
  // 审计行挂一个合成 job 行(distill_job_id NOT NULL + FK)。
  const jobId = ulid()
  const now = Date.now()
  await db.insert(memoryDistillJobs).values({
    id: jobId, debounceKey: `rescan:${jobId}`, sourceEventId: `rescan:${jobId}`,
    runtime: 'claude-code', cwd: '(rescan)', sessionId: null, sourceAgentId: null,
    status: 'done', attempts: 0, nextRunAt: now, createdAt: now, finishedAt: now,
  })
  const cfg = deps.loadJudgeConfig?.() ?? DEFAULT_JUDGE_CONFIG
  // 按仓库根分组(目录缺失的整组跳过)。
  const byRoot = new Map<string, Memory[]>()
  for (const m of all) {
    const rootDir = ((m as { sourceCwd?: string | null }).sourceCwd ?? m.scopeId ?? '')
    if (!byRoot.has(rootDir)) byRoot.set(rootDir, [])
    byRoot.get(rootDir)!.push(m)
  }
  for (const [rootDir, group] of byRoot) {
    if (!rootDir || !existsSync(rootDir)) {
      report.skipped += group.length
      report.processed += group.length
      onProgress?.(report.processed, all.length)
      continue
    }
    let approvedTitles: string[] = []
    try {
      const set = await listApprovedByScope(db, { projectId: rootDir })
      approvedTitles = [...set.byScope.project, ...set.byScope.global].map((m) => m.title).slice(0, 100)
    } catch { approvedTitles = [] }
    for (let i = 0; i < group.length; i += RESCAN_BATCH) {
      const batch = group.slice(i, i + RESCAN_BATCH)
      const cands = batch.map(toCandidate)
      const verdicts = cfg.mode === 'economy'
        ? await judgeValue(cands, deps.callLLM)
        : (await judgeValueAgentic(cands, {
            callLLM: deps.callLLM, rootDir, approvedTitles,
            sourceKind: 'conversation', maxRounds: cfg.maxRounds, timeBudgetMs: cfg.timeBudgetS * 1000,
          })).verdicts
      for (let j = 0; j < batch.length; j++) {
        const v = verdicts[j]
        const m = batch[j]!
        if (v && !v.keep) {
          try {
            await logDiscards(db, jobId, [{
              title: m.title, bodyMd: m.bodyMd, reason: v.reason,
              scopeType: m.scopeType, scopeId: m.scopeId,
              sourceCwd: rootDir, runtime: m.runtime,
              sourceKind: ((m as { sourceKind?: string }).sourceKind === 'subagent' ? 'subagent' : 'conversation'),
            }])
            await db.update(memories).set({ status: 'rejected' }).where(eq(memories.id, m.id)).run()
            report.discarded++
          } catch (e) { console.warn('memside: rescan discard failed', e) }
        } else {
          try {
            await updateJudgedFields(db, m.id, {
              valueClass: v?.keep ? v.valueClass : undefined,
              origin: (m as { origin?: string | null }).origin ?? undefined,
            })
            report.keptUpdated++
          } catch (e) { console.warn('memside: rescan update failed', e) }
        }
      }
      report.processed += batch.length
      onProgress?.(report.processed, all.length)
    }
  }
  return report
}
```

(import 补 `eq` from drizzle-orm、`memories` from schema——按文件头实际写。)

- [ ] **Step 5: server 端点 + 进度暴露**

`src/server.ts`:

```ts
// 模块级回扫状态(单实例;fire-and-forget 与 distill loop 同款)。
let rescanState: { running: boolean; done: number; total: number; report: RescanReport | null } =
  { running: false, done: 0, total: 0, report: null }

app.post('/api/rescan', (c) => {
  if (rescanState.running) return c.json({ error: 'rescan already running' }, 409)
  rescanState = { running: true, done: 0, total: 0, report: null }
  void (async () => {
    try {
      const report = await rescanCandidates(db, {
        callLLM: resolveCallLLM(),  // 与 daemon 注入的 callLLM 一致——用 AppDeps 现有 callLLM 字段
        loadJudgeConfig: () => loadJudgeConfig(db),
      }, (done, total) => { rescanState.done = done; rescanState.total = total })
      rescanState.report = report
    } catch (e) {
      console.warn('memside: rescan failed', e)
    } finally {
      rescanState.running = false
      broadcast('rescan')
    }
  })()
  return c.json({ started: true }, 202)
})
```

`/api/status` 响应体加 `rescan: rescanState`。`AppDeps` 若无现成 `callLLM` 则加一个可选注入(与 daemon 现有 deps 传递方式一致);测试用 mock。

`tests/server.test.ts` 追加:POST → 202;运行中再 POST → 409。

- [ ] **Step 6: Web UI 按钮 + 进度**

`src/web/api.ts` 加 `startRescan(): Promise<void>`(POST /api/rescan)。`src/web/App.tsx` 候选 tab 工具行加「回扫存量」按钮(复用现有按钮 inline-style);点击后调 startRescan,轮询 `/api/status` 的 `rescan` 字段显示「回扫中 done/total」或完成报告「处理 N / 判丢 M / 跳过 K」。加源码文本断言(锁按钮与端点字符串):

```ts
expect(appSrc).toContain('回扫存量')
expect(appSrc).toContain('/api/rescan')
```

- [ ] **Step 7: 全量回归**

Run: `bun test tests/rescan.test.ts tests/server.test.ts && bun run typecheck && bun test`
Expected: 全绿

- [ ] **Step 8: Commit**

```bash
git add src/memory/store.ts src/memory/rescan.ts src/server.ts src/web/api.ts src/web/App.tsx tests/rescan.test.ts tests/server.test.ts
git commit -m "feat(memory): 存量回扫——按当前模式重判候选,判丢双写可恢复"
```

---

## Self-Review 记录(计划落档前已执行)

1. **Spec 覆盖**:spec §4.1→Task 1;§4.2→Task 2;§4.3→Task 3;§4.4→Task 4;§4.5→Task 5;§4.6→Task 6;§4.7→Task 7;§6 失败矩阵→各任务兜底测试;§7 测试策略→每任务 TDD 步骤 + 门禁回归锁。无缺口。
2. **类型一致**:`JudgeConfig`/`DEFAULT_JUDGE_CONFIG`(Task 5 产 → Task 6/7 消费);`AgentStep`(Task 4 产 → Task 5 消费);`RepoTools.execute`(Task 3 产 → Task 4 消费);`loadJudgeConfig(db)`(Task 6 产 → Task 7 消费);`verdictsFromCategories`(Task 5 内 valueFilter 重构,agentJudge 同文件链消费)。已核对签名一致。
3. **Placeholder 扫描**:Task 5 Step 1 的 `ORIGINAL` 字面量与 Step 9 的三个调度测试需实施时展开完整代码(已注明展开指令与锁点),其余步骤均为可执行完整代码。
4. **已知风险**(实施时注意):Task 5 valueFilter 重构是字节级敏感操作,必须先跑 Step 1 的回归锁(红)再重构(绿);Task 7 双写(discards + status)非事务,接受低频手动操作的权衡(与 promoteDiscard 既有先例一致)。

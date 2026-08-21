# 合并步 update_of targetId 必挂修复（prompt 分区 + 重试收敛）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复合并步确定性失败——prompt 分区渲染 approved/candidate 既有记忆、系统提示改为可执行规则、重试报错携带合法 targetId 引导。

**Architecture:** 改动集中在 `src/memory/consolidate.ts` 单文件：`renderUserPrompt`（导出 + 分区）、`CONSOLIDATE_SYSTEM_PROMPT`（规则改写 + 示例占位符）、`consolidateShouldRetry`（报错附引导）。校验语义（approvedIds 过滤、parseConsolidate 兜底 keep）不动。

**Tech Stack:** Bun + bun:test；纯函数层测试。

**Spec:** `docs/superpowers/specs/2026-08-20-consolidate-update-of-target-prompt-design.md`

## Global Constraints

- 工作目录：worktree `C:\Users\admin\Desktop\memside\.claude\worktrees\fix-consolidate-update-of-target`，分支 `fix/consolidate-update-of-target-prompt`（已从最新 origin/master 切出）。**禁止 checkout 主仓库分支。**
- 测试一律 `bun test`（严禁 `npm test`）；提交前 `bun run typecheck && bun test` 全绿（该命令链用 Bash 工具跑，PowerShell 5.1 不支持 `&&`）。
- commit 直接落在本分支（分支已隔离，最终统一开 PR 回 master，不直推）。
- 裁决 #1 维持：update_of target 合法集合 = `existing.filter(status==='approved')` 的 id，candidate 不可作 target。
- 不改 `listForDedupByScope`、stepState、step 名 `'dedup'`、断点续跑协议。

---

### Task 1: `renderUserPrompt` 分区渲染并导出

**Files:**
- Modify: `src/memory/consolidate.ts:209-216`（renderUserPrompt）
- Test: `tests/consolidate.test.ts`（新增 describe）

**Interfaces:**
- Consumes: `DistillCandidate`（`src/memory/distiller`）、`ExistingMemoryForDedup`（`src/memory/dedup`）——既有类型。
- Produces: `export function renderUserPrompt(newCandidates: DistillCandidate[], existing: ExistingMemoryForDedup[], existingSlugs: string[]): string`（原为模块私有，仅加 `export` + 改实现）。

- [ ] **Step 1: 写失败测试** —— 在 `tests/consolidate.test.ts` 顶部 import 行追加 `renderUserPrompt`，文件末尾新增：

```ts
// 回归锁（spec 2026-08-20-consolidate-update-of-target-prompt）：
// 旧 renderUserPrompt 把 approved+candidate 混排且不带 status，模型无从区分，
// update_of 指向 candidate 时 3 轮重试同错必挂。分区渲染让规则可执行。
describe('renderUserPrompt 分区渲染', () => {
  it('approved 与 candidate 各归其区，id 不串区', () => {
    const p = renderUserPrompt(news, existing, ['refund'])
    const approvedIdx = p.indexOf('Existing APPROVED memories')
    const candidateIdx = p.indexOf('Existing CANDIDATE memories')
    const newIdx = p.indexOf('New candidates:')
    expect(approvedIdx).toBeGreaterThanOrEqual(0)
    expect(candidateIdx).toBeGreaterThan(approvedIdx)
    expect(newIdx).toBeGreaterThan(candidateIdx)
    const approvedSection = p.slice(approvedIdx, candidateIdx)
    const candidateSection = p.slice(candidateIdx, newIdx)
    expect(approvedSection).toContain('id=A')       // A 是 approved 夹具
    expect(approvedSection).not.toContain('id=C')
    expect(candidateSection).toContain('id=C')      // C 是 candidate 夹具
    expect(candidateSection).not.toContain('id=A')
  })
  it('approved 为空 → 明示 update_of 不可用 + candidate 仍列出', () => {
    const p = renderUserPrompt(news, [existing[1]!], ['refund'])  // 仅 candidate C
    expect(p).toContain('update_of is NOT available')
    expect(p).toContain('id=C')
    expect(p.slice(p.indexOf('Existing APPROVED'), p.indexOf('Existing CANDIDATE'))).toContain('(none)')
  })
  it('existing 为空 → 两区均 (none)', () => {
    const p = renderUserPrompt(news, [], [])
    expect(p).toContain('New candidates:')
    const approvedSection = p.slice(p.indexOf('Existing APPROVED'), p.indexOf('Existing CANDIDATE'))
    const candidateSection = p.slice(p.indexOf('Existing CANDIDATE'), p.indexOf('New candidates:'))
    expect(approvedSection).toContain('(none)')
    expect(candidateSection).toContain('(none)')
  })
})
```

- [ ] **Step 2: 跑测试确认失败** —— `bun test tests/consolidate.test.ts`（Bash 工具）
  预期：FAIL / 编译错（`renderUserPrompt` 未导出，import 报错）。

- [ ] **Step 3: 实现** —— 替换 `consolidate.ts` 的 `renderUserPrompt` 整体（含加 `export`）：

```ts
export function renderUserPrompt(newCandidates: DistillCandidate[], existing: ExistingMemoryForDedup[], existingSlugs: string[]): string {
  // 分区渲染（spec 2026-08-20）：approved 与 candidate 分开列出，update_of 合法
  // target 只限 APPROVED 区——旧版混排无 status 标记，模型指向 candidate 必挂。
  const approved = existing.filter((e) => e.status === 'approved')
  const candidate = existing.filter((e) => e.status !== 'approved')
  const line = (e: ExistingMemoryForDedup) => `id=${e.id} | slug=${e.subjectSlug ?? '(none)'} | ${e.title}\n${e.bodyMd}`
  const approvedBlock = approved.length > 0 ? approved.map(line).join('\n') : '(none)'
  const candidateBlock = candidate.length > 0 ? candidate.map(line).join('\n') : '(none)'
  const noApprovedNote = approved.length === 0
    ? 'NOTE: no approved memories exist — update_of is NOT available in this batch.\n\n'
    : ''
  const newLines = newCandidates.map((c, i) => `id=new-${i} | slug=${c.subjectSlug ?? '(none)'} | ${c.title}\n${c.bodyMd}${c.evidence ? `\n出处: ${c.evidence}` : ''}`).join('\n---\n')
  const slugs = existingSlugs.length > 0 ? existingSlugs.join(', ') : '(none)'
  return `Existing subject slugs (reuse these): ${slugs}\n\nExisting APPROVED memories (ONLY ids in this section are valid update_of targetId):\n${approvedBlock}\n\n${noApprovedNote}Existing CANDIDATE memories (pending approval; NOT valid update_of targets — use only as context for drop/merge):\n${candidateBlock}\n\nNew candidates:\n${newLines}\n\nReturn JSON per the system instructions. Every new-<i> must be covered by exactly one group.`
}
```

（注：candidate 分区按 `status !== 'approved'` 归集——`listForDedupByScope` 只返回 approved/candidate 两种，防御性兜底把异常状态归入「不可作 target」一侧，与校验层 approvedIds 语义一致。）

- [ ] **Step 4: 跑测试确认通过** —— `bun test tests/consolidate.test.ts`
  预期：全 PASS（含既有用例）。
- [ ] **Step 5: Commit**

```bash
git add src/memory/consolidate.ts tests/consolidate.test.ts
git commit -m "fix(consolidate): renderUserPrompt 分区渲染 approved/candidate，update_of 合法 target 对模型可见"
```

---

### Task 2: `CONSOLIDATE_SYSTEM_PROMPT` 规则改写 + 示例占位符

**Files:**
- Modify: `src/memory/consolidate.ts:14-38`（系统提示）、`src/memory/consolidate.ts:1-7`（文件头注释）
- Test: `tests/consolidate.test.ts`（CONSOLIDATE_SYSTEM_PROMPT describe 扩充）

**Interfaces:**
- Consumes: Task 1 的分区标题文案（`Existing APPROVED memories` / `Existing CANDIDATE memories`）——系统提示措辞须与之一致。
- Produces: 常量 `CONSOLIDATE_SYSTEM_PROMPT`（签名不变，内容改写）。

- [ ] **Step 1: 写失败测试** —— 在 `tests/consolidate.test.ts` 的 `describe('CONSOLIDATE_SYSTEM_PROMPT', ...)` 内追加用例：

```ts
  // 回归锁（spec 2026-08-20）：分区规则必须写进系统提示，且旧的假 id 示例必须清除
  it('contains partition rules + empty-approved ban + no fake id example', () => {
    expect(CONSOLIDATE_SYSTEM_PROMPT).toContain('APPROVED 分区')
    expect(CONSOLIDATE_SYSTEM_PROMPT).toContain('CANDIDATE 分区')
    expect(CONSOLIDATE_SYSTEM_PROMPT).toContain('(none)')
    expect(CONSOLIDATE_SYSTEM_PROMPT).toContain('禁止使用 update_of')
    expect(CONSOLIDATE_SYSTEM_PROMPT).not.toContain('"targetId": "A"')
  })
```

- [ ] **Step 2: 跑测试确认失败** —— `bun test tests/consolidate.test.ts`
  预期：新用例 FAIL（缺 `APPROVED 分区` 等 token）。
- [ ] **Step 3: 实现** —— 系统提示内三处改动（其余文字不动）：

1. 硬规则第 3 条（原 `consolidate.ts:24`）替换为：

```
- update_of 仅当新候选是对既有 approved 记忆同一主题的精炼/补充/纠正；targetId 必须是 user prompt 中 APPROVED 分区列出的 id 之一——CANDIDATE 分区的记忆与任何 candidate 均不可作 target。APPROVED 分区为 (none) 时，本批禁止使用 update_of。
```

2. 输出示例里 update_of 组的 `\"targetId\": \"A\"` 替换为：

```
{ \"action\": \"update_of\", \"targetId\": \"<an id from the APPROVED section>\", \"members\": [\"new-1\"], \"mergedTitle\": \"...\", \"mergedBody\": \"...\", \"mergedEvidence\": \"...\", \"mergedSlug\": \"refund-policy\", \"mergedOrigin\": \"agent-observed\" },
```

3. 紧跟输出格式说明（原 `consolidate.ts:30` 那句）追加一句：

```
示例中 targetId 的占位符 `<an id from the APPROVED section>` 必须替换为 user prompt APPROVED 分区实际列出的 id。
```

同时更新文件头注释（`consolidate.ts:5-7`）：在「本模块为纯逻辑」句后补「user prompt 分区渲染 approved/candidate（update_of 合法 target 只限 APPROVED 区）」。

- [ ] **Step 4: 跑测试确认通过** —— `bun test tests/consolidate.test.ts`
  预期：全 PASS（既有 `update_of 仅当` / `approved` token 断言仍成立）。
- [ ] **Step 5: Commit**

```bash
git add src/memory/consolidate.ts tests/consolidate.test.ts
git commit -m "fix(consolidate): 系统提示对齐分区规则——targetId 限 APPROVED 分区、空区禁用 update_of、清除假 id 示例"
```

---

### Task 3: `consolidateShouldRetry` 报错携带合法 targetId 引导

**Files:**
- Modify: `src/memory/consolidate.ts:174-207`（consolidateShouldRetry）
- Test: `tests/consolidate.test.ts`（consolidateShouldRetry describe 扩充）

**Interfaces:**
- Consumes: 既有签名 `(approvedIds: Set<string>) => (parsed: unknown) => string | null`（不变）。
- Produces: 报错字符串新格式（供 runLlmSession followup 抵达模型）：非空集合含 id 列表；空集合明示不可用 update_of。

- [ ] **Step 1: 写失败测试** —— 在 `describe('consolidateShouldRetry', ...)` 内追加：

```ts
  // 回归锁（spec 2026-08-20）：报错必须携带可执行引导，否则 followup 轮模型无据可改、3 轮同错
  it('targetId not in approved → retry message lists APPROVED 分区合法 id', () => {
    expect(fn({ groups: [{ action: 'update_of', targetId: 'C', members: ['new-0'] }] })).toMatch(/仅限 APPROVED 分区: A/)
  })
  it('approvedIds 为空 → retry message 明示不可使用 update_of', () => {
    const fnEmpty = consolidateShouldRetry(new Set<string>())
    expect(fnEmpty({ groups: [{ action: 'update_of', targetId: 'C', members: ['new-0'] }] })).toMatch(/不可使用 update_of/)
  })
```

- [ ] **Step 2: 跑测试确认失败** —— `bun test tests/consolidate.test.ts`
  预期：两个新用例 FAIL（报错文案不含引导）。
- [ ] **Step 3: 实现** —— 把 `consolidate.ts:194` 的单行报错替换为：

```ts
      if (action === 'update_of') {
        if (typeof g.targetId !== 'string') return `group ${i} update_of 缺少 targetId`
        if (!approvedIds.has(g.targetId)) {
          // 防御纵深（spec 2026-08-20）：报错携带引导让 followup 轮可收敛，
          // 不再 3 轮同错——prompt 分区（Task 1/2）是第一道防线，这里是第二道。
          const ids = [...approvedIds].join(', ')
          return approvedIds.size > 0
            ? `group ${i} targetId 不在 approved 集合内（合法 targetId 仅限 APPROVED 分区: ${ids}）`
            : `group ${i} targetId 不在 approved 集合内（本批 approved 为空，不可使用 update_of）`
        }
      }
```

- [ ] **Step 4: 跑测试确认通过** —— `bun test tests/consolidate.test.ts`
  预期：全 PASS（既有 `/targetId/` 正则断言仍匹配新文案）。
- [ ] **Step 5: Commit**

```bash
git add src/memory/consolidate.ts tests/consolidate.test.ts
git commit -m "fix(consolidate): update_of targetId 报错附合法 id 引导，重试轮可收敛"
```

---

### Task 4: 全量验证 + 收尾

**Files:**
- Modify: 无新文件；验证整仓。

**Interfaces:**
- Consumes: Task 1-3 全部改动。
- Produces: 全绿基线，供 PR。

- [ ] **Step 1: 全量校验** —— Bash 工具：`bun run typecheck && bun test`
  预期：typecheck 0 错；测试 0 fail（基线 1381 pass，加上新用例应更多；5 skip 为 live 守卫，正常）。
- [ ] **Step 2: 检查既有测试是否受 prompt 文案影响** —— `bun test tests/e2e.test.ts tests/e2e-distill-batching.test.ts tests/scheduler-consolidation.test.ts`
  预期：PASS。若有用例断言旧 dedup prompt 全文（`Existing memories (same scope)`），按新分区文案同步断言。
- [ ] **Step 3: Commit（若有 Step 2 的同步修改）** —— `git commit -m "test: 同步 e2e 断言至分区版 consolidate prompt"`（无修改则跳过）。

---

## Self-Review 结果

- **Spec 覆盖**：目标 1（分区渲染）→ Task 1；目标 2（系统提示 + 空区禁用 + 假 id 清除）→ Task 2；目标 3（重试收敛）→ Task 3；验收清单全绿 → Task 4。非目标均未触碰。
- **占位符扫描**：无 TBD/TODO；所有代码步骤含完整代码。
- **类型一致性**：`renderUserPrompt` 三参签名在 Task 1 定义、测试一致；`consolidateShouldRetry` 签名不变；分区标题字符串在 Task 1（实现）与 Task 2（系统提示措辞）间一致（`APPROVED 分区` / `CANDIDATE 分区` 同时出现在 user prompt 标题与系统提示规则中）。

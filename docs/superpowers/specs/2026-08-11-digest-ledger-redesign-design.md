# 滚动摘要职责反转：会话事实账本（digest ledger）redesign

日期：2026-08-11
状态：设计定稿（用户已批准方案 A，并授权 spec → plan → 实现一路执行不再逐节确认）
关联：取代 `2026-08-09-distill-context-and-batching-design.md` 的 §4.3（滚动摘要）与 §5 失败矩阵 #8；§4.2（确定性 digest）、§4.6（distiller 输入）不动

## 1. 背景与问题

现行滚动摘要（`src/memory/rollingSummary.ts` 的 `mergeRollingSummary`）在每次蒸馏成功后把「全量旧摘要 + 本次新切片」交给 LLM，要求整体重压缩回固定预算 `DIGEST_MAX_CHARS=3000`，超了由代码 `slice(0, 3000)` 留头砍尾并记 `digest_truncated` 降级。2026-08-11 在本仓库自身开发 session 上实测（4 条降级记录 + 一次真实复现调用），暴露四个结构性缺陷：

1. **压缩比单调上升 → 超预算是时间问题**。会话越长旧摘要越满，合并时 LLM 要压进固定预算的新内容越多。当日 4/4 次合并全部超预算；且首次截断后存量恒为满额 3000 字，之后每次合并都零缓冲，连环触发。调预算只能推迟崩溃点，不改变趋势。
2. **留头砍尾砍掉最值钱的部分**。prompt 要求时间序组织，LLM 输出开头是最早话题、结尾是最新进展；`slice(0, 3000)` 恰好砍掉结尾。复现实测：输入 11840 字 → 产出 3834 字（真压缩，3:1，stop_reason=end_turn，结构化良好），超预算仅 28%，被砍的 834 字全是最新事实（PR #58 创建、收尾）。而经济模式 `buildDeterministicDigest` 的策略是丢最旧、保最近——**两模式留存策略互相矛盾**。
3. **摘要的摘要渐糊**。同一段历史每轮合并都被重新改写一次，信息随重压缩次数渐进失真。这是现行结构自带的质量损失，与截断无关。
4. **可观测性缺口**。`digest_truncated` 的 detail 是固定文案，不记录原始产出长度，超限幅度不可观测（本次靠复现才量出 128%）。

复现同时证明：LLM 的压缩动作真实发生且质量良好，超预算是「差一点」的系统性偏差（长度预算被当软目标），不是模型不工作。因此根治方向不是「让 LLM 更守预算」（重试/强化措辞等补救），而是**把预算管理职责从 LLM 手里收回来**。

## 2. 目标

- **G1**：「LLM 产出超全局预算」从机制上不可能发生——全局预算只由代码强制，不经 LLM 之手。
- **G2**：消除连环降级——LLM 的压缩难度只取决于当前切片大小（放行阈值 8000 字 / 50 turn 封顶，有界），不随会话长度累积。
- **G3**：消除摘要重压缩退化——旧内容要么原样留存、要么整行丢弃，永不被改写。
- **G4**：统一质量/经济两模式的留存策略（丢最旧、保最近），收敛为同一个纯函数实现。
- **G5**：预算 3000 → 6000（用户已确认）。依据：digest 在蒸馏 prompt 中仅背景一节，蒸馏输入预算 64k token，6000 字 ≈ 6k token，占比增量 ~5%；预算越大合并压缩比越小。
- **G6**：残留降级不静默——仍落 `memory_degradations` + 状态栏可见（项目硬约束不变）。

## 3. 非目标

- **不做超配额重试**。新结构下超配额是罕见有界事件，按行裁剪即收敛；重试属过度设计（用户已否决补救式方案）。
- **不改 schema**。`memory_session_digests` 原样复用（digest 仍是 TEXT，内容从 prose 变为行式）。
- **不改蒸馏 prompt**。digest 仍作「背景」节传入，空节省略的逐字节兼容保证不变。
- **不改经济模式对外行为**。`buildDeterministicDigest` 重构后逐字节一致（既有测试原样通过即回归锁）。
- **不改 UI 结构**。仅 `src/web/ui-utils.ts` 一处降级标签文案。
- **不把整份旧账本传给 LLM**（会复活输入膨胀）。LLM 压缩时只传账本最后 ≤5 行作衔接上下文（O(1) 常量）。
- **不在本期解决跨片指代**（「这个方案」类悬浮引用）。留上线观测项（§10），观测到质量损伤再议。
- 不动 `digest_llm_failed` / `digest_read_failed` 既有路径语义。

## 4. 核心机制：从「整体重压缩」到「追加式事实账本」

把每 session 一份的滚动摘要改为**追加式事实账本（ledger）**：

- 账本 = 时间序事实行的纯文本，一行一事实，最旧在前、最新在后；仍存 `memory_session_digests.digest`。
- **LLM 的唯一任务**：把本次新切片压缩成事实行，配额与切片大小成正比（约 2:1；实测该模型无压力做到 3:1）。
- **代码的唯一任务**：新行追加到账本尾部；总量超 `DIGEST_MAX_CHARS` 时从最旧的整行开始丢，直到达标。
- 推论：全局预算由代码强制 → G1；LLM 任务规模只与切片相关 → G2；旧行不被改写 → G3；两模式共用留存函数 → G4。

### 4.1 数据流（scheduler 挂点不变，`scheduler.ts:444-459` 区域）

```
蒸馏成功（质量模式 + 会话 job + 非 subagent）
 → getSessionDigest 读账本（失败路径不变：digest_read_failed）
 → rendered = renderDigestLines(newTurns)            // 规范行格式，与经济模式同源
 → renderedLen = rendered.join('\n').length          // 含换行符，与 digest 文本口径一致
    ├─ renderedLen < 1200 字：newLines = rendered，不调 LLM（小切片免 30s+ 调用，原文行无损）
    └─ ≥1200 字：LLM 压缩
         budget = sliceBudget(renderedLen)            // clamp(ceil(len/2), 600, 3000)
         system = sliceDigestSystemPrompt(budget)
         user = [衔接段：账本最后 ≤5 行，仅供衔接、不要重复] + [新增段：rendered]
         out = callLLM(...)                           // 抛错向外传 → digest_llm_failed（不变）
         空/空白产出 → 抛错（同上，不变）
         newLines = sanitizeLlmLines(out)             // 按行切、压平空白、丢空行、单行 cap 300
         joined(newLines) > budget → trimOldestLines(newLines, budget)，truncated = true
 → ledgerLines = [...prior 行化（split('\n') 去空行）, ...newLines]
 → digest = trimOldestLines(ledgerLines, 6000).join('\n')   // 设计内留存策略，不记降级（与经济模式同语义）
 → digest 与 prior 相同 → 跳过 upsert；否则 upsertSessionDigest(mode='llm')
 → truncated → logDegradation('digest_truncated', detail 含配额/实际字数)
```

**遗留 prose 分支**（一次性自愈，§6）：prior 非空且 `isLineStructured(prior)` 为假 → 走重整调用（budget=6000，旧 prose 全文 + 新切片一并整理为事实行），产出净化、超限按行裁剪后**替换**账本（不追加）。此后该 session 恒走行式路径。

## 5. 接口契约

### 5.1 `src/memory/contextDigest.ts`（行格式与留存的唯一权威）

```ts
export const DIGEST_MAX_CHARS = 6000          // 3000 -> 6000（G5）
export const DIGEST_LINE_MAX_CHARS = 300      // 不变
export const DIGEST_TOOL_CALL_MAX_CHARS = 100 // 不变

/** 规范行渲染：现 buildDeterministicDigest 内部逐行逻辑原样提出。
 *  user/assistant/thinking -> `USER: `/`ASSISTANT: `/`THINKING: ` 前缀 + 压平空白 + 300 字 cap；
 *  tool -> `[tool: 名]`（有 toolCall 附 ≤100 字摘要）；system 跳过。纯函数、永不抛。 */
export function renderDigestLines(turns: readonly TranscriptTurn[]): string[]

/** 最旧整行丢弃直到 join('\n') 后 ≤ maxChars；仅剩单行仍超 -> 保留末尾 maxChars 字
 *  （沿用现 buildDeterministicDigest 边界行为）。纯函数。经济模式与 LLM 账本共用。 */
export function trimOldestLines(lines: readonly string[], maxChars: number): string[]

/** = trimOldestLines(renderDigestLines(turns), maxChars)。
 *  硬约束：重构后对外行为与旧实现逐字节一致（既有 context-digest.test.ts 原样通过）。 */
export function buildDeterministicDigest(turns: readonly TranscriptTurn[], maxChars?: number): string
```

### 5.2 `src/memory/rollingSummary.ts`（重写）

```ts
/** 切片压缩配额：2:1，下限 600，上限账本一半（3000）。纯函数。 */
export const SLICE_BUDGET_MIN = 600
export function sliceBudget(renderedLen: number): number
// = clamp(Math.ceil(renderedLen / 2), SLICE_BUDGET_MIN, Math.floor(DIGEST_MAX_CHARS / 2))

/** 直接追加阈值：渲染总长低于此值不调 LLM。= SLICE_BUDGET_MIN * 2（再低则压缩无意义）。 */
export const DIRECT_APPEND_MAX_CHARS = 1200

/** 行化探测：所有非空行 ≤400 字视为已行化（账本行经净化恒 ≤300，留 100 字余量）。 */
export function isLineStructured(digest: string): boolean

/** LLM 产出行净化：按 \n 切、逐行压平空白、丢空行、单行超 DIGEST_LINE_MAX_CHARS 截断（无后缀，
 *  与 renderDigestLines 约定一致）。纯函数、永不抛。 */
export function sanitizeLlmLines(raw: string): string[]

/** 中立压缩 prompt（预算参数化）。硬约束：不得匹配 /keep|discard|保留重要|丢弃|取舍/i
 *  （沿用现中立性测试；取舍策略在代码层，不进 prompt）。 */
export function sliceDigestSystemPrompt(budget: number): string

/** 编排。返回形状与旧 mergeRollingSummary 兼容（scheduler 调用点最小 diff）。
 *  truncated 语义收窄为「切片压缩产出超配额被按行裁剪」。
 *  overshoot 仅在 truncated=true 时非空，供降级 detail 记数。
 *  LLM 抛错 / 空产出向外抛（调用方留旧账本 + digest_llm_failed，不变）。 */
export async function updateSessionLedger(
  priorLedger: string | null,
  newTurns: readonly TranscriptTurn[],
  callLLM: LLMCall,
): Promise<{ digest: string; truncated: boolean; overshoot: { budget: number; actual: number } | null }>
```

`mergeRollingSummary` / `ROLLING_SUMMARY_SYSTEM_PROMPT` 两个导出被上面替代，删除（调用点仅 scheduler 一处 + 测试）。

### 5.3 prompt 文本

system（预算参数化；措辞避开中立性正则）：

```
You are a session-digest compressor for a memory sidecar.

Convert the provided NEW conversation slice into compact fact lines for the session's rolling ledger.

Rules:
- Output ONLY the fact lines: no JSON, no markdown fences, no numbering, no commentary.
- One fact per line, chronological order, plain declarative sentences.
- Write in 简体中文 (technical terms may stay in English).
- Compress mechanically: no opinions, no importance ranking, no advice.
- Hard length budget: at most ${budget} characters in total.
```

user（正常路径）——衔接段仅当账本有行时出现：

```
已有摘要结尾（仅供衔接参考，不要重复其中内容）：
<账本最后 ≤5 行>

新增会话内容：
<renderDigestLines(newTurns) join '\n'>

请输出事实行。
```

user（重整路径，遗留 prose 一次性）：

```
旧摘要（需一并整理）：
<prose 全文>

新增会话内容：
<同上>

请输出整理后的全部事实行。
```

### 5.4 scheduler 接线（`scheduler.ts:448-459` 区域，最小 diff）

```ts
const { digest: merged, truncated, overshoot } = await updateSessionLedger(prior?.digest ?? null, newTurns, deps.callLLM)
if (merged !== (prior?.digest ?? '')) await upsertSessionDigest(db, job.sessionId, merged, 'llm')
if (truncated && overshoot) {
  await logDegradation(db, { kind: 'digest_truncated', detail: `切片压缩产出 ${overshoot.actual} 字超配额 ${overshoot.budget} 字，按行裁剪保留最新`, distillJobId: job.id, sessionId: job.sessionId })
}
```

catch 分支（`digest_llm_failed`）不动。

### 5.5 UI 文案

`src/web/ui-utils.ts`：`digest_truncated: '摘要超长截断'` → `'摘要压缩超限'`。其余不动。

## 6. 遗留 prose 迁移（零脚本，行为内自愈）

- 探测：`isLineStructured(digest)`——所有非空行 ≤400 字为真。现网 prose 段落体（单段数百至上千字）判假；行式账本（LLM 新产出恒 ≤300/行、确定性 digest 行 ≤300/行）判真。
- 首次合并判假 → 重整调用：budget=6000（满额），旧 prose 全文 + 新切片 → 事实行；产出净化后超 6000 按行裁剪（同样记 `digest_truncated`，overshoot 语义一致）；结果**替换**账本。每 session 至多一次，此后恒行式。
- prior 为 null（新 session / legacy 无摘要）→ 正常首建，天然行式。
- 边界：prose 恰好全是短行（≤400）被判真 → 当作行式账本追加，行为仍正确（短行即事实行），无需特判。

## 7. 失败矩阵

| # | 失败 | 行为 | 降级记录 |
|---|---|---|---|
| 1 | LLM 产出超**全局**预算 | 不可能发生（全局预算不经 LLM） | 无（G1） |
| 2 | 切片压缩产出超配额 | `trimOldestLines` 丢产出最旧行；保留最新 | `digest_truncated`，detail 含 actual/budget |
| 3 | 账本追加后超 6000 | `trimOldestLines` 丢最旧整行 | 不记（设计内留存，与经济模式同语义） |
| 4 | LLM 抛错 | 留旧账本，job 仍 done | `digest_llm_failed`（不变） |
| 5 | 空/空白产出 | 同 #4 | `digest_llm_failed`（不变） |
| 6 | digest 读取失败 | priorContext=null，distill 照常 | `digest_read_failed`（不变） |
| 7 | 重整路径产出超长 | 同 #2（budget=6000） | `digest_truncated` |
| 8 | 切片无可渲染行（全 system 等） | 不调 LLM，digest 不变，跳过 upsert | 无 |

`tests/degradation-coverage.test.ts` 的 grep 级守卫继续满足：`'digest_truncated'` 字符串仍在 `scheduler.ts` 生产点出现。

## 8. 耦合点与影响面

| 文件 | 改动 |
|---|---|
| `src/memory/contextDigest.ts` | 常量 3000→6000；抽出 `renderDigestLines` / `trimOldestLines`；`buildDeterministicDigest` 重组（逐字节不变） |
| `src/memory/rollingSummary.ts` | 重写：新导出集（§5.2），删除 `mergeRollingSummary` / `ROLLING_SUMMARY_SYSTEM_PROMPT` |
| `src/scheduler.ts` | §5.4 调用点替换（~6 行） |
| `src/web/ui-utils.ts` | 一处标签文案 |
| `tests/context-digest.test.ts` | 常量断言 3000→6000（注释记决策来源：本 spec G5）；新增纯函数用例；既有用例不动（回归锁） |
| `tests/rolling-summary.test.ts` | 重写为 `updateSessionLedger` 用例集 + 新 prompt 中立性 |
| `tests/degradation-coverage.test.ts` | 不动（守卫天然满足） |
| 蒸馏 prompt / distiller / schema / UI 结构 | 零改动 |

## 9. 测试策略（随实现落地，`bun test`）

纯函数层（主力，可断言面优先——CLAUDE.md 约定）：

1. `sliceBudget`：下限钳制（渲染 100 / 1199 / 1200 → 600）、2:1 区段（4000 → 2000）、上限钳制（10000 → 3000）。直追阈值 `DIRECT_APPEND_MAX_CHARS` 的语义归编排层用例 #10。
2. `trimOldestLines`：多行丢最旧直到达标；恰好达标不动；仅剩单行超限 → 末尾切片；空数组 → 空串。且与旧 `buildDeterministicDigest` 裁剪行为一致性断言。
3. `renderDigestLines`：四种 role 格式 + system 跳过 + 300 cap + toolCall 100 cap（部分可从既有 context-digest 用例平移）。
4. `buildDeterministicDigest` 逐字节回归：既有 `context-digest.test.ts` 全部用例原样通过（仅常量断言改 6000）。
5. `sanitizeLlmLines`：多行切分、空白压平、空行丢弃、单行 300 cap、空串输入 → 空数组。
6. `isLineStructured`：prose（长段）判假；行式（短行）判真；空串/纯空白判真（无违规行）。

编排层（mock LLM）：

7. 正常追加：prior 行式 + 新行追加，总量 ≤6000，truncated=false，overshoot=null。
8. 全局预算裁剪：追加后超 6000 → 丢最旧行、结果 ≤6000、**不**报 truncated（区分 #2/#3）。
9. 超配额：mock 返回 >budget 的产出 → 产出被按行裁剪、truncated=true、overshoot 数值正确、最新行保留。
10. 小切片直追：渲染总长 <1200 → callLLM 零调用（spy 断言），rendered 行原样进账本。
11. 首建（prior=null）：无衔接段，产出即账本。
12. 遗留 prose：prior 为段落体 → 重整 prompt 含 prose 全文、budget=6000；产出替换账本。
13. 空产出抛错、LLM 抛错传播（既有语义不变）。
14. 性质断言：任意非空 mock 产出，返回 digest 恒 ≤6000。
15. 无可渲染行：不调 LLM，返回 prior 原值。

prompt 层：

16. 新 system prompt 过中立性正则 `/keep|discard|保留重要|丢弃|取舍/i`（沿用现测试形态）。
17. prompt 含预算数字参数；prior 有行时含衔接段与「不要重复」字样，prior=null 时不含。

scheduler 层（既有 server/scheduler 测试体系内）：

18. `digest_truncated` 仅在 overshoot 路径落表且 detail 含 actual/budget 数值；全局裁剪路径零 logDegradation 调用。

## 10. 上线后观测（并入 STATE.md 2026-08-09 观测清单，结论回填 STATE.md）

- `digest_truncated` 24h 计数：预期从「单 session 4 连发」降到近零；若仍高频说明 2:1 配额对所用模型偏紧，调 `sliceBudget` 比例（纯函数，一行）。
- 账本长度分布：`select session_id, length(digest) from memory_session_digests`——观察 6000 上限的贴顶频率，评估 G5 预算是否还需调。
- 跨片指代质量：质量模式候选与既有记忆重复率是否因「只看切片不看全史」而上升（对照 §3 非目标的判断）。
- 小切片直追占比：无直接打点，经 distill runs 抽样观察（非阻塞）。

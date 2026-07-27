# 记忆质量修复第二轮设计（条件门 + dedup 跨批增强 + 64k 预算）

## 1. 背景

PR #13（第一轮）落地了输入过滤 + valueFilter 逻辑门 + dedup 前置。合并后重启 daemon 产出新候选，活体证据显示质量仍系统性偏低：

- **逻辑门被滥用**：5 条 `[category:invariant]` 候选全是"memside 自身 valueFilter 实现规则"的不同表述（"invariant/integration/compliance 必须强制保留 + valueClass='decision'"），被逻辑门强制保留、绕过 derivable 判定。这些是可从仓库源码推导的代码复述，本该拒。
- **dedup 没合并同义**：上述 5 条跨两批产出，dedup 没把它们合成 1 条。
- **运行知识被保留**：1 条 `[category:integration]`"daemon 跑 7777、Web UI 跑 5173、重启中断 job 但下个 tick 重跑"是 README/CLAUDE.md 可推导的运行知识，本该拒。
- **量化**：重启后 30 分钟内 60 留 / 11 丢（keep-rate 85%），但留存里多条是"配置默认值/内部模块行为/符号名"（如"默认 max_tokens=8192"、"callWithRetry 两参数调用"、"src/llm.ts 契约"），正是第一轮 REJECT 条款点名要拒的。

### 1.1 根因（比第一轮更棘手）

1. **逻辑门触发器描述"形状"而非"对象"**：`VALUE_PROTECTED_CATEGORIES`（invariant/integration/compliance）的触发器是 distiller LLM 自由打的 `[category:xxx]` 标签。LLM 区分不了"业务硬规则"（不可从代码推导，如退款 14 天）和"代码实现规则"（可从源码推导，如 valueFilter 必须强制保留 invariant）——两者措辞都是"X 必须 Y"。逻辑门一刀切全保留，等于给"代码复述"开免死金牌。
2. **dedup 跨批比对只发 title**：`renderUserPrompt` 对 existing 只发 `id | title`（dedup.ts:40），同批兄弟才发 bodyMd。跨批同义候选 title 强调不同侧面，LLM 看不出同一条规则。
3. **dogfood 归类陷阱**：会话主题是开发 memside 时，几乎所有候选都"关于代码"，LLM 把代码实现规则当领域知识。

### 1.2 第一轮遗留的取舍回调

第一轮把 `DEFAULT_DISTILL_INPUT_BUDGET_TOKENS` 压到 12k 是为去噪。用户确认本轮**不省 token**：dedup 比对带全 bodyMd、输入预算放到 64k、`max_tokens` 一并整改，用更多上下文换更准判定。文件类工具占位符（`[file: 路径, 原文 N 行]`）是去噪（防 LLM 分心复述源码）不是省 token，保留。

## 2. 目标 / 非目标

### 目标
- 逻辑门只保护"外部业务领域"的硬规则，不再保护"当前仓库自身代码"的复述。
- dedup 跨批比对带 bodyMd + prompt 明确"同规则不同侧面=重复"，提升近义合并率。
- distill 输入预算 12k -> 64k，per-turn cap 翻倍，给 distiller 更完整上下文判 subject/category。

### 非目标
- 不引入新 schema 变更（`subject` 瞬态字段不入库）。
- 不引入精确 tokenizer（保留 4 char ≈ 1 token 粗估）。
- 不对 dogfood 场景做特殊处理（靠通用 subject 判定覆盖）。
- 不加第二道 facet merge LLM 遍（同一遍调用给全 body + 明确指引已足够）。
- DB 253MB 膨胀 / events 保留策略仍为独立后续 issue。

## 3. 接口契约

### 3.1 DistillCandidate 扩展（distiller.ts）

```ts
export interface DistillCandidate {
  title: string
  bodyMd: string
  scopeType: MemoryScope
  runtime: RuntimeTag
  distillAction: 'new' | 'update_of' | 'duplicate_of' | 'conflict_with'
  subject: 'codebase' | 'domain'   // 新增：瞬态，不持久化
}
```

`subject` 语义：
- `codebase` = 这条规则描述的是当前 cwd 仓库自身的代码、配置、模块行为或实现逻辑。脱离这个仓库，规则就失去所指对象。
- `domain` = 这条规则描述的是仓库之外的东西：用户的业务规则、外部系统契约、法规约束、跨项目的领域知识。换一个仓库这条规则依然成立、依然有意义。

默认值：distiller 拿不准 / 漏标时 `codebase`（精度优先，不保护）。

### 3.2 distiller 提示词改造（distiller.ts）

`DISTILLER_SYSTEM_PROMPT` 输出 schema 的 candidate 对象加 `"subject": "codebase" | "domain"` 字段。新增判定指引（见 §4.1 原文）。

invariant 定义收紧（distiller.ts:14）：
- 旧：`[category:invariant] - hard business rules / constraints that must always hold`
- 新：`[category:invariant] - hard business rules about the user's DOMAIN (NOT about this codebase's own implementation) that must always hold`

`distillShouldRetry` 校验加一条：每个 candidate 的 `subject` 必须是 `'codebase'` 或 `'domain'`，缺失/非法触发 retry。exhausted 后 fall through 默认 `subject='codebase'`。

### 3.3 valueFilter 条件门改造（valueFilter.ts）

`judgeValue` 的 force-keep 条件从无条件改为条件门：

```ts
// 旧（两处：keepNull + 正常路径）
if (cat && VALUE_PROTECTED_CATEGORIES.has(cat))
  return { index: i, keep: true, valueClass: 'decision' }

// 新
const subj = c.subject ?? 'codebase'   // 缺失默认 codebase
if (cat && VALUE_PROTECTED_CATEGORIES.has(cat) && subj === 'domain')
  return { index: i, keep: true, valueClass: 'decision' }
```

`subject` 缺失/非法一律视为 `codebase`（不保护，走正常 derivable 判定）。

### 3.4 dedup 跨批增强（dedup.ts + store.ts）

`ExistingMemoryForDedup` 加 `bodyMd: string` 字段。`listForDedupByScope`（store.ts:138）多 SELECT `bodyMd` 列。

`renderUserPrompt` existing 行从 `id=${e.id} | ${e.title}` 改为 `id=${e.id} | ${e.title}\n${e.bodyMd}`。

`DEDUP_SYSTEM_PROMPT` 加"同规则不同侧面=重复"指引 + 1 个示例（见 §4.2 原文）。

### 3.5 token 预算放宽（pure.ts + llm.ts）

- `DEFAULT_DISTILL_INPUT_BUDGET_TOKENS`：12k -> 64k。
- per-turn cap：user/assistant 4000 -> 8000；tool 1500 -> 3000（非文件）；文件类占位符 cap 不变。
- 文件类工具占位符（`[file: 路径, 原文 N 行]`）保留。
- `DEFAULT_LLM_MAX_TOKENS`（llm.ts）已 8192，确认够用，不动。
- token 估算保留 4 char ≈ 1 token 粗估。

## 4. 数据流 / 提示词原文

### 4.1 distiller subject 判定指引（写入 DISTILLER_SYSTEM_PROMPT）

```
对每条候选标记 subject：
- codebase = 这条规则描述的是当前仓库自身的代码、配置、模块行为或实现逻辑。
  判据：规则的主语是仓库内的具体组件/符号/流程（如 valueFilter、daemon、scheduler、
  某个函数的调用约定）。脱离这个仓库，规则就失去所指对象。
- domain = 这条规则描述的是仓库之外的东西：用户的业务规则、外部系统契约、法规约束、
  跨项目的领域知识。判据：换一个仓库这条规则依然成立、依然有意义。

拿不准时标 codebase。
```

### 4.2 dedup "同规则不同侧面"指引（写入 DEDUP_SYSTEM_PROMPT）

在现有 "the same rule or fact, even if worded differently or tagged with a different [category:] prefix" 之后追加：

```
同一规则从"为什么这么做 / 实现要点 / 触发条件"等不同角度各写一条，仍是重复——只保留最完整的一条。例如以下三条都表达同一规则，只有第一条应保留：
  [category:invariant] 退款须在发货后14天内
  [category:invariant] 退款规则的14天期限不可被LLM以derivable丢弃
  [category:compliance] 14天退款窗口必须强制保留并标记valueClass
```

### 4.3 数据流（tick 内）

1. `distillTranscript` -> 产出带 `subject` 的 `DistillCandidate[]`（subject 瞬态）。
2. `dedupCandidates` -> existing 比对带 bodyMd，合并近义。dedup 不看 subject。
3. `judgeValue` -> 读 `candidate.subject` + `parseCategory(title)`。条件门：`cat ∈ PROTECTED && subject === 'domain'` 才 force-keep+decision；其余走 LLM 6 类判定。
4. `logDiscards` / `createCandidate` -> 不变。subject 不进 schema、不入 `memories` 表。

### 4.4 subject 流转边界

- `DistillCandidate` 接口：`subject` 必填。
- `ExistingMemoryForDedup`：**不加** subject（已入库候选无此字段，dedup 也不需要）。
- `judgeValue(candidates)`：入参 `DistillCandidate[]`，天然带 subject。
- scheduler `createCandidate`：不传 subject（store 层不感知）。

## 5. 与现有模块的耦合点

| 模块 | 本轮改动 | 兼容性 |
|---|---|---|
| `src/memory/distiller.ts` | 提示词加 subject 字段+指引；invariant 定义收紧；`distillShouldRetry` 加 subject 校验；fall through 默认 codebase | `DistillCandidate` 加必填字段，所有构造点（仅 distiller）需补 |
| `src/memory/valueFilter.ts` | gate 两处加 `subject === 'domain'` 条件；缺失默认 codebase | `judgeValue` 入参已是 `DistillCandidate[]`，天然带 subject |
| `src/memory/dedup.ts` | `renderUserPrompt` existing 行加 bodyMd；prompt 加同规则不同侧面指引 | `ExistingMemoryForDedup` 加字段，dedup 是唯一消费方 |
| `src/memory/store.ts` | `listForDedupByScope` 多 SELECT bodyMd | 纯加列 |
| `src/memory/pure.ts` | `DEFAULT_DISTILL_INPUT_BUDGET_TOKENS` 64k；per-turn cap 翻倍 | 占位符逻辑不动 |
| `src/scheduler.ts` | 无（tick 调用序不变，subject 透传不感知） | 不变 |

## 6. 失败模式 / 降级矩阵

保持"永不抛、永不阻塞 distill"契约：

| 失败点 | 现状降级 | 本轮变化 |
|---|---|---|
| distiller LLM 错/非JSON | 返回 `[]`（无候选） | 不变 |
| distiller 漏标 subject | `distillShouldRetry` 拦截重试 | **新增**：exhausted 后 fall through 默认 `subject='codebase'` |
| dedup LLM 错 | 全留 | 不变 |
| valueFilter LLM 错 | `keepNull()`：protected->decision，其余->null | **变化**：条件门下 `keepNull()` 也按 `subject==='domain'` 判定；subject 缺失默认 codebase -> 不保护 -> null |
| subject 字段非法值 | - | **新增**：valueFilter 视非法/缺失为 codebase（精度优先） |

**关键不变量**：`subject` 任何缺失/异常都默认 `codebase`，意味着条件门**永远不会比现在的无条件门保护得更多**——最坏是少保护（某条 domain 规则走 derivable），不会多保护（代码复述仍被免死）。修复方向单调向好。

**向后兼容**：旧候选（已入库）无 subject，但不进 distiller/valueFilter 流程，不受影响。

## 7. 测试策略

### 7.1 §A 条件门（valueFilter.test.ts）
- 新增：`subject='domain'` + `cat=invariant` + LLM derivable -> force-keep + decision（旧门行为保留）
- 新增：`subject='codebase'` + `cat=invariant` + LLM derivable -> **discard**（核心新行为，锁住"代码复述不再被保护"）
- 新增：`subject` 缺失/非法 + `cat=invariant` + LLM derivable -> discard（默认 codebase）
- 新增：`subject='domain'` + `cat=integration`/`compliance` -> 同 invariant（三个 protected 都测）
- 保留：`subject='domain'` + 非 protected cat -> 走 LLM 正常判定（门不误伤）
- 保留：第一轮 neutrality 禁词约束测试（本轮不动 valueFilter 提示词，应仍绿）

### 7.2 §B dedup（dedup.test.ts）
- 新增：existing 带 bodyMd 时 prompt 含 body（断言 captured 包含 existing body 片段）
- 新增：同规则不同侧面的两条候选 -> 一条判 duplicate（prompt 示例生效）
- 保留：跨批 existing 比对、new-j 合法性、LLM 错全留等第一轮测试

### 7.3 §C token 预算（pure-transcript-filter.test.ts）
- 改：预算 64k 下，原 12k 会 drop 的 turn 现在保留
- 改：per-turn cap 翻倍后，原 cap 边界测试数值更新
- 保留：user/error 必留、按优先级 drop、文件类占位符等第一轮测试

### 7.4 §D distiller subject（distiller.test.ts）
- 新增：`distillShouldRetry` 对缺 subject / 非法 subject 返回错误（触发重试）
- 新增：exhausted 后 fall through 默认 subject=codebase
- 新增：invariant 定义收紧后，distiller prompt 含 "about the user's DOMAIN (NOT about this codebase's own implementation)"

### 7.5 §F e2e 门禁（scheduler.test.ts）
- 改：第一轮 `protected invariant candidate survives` 测试，distill mock 加 `subject='domain'`
- 新增反向：`codebase invariant candidate is discarded when LLM says derivable`（subject=codebase 不保护）
- 新增：dedup existing 带 bodyMd 的端到端（scheduler 层断言 createCandidate 收到的候选数减少）

### 7.6 运行门槛
`bun run typecheck && bun test` 全绿才交付。每条新测试顶端注释写清"为什么这条测试存在"（链接本轮根因：代码复述被逻辑门保护）。describe/title 用 `subject gate` / `cross-batch body dedup` / `64k budget` 等可识别词。

## 8. 验收清单

- [ ] `DistillCandidate` 加 `subject` 字段，distiller 提示词+校验+降级落地
- [ ] valueFilter 条件门：`cat ∈ PROTECTED && subject === 'domain'` 才保护
- [ ] dedup existing 比对带 bodyMd + prompt 同规则不同侧面指引
- [ ] `DEFAULT_DISTILL_INPUT_BUDGET_TOKENS` 64k + per-turn cap 翻倍
- [ ] invariant 定义收紧（DOMAIN NOT codebase）
- [ ] e2e：domain invariant 保留 / codebase invariant 被 derivable 丢弃
- [ ] `bun run typecheck && bun test` 全绿
- [ ] 重启后新候选不再出现"代码复述被保护"（5 条同义 invariant 合成 ≤1 条且走 derivable）

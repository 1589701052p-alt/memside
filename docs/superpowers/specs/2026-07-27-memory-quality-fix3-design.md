# 记忆质量修复第三轮设计（subject 驱动 derivable）

## 1. 背景

第二轮（PR #14）落地条件门（subject=codebase|domain）+ dedup 跨批 bodyMd + 64k 预算。重启后验证：核心目标达成（代码复述不再被逻辑门保护，architecture 类被 derivable 拦截），但暴露下一个层次的语义判断问题。

### 1.1 活体证据（第二轮重启后 20 分钟，6 候选 + 1 discard）

**derivable 拦截生效**：1 条 discard `[category:architecture] PR #14 已合并，条件门+dedup+64k 上线` -> derivable（描述仓库状态，可从 git log 推导）。第一轮该拦没拦，现在拦下了。

**仍漏网**：6 条留存候选里 5 条是"关于 memside 自身代码/设计的规则"，却被保留：
- `[decision] token 预算 12k->64k 保留占位符` - memside 设计决策，应 codebase/derivable
- `[decision] 逻辑门加 subject 维度` - memside 设计决策，应 codebase/derivable
- `[decision] dedup 跨批 bodyMd 检查清单` - memside 设计决策，应 codebase/derivable
- `[decision] e2e 门禁正反锚点` - memside 测试设计，应 codebase/derivable
- `[convention] 重启验证后代码复述减少` - meta 观察，可丢

### 1.2 根因（比第二轮更深的语义层）

1. **distiller subject 判定在 dogfood 场景偏 domain**：spec §4.1 判定指引写了"换一个仓库这条规则依然成立"才算 domain，但 LLM 把"架构决策的经验教训"当可迁移领域知识。
2. **valueFilter derivable 判定对"代码设计决策"偏宽松**：这些候选被标 decision/convention（不是 invariant），没走条件门，是被 LLM 正常判定保留。LLM 觉得"为什么这么做"有 rationale 就判 decision，没意识到 rationale 全是关于当前仓库自身的。
3. **两个 LLM 调用不通气**：distiller 判 subject（有 transcript 上下文，能看到 cwd、改了哪些文件），valueFilter 判 derivable（只有候选文本，看不到仓库）。valueFilter 的 derivable 定义已写"codebase being worked on... derivable even when rationale is given"，措辞到头了--问题是它没有"当前仓库"的参照系。distiller 判 subject 比 valueFilter 判 derivable 更有依据，但两者各自独立，互不通气。

### 1.3 第三轮定位

让 distiller 的 subject 判定成为 valueFilter derivable 判定的**输入信号**。distiller 有上下文（判得准），valueFilter 消费这个信号（补强 derivable 判定）。不再让 valueFilter 独立判"当前仓库复述"--它没这个能力。

## 2. 目标 / 非目标

### 目标
- distiller subject 判定加固（提示词加通用启发 + 通用示例），减少 dogfood 场景偏 domain。
- valueFilter 接收 subject 信号：user prompt 每条候选带 subject 标记；提示词加中性描述关联 derivable。
- valueFilter 仍跑完整 6 类（不跳过、不代码覆盖），靠 prompt 信号补强 derivable 判定精度。

### 非目标
- 不动第二轮条件门逻辑（`cat ∈ PROTECTED && subject === 'domain'`）。
- 不加新 LLM 调用、不加新判定层、不加新 schema。
- 不加纯函数启发式覆盖（扫描候选含 transcript 文件路径强制 codebase）。
- 不针对已有记忆写示例（防过拟合）。
- 前两轮修复（输入过滤/dedup bodyMd/64k 预算/条件门）全保留不回退。
- DB 膨胀 / events 保留策略仍为独立后续 issue。

## 3. 接口契约

### 3.1 distiller 提示词加固（distiller.ts）

`DISTILLER_SYSTEM_PROMPT` 的 subject 判定指引（现有"拿不准时标 codebase。"之后）追加通用判定启发 + 通用示例（占位符形式，不含真实记忆符号）。原文见 §4.1。

### 3.2 valueFilter 接收 subject 信号（valueFilter.ts）

**user prompt 加 subject 标记**：`renderUserPrompt`（valueFilter.ts:59-61）从 `[${i}] ${c.title}\n${c.bodyMd}` 改为 `[${i}] (subject: ${c.subject ?? 'codebase'}) ${c.title}\n${c.bodyMd}`。subject 是 `DistillCandidate` 已有字段（第二轮落地），缺失默认 codebase（与 gate defaulting 一致）。

**VALUE_JUDGE_SYSTEM_PROMPT 加中性描述**：在现有 6 类定义之后加一句关联 subject 与 derivable（neutral 措辞，不含禁词）。原文见 §4.2。

### 3.3 不变项

- `DistillCandidate.subject` 字段（第二轮）：不动。
- valueFilter gate 两处（keepNull + 正常路径）的 `cat ∈ PROTECTED && subject === 'domain'`（第二轮）：不动。
- valueFilter 仍跑完整 6 类判定：不跳过、不代码覆盖。
- dedup / pure / scheduler / store：不动。

## 4. 提示词原文

### 4.1 distiller subject 加固（追加在"拿不准时标 codebase。"之后）

```
判定时问自己：这条规则的主语，是这个仓库里能 grep 到的具体东西（文件、函数、配置项、模块名、某个常量值），还是一个仓库之外的业务/领域概念？
- 如果主语是仓库内的具体东西，即使规则本身听起来像"通用经验"，它也是 codebase--因为脱离这个仓库它就失去所指对象，或可从源码重新读出。
- 如果主语是仓库外的业务/领域概念（用户业务规则、外部系统契约、法规、跨项目共识），且换一个仓库依然成立，才是 domain。

通用示例（仅示判定模式，勿照抄内容）：
  codebase: "X 模块的 Y 函数以 Z 方式调用" -- 主语是仓库内符号
  codebase: "本项目把 W 配置为值 V" -- 主语是仓库内配置项
  codebase: "A 组件的 B 行为在 C 条件下触发" -- 主语是仓库内组件
  domain: "用户业务的退款须在发货后 N 天内" -- 主语是外部业务规则
  domain: "外部系统 X 的 SLA 要求 Y" -- 主语是仓库外契约
  domain: "法规要求 Z" -- 主语是仓库外法规
```

### 4.2 valueFilter subject 中性描述（追加在 6 类定义之后）

```
Each candidate is marked with a subject hint: codebase (describes the current repository's own code/config/modules) or domain (describes something outside the repository). Apply the 6 categories above as written - a codebase-subject candidate that describes this repository's own design decisions, implementation rules, or internal behavior is derivable.
```

## 5. 数据流与不变量

### 5.1 数据流

1. `distillTranscript` -> 产出带 `subject` 的 `DistillCandidate[]`（第二轮已落地；本轮加固提示词让 subject 判定更准）。
2. `dedupCandidates` -> 不看 subject（与第二轮一致）。
3. `judgeValue` -> user prompt 每条候选带 `(subject: xxx)` 标记（本轮新增）；VALUE_JUDGE_SYSTEM_PROMPT 加中性描述关联 derivable。LLM 拿到 subject 信号 + derivable 定义，对 codebase-subject 的仓库自身设计决策判 derivable 更准。
4. `logDiscards` / `createCandidate` -> 不变。subject 仍瞬态不入库。

### 5.2 不变量

| 不变量 | 来源 | 本轮状态 |
|---|---|---|
| subject 缺失/非法默认 codebase | 第二轮 | 保留（gate + prompt 渲染都用此 defaulting）|
| 条件门：`cat ∈ PROTECTED && subject === 'domain'` 才保护 | 第二轮 | 保留不动 |
| 新门永远不会比旧无条件门保护得更多 | 第二轮 | 保留（本轮不动 gate）|
| valueFilter 仍跑完整 6 类 | - | 新增（不跳过、不代码覆盖）|
| subject 只进 prompt 当提示，不进代码层 keep/discard 决策 | - | 新增（neutrality 合规）|
| 前两轮修复不回退 | - | 新增（输入过滤/dedup bodyMd/64k 预算/条件门全保留）|

### 5.3 错误处理

与第二轮一致。distiller LLM 错 -> 无候选；valueFilter LLM 错 -> keepNull（条件门按 subject 判定）；subject 缺失 -> codebase。本轮不加新失败模式。

### 5.4 向后兼容

旧候选（已入库）无 subject，但不进 distill/valueFilter 流程，不受影响。第二轮的 e2e 测试（domain invariant 保留 / codebase invariant 丢弃）仍应绿--本轮只补强 derivable 判定精度，不改 gate 逻辑。

## 6. 与现有模块的耦合点

| 模块 | 本轮改动 | 兼容性 |
|---|---|---|
| `src/memory/distiller.ts` | 提示词 subject 指引追加通用启发+示例 | 纯文本追加，无接口/逻辑变更 |
| `src/memory/valueFilter.ts` | `renderUserPrompt` 加 subject 标记；`VALUE_JUDGE_SYSTEM_PROMPT` 加中性描述 | 无接口/逻辑变更；neutrality 约束需复核新措辞 |
| `src/memory/dedup.ts` | 无 | 不变 |
| `src/memory/pure.ts` | 无 | 不变 |
| `src/memory/store.ts` | 无 | 不变 |
| `src/scheduler.ts` | 无 | 不变 |

## 7. 测试策略

### 7.1 §B distiller subject 加固（distiller.test.ts）
- 新增：distiller prompt 含判定启发（"能 grep 到的具体东西"）。
- 新增：distiller prompt 含通用示例占位符（"X 模块的 Y 函数" 等形式）。
- 新增：防过拟合--示例不含真实记忆符号（断言 prompt 不含 "valueFilter"/"token 预算" 等当前 dogfood 产物词）。
- 保留：第二轮 subject 解析/默认/retry 测试全绿。

### 7.2 §C valueFilter 接收 subject（valueFilter.test.ts）
- 新增：user prompt 每条候选含 `(subject: codebase)` 或 `(subject: domain)` 标记。
- 新增：VALUE_JUDGE_SYSTEM_PROMPT 含 subject 中性描述（"codebase-subject candidate that describes this repository's own design decisions... is derivable"）。
- 保留：neutrality 禁词测试（本轮加了新提示词文本，必须仍不含 keep/discard/reject/avoid/important/valuable/unsure/cautious/careful/don't/dangerous）--硬约束，新措辞逐词核对。
- 保留：第二轮条件门测试（domain invariant 保留 / codebase invariant 丢弃）全绿。

### 7.3 §D e2e（scheduler.test.ts）
- 新增：subject=codebase 的设计决策候选，judgeValue LLM 判 derivable -> 丢弃。锁住"subject 信号让 derivable 判定更准"的端到端行为。
- 保留：第二轮 domain invariant 保留 + codebase invariant 丢弃 + dedup bodyMd e2e。

### 7.4 运行门槛
`bun run typecheck && bun test` 全绿。新测试顶端注释写清"为什么这条测试存在"（链接第三轮根因：dogfood 场景 derivable 偏宽松，靠 subject 信号补强）。describe/title 用 `subject-driven derivable` / `subject hint in prompt` 等可识别词。

### 7.5 neutrality 核对（本轮最高风险点）
本轮是三轮里第一次动 VALUE_JUDGE_SYSTEM_PROMPT 措辞（加 subject 描述）。前两轮都没动它。新增英文描述逐词排查禁词：`design decisions` / `is derivable` 不含禁词，但禁止滑进 `should discard` / `avoid keeping` / `do not keep` 之类偏向性措辞。neutrality 测试是硬约束，新措辞必须通过。

## 8. 验收清单

- [ ] distiller 提示词 subject 指引追加通用启发 + 占位符示例（不含真实记忆符号）
- [ ] valueFilter `renderUserPrompt` 每条候选带 `(subject: xxx)` 标记
- [ ] valueFilter `VALUE_JUDGE_SYSTEM_PROMPT` 加 subject 中性描述
- [ ] neutrality 禁词测试仍绿（新措辞逐词核对）
- [ ] 第二轮条件门/e2e 测试全绿（不回退）
- [ ] e2e：subject=codebase 设计决策候选被 derivable 丢弃
- [ ] `bun run typecheck && bun test` 全绿
- [ ] 重启后 dogfood 场景：codebase-subject 的仓库自身设计决策候选明显减少（derivable 拦截率上升）

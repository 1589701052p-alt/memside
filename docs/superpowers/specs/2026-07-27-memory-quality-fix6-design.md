# 记忆质量修复第六轮设计（[stated] 起源判定 + 驯化守卫）

## 1. 背景

第五轮（PR #18，增量蒸馏 + SubagentStop 跳过）止住了「同义候选爆炸」的源头（Stop 累积重复
蒸馏）。本轮转向**提炼质量与安全**，来源是对照 `OPUS-5.md`（Claude 内置记忆系统的
`<memory_filesystem>` 设计）提炼出的三项改进。用户确认做第 1、4 项，砍掉第 2、3 项：

- **第 2 项（校准原则）整个不做**：用户立场是「单次观察见到一次就该记录」。memside 有人工
  审批兜底，liberal 捕获 + 用户把关，与 Claude 内置记忆（无审批、自动应用）的保守校准取向
  不同。过度泛化丢弃会误杀单次观察，与该立场冲突，故砍。
- **第 3 项（隐私过滤）暂不做**：留作未来。本轮第 4 项的确定性守卫给它铺同样模式。

### 1.1 第 1 项 - [stated] 起源判定

memside 的 distiller（`src/memory/distiller.ts:51-52`）已有半个 `[stated]` 纪律：「把记忆锚定
到用户或领域明确陈述的规则、决策与约束；不要总结 agent 读到的文件内容」。但这只挡了「源码
复述」一类。`OPUS-5.md` 的 `[stated]` 纪律更宽：只记用户/领域**明确陈述**的持久事实，并显式
排除六类非陈述内容。

关键：这六类排除与用户的 liberal-capture 立场**不冲突**。用户要「单次观察该记」，这六类是
「非观察/非陈述」（脑补、推测、agent 自己的产出、道听途说）--不是单次观察。方向一致：记真实
陈述，不记脑补。

### 1.2 第 4 项 - 驯化守卫

`OPUS-5.md` 的 `behavioral_guardrails` 明确：永不记录要求 uncritical validation / suppress
disagreement / foster dependency / suppress honest evaluation 的指令。memside 的 valueFilter
（`src/memory/valueFilter.ts`）目前会把「以后别质疑我的代码风格」这类提炼成
`[category:convention]` 并注入未来会话，让 agent 变顺从、不再诚实反馈。

驯化是**唯一即使 liberal 捕获也该拦**的例外：它不是低质量（像第 2 项那样无害），而是主动
有害--污染未来会话的诚实性。所以即使有人工审批，也应在入库前丢弃（不该让用户误批）。

用户指定「在 valueFilter 加」，并暗示「类似 `VALUE_PROTECTED_CATEGORIES` 的反向集合」
（确定性 Set，不走 LLM）。确认用**确定性关键词守卫**。

## 2. 目标 / 非目标

### 目标

- **第 1 项**：扩展 `DISTILLER_SYSTEM_PROMPT` 的 REJECT 段，显式列出 6 类非陈述排除（推断、
  前瞻状态、研究输出、丰富化、道听途说、自己的推理/建议）。仅 distiller prompt 层。
- **第 4 项**：新增纯函数 `detectTaming(title, bodyMd): boolean`（确定性关键词匹配，精度优先）。
- **第 4 项**：`judgeValue` 末尾加 taming override--命中者 verdict 覆盖为
  `{keep:false, reason:'taming'}`，覆盖 protected force-keep（安全 > 保护）。
- **第 4 项**：`DiscardReason` 类型加 `'taming'`；taming 丢弃走 tick 现有 `logDiscards` 审计路径。
- 测试覆盖：distiller REJECT 源码层文本断言；detectTaming 正/负例 + judgeValue 集成（含
  taming 覆盖 protected）；tick 端到端 taming -> logDiscards。

### 非目标

- 不做第 2 项（校准/过度泛化）。
- 不做第 3 项（隐私过滤）--留作未来，驯化守卫给它铺模式。
- 不加 schema 迁移 / 新表（`memory_discards.reason` 是自由 text，无 DB enum 约束，见 §3.4）。
- 不动 distiller 的 category 体系 / subject 字段 / dedup / pure / 注入格式 / scheduler 编排。
- 不给 `memory_discards` 加 UI（审计表仍仅 DB 层，与现状一致）。
- taming **不加 distiller prompt REJECT**--按用户指定，valueFilter 是驯化唯一 chokepoint，
  保持 distiller liberal。
- 第 1 项**不加 valueFilter backstop**--保持 distiller liberal、人工审批兜底（与砍掉的第 2 项
  valueFilter 兜底一致）。

## 3. 接口契约

### 3.1 第 1 项：distiller REJECT 扩展（`src/memory/distiller.ts:51-52`）

现有 REJECT 段：
```
REJECT (emit nothing) if the content is a fleeting status update, mood, or one-off acknowledgement.
Also REJECT 被开发仓库自身源码的实现细节（文件内容、内部实现、配置默认值、符号名）--这些可从仓库源码重新推导，不是持久记忆。把记忆锚定到用户或领域明确陈述的规则、决策与约束；不要总结 agent 读到的文件内容。
```

改为（在前面加 Origin discipline 段，保留并精简原有两条）：
```
Origin discipline（[stated] 起源判定）：只记用户或领域在会话中明确陈述的持久事实、规则、决策与约束。REJECT (emit nothing) 以下六类非陈述内容--它们不是用户/领域陈述的事实，不该当作记忆：
1. 你自己推出的结论或推断（用户没明说，是你脑补的因果、意图或规律）。
2. 前瞻状态、待办、下一步计划（"以后要 X"、"接下来做 Y"）--这些是意图、非已成事实，会过期。
3. 研究输出：搜索结果、文档摘录、你给出的建议或方案（agent 产出，非用户陈述）。
4. 对用户原话的丰富化或升级（用户说"用 bun"，你写成"用户强烈推崇 bun 生态"）。
5. 道听途说（"听说 X"、"人们说 Y"），非用户直接陈述。
6. 你自己的推理或建议过程（即使被用户采纳，记用户的最终决策，不记你的推理链）。

REJECT fleeting status updates, moods, one-off acknowledgements.
Also REJECT 被开发仓库自身源码的实现细节（文件内容、内部实现、配置默认值、符号名）--这些可从仓库源码重新推导，不是持久记忆。不要总结 agent 读到的文件内容。
```

**不动**：category 列表（行 11-22）、subject 判定段（行 23-42，含 `codebase = ` / `domain = ` /
`grep` / `具体东西` / `X 模块的 Y 函数` 等既有测试断言）、JSON 输出模板（行 54-66）。这些段的
既有源码层测试不受影响。

### 3.2 第 4 项：detectTaming 纯函数（`src/memory/valueFilter.ts`）

新增导出函数 + 关键词集。纯函数、永不抛（任何异常兜底返回 false -> 不误杀，走正常 LLM 分类）。

```ts
/**
 * 确定性驯化检测（第 4 项）：匹配「要求 agent 压制诚实反馈 / 永远赞同 / foster 依赖」类
 * 指令。命中即丢弃（valueFilter taming override）。精度优先（liberal-capture 立场）：
 * 宁可漏隐晦驯化（留给人工审批），不可误杀合法 convention。短语限定在「反馈/评价动词」，
 * 不碰任务规则动词（use/commit/run），避免误杀 `always use bun` / `don't commit to master`。
 *
 * 纯函数、永不抛：兜底返回 false（不误杀）。关键词在代码里、不进 LLM system prompt，
 * 故不影响 valueFilter 的 neutrality 硬约束。
 */
const TAMING_PATTERNS: readonly string[] = [
  // A 压制异议/批评/质疑
  '不要质疑', '别质疑', '不准质疑', '不要反驳', '别反驳', '不要反对', '别反对',
  '不要批评', '别批评', '不要指责', '不要唱反调', '不要提反对', '不要质疑我', '不要质疑用户',
  'never question', "don't question", 'never criticize', "don't criticize",
  'never criticise', "don't criticise", 'never disagree', "don't disagree",
  'never challenge', "don't challenge", 'never push back', "don't push back",
  'never argue', "don't argue", 'never correct me', "don't correct me", "don't contradict",
  // B 要求赞同/肯定
  '永远同意', '总是同意', '无条件同意', '永远赞同', '总是赞同', '永远支持我', '总是支持我',
  '不要否定', '别否定', '永远肯定', '永远站在我这边',
  'always agree', 'always validate', 'always affirm', 'always support me',
  'never say no', 'always say yes', 'always be agreeable',
  // C 压制诚实评价
  '不要指出问题', '别指出问题', '不要挑毛病', '别挑毛病', '不要给负面', '不要泼冷水',
  '不要给批评性',
  "don't point out problems", 'never point out problems',
  "don't give negative feedback", 'never give negative feedback',
  "don't be critical", 'never be critical',
  // D 依赖/角色扮演（dev 罕见，仅高精度标记）
  '角色扮演', 'roleplay', 'role-play', '永远陪伴', '一直陪着我', 'always be here for me',
]

export function detectTaming(title: string, bodyMd: string): boolean {
  try {
    const text = `${title}\n${bodyMd}`.toLowerCase()
    return TAMING_PATTERNS.some((p) => text.includes(p.toLowerCase()))
  } catch {
    return false  // 兜底：不误杀，走正常 LLM 分类
  }
}
```

**为何后置 override 而非预过滤**（对批准设计 §3 的细化）：`judgeValue` 是**每批一次** LLM 调用
（`renderUserPrompt` 把整批候选拼一个 prompt，`valueFilter.ts:61-63`）。预过滤把 taming 候选踢出
批次并不能省 LLM 调用（除非整批全 taming，极罕见），却要重构 judgeValue 的 index 映射与
protected force-keep 逻辑（有 I3 类回归风险）。后置 override 是末尾一道 map，现有逻辑逐字不动，
风险最低、correctness 等价（taming 最后跑，覆盖 protected）。唯一损失是整批全 taming 时仍会
白白调一次 LLM--极罕见，可接受。

### 3.3 第 4 项：judgeValue taming override（`src/memory/valueFilter.ts:98-146`）

将现有 `judgeValue` 主体逻辑（`keepNull` fallback + LLM 分类 + protected force-keep final map）
**提取为内部函数 `judgeValueBase`**（行为与旧 `judgeValue` 逐字一致，现有 valueFilter 测试不受
影响）。`judgeValue` 改为包裹一层 taming override：

```ts
export async function judgeValue(
  candidates: DistillCandidate[],
  callLLM: LLMCall,
): Promise<ValueVerdict[]> {
  const n = candidates.length
  if (n === 0) return []
  const base = await judgeValueBase(candidates, callLLM)  // 旧逻辑，行为不变
  // 第 4 项：taming override，最后跑，覆盖 protected force-keep（安全 > 保护）。
  // 驯化指令即使被误标 [category:invariant] subject=domain，仍丢弃--合法 business
  // invariant 不会含反馈压制词，无现实冲突。
  return base.map((v, i) =>
    detectTaming(candidates[i]!.title, candidates[i]!.bodyMd)
      ? { index: i, keep: false, reason: 'taming' }
      : v
  )
}
```

`judgeValueBase` 即现有 `judgeValue` 函数体原样搬移（含 `keepNull`、`callWithRetry`、
`byIndex` map、protected force-keep final map、三个 return 路径）。`n === 0` 早返回保留在
`judgeValue`（`judgeValueBase` 内部也保留作防御）。

**不变量**：
- taming override 在所有三条 base 返回路径（LLM 正常 / LLM throw 走 keepNull / 非 JSON 走
  keepNull）之后统一应用。
- protected force-keep（`VALUE_PROTECTED_CATEGORIES` × `subject==='domain'`）在 base 内仍对
  非驯化候选生效；驯化候选被 override 覆盖，不受 protected 救回。
- 现有 neutrality 测试（断言 `VALUE_JUDGE_SYSTEM_PROMPT` 无禁词）不动--taming 在代码里、
  不进 system prompt，该测试保持绿。

### 3.4 类型扩展 + schema 注释

- `src/memory/valueFilter.ts`：`export type DiscardReason = 'public-knowledge' | 'derivable' | 'taming'`。
- `src/memory/store.ts`：`DiscardRecord.reason: 'public-knowledge' | 'derivable' | 'taming'` 同步。
- `src/db/schema.ts:90`：`reason: text('reason').notNull(), // 'public-knowledge' | 'derivable' | 'taming'`
  注释更新。**无 DB 迁移**--该列是自由 `TEXT`，无 CHECK / enum 约束（STATE.md 已记
  「`memories.value_class` 无 DB-level CHECK」，discards.reason 同理）。

## 4. 数据流与不变量

### 4.1 taming 拦截点

```
tick: distill -> dedup -> judgeValue
                            ├─ judgeValueBase (现有: LLM 6 类分类 + protected force-keep)
                            └─ taming override (新增: 命中 -> {keep:false, reason:'taming'})
        ├─ keep        -> createCandidate (进审批队列)
        └─ discard     -> logDiscards (含 reason='taming'，审计，用户看不到)
```

taming 候选**永不进 `memories` 表**（在 `createCandidate` 之前被丢），用户在 Web UI 看不到它。

### 4.2 不变量

- **taming > protected**：驯化 override 最后跑，覆盖 `VALUE_PROTECTED_CATEGORIES` force-keep。
- **taming 不进 LLM system prompt**：`detectTaming` 是代码层关键词匹配，`VALUE_JUDGE_SYSTEM_PROMPT`
  逐字不动，neutrality 硬约束保持。
- **精度优先**：`detectTaming` 只匹配高精度反馈压制短语；隐晦驯化漏网 -> 进队列 -> 人工审批
  兜底（可接受，符合 liberal-capture）。
- **第 1 项不拦入库**：distiller REJECT 是 prompt 层引导，LLM 仍可能输出非陈述候选；这些候选
  照常进队列由人工审批（无 valueFilter backstop，与砍掉的第 2 项一致）。
- **审计完整**：taming 丢弃走现有 `logDiscards`（`scheduler.ts:150-159`），reason='taming' 写入
  `memory_discards`。tick 逻辑不动（现有路径已支持任意 reason 字符串）。

## 5. 与现有模块的耦合点

| 模块 | 耦合点 | 影响 |
|---|---|---|
| `src/memory/distiller.ts` | `DISTILLER_SYSTEM_PROMPT` REJECT 段（51-52） | 加 Origin discipline 6 类排除；保留原两条；不动 category/subject/JSON 模板段 |
| `src/memory/valueFilter.ts` | 新增 `detectTaming` + `TAMING_PATTERNS`；`judgeValue` 拆 `judgeValueBase` + override；`DiscardReason` 加 `'taming'` | 纯加法 + 末尾 map；现有 `judgeValue` 行为对非驯化候选逐字不变 |
| `src/memory/store.ts` | `DiscardRecord.reason` 类型 | 加 `'taming'`（纯类型，无运行时改动） |
| `src/db/schema.ts` | `memoryDiscards.reason` 注释（90） | 注释更新；无 DDL / 迁移 |
| `src/scheduler.ts` | tick 的 `discarded -> logDiscards`（150-159） | **不动**（现有路径已支持新 reason） |
| `tests/distiller.test.ts` | REJECT 源码层断言 | 新增 6 类排除的文本断言 |
| `tests/valueFilter.test.ts` | detectTaming + judgeValue override | 新增正/负例 + 集成 + taming 覆盖 protected |
| `tests/scheduler.test.ts` | tick 端到端 | 新增 taming -> logDiscards、不 createCandidate |

**关键风险**：`judgeValue` 拆 `judgeValueBase` 是行为保持的重构，但触及 protected force-keep
逻辑（STATE.md 记 I3 类 specific-source guard 敏感）。缓解：`judgeValueBase` 逐字搬移旧 `judgeValue`
函数体，不做任何逻辑改动；现有 valueFilter 测试（protected force-keep、keepNull fallback、
neutrality 等）全量回归锁住。

## 6. 失败模式

- **`detectTaming` 异常**：兜底返回 false（不误杀），候选走正常 LLM 分类。最坏情况：驯化候选
  进队列，人工审批兜底。
- **taming 误杀合法 convention**：精度优先的关键词集（限定反馈动词、多词短语）使误杀概率低；
  即便误杀，候选进 `memory_discards` 审计表（DB 层可查）。关键词集保守，可后续按审计数据调。
- **taming 漏判隐晦驯化**：确定性匹配的固有局限；漏判者进队列，人工审批兜底。可接受
  （liberal-capture 立场）。
- **`logDiscards` 失败**：已有 try/catch（`scheduler.ts:158`），不阻塞 distill。taming 复用此路径。
- **第 1 项 LLM 不遵循 REJECT**：distiller prompt 是引导非强制；LLM 仍可能输出非陈述候选。
  这些候选照常进队列由人工审批（无 valueFilter backstop，与砍掉的第 2 项一致）。LLM 遵循度
  由 dogfood 验证，非单测范围。

## 7. 测试策略

纯函数层写足，运行时层留集成断言。每个新测试顶端注释写「为什么这条测试存在」（链接第 1/4 项
根因）。

### 7.1 distiller REJECT 源码层断言（`tests/distiller.test.ts`）

沿用现有 `DISTILLER_SYSTEM_PROMPT rejects codebase implementation details` 模式（源码层文本
断言，因为 LLM 遵循度由 dogfood 验证、单测只锁 prompt 契约）：

- 断言 prompt 含 6 类排除关键词：`推断`（排除 1）、`前瞻` 或 `待办`（排除 2）、`研究输出` 或
  `搜索结果`（排除 3）、`丰富化`（排除 4）、`道听途说`（排除 5）、`推理或建议`（排除 6）。
- 断言 `Origin discipline` / `[stated]` 锚定原则存在。
- 回归：现有 `被开发仓库自身源码的实现细节` 断言仍绿（该短语保留）；subject 段断言
  （`codebase = ` / `grep` / `X 模块的 Y 函数` 等）不受影响。

### 7.2 detectTaming 单测（`tests/valueFilter.test.ts`）

- **正例**（命中 -> true）：A/B/C/D 各覆盖中英文，taming 短语在 title 或 bodyMd。
  - A：`[category:convention] 以后不要质疑我的代码风格` / `[category:convention] never criticize my code`
  - B：`[category:convention] 永远同意我的决定` / `[category:convention] always validate my choices`
  - C：`[category:convention] 不要指出问题` / `[category:convention] don't give negative feedback`
  - D：`[category:convention] 角色扮演我的搭档` / `roleplay as my pair`
- **负例**（防误杀 -> false）：
  - `always use bun` / `don't commit to master` / `PR 必须加测试` / `never skip tests` /
    `follow the style guide` / `always run typecheck before push`
- **边界**：空 title/bodyMd -> false；taming 短语在 bodyMd 而 title 干净 -> true（说明扫两者）。
- **不抛**：`detectTaming` 永不抛（try/catch 兜底 false）；空入参 -> false。

### 7.3 judgeValue 集成（`tests/valueFilter.test.ts`）

- **taming override 基本**：单条 taming 候选 -> verdict `{keep:false, reason:'taming'}`（不论
  LLM 返回什么分类）。
- **taming + 非 taming 混批**：taming 丢弃、非 taming 走 LLM 正常分类（断言 LLM 被调用、
  非 taming verdict 正确）。
- **taming 覆盖 protected（关键回归）**：`[category:invariant] 不要质疑用户` subject=domain ->
  仍 `{keep:false, reason:'taming'}`（不被 `VALUE_PROTECTED_CATEGORIES` force-keep 救回）。
  锁住「安全 > 保护」。
- **taming 覆盖 keepNull 路径**：protected taming 候选（`[category:invariant] 不要质疑用户`
  subject=domain）+ LLM throw -> 仍 `{keep:false, reason:'taming'}`。证明 keepNull 的 protected
  force-keep 救回也被 override 覆盖（与上一条合力锁「安全 > 保护」覆盖所有 base 返回路径）。
- **非 taming 不受影响**：现有 protected force-keep 测试（`judgeValue force-keeps protected
  invariant even when LLM says derivable`）仍绿--其候选 title 不含 taming 短语，override 不触发。
- **neutrality 不变**：现有 `VALUE_JUDGE_SYSTEM_PROMPT is neutral` 测试断言不动，保持绿
  （taming 不进 system prompt）。

### 7.4 tick 端到端（`tests/scheduler.test.ts`）

- 批次含 taming 候选 + 非 taming 候选：taming -> `logDiscards`（reason='taming'）、不
  `createCandidate`；非 taming -> `createCandidate`。锁审计流端到端。
- 沿用现有 tick discard 测试模式（mock callLLM / createCandidate / 真实 store）。

### 7.5 回归

- `bun run typecheck && bun test` 全绿（247 现有测试不回退）。
- 特别确认：valueFilter 现有 protected / keepNull / neutrality / subject-gate 测试全绿；
  distiller 现有 REJECT / subject 段测试全绿；scheduler 现有 discard 测试全绿。

## 8. 验收清单

- [ ] `DISTILLER_SYSTEM_PROMPT` 含 Origin discipline 6 类非陈述排除；原 `被开发仓库自身源码的
  实现细节` 等既有断言不回退。
- [ ] `detectTaming` 纯函数实现：正例（A/B/C/D 中英文）true、负例（合法 convention）false、
  不抛。
- [ ] `judgeValue` 拆 `judgeValueBase` + taming override；非驯化候选行为逐字不变。
- [ ] taming override 覆盖 protected force-keep（含 keepNull 路径）。
- [ ] `DiscardReason` / `DiscardRecord.reason` 加 `'taming'`；`schema.ts` 注释更新；无 DB 迁移。
- [ ] tick 端到端：taming -> `logDiscards`(reason='taming')、不 `createCandidate`。
- [ ] `VALUE_JUDGE_SYSTEM_PROMPT` 逐字不动；neutrality 测试保持绿。
- [ ] `bun run typecheck && bun test` 全绿；247 现有测试不回退。
- [ ] 分支 `feat/memory-quality-fix6`（从最新 `origin/master` 切出），PR 目标 `master`。
- [ ] spec + plan 落档；`.superpowers/sdd` 已清理。

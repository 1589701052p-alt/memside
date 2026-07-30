# 出处驱动的价值判定（origin-driven value judgment）

## 背景

对现行价值判定（distiller 10 category + ruleObject codebase/domain + judgeValue 6 筐）做
完整评估后确认其两根判定轴都选错了，两头误判：

**误杀（live 实测，2026-07-30）**：新版判定代码上线后（7-30 起），distill 产出 8 条候选
被全数自动拒绝（reason 全为 derivable），其中 3~4 条是用户亲口确认的决策/硬性要求——
「凭证解析链 UI → settings.json → env → credentials.json（用户确认，动因是 env 残留
导致 401 事故）」「UI 必须回显当前生效的 API 来源（用户硬性要求）」「LLM 凭证应通过
Web UI 配置（用户明确的决策）」。7-30 起新代码战绩：入库 0 条，拒绝 8 条。

**误留（旧代码战绩，仅作背景）**：7-30 之前旧判定代码下 573 候选 vs 3 审批，存活候选
大量是 memside 自身源码实现细节（「callThrew 偏差」「快照保真度不变性」等），只因正文
带了"为什么"就被分进 decision 筐。

**根因分析**：

1. **判定轴错位**。现行体系的主轴是 domain（仓库外业务）好 / codebase（本仓库）坏；
   用户的实际价值观是「用户亲口陈述的规则/决策/约束 = 最有价值」，与它描述的是哪个
   仓库无关。judge prompt 第 2 条（`src/memory/valueFilter.ts:19-22`）明确指示
   「描述本仓库的候选即使带 rationale 也算 derivable」，把用户决策和源码琐事一刀切。
2. **"derivable 扔"规则半对半错**。对「是什么」类事实（代码里有、可重读、存了会腐烂）
   扔得对；对「谁定的、为什么」类决策扔得错——代码只记录决策结果，不记录动机与约束力，
   理由不在代码里，丢了就是真丢了。
3. **筐覆盖不全**。6 筐没有「用户明确立的规矩」「用户偏好」「事故教训」的位置，用户
   批准的 3 条记忆里 2 条（brainstorming 流程、quality-bar）在 6 筐里都无合适归宿。
4. **保护类门槛答非所问**。invariant/integration/compliance 强制保留要求
   ruleObject=domain，导致本仓库的安全硬约束（token 全链路打码）连保护资格都没有。
5. **「拿不准标 codebase」+「codebase 倾向 derivable」形成系统性绞肉机**，与用户
   liberal-capture + 人工兜底的既定立场相反。
6. **结构缺陷**：judge 只看候选标题/正文，看不到对话原文。「用户说没说」这个关键证据
   在蒸馏时存在、到判定时已丢失，任何「用户陈述优先」的标准在现行架构下都无法执行。

### 诚实声明（用户原话，必须随 spec 留存）

> 开发仓库自身源码的实现细节不记，理由是这些东西翻翻代码就能重新知道，不算记忆。
> 但因为蒸馏器看不到仓库源码，所以只能启发式推断。

本 spec 的 Q2（仓库重推题）是**启发式推断**：判定器物理上看不到仓库（只能凭候选文本
长相推断「这写没写在代码里」），蒸馏器也看不到仓库（只有过滤版对话）。Q2 的安全性不
依赖模型聪明，依赖两道结构保护：origin 门禁（用户陈述类禁考 Q2）+ 代码硬兜底（LLM
违规对用户陈述类返回 derivable 时自动改判保留）。第二期可选增强（grep 预检）可把
真实仓库证据接进判定环节，见「非目标」。

## 目标 / 非目标

**目标**

- 判定锚点从「domain vs codebase」换成「用户陈述 vs 可重新推导」：distiller 为每条
  候选输出 `origin`（user-stated / user-confirmed / agent-observed）+ `evidence`
  （对话原文摘句），随候选入库、供判定与人工审批使用。
- judgeValue 重写：生死题（三理由三考题）与标签题（6 价值筐）分离。标签判错代价低
  （徽标不准），生死判错代价高（记忆没了）——生死侧全部上保险。
- 用户陈述类（user-stated / user-confirmed + 有效 evidence）免疫 derivable 丢弃
  （prompt 禁考 + 代码兜底双保险）；AI 仍可用 fleeting 考题判其丢弃（保留 AI 对
  用户话语的判断权）。
- 价值筐扩编 4 → 6（+user-rule、+preference，trap 扩含事故教训），`value_class`
  列免迁移（自由文本）。
- 审计/兜底语义不变：taming 守卫最高优先、LLM 失败全保留、丢弃进
  `memory_discards` 可提升。
- Web UI：审批卡片显示 evidence 出处 + 6 筐徽标；「AI自动拒绝」tab 支持新丢弃
  理由 fleeting。

**非目标**

- **grep 预检（第二期）**：scheduler 本机可读 `job.cwd` 仓库，可从候选抽符号 token
  grep 后把「仓库实锤」证据附给判定器，把 Q2 从启发式升级为带证判定。纯增量（判定
  规则不用改），本次不做——一次改太多变量，出问题不好归因。
- **存量重判**：573 条旧候选不按新规则重跑；用户可用现有「批量拒绝未评估」+ 手动
  审批自行清理。
- 不改 dedup、不改 taming 关键词集、不改 distill 调用的 retry/超时策略。
- 不改 `memory_discards` schema（reason 是自由文本，fleeting 直接写入无需迁移）。

## 核心设计：判定规则全集（按优先级，命中即定）

### R0 驯化守卫（纯代码，现状不变）

`detectTaming(title, bodyMd)` 命中压制反馈关键词 → 丢弃，reason=`taming`。压过一切
（含 R2 保护），安全 > 保护。

### R1 出处门（distiller 输出 + 代码校验）

distiller 为每条候选输出两字段：

- `origin`：
  - `user-stated` — 用户原话明确说出的规则、决策、约束、偏好
  - `user-confirmed` — agent 提出、用户明确采纳（"对"/"就这么办"/"可以"）
  - `agent-observed` — 其余一切（agent 从工具报错/代码阅读/事件自行总结）
- `evidence` — 从 transcript 摘抄的出处原句（≤1 句；user-confirmed 为 agent 提议句
  + 用户采纳句）。**找不到原话出处，不许标 user-stated / user-confirmed。**

代码校验（distiller 解析层）：origin 缺失/非法 → `agent-observed`；标了 stated/
confirmed 但 evidence 空 → 降级 `agent-observed`。贴金防护：弱模型乱贴高价值标签
时，摘不出原话就拿不到保护。非法 origin 值触发一次 retry（同现有 `distillShouldRetry`
模式）。

### R2 LLM 判定（dedup 之后，一次调用，先定生死再贴标签）

**生死题 —— 只允许三个丢弃理由，各配一道考题：**

- **Q1 公开知识题**（对所有 origin 合法）：「没读过这仓库、没参加过这会话的工程师，
  凭通用知识/官方文档能写出这条吗？」是 → 丢 `public-knowledge`。
  锚点：「Python 字典无序」→ 是；「本项目退款限发货后 14 天」→ 否。
- **Q2 仓库重推题**（**仅对 agent-observed 合法**）：「只看仓库代码/文档/配置，不看
  对话，能重新推出这条内容吗？」是 → 丢 `derivable`。
  锚点：「打码规则是前 6 位 + 后 4 位」→ 是；「凭证链 UI 优先是因为 env 残留出过
  401 事故」→ 否（代码只有顺序，没有为什么）。
  **prompt 硬规则：origin 为 user-stated / user-confirmed 的候选禁止考 Q2。**
  **代码硬兜底：LLM 违规对 stated/confirmed 候选返回 derivable → 自动改判保留**
  （valueClass 取 LLM 标签题结果，缺省 `decision`）。
- **Q3 时效题**（对所有 origin 合法，含用户陈述）：「三个月后开全新会话，这条还有
  约束力/参考价值吗？」否 → 丢 `fleeting`（新丢弃理由）。
  锚点：「今天先到这吧」→ 否（一次性状态）；「任何改动必须走分支 + PR」→ 是
  （长期规矩）。**这是 AI 对用户话语的判断权所在**：用户随口的琐事可被 AI 判丢，
  但理由只能是 fleeting，永远不能是 derivable。

**标签题 —— 留下的每条分进 6 筐（ValueClass 扩编）：**

| 筐 | 装什么 |
|---|---|
| `user-rule` | 用户明确立的规矩/硬约束（流程规矩、质量门槛、安全约束） |
| `decision` | 决策 + 理由（用户拍板或用户采纳的） |
| `preference` | 用户偏好、沟通/协作习惯 |
| `convention` | 团队/仓库未成文约定（非用户亲口但稳定存在） |
| `trap` | 坑、反直觉行为、**事故教训**（postmortem 并入本筐） |
| `topology` | 跨模块/跨服务/跨仓库、单点看不见的连接 |

标签判错代价低（徽标/排序偏差，记忆还在），故 6 筐放心交给弱模型；生死只许三理由
+ 考题 + 代码兜底。

### R3 失败兜底（现状语义不变）

judge LLM 调用失败 → 当批全保留，`valueClass=null`（未评估，可被「批量拒绝未评估」
清理）。distiller 失败语义不变（0 候选降级）。

### R4 配套环节不动

dedup 在判定前照常跑；`memory_discards` 审计（reason 新增 `fleeting` 值，自由文本
列免迁移）、「AI自动拒绝」tab、`promoteDiscard` 提升按钮全部零改动。

## 规则验收（7-30 被误杀的 8 条对照）

| 候选 | origin | 走哪条 | 新结果 |
|---|---|---|---|
| 凭证链优先级（用户确认+事故理由） | user-confirmed | R2 标签题 → decision | **留** |
| UI 必须回显生效来源（用户硬性要求） | user-stated | R2 标签题 → user-rule | **留** |
| 凭证应走 UI 配置（用户明确决策） | user-stated | R2 标签题 → decision | **留** |
| token 不得明文返回（用户方陈述的安全约束） | user-stated | R2 标签题 → user-rule | **留** |
| 打码规则前 6 后 4（实现细节） | agent-observed | Q2 是 → derivable | 丢 |
| 保存后无需重启（读代码即知） | agent-observed | Q2 是 → derivable | 丢 |

## 数据模型

`memories` 加两列（幂等 ALTER 迁移，同 `source_cwd`/`value_class` 模式）：

| 列 | 类型 | 说明 |
|---|---|---|
| `origin` | TEXT (nullable) | `user-stated`/`user-confirmed`/`agent-observed`。老行 NULL = 未标注。 |
| `evidence` | TEXT (nullable) | 出处原句摘抄。老行 NULL。 |

`value_class` 无 schema 变更（自由文本列，TS 层 `ValueClass` 枚举加 `user-rule` /
`preference`）。`memory_discards.reason` 无 schema 变更（自由文本，加 `fleeting` 值）。

**表重建注意**：`memories` 在 `feat/distill-signal-recovery` 已因 CHECK 约束做过一次
表重建 migration（STATE.md 记录：未来加列需 lockstep 更新 `memories_new` DDL）。本次
加列走幂等 ALTER（新列无 CHECK），同时更新 DDL 与 `memories_new` 副本保持一致。

## 模块改动点

### 1. distiller（`src/memory/distiller.ts`）

- `DistillCandidate` 加 `origin: 'user-stated'|'user-confirmed'|'agent-observed'` 与
  `evidence: string | null`。
- `ruleObject` 字段**退役**（domain/codebase 轴废除；valueFilter 不再消费它）。
  distiller 输出 schema 移除 ruleObject 及其 prompt 段。
- prompt 改动：
  - 删除「REJECT 被开发仓库自身源码的实现细节」一刀切句，换成精确表述：复述 agent
    读到的文件内容/符号细节不记；**用户亲口陈述的关于本仓库的规则/决策/约束必须记**。
  - 新增 origin/evidence 字段说明 + 「找不到原话出处不许标 stated/confirmed」硬约束。
  - Origin discipline 六道 REJECT 原样保留。
- `distillShouldRetry` 加 origin 值校验（非法触发一次 retry，耗尽后降级
  agent-observed，不丢候选）。

### 2. valueFilter / judgeValue（`src/memory/valueFilter.ts`）

- `VALUE_JUDGE_SYSTEM_PROMPT` 重写：三生死考题（Q1/Q2/Q3，各带锚点）+ 6 筐标签题 +
  「stated/confirmed 禁考 Q2」硬规则。输出格式：
  `{"verdicts":[{"index":0,"action":"keep","valueClass":"decision"},
  {"index":1,"action":"discard","reason":"derivable"}]}`。
- `ValueVerdict` / `DiscardReason` 类型：DiscardReason 加 `'fleeting'`；ValueClass
  加 `'user-rule'|'preference'`。
- 代码硬兜底：LLM 对 origin=stated/confirmed 候选返回 discard+derivable → 改判
  keep（valueClass 取 LLM 标签结果 ?? `'decision'`）。
- `keepNull()` 失败兜底保留（R3），其中 stated/confirmed 候选 fallback valueClass
  为 `'decision'`（免疫批量拒绝），observed 为 null。
- `VALUE_PROTECTED_CATEGORIES`（invariant/integration/compliance × domain 强制保留）
  **退役**——domain 硬规则在新体系下自然存活（Q2 对仓库外业务规则答案恒为「否」），
  用户陈述的保护由 origin 门接管。
- taming override 逻辑原样保留（最后跑，压过一切）。

### 3. scheduler（`src/scheduler.ts`）

- tick 接线：origin/evidence 随 `createCandidate` 入库；judgeValue 入参带 origin。
- distill run 计数链（distilled→deduped→filtered→stored）语义不变。

### 4. store（`src/memory/store.ts`）

- `createCandidate`/`MemoryInput`/`Memory` 加 origin/evidence 读写。
- 幂等迁移：`PRAGMA table_info(memories)` 检测加列。

### 5. server / web-api（`src/server.ts`、`src/web/api.ts`）

- `GET /api/memories` 响应带 origin/evidence（透传，无新端点）。
- web-api `MemoryItem` 类型加 origin/evidence；`DiscardItem` reason 联合类型加
  `'fleeting'`。

### 6. Web UI（`src/web/App.tsx`、`src/web/ui-utils.ts`）

- MemoryCard 审批卡片：origin 徽标（用户陈述/用户采纳/agent 观察）+ evidence 出处行
  （「用户原话：……」样式，NULL 不显）。
- valueClass 徽标扩 6 筐（user-rule / decision / preference / convention / trap /
  topology + 未评估），排序优先级：user-rule=decision=高，preference=convention=
  trap=topology=中，null=低。
- DiscardCard reason 徽标加 fleeting 文案（「一次性/琐事」）。

## 失败模式

1. **origin 标错方向单向收紧**：stated 错标 observed → 多过 Q1/Q3 考题仍可能活，
   或被 Q2 误杀（evidence 在审批卡片上可溯源，审计表可提升）；observed 错标
   stated → evidence 摘抄门槛挡住（摘不出原话即降级）。
2. **Q2 启发式误判**（false no：源码琐事被判「推不出」）→ 进候选队列由人工审批挡
   （liberal-capture 既定取舍）；（false yes：有价值内容被误杀）→ 只可能发生在
   agent-observed 类，审计表可提升。
3. **用户随口琐事贴 user-stated 溜入**：distiller Origin discipline 拦大部分，
   Q3 时效题再拦一轮，最后人工审批兜底。
4. **LLM 输出格式劣化**：shouldRetry 一次重试 + 耗尽后保守保留（R3），与现有
   callWithRetry 模式一致。

## 测试策略（CLAUDE.md 首选可断言面）

纯函数层：

- origin 解析/校验：非法值降级、evidence 空降级、retry 触发条件。
- judgeValue verdict 映射：三生死理由 → discard；6 筐 → keep+valueClass；非法
  category → keep+null。
- **代码硬兜底**：stated/confirmed + LLM 返回 derivable → 改判 keep（回归防护，
  对应 7-30 误杀事故）。
- keepNull 兜底：LLM 失败时 stated → decision / observed → null。
- ui-utils：6 筐徽标映射、origin 徽标、fleeting 文案。

prompt 文本断言（与现有 distiller.test.ts 模式一致）：

- distiller prompt 含 origin/evidence 字段说明 + 「找不到原话不许标 stated」硬约束。
- judge prompt 含三考题 + 「stated/confirmed 禁考 Q2」+ 6 筐定义。

e2e 门禁测试（镜像 fix5 模式）：

- 用户陈述的本仓库决策在 LLM 误判 derivable 时仍入库且不进 discards（7-30 事故
  回归锁）。
- fleeting 丢弃写 `memory_discards` 且可 promote。

集成：store 迁移幂等（老行 origin/evidence NULL）、server 透传、UI 卡片区渲染。

## 与现有模块的耦合点

- `scheduler.ts:174` judgeValue 调用点（入参加 origin）。
- `store.ts` createCandidate / 迁移函数（同 source_cwd 模式）。
- `valueFilter.ts` 全文重写 judge prompt + verdict 映射（taming/keepNull 骨架保留）。
- `distiller.ts` prompt + 解析 + `DistillCandidate` 类型（ruleObject 退役波及
  scheduler renderUserPrompt 的 ruleObject hint 行同步删除）。
- `App.tsx` MemoryCard/valueBadge/DiscardCard。

## 第二期候选（本 spec 不做）

- grep 预检：scheduler 从候选抽符号 token 在 `job.cwd` grep，证据行附给判定器。
- 存量 573 候选按新规则批量重判工具。
- evidence 在注入块（formatMemoryBlock）中的呈现（本期仅审批卡片可见）。

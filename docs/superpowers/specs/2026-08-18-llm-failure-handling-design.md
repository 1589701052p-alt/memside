# LLM 失败处理重构：可接续 agent 会话执行器

> 状态：设计 spec（待审阅 → 实现计划）
> 日期：2026-08-18
> 背景：公司内测实测——distill 阶段连续两条 360036ms / 360045ms 的 "operation was aborted" 错误，
> 且候选全部"未评估"、AI 自动拒绝 0 个。根因调查见 §1。

## 0. 一句话目标

把 memside 与 LLM 的关系从"一次性大请求、失败即丢"重构为"带历史、可中断、可接续的多轮 agent 对话"：
**任何 LLM 调用失败都不再被当成正常业务结果静默吞掉，而是有记忆地重试接续，失败全程可见，内容绝不丢失。**

## 1. 背景：为什么现在的 LLM 错误处理不健壮

memside 每个蒸馏任务顺序跑四步，每步都要问一次 LLM，用的是同一个 LLM 调用接口（`scheduler.ts:235-237` 构造 `tracked`，distill `:327`、judge `:373/:380` 共用）：

1. **蒸馏（distill）**：喂对话记录，要 LLM 吐候选记忆 JSON。
2. **去重（dedup）**：拿候选跟已有记忆比，去掉重复。
3. **审查（judge）**：给每条候选判价值、打标签。
4. **摘要（digest）**：把这段对话压成账本，下次蒸馏当上下文。

现在的失败处理有三个系统性缺陷（"局部合理、全局错误"——每段单独看都有理由，拼在一起就是失败被当成功处理）：

### 缺陷 1：LLM 失败被当成正常业务结果，不走任务级重试

scheduler 的 job 重试机制（`scheduler.ts:512-520`，docstring `:204-213`）只在**抛异常**时触发。但 LLM 调用失败**不抛异常**到那一层：

- `anthropic.ts` 流式调用被网关掐断抛 AbortError → distiller 的 `wrappedCall`（`distiller.ts:216-220`）catch 住记 `callThrew=true` 并 `throw e`，但这在 `callWithRetry` 内部（`retry.ts:41-45`）被喂回模型重试，3 次撞墙后返回 `undefined`，**不抛**。
- `distiller.ts:283-289` 顶层 catch 把一切异常吞成 `{candidates:[], callThrew:true}`，**永不抛**。
- 回到 scheduler：`candidates.length===0 && callThrew` → `outcome='llm_error'`（`scheduler.ts:435-437`）→ 写通知、写 last_error（这是为什么 distill 失败**可见**）。
- **然后 `scheduler.ts:478` 无条件标 `done`**：job 被消费，下次永不重跑。
- `:482` 还推进 session offset（`setSessionOffset`）→ 失败那批对话**永久跳过**，重试时切出的范围已错乱。

外层 catch（`:512-520`）根本没进——因为 distill 不抛、judge 不抛（judge 走 `keepNull`/`keepAll` 兜底）。

### 缺陷 2：judge 失败完全静默

judge 的失败可见性与 distill **分裂**：

- `valueFilter.ts:217-223,240-242`：judge LLM 报错 → `keepNull()` → 全 `keep:true`（0 丢弃 = AI 自动拒绝 0），`agent-observed` 候选给 `valueClass:null`（= 未评估）。
- `agentJudge.ts:54,112-114`：agentic judge 的 `llm-error`/`time-budget` stopReason → `keepAll()` 全保留兜底，catch 吞掉不抛。
- 通知和 last_error **只在 `outcome==='llm_error'||'parse_error'` 时写**（`scheduler.ts:463-476`），而 `outcome` 只反映 **distill** 阶段。judge 在 distill 产出候选**之后**跑，失败不进 outcome，**零通知**。
- `distiller.ts:262-271`：origin 默认 `agent-observed`（非 Claude 后端基本不标 stated，或摘不出 evidence 就降级）→ judge 失败时全批候选落 `null` = 未评估。

**这就解释了用户观察到的"全部未评估 + AI 自动拒绝 0"：审查跑了，被 360s 掐断了，被当成"正常 0 丢弃"静默处理了。**

### 缺陷 3：360s 网关墙场景下的放大问题

- SDK 0.32.1 实测：`DEFAULT_TIMEOUT=600000`（`core.js:136`），memside 也传 `600_000`（`anthropic.ts:79`）。360s ≠ 600s，**不是 memside/SDK 的 timeout 触发**——是公司 codeagent 网关的 360s（6 分钟）硬上限掐断了连接。
- "the operation was aborted" 是裸 AbortError 消息（SDK 自己的 timeout 抛 `APIConnectionTimeoutError`，消息是 "Request timed out"，不是这句）。
- `maxRetries` 保留 SDK 默认 2（`anthropic.ts` 注释明说）→ `core.js:316` 对 abort 会 `retryRequest` → 一次失败叠加成 3 次悬挂。STATE.md 早记过"llm_error 时长 448-566s 是 SDK 默认重试叠加"——360s 是同模式。

## 2. 设计原则（硬约束）

用户铁律：**memside 不得有任何静默失败或静默降级，必须让用户看得见。**

由此导出：

| 编号 | 原则 | 含义 |
|---|---|---|
| P1 | 失败≠正常结果 | LLM 调用失败是基础设施故障，不是"0 候选/全保留"的业务结果。失败就是失败，要么重试要么报错，不许静默吞。 |
| P2 | 有记忆地重试 | 重试不傻跑同样请求，带着之前的输入输出对话历史接着跑。像 claude code / ReAct agent 那样——LLM 知道自己"做到哪了"，重试是"接着做"不是"重做"。 |
| P3 | 断点续跑 | 一步失败，不重算前面已成功的步骤。每步结果落库，重试从失败步骤接着跑。 |
| P4 | 步骤解耦 | 步骤之间只传"干净结果"（候选清单等），不传 LLM 对话历史。每步对话是那一步的私事，历史留底但不外泄。 |
| P5 | 进度不冒进 | session offset 只在四步全部成功时推进。失败/重试/暂停中 offset 不动，不丢内容。 |
| P6 | 与 LLM 解耦 | memside 不假设网关有几秒的墙、不设主动超时。被动等失败后接续重试。360s 只是实测现象，不是设计依据。 |
| P7 | 重试有上限 | 每步最多 3 轮。3 次内成功→静默不打扰；3 次都失败→汇总成一条任务级通知，任务暂停等用户处置。 |
| P8 | 零静默 | 任何失败、暂停、待审查状态都必须在 Web UI 可见、可处置。 |

## 3. 核心设计：可接续 agent 会话执行器

### 3.1 从"单次请求"到"多轮对话"

把 distill/dedup/judge/digest 每一步，从"发一次请求要一次完整 JSON"改成"开一段可中断、可接续的对话"：

- **会话留底**：每一步里 memside 与 LLM 的每一轮（输入 + 输出）都记进数据库。
- **失败接续**：任一轮 LLM 没给合规结果（网关掐断/格式坏/没回完），不丢这一轮。任务回队列，下次重试时**带着已有历史**追问 LLM："你上次回的是 xxx，没回完/格式错，接着出完整结果。"LLM 看到自己上次说过什么，接着补。
- **区别**：LLM 知道自己"做到哪了"，重试是"接着做"。这是 ReAct/agent 模式落地。

### 3.2 四步统一套用此模式，但各自封闭

```
一个蒸馏任务（单任务内断点续跑）
 ├─ 步骤1 蒸馏：[自己的对话历史(留底)] → 产出"候选清单"（干净结果）
 ├─ 步骤2 去重：[自己的对话历史(留底)] → 产出"去重后清单"
 │   输入=候选清单（干净结果，非蒸馏对话历史）
 ├─ 步骤3 审查：[自己的对话历史(留底)] → 产出"判决清单"
 │   输入=去重后清单（干净结果）
 └─ 步骤4 摘要：[自己的对话历史(留底)] → 产出"会话账本"
     输入=原始对话记录
```

- 每步的对话历史是该步私事，跟着该步走，**不跨步传递**（P4）。步骤间只交接干净结果。
- 步骤间数据流是天然耦合（后步输入依赖前步产出），但通过"干净结果落库 + 断点续跑读回"解耦执行——一步失败不拖累整任务重来（P3）。

### 3.3 三条不变量

1. **历史完整留底**：每一轮的输入输出都存 DB，重试基于这段历史继续，不凭空。
2. **失败绝不冒充成功**：LLM 没给合规结果就是"这轮失败"，绝不像现在 judge 那样走"全保留"兜底假装成功。
3. **对话范围锁定**：对话进行中，喂给 LLM 的原始素材（对话记录、候选清单）锁死不变。重试换的是"怎么追问"，不是"换素材重算"。

## 4. 数据模型

### 4.1 复用与扩展现有表

尽量复用现有表，不新建重复结构。schema 现状见 `src/db/schema.ts`。

**`memory_distill_jobs`（任务表，扩展）**——加断点字段：
- `current_step`（text, nullable）：当前步骤 `distill|dedup|judge|digest`。NULL/缺省=`distill`（新任务）。
- `step_attempts`（integer, default 0）：当前步骤已尝试轮数（数到 3 触发暂停）。
- `step_error`（text, nullable）：当前步骤最后一次失败原因（汇总通知用）。
- 迁移：幂等 ALTER TABLE ADD COLUMN（不表重建），老行 NULL/0 = 新任务语义。
- status enum 扩展：加 `paused`（3 次失败暂停等用户处置）。老 status 值不动。

**`memory_distill_events`（对话历史表，复用）**——存每步每轮的对话历史，按"任务+步骤+轮次"索引。复用现有 `(distillJobId, attemptIndex, ts, kind, payload)` 结构，扩展 `kind` 取值与 `payload` 内容：
- `kind` 加 `llm_round`（一轮 LLM 对话）。
- `payload` JSON 每轮存四样（P4 细化）：
  1. `round`：轮次编号。
  2. `request`：memside 这一轮发的内容（user prompt 追加了什么）。
  3. `response`：LLM 这一轮回的内容（原始文本，含残缺也存）。
  4. `result`：本轮结果 `{ok: bool, reason?: string}`，reason 分类失败原因（`aborted`/`format`/`incomplete`）。
- 索引按 `step + round` 读回历史。

**`memory_distill_runs`（运行记录表，语义调整）**——一个任务的多步多轮尝试都能记。现有字段保留向后兼容，`outcome` 扩展 paused 语义；加 `pausedStep`（暂停在哪步）。

**`memories`（候选记忆表，扩展）**——加候选状态：
- 现有 `status` enum（`candidate|approved|rejected|archived|superseded`）加 `pending_review`（待审查，审查任务失败暂停期间，不进审批队列）。
- 审查通过后 `pending_review → candidate` 进队列；用户手动接管审批则直接走 approve/reject。
- 迁移：幂等 ALTER（status CHECK 约束在 SQLite 需谨慎，沿用现有迁移块模式）。

**`notifications`（消息中心，复用）**——3 次失败汇总通知落这，复用现有 `insertNotification` 同内容折叠（`store.ts:1210`）。可能加 `kind='judge_error'|'dedup_error'|'digest_error'` 或统一 `llm_error` 用 title 区分步骤（见 §7 待定）。

### 4.2 不新建的

不新建"步骤产出表"——候选清单走 `memories` 表（带 `distillJobId`、`pending_review` 状态），去重/审查的"通过清单"通过候选的状态+job 关联表达，避免新表。

## 5. 执行逻辑：断点续跑

### 5.1 一个任务的完整生命周期

```
任务 pending，nextRunAt 到了，tick 选中
  → 状态改 running，读断点字段
    → 新任务：从 distill 第1轮开始
    → 重试任务：从 (current_step, step_attempts+1) 接着跑，读回该步对话历史
  → 跑当前步骤的下一轮：
      构造输入（带该步历史）
      发给 LLM，等回复
      ├─ 合规结果 → 存历史，标记本轮成功 → 该步完成
      │    ├─ 还有下一步 → 推进断点到下一步第1轮，继续跑（仍在本次 tick 内？见 §5.4）
      │    └─ 四步全完 → 推进 session offset，标 done
      └─ 失败（掐断/格式错/没回完）→ 存历史（含残缺+原因），本轮算失败
           → step_attempts +1，更新断点 step_error
              ├─ step_attempts < 3 → 任务回 pending，nextRunAt = now + 退避，下次 tick 接着跑
              └─ step_attempts = 3 → 汇总 3 次失败，写 1 条任务级通知
                   → 任务标 paused，offset 不推进
                   → 待审查候选标 pending_review，不进审批队列
                   → 等 UI 处置（重试/放弃）
```

### 5.2 关键决策

**D1：失败后回队列等下次 tick，不立刻连发下一轮。** 避免一个任务在几秒内把 3 轮打完、全撞同一堵持续墙；给 LLM 端喘息。沿用现有 job 退避模式。退避间隔待定（现有指数 1s/2s/4s，对"3 轮内完成"可能偏长，见 §7）。

**D2：3 次失败 = 暂停等人处置，不标 failed 丢弃。** P8——绝不静默丢内容。failed（现 distill 做法）= 丢内容。新设计 paused + 通知 + 等 UI。用户可「重试」（重置 step_attempts=0，回 pending）或「放弃」（知情丢弃，推进 offset）。

**D3：offset 时机修正。** 只在四步全成功推 offset（P5）。修现有"失败也推"的 bug（缺陷 1）。

**D4：judge 静默全保留彻底废除。** judge 失败就是失败（3 轮内重试，3 次暂停+通知），**不再走 `keepNull`/`keepAll` 兜底冒充成功**（缺陷 2）。这直接解决"全是未评估"。judge 暂停期间候选标 `pending_review`（不进队列，可手动接管审批）。

### 5.3 重试时怎么追问 LLM（有记忆）

根据上一轮失败原因分类，决定这一轮怎么追问：
- `incomplete`（没回完/被掐断）→ "你上次回的是 xxx，没回完，接着出完整结果。"
- `format`（格式不合规）→ "你上次的回复格式不对（原因），请输出合规 JSON。" + JSON 模板提醒。
- `aborted`（网关掐断，无响应）→ 带历史重发，附"上次请求被中断，请重新输出。"

这扩展现有 `callWithRetry` 喂错误回模型的思路，但变成有记忆的多轮（带历史 + 分类追问）。

### 5.4 待定：一个 tick 内跑多少步

新任务四步顺序跑，是"一个 tick 跑完四步"还是"每步跑完回 pending 等下个 tick"？前者快但一个 tick 可能很长（四步 × 各轮），后者慢但调度更细。倾向前者（一个 tick 内尽量推进多步，只在失败时回队列），但需在 plan 阶段定。

## 6. 可见性与处置（Web UI）

### 6.1 状态栏（已有，补全）
- 显示"某步骤第 N 轮重试中"，不只"进行中"。
- 摘要阶段纳入显示（现归蒸馏列，符合既有约定，确保摘要失败可感知）。

### 6.2 消息中心（已有机制，接通）
- 3 次失败写 1 条任务级汇总通知：哪步、几次、每次原因。例：
  > ⚠️ 蒸馏任务失败：审查步骤重试 3 次未通过
  > 任务：xxx 会话 / 3 次失败原因：①网关掐断(360036ms) ②格式不合规(缺 verdicts) ③网关掐断(360045ms)
- 复用 `insertNotification` 同内容折叠，同任务反复失败不刷屏。
- 状态栏红条/琥珀条接通（现有 `unreadLlmErrors`/`unreadDegradations` 模式）。

### 6.3 暂停任务（复用"蒸馏记录"tab）
- 不新建 tab。暂停任务在蒸馏记录列表用醒目标记（`⏸ 已暂停-某步失败`，与现有 outcome 徽标同风格）。
- 详情可看：卡在哪步、第几轮失败、3 次每次原因、该步对话历史（memside 问了什么、LLM 回了什么、为什么算失败）。
- 处置按钮：「重试」（重置 step_attempts=0 回 pending）、「放弃」（知情丢弃，推进 offset）。

### 6.4 待审查候选（复用"候选审批"tab）
- `pending_review` 状态候选在候选审批 tab 用醒目区块/徽标隔开（`⏸ 待审查`）。
- 审查重试成功后自动打标签 → `pending_review → candidate` 进正常队列。
- 暂停期间**可手动接管审批**（approve/reject/edit），用户当人肉审查员。

## 7. 待定项（plan 阶段决断）

1. 通知 `kind`：统一 `llm_error` 用 title 区分步骤，还是加 `judge_error` 等新 kind。倾向统一 + title 区分（复用折叠）。
2. 退避间隔：现有指数 1s/2s/4s 对"3 轮内完成"是否合适。
3. 一个 tick 内跑多少步（§5.4）。
4. `pending_review` 候选在 facets 计数（筛选下拉）里如何呈现。
5. codeagent 隐藏 token / 凭证源适配（本轮不纳入——实测 LLM 可达，凭证问题另算）。

## 8. 测试策略

主战场在纯函数层与调度层（状态转换/执行流程），UI 留少量源码层文本断言。运行门槛：`bun run typecheck && bun test` 全绿（现有 1148 pass 基线，重构改/删旧测试 + 净增）。

### 8.1 必写 case（六类）

**T1：断点续跑状态机（纯函数层，主战场）**——把"从哪步哪轮失败、下一步去哪"抽纯函数（仿 `canTransition`），写足转换：
- distill 第1轮失败 → 断点"distill/第2轮"，回 pending。
- distill 3 轮全失败 → 转 paused，offset 不动。
- distill 成功 → 推进到"dedup/第1轮"。
- judge 失败暂停 → 重试从 judge 接着跑，不重算 distill+dedup。
- 重试读回历史 → 确认带的是本步历史，非别步。
- 全成功 → offset 推进。
- 边界：第3轮成功 → 失败计数清零，全程静默。

**T2：带历史重试（纯函数层）**
- 第1轮残缺 → 第2轮追问带上了第1轮内容+失败原因。
- 第1轮格式错 → 追问措辞"格式不对"，区分于"没回完"。
- 每轮四样（轮次/request/response/result）落盘且读回。
- 失败原因分类（aborted/format/incomplete）正确，决定追问措辞。

**T3：3 次失败汇总通知（store 层）**
- 3 次内成功 → 不写通知。
- 第3次失败 → 写且只写 1 条任务级通知，含 3 次原因。
- 同任务反复暂停 → 折叠不刷屏（复用 `insertNotification`，加测试锁）。
- 通知汇总格式正确。

**T4：judge 静默全保留废除（回归防护，重点）**——锁死不复活：
- judge LLM 报错 → 不走 keepNull 全保留，记失败走重试。
- judge 3 次失败 → 暂停+通知，候选 `pending_review`，不落"未评估"进队列。
- 反向断言：judge 失败时不再出现"全候选 valueClass:null + 0 丢弃"旧症状。
- 测试文件顶端注释链本次 spec，未来 refactor 变红能看出意图。

**T5：offset 推进时机（回归防护）**
- 失败回队列 → offset 不变。
- 暂停 → offset 不变。
- 四步全成功 → offset 推进。
- 断点续跑切出范围 = 原范围（不跳内容）。

**T6：步骤间数据传递（锁住 P4 纠正）**
- 去重输入 = 蒸馏干净结果（候选清单），不含蒸馏对话历史。
- 审查输入 = 去重干净结果，不含去重对话历史。
- 反向断言：步骤间传递数据结构里不出现别的步骤的 LLM 对话。

**T7：UI 层兜底（源码层文本断言）**
- 蒸馏记录 tab 有"⏸ 已暂停"标记 token。
- 待审查候选区块 token。
- 重试/放弃按钮 token。

**T8：live e2e 门禁（`npm run test:live`）**
- mock 网关在 N 秒掐断，验证接续重试能成功（3 轮内）。
- 3 轮都掐断 → 验证暂停+通知。

### 8.2 删除/改造的旧测试

- distiller 旧的"失败兜底全保留/0 候选"测试 → 改成新语义（失败走重试/暂停，不冒充成功）。
- scheduler 旧的"失败标 done"测试 → 改成新语义（失败回 pending/暂停）。
- judge 旧的 keepNull 兜底测试 → 删除或改成"失败记失败"。

## 9. 失败模式

1. **历史膨胀**：多轮对话历史越滚越大，反而更易撞网关墙。缓解：每步对话历史单独、不跨步（P4 已隔离）；单步历史有轮次上限（3 轮）天然有界；response 字段可 cap。
2. **暂停任务堆积**：LLM 长期挂，paused 任务越积越多。缓解：paused 不占调度（不在 pending 队列）；UI 可批量放弃；后续可加 paused 任务 TTL 提醒。
3. **老库迁移**：现有 in-flight 的 running/done job 无 current_step。迁移：NULL = distill 语义；已 done 的不受影响。running 的重启后按 distill 起跑（保守）。
4. **pending_review 候选与现有筛选/facets 交互**：见 §7.4，plan 阶段定。
5. **3 轮上限过严**：偶发抖动需 4 轮才成。缓解：用户可手动「重试」重置计数；上限可后续可配。

## 10. 非目标

- codeagent 隐藏 token / 凭证源适配（实测 LLM 可达，另算）。
- 主动超时 / 网关墙探测（P6：memside 与 LLM 解耦，不假设网关）。
- 蒸馏 JSON 语义改成流式增量（仍是一次性完整 JSON，但失败有记忆接续）。
- 现有 taming/dedup/stated-immune 判定逻辑不变（只改失败处理，不改判定规则）。

## 11. 与现有模块的耦合点

- `src/scheduler.ts`：tick 主流程改造（断点续跑、3 次上限、暂停、offset 时机）。
- `src/memory/distiller.ts`：distill 步骤改为多轮可接续对话；废除顶层 catch 吞错为 0 候选。
- `src/memory/valueFilter.ts`：judge 废除 `keepNull`/`keepAll` 兜底，失败记失败。
- `src/memory/agentJudge.ts`：agentic judge 同上。
- `src/memory/agentLoop.ts`：已有 agent 循环可复用（conversation 累积 + 追问），distill/dedup/digest 可借鉴其模式。
- `src/memory/store.ts`：加断点读写、对话历史读写、pending_review 候选、3 次失败汇总通知。
- `src/db/schema.ts`：jobs/events/runs/memories 表迁移。
- `src/memory/retry.ts`：`callWithRetry` 扩展为有记忆多轮（带历史 + 分类追问），或被 agentLoop 模式取代。
- `src/web/App.tsx` + `api.ts`：暂停任务、待审查候选、重试/放弃 UI。
- `src/anthropic.ts`：不动调用本身（P6 不设主动超时），但 AbortError 消息透出更可诊断。

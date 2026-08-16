# 真实 LLM e2e + AI-as-judge 门禁 设计 spec

日期：2026-08-16
状态：待批准
关联：补 smoke-live.ts（根目录，无门禁、只覆盖 distill happy path）与全量单测（mock 形状与契约逐字一致但未验「真模型是否真按 prompt 产出合法形状」）留下的 dogfood 级空白。

## 1. 背景

memside 即将商用，核心闭环 capture → distill → approve → inject 的「真实 LLM 交互」这一层，自动化测试覆盖是空的：

- **`tests/e2e.test.ts`**：跑完整闭环，但 `callLLM` 是 mock（`e2e.test.ts:138`），只验「transcript 数据流到 distiller 输入」，没验「distiller 的 prompt 喂给真模型、模型回的东西解析链路能否吃下」。
- **`tests/distiller.test.ts` / `dedup.test.ts` / `agent-judge.test.ts`**：注入手写 JSON 假响应。探查确认这些 mock 的 JSON 形状与契约「逐字一致」——即它们测的是「解析链路能吃下合法形状」，**没测「真模型是否真按 prompt 产出合法形状」**。
- **`smoke-live.ts`**（根目录）：唯一全程零 mock 的闭环，但三个问题使其不算门禁：① 不在 `bun test` 范围内（根目录脚本，非 `tests/*.test.ts`）；② 只覆盖 distill 阶段 happy path，dedup / judgeValue / agentJudge 三阶段完全没真打过；③ 无门禁——无 candidate 时 `console.log('NO CANDIDATE...')` 后 `process.exit(0)`（`smoke-live.ts:67`），CI 当成功。

STATE.md 记录的真实事故，全是这个 gap 漏出来的（均靠 dogfood「近一天无新增记忆」才发现，非测试拦住）：

| 事故 | 根因 | 本门禁能否拦住 |
|---|---|---|
| markdown 围栏包 JSON → 0 候选（PR #7） | 真模型把 JSON 用 ` ```json ``` ` 包，mock 喂的都是干净 JSON | ✅ 真打模型撞围栏，`rawCount > 0 且 candidates.length === 0` |
| kimi 60s 非流式断连（2026-08-14） | 端点对生成 >60s 非流式请求准时断连，「测试连接」max_tokens=1 碰不到墙 | ✅ 真跑流式 distill 170-210s，`callThrew=true` |
| `[convention]` vs `[category:convention]` 前缀丢光 | 后端模型把前缀写错，候选被静默丢弃 | ✅ `rawCount` vs `candidates.length` 差距暴露 |
| agent 终审多轮不产 final（quality 模式） | 多轮协议复杂，模型预算内可能不出 `{"final":...}` | ❌ 本期不覆盖 agent 终审（见非目标） |

用户的核心诉求：**测试不必是代码断言，可以是一段喂给 AI 的提示词，让 AI 来检验被测 LLM 的产出**（LLM-as-judge 评估模式）。本设计把「AI 测 LLM」落地为：真实模型跑 memside 的 prompt → AI judge 判产出是否满足结构契约。

## 2. 目标 / 非目标

### 目标

1. **G1 真打 LLM 门禁**：发版前手动 opt-in 跑一次，distill / dedup / judgeValue 三阶段各真打一次真实 LLM，验证「真模型按 prompt 产出 → 现有解析链路吃下」这条契约。
2. **G2 AI-as-judge 判 evidence 真伪**：distill 候选的 `evidence`（原话出处）是否真出自 transcript——这是唯一需要语义判断的契约点，交给 AI judge。
3. **G3 4 条确定性硬检查**：不锁文案、不存 golden 基线，只锁 4 条确定性判断，不 flaky 也不虚设。
4. **G4 门禁隔离**：默认 `bun test` 不跑 live 测试；手动 opt-in（`bun test tests/live-*` 或 `npm run test:live`）；无凭证自动 skip 不报错；不影响日常 push 门槛。

### 非目标

- **不覆盖 agent 终审**（quality 模式 `judgeValueAgentic` 多轮协议）：最慢最贵最易 flaky，发版门禁不碰。agent 终审的真模型契约仍是空白，留后续。
- **不给终端用户接触**：这套测试是开发人员发版用的，终端用户不感知、不需要配凭证。
- **不存 golden 基线**：不记历史产出量级、不做 diff 退化预警。只做当下 4 条硬检查。
- **不改生产代码**：注入点（`distillTranscript` / `judgeDuplicates` / `judgeValue` 的 `callLLM: LLMCall` 接缝）已现成，不新增生产接缝。
- **不锁 LLM 产出文案**：候选标题/body 文案每次不同，不逐字断言。
- **不进 CI 自动跑**：本期是手动 opt-in，不接 CI webhook、不在 PR 检查里强制。

## 3. 接口契约

### 3.1 注入点（复用现有接缝，零生产改动）

四个被测函数已接受 `callLLM: LLMCall` 接缝（探查确认）：

| 阶段 | 函数 | 接缝位置 | 被测契约形状 |
|---|---|---|---|
| distill | `distillTranscript` | `src/memory/distiller.ts:106` `DistillInput.callLLM` | `{candidates:[{title,bodyMd,scope,runtime,distillAction,origin?,evidence?,subjectSlug?}]}` |
| dedup | `judgeDuplicates` | `src/memory/dedup.ts:18` `DedupInput.callLLM` | `{verdicts:[{index,isDuplicate,duplicateOfId?}]}` |
| judgeValue | `judgeValue` | `src/memory/valueFilter.ts:225`（经 `judgeValueBase`） | `{verdicts:[{index,category}]}`，category ∈ 9 类枚举 |

真实 `callLLM` 由 `makeLLMCall()`（`src/anthropic.ts:61`，流式，复用 daemon 同款凭证链 `loadClaudeCreds`）产出，直接注入上述函数——**与生产 daemon 路径同源**，不走 `runDistillOnce` / `startDaemon`，避免端口与 daemon 状态污染。

### 3.2 AI judge 接缝

AI judge 是一个独立的 `LLMCall`，与被测 `callLLM` 分离：

- **默认同源**：judge 复用被测 `makeLLMCall()`（开发者本地已有凭证即可跑，零新配置）。同源盲区已知并接受（judge 倾向认可同源模型产出）。
- **可配异源**：env `MEMSIDE_JUDGE_LLM_BACKEND` / `MEMSIDE_JUDGE_LLM_TOKEN` / `MEMSIDE_JUDGE_LLM_BASE_URL` / `MEMSIDE_JUDGE_LLM_MODEL` 存在时，judge 走独立端点。开发者想要消同源盲区时自行配置；终端用户不接触。
- judge 的 `LLMCall` 通过一个新的 `makeJudgeCallLLM(env)` 工厂构造，优先读 `MEMSIDE_JUDGE_LLM_*`，缺失则回退被测 `callLLM`。

### 3.3 opt-in 触发与 skip 语义

- `npm run test:live`（新增 script）= `MEMSIDE_RUN_LIVE=1 bun test tests/live-*`。
- `bun test`（默认全量）虽按 glob 包含 `tests/live-*.test.ts`，但每个 live test 同时受两道守卫：① 无凭证（`loadClaudeCreds` 返回 `apiKey: null`）skip；② 未设 env `MEMSIDE_RUN_LIVE` skip。默认 `bun test` 与 CI 不设该 env → live 全 skip，永不真打模型，不影响日常 push 门槛。
- live test 单独提 timeout：`bunfig.toml` 全局 60s 对 live 不够（distill 真实 170-210s），每个 live test 用 `test('...', async () => {...}, { timeout: 300_000 })` 单测提至 5 分钟。

## 4. 数据流

```
手写固定 fixture（transcript turns）
        │
        ▼
distillTranscript({ turns, callLLM: realCallLLM })   ← 真打模型
        │
        ├─→ 4 硬检查 ①: callThrew===false && errorMessage===null
        ├─→ 4 硬检查 ②: rawCount 与 candidates.length 对得上（差值=被解析丢弃，记诊断不红）
        └─→ 候选 → AI judge 检查 ③: 每条 evidence 是否真出自 fixture transcript 原话
                    │  judge prompt: 「以下 evidence 摘句是否出现在以下 transcript 原文中？只回 JSON {verdicts:[{index, isPresent}]}」
                    ▼
        候选（通过 evidence 检查的）
        │
        ▼
judgeDuplicates({ newCandidates, existing, callLLM: realCallLLM })  ← 真打模型
        │
        └─→ 4 硬检查（dedup 形状）: verdicts index 合法、isDuplicate 配 duplicateOfId、id 指向合法（existing 或 new-j）
        │
        ▼
judgeValue(candidates, realCallLLM)   ← 真打模型
        │
        └─→ 4 硬检查（judge 形状）: verdicts index 合法、category ∈ 9 类枚举
        │
        ▼
4 硬检查 ④: 三阶段跑通——distill 出 ≥1 候选、dedup 不崩、judge 给出合法 category
```

## 5. 4 条确定性硬检查（核心契约）

不锁文案，只锁这 4 条；每条都是确定性判断，AI 只在 ③ 上场。

### 检查 ① 模型有没有按时返回（distill）

- `result.callThrew === false` 且 `result.errorMessage === null`。
- 命中即红：真模型调用本身失败（60s 墙、凭证错、端点不可达、Connection error）。这正是 2026-08-14 事故的拦截点。

### 检查 ② 模型产出解析链路吃不吃得下（distill）

- `result.rawCount > 0`（模型确实返回了候选）。
- `result.candidates.length >= 1`（解析后至少留下一条）。
- 诊断（不红）：`result.rawCount - result.candidates.length` = 被格式校验丢弃的条数，记入诊断输出供开发者看，但不作为门禁（模型偶尔产出一条非法字段是正常的）。
- 命中即红：`rawCount > 0 且 candidates.length === 0`——模型产出了但全被解析丢光（围栏包裹 / 前缀全错 / JSON 无法 parse）。这正是 PR #7 与 `[convention]` 前缀事故的拦截点。

### 检查 ③ evidence 真伪（distill，AI judge 上场）

- 对每条带 `evidence` 的候选，AI judge 判该 evidence 摘句是否真出现在 fixture transcript 原文中。
- judge prompt 要求只回 `{verdicts:[{index, isPresent: boolean}]}`，`isPresent` 为布尔判定。
- 命中即红：任一 evidence 经 judge 判为 `isPresent===false`——模型编造了不存在的原话出处（贴金防护的语义层兜底，代码层 `distiller.ts:261` 已对「origin 非 observed 但 evidence 空」降级，但 evidence 非空却伪造的情况代码层无法判，需 AI）。
- judge 自身失败（callThrew）不红该检查，降级为「evidence 检查 skip」并记诊断（judge 是辅助，不能让 judge 的不稳定反过来门禁被测模型）。

### 检查 ④ 三阶段跑通（端到端）

- distill 出 ≥1 候选（已在 ②）。
- `judgeDuplicates` 不抛错、返回合法 verdicts（index 范围内、duplicateOfId 合法）。
- `judgeValue` 返回合法 verdicts（category ∈ 9 类）。
- 命中即红：任一阶段模型产出形状完全不对（dedup verdicts 全乱、judge category 全在枚举外）。

## 6. 测试策略

### 6.1 文件布局

- `tests/live-distill.test.ts`：distill 阶段真模型 + evidence AI judge（检查 ①②③）。
- `tests/live-dedup.test.ts`：dedup 阶段真模型（检查 ④ dedup 分支）。
- `tests/live-judge.test.ts`：judgeValue 阶段真模型（检查 ④ judge 分支）。
- `tests/live-helpers.ts`（非 test 文件）：共享 `realCallLLM`（`makeLLMCall()`）、`judgeCallLLM`（`makeJudgeCallLLM(env)`）、`hasCreds()` skip 守卫、手写 fixture（见 6.2）。

### 6.2 手写固定 fixture

手写几段精心构造的 transcript turn 数组（`TranscriptTurn[]`，不写 JSONL 文件——直接构造内存对象，绕过 `parseTranscriptFile` 的文件 IO，聚焦「prompt → 模型 → 解析」契约）。fixture 含：

- 一条明确的业务规则陈述（user turn，如「退款必须在发货后 14 天内」），确保 distill 稳定产出至少一条候选。
- 一条 thinking turn（验证 2026-08-09 thinking 捕获经真模型链路抵达 distiller 输入）。
- 一条 tool_use + tool_result（验证 2026-08-09 工具调用信息捕获）。
- 一条无关闲聊（确保 distiller 不会把所有内容都提成记忆，验选择性）。

### 6.3 隔离

- 每个 live test 用 tmp DB（`openDb(tmpPath)`，与 `tests/e2e.test.ts` 同 EBUSY-safe 模式），不碰 `~/.memside/memside.db`。
- 不起 daemon、不占端口——直接调 `distillTranscript` / `judgeDuplicates` / `judgeValue` 函数，纯内存调用。
- 凭证来自 `loadClaudeCreds()`（读 `~/.claude/settings.json` + env），与 `smoke-live.ts` 同源。

### 6.4 skip 守卫

每个 live test 文件顶部：

```ts
const hasCreds = /* loadClaudeCreds() 返回 apiKey 非 null */
test.skipIf(!hasCreds || !process.env.MEMSIDE_RUN_LIVE)(
  'live distill: 真模型产出可解析 + evidence 真',
  async () => { ... },
  { timeout: 300_000 }
)
```

双守卫：凭证缺失 OR 未设 `MEMSIDE_RUN_LIVE` → skip。默认 `bun test` 两条件都不满足 → 全 skip。

### 6.5 与 bun test 默认范围的隔离

bun test 默认跑 `tests/**/*.test.ts`，会含 `tests/live-*.test.ts`。通过 §6.4 的双守卫确保默认 `bun test`（含 CI）永远不真打模型：未设 `MEMSIDE_RUN_LIVE` env 即 skip。只有 `npm run test:live`（设 `MEMSIDE_RUN_LIVE=1`）且本地有凭证才真跑。

### 6.6 新增 npm script

```json
"test:live": "MEMSIDE_RUN_LIVE=1 bun test tests/live-*"
```

## 7. 失败模式

| 失败模式 | 处理 |
|---|---|
| 真模型端点不稳（Ark/kimi 间歇失败） | 检查 ① 会红。这是真问题（端点不稳影响生产），门禁红是对的。开发者确认是端点问题后可重跑（但 §6 flaky 原则：重跑不作为通过依据，需确认非 memside 侧 bug）。 |
| AI judge 自身不稳定 | 检查 ③ 降级 skip 不红（§5 检查 ③）。judge 是辅助，不让 judge 不稳定门禁被测模型。 |
| 模型产出 0 候选但合法（fixture 不触发记忆） | 检查 ② 红（`candidates.length === 0`）。这是 fixture 设计问题，开发者修 fixture。 |
| 凭证缺失 | 全部 skip，不红不绿。 |
| live test 超时（模型 >5 分钟） | `timeout: 300_000` 兜底超时红。正常流式 170-210s，5 分钟裕量充足。 |
| 同源 judge 盲区 | 已知接受。开发者可配 `MEMSIDE_JUDGE_LLM_*` 异源消除。 |

## 8. 与现有模块的耦合点

- **`src/anthropic.ts` `makeLLMCall`**：直接复用，产真实 `callLLM`。不改动。
- **`src/creds.ts` `loadClaudeCreds`**：复用读凭证。不改动。
- **`src/llm.ts` `resolveLLMBackend`**：judge 异源配置复用后端选择逻辑。不改动。
- **`src/memory/distiller.ts` / `dedup.ts` / `valueFilter.ts`**：只读它们的 `DistillInput` / `DedupInput` 类型与导出函数，不改动。
- **`package.json`**：新增 `test:live` script。
- **`smoke-live.ts`**：保留不动（仍可作为人工诊断脚本），本门禁不替换它。

## 9. 上线后观测

- 首次 `npm run test:live` 跑通记录：三阶段耗时、模型实际产出候选数、evidence judge 判定结果。回填 STATE.md。
- 若检查 ① 频繁红（端点不稳），记录端点稳定性数据，决定是否在门禁里给端点抖动留容错预算（本期不做，硬红）。
- 若检查 ② 频繁红（模型产出被解析丢光），说明 prompt 与解析契约对真模型不够友好，触发 distiller prompt 调优。

## 10. 未覆盖（后续 issue）

1. **agent 终审真模型门禁**（quality 模式 `judgeValueAgentic` 多轮协议）：最复杂，留独立 spec。
2. **golden 基线退化预警**：本期砍掉，若发版后发现「产出量级静默退化」频发，再补。
3. **CI 自动跑 live**：本期手动 opt-in，未来若 CI 有凭证可接。

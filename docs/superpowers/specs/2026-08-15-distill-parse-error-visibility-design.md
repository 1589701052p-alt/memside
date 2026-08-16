# 蒸馏解析失败可视化 + subagent 兜底治理 设计 spec

日期：2026-08-15
状态：已通过 brainstorming 评审（用户三项决策见 §2）
关联：`docs/superpowers/specs/2026-08-14-llm-streaming-and-failure-visibility-design.md`（流式化，本 spec 的上游）、`2026-07-29-distill-work-record-design.md`（runs 表）、`2026-07-29-distill-signal-recovery-design.md`（subagent 单独蒸馏，本 spec 推翻其「退回主会话」兜底）

## 1. 背景与事故证据

2026-08-14 用户发现蒸馏记录「空产出」暴增。systematic-debugging 取证（live DB `~/.memside/memside.db`）：

**发现 1：空产出分真假两种，假空占多数。**
8-14 的 26 条 `empty_output` 中 19 条 `raw_output_json IS NULL`（下称 rawNULL）。代码路径：`callWithRetry` 三次 attempt 都没拿到合法结构（JSON.parse 全败或 `candidates` 非数组且重试耗尽）→ 返回 `undefined` → distiller `rawOutput = parsed ?? null` → 0 候选 + `callThrew=false` → scheduler 分类 `empty_output`。**模型的原始输出文本在此过程中被完全丢弃**，error_message 为 NULL——UI 上看与「模型诚实返回空」毫无区别，是黑盒。

**发现 2：假空不是流式化制造的，但流式化改变了它的呈现。**
rawNULL 型在 8-05（6 条）、8-06（7 条）、8-11（17 条）、8-12（2 条）就存在。8-14 下午 16:24 前，大输入任务以 `llm_error`（Connection error，448–578s，非流式 60s 断连墙 × SDK 重试 × callWithRetry 重试叠加）失败；流式化（PR #61）16:24 生效后连接错误绝迹，流能跑完——但同一批大输入间歇性产出不可解析输出，失败标签从 llm_error 迁移成 empty_output。

**发现 3：解析失败是间歇性的，输入本身无罪。**
同一份 191494 字节输入（md5 884c9808）8-14 晚被蒸 7 次：5 次 rawNULL + 2 次 produced。事后用真实管线 + 真实端点重放该输入：135s 一次成功，产出 3 条候选（`scratch-replay.log`，本地产出不入库）。

**发现 4：大输入来自 subagent 兜底放大器。**
8-14 的 rawNULL 运行输入 160–270KB，而真空型仅 10–22KB。大输入 = SubagentStop 的 `loadSubagentTranscript` 兜底：15 个 agent 的对话文件在整个 `~/.claude/projects/` 不存在（主会话 transcript 也无其 id 记录、无 spawnDepth=2、无后台任务残留），`loadSubagentTranscript` 按双路兜底退回主会话全文（md5 与主会话文件 parse+filter 结果逐字节吻合已实证）。同一份主会话输入当晚被不同 agent_id 的 job 重复蒸馏 7 次。

**兜底的三重害处**（用户裁决依据）：
1. 重复蒸馏——主会话内容由其自有累加 job（攒量批处理，spec 2026-08-09）负责，兜底是纯重复；
2. 语义错误——subagent job 强制 origin 降级 agent-observed（spec 2026-07-31），主会话内容里的用户陈述被剥夺 stated 保护；
3. 不可观测——文件为何找不到，无任何日志/记录。

**schema 事实**：`memory_distill_runs.outcome`、`notifications.kind`、`memory_degradations.kind` 均为自由 TEXT 列（无 CHECK），新增枚举值免迁移。

## 2. 目标与用户裁决

- **G1（裁决：新 outcome）**：distill 解析失败独立为 `parse_error` outcome，原始输出文本（截断）+ 解析错误描述落盘，消灭假空黑盒。
- **G2（裁决：进消息中心 + 折叠）**：parse_error 写通知（同内容折叠），状态栏红条覆盖。
- **G3（裁决：彻底删掉兜底）**：SubagentStop 在 subagent 自有对话文件缺失/为空时**不再退回主会话**——不入队、不写 events，改写一条带取证现场的 `subagent_transcript_missing` degradation（双写通知，消息中心可见）。
- **G4**：`empty_output` 回归纯真空语义（仅「模型返回合法 `{"candidates":[]}`」或「rawCount>0 但逐条校验全丢」，后者沿用既有「N 条格式不合格」呈现）。

## 3. 非目标

1. **历史存量假空行不回分类**——raw 已丢，无法可靠区分；留在 empty_output 里作为历史。
2. **不调 retry prompt / max_tokens**——解析失败根因（截断 vs 围栏 vs 散文）等 raw_text 攒够证据再定，留 follow-up。
3. **dedup / judge 的解析失败不做 parse_error**——两者失败语义是保守全留（dedup 失败全保留、judge R3 stated→decision），不丢信号，不在本轮。
4. **opencode 链路不动**。
5. **不修复「subagent 文件为什么不存在」**——本 spec 只部署取证（§5.2），抓到现行后另行立项。

## 4. 判定链（outcome 真值表，本 spec 的语义核心）

scheduler tick 对主路径 job 的 outcome 分类改为：

| candidates | callThrew | parseError | outcome |
|---|---|---|---|
| >0 | 任意 | 任意 | `produced`（不变） |
| 0 | true | 任意 | `llm_error`（不变） |
| 0 | false | 非 null | **`parse_error`（新）** |
| 0 | false | null | `empty_output`（纯真空） |

distiller 内部逐 attempt 状态（与现有 callThrew 重置模式一致）：

- attempt 抛错 → `callThrew=true`、`lastErrorMessage` 更新（现有）。
- attempt 未抛错 → `callThrew=false`（现有重置）+ `onAttempt` 回调上报 `{raw, error}`：`error` = JSON.parse 错误消息 / shouldRetry 校验错误消息 / 通过为 `null`。distiller 用 `lastAttemptRaw` / `lastAttemptError` 逐次覆盖留存。
- callWithRetry 返回后：
  - `parsed` 有效（`candidates` 是数组）→ 走既有逐条候选校验；`parseError=null`、`lastRawText=null`（成功与部分丢弃都不带解析错误）。
  - `!parsed || !Array.isArray(parsed.candidates)` 且 `callThrew=false` → `parseError = lastAttemptError ?? '解析失败：无错误描述'`、`lastRawText = lastAttemptRaw`。
  - `callThrew=true` → llm_error 路径，`parseError=null`、`lastRawText=null`（不变）。

边界论证：「未抛错 attempt 必然经过 JSON.parse（败则 error 有值）或 shouldRetry（通过则已被接受返回）」，故 `!callThrew && 返回无效` 时 `lastAttemptError` 必有值；`?? '解析失败：无错误描述'` 仅为防御兜底。`callThrew` 与 `parseError` 互斥由「末次 attempt 非抛即报」保证。

## 5. 详细设计

### 5.1 retry.ts：`onAttempt` 观测回调

`RetryOpts` 加可选字段：

```ts
/** 每次未抛错的 attempt 后回调：raw=原始文本，error=parse/校验错误（通过为 null）。纯观测，不影响流程。 */
onAttempt?: (info: { raw: string; error: string | null }) => void
```

三个触发点（均仅在 call 未抛错时）：JSON.parse 失败（error 复用喂给模型的同一句「不是合法 JSON：…」）、shouldRetry 返回错误（error=retryError）、接受（error=null）。call 抛错路径不触发。dedup / judge 调用方不传此回调，行为零变化。

### 5.2 transcript.ts：`resolveSubagentTranscript` 取代 `loadSubagentTranscript`

`loadSubagentTranscript`（含「退回主会话」兜底）删除，替换为：

```ts
export interface SubagentResolveDiag {
  agentId: string
  transcriptPath: string
  derivedPath: string | null        // subagentFilePathFromPayload 推导结果；推不出为 null
  derivedExists: boolean            // derivedPath 存在且为文件
  derivedTurns: number              // 文件解析出的 turn 数（0 = 存在但空/无有效 turn）
  mainTranscriptExists: boolean     // transcript_path 指向的文件是否存在（不读内容）
  subagentsDirEntries: string[]     // <base>/subagents/ 目录当时真实 basename，cap 30；目录不存在为 []
}
export function resolveSubagentTranscript(
  transcriptPath: string, agentId: string | null | undefined,
): { turns: TranscriptTurn[]; diag: SubagentResolveDiag }
```

契约：**永不抛异常**（沿用旧契约）；不再读主会话内容。`subagentFilePathFromPayload` 原样保留复用。

### 5.3 server.ts：SubagentStop 新流程

```
SubagentStop → resolveSubagentTranscript(transcriptPath, agentId)
  ├─ turns.length > 0 → 照旧 enqueueDistillJob + 写 events 行（不变）
  └─ turns.length === 0 → 不入队、不写 events：
       logDegradation({ kind: 'subagent_transcript_missing',
                        detail: JSON.stringify({ ...diag, payloadKeys: Object.keys(body) }),
                        sessionId: body.session_id ?? undefined })
       + console.warn（同 detail，daemon 日志留底）
```

202 ack 契约与 `memory.capture` broadcast 不变。degradation 经 logDegradation 双写通知（kind='degradation'、title=kind 原值），同 title 折叠——重复缺失收成一条浮顶，不刷屏。

### 5.4 store 层

1. **迁移**（client.ts，沿用 PRAGMA+条件 ALTER 幂等模式）：`memory_distill_runs` 加 `raw_text TEXT`，无 backfill（老行 NULL）。
2. **schema.ts**：`memoryDistillRuns` 加 `rawText: text('raw_text')`。
3. **saveDistillRun**：入参加 `rawText?: string | null`，UPSERT 覆盖写入。
4. **getDistillRun**：返回带 `rawText`（反序列化失败兜底模式不变）。**listRecentDistillRuns 不选 raw_text**（与 rawOutput 同——列表保持轻量）。
5. **DistillOutcome**（store.ts:588 处联合类型）加 `'parse_error'`。
6. **logParseErrorNotification**：镜像 `logLlmErrorNotification`——`insertNotification({ kind: 'parse_error', title: 'parse_error', body: message, refType: 'distill_job', refId: jobId })`。`insertNotification` 的 llm_error 折叠分支（按裁剪后 body 匹配）扩展覆盖 parse_error；degradation 分支（按 title）不变。

### 5.5 scheduler tick 接线

主路径（约 scheduler.ts:432 起）：

```ts
const outcome = candidates.length === 0
  ? (callThrew ? 'llm_error' : parseError ? 'parse_error' : 'empty_output')
  : 'produced'
```

- `saveDistillRun`：`rawText = outcome === 'parse_error' ? capRawText(lastRawText) : null`；`errorMessage` 取值扩展为 llm_error→调用错误、parse_error→parseError、其余 null。
- `job.last_error` 回写与通知：`outcome === 'llm_error' || outcome === 'parse_error'` 时进入既有 try 块；parse_error 调 `logParseErrorNotification`，llm_error 照旧 `logLlmErrorNotification`。
- `skipped_no_new_turns` / `skipped_trivial` 分支不触及。

### 5.6 pure.ts：`capRawText`

```ts
export const RAW_TEXT_CAP_CHARS = 24_000  // 头 8000 + 尾 16000 + 标记
export function capRawText(raw: string | null): string | null
```

- null/空串 → null；≤ cap → 原样；
- 超 cap → `raw.slice(0,8000) + `\n…[截断 ${omitted} 字]…\n` + raw.slice(-16000)`。
  尾部权重更大：max_tokens 截断的断口在尾部，是本观测的首要疑凶；头部保留以识别围栏/散文。

### 5.7 server.ts：status 与通知过滤

- `/api/status`：`unreadLlmErrors` 改为 `kind IN ('llm_error','parse_error')` 的未读合计；`latestUnreadLlmError` 同步覆盖两类（字段名不变，语义扩为「LLM 类报错」）。`unreadDegradations` 不变。
- 通知列表 kind 过滤校验（server.ts:565 附近）：合法值加 `'parse_error'`。
- `GET /api/distill-runs/:jobId` 详情：响应加 `rawText`（列表端点不带）。

### 5.8 Web UI

- **api.ts**：`DistillOutcome` 加 `'parse_error'`；`NotificationKind` 加 `'parse_error'`；distill-run 详情类型加 `rawText?: string | null`。
- **ui-utils.ts**：`DistillOutcome` 同步；`formatOutcome('parse_error')` → `{ label: '解析失败', color: '#c00' }`；通知标题映射加 `parse_error → '解析失败'`；`degradationKindLabel` 加 `subagent_transcript_missing → 'subagent 记录缺失'`。
- **App.tsx**：
  - 消息中心：kind 筛选下拉加「解析失败」；行 chip 标签三分支（llm_error→LLM错误 / parse_error→解析失败 / degradation→降级），chip 颜色逻辑不变（parse_error 落到红色家族）。
  - `DistillRunModal`：parse_error 分支 = 红块展示 errorMessage（复用 llm_error 样式）+ 新增「模型原始输出」区，pre 块等宽字体、限高滚动展示 rawText；rawText 为 null 时显示「（无留存）」不空白。
  - 状态栏红条逻辑零改动（unreadLlmErrors 计数已含 parse_error，条文案不变）。

## 6. 失败模式

1. **raw_text 体积**：单次 ≤ cap（约 24KB），仅 parse_error 行写入；rawNULL 实测占比远低于 produced，DB 体积影响可忽略。
2. **onAttempt 回调抛错**：回调包 try/catch（观测不得影响主流程，与 logDegradation best-effort 同模式）。
3. **删兜底后的信号丢失面**：subagent 文件缺失时该次事件只剩 degradation——主会话内容仍由主会话累加 job 蒸馏（spec 2026-08-09），无真实信号丢失；subagent 自有内容在文件缺失时本来就拿不到，不算丢失。
4. **parse_error 通知风暴**：同内容折叠（body 匹配）把同签名错误收成一条；不同签名各自一条——与 llm_error 同级可见性，用户可从消息中心逐条已读。
5. **degradation 目录清单泄露面**：subagentsDirEntries 仅 basename、cap 30，路径本机信息不出本机（daemon 本地），无外部暴露。

## 7. 测试策略（CLAUDE.md 强制：随改动落地，先红后绿）

- **retry.test.ts**：onAttempt 三触发点（parse 败 / 校验败 / 通过）+ 抛错不触发 + 回调抛错不影响流程。
- **distiller.test.ts**：三次全 parse 败 → parseError 非空 + lastRawText=末次文本 + candidates=[] + callThrew=false；校验耗尽（candidates 非数组 ×3）→ parseError；attempt0 败 attempt1 成 → parseError=null（重置锁）；`{"candidates":[]}` → parseError=null（真空回归锁）；全抛错 → llm_error 路径 parseError=null（回归锁）。
- **pure.test.ts**：capRawText 四 case（null / 空串 / 不超 / 超断头尾+标记+字数）。
- **store 测试**：raw_text saveDistillRun→getDistillRun 往返；listRecentDistillRuns 不含 rawText；幂等迁移（无列老库打开两次不炸）；insertNotification parse_error 按 body 折叠。
- **scheduler 测试**：parse_error 分类真值表（四类 outcome 各一）；parse_error 时 saveDistillRun 带 capRawText 后 rawText + errorMessage=parseError + job.last_error 回写 + 通知落库；empty_output/produced/llm_error 回归。
- **transcript 测试**：resolveSubagentTranscript 文件存在→turns+diag；文件缺失→空 turns+diag 字段（derivedExists=false、dir listing 反映测试夹具）；文件存在 0 turns→空 turns+derivedTurns=0；永不抛（畸形路径输入）。**旧「退回主会话」测试全部翻转为不兜底断言**（行为变更锁，注释链接本 spec）。
- **server 测试**：SubagentStop 文件存在→入队+events（旧行为守卫）；文件缺失/0 turns/缺 agent_id→不入队+degradation 行字段断言（含 payloadKeys）+通知双写；202 契约。status：unreadLlmErrors 含 parse_error；通知过滤 kind=parse_error 可用。distill-runs 详情带 rawText、列表不带。
- **UI 源码层断言**（CLAUDE.md 兜底面）：formatOutcome 新徽标、modal parse_error 分支 token（「模型原始输出」/「（无留存）」）、degradationKindLabel 新映射、筛选下拉新选项、kind 标签三分支。

运行门槛：`bun run typecheck && bun test` 全绿才能 push。

## 8. 上线后观测（硬要求，结论回填 STATE.md）

1. parse_error 24h 计数与占比；raw_text 抽样判型（截断断口 / 围栏 / 散文），给后续 retry prompt 调优定罪。
2. `subagent_transcript_missing` 降解的 dir listing 对照 agentId——抓 phantom agent 文件缺失的现行（claude code 版本、payload 形状）。
3. empty_output 是否回归纯真空（抽样应全部 raw_output_json 非 NULL）。
4. parse_error 通知折叠效果：同签名是否收成一条。

## 9. 措辞核对单（spec 权威文本，实现逐字对齐）

- outcome 枚举新值：`parse_error`
- degradation kind：`subagent_transcript_missing`
- 通知 kind：`parse_error`；通知 title 原值 `'parse_error'`
- UI 文案：徽标「解析失败」；degradation 标签「subagent 记录缺失」；modal 区块「模型原始输出」；空值兜底「（无留存）」
- `capRawText` 常量：`RAW_TEXT_CAP_CHARS = 24_000`，头 8000 / 尾 16000
- `SubagentResolveDiag` 字段名：agentId / transcriptPath / derivedPath / derivedExists / derivedTurns / mainTranscriptExists / subagentsDirEntries
- degradation detail JSON 附加字段：`payloadKeys`

# OpenAI 后端流式化 + 失败彻底可诊断（design spec）

- 日期：2026-08-20
- 分支：`fix/openai-streaming-and-failure-visibility`
- 前作：`2026-08-14-llm-streaming-and-failure-visibility-design.md`（anthropic 流式化，本次移植到 openai）、`2026-08-18-llm-failure-handling-design.md`（4 步断点续跑执行器）

## 1. 背景 / 事故

公司内部 claude code 环境用 memside 测试，反复出现 distill 失败，**每次卡整 120 秒**报错 `aborted: The operation was aborted`，点「查看原始输入」**显示该 job 无原始输入快照**。另有一个 judge 失败，**169 秒**报错 `agent loop ended without final: llm-error`，**有**原始输入可看。

### 根因链（已用 file:line 交叉验证）

1. **openai 后端非流式 + 120s 硬超时**：`src/openai.ts:60` `timeoutMs = deps.timeoutMs ?? 120_000`，`:64-65` `AbortController` 120s 触发 `ctrl.abort()`。这是 2026-08-14「流式化」修复**只覆盖 `src/anthropic.ts`**（`messages.stream` + `timeout: 600_000`）的漏网——openai 后端从未移植流式。
2. **后端选择**：`src/llm.ts:38` 有 `OPENAI_API_KEY` 或 `MEMSIDE_LLM_BACKEND=openai` 即走 openai 后端；`src/daemon.ts:88-106` 每次调用现解析协议后派发。公司环境用 OpenAI 兼容网关 → 命中非流式路径。
3. **网关 TTFB 墙**（STATE.md 2026-08-14 实测）：对生成超过约 60s 仍无首字节的非流式请求，网关掐断。distill 大 transcript 生成需 170-210s，远超 60s → 必掐 → 120s 客户端超时（`aborted`）。流式请求字节持续流动，同载荷 170-203s 稳定完成。

### 为什么 distill「无输入快照」、judge「有」（伴生缺口）

`saveSourceInput`（存「原始输入」快照，供 UI「查看原始输入」）只在 `src/scheduler.ts` 两处调：
- `:632` — judge 步成功后
- `:776` — judge 步暂停时（`if (failStep === 'judge' && deduped.length > 0)` 内）

**distill / dedup 步失败或暂停时从不存 source-input 快照**。故 distill 暂停的 job 点「查看原始输入」为空。

此外 abort 路径还清空 `rawText`：`:727` `if (!isAbort)` 才抓 rawText，distill abort 被判 `isAbort=true`（`classifyStepReason` 命中 `aborted`，`:716/:725`），故 `rawText=null`。输入快照 + 末轮响应双双为空 → distill 失败彻底黑盒。

judge 暂停时走 `:776` 存了 source-input，故有原始输入可看。

### 为什么 distill 报 `aborted`、judge 报 `llm-error`

两者用同一 `callLLM`，但执行器对 abort 的归类不同：
- **distill/dedup** 走 `runLlmSession`：`src/memory/llmSession.ts:85-92` catch → `classifyFailure(e, null)` 命中 `aborted`（`stepPrompt.ts:41`），reason 拼 `aborted:<e.message>`（`llmSession.ts:89`）。逐字符合「distill 120s `aborted: The operation was aborted`」。
- **judge**（质量模式 agent loop）走 `runAgentLoop`：`src/memory/agentLoop.ts:54` `catch { return { final:null, trace, stopReason:'llm-error' } }`——**不看异常内容**，一律 `llm-error`，`agentJudge.ts:100` 输出 `agent loop ended without final: llm-error`。逐字符合「judge 169s `agent loop ended without final: llm-error`」。
- judge 169s > 120s 因 agent loop 跑了若干轮（工具 grep/read），其中一轮 callLLM 在 120s 被掐 → 抛错 → `llm-error`，前几轮累计 ~49s。

## 2. 目标 / 非目标

### 目标
- G1：openai 后端流式化，根治大 transcript distill 的 120s `aborted`（正常路径 170-210s 跑通产出候选）。
- G2：judge（agentLoop）失败分类对齐 distill 路径——不再笼统 `llm-error`，透出真实原因（aborted / 真报错）。
- G3：distill / dedup 步失败也存 source-input 快照；abort 不再清空可保留信息，让 distill 失败不黑盒。

### 非目标
- N1：不引入 `openai` npm SDK（保持 openai 后端原生 fetch，核心 SDK-free 结构不变）。
- N2：不修网关本身（外部服务，同 2026-08-14 立场）。
- N3：不给 agentLoop 接 persistRound / 跨 tick 断点续跑（STATE.md deferred minor #3，独立 spec）。
- N4：不改 anthropic 后端（已是流式）；不改 `testConnection`（仍是 max_tokens=1 秒级探针，不碰 60s 墙）。
- N5：不动步骤机 / 断点续跑语义、不动 offset 推进逻辑（2026-08-18 已根治）。

## 3. 接口契约与数据流

### 3.1 openai 流式传输（`src/openai.ts`）

`makeLLMCall` 改为：

```
POST {baseURL}/chat/completions
headers: Content-Type: application/json, Authorization: Bearer <token>
body: { model, max_tokens, stream: true, messages:[{system},{user}] }
signal: AbortController（600_000ms）
```

响应用 `response.body.getReader()` 逐块读取，按 SSE 规范解析：
- 文本解码为 UTF-8，累积进行缓冲（跨 chunk 的不完整行）。
- 按行切；以 `data: ` 前缀的行取 payload；payload === `[DONE]` → 结束；空行 / 非 `data:` 行（SSE 心跳）跳过。
- payload `JSON.parse` → 取 `choices[0].delta.content`（string），累加进全文。缺 `content` / 非对象 / 解析失败 → 跳过该 chunk（不抛，SSE 规范允许事件行；只要累计出最终文本即可）。
- reader 正常 done + 未见 `[DONE]` 也视结束（连接正常关闭即收尾）。

拼完返回累加文本，语义与非流式 `choices[0].message.content` 完全一致——distiller / dedup / judge / `runLlmSession` / `runAgentLoop` 调用方零感知。

**超时**：`AbortController` 600_000ms（10 分钟硬上限兜底，与 anthropic `timeout: 600_000` 对齐）。流式字节流动期间不触发——网关持续吐 chunk 即不断。`OpenAiDeps.timeoutMs?` 保留可注入（测试用），缺省由 120_000 改为 600_000。

**失败语义**：流式读过程中连接被掐（真网关故障，极少）→ fetch/reader 抛 AbortError 或连接错误 → `makeLLMCall` 直接 re-throw（openai 后端不像 anthropic 那层包诊断前缀；抛原异常即可，`isAbortLike` 在上游 stepPrompt 统一识别 `error.name==='AbortError'` 与 message 含 aborted/timeout/connection error）。执行器重试/暂停链路既有不变。

### 3.2 judge 失败分类对齐（`src/memory/agentLoop.ts` + `agentJudge.ts`）

`callOnce` catch 块（`agentLoop.ts:54`）改为：

```
} catch (e) {
  const reason = isAbortLike(e) ? 'aborted' : 'llm-error'
  const msg = e instanceof Error ? e.message : String(e)
  trace.push({ kind: 'correction', text: `${reason}:${msg}`.slice(0, TRACE_CAP) })
  return { final: null, trace, stopReason: 'llm-error' }
}
```

- `stopReason` 仍为 `'llm-error'`（外部契约：judge 失败标识不变，scheduler 据此暂停 + pending_review）。
- trace 文本从「丢原因」改为带 `${reason}:${msg}`，落盘后 UI / runs 可见真实原因。
- `agentJudge.ts:100` 的 reasons 从 `['agent loop ended without final: ${loop.stopReason}']` 改为 `loop.trace` 末条 correction 文本优先透出（含 `aborted:<原因>` 或 `llm-error:<原因>`）；trace 为空时回退旧文案。

导入 `isAbortLike` from `./stepPrompt`（已是 anthropic.ts 同源，单一真相源，不重复定义 abort 模式）。

### 3.3 distill/dedup 步失败补存输入快照 + abort 不清空（`src/scheduler.ts`）

两处改动：

**(a) saveSourceInput 放开到任意步骤暂停：**
当前 `:776` 的 `saveSourceInput` 嵌在 `if (failStep === 'judge' && deduped.length > 0)` 内。上提到失败暂停块的 `if (adv.paused === 'paused')` 顶层（judge-pending_review 分支之外、任意 failStep 都执行）：

```
if (adv.paused === 'paused') {
  ...
  try { await saveSourceInput(db, job.id, filterTranscriptForDistill(newTurns)) }
  catch (e) { console.warn('memside: saveSourceInput failed', e) }
  await markJobPaused(db, job.id, failStep)
  ...
}
```

- judge-pending_review 插入逻辑仍在 `if (failStep === 'judge' && deduped.length > 0)` 内（保持候选标 pending_review 语义不变），只是 saveSourceInput 移到外层共享。
- 任意步骤暂停都存输入快照 → distill/dedup 暂停时 UI「查看原始输入」可见。

**(b) abort 路径保留可保留信息：**
`:727` `if (!isAbort) { ... rawText = capRawText(last?.response ?? null) }`。abort 时 `rawText` 仍为 null（末轮响应确实是空——`llmSession.ts:90` abort catch 写 `response:''`），这是**事实**（没有末轮响应可存），保留 null 正确。
**但** saveSourceInput 现在无论 abort 与否都执行——用户看到的是「喂给模型的输入」(source-input 快照)，而非末轮响应(rawText)。两者解耦：abort 无末轮响应（rawText=null 合理），但输入快照照存（这是用户排查「模型看到了什么」的关键面）。
**即：** `:727` 的 `if (!isAbort)` 逻辑**不动**（rawText 在 abort 时确为空是事实正确），靠 (a) 的 saveSourceInput 放开来补「输入快照」这一面。两道信息面（输入快照 / 末轮响应）独立，abort 只丢末轮响应（本来就没有），不丢输入快照。

## 4. 与现有模块的耦合点

| 模块 | 耦合 | 风险 |
|---|---|---|
| `src/openai.ts` | 流式重写 makeLLMCall；timeoutMs 缺省 120k→600k | 调用方零感知（返回 string 契约不变）；手写 SSE 需 framing 测试 |
| `src/anthropic.ts` | 不动 | 无 |
| `src/memory/agentLoop.ts` | catch 块加 isAbortLike 分类 + trace 透出 | stopReason 外部契约不变；trace 文本格式变更需测 |
| `src/memory/agentJudge.ts` | reasons 透出真实原因 | failed 标识不变，scheduler 暂停逻辑不变 |
| `src/memory/stepPrompt.ts` | 不动（isAbortLike 已存在，被 openai/agentLoop 共用） | 无 |
| `src/scheduler.ts` | saveSourceInput 上提；rawText 路径不动 | saveSourceInput 失败已 best-effort warn，不阻塞 |
| `src/daemon.ts` / `src/llm.ts` | 不动 | 后端选择逻辑不变 |

## 5. 失败模式

| 失败 | 处理 |
|---|---|
| openai SSE 解析某 chunk 失败 | 跳过该 chunk，不抛；累计出最终文本即可 |
| 流式连接被掐（真网关故障） | fetch/reader 抛异常 → isAbortLike → 执行器重试 3 轮 → 暂停 + 通知（既有链路） |
| saveSourceInput 失败 | warn 不阻塞（既有 best-effort） |
| agentLoop catch 后 trace push 失败（理论不可达） | 仍 return llm-error，不抛 |
| 流式响应缺 `[DONE]` 但连接关闭 | 视为结束，返回已累计文本（SSE 允许） |

## 6. 测试策略

> 首选可断言面：纯函数 / 纯数据流优先，运行时层留少量集成断言。

### 6.1 openai 流式（核心）

- **SSE framing 契约测试**（纯函数层）：抽出 `parseSseChunks(buffer, leftover): {lines: string[], leftover: string}` 或等价纯解析函数，测：
  - 完整 `data: {...}\n\n` 一行一事件
  - 跨 chunk 拆断的行（`data: {"ch` + `oices"...`）正确拼接
  - `[DONE]` 哨兵终止
  - 空行 / `:heartbeat` 心跳跳过
  - delta.content 缺失 / 非对象 chunk 跳过不抛
- **端到端拼接**：喂一组真实形态 SSE chunks（delta 累加），断言最终拼接文本 == 非流式 choices[0].message.content 等价文本。
- **超时默认值**：断言 `OpenAiDeps.timeoutMs` 缺省 = 600_000（回归锁，防回退 120k）。
- **可注入性**：注入 fake loadOpenAiCreds + mock fetch（返回 ReadableStream），断言走流式分支。

### 6.2 judge 失败分类

- `agentLoop.test.ts`：callLLM 抛 AbortError → trace 末条含 `aborted:`，stopReason 仍 `llm-error`；callLLM 抛普通 Error → trace 末条含 `llm-error:`。
- `agent-judge.test.ts`：agentLoop 失败时 reasons 透出真实原因（不再固定 `agent loop ended without final: llm-error`）；failStep 标识 / failed 形状不变。

### 6.3 distill 步输入快照

- `scheduler.test.ts`（或 scheduler-resume）：distill 步 3 轮失败暂停时，断言 `getSourceInput(jobId)` 非空（或 saveSourceInput 被调）——之前 distill 暂停无快照。
- 回归：judge 暂停仍存快照（既有不变量不破）；judge pending_review 仍插（语义不变）。

### 6.4 既有不变量回归

- `runLlmSession` aborted 分类不变（distill/dedup 路径不破）。
- offset 仅四步全成推进（不破）。
- 流式返回 string 契约 → distiller/dedup/judge 零感知（既有测试全绿）。

### 运行门槛

- `bun run typecheck && bun test` 必须全绿。
- live 测试（`tests/live-*.test.ts`）双守卫保护，默认 skip；真打模型属 manual smoke，本 spec 不强制。

## 7. 上线后观测（硬要求，结论回填 STATE.md）

1. **openai 后端 distill 120s aborted 消失**：流式 170-210s 跑通产出候选；失败时长不再卡整 120s。
2. **distill 失败不再黑盒**：暂停 job 点「查看原始输入」非空。
3. **judge 失败分类可辨**：aborted vs 真报错分开显示（live 数据）。
4. **judge 仍可能因网关真故障暂停**（流式降低概率但不消除），暂停后 UI/通知如实。
5. **既有 1255+ 测试基线**不回归。

## 8. 诚实声明

- 流式化根治的是「生成超 60s 无首字节」的网关掐断；若公司网关对流式也有别的限制（如总时长硬上限 < 生成时长），流式无法解决——但 2026-08-14 实测同载荷流式 170-203s 稳定完成，证据支持流式有效。
- 本修复不改步骤机 / offset / 断点续跑语义（2026-08-18 已根治）；只修传输层 + 诊断可见性。
- agentLoop 跨 tick 断点续跑（STATE deferred minor #3）明确不在此 spec 范围。

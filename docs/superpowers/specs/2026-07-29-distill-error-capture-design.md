# 蒸馏 LLM 错误捕获与透传（distill error-capture）

## 背景

`feat/distill-work-record` 交付的「蒸馏工作记录透明化」上线后，用户在第 5 tab 看到近期
distill job 全是 `llm_error`，但点开详情是空的--看不到「报了什么错」。诊断发现这是当前
透明化设计在「最该透明的场景」的硬伤：LLM 报错时错误信息被链路层层吞掉。

错误被吞的完整链路（已实测验证）：

1. `callWithRetry`（src/memory/retry.ts:33-38）catch 住 `callLLM` 抛的异常，错误 message
   只拼进重试 prompt，**不透出**；3 次 attempt 耗尽后返回 `lastParsed`（undefined）。
2. `distillTranscript`（src/memory/distiller.ts:191-193）拿到 `parsed=undefined`，
   `rawOutput = parsed ?? null = null`；顶层 catch（distiller.ts:224-227）兜底返回
   `rawOutput: null`。**错误 message 丢弃**。
3. distiller 从不抛异常 -> `scheduler.tick`（src/scheduler.ts:237 外层 catch）不触发 ->
   `memory_distill_jobs.last_error` 列**不写**（实测两条 llm_error job `last_error=null`、
   `status='done'` 非 `failed`、`attempts=0`）。
4. `distill_runs` 表 `raw_output_json=null`；`source input` 被 distiller.ts:193 的
   `filteredTurns: callThrew ? [] : filtered` 清空（实测 `turnCount:0`）。
5. `/api/status` 的 `lastError`（src/server.ts:219 `jobs.find((j) => j.lastError)`）找不到
   llm_error job（它们的 `last_error` 为 null）。

结果：LLM 报错时整条链没有任何位置存下「到底报了什么错」。本 spec 补这个缺口。

诊断同时确认了根因性质：配置/凭证/distiller prompt 全对（用 `settings.json` 的 Ark 凭证
实调，简单调用 6.8s 成功、distiller 真实 prompt 23.7s 产出合法候选），失败是 Ark 端点
**间歇性不稳**（成功 8-23s，失败时每次 attempt ~6.4s 抛错 × 3 = 19.5s 耗尽重试）。本 spec
不解决 Ark 稳定性（外部服务），只让间歇失败时错误可见、可诊断。

## 目标 / 非目标

**目标**

- `llm_error` 的 distill run 记录其底层 LLM 调用的错误描述（含 HTTP status 若有）。
- Web UI 在 `llm_error` 时展示该错误描述（列表行摘要 + 详情 modal 完整）。
- 修复伴生缺口：`callThrew` 时不再清空 `filteredTurns`，llm_error job 也能看到「喂给
  模型的 transcript」。
- 修复 `/api/status` 的 `lastError`：llm_error job 的错误也能在顶部状态栏体现。

**非目标**

- 不改 `callWithRetry` 的签名或重试策略（方案 2：错误捕获留在 distiller 层）。
- 不做错误结构化分类（status code / 错误类型枚举）。错误以字符串形式存储，status 信息
  含在 message 里（如 `"500 Internal Server Error"`）。结构化分类留作 follow-up。
- 不解决 Ark 端点稳定性（外部服务，代码层只能让失败可见）。
- 不改 `callWithRetry` 的 maxRetries（3 次）或超时配置。

## 数据模型

`memory_distill_runs` 加一列：

| 列 | 类型 | 说明 |
|---|---|---|
| `error_message` | TEXT (nullable) | LLM 调用错误描述。`produced`/`empty_output`/`skipped_no_new_turns` 时 null；`llm_error` 时存错误 message（含 HTTP status 若有）。 |

幂等迁移（src/db/client.ts，与 `source_cwd`/`value_class` 迁移同模式）：

- DDL 的 `CREATE TABLE IF NOT EXISTS memory_distill_runs` 加 `error_message TEXT` 列。
- 幂等 ALTER：`PRAGMA table_info(memory_distill_runs)` 检测无 `error_message` 列则
  `ALTER TABLE memory_distill_runs ADD COLUMN error_message TEXT`（老库升级）。
- drizzle schema（src/db/schema.ts `memoryDistillRuns`）加 `errorMessage: text('error_message')`。

## 透传路径（distiller 层，方案 2）

只改 `src/memory/distiller.ts`，`callWithRetry` / dedup / valueFilter 不动。

**wrappedCall 捕获错误 message**（distiller.ts:172-184）：

```ts
let callThrew = false
let lastErrorMessage: string | null = null          // 新增
const wrappedCall: LLMCall = async (sys, user, opts) => {
  callThrew = false
  try {
    return await input.callLLM(sys, user, opts)
  } catch (e) {
    callThrew = true
    lastErrorMessage = e instanceof Error ? e.message : String(e)   // 新增：每次 attempt 更新
    throw e
  }
}
```

`lastErrorMessage` 每次 attempt 失败更新，留存最后一次 attempt 的错误（与 `callThrew`
同步：只在 call 抛错时更新，parse 失败不更新）。

**DistillResult 加字段**（distiller.ts:107-116）：

```ts
export interface DistillResult {
  candidates: DistillCandidate[]
  filteredTurns: TranscriptTurn[]
  rawOutput: unknown | null
  rawCount: number
  callThrew: boolean
  errorMessage: string | null    // 新增：llm_error 时的错误描述，其余 null
}
```

**三条返回路径的 errorMessage 取值**：

| 路径 | 行号 | callThrew | candidates | errorMessage |
|---|---|---|---|---|
| `!parsed`（callThrew） | distiller.ts:193 | true | [] | `lastErrorMessage` |
| `!parsed`（parse 失败） | distiller.ts:193 | false | [] | null（empty_output，非调用错误） |
| 成功（含 retry-success） | distiller.ts:223 | true/false | 有 | null（产出候选，错误被成功覆盖） |
| 顶层 catch 兜底 | distiller.ts:226 | true | [] | 顶层异常 message |

关键：retry-success（attempt 0 抛错记 `lastErrorMessage`、attempt 1 成功产出候选）时
`callThrew=false`（最后一次 attempt 重置并成功）、有候选 -> outcome=`produced`、
errorMessage=null。成功分支**显式返回 null**，不把 attempt 0 的残留 `lastErrorMessage`
带进产出记录。

`!parsed` 分支：`errorMessage: callThrew ? lastErrorMessage : null`。

顶层 catch（distiller.ts:224-227）：`errorMessage: e instanceof Error ? e.message : String(e)`
（catch 的参数目前是隐式 `unknown`，要命名 `catch (e)` 才能取 message）。

## source input 清空修复（伴生缺口）

distiller.ts:193：

```diff
- filteredTurns: callThrew ? [] : filtered,
+ filteredTurns: filtered,
```

**理由**：`filteredTurns` 是「过滤后准备喂模型的输入快照」，在 `callWithRetry` 之前就
算好（distiller.ts:164），与调用成败无关。`callThrew` 时清空它纯属丢失诊断信息。原注释
（distiller.ts:166-170）「matching the catch() degrade contract」不成立：顶层 catch
（distiller.ts:224）返回空是因为 `filtered` 在 filterTranscriptForDistill 抛错时算不出来；
而 `!parsed` 分支 `filtered` 早已算出，没有理由丢弃。

**效果**：`callThrew` 时 `saveSourceInput`（scheduler.ts:213）存真实 filtered transcript，
llm_error job 点「查看原始输入」能看到当时在蒸馏什么。`scheduler` 侧无需改动
（`filteredTurns` 透传即生效）。

**注释更新**：distiller.ts:166-170 的注释删除「callThrew -> empty filteredTurns」相关描述，
改为说明 `filteredTurns` 恒为过滤快照（无论调用成败）。

## store 层（src/memory/store.ts）

- `DistillRunRecord`（store.ts:555）加 `errorMessage: string | null`。
- `DistillRunRow`（store.ts:567）加 `errorMessage: string | null`。
- `DistillRunListRow`（store.ts:622）加 `errorMessage: string | null`（列表行也带，供 UI
  列表行展示错误摘要）。
- `saveDistillRun`（store.ts:581）：insert 的 values + onConflictDoUpdate 的 set 都写
  `errorMessage: record.errorMessage`。
- `rowToRun`（store.ts:601）：解析 `errorMessage: r.errorMessage`。
- `listRecentDistillRuns`（store.ts:644）：cols 加 `errorMessage: memoryDistillRuns.errorMessage`。

## scheduler 层（src/scheduler.ts）

**saveDistillRun 调用**（scheduler.ts:217-227）加 `errorMessage`：

```ts
await saveDistillRun(db, job.id, {
  outcome: ...,
  rawOutput, rawCount, acceptedCount: candidates.length, ...,
  durationMs,
  errorMessage,    // 新增：从 distillTranscript 解构
})
```

scheduler.ts:158 解构加 `errorMessage`。

**`/api/status` 修复**：llm_error 时也写 `memory_distill_jobs.last_error`。在 saveDistillRun
之后（best-effort，与 saveDistillRun 同级 try/catch + console.warn）：

```ts
if (outcome === 'llm_error' && errorMessage) {
  try {
    await db.update(memoryDistillJobs).set({ lastError: errorMessage })
      .where(eq(memoryDistillJobs.id, job.id)).run()
  } catch (e) { console.warn('memside: set lastError failed', e) }
}
```

效果：`/api/status` 的 `lastError`（server.ts:219 找 `j.lastError` 非空）能找到 llm_error
job，顶部状态栏显示最近 LLM 错误。语义变化：`last_error` 从「job 失败重试时的错误」扩展为
「最近一次错误」（含 llm_error 但 job 仍 done 的情况）。既有外层 catch（scheduler.ts:240,
243）写 `last_error` 的逻辑不变。

skipped 分支（scheduler.ts:130-142 的 saveDistillRun）不加 errorMessage（恒 null，outcome
是 `skipped_no_new_turns`，无 LLM 调用）。

## server 层（src/server.ts）

无需改路由逻辑--`/api/distill-runs/:jobId`（server.ts:338）返回 `getDistillRun` 的
`DistillRunRow`（自动含 errorMessage），`/api/distill-runs`（server.ts:327）返回
`DistillRunListRow`（自动含 errorMessage）。store 层加了字段，序列化自然带出。

## Web UI 层

**web-api（src/web/api.ts）**：`DistillRunDetail` / `DistillRunListItem` 类型加
`errorMessage: string | null`。

**ui-utils（src/web/ui-utils.ts）**：`formatOutcome` 不变（llm_error 已是红色徽标）。

**App.tsx - DistillRunModal**（src/web/App.tsx:614）：

产出区 llm_error 分支（App.tsx:701）从纯文案改为展示错误：

```diff
- : detail.outcome === 'llm_error' ? <span style={{ color: '#c00' }}>LLM 调用失败</span>
+ : detail.outcome === 'llm_error' ? (
+     <div>
+       <span style={{ color: '#c00' }}>LLM 调用失败</span>
+       {detail.errorMessage ? (
+         <pre style={{ background: '#fff4f4', color: '#c00', padding: 8, margin: '4px 0', whiteSpace: 'pre-wrap', borderLeft: '3px solid #c00' }}>{detail.errorMessage}</pre>
+       ) : <span style={{ color: '#999' }}>（无错误描述）</span>}
+     </div>
+   )
```

「无错误描述」兜底：历史 llm_error run（本功能上线前）无 errorMessage 字段，展示文案而非空白
（CLAUDE.md 状态可见性：不静默空白）。

**App.tsx - DistillRunRow**（src/web/App.tsx:513）：列表行 llm_error 时在 outcome 徽标下
显示一行截断错误（溢出省略），便于不点开逐个查看：

```tsx
{r.outcome === 'llm_error' && r.errorMessage && (
  <div style={{ color: '#c00', fontSize: 12, marginTop: 2,
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
    {r.errorMessage}
  </div>
)}
```

## 失败模式

| 场景 | 行为 |
|---|---|
| `error_message` 列不存在（老库） | 幂等 ALTER 补列；老行 `error_message=null`，UI 展示「无错误描述」 |
| `getDistillRun` 反序列化 raw_output_json 失败 | rawOutput=null（既有逻辑），errorMessage 正常读（独立列，不依赖 raw_output_json） |
| scheduler 写 last_error 失败 | console.warn，不阻塞 job done（best-effort，与 saveDistillRun 同级） |
| errorMessage 含敏感信息 | SDK 的 APIError.message 一般含 status + 端点路径，不含请求体/凭证；可接受。若后续发现含敏感数据，再加脱敏（follow-up） |
| 历史 llm_error run（无 errorMessage） | UI 兜底「无错误描述」；source input 修复后新 run 才有 transcript |

## 测试策略

**distiller（src/memory/distiller.ts）-- 纯函数层，主战场**：

1. callThrew 时 errorMessage = 最后一次 attempt 的错误 message（mock callLLM 前两次抛
   `"timeout"`、第三次抛 `"500"`，断言 errorMessage=`"500"`）。
2. retry-success 时 errorMessage = null（mock attempt 0 抛错、attempt 1 成功返回候选，
   断言 candidates 非空且 errorMessage=null）。
3. parse 失败时 errorMessage = null（mock callLLM 成功返回非 JSON，callThrew=false，
   断言 errorMessage=null）。
4. 顶层 catch 时 errorMessage = 异常 message（mock filterTranscriptForDistill 抛错
   -- 不易构造，改用 mock detectErrorSignals 抛错触发顶层 catch，断言 errorMessage=异常
   message、callThrew=true）。
5. **filteredTurns 在 callThrew 时保留**（回归防护：mock callLLM 抛错，断言
   `result.filteredTurns` 等于过滤后的 turns，非空）。这条测试锁住本次 source input
   修复--未来 refactor 若重新引入 `callThrew ? [] : filtered` 会立刻变红。

**store（src/memory/store.ts）**：

6. saveDistillRun 写 errorMessage；getDistillRun 读回 errorMessage 一致。
7. listRecentDistillRuns 返回的行含 errorMessage。
8. errorMessage=null 时正确序列化/反序列化（produced run）。

**scheduler（src/scheduler.ts）**：

9. llm_error 时 saveDistillRun 写入 errorMessage + job.last_error 更新（mock distillTranscript
   返回 callThrew=true + errorMessage，断言 job.last_error 被写）。
10. produced 时 job.last_error 不被写（断言无 last_error 更新）。

**server（src/server.ts）**：

11. `/api/distill-runs/:jobId` 详情返回 errorMessage 字段。
12. `/api/distill-runs` 列表项含 errorMessage 字段。

**web-api（src/web/api.ts）**：

13. `getDistillRun`/`listDistillRuns` 返回类型含 errorMessage（URL 断言既有模式）。

**Web UI（src/web/App.tsx / ui-utils.ts）**：

14. DistillRunModal llm_error + errorMessage 时渲染错误文本（源代码层文本断言兜底）。
15. DistillRunRow llm_error 时渲染截断错误（源代码层文本断言）。

**回归**：现有 distill-work-record 测试（470 条）全绿。callThrew sticky 测试（既有）仍绿
（errorMessage 不影响 callThrew 逻辑）。filteredTurns 清空修复可能使既有断言
`callThrew 时 filteredTurns=[]` 的测试变红--更新为期望真实 filtered（在测试文件顶端注释说明
本次修复链接本 spec）。

## 涉及文件

- `src/db/schema.ts` - `memoryDistillRuns` 加 `errorMessage` 列
- `src/db/client.ts` - DDL + 幂等 ALTER 迁移
- `src/memory/distiller.ts` - wrappedCall 捕获 + DistillResult.errorMessage + filteredTurns 修复 + 三条返回路径
- `src/memory/store.ts` - Record/Row/ListRow 类型 + saveDistillRun/getDistillRun/listRecentDistillRuns
- `src/scheduler.ts` - 解构 errorMessage + saveDistillRun 传入 + llm_error 写 job.last_error
- `src/web/api.ts` - 类型加 errorMessage
- `src/web/App.tsx` - DistillRunModal 错误展示 + DistillRunRow 截断错误
- 测试：`tests/distiller.test.ts` / `tests/store.test.ts`（或 store-distill-runs）/ `tests/scheduler.test.ts` / `tests/server.test.ts` / `tests/web-api.test.ts` / `tests/web-ui.test.ts` / `tests/ui-utils.test.ts`

# 空字符串归类 + e2e 大输入 设计 spec

日期：2026-08-17
状态：待批准
关联：修 2026-08-17 探查发现的两个问题——parse_error 错误归类（根因：模型返回空字符串被当解析失败）+ live e2e 测试输入太小（124 tokens vs 生产 63K tokens，差 500 倍，测不出真实问题）。

## 1. 背景

2026-08-17 诊断「8 月 17 日蒸馏记录大量报错」时，经过两轮探查，发现：

### 1.1 empty_output 是正确判定（已澄清，不改）

11 条 empty_output + 23 条 subagent empty_output 实测：模型对 subagent 开发对话（写代码/跑测试/开 PR）判定「无记忆可提炼」，返回 `{"candidates": []}`。**这是模型的正确判定，不是故障**。STATE.md 把它当待修问题是误判（已在探查中纠正认知）。本 spec 不改 empty_output。

### 1.2 parse_error 的真因是「模型返回空字符串」（本 spec 修）

复现实验（job `01M06R3MGGF7V09N0F7MN91MA0`，subagent 开发对话 source input，29603 字符 / ~7401 tokens）：
- 模型 108 秒后返回**空字符串** `""`（len=0），不是 `{"candidates": []}`，也不是半个坏 JSON。
- `extractJsonObject("")` → `""`，`JSON.parse("")` → `Unexpected EOF`。
- distiller 把它当解析失败 → `parseError = "不是合法 JSON：Unexpected EOF"` → outcome = `parse_error`。
- 错误文案 `Unexpected EOF` 误导诊断（看着像流式截断，实际是空字符串）。

**为什么耗时 300+ 秒**：`callWithRetry` 默认重试 3 次（maxRetries=2），每次空字符串都走 `retry.ts:51-56` 的 JSON.parse 失败分支，触发重试再问模型；模型每次 ~100 秒返回空 → 3 次累计 ~300 秒。

**根因链**：
1. 模型对无记忆价值的对话，有时返回 `{"candidates": []}`（→ empty_output），有时返回空字符串 `""`（→ parse_error）。
2. 空字符串和显式空 JSON是同一回事（「无产出」），但系统把它们归类成两个不同 outcome。
3. 空字符串被当「解析失败」是**错误归类**。

### 1.3 raw_text 落盘失效（本 spec 顺带修）

parse_error 时本该落盘模型原始输出（`raw_text`）供诊断，但实测全 NULL。根因：`capRawText`（`pure.ts:394-395`）`if (!raw) return null`——空字符串 `""` 是 falsy，被当 null 落盘。事故现场丢失。

### 1.4 live e2e 测试输入太小（本 spec 修）

现有 `tests/live-helpers.ts` 的 `makeFixture()`：8 turn / 495 字符 / ~124 tokens。真实生产那条失败的 distill 输入：63817 tokens。**差 500 倍**。

后果：`npm run test:live` 在 124 tokens 输入下，模型几秒返回干净 JSON，**永远撞不到 empty_output/parse_error**——门禁「全绿」却没发现生产真在报错。门禁对小输入有效（验契约形状），但对真实大输入无检测力。

实测对比：
- 小输入（124 tokens）：20 秒返回干净 JSON 候选 ✅
- 真实大输入（63K tokens / 200K 字符）：110 秒返回空字符串 → parse_error ❌（门禁测不到）

## 2. 目标 / 非目标

### 目标

1. **G1 空字符串归类为 empty_output**：distiller 把「模型返回空字符串」识别为「无产出」（empty_output），而非「解析失败」（parse_error）。空字符串与 `{"candidates": []}` 同义。
2. **G2 raw_text 空字符串落盘**：`capRawText` 不再把空字符串转 null；空字符串也落盘（可读为空，但不丢现场）。
3. **G3 live e2e 增加大输入场景**：新增一个用真实大 transcript（几百 KB / 几千-几万 token）的 live test，逼出真实路径（empty_output/parse_error 在大输入下的实际行为）。
4. **G4 纯函数 + 永不抛**：空字符串识别逻辑是纯函数，失败降级。

### 非目标

- **不改 empty_output 的判定**：empty_output 是模型正确判定（§1.1），不动。
- **不改 budget**：实测模型能吃 100K tokens 输入（400K 字符 2.5 秒返回 OK），budget 64000 不是主因。不动 `DEFAULT_DISTILL_INPUT_BUDGET_TOKENS`。
- **不改 prompt**：不在 prompt 强制「即使无记忆也必须返回 candidates:[]」（修法三，影响面大，弃）。改在 distiller 代码层识别空字符串。
- **不改 retry 逻辑**：`callWithRetry` 的重试语义不变（空字符串仍触发重试，因为模型偶尔抖动返回空可能重试就有了）。但在 retry 耗尽后，distiller 归类时识别空字符串。
- **不解决「subagent 开发对话被 enqueue 蒸馏浪费 LLM 调用」**：那是入队策略问题，独立。

## 3. 接口契约

### 3.1 distiller 空字符串识别（src/memory/distiller.ts）

`distillTranscript` 当前路径（`distiller.ts:222-238`）：`callWithRetry` 返回 `parsed`（undefined 或对象）；`!parsed || !Array.isArray(parsed.candidates)` → 归 `parseError`。

**问题**：空字符串经 `callWithRetry` → `extractJsonObject("")` → `JSON.parse("")` 抛错 → retry 耗尽返回 `lastParsed = undefined` → `parsed = undefined` → 归 parseError。distiller 无法区分「空字符串」和「真返回了坏 JSON」，因为 `lastRawText`（末次原始输出）没参与归类判断。

**改法**：在 `!parsed` 归类时，用 `lastAttemptRaw`（末次原始输出，已由 `onAttempt` 记录）区分：
- 若 `lastAttemptRaw` 为空字符串（或纯空白）：归类为「无产出」，`parseError = null`，让 scheduler 走 `empty_output`（candidates.length===0 && !callThrew && !parseError）。
- 若 `lastAttemptRaw` 非空但解析失败：保持 `parseError`（真解析失败，可能是半个 JSON）。

distiller.ts:233-238 改为：
```ts
return { candidates: [], filteredTurns: filtered, rawOutput, rawCount: 0, callThrew,
  errorMessage: callThrew ? lastErrorMessage : null,
  // 空字符串/纯空白 = 模型无产出（与 {"candidates":[]} 同义），归 empty_output 非 parse_error。
  // 非空但解析失败 = 真 parse_error。callThrew 与 parseError 互斥不变。
  parseError: callThrew ? null : (lastAttemptRaw != null && lastAttemptRaw.trim() !== ''
    ? (lastAttemptError ?? '解析失败：无错误描述')
    : null),
  lastRawText: callThrew ? null : lastAttemptRaw }
```

**效果**：空字符串 → `parseError = null` → scheduler `outcome = candidates.length===0 ? (callThrew ? llm_error : parseError ? parse_error : empty_output)`（`scheduler.ts:436`）→ `empty_output`。真坏 JSON → `parseError` 非空 → `parse_error`。

### 3.2 capRawText 空字符串落盘（src/memory/pure.ts）

`capRawText`（`pure.ts:394-401`）`if (!raw) return null` 把空字符串当 null。改为：
```ts
export function capRawText(raw: string | null): string | null {
  if (raw === null) return null
  if (raw.length === 0) return ''   // 空字符串也落盘（不丢现场），区别于 null（无数据）
  if (raw.length <= RAW_TEXT_CAP_CHARS) return raw
  // ... 截断逻辑不变
}
```

**效果**：parse_error 时若模型返回空字符串，`raw_text` 落盘 `""`（可读为空但存在），不再是 NULL。诊断时能看出「模型确实返回了空」。

### 3.3 live e2e 大输入场景（tests/live-helpers.ts + tests/live-distill.test.ts）

新增 `makeLargeFixture()`（`live-helpers.ts`）：构造一个**真实规模**的 transcript——不是手写 8 turn，而是模拟长寿会话：大量 assistant rationale + tool turn + 少量 user。目标几千-几万 tokens（逼出真实路径，但不必到 63K 以免每次 test 跑 100+ 秒）。

设计：~100 turn，混 assistant（rationale）/tool/user，总 ~10000-15000 tokens（40-60KB 字符）。这个量级能测「中等规模输入下模型是否稳定返回非空」，又不会每次跑 300 秒。

`live-distill.test.ts` 新增一个 test：用 `makeLargeFixture()` 跑 distill，断言**不返回空字符串**——即 `result.callThrew === false` 且 `result.candidates.length >= 1`（中等输入应能产出候选，若返回空说明模型对该输入判无记忆，是 empty_output 而非 parse_error）。

**关键**：大输入 test 断言「产出 ≥1 候选」——若模型对中等规模 fixture 也返回空，说明 fixture 内容确实无记忆价值（需调 fixture 含明确可提炼规则），或模型行为异常。这把「测不测得出问题」从「永远测不出」变成「能测出」。

## 4. 数据流

```
模型返回 ""
    │
    ▼
callWithRetry: extractJsonObject("") → "" → JSON.parse("") 抛 → retry 3 次 → 仍空 → lastParsed=undefined
    │  onAttempt 记录 lastAttemptRaw=""  lastAttemptError="不是合法 JSON：Unexpected EOF"
    ▼
distillTranscript: parsed=undefined → !parsed 分支
    │  【新增判断】lastAttemptRaw.trim()==='' → parseError=null（无产出）
    ▼
scheduler: candidates.length===0 && !callThrew && !parseError → outcome=empty_output（不再是 parse_error）
    │  raw_text: capRawText("") → "" 落盘（不再是 NULL）
    ▼
状态栏/消息中心: empty_output 计数（不再被假 parse_error 刷屏）
```

## 5. 失败模式

| 失败模式 | 处理 |
|---|---|
| 模型返回空字符串但其实是抖动（重试就有了） | `callWithRetry` 仍重试 3 次；本 spec 不改 retry。只在 retry 耗尽后归类时识别空字符串。抖动导致偶发空 → 仍走 empty_output（不再误标 parse_error）。 |
| 模型返回纯空白（空格/换行） | `lastAttemptRaw.trim() === ''` 覆盖纯空白，归 empty_output。 |
| 模型返回半个 JSON（真截断） | `lastAttemptRaw.trim() !== ''` → 保持 parseError → parse_error。真解析失败仍正确归类。 |
| lastAttemptRaw 为 null（onAttempt 没触发） | `lastAttemptRaw != null && ...` 守卫——null 时 fallback 到原逻辑 `lastAttemptError ?? '解析失败'`，保守归 parse_error（宁可误标 parse_error 也不漏）。 |
| 大输入 live test 每次跑 100+ 秒 | fixture 控制在 ~10-15K tokens（非 63K），单次 ~30-60 秒可接受。 |
| 大输入 fixture 内容模型判无记忆（empty_output） | 调 fixture 含明确可提炼规则（如 §3.3 所述），确保中等输入应产出候选。 |

## 6. 测试策略

### 6.1 纯函数层（distiller 空字符串归类）

`tests/distiller.test.ts` 新增：
1. **空字符串 → empty_output 非 parse_error**：mock callLLM 返回 `""`，断言 `result.parseError === null`、`result.candidates.length === 0`。
2. **纯空白 → empty_output**：mock 返回 `"   \n  "`，同上。
3. **半个坏 JSON → 仍 parse_error**：mock 返回 `{"candidates":[{"title":"x"`（截断），断言 `result.parseError !== null`。
4. **raw_text 空字符串落盘**：capRawText("") === ""（非 null）。

### 6.2 纯函数层（capRawText）

`tests/pure-raw-cap.test.ts` 新增/补充：
- `capRawText("")` === `""`（非 null，§3.2 回归锁）。
- `capRawText(null)` === `null`（不变）。

### 6.3 live e2e 大输入（tests/live-distill.test.ts + live-helpers.ts）

新增 `makeLargeFixture()` + 一个 live test：
- `makeLargeFixture()` 返回 ~100 turn / ~10-15K tokens transcript（含明确可提炼规则 + 大量 rationale/tool）。
- live test：`test.skipIf(!LIVE_GUARD)` 跑 distill，断言 `callThrew===false` 且 `candidates.length>=1`（中等输入应产出候选）。
- timeout 提至 300_000（大输入可能跑 60-100 秒）。

### 6.4 验证门槛

`bun run typecheck && bun test` 全绿。live test 默认 skip（双守卫），不影响默认门禁。修法一的正确性由纯函数单测保证（mock 空字符串）。

## 7. 与现有模块的耦合点

- **`src/memory/distiller.ts`**：`distillTranscript` 的 `!parsed` 归类分支改判断逻辑（§3.1）。`DistillResult` 结构不变。
- **`src/memory/pure.ts`**：`capRawText` 改空字符串处理（§3.2）。
- **`src/scheduler.ts`**：不动。outcome 判定（`scheduler.ts:436`）已支持 `parseError ? parse_error : empty_output`，distiller 返回 `parseError=null` 时自动走 empty_output。
- **`tests/live-helpers.ts`**：新增 `makeLargeFixture()`。
- **`tests/live-distill.test.ts`**：新增大输入 test。
- **`tests/distiller.test.ts` / `tests/pure-raw-cap.test.ts`**：新增空字符串归类 + capRawText 测试。

## 8. 上线后观测（硬要求，结论回填 STATE.md）

1. parse_error 24h 计数对比（修法一前 vs 后）。预期大幅下降（空字符串归 empty_output 后，只剩真坏 JSON 的 parse_error）。
2. empty_output 24h 计数对比。预期上升（原 parse_error 的空字符串归入 empty_output）——但这是正确归类，不是新故障。
3. raw_text 落盘率：parse_error 的 raw_text 不再全 NULL（空字符串落盘为 ""）。
4. live e2e 大输入 test 首次真跑：中等输入下模型是否稳定产出候选。

## 9. 未覆盖（后续 issue）

1. **subagent 开发对话入队预筛**：subagent 做开发任务（无记忆价值）仍被 enqueue 蒸馏，浪费 LLM 调用。独立 issue。
2. **budget 是否需调整**：实测模型能吃 100K tokens，但「大输入 + 长生成」组合下模型可能仍不稳定返回。若修法一后仍有异常空返回，再评估 budget。本期不动。
3. **prompt 强制合法 JSON**（修法三）：本期弃，若修法一后空字符串仍高频，再考虑。

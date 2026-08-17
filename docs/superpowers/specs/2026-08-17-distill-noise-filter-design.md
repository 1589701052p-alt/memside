# 蒸馏输入噪声剔除 设计 spec

日期：2026-08-17
状态：待批准
关联：补 `filterTranscriptForDistill`（`src/memory/pure.ts:286`）未识别 user-role 噪声的缺口；缓解 STATE.md 已知债务 #1（events 存完整 transcript 膨胀）在 distill 输入侧的影响（DB 膨胀本身不碰，独立 issue）。

## 1. 背景

2026-08-17 用户发现蒸馏记录（`memory_distill_runs`）出现大量 8 月 17 日报错：~24 条 `empty_output`、4 条 `parse_error`、2 条 `llm_error`，几乎全耗时 200-360 秒。诊断排除了 live test 污染（live test 直调 `distillTranscript` 不写 jobs/runs 表，这些是 daemon 真实蒸馏）和阿里云端点故障（同凭证短输入 20s 返回干净 JSON）。

**根因**：长寿会话（多次 compact 续命 + 大量后台 subagent）的 transcript 巨大（最大 1065KB / 1119 turn）。`filterTranscriptForDistill` 把文件类 tool 结果压成了占位（tool role 988KB→5.9KB），但 **user role 里的两类噪声没被识别**，过滤后仍 255KB 喂模型，prompt 超出模型有效窗口 → 模型返回空（empty_output）或流式长生成中途断连（`parse_error: Unexpected EOF`）。

### 1.1 噪声构成（实测，job GFHPWG，过滤后 255KB）

| role | 过滤后字符 | 构成 |
|---|---|---|
| tool | 5.9KB | 文件结果已压占位（`compactToolTurn` 生效） |
| assistant | 128KB | rationale/解释（有价值的信号，但量过大） |
| **user** | **115KB** | **~100KB 是两类噪声** |

**user role 的两类噪声（共 ~100KB）**：

1. **task-notification 块（~70KB）**：content 是 `<task-notification>...</task-notification>` XML，harness 后台 task（subagent/bun）完成回调。实测 24 条，每条 5-16KB，**全部为纯 XML 无用户正文混杂**。对提炼记忆零价值。
2. **compact 续接块（~31KB）**：content 以 `This session is being continued from a previous conversation` 开头，是上一段会话的压缩摘要（compact 续命块）。2 条，各 15-16KB。

### 1.2 为什么现有过滤没覆盖

`filterTranscriptForDistill`（`pure.ts:286-315`）的压缩逻辑（`compactToolTurn`）只作用于 `role === 'tool'` 的 turn。这两类噪声是 `role === 'user'`，走 `truncate(content, NON_TOOL_CAP_CHARS)`（NON_TOOL_CAP_CHARS=20000）。它们大多 5-16KB，卡在 20000 cap 以内，**原样保留**。

更糟的是预算裁剪的反向优先级：`turnPriority`（`pure.ts:268`）user role = 0（最高），budget 超限时 `x.p > 1` 才丢（`pure.ts:302`），**user 永不丢**。所以这些 user 噪声在超预算时被强制保留，反而把 assistant rationale（priority=2）挤掉——**噪声留、信号丢，方向反了**。

### 1.3 为什么"之前的会话没这么大"

之前没有这种「长寿会话 + 大量后台 subagent」组合。subagent-driven 全流程会 spawn 大量后台 agent，每个完成都往 transcript 塞一个 task-notification XML，全部以 user turn 全量保留。compact 续命块随会话多次压缩累积。普通短会话几 KB-几十 KB，不触发问题。

## 2. 目标 / 非目标

### 目标

1. **G1 识别并剔除 task-notification 块**：`filterTranscriptForDistill` 开头剔除纯 `<task-notification>` XML 的 user turn。
2. **G2 识别并剔除 compact 续接块**：剔除以 `This session is being continued from a previous conversation` 开头的 user turn。
3. **G3 纯函数 + 永不抛**：剔除逻辑是纯函数，在现有 compact/budget 之前执行，失败降级为不剔（保留原 turn）。
4. **G4 不影响 detectErrorSignals**：`detectErrorSignals` 跑在原始 turns（filter 之前，`pure.ts:284` 注释），剔除只影响 distiller 输入，不影响错误信号检测。
5. **G5 回归防护**：纯函数层测试覆盖两类噪声剔除 + 不误伤正常 user turn + 剔除后预算裁剪能保留 rationale。

### 非目标

- **不碰 DB 膨胀**（STATE.md 债务 #1）：events 表仍存完整 transcript（含噪声）。剔除只在 distill 输入侧，DB 减容是独立 issue。
- **不碰 capture 层**（`parseTranscriptFile`/`parseOpencodeMessages`）：只在 filter 层剔除，降低跨 runtime 回归风险。
- **不处理 assistant role 冗余**（128KB rationale）：assistant 是有价值信号，本期不动；若剔除噪声后仍超预算，靠现有 budget 裁剪按 priority 处理。
- **不修 parse_error raw_text 落盘缺陷**（`retry.ts:41-46` call 抛错不 fireAttempt）：独立 issue，本期只解决「为什么输入这么大」，不解决「事故现场为什么没落盘」。
- **不碰 origin discipline / category 规则**：只动 filter 层，distiller prompt / 解析契约零改动。

## 3. 接口契约

### 3.1 新增纯函数 `stripNoiseTurns`（`src/memory/pure.ts`）

```ts
/**
 * 剔除 distiller 输入里的两类 user-role 噪声（spec 2026-08-17 §1.1）：
 *   1. task-notification 块：content 含 `<task-notification>` XML（harness 后台 task 回调，零记忆价值）。
 *   2. compact 续接块：content 以 `This session is being continued from a previous conversation` 开头
 *      （历史压缩摘要，非本会话原话，作 evidence 出处不可靠；distiller 的 priorContext 段已单独提供背景）。
 *
 * 纯函数 + 永不抛：任何异常降级为返回原 turns（不剔，保守保留）。
 * 只识别 user role；其他 role 原样返回。
 * 在 filterTranscriptForDistill 的 compact/budget 之前执行。
 */
export function stripNoiseTurns(turns: readonly TranscriptTurn[]): TranscriptTurn[]
```

**识别规则（保守、精确）**：
- task-notification：`t.role === 'user'` 且 `t.content.includes('<task-notification>')`。实测 24/24 纯 XML 无正文混杂（§1.1），按 `<task-notification>` 子串识别零误伤。
- compact 续接：`t.role === 'user'` 且 `t.content.startsWith('This session is being continued from a previous conversation')`。用 startsWith 精确匹配开头，不误伤含相似词的正常 user turn。

### 3.2 接入 `filterTranscriptForDistill`

```ts
export function filterTranscriptForDistill(
  turns: readonly TranscriptTurn[],
  budgetTokens: number = DEFAULT_DISTILL_INPUT_BUDGET_TOKENS,
): TranscriptTurn[] {
  if (!Array.isArray(turns)) return []
  try {
    const denoised = stripNoiseTurns(turns)        // ← 新增：先剔噪声
    const compacted = denoised.map((t) =>
      t.role === 'tool' ? compactToolTurn(t) : { ...t, content: truncate(t.content, NON_TOOL_CAP_CHARS) },
    )
    // ... 后续 budget 裁剪逻辑零改动
  } catch {
    return [...turns]
  }
}
```

剔噪声在 compact 之前，让 budget 裁剪面对的是已去噪的 turns——噪声不再以 user priority=0 强留挤掉 rationale。

### 3.3 detectErrorSignals 不变

`detectErrorSignals`（`pure.ts:131`）仍跑在原始 turns（调用方 `distiller.ts` 在 filter 之前调），不受剔除影响。`pure.ts:284` 注释已说明此约束，本期保持。

## 4. 数据流

```
原始 turns（含 task-notification / compact 块）
        │
        ▼
detectErrorSignals(原始 turns)          ← 不变，跑在 filter 前
        │
        ▼
stripNoiseTurns(turns)                  ← 新增：剔除 task-notification + compact user turn
        │
        ▼
map: compactToolTurn(tool) / truncate(user,20000)
        │
        ▼
budget 裁剪（priority: user=0 > error=1 > assistant=2 > tool=3）
        │  噪声已剔，user 不再被噪声挤占预算
        ▼
distiller 输入（大幅减容，rationale 保留率提升）
```

## 5. 失败模式

| 失败模式 | 处理 |
|---|---|
| `stripNoiseTurns` 内部异常 | try/catch 降级返回原 turns（不剔，保守保留），由 `filterTranscriptForDistill` 外层 catch 兜底。 |
| 误剔含 `<task-notification>` 的正常 user turn | 实测 24/24 纯 XML 无正文（§1.1）；若未来出现正文混杂，用户陈述会随 notification 一起被剔。风险接受：用户在 task-notification 块里陈述规则的概率极低，且 distiller 看不到也无所谓（它不是对话原话）。 |
| compact 续接块含转述规则被误删 | 有意取舍（§1.1）：compact 是压缩非原话，作 evidence 出处不可靠，剔除防贴金；distiller 的 priorContext 段已单独提供背景。放弃压缩转述规则换取不贴金 + 减容。 |
| 老数据 events 已存噪声 | filter 层每次运行剔，老数据重跑 distill 自动受益；DB 仍膨胀但 distill 输入已净化。 |
| 剔除后仍超预算 | 走现有 budget 裁剪（priority），assistant rationale 按 priority=2 正常参与裁剪。 |

## 6. 测试策略

### 6.1 纯函数层（`tests/`，可断言主面）

新增 `tests/pure-noise-filter.test.ts`：

1. **task-notification 剔除**：fixture 含 3 条 user turn（1 条 `<task-notification>` XML + 2 条正常 user），断言剔除后剩 2 条正常，notification 不在结果里。
2. **compact 续接剔除**：fixture 含 1 条 `This session is being continued...` 开头 + 1 条正常 user，断言剔除 compact 块。
3. **不误伤其他 role**：含 assistant/thinking/tool 的混合 turns，断言这些 role 全保留。
4. **不误伤相似但非噪声的 user turn**：user content 含 "previous conversation" 或 "task" 字样但非完整 pattern，断言保留。
5. **`stripNoiseTurns` 永不抛**：传非数组/异常输入，断言返回 []（或原样，遵循 filter 契约）。
6. **接入验证**：`filterTranscriptForDistill` 对含噪声的 turns，输出不含 notification/compact 块；且当噪声使总体超预算时，rationale（assistant）不被噪声挤掉（回归 §1.2 反向优先级 bug）。

### 6.2 现有测试回归

- `tests/pure-transcript-filter.test.ts`：现有 filter 测试应全绿（剔除是新增步骤，对无噪声 turns 零影响——stripNoiseTurns 不匹配则原样返回）。
- `tests/e2e.test.ts`：e2e fixture 不含 task-notification/compact，stripNoiseTurns 原样返回，e2e 仍绿。

### 6.3 验证门槛

`bun run typecheck && bun test` 全绿。不需 live test（噪声剔除是纯函数，单测覆盖足够；减容效果用真实大 transcript 在实现后可手动验证一次回填 STATE.md，但不进门禁）。

## 7. 与现有模块的耦合点

- **`src/memory/pure.ts`**：新增 `stripNoiseTurns` + `filterTranscriptForDistill` 加一行调用。唯一改动文件。
- **`src/memory/distiller.ts`**：不动。`distillTranscript` 调 `filterTranscriptForDistill`（`distiller.ts:197`），自动受益。
- **`src/memory/contextDigest.ts` / `rollingSummary.ts`**：若它们也调 `filterTranscriptForDistill` 则同步受益；若调原始 turns 则不受影响（需实现时确认，预计不影响）。
- **capture 层（`parseTranscriptFile`/`parseOpencodeMessages`）**：零改动。
- **DB schema**：零迁移。

## 8. 上线后观测（硬要求，结论回填 STATE.md）

1. 剔除后 distill 输入字符数对比（抽样大 transcript job：过滤前 vs stripNoiseTurns 后 vs 最终喂模型）。预期 user role 从 ~115KB 降到正常水平（去除 ~100KB 噪声）。
2. empty_output / parse_error 24h 计数对比（剔除前 vs 后）。预期大幅下降。若仍高频，说明还有别的噪声源或预算仍超，需二期。
3. 剔除后是否仍有 distill 输入超模型窗口的情况（看 empty_output 是否归零）。

## 9. 未覆盖（后续 issue）

1. **parse_error raw_text 落盘缺陷**（`retry.ts:41-46` call 抛错不 fireAttempt，导致 parse_error 事故现场丢失）：独立 issue，本期不碰。
2. **DB 膨胀**（events 存完整 transcript 含噪声，STATE.md 债务 #1）：独立 issue，filter 层减容不解决存储膨胀。
3. **assistant role 冗余 rationale**（128KB）：若剔除 user 噪声后仍超预算，二期可考虑 rationale 去重/摘要。
4. **opencode runtime 的同类噪声**：opencode 的 task-notification/续接块格式可能不同，实现时确认 `stripNoiseTurns` pattern 是否覆盖；若不覆盖留二期。

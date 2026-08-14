# 蒸馏 LLM 流式化 + 失败可见性 设计 spec

日期：2026-08-14
状态：已批准（用户审批通过，含范围决策「LLM 报错 + 降级都要醒目」）
关联：依赖 2026-08-12 llm-status-and-message-center 的消息中心与状态栏骨架

## 1. 背景

2026-08-13 起线上观测到蒸馏 LLM 调用持续失败（`Connection error.`，单次失败耗时 448-566s），
但设置页「测试连接」按钮始终报成功，用户未察觉故障（去重/审查计数连日为 0 才暴露）。

systematic-debugging 实验结论（2026-08-14，本仓库一次性脚本实测）：

| 请求形态 | 走代理 7897 | 直连 |
|---|---|---|
| 非流式，短生成（max_tokens=512） | ✅ 9s | ✅ 16s |
| 非流式，大载荷（~230k 字） | ✅ 37s | ✅ 27s |
| 非流式，长生成（max_tokens=8192） | ❌ 62s 整 Connection error | ❌ 60s 整 Connection error |
| 流式（messages.stream），同载荷同 8192 | ✅ 203s | ✅ 170s |

**根因**：当前 LLM 端点（kimi coding）对**生成时长超过约 60 秒的非流式请求**准时断连
（代理与直连同现，排除本地代理因素；60s 整的特征指向端点/网关的 TTFB 类限制）。
非流式请求在模型生成期间响应方向零字节，必然撞墙；流式请求字节持续流动，可稳定完成。
「测试连接」成功是假象：它用 max_tokens=1 的秒级探针，永远碰不到 60s 墙。

历史失败单 448-566s 的耗时 = SDK 默认 maxRetries=2 下三次各 ~60-180s 的尝试叠加退避。

## 2. 目标 / 非目标

### 目标

1. **G1 蒸馏调用流式化**：`makeLLMCall` 改用流式传输，消除 60s 非流式墙，大载荷长生成可稳定完成。
2. **G2 失败醒目可见**：未读 LLM 报错 / 降级在状态栏以警示条呈现，🔔 入口变色，用户无需点开消息 tab 即可察觉。
3. **G3 重复消息折叠**：连续相同内容的通知不刷屏、未读数不虚高。
4. **G4 测试连接语义澄清**：设置页明确「测试连接仅验证端点可达」，消除「测试绿 = 蒸馏必成」错觉。

### 非目标

- 不改 `LLMCall` 对外签名（`callLLM(system, user, opts?) => Promise<string>`），distiller / dedup / judge 调用方零感知。
- 不引入新依赖。
- 不动消息中心 tab 的既有交互（逐条已读 / 全部已读 / 搜索 / 筛选保持不变）。
- 不做桌面通知 / 声音提醒（Web UI 内警示条已满足「醒目」需求）。
- 不改「测试连接」的探测方式（仍是 max_tokens=1 非流式小探针——它测的就是可达性）。

## 3. 接口契约

### 3.1 `makeLLMCall` 流式化（src/anthropic.ts）

- 内部从 `client.messages.create(...)` 改为 `client.messages.stream(...)` + `await stream.finalMessage()`。
- 文本提取逻辑不变（`content` 块 `type==='text'` 拼接），返回值语义不变。
- 显式传入 `{ timeout: 600_000 }`（10 分钟硬上限兜底，防极端挂死；正常流式 170-210s 即可完成）。
- 保留 SDK 默认 `maxRetries`（连接错误自动重试 2 次）。
- `AnthropicDeps`、错误透传（`Error.message`）语义不变。

### 3.2 status 端点新增字段（src/server.ts `GET /api/status`）

```jsonc
{
  // ...既有字段不动（unreadNotifications 总数保留）
  "unreadLlmErrors": 2,      // notifications 中 kind='llm_error' AND read_at IS NULL 的计数
  "unreadDegradations": 5,   // notifications 中 kind='degradation' AND read_at IS NULL 的计数
  "latestUnreadLlmError": {  // 最新一条未读 llm_error（警示条要显示「最近：xxx」）；无则 null
    "body": "Connection error.",
    "ts": 1723680000000
  }
}
```

SQL：在既有 unread 总数查询旁按 kind 分组计数 + 取最新一条未读 llm_error 的 body/ts（LIMIT 1 ORDER BY ts DESC）。

### 3.3 通知折叠（src/memory/store.ts `insertNotification`）

插入前折叠检查：

- **llm_error**：若存在最新一条 `kind='llm_error' AND read_at IS NULL AND body = 新body` 的通知
  → 不新插行，将该行 `ts` 刷新为 `Date.now()`（保持它浮在列表顶部），返回该行 id。
- **degradation**：若存在最新一条 `kind='degradation' AND read_at IS NULL AND title = 新title`
  （title = 降级 kind）的通知 → 同上只刷 ts。
- 已读的相同内容不折叠（已读即用户已处置，新的发生是新事件，正常新插）。
- 折叠命中时**跳过保留裁剪**（没有新行，无需裁剪）。
- body 比较用裁剪后（2000 字 cap 内）的值，与入库值一致。

### 3.4 Web UI（src/web/App.tsx + src/web/api.ts 类型）

- **警示条**：状态栏容器内、三阶段实况行下方插入（仅在有对应未读时渲染）：
  - `unreadLlmErrors > 0` → 红底白字条：
    `⚠️ 蒸馏 LLM 报错 ×N（最近：<body 截断 40 字>）→ 点击查看`，点击 `setTab('messages')`。
  - `unreadDegradations > 0` → 琥珀底条：`⚠️ 降级 ×N → 点击查看`，点击同上。
  - 两条可同时存在（LLM 报错条在上）。无独立关闭按钮；未读清零（消息 tab 已读操作）后自动消失。
- **🔔 按钮**：`unreadLlmErrors > 0` 时按钮文案红色加粗；仅降级未读时保持现状（琥珀色）。
- **设置页测试连接**（设置 tab）：按钮旁加一行灰色小字
  「仅验证端点可达；长蒸馏请求可能仍失败，失败会在状态栏警示条提示」。
- 样式沿用既有 inline style 约定，不引入新组件库。

### 3.5 纯函数（src/web/ui-utils.ts）

- `truncateAlertBody(body: string | null, max = 40): string` — 警示条「最近：」文案截断，
  null → `'（无详情）'`。
- 既有 `notificationTitle` / `formatElapsed` / `formatPhaseStat` 复用，不改签名。

## 4. 数据流 / 耦合点

- scheduler 蒸馏失败路径 → `logLlmErrorNotification` → `insertNotification`（折叠在内）→ status 端点按类计数 → App 状态栏警示条。
- `logDegradation` 双写路径同样经过 `insertNotification`，自动获得折叠行为。
- 消息 tab 已读操作 → `read_at` 落库 → 下一次 status 轮询（既有轮询节奏不变）警示条消失。
- `makeLLMCall` 被 distiller / dedup / valueFilter 经 `callWithRetry` 消费（`resolveCallLLM` 注入）；流式化对调用方透明。

## 5. 失败模式

| 场景 | 行为 |
|---|---|
| 流式中途断连 | SDK 抛错 → 走既有 llm_error 通知路径；SDK 默认重试 2 次仍兜底 |
| 折叠更新 ts 失败 | 同既有契约：warn，不影响蒸馏主流程 |
| status 新字段查询失败 | 整个 status 既有 try/catch 兜底（断连 banner），不新增爆炸半径 |
| 端点换掉 60s 墙（未来升级） | 流式请求不受影响，无需回退 |
| 超长输出超过 8192 token | `stop_reason=max_tokens`，与现状一致（蒸馏 prompt 自带条数上限，实际输出远小于 8192） |

## 6. 测试策略

| # | 层 | 用例 |
|---|---|---|
| T1 | anthropic 单测 | mock SDK：断言调用 `messages.stream` 而非 `create`；文本拼接正确；错误 message 透传；timeout 600_000 传入 |
| T2 | store 单测 | llm_error 折叠：同 body 未读已存在 → 不新插、行数不变、ts 刷新、返回原 id；不同 body → 新插；已读同 body → 新插 |
| T3 | store 单测 | degradation 折叠：同 title 未读 → 折叠；不同 title → 新插；折叠命中不触发裁剪（行数 > cap 边界不退化） |
| T4 | server 集成 | `/api/status` 返回 `unreadLlmErrors` / `unreadDegradations` / `latestUnreadLlmError` 计数与最新 body 正确；全已读时分别为 0 / 0 / null |
| T5 | ui-utils 单测 | `truncateAlertBody`：null / 短串 / 超长截断 |
| T6 | web 源码断言 | App.tsx 含警示条渲染分支（`unreadLlmErrors`、红底样式、`setTab('messages')`）；🔔 红色加粗分支；设置页提示小字 |

回归防护：T1 锁定「不再使用非流式 create」这一根因修复，未来 refactor 一旦改回非流式立刻变红。

## 7. 验收清单

- [ ] 大载荷长生成蒸馏调用流式完成（实测同等载荷不再 Connection error）
- [ ] 人为制造 LLM 报错后，状态栏红条 + 红铃出现，点击跳消息 tab
- [ ] 连续 3 次相同报错只产生 1 条未读通知
- [ ] 消息 tab 全部已读后警示条与铃铛复原
- [ ] `bun run typecheck && bun test` 全绿
- [ ] 设置页测试连接旁出现语义澄清小字

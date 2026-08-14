# 蒸馏 LLM 流式化 + 失败可见性 任务计划

日期：2026-08-14
Spec：`docs/superpowers/specs/2026-08-14-llm-streaming-and-failure-visibility-design.md`
执行方式：subagent-driven（每任务 fresh implementer + task reviewer，最后 whole-branch review）
分支：`fix/llm-streaming-and-failure-visibility`（从最新 origin/master 切）

## 任务分解

### T1 anthropic.ts 流式化（spec §3.1）

- 改动：`src/anthropic.ts` `makeLLMCall` 内部 `messages.create` → `messages.stream` + `finalMessage()`；
  显式 `timeout: 600_000`；文本提取与错误透传不变。
- 测试（同文件测试或既有 anthropic 测试文件）：mock SDK 断言
  (a) 走 `messages.stream` 不走 `create`（根因回归锁）；
  (b) 文本块拼接正确；(c) 错误 `message` 透传；(d) timeout 600_000 传入。
- 验收：spec 测试策略 T1 全绿。
- 依赖：无。

### T2 通知折叠（spec §3.3）

- 改动：`src/memory/store.ts` `insertNotification` 插入前折叠检查：
  - llm_error：最新一条未读同 kind 且 body 相同 → `UPDATE notifications SET ts=? WHERE id=?`，返回原 id，跳过插入与裁剪。
  - degradation：最新一条未读同 kind 且 title 相同 → 同上。
  - 比较用裁剪后 body（2000 字 cap）。
- 测试：spec T2 / T3（同 body 折叠、不同 body 新插、已读不折叠、折叠不触发裁剪、degradation 同 title 折叠）。
- 验收：spec 测试策略 T2 / T3 全绿。
- 依赖：无（与 T1 并行）。

### T3 status 端点按类未读计数（spec §3.2）

- 改动：`src/server.ts` `/api/status` 新增 `unreadLlmErrors` / `unreadDegradations` /
  `latestUnreadLlmError: { body, ts } | null`；保留 `unreadNotifications` 总数。
- 同步：`src/web/api.ts` `StatusResponse` 类型加三个字段。
- 测试：spec T4（计数正确、最新 body/ts 正确、全已读归零/为 null）。
- 依赖：无（与 T1/T2 并行；T5 依赖它）。

### T4 ui-utils 纯函数（spec §3.5）

- 改动：`src/web/ui-utils.ts` 新增 `truncateAlertBody(body, max=40)`。
- 测试：spec T5。
- 依赖：无（并行）。

### T5 App.tsx 警示条 + 红铃 + 设置页小字（spec §3.4）

- 改动：
  - 状态栏容器内三阶段行下方插入警示条（llm_error 红条在上、degradation 琥珀条在下），
    点击 `setTab('messages')`；无独立关闭。
  - 🔔 按钮：`unreadLlmErrors > 0` 红色加粗；仅降级未读 → 琥珀色。
  - 设置 tab 测试连接按钮旁加灰色小字（spec §3.4 原文）。
- 测试：spec T6 源码断言（渲染分支、红底样式、setTab 跳转、铃铛变色分支、设置页小字）。
- 依赖：T3（status 字段）、T4（truncateAlertBody）。

### T6 文档收尾

- 更新 `STATE.md`（本迭代改动 + 实测根因结论）与 `README.md`（状态栏警示条 / 折叠行为一句话级）。
- 验收：文档与新行为一致。
- 依赖：T1-T5。

## 依赖图

```
T1 ──┐
T2 ──┼──（并行）──> T5（依赖 T3、T4）──> T6
T3 ──┤       T4 ──┘
```

## 总验收

- spec §7 验收清单全过；
- `bun run typecheck && bun test` 全绿；
- whole-branch review 无 Blocking。

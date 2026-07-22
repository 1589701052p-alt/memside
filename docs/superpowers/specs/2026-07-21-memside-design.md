# memside — 跨运行时旁路长期记忆 sidecar

- 日期：2026-07-21
- 状态：Draft
- 灵感来源：agent-workflow RFC-041 平台长期记忆子系统（已验证设计，大量照搬其存储 / 提炼 / 调度 / 审批机制）

## 1. 背景与目标

memside 是一个本地常驻的长期记忆 sidecar，给 **claude code（MVP 完整支持）** 和 **opencode（MVP stub，后续填实体）** 当"记忆外挂"。

它旁路监听用户日常使用 CLI 产生的对话与错误，提炼出可复用的业务 / 架构知识，经人工审批后，在下次会话启动时自动注入回 CLI 的 system prompt。全程不接管用户启动 CLI 的方式、不阻塞任何正常任务。

核心闭环：**采集（对话 + 错误）→ 提炼 → 审批 → 注入**。

## 2. 非目标

- 不接管用户启动 claude code / opencode 的方式（纯旁路，不 spawn agent）。
- 不做多用户 / 团队共享记忆（单用户本地）。
- MVP 不实现 opencode 的实体采集与注入（留接口 + stub）。
- 不做工作流编排、agent 管理、任务管理、worktree（这些是 agent-workflow 的职责，memside 只做记忆这一件事）。

## 3. 关键决策

| # | 决策点 | 选择 | 理由 |
|---|--------|------|------|
| 1 | 运行形态 | 旁路监听 | 用户照常用 CLI，工具后台监听 + 注入；最贴"插件""不阻塞"定位 |
| 2 | 部署形态 | 单用户本地 | sqlite 本地存储、轻量 daemon；MVP 快速出 |
| 3 | 提炼器 | 复用 claude 凭证直调 Anthropic API | 零额外配置 / 费用、进程轻 |
| 4 | 审批 UI | 本地 Web UI | 审批需看候选 + 来源上下文，Web 体验最好 |
| 5 | 错误信号 | 混合（自动检测 + 用户标注） | 覆盖面与精准度兼顾 |
| 6 | 采集 + 注入 | hook 全驱动 | 实时、per-session、不污染用户文件 |
| 7 | MVP 范围 | claude code 完整闭环，opencode stub | 规避 opencode 最大不确定风险，先打通 |

## 4. 架构

### 4.1 形态

本地常驻 daemon（Bun 单进程）+ 本地 SQLite（WAL）+ 按需起的本地 Web UI。

### 4.2 组件

- **Collector**：HTTP 端点，接收 claude code hook 回调，落事件队列。
- **Scheduler**：debounce 凑批 + 1Hz worker，驱动提炼。
- **Distiller**：复用 claude 凭证调 Anthropic API，把事件蒸馏成候选记忆。
- **Store**：SQLite，存 memories / events / distill_jobs。
- **Approval Web UI**：本地 web 服务，候选审批 / 编辑 / 替换。
- **Injector**：SessionStart hook 调用，返回当前会话相关记忆块。
- **RuntimeAdapter**：抽象接口，隔离 runtime 差异。`ClaudeCodeAdapter` 实体，`OpencodeAdapter` stub。

### 4.3 组件拓扑

```
                 ┌─────────────── 日常使用（不受影响）───────────────┐
   用户 ──> claude code CLI ──┐                            opencode CLI ──┐
                 │ hooks                          │ plugin/hook(stub)  │
                 ▼                                ▼                    │
        ┌─────────────────────────────────────────────────┐            │
        │  采集器 Collector  (HTTP/IPC 接收 hook 回调)     │            │
        │  · 会话 transcript · 工具失败 · 用户标注         │            │
        └──────────────────────┬──────────────────────────┘            │
                               ▼                                       │
        ┌─────────────────────────────────────────────────┐            │
        │  调度器 Scheduler (debounce + 1Hz worker)        │            │
        └──────────────────────┬──────────────────────────┘            │
                               ▼                                       │
        ┌─────────────────────────────────────────────────┐            │
        │  提炼器 Distiller (复用 claude 凭证 -> Anthropic) │            │
        │  · 口味同本项目: 业务/架构知识 + [category:xxx]  │            │
        └──────────────────────┬──────────────────────────┘            │
                               ▼ candidate                             │
        ┌──────────────────────────┐    ┌─────────────────────────┐   │
        │  存储 Store (sqlite)      │<──>│ 审批 Web UI             │   │
        │  memories + events + jobs │    │ 批准/拒绝/编辑/替换     │   │
        └──────────┬───────────────┘    └─────────────────────────┘   │
                   ▼ approved                                         │
        ┌─────────────────────────────────────────────────┐            │
        │  注入器 Injector                                  │            │
        │  · SessionStart hook 动态返回相关记忆 (claude)    │ ───────────┘
        │  · opencode stub (no-op)                          │
        └─────────────────────────────────────────────────┘
```

### 4.4 RuntimeAdapter 抽象

借鉴 agent-workflow `RuntimeDriver`（`packages/backend/src/services/runtime/types.ts:307`）。接口定义采集与注入的 runtime 专属逻辑，新 runtime = 实现一个 adapter + 注册。MVP 只实现 ClaudeCodeAdapter，OpencodeAdapter 为 stub。

## 5. 数据模型

照搬 RFC-041 `memories` 表（agent-workflow `packages/backend/src/db/schema.ts:1494`），字段语义照搬：
`id / scopeType / scopeId / title / bodyMd / tags / status / sourceKind / distillAction / supersedesId / supersededById / version / approvedByUserId / approvedAt / createdAt`。

### 5.1 作用域（旁路模式调整）

砍掉 agent / workflow 层（旁路无虚拟 agent / 工作流概念），保留：

- `project`（按 cwd / repo，最重要）——某个项目里学到的规矩。
- `global`——跨项目通用。
- `runtime` 标签（`claude-code` / `opencode`）：可选，标记来源 / 适用 runtime；注入时按当前 runtime 过滤。

### 5.2 配套表

- `memory_distill_jobs`（提炼队列，照搬）。
- `memory_distill_events`（提炼回放，照搬）。

### 5.3 状态机

`candidate → approved → {archived | superseded | rejected}`

## 6. 采集

### 6.1 claude code（实体）

安装时往 `~/.claude/settings.json` 注册 hooks，指向 collector 本地 HTTP 端点：

- `Stop` / `SessionEnd`：推 `transcript_path`，collector 异步读 JSONL 还原对话。
- `PostToolUse`：失败时推「错误事件」（踩坑信号主来源之一）。
- `SubagentStop`：子 agent transcript（路径 `~/.claude/projects/<slug>/<sid>/subagents/*.jsonl`，借鉴 agent-workflow `sessionCapture.ts:5`）。

### 6.2 opencode（stub）

`OpencodeAdapter` 采集返回空。实体实现待后续迭代验证 opencode plugin 事件能力后补。退化方案（若 plugin 无事件钩子）：daemon 轮询 opencode 会话 SQLite。

### 6.3 错误信号混合识别

- **自动检测**（提炼器读 transcript 时识别模式）：工具调用失败、同目标反复重试、用户否定词（"不对 / 错了 / 撤销 / revert"）、用户中断、agent 自我修正。命中即作为踩坑信号加权送提炼。
- **用户显式标注**：claude code slash command `/mem-blame`（opencode 等价待验证），用户标记片段，必提炼、强信号。
- **混合**：两类都进队列，用户标注优先。

### 6.4 不阻塞保证（采集侧）

- hook 回调只「落队 + ack」，目标 <50ms，不读文件不调 LLM。
- 重活全在 daemon worker 异步。
- daemon 挂了不影响 CLI——hook 失败静默吞，不向 CLI 抛错。

## 7. 注入

### 7.1 claude code（实体）

`SessionStart` hook 在会话启动时调 collector 注入端点（带 cwd）：

1. 查 project（按 cwd / repo）+ global 的 approved 记忆，按 runtime 标签过滤：当前 runtime 专属记忆 + 无标签通用记忆都注入，他 runtime 专属的不注入。
2. token 预算 clip（照搬 agent-workflow `memoryInject.ts` 的 `clipByBudget` / `estimateTokens`：project 1500 + global 500，丢最旧）。
3. 渲染 `## Learned context (auto-injected, advisory)` + `--- BEGIN/END INJECTED MEMORY ---` 块（照搬 `formatMemoryBlock`）。全空返回 null（不注入，prompt 字节不变）。
4. hook 作为 `additionalContext` 返回，claude code 注入会话上下文。

per-session、动态、零文件污染（不碰用户的 `CLAUDE.md`）。记忆更新下次会话生效。

### 7.2 opencode（stub / 降级）

`OpencodeAdapter` 注入 no-op。后续验证 opencode plugin 启动注入点。三档退路：plugin 启动注入 → 独立 agent 文件 → skill 文件。最差降级：opencode 侧仅采集不注入（先把 opencode 对话学进记忆供 claude code 侧用）。

## 8. 提炼

- 直调 Anthropic API（不起子进程），从本机 claude code 配置读认证。
- system prompt 照搬 agent-workflow `DISTILLER_SYSTEM_PROMPT` 口味（`packages/backend/src/services/memoryDistiller.ts:83`）：偏爱业务 / 架构知识、`[category:xxx]` 前缀（domain-glossary / invariant / process / architecture / integration / compliance / data-semantics / anti-pattern / convention / quality-bar）、英文落档、原子可泛化。
- 输入：transcript 片段 + 错误信号标注（用户标注优先加权），clip 到源上下文预算（借鉴 `distillerSourceContext` 的 `clipHeadTail`）。
- 输出：结构化候选 JSON（`title / bodyMd / scope / category / distillAction`）。
- model 默认 Haiku（省钱，结构化抽取够用），可配。
- 候选以 `candidate` 落库，无跳过审批捷径。

## 9. 调度

照搬 agent-workflow `memoryDistillScheduler.ts`：

- 5s debounce 同源事件凑批。
- 1Hz worker，每 tick 最多 5 个 job。
- 失败指数退避（30s → 60s → 120s），3 次后永久 `failed`。
- 全程异步，不阻塞 CLI。

## 10. 审批状态机

照搬 agent-workflow `memory.ts`：

- 状态：`candidate → approved → {archived | superseded | rejected}`。
- 动作：`approve` / `approve_and_supersede`（替换旧记忆、version+1、旧的 superseded）/ `reject`；`patch`（原地编辑，仅实际变更 bump version）。
- promote → mark-superseded → broadcast 跑在同步事务（照搬 `dbTxSync`，保证原子）。
- WS 广播 Web UI 实时刷新（照搬 `memoryBroadcaster`）。
- 手动新建也是 candidate（照搬 `createManualCandidate`）。

## 11. 不阻塞保证 + 错误处理

- **全链降级**：任一环节失败 →「无记忆」，绝不让 CLI 卡住或报错。
- 采集失败：静默吞，下次会话补。
- 提炼失败：退避重试 → 3 次后 `failed` + `last_error`。
- 注入失败：返回 null，会话无记忆正常启动。
- 凭证读取失败：提炼跳过、job `failed`、Web UI 提示配凭证。
- 结构化日志（照搬 `createLogger`）。

## 12. 测试策略

- **纯函数优先断言**：`clipByBudget` / `formatMemoryBlock` / `estimateTokens` / 状态机转移 / 错误信号模式识别 / `distillAction` 去重。
- ClaudeCodeAdapter hook 接收 / 注入端点可 mock；提炼器 mock Anthropic API（借鉴 `memoryDistiller.ts` 的 `spawnFn` 注入模式）。
- **集成测试**：hook 回调 → 落队 → 提炼(mock) → candidate → 审批 → 注入返回块，端到端打通。
- **回归防护**：hook 回调超时阈值、daemon 挂时 hook 静默行为；注入块锚点 `--- BEGIN INJECTED MEMORY ---` 文本兜底断言。

## 13. 风险清单 + 验证计划

| # | 风险 | 影响 | 缓解 / 验证 |
|---|------|------|-----------|
| 1 | opencode hook / 注入能力未知 | opencode 实体实现 | MVP stub 规避；后续读 opencode 源码验证 |
| 2 | claude code 凭证存储位置未知 | 提炼无法调 API | 实现时验证 `~/.claude/` 读取方式（文件 / keychain） |
| 3 | claude code hooks 字段（`transcript_path` / `additionalContext`） | 采集 / 注入 | 实现时对照官方文档验证 |
| 4 | hook 回调 <50ms ack | 不阻塞 | ack 不读文件，实测确认 |
| 5 | hook 失败 / 超时 claude code 行为 | 不阻塞 | 确认不卡会话 |
| 6 | 隐私：对话发往 Anthropic API | 数据外发 | spec 明示，Web UI 首次提示；用户本就用 claude code 同 provider |

## 14. MVP 范围

- claude code 完整闭环：采集（hooks）→ 提炼（直调 API）→ 审批（Web UI）→ 注入（SessionStart hook）。
- opencode：RuntimeAdapter stub，采集返回空、注入 no-op。
- 存储 / 提炼 / 调度 / 审批照搬 RFC-041 已验证设计。
- 后续迭代：填 opencode 实体 adapter。

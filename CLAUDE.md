# CLAUDE.md

本文件给 Claude Code（claude.ai/code）提供 memside 仓库的工作指引。**所有规则强制执行**，违反不算个人风格选择，是产品级 bug。

## 仓库定位

memside 是 claude code 的**本地记忆 sidecar**：捕获会话 transcript → LLM 异步提炼成候选记忆 → 用户在 Web UI 审批 → 下次会话 `SessionStart` 时注入。核心闭环：**capture → distill → approve → inject**。

技术栈：Bun + Hono + Drizzle + bun:sqlite（WAL）+ zod + @anthropic-ai/sdk；前端 Vite + React 19。daemon 端口 `7777`，Web UI `5173`（vite dev，proxy `/api/`、`/inject`、`/hooks` 到 daemon）。

## 接手 session 的读取顺序

1. `STATE.md` — 构建状态、当前进度、遗留债务。**永远先读它**。
2. `docs/superpowers/specs/` — 设计 spec（brainstorming 产出）。
3. `docs/superpowers/plans/` — 任务计划（brainstorming 产出）。
5. `README.md` — 用户文档（快速开始 + 使用教程）。

## 开发流程（强制，不得跳步）

任何**新功能、非平凡重构、产品行为变更**，必须按下面四步顺序走，**不得边设计边写代码**。

### 1. 先走 superpowers brainstorming（强制）

新需求落到代码前，**必须先走 superpowers 的 brainstorming 流程**，产出两份落档文件：

- `docs/superpowers/specs/<YYYY-MM-DD>-<slug>-design.md` — 设计 spec：背景、目标 / 非目标、接口契约、数据流、与现有模块的耦合点、失败模式、测试策略。
- `docs/superpowers/plans/<YYYY-MM-DD>-<slug>.md` — 任务分解：编号子任务、依赖关系、验收清单。

> 判定原则：当你犹豫"这个改动要不要先 brainstorm"时，默认答案是"要"。常规改动也先想清楚再动手。

### 2. 分支 + PR（禁止直推 master）

**任何**改动——新需求、bug 修复、重构、文档 / 测试 / 配置改动，无论是否走 brainstorming——都按「从最新 `origin/master` 切新分支 → 推远端 → 开 PR 合并回 `master`」落地。**严禁直接在 `master` 上 commit 或向 `master` push。**

- **切分支**：开工前 `git fetch origin`，再 `git checkout -b <branch> origin/master`，保证基线最新；不要从过期的本地 `master` 切。
- **命名**：带前缀、含义清晰：`feat/...` / `fix/...` / `docs/...` / `test/...` / `chore/...`。
- **PR 目标**：`master`。commit 与 PR 标题按改动类型写。
- **合并后清理**：head 分支让 GitHub 合并时自动删；本地残留 `git branch -d <branch>`，过期 remote-tracking ref 用 `git fetch --prune`。

### 4. 测试随每次改动落地（强制）

**任何代码改动落 commit 前必须带对应测试**——既含新功能的正向 / 边界 / 错误路径覆盖，也含 bug 修复的回归防护。没有"先实现、之后补测试"这一档；测试用例是改动本身的一部分。

- **新功能**：实现的同时给正向 / 边界 / 错误路径写测试。spec 的「测试策略」列出哪些 case 必写，PR 必须把它们都跑绿才算交付。
- **bug 修复**：先写一个能稳定复现该 bug 的测试（红），再写修复（绿）。把"为什么这条测试存在"写进 test 文件顶端注释（链接 commit / spec），让未来 refactor 一旦把它变红能立刻看出意图。
- **首选可断言面**：抽出纯函数 / 纯数据预言（典型：`formatMemoryBlock` / `clipByBudget` / `canTransition` / `parseTranscriptFile`），在纯函数层写足测试，UI / daemon 运行时层只留少量集成断言。运行时巨型组件难直接覆盖时，**最低限度保留一条源代码层文本断言**兜底。
- **回归防护命名**：测试文件 / describe 标题应能让人一眼识别它锁的是哪类回归。
- **运行门槛**：`bun run typecheck && bun test` 必须全绿才能 push。
- **flaky 不能掩盖红 case**：发现某测试间歇性失败，先确认是不是真 bug；确属环境 / 时序的，要么修测试，要么显式注释标记并开 issue，**绝不允许"重跑就过了"作为通过依据**。
- **不写测试的极少数例外**：纯文档 / 注释改动、依赖版本号 bump（且 lock 文件锁住 minor）、配置微调。**任何触及生产代码或测试代码的改动都没有这个豁免。**

## 例外（免 brainstorming，不免分支 + PR）

拼写 / 单行 bug 修复 / 纯重命名 / 依赖升级 / 文档增删 / 测试补充 / 配置微调，可以直接改 + 提交，**免 brainstorming**。注意：免 brainstorming **不等于可以直推 `master`**——仍要走新分支 + PR。

## Web UI 改动

memside 的 Web UI（`src/web/`）目前是轻量自绘样式（inline style + 少量约定结构）。新增 / 改动界面时：

- **优先复用** `src/web/App.tsx` 里既有的样式风格与组件结构（`MemoryCard` 等），保持视觉与交互一致，不要为"快一点"引入新样式框架或重写既有 chrome。
- **状态可见性**：涉及后台异步（distill / scheduler / 事件捕获）的改动，UI 必须让用户**感知后台状态**——参考 `GET /api/status` + 顶部状态栏（已捕获事件 / distill 进行中 / 记忆计数 / 最近错误）。**不得静默 stall 出空白页**：fetch 失败要显示错误横幅，加载中要显示进度，不得让用户对着空 UI 猜后台在不在跑。
- **vite proxy 陷阱**：`vite.config.ts` 的 proxy 键用 `/api/`（带尾斜杠）而非 `/api`——后者会把 `App.tsx` 的 `import './api'`（即 `/api.ts` 模块请求）也转发给 daemon 而 404，导致整个模块图断裂、白屏。新增 proxy 前缀时同理避免与源码模块路径冲突。

## opencode / claude code 行为以源码为准

涉及 claude code hooks 协议（`SessionStart` / `Stop` / `PostToolUse` / `SubagentStop` 的 stdin payload、`transcript_path`、`hookSpecificOutput.additionalContext` envelope、`is_error` 字段）或 opencode 进程行为（启动参数、`OPENCODE_*` 环境变量、`.opencode/` 扫描合并顺序、输出 XML envelope）的判断，**不靠记忆，主动 grep / 读源码验证**，回复里**引用具体文件:行号**让用户能追溯。claude code / opencode 版本升级后旧假设可能失效，上手前先复核再继续，避免基于过期假设写代码。

## 常用命令

```bash
bun install                  # 装依赖
bun run src/cli.ts start     # 启 daemon（端口 7777）
bun run dev:web              # 启 Web UI（端口 5173，另开终端）
bun test                     # 跑测试
bun run typecheck            # tsc --noEmit 类型检查
```

daemon 端口可用 `MEMSIDE_PORT` env 覆盖。distiller 走 `~/.claude/settings.json` 里的 `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL` / `ANTHROPIC_DEFAULT_HAIKU_MODEL`（Volcengine Ark 代理），loopback 请求要排除代理（`NO_PROXY=127.0.0.1,localhost`，hook curl 用 `--noproxy`）。

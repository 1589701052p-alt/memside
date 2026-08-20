# memside

AI agent（Claude Code / opencode）的本地记忆 sidecar。它监听你的 AI agent 会话，把反复出现的经验教训、踩过的坑、团队约定提炼成简洁的记忆条目，经你在 Web UI 审批后，在未来的会话里自动注入——全程不阻塞你的工作。

```
   claude code 会话
        │  hooks（SessionStart / Stop / PostToolUse / SubagentStop / SessionEnd）
        ▼
   ┌───────────┐  capture     ┌──────────┐  distill    ┌──────────┐
   │ collector │ ───────────▶ │ sqlite DB │ ──────────▶ │   LLM    │
   │  (<50ms)  │   transcript │  (WAL)    │  transcript │ (haiku)  │
   └───────────┘              └──────────┘              └──────────┘
                                                          │ 候选记忆
                                           审批           ▼
   新会话 ◀── additionalContext ◀── web UI  ◀── memory store
```

**非阻塞。** 每个 hook 在 50ms 内 ack——读 transcript、写 DB、调 LLM 提炼全在后台 fire-and-forget。daemon 挂了，hook 2s 超时后会话照常继续。

**你掌控。** 没在 Web UI 审批的条目绝不注入。被 reject 的不会再被提炼。

---

<img width="1051" height="1067" alt="屏幕截图 2026-08-17 175514" src="https://github.com/user-attachments/assets/efbbb22f-65f4-4e32-b2ea-9b7bd76bd746" />

---

## 安装

三种方式，**选一种**即可。装好后都得到同一个命令 `memside`，使用方式完全一样。

### 方式 A：Windows 安装器（推荐，最省事）

1. 去 [Releases 页](https://github.com/1589701052p-alt/memside/releases) 下载最新的 `memside-setup-<版本号>.exe`（如 `memside-setup-0.4.0.exe`）。
2. 双击安装（per-user，**不需要管理员权限**）。安装器会创建开始菜单和桌面快捷方式，并把 `memside` 加入 PATH。
3. 双击桌面/开始菜单的 `memside` 快捷方式启动。

> 首次双击未签名的 exe，Windows 会弹"已保护你的电脑"（SmartScreen）。点 **"更多信息"** → **"仍运行"** 即可。这是 v1 未签名的正常现象，后续版本会评估代码签名。
>
> **升级**：下载新版本的 `memside-setup-<版本号>.exe` 直接运行即可。安装器会自动识别上次的安装目录（在跑的旧 daemon 会被先结束，数据不受影响）。

<details>
<summary>不想装安装器？直接用便携 exe</summary>

Releases 页另有一个 `memside-<版本号>.exe`（如 `memside-0.4.0.exe`），是内嵌 Bun 运行时 + 前端 + opencode 插件的**单文件绿色二进制**，不写 PATH、不动注册表、不留卸载项。

1. 去 [Releases 页](https://github.com/1589701052p-alt/memside/releases) 下载 `memside-<版本号>.exe`，放任意目录（桌面、U 盘都行；下载后随意改名，不影响使用）。
2. 双击运行。它等价于 `start-and-install`：自动启动 daemon **并** 装 claude code hooks **并** 装 opencode 插件——一次搞定。
3. 看到 `memside on http://127.0.0.1:7777 ...` 就说明在跑了。**保持那个窗口开着**，daemon 跟着窗口活；关窗即停。

和安装器版的区别：

- **无 PATH / 无快捷方式**，每次开机想用就再双击一次 `memside.exe`。
- **关窗口即停 daemon**。要让它常驻，别关那个控制台窗口（或开个终端跑）。
- hooks 是 `curl` 调 `127.0.0.1:7777`，**不依赖 exe 路径**——所以之后移动 / 重命名 `memside.exe` 不影响已装的 hooks，只要 daemon 还在跑。

</details>

### 方式 B：npm（跨平台，需先装 [Bun](https://bun.sh)）

```bash
bunx @memside-h/memside start-and-install
```

或全局安装后直接用 `memside`：

```bash
npm i -g @memside-h/memside
memside start-and-install
```

> npm 包名是 `@memside-h/memside`（scoped），但装后的命令名是 `memside`。memside 用了 `bun:sqlite`（Bun 专有），**必须跑在 Bun 上**，纯 Node 不行——所以先装 Bun，再用 `bunx` 最稳。

### 方式 C：从源码（开发者）

```bash
git clone https://github.com/1589701052p-alt/memside.git && cd memside
bun install
bun run start   # 构建前端 + 启动 daemon + 装 hooks
```

> 想保留前端热更新开发，用 `bun run dev`（daemon:7777 + vite dev:5173 双进程）。

---

## 装好了，怎么用（5 步走一遍）

无论上面哪种方式装的，启动后都会看到：

```
memside on http://127.0.0.1:7777 (UI + API, hooks installed)
```

看到这行就对了：daemon 在跑、hooks 已装、Web UI 已托管。

### 第 1 步：打开 Web UI

浏览器开 `http://localhost:7777`。此时审批队列是空的——还没有候选记忆。

### 第 2 步：用 Claude Code 聊点"值得记住"的事

在任意目录开一个 Claude Code 会话，聊点带约定/规则/教训的内容，比如：

> 你：我们项目的约定是，每个 PR 必须在 CHANGELOG.md 的 "Unreleased" 部分加一条。

让 claude 回一句确认，然后**正常结束会话**（输入 exit 或 Ctrl+C）。

会话结束时 `Stop` hook 触发，memside 在后台把这次对话的 transcript 抓走、送去 LLM 提炼。

### 第 3 步：等 ~30 秒，回 Web UI 看候选记忆

distill 是后台异步的。稍等片刻刷新 Web UI，会出现一条候选记忆，类似：

> `[category:convention] 每个 PR 必须在 CHANGELOG.md 的"Unreleased"部分添加条目`

如果聊的是踩坑（比如工具报错、你纠正了 claude），会标成 `[category:anti-pattern]`。

### 第 4 步：审批

在 Web UI 里：

- 觉得有用 → 点 **approve**（进入注入池）
- 觉得是噪音 → 点 **reject**（不会再出现）
- 想改措辞 → 点 **edit** 改 title/bodyMd 后保存，再 approve

### 第 5 步：开新会话，验证注入

在**同一个目录**开一个新的 Claude Code 会话。`SessionStart` hook 会把刚 approve 的记忆作为 `additionalContext` 注入。会话的 context 开头会有：

```
## Learned context (auto-injected, advisory)

The following items were distilled from past sessions and approved by you...
--- BEGIN INJECTED MEMORY ---
- [project] [category:convention] 每个 PR 必须在 CHANGELOG.md 的"Unreleased"部分添加条目 - ...
--- END INJECTED MEMORY ---
```

claude 会把它当成软约定参考。（注：这是注入到 context 里的，claude 不一定每次都在回复里提它——但它在 context 里，claude 看得见。）

走到这里你就掌握了日常循环。下面是日常用法和命令说明。

---

## 日常使用

会话结束 → 后台提炼出候选记忆 → Web UI 审批 → 下次开会话自动注入。就这一个循环，不用刻意操作。

- **project 记忆**：绑到你开会话时的 cwd，只在该项目注入。
- **global 记忆**：在所有会话注入（在 Web UI 手动创建记忆时可选 global）。
- **错误信号**：工具失败（`PostToolUse` + `is_error`）、你纠正 claude，会被标成 `[category:anti-pattern]`，下次避免重蹈覆辙。
- **回收站**：删除的记忆进回收站，可恢复；清空回收站后才真正不可恢复。还支持记忆的**批量删除 / 批量导出 / 导入**（memside JSON 高保真 + Markdown 低保真两种格式）。
- **后台状态可见**：顶部状态栏实时显示 LLM 三阶段进展与近 24h 统计；蒸馏 LLM 报错 / 降级会以状态栏警示条提醒（点击跳「消息」tab 逐条处理，已读即消失），连续相同内容的通知只保留一条、不刷屏。

## 命令

`memside` 有三个子命令（exe / npm 全局装后直接敲 `memside`；源码方式用 `bun run src/cli.ts` 代替）：

| 命令 | 作用 |
|---|---|
| `start` | 只启动 daemon（HTTP server + 后台提炼循环），不碰 hooks |
| `install` | 只装 hooks 到 `~/.claude/settings.json`（幂等，可重复跑），不启 daemon |
| `start-and-install` | 两者都做（**首次使用推荐**） |

- daemon 必须持续运行，否则装的 hooks 每次会吃满 2s 超时拖慢你的 claude code 会话。
- 重新跑 `install` 会替换旧的 memside hook 条目（按 `x-memside-tag` 标记识别），不影响你自己写的其他 hook。
- 端口用 `MEMSIDE_PORT` 环境变量改（默认 7777）。
- 源码方式的 `bun run start` 等价于 `start-and-install` + 构建前端（每次自动跑 `vite build`）。

### opencode 支持

memside 同时支持 **Claude Code** 和 **opencode**。`start-and-install` 会自动安装 opencode 插件（写入 `~/.config/opencode/opencode.json`），无需额外操作。

- **捕获**：opencode 会话空闲时自动把消息发给 memside 提炼。
- **注入**：opencode 新会话自动注入已审批记忆。
- **跨 runtime 共享**：project 记忆在 claude code 和 opencode 间共享——用 opencode 开会话也能看到同一项目下的记忆块。
- **Web UI**：记忆卡片会标注来源 runtime（`claude-code` / `opencode`）。

## 验证安装（可选）

想确认整个链路真的通了，跑自动化验证脚本（用临时 DB，不碰你的真实数据）：

```bash
bun run demo.ts
```

它会自动走一遍 capture → distill → approve → inject 全流程，最后打印 `N/N steps passed` 就说明安装没问题。约 1-2 分钟（主要是 LLM 提炼耗时）。这只是安装自检，**日常使用不需要跑它**。

## 前提

- **[Bun](https://bun.sh) ≥ 1.3**。方式 A（exe）已内嵌 Bun 运行时，无需另装；方式 B / C 需自行安装。
- **Claude Code**（CLI）。
- **LLM 凭证**：
  - **Anthropic API key**
  - **OpenAI 兼容 API**

memside 直接读 Claude Code 自己的 settings，所以 **Claude Code 能跑，distiller 就能用同一套凭证**。

后端选择：有 `OPENAI_API_KEY` 时自动用 OpenAI 后端，否则用 Anthropic；可用 `MEMSIDE_LLM_BACKEND=anthropic|openai` 显式覆盖。

## 配置参考

| 环境变量 / 来源 | 默认值 | 用途 |
|---|---|---|
| `MEMSIDE_PORT` | `7777` | daemon HTTP 端口（hooks + Web UI） |
| `~/.claude/settings.json` 的 `env` | - | `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL` / `ANTHROPIC_DEFAULT_HAIKU_MODEL`（代理模式） |
| `ANTHROPIC_API_KEY` | - | 官方 Anthropic key（优先级高于 settings.json） |
| `OPENAI_API_KEY` | - | OpenAI 兼容后端的 API key（设了即自动启用 OpenAI 后端） |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | OpenAI 兼容端点（内部代理填这里） |
| `OPENAI_MODEL` | - | OpenAI 后端模型名（必配，无默认） |
| `MEMSIDE_LLM_BACKEND` | 自动 | 显式 `anthropic` / `openai` 覆盖自动选择 |
| `~/.memside/memside.db` | - | 记忆数据库（WAL 模式，卸载保留） |
| `~/.claude/settings.json` 的 `hooks` | - | 5 个 collector hook 装在这 |

## 故障排查

**hook / demo 返回 `502 Bad Gateway`。** 系统代理拦截了 loopback 调用。装的 hook 已自带 `--noproxy` 绕过；跑 demo 或手动 `curl` 要前置 `NO_PROXY=127.0.0.1,localhost`。

**会话变慢/卡顿。** daemon 没跑，每个 hook 都吃满 2s 超时。启动它：`memside start-and-install`（或源码 `bun run start`）。确认存活：`curl -s http://127.0.0.1:7777/api/memories`。

**启动报 `EADDRINUSE` / 端口被占。** 上一次 dev/start 未正常退出留了孤儿进程。`bun run start` / `bun run dev` 会在启动前检测端口占用，列出占用进程的 PID 和命令行并询问是否杀掉；非交互环境（管道/CI）直接退出，需手动回收：

```bash
netstat -ano | findstr :7777      # Windows，拿 PID
taskkill /PID <pid> /F            # cmd / PowerShell；Git Bash 下用 //PID //F
# 或 posix:
lsof -ti:7777 | xargs kill -9
```

**没有候选记忆产出。** distiller 调不通 LLM。查 `~/.memside/memside.db` 里 `memory_distill_jobs.last_error`，确认凭证可用（claude code 自己能跑是个好信号）。常见原因：`ANTHROPIC_DEFAULT_HAIKU_MODEL` 的 model id 在你的代理上不可达——换成代理支持的 haiku 档 model。

**拒绝过的记忆又出现了。** 不应该——rejected 的条目保持 rejected。如果出现，提 issue。

**停掉后台任务后 daemon 进程残留。** Windows 上杀 background task 可能留下 bun 进程占 7777。回收：`netstat -ano | findstr :7777` 拿到 PID，再 `taskkill /PID <pid> /F`（cmd / PowerShell；Git Bash 下用 `//PID //F`）。

**卸载后想彻底清理。** 卸载只删程序，**保留** `~/.memside`（记忆库）、`~/.claude/settings.json` 里的 hooks、`~/.config/opencode`（插件）。如需彻底清理，手动删 `~/.memside` 目录，并从 `~/.claude/settings.json` 删带 `memside-managed` 标记的 hook 条目。

## 开发

```bash
bun install
bun run dev           # daemon(7777) + vite dev(5173) 双进程
bun test              # 测试套件
bun run typecheck     # tsc --noEmit
```

代码库 TDD 驱动，每个 fix 都带回归测试。构建状态见 `STATE.md`。

**发版**：改 `package.json` 版本号 → 走 PR 合入 master → 打 `v*` tag 推送触发 GitHub Actions（`.github/workflows/release.yml`）——windows job 产 `memside-<版本号>.exe` + `memside-setup-<版本号>.exe`（版本号取自 `package.json`，产物名自动带上）挂 GitHub Release，ubuntu job `npm publish`。

## 已知限制

- **无实时 WS 推送。** Web UI 轮询 `/api/memories`；`/ws/memories` 广播 seam 已预留但未接。
- **单用户、本地。** 无鉴权、无多用户。
- **注入是 advisory。** 记忆块作为软上下文前置；模型不一定每次都在回复里体现（但会话 transcript 里一定有）。
- **仅 Windows exe。** macOS / Linux 用户走 npm 方式（exe 跨平台编译留后续）。

## 底层原理

- **Capture。** Claude Code 把每个 hook 的 JSON payload（含 `transcript_path`，一个 JSONL 文件路径）通过 `curl -d @-` 喂给 collector。`src/claude/transcript.ts` 把 JSONL 解析成结构化 turn（user prompt、assistant text、带 `is_error` 的 tool result）。collector 立即返回 202，在 fire-and-forget IIFE 里把 turns 持久化到 `memory_distill_events`。
- **Distill。** 1Hz scheduler tick（`src/scheduler.ts`）取 pending job，加载 turns，用带分类感知的 system prompt 调 LLM（`src/memory/distiller.ts`）。JSON 响应变成 `candidate` 记忆。debounce（5s）+ 指数退避应对突发和 LLM 瞬时失败。title/bodyMd 用简体中文（`[category:xxx]` 前缀保持英文）。蒸馏按会话级攒量：同一 session 多次 capture 累加一个任务，内容量达阈值（或会话结束 / 闲置超 2 小时）才调 LLM 提炼；琐碎内容自动跳过并记入蒸馏记录。
- **Approve。** Web UI 调 `POST /api/memories/:id/promote`，body `{action:'approve'|'reject'|'approve_and_supersede'}`。状态转换用 specific-source 检查（不是通用的 `canTransition`），archived 条目不能被静默重新 approve。
- **Inject。** `SessionStart` 调 `adapter.inject({cwd})`，按 project + runtime 查 approved 记忆，按 token 预算裁剪（project 1500 / global 500），渲染 markdown 块，包成 `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":...}}` 返回——这正是 Claude Code 从 hook stdout 读的 envelope。

## License

MIT

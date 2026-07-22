# memside

[claude code](https://claude.com/claude-code) 的本地记忆 sidecar。它监听你的 claude code 会话,把反复出现的经验教训、踩过的坑、团队约定提炼成简洁的记忆条目,经你 web UI 审批后,在未来的会话里自动注入--全程不阻塞你的工作。

```
   claude code 会话
        │  hooks (SessionStart / Stop / PostToolUse / SubagentStop)
        ▼
   ┌───────────┐  capture     ┌──────────┐  distill    ┌──────────┐
   │ collector │ ───────────▶ │ sqlite DB │ ──────────▶ │   LLM    │
   │  (<50ms)  │   transcript │  (WAL)    │  transcript │ (haiku)  │
   └───────────┘              └──────────┘              └──────────┘
                                                          │ 候选记忆
                                           审批           ▼
   新会话 ◀── additionalContext ◀── web UI  ◀── memory store
```

**非阻塞。** 每个 hook 在 50ms 内 ack--读 transcript、写 DB、调 LLM 提炼全在后台 fire-and-forget。daemon 挂了,hook 2s 超时后会话照常继续。

**你掌控。** 没在 web UI 审批的条目绝不注入。被 reject 的不会再被提炼。

---

## 快速开始

```bash
git clone <this-repo> memside && cd memside
bun install

# 启动 daemon + 装 claude code hooks(每台机器一次)
bun run src/cli.ts start-and-install

# 起 web UI(另开一个终端)
bun run dev:web   # -> http://localhost:5173
```

跑完上面三步,memside 就在后台工作了。然后**正常用 claude code**即可--不用改你的使用习惯。

> 上面的 `bun run src/cli.ts <命令>` 是 clone 后直接就能用的方式。如果你执行过 `bun link`,也可以用全局命令 `memside <命令>`,两者完全等价(见下面 [CLI 命令](#cli-命令))。本文统一用 `bun run src/cli.ts`,省去 link 步骤。

---

## 使用教程(第一次用,跟着做一遍)

这一节手把手带你走完一次完整循环:**产生记忆 → 审批 → 下次自动注入**。花 2 分钟走一遍,你就懂日常怎么用了。

### 第 1 步:确认 daemon 在跑 + hooks 已装

```bash
bun run src/cli.ts start-and-install
```

输出 `memside daemon on http://127.0.0.1:7777 (hooks installed)` 就对了。如果提示端口占用,说明 daemon 已经在跑了,改用 `bun run src/cli.ts install` 只补装 hooks 即可。

### 第 2 步:打开 web UI

```bash
bun run dev:web
```

浏览器开 `http://localhost:5173`。此时审批队列是空的--还没有候选记忆。

### 第 3 步:用 claude code 聊点"值得记住"的事

在**任意 repo** 开一个 claude code 会话,聊点带约定/规则/教训的内容,比如:

> 你:我们项目的约定是,每个 PR 必须在 CHANGELOG.md 的 "Unreleased" 部分加一条。

让 claude 回一句确认,然后**正常结束会话**(输入 exit 或 Ctrl+C)。

会话结束时 `Stop` hook 触发,memside 在后台把这次对话的 transcript 抓走、送去 LLM 提炼。

### 第 4 步:等 ~30 秒,回 web UI 看候选记忆

distill 是后台异步的(debounce 5s + LLM 往返 ~15-30s)。稍等片刻刷新 web UI,会出现一条候选记忆,类似:

> `[category:convention] 每个 PR 必须在 CHANGELOG.md 的"Unreleased"部分添加条目`

如果聊的是踩坑(比如工具报错、你纠正了 claude),会标成 `[category:anti-pattern]`。

### 第 5 步:审批

在 web UI 里:
- 觉得有用 → 点 **approve**(进入注入池)
- 觉得是噪音 → 点 **reject**(不会再出现)
- 想改措辞 → 点 **edit** 改 title/bodyMd 后保存,再 approve

### 第 6 步:开新会话,验证注入

在**同一个 repo** 开一个新的 claude code 会话。`SessionStart` hook 会把刚 approve 的记忆作为 `additionalContext` 注入。会话的 context 开头会有:

```
## Learned context (auto-injected, advisory)

The following items were distilled from past sessions and approved by you...
--- BEGIN INJECTED MEMORY ---
- [project] [category:convention] 每个 PR 必须在 CHANGELOG.md 的"Unreleased"部分添加条目 - ...
--- END INJECTED MEMORY ---
```

claude 会把它当成软约定参考。(注:这是注入到 context 里的,claude 不一定每次都在回复里提它--但它在 context 里,claude 看得见。)

---

走到这里你就掌握了日常循环。下面是简化的日常用法和命令说明。

## 日常使用

会话结束 → 后台提炼出候选记忆 → web UI 审批 → 下次开会话自动注入。就这一个循环,不用刻意操作。

- **project 记忆**:绑到你开会话时的 cwd,只在该项目注入。
- **global 记忆**:在所有会话注入(在 web UI 手动创建记忆时可选 global)。
- **错误信号**:工具失败(`PostToolUse` + `is_error`)、你纠正 claude,会被标成 `[category:anti-pattern]`,下次避免重蹈覆辙。

## CLI 命令

memside 的所有命令都通过 `src/cli.ts` 入口跑。clone 后直接用 `bun run src/cli.ts <命令>`;执行过 `bun link` 后也能用全局的 `memside <命令>`。两者等价。

| 命令 | 作用 |
|---|---|
| `start` | 只启动 daemon(HTTP server + 后台提炼循环),不碰 claude code hooks |
| `install` | 只把四个 hook 写进 `~/.claude/settings.json`(幂等,可重复跑),不启 daemon |
| `start-and-install` | 两者都做(首次使用推荐) |

- daemon 必须持续运行,否则装的 hooks 每次会吃满 2s 超时拖慢你的 claude code 会话。
- 重新跑 `install` 会替换旧的 memside hook 条目(按 `x-memside-tag` 标记识别),不影响你自己写的其他 hook。
- 端口用 `MEMSIDE_PORT` 环境变量改(默认 7777)。

## 验证安装(可选)

想确认整个链路真的通了,跑自动化验证脚本(用临时 DB,不碰你的真实数据):

```bash
NO_PROXY=127.0.0.1,localhost bun run demo.ts
```

它会自动走一遍 capture → distill → approve → inject 全流程,最后打印 `9/9 steps passed` 就说明安装没问题。约 1-2 分钟(主要是 LLM 提炼耗时)。这只是安装自检,**日常使用不需要跑它**。

## 前提

- [Bun](https://bun.sh) ≥ 1.3
- claude code(CLI)
- LLM 凭证,**二选一**:
  - **火山引擎 Ark / 其他 Anthropic 兼容代理**,配在 `~/.claude/settings.json`(`ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL` + `ANTHROPIC_DEFAULT_HAIKU_MODEL`),或
  - **官方 Anthropic API key**,设 `ANTHROPIC_API_KEY`(distiller 调 `api.anthropic.com` + `claude-haiku-4-5-20251001`)。

memside 直接读 claude code 自己的 settings,所以 claude code 能跑,distiller 就能用同一套凭证。

## 配置参考

| 环境变量 / 来源 | 默认值 | 用途 |
|---|---|---|
| `MEMSIDE_PORT` | `7777` | daemon HTTP 端口(hooks + web UI 代理目标) |
| `~/.claude/settings.json` 的 `env` | - | `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL` / `ANTHROPIC_DEFAULT_HAIKU_MODEL`(代理模式) |
| `ANTHROPIC_API_KEY` | - | 官方 Anthropic key(优先级高于 settings.json) |
| `~/.memside/memside.db` | - | 记忆数据库(WAL 模式) |
| `~/.claude/settings.json` 的 `hooks` | - | 四个 collector hook 装在这 |

## 故障排查

**hook / demo 返回 `502 Bad Gateway`。** 系统代理拦截了 loopback 调用。装的 hook 已自带 `--noproxy` 绕过;跑 demo 或手动 `curl` 要前置 `NO_PROXY=127.0.0.1,localhost`。

**会话变慢/卡顿。** daemon 没跑,每个 hook 都吃满 2s 超时。启动它:`bun run src/cli.ts start`(或 `start-and-install`)。确认存活:`curl -s http://127.0.0.1:7777/api/memories`。

**没有候选记忆产出。** distiller 调不通 LLM。查 `~/.memside/memside.db` 里 `memory_distill_jobs.last_error`,确认凭证可用(claude code 自己能跑是个好信号)。常见原因:`ANTHROPIC_DEFAULT_HAIKU_MODEL` 的 model id 在你的代理上不可达--换成代理支持的 haiku 档 model。

**拒绝过的记忆又出现了。** 不应该--rejected 的条目保持 rejected。如果出现,提 issue。

**停掉后台任务后 daemon 进程残留。** Windows 上杀 background task 可能留下 bun 进程占 7777。回收:`netstat -ano | findstr :7777` 拿到 PID,再 `taskkill //PID <pid> //F`。

## 开发

```bash
bun test              # 100 个测试
bun run typecheck     # tsc --noEmit
bun run dev:web       # vite dev server(5173,代理到 :7777)
```

代码库 TDD 驱动,每个 fix 都带回归测试。构建状态见 `STATE.md`。memside 的存储、distiller、审批状态机借鉴自上游 agent-workflow 项目的 RFC-041。

## 已知限制(MVP)

- **仅 claude code。** opencode adapter 是 stub(`src/adapter/opencode.ts`);MVP 没接 opencode 的 hook / 注入。
- **无 archive / unarchive UI。** store 实现了 `archiveMemory` / `unarchiveMemory`(且有单测),但没暴露 HTTP 路由或 web UI 按钮。approved 条目可 reject/edit,但不能从 UI archive。需要的话直接调 store API。
- **无实时 WS 推送。** web UI 轮询 `/api/memories`;`/ws/memories` 广播 seam 已预留但未接。
- **单用户、本地。** 无鉴权、无多用户。
- **注入是 advisory。** 记忆块作为软上下文前置;模型不一定每次都在回复里体现(但会话 transcript 里一定有)。

## 底层原理

- **Capture。** claude code 把每个 hook 的 JSON payload(含 `transcript_path`,一个 JSONL 文件路径)通过 `curl -d @-` 喂给 collector。`src/claude/transcript.ts` 把 JSONL 解析成结构化 turn(user prompt、assistant text、带 `is_error` 的 tool result)。collector 立即返回 202,在 fire-and-forget IIFE 里把 turns 持久化到 `memory_distill_events`。
- **Distill。** 1Hz scheduler tick(`src/scheduler.ts`)取 pending job,加载 turns,用带分类感知的 system prompt 调 LLM(`src/memory/distiller.ts`)。JSON 响应变成 `candidate` 记忆。debounce(5s)+ 指数退避应对突发和 LLM 瞬时失败。title/bodyMd 用简体中文(`[category:xxx]` 前缀保持英文)。
- **Approve。** web UI 调 `POST /api/memories/:id/promote`,body `{action:'approve'|'reject'|'approve_and_supersede'}`。状态转换用 specific-source 检查(不是通用的 `canTransition`),archived 条目不能被静默重新 approve。
- **Inject。** `SessionStart` 调 `adapter.inject({cwd})`,按 project + runtime 查 approved 记忆,按 token 预算裁剪(project 1500 / global 500),渲染 markdown 块,包成 `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":...}}` 返回--这正是 claude code 从 hook stdout 读的 envelope。

## License

Private / WIP.

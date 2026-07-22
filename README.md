# memside

[claude code](https://claude.com/claude-code) 的本地记忆 sidecar。它监听你的 claude code 会话,把反复出现的经验教训、踩过的坑、团队约定提炼成简洁的记忆条目,通过 web UI 让你审批后,在未来的会话里自动注入--全程不阻塞你的工作。

```
   claude code 会话
        │  hooks (SessionStart / Stop / PostToolUse / SubagentStop)
        ▼
   ┌───────────┐  capture     ┌──────────┐  distill    ┌──────────┐
   │ collector │ ───────────▶ │ sqlite DB │ ──────────▶ │   LLM    │
   │  (<50ms)  │   transcript │  (WAL)    │  transcript │ (haiku)  │
   └───────────┘              └──────────┘              └──────────┘
                                                          │ candidates
                                           approve        ▼
   新会话 ◀── additionalContext ◀── web UI  ◀── memory store
```

**非阻塞设计。** 每个 hook 在 50ms 内 ack--transcript 读取、DB 写入、LLM 提炼全在 fire-and-forget 后台循环里。daemon 挂了,hook 2s 超时后会话照常继续。

**你始终掌控。** 没在 web UI 审批通过的条目绝不注入。被拒绝的条目不会再被提炼。

## 快速开始

```bash
git clone <this-repo> memside && cd memside
bun install

# 1. 启动 daemon 并装 claude code hooks(每台机器一次)
bun run src/cli.ts start-and-install

# 2. 跑功能 demo(用真实 LLM 验证整个闭环)
NO_PROXY=127.0.0.1,localhost bun run demo.ts

# 3. 起 web UI(另开一个终端)
bun run dev:web   # -> http://localhost:5173
```

demo 打印 `9/9 steps passed` 就说明 memside 全链路打通了。然后正常用 claude code 即可--会话结束时 `Stop` hook 触发 capture,工具报错时 `PostToolUse` 触发 error-signal capture,都在后台提炼成候选记忆;去 web UI 审批;下次开会话自动注入。

> **代理环境注意**:如果你挂着系统代理(`HTTP_PROXY`/`HTTPS_PROXY`,如 clash/v2ray 在 `:7897`),装的 hook 命令已自带 `--noproxy 127.0.0.1,localhost`,loopback 调用自动绕过代理。只有跑 demo / `smoke-live.ts` / 手动 `curl` 时需要前置 `NO_PROXY=127.0.0.1,localhost`(因为这些走 Bun 的 `fetch`,会读代理环境变量)。distill 调 LLM 仍走 `HTTPS_PROXY`。

## 前提

- [Bun](https://bun.sh) ≥ 1.3
- claude code(CLI)
- LLM 凭证--**二选一**:
  - **火山引擎 Ark / 其他 Anthropic 兼容代理**,配在 `~/.claude/settings.json`(`ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL` + `ANTHROPIC_DEFAULT_HAIKU_MODEL`),或
  - **官方 Anthropic API key**,设 `ANTHROPIC_API_KEY`(distiller 调 `api.anthropic.com` + `claude-haiku-4-5-20251001`)。

memside 直接读 claude code 自己的 settings,所以 claude code 能跑,distiller 就能用同一套凭证跑。

## 日常使用

1. **正常用 claude code**(任意 repo)。会话 stop 时 `Stop` hook 触发 -> transcript 被 capture 并在后台提炼。工具失败触发 `PostToolUse` -> error-signal capture。
2. **在 web UI 审批**(`bun run dev:web` -> `http://localhost:5173`)。approve 值得保留的,reject 噪音,编辑 title/bodyMd。
3. **开下一个会话** -> `SessionStart` 触发 -> 当前 project 的 approved 记忆(加 globals)作为 `additionalContext` 注入。会话开头会出现 `## Learned context (auto-injected, advisory)` 块。

记忆条目按 scope 分:
- **project** -- 绑定到某个 cwd,只在该项目注入。
- **global** -- 在所有会话注入。

distiller 用**简体中文**输出 title 和 bodyMd(保留 `[category:xxx]` 英文前缀)。示例:
- `[category:convention] 每个 PR 必须在 CHANGELOG.md 的"Unreleased"部分添加条目`
- `[category:anti-pattern] 运行测试前应检查项目使用的测试运行器,不要假定是 bun`

## Demo

`demo.ts` 用**临时 DB** + 你的真实 LLM 跑全功能矩阵,不碰 `~/.memside/memside.db`:

```bash
NO_PROXY=127.0.0.1,localhost bun run demo.ts
```

覆盖:conversation capture -> error-signal capture -> distill -> list -> approve -> reject -> edit(PATCH)-> inject(SessionStart envelope)-> manual candidate -> global 注入。预期 `9/9 steps passed`,约 1-2 分钟(主要是 LLM 提炼往返)。

另有 `smoke-live.ts`--更窄的端到端 smoke(capture -> distill -> approve -> inject),可作快速健康检查。

## 配置参考

| 环境变量 / 来源 | 默认值 | 用途 |
|---|---|---|
| `MEMSIDE_PORT` | `7777` | daemon HTTP 端口(hooks + web UI 代理目标) |
| `~/.claude/settings.json` 的 `env` | - | `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL` / `ANTHROPIC_DEFAULT_HAIKU_MODEL`(代理模式) |
| `ANTHROPIC_API_KEY` | - | 官方 Anthropic key(优先级高于 settings.json) |
| `~/.memside/memside.db` | - | 记忆数据库(WAL 模式) |
| `~/.claude/settings.json` 的 `hooks` | - | 四个 collector hook 装在这 |

### CLI 命令

```bash
memside start             # 只启动 daemon(不装 hooks)
memside install           # 只装 claude code hooks(不启 daemon)
memside start-and-install # 两者都做
```

(没 `bun link` 的话,`bun run src/cli.ts <cmd>` 一样。)

## 故障排查

**hook / demo 返回 `502 Bad Gateway`。** 系统代理拦截了 loopback 调用。装的 hook 已自带 `--noproxy` 绕过;demo 或手动 `curl` 要前置 `NO_PROXY=127.0.0.1,localhost`。

**会话变慢/卡顿。** daemon 没跑,每个 hook 都吃满 2s `--max-time` 超时。启动它:`bun run src/cli.ts start`(或 `start-and-install`)。确认存活:`curl -s http://127.0.0.1:7777/api/memories`。

**没有 candidate 产出。** distiller 调不通 LLM。查 `~/.memside/memside.db` 里 `memory_distill_jobs.last_error`,确认凭证可用(claude code 自己能跑是个好信号)。常见原因:`ANTHROPIC_DEFAULT_HAIKU_MODEL` 的 model id 在你的代理上不可达--换成代理支持的 haiku 档 model。

**拒绝过的记忆又出现了。** 不应该--rejected 的条目会保持 rejected。如果出现,提 issue;去重以提炼后的内容为 key。

**停掉后台任务后 daemon 进程残留。** Windows 上杀 background task 可能留下 bun 进程占着 7777。回收:`netstat -ano | findstr :7777` -> `taskkill //PID <pid> //F`。

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
- **单用户、本地。** 无鉴权、无多用户--memside 跑在你本机,服务你自己的 claude code 会话。
- **注入是 advisory。** 记忆块作为软上下文前置;模型不一定每次都在回复里体现(但会话 transcript 里一定有)。

## 底层原理

- **Capture。** claude code 把每个 hook 的 JSON payload(含 `transcript_path`,一个 JSONL 文件路径)通过 `curl -d @-` 喂给 collector。`src/claude/transcript.ts` 把 JSONL 解析成结构化 turn(user prompt、assistant text、带 `is_error` 的 tool result)。collector 立即返回 202,在 fire-and-forget IIFE 里把 turns 持久化到 `memory_distill_events`。
- **Distill。** 1Hz scheduler tick(`src/scheduler.ts`)取 pending job,加载存储的 turns,用带分类感知的 system prompt 调 LLM(`src/memory/distiller.ts`)。JSON 响应变成 `candidate` 记忆。debounce(5s)+ 指数退避应对突发和 LLM 瞬时失败。
- **Approve。** web UI 调 `POST /api/memories/:id/promote`,body `{action:'approve'|'reject'|'approve_and_supersede'}`。状态转换用 specific-source 检查(不是通用的 `canTransition`),所以 archived 条目不能被静默重新 approve。
- **Inject。** `SessionStart` 调 `adapter.inject({cwd})`,按 project + runtime 查 approved 记忆,按 token 预算裁剪(project 1500 / global 500),渲染 markdown 块,包成 `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":...}}` 返回--这正是 claude code 从 hook stdout 读的 envelope。

## License

Private / WIP.

# STATE.md - memside 构建状态

## MVP 构建:已完成

全部 17 个任务均已实现。完整测试套件全绿(`bun test` -> 100 通过,
0 失败),`tsc --noEmit` 干净无报错。

### 任务总览

| 任务 | 描述 | 状态 |
|------|-------------|--------|
| 1  | 仓库脚手架 + bun/tsconfig               | 完成 |
| 2  | SQLite schema + db 客户端                | 完成 |
| 3  | 纯注入层(formatMemoryBlock、budget clip)| 完成 |
| 4  | 纯错误信号检测                            | 完成 |
| 5  | 纯状态机(canTransition)                  | 完成 |
| 6  | 记忆存储:createCandidate                 | 完成 |
| 7  | 记忆存储:promote/patch/archive           | 完成 |
| 8  | Distiller(LLM prompt + JSON 解析)       | 完成 |
| 9  | Scheduler(enqueue + tick + loop)         | 完成 |
| 10 | opencode stub adapter                    | 完成 |
| 11 | claude code adapter(捕获 + 注入)        | 完成 |
| 12 | 凭证加载器(claude code API key)         | 完成 |
| 13 | Hono server(collector + injector + API) | 完成 |
| 14 | Hook 安装器(幂等 settings.json)         | 完成 |
| 15 | Web UI(React 审批队列)                  | 完成 |
| 16 | Daemon(串联 collector + scheduler + server)| 完成 |
| 17 | CLI 入口 + e2e smoke 测试                | 完成 |

### 如何运行

```bash
# 启动 daemon + 安装 claude code hooks(每台机器一次性)
bun run src/cli.ts start-and-install

# 启动 Web UI(另开一个终端)
bun run dev:web

# 在任意仓库里照常使用 claude code。
# Stop hook 触发后,Web UI 上会出现一条候选记忆。
# 审批它,再开一个新的 claude code 会话,记忆块即被注入。

# 测试
bun test
bun run typecheck
```

### CLI 命令

- `memside start` - 仅启动 daemon(不安装 hook)
- `memside install` - 仅安装 claude code hooks(不启动 daemon)
- `memside start-and-install` - 两者都做

端口由 `MEMSIDE_PORT` env 控制(默认 7777)。

## 验证状态(final-fix1..4 之后 + daemon 层 live smoke)

MVP 的 capture -> distill -> approve -> inject 闭环已在 daemon 层通过
`smoke-live.ts` 端到端验证(真实 Ark LLM、真实 HTTP、无 mock):真实
transcript -> 候选 `[category:invariant] Refunds allowed only within 14 days
of shipment` -> 审批通过 -> SessionStart 返回带 `## Learned context` 块的
`hookSpecificOutput` additionalContext envelope。测试套件:`bun test` ->
100 通过 / 0 失败,`tsc --noEmit` 干净。

### 已由 final-fix 轮次解决(live-verified)
1. **凭证加载**(final-fix4,`0a25a1a`):`src/creds.ts` 现在从
   `~/.claude/settings.json` 的 env 中读取 `ANTHROPIC_AUTH_TOKEN` +
   `ANTHROPIC_BASE_URL` + `ANTHROPIC_DEFAULT_HAIKU_MODEL`(进程 env 优先,
   其次 settings 文件),支持目标用户实际使用的 Volcengine Ark 代理
   (`https://ark.cn-beijing.volces.com/api/plan` + `deepseek-v4-flash`)。
   Live smoke 确认 distiller 调用了 Ark 模型并拿到合法候选。
3. **模型可达性**(final-fix4):distiller 不再硬编码
   `claude-haiku-4-5-20251001`;改为使用 `creds.model ?? DISTILL_MODEL`,
   因此用户配置的 haiku 档模型优先。已 live-verified。
2. **C2/C3 捕获+注入**(final-fix3,`ac73ce4`):捕获侧通过
   `src/claude/transcript.ts` 的 `parseTranscriptFile` 读取
   `transcript_path`(已对照 2.1.217 二进制 + 一个真实本地 transcript 验证);
   SessionStart 返回 `hookSpecificOutput` additionalContext envelope
   (envelope 形状已对照二进制自身的错误字符串验证)。daemon 层 live smoke
   通过了完整闭环。

### 仍需真实 claude-code 会话验证(无法自动化)
4. **SessionStart additionalContext 抵达新会话 - 已验证**:
   在 memside 仓库内执行 `claude -p "say hi"` 触发了 SessionStart hook
   (daemon diag 日志:`SessionStart hit cwd=C:\Users\admin\Desktop\memside
   hasBlock=true`),daemon 返回了 envelope,claude code 把
   `additionalContext` 注入了会话 - 由会话 transcript 中包含
   `"additionalContext":"## Learned context (auto-injected, advisory)
   ...memside injection probe..."` 得到确认。注意:print 模式的
   `YES/NO` 探针回答了 NO,因为模型在回答直接提问时不会扫描注入的上下文;
   transcript 才是事实来源。完整闭环 - capture -> distill -> approve ->
   inject - 现已用真实 claude code 会话 + 真实 Ark LLM 完成端到端
   live-verified。

### Live smoke harness
`bun run smoke-live.ts`(仓库根目录)用 tmp DB + tmp transcript + 真实
Ark LLM 跑完整闭环。在代理环境下,设置 `NO_PROXY=127.0.0.1,localhost`
让本地 HTTP fetch 绕过系统代理:
`NO_PROXY=127.0.0.1,localhost bun run smoke-live.ts`(Ark 调用仍走
`HTTPS_PROXY`)。distill 耗时约 15-30s(异步 fire-and-forget,不阻塞
hook ack)。

## 已知债务 - 候选队列审计(2026-07-23)

审计了 live DB(`~/.memside/memside.db`:**571 候选 / 2 已审批**,
102 MB;约 19 小时运行)。候选队列实质上是坏的:生产速度远超审批,
且没有去重。**去重正在单独 brainstorming**(见
`docs/superpowers/specs/` + `plans/` 里的去重设计)。其余发现作为后续
工作记录于此:

1. **events/jobs 从不清理 + 存了完整 transcript** - `src/server.ts:113-127`
   在每次 Stop hook 时把*整个* transcript JSON 序列化进
   `memory_distill_events.payload`;对已完成/失败的 job 及其 event 没有
   delete / TTL(grep 确认 - 只有 FK `ON DELETE CASCADE`,没有任何地方
   删 job)。102 MB DB 里有 92 MB 是 `memory_distill_events.payload`
   (316 行;最大单行 660 KB)。需要清理策略 + 只存摘要而非完整 transcript
   副本。
2. **候选队列增长快于审批** - 约 19 小时内 571 候选 vs 2 已审批。审批
   步骤是 capture->distill->approve->inject 闭环里断掉的那一环。需要在
   队列 UI 里加候选上限 / 老化 / 近重复聚合,让人能真正走完它。
3. **`scope_id` 是原始 cwd,无归一化** - `src/scheduler.ts:76` 写入
   `scopeId = job.cwd`;`src/adapter/claudeCode.ts:38` 用
   `projectId = input.cwd` 注入,靠精确字符串 `eq` 匹配。Windows 路径大小写 /
   尾斜杠 / 符号链接 / 8.3 短名漂移会静默打断 project-scope 注入(已审批的
   project 记忆永远到不了新会话)。需要在写入和匹配两处都做 cwd 归一化。
4. **schema 漂移 + 迁移回填缺口** - live DB 的 `memories` 表**没有
   `source_cwd` 列**(`PRAGMA table_info` 确认):运行中的 daemon 是从
   pre-`source_cwd` 代码启动的、从未重启,所以 `client.ts:66-75` 的迁移
   从未运行。此外回填
   `UPDATE memories SET source_cwd = scope_id WHERE scope_type='project'`
   (`client.ts:73`)只覆盖 project 行 - **global 记忆的 `source_cwd`
   会保持 NULL**,丢失其来源项目。需要重启 daemon 以应用迁移,并修复回填
   使 global 行的 `source_cwd` 从其 distill job 的 `cwd` 填入。
5. **卡住的 `running` distill job** - 2 个 job 卡在
   `status='running'`;`sweepStuckRunning`(`src/daemon.ts:108`)只在
   daemon 启动时跑一次,所以长寿命 daemon 永远恢复不了它们。需要周期性
   sweep,或在 tick 侧对 `running` 行做超时跳过。

## Known debt - codeagent 桥接遗留 (2026-07-23)

探索"用公司内部 codeagent CLI(Claude Code 封装,不暴露 API 凭证)替代直连 Anthropic SDK 驱动 distill"的结论:**技术上可行**。memside 的 `callAnthropic` seam(`src/scheduler.ts:38`、`src/daemon.ts:117`)可替换为 spawn `codeagent -p --system-prompt <sys> --output-format json --tools "" --no-session-persistence`,stdin 传 user prompt,从 envelope 的 `.result` 取文本返回;distiller / scheduler / store 核心不动。本机用标准 `claude` + Ark 代理实测两次均成立(envelope `type:"result"` / `result` 字段、stdin + `--system-prompt` 共存、中文编码正常、~12s / $0.02 一次)。**硬前提**:codeagent 必须透传 `-p` / `--system-prompt` / `--output-format` / stdin(公司机器上待验证,验证清单见对话记录)。

桥接有五个脆弱点,第 1 个已解决(PR #7),其余四个在此追踪:

1. **markdown 围栏包裹致 `JSON.parse` 静默失败** - 模型 `result` 可能被 ```` ```json ... ``` ```` 围栏包裹,`src/memory/distiller.ts:63` 的 `JSON.parse(raw)` 抛错 -> catch 吞掉 -> 产出 0 候选(实测撞到,间歇性)。**已解决**(PR #7,三道防线:`extractJsonObject` 状态机扒围栏 + distiller/dedup SYSTEM_PROMPT 加 JSON 模板 + `callWithRetry` 重试喂错误回模型;170/170 测试全绿,final review verdict Yes)。
2. **`[category:xxx]` 前缀校验过严** - `src/memory/distiller.ts:70` 的 `if (!o.title.includes('[category:')) continue` 会丢弃后端模型输出。codeagent 后端若非 Claude(实测 glm 把 `[category:convention]` 写成 `[convention]`),候选被静默丢弃。需放宽校验或加固 prompt。
3. **长 transcript vs context window** - `src/daemon.ts:28` 的 `makeLoadTranscript` 全量加载不截断(已知最大单条 payload 660KB,见上方 candidate-queue debt 第 1 项)。codeagent 后端 context 可能小于直连 haiku,长 transcript 超限 / 被截。需在 codeagent 模式下加预算裁剪(复用 `clipByBudget` 思路)。
4. **system prompt 可能被 codeagent 覆盖 / 拼接** - 公司封装常强制注入企业合规 / 审计 system prompt,稀释 distiller "ONLY a JSON object" 指令 -> 输出格式乱 -> 回到第 1 项。备选 fallback:把 system prompt 拼进 user prompt 开头(user prompt 一般不被覆盖)。
5. **hooks 兼容性(闭环层面,独立于 distill)** - capture / inject 依赖 `~/.claude/settings.json` 的 hooks(`src/install.ts`)。若 codeagent 用别的配置目录(如 `~/.codeagent/`)或不读 claude hooks,hooks 装不上 -> capture 抓不到 transcript、inject 注不进新会话,整个闭环断。需验证 codeagent 配置路径 + 可能适配 `installHooks` 的 `baseDir`。**此项决定产品能否闭环,优先级高于 2-4。**

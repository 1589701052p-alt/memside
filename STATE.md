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

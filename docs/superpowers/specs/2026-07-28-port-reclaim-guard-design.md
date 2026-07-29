# 端口占用防呆（启动前检测 + 询问回收）- 设计 spec

日期：2026-07-28
分支：`feat/port-reclaim-guard`
状态：设计已与用户逐段确认通过，待用户复核 spec 文件。
关联：`docs/superpowers/specs/2026-07-28-one-click-launch-design.md`（一键启动）的增量补充。

## 1. 背景

`bun run dev` / `bun run start`（一键启动，PR #23 已合并）在端口被占时直接抛
裸的 `EADDRINUSE` 堆栈，用户面对一堆 Bun 内部栈无法判断是谁占了端口、怎么处理。
真实触发场景：上一次 dev/start 未正常退出（孤儿进程、手动 Ctrl+C 后子进程没被回收、
诊断脚本留尸）导致 7777/5173 仍被占，再次启动即崩。

原一键启动 spec 的非目标写明「端口占用自动切换/探测、静默换端口」--本需求**修订**
该决策：仍不静默换端口、仍不静默杀进程，改为**启动前检测 + 列出占用进程 + 询问用户
是否杀掉后继续**。

### 关键现状（摸底结论）

1. **start.ts** 在 `await startDaemon` 前无任何端口预检；daemon 内部 `Bun.serve` 失败
   抛 `EADDRINUSE`，栈打到 stderr，进程退出 1。
2. **dev.ts** spawn daemon 子进程，daemon 崩溃时其 stderr 经 `[daemon]` 前缀转发，
   主进程随后因 daemon `exited` 非零而退出（即用户看到的 `[daemon] error: Failed to
   start server. Is port 7777 in use?` + 栈）。
3. **端口固定**：daemon 7777（`MEMSIDE_PORT` 可覆盖，但 dev 下 vite 5173 由 vite
   默认、不受 `MEMSIDE_PORT` 控制）。dev 实际要占 7777 + 5173 两个端口。
4. **跨平台进程查询**：Windows `netstat -ano | findstr :PORT` 拿 PID +
   `wmic process where ProcessId=PID get CommandLine`（或 PowerShell
   `Get-CimInstance`）拿命令行；posix `lsof -ti:PORT` 拿 PID + `ps -p PID -o command=`
   拿命令行。
5. **杀进程**：Windows `taskkill //PID <pid> //F`；posix `process.kill(pid, 'SIGKILL')`。

## 2. 目标 / 非目标

### 目标

- `bun run start` 启动前预检 daemon 端口（`MEMSIDE_PORT ?? 7777`）；`bun run dev`
  预检 7777 + 5173。
- 端口被占时：**列出每个被占端口的 PID + 命令行**，TTY 下询问「是否杀掉并继续?
  (y/N)」，用户答 y 才杀；答 n 或非 TTY 直接退出 1。
- 杀进程后继续启动；杀失败不中止（进程可能已自行退出），由原 EADDRINUSE 兜底。
- 跨平台（Windows + posix）。纯函数层可单测。

### 非目标（YAGNI）

- ❌ 静默换端口。端口仍固定，hooks 里写死 7777，换端口会让 capture/inject 全断。
- ❌ 静默杀进程。必须有用户确认（TTY 下）或直接退出（非 TTY），绝不擅自 kill。
- ❌ 杀父进程链 / 整个进程树。只杀占端口的那一个 PID（用户选定）。
- ❌ `--yes` / `MEMSIDE_AUTO_RECLAIM` 等自动回收开关。非 TTY 直接退出，保持简单；
  自动回收开关留待真实需求出现再加。
- ❌ 改 `src/daemon.ts` 或 `src/cli.ts`。预检只在 scripts 层，daemon 行为不变。
- ❌ 改原一键启动 spec 文件。本需求是增量补充，独立 spec。
- ❌ 检测 vite 端口 5173 之外的 vite 备用端口（5174 等）。vite 自己会让端口；本需求
  只预检固定 5173，5173 被占走询问流程，杀掉后 vite 自然回到 5173。

## 3. 用户确认的关键决策

| 决策 | 选项 | 用户选定 |
|------|------|----------|
| 交互方式 | 提示后等 y/N / 只提示不杀（退出）/ 直接杀后启动 | **提示后等用户输入 y/N** |
| 检测范围 | start 检 7777，dev 检 7777+5173 / 都只检 7777 / 只检自身 | **start 检 7777，dev 检 7777+5173** |
| 杀进程范围 | 只杀占端口 PID / 杀 PID+父链 / 杀整树 | **只杀占端口的 PID** |
| 非 TTY 降级 | 直接退出 / 加 --yes 开关 / 始终默认不杀退出 | **非 TTY 直接退出** |
| 多端口节奏 | 列出全部问一次 / 逐个问 / 列出全部直接退出 | **列出全部、问一次** |

## 4. 设计

### 4.1 新模块 `src/launch/portCheck.ts`

三个导出，平台/TTY 依赖全部参数化注入以便单测：

```ts
export interface PortHolder { port: number; pid: number; cmdline: string }
```

- **`findPortHolders(ports, ctx): Promise<PortHolder[]>`**
  - `ctx = { platform: NodeJS.Platform; spawn: (cmd, opts) => ... }`（spawn 注入，便于
    mock；生产传 `Bun.spawn` 的包装）。
  - Windows：对每个 port 跑 `netstat -ano`，正则匹配
    `^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)` 拿到占该端口的 PID（可能多个，
    全取）；再对每个 PID 跑 `wmic process where ProcessId=PID get CommandLine /value`
    解析 `CommandLine=...` 拿命令行（wmic 取不到时 cmdline 留空字符串，不阻塞）。
  - posix：对每个 port 跑 `lsof -ti:PORT`（可能多行多 PID），再对每个 PID 跑
    `ps -p PID -o command=` 拿命令行（取不到留空）。
  - 同一端口多 PID 全部列出；同一 PID 占多端口按端口各列一条。
  - 端口未被占 -> 该端口无条目；返回数组只含被占的。

- **`promptReclaim(holders, ctx): Promise<boolean>`**
  - `ctx = { isTTY: boolean; readline: () => Promise<string> }`。
  - holders 为空 -> 返回 true（无需回收，继续启动）。
  - 非 TTY -> 打印占用列表（每条 `[port 7777] PID 18196: <cmdline>`）+ 提示
    「非交互环境，请手动回收后重试」-> 返回 false。
  - TTY -> 打印占用列表 + `memside: 是否杀掉以上进程并继续? (y/N)` -> 读一行 ->
    `y`/`yes`（trim + toLowerCase）返回 true，其余（n、空、任意）返回 false。

- **`reclaim(holders, ctx): Promise<void>`**
  - `ctx = { platform; spawn }`。
  - Windows：`taskkill //PID <pid> //F`（注意 Bun spawn 在 Windows 上 `//` 转义为
    `/`，与仓库既有 taskkill 用法一致）；posix：`process.kill(pid, 'SIGKILL')`。
  - **只杀 holders 里每个 PID 一次**（去重），不递归父/子。
  - 杀失败（进程已退出 / 权限不足）打印 warn，不抛、不中止。

### 4.2 start.ts 接入

`await startDaemon` 之前插入：

```ts
const holders = await findPortHolders([PORT], prodCtx)
if (holders.length) {
  if (!(await promptReclaim(holders, prodCtx))) process.exit(1)
  await reclaim(holders, prodCtx)
}
```

`prodCtx` 在脚本顶层组装（`{ platform: process.platform, spawn: Bun.spawn, isTTY:
process.stdin.isTTY ?? false, readline: readLineStdin }`）。`readLineStdin` 是一个
从 `process.stdin` 读一行的本地小函数。

### 4.3 dev.ts 接入

spawn daemon/web 之前插入（端口固定 7777 + 5173，**不读 MEMSIDE_PORT**--dev 下
daemon 子进程自己读 env，主进程预检用默认 7777 即可；若用户改了 MEMSIDE_PORT，
daemon 会占新端口，5173 不变，此处预检 7777 仍合理因为默认场景占绝大多数；精确起见
预检的 daemon 端口取 `plan.port`）：

```ts
const holders = await findPortHolders([plan.port, 5173], devCtx)
if (holders.length) {
  if (!(await promptReclaim(holders, devCtx))) process.exit(1)
  await reclaim(holders, devCtx)
}
```

`plan.port` 来自 `buildSpawnPlan`（已是 `MEMSIDE_PORT ?? 7777`）。

### 4.4 数据流

```
启动 start/dev
  -> findPortHolders(目标端口)
  -> 空数组 -> 继续 spawn/startDaemon
  -> 非空 -> promptReclaim
       -> 非 TTY -> 打印列表 + 退出提示 -> exit 1
       -> TTY -> 打印列表 + 询问
            -> y -> reclaim(杀 PID) -> 继续 spawn/startDaemon
            -> n/空 -> exit 1
```

### 4.5 错误处理

| 场景 | 行为 |
|------|------|
| netstat / lsof 命令不存在或失败 | `findPortHolders` catch 后返回空数组（降级「无法检测，直接启动」），让原 EADDRINUSE 兜底；罕见 |
| wmic / ps 取命令行失败 | cmdline 留空字符串，仍列出 PID，不阻塞 |
| taskkill / kill 失败（进程已退出） | 打印 warn，继续启动；若端口仍被占，由 daemon EADDRINUSE 透出 |
| 用户答 n / 非 TTY | exit 1，不动任何进程 |
| 同端口多 PID | 全部列出、全部杀（用户确认一次即覆盖所有列出的 PID） |

### 4.6 与现有模块的耦合点

| 模块 | 改动 | 风险 |
|------|------|------|
| `src/launch/portCheck.ts` | 新建 | 无 |
| `scripts/start.ts` | 启动前加预检块 | 预检失败降级空数组，不阻塞；行为仅在「端口被占」时变化 |
| `scripts/dev.ts` | spawn 前加预检块 | 同上；`plan.port` 复用 buildSpawnPlan 既有输出 |
| `src/launch/spawnPlan.ts` | 不改 | - |
| `src/daemon.ts` / `src/cli.ts` | 不改 | daemon 行为不变，EADDRINUSE 仍是兜底 |
| `package.json` | 不改 | - |
| `README.md` | 故障排查节补一句「现在端口被占会询问回收，旧版本手动 taskkill 仍适用」 | 可选，小改 |

### 4.7 测试策略

按 CLAUDE.md：纯函数层写足测试，运行时层留文本断言兜底。

1. **`findPortHolders` 单测**（mock `ctx.spawn` 返回固定字符串）：
   - Windows：netstat 输出含 7777 LISTENING + PID -> 解析出 holder；wmic 输出
     `CommandLine=bun run src/cli.ts start` -> cmdline 正确；端口未占 -> 无条目。
   - posix：lsof 多行多 PID -> 全解析；ps 取命令行；未占 -> 空。
   - 同端口多 PID 全列；命令行取不到 -> 空字符串不抛。
2. **`promptReclaim` 单测**（mock `ctx.isTTY` + `ctx.readline`）：
   - holders 空 -> true。
   - 非 TTY -> 打印 + false。
   - TTY + readline 返回 'y' / 'Y' / ' yes ' -> true；返回 'n' / '' / 'x' -> false。
3. **`reclaim` 单测**（mock `ctx.spawn` / `process.kill`）：
   - Windows -> 调 `taskkill //PID <pid> //F`；posix -> `process.kill(pid,'SIGKILL')`。
   - 同 PID 去重只杀一次；杀抛错 -> warn 不中断。
4. **文本断言兜底**：`scripts/start.ts` / `scripts/dev.ts` 含 `findPortHolders` /
   `promptReclaim` 调用字样。
5. 运行门槛：`bun run typecheck && bun test` 全绿才可 push。

## 5. 验收清单

- [ ] 7777 被占时 `bun run start` 打印 `memside: 端口 7777 已被占用` + PID + 命令行 +
      `是否杀掉并继续? (y/N)`；答 y -> 杀进程 -> daemon 正常起；答 n -> 退出 1
- [ ] 7777 或 5173 被占时 `bun run dev` 列出全部被占端口、问一次；y -> 杀全部 -> 双进程起
- [ ] 非 TTY（管道 `bun run start < /dev/null` 或 CI）端口被占 -> 打印列表 + 退出 1，不杀
- [ ] 端口空闲 -> 无任何预检输出，直接启动（与现状一致）
- [ ] 杀进程只杀占端口 PID，不动父/子进程
- [ ] `src/daemon.ts` / `src/cli.ts` 零改动
- [ ] `bun run typecheck && bun test` 全绿（含新增测试）
- [ ] README 故障排查节同步（可选小改）

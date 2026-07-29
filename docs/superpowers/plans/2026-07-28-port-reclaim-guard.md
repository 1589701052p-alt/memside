# 端口占用防呆（启动前检测 + 询问回收）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `bun run start` / `bun run dev` 在端口被占时不裸抛 EADDRINUSE，而是列出占用进程 PID+命令行、询问用户是否杀掉后继续。

**Architecture:** 新增 `src/launch/portCheck.ts`，把端口查询、询问、回收三步各做成依赖注入的函数（平台/TTY/spawn 全参数化，纯函数层可单测）；`scripts/start.ts` 和 `scripts/dev.ts` 在启动前各调一次。daemon/cli 零改动，EADDRINUSE 仍是兜底。

**Tech Stack:** Bun（runtime + test + spawn）、TypeScript、Windows netstat/wmic/taskkill、posix lsof/ps/kill。

**Spec:** `docs/superpowers/specs/2026-07-28-port-reclaim-guard-design.md`

## Global Constraints

- 分支：`feat/port-reclaim-guard`（从最新 `origin/master` 切；严禁直推 master）。
- 运行门槛：每个 task 落 commit 前 `bun run typecheck && bun test` 全绿。
- 端口固定：daemon `MEMSIDE_PORT ?? 7777`；dev 下 vite 5173（vite 默认，不受 `MEMSIDE_PORT` 控制）。dev 预检的 daemon 端口取 `buildSpawnPlan` 的 `plan.port`。
- 不静默换端口、不静默杀进程：TTY 询问 `(y/N)`；非 TTY 直接退出 1。
- 杀进程**只杀占端口的那一个 PID**，不递归父/子；同 PID 去重只杀一次。
- `src/daemon.ts` / `src/cli.ts` / `src/launch/spawnPlan.ts` / `package.json` 零改动。
- 不改原 `2026-07-28-one-click-launch-design.md` spec；本需求是增量。
- 查端口/取命令行/杀进程失败都降级，不阻塞启动（让原 EADDRINUSE 兜底）。
- 平台/TTY/spawn 依赖全部参数化注入，便于纯函数单测；生产 ctx 在脚本顶层组装。

---

### Task 1: `findPortHolders` 跨平台端口占用查询纯函数

**Files:**
- Create: `src/launch/portCheck.ts`
- Test: `tests/port-check.test.ts`（新建）

**Interfaces:**
- Consumes: 无（纯函数 + 注入的 `spawn`）。
- Produces（Task 3 的 start.ts / dev.ts 依赖）:

```ts
export interface PortHolder { port: number; pid: number; cmdline: string }
export interface PortCheckCtx {
  platform: NodeJS.Platform
  spawn: (cmd: string[]) => Promise<{ stdout: string; exitCode: number | null }>
}
export async function findPortHolders(ports: number[], ctx: PortCheckCtx): Promise<PortHolder[]>
```

- [ ] **Step 1: 写失败测试 `tests/port-check.test.ts`（findPortHolders 部分）**

```ts
import { test, expect } from 'bun:test'
import { findPortHolders, type PortCheckCtx } from '@/launch/portCheck'

// 端口占用防呆（2026-07-28-port-reclaim-guard）：跨平台端口查询纯函数层。
// 平台/spawn 全注入，不碰真实系统命令。

/** 造一个按命令返回固定 stdout 的假 spawn。键为完整命令字符串。 */
function fakeSpawn(map: Record<string, string>): PortCheckCtx['spawn'] {
  return async (cmd: string[]) => {
    const key = cmd.join(' ')
    return { stdout: map[key] ?? '', exitCode: map[key] !== undefined ? 0 : 1 }
  }
}

test('Windows: parses LISTENING PID from netstat + cmdline from wmic', async () => {
  const ctx: PortCheckCtx = {
    platform: 'win32',
    spawn: fakeSpawn({
      'netstat -ano':
        '  TCP    127.0.0.1:7777         0.0.0.0:0              LISTENING       18196\r\n' +
        '  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       21044\r\n',
      'wmic process where ProcessId=18196 get CommandLine /value':
        'CommandLine=bun run src/cli.ts start\r\n',
      'wmic process where ProcessId=21044 get CommandLine /value':
        'CommandLine=node vite/bin/vite.js\r\n',
    }),
  }
  const holders = await findPortHolders([7777, 5173], ctx)
  expect(holders).toContainEqual({ port: 7777, pid: 18196, cmdline: 'bun run src/cli.ts start' })
  expect(holders).toContainEqual({ port: 5173, pid: 21044, cmdline: 'node vite/bin/vite.js' })
})

test('Windows: unoccupied port yields no holder', async () => {
  const ctx: PortCheckCtx = {
    platform: 'win32',
    spawn: fakeSpawn({ 'netstat -ano': '  TCP    127.0.0.1:9999  0.0.0.0:0  LISTENING  1\r\n' }),
  }
  const holders = await findPortHolders([7777], ctx)
  expect(holders).toEqual([])
})

test('Windows: wmic failure leaves cmdline empty, PID still listed', async () => {
  const ctx: PortCheckCtx = {
    platform: 'win32',
    spawn: fakeSpawn({
      'netstat -ano': '  TCP    127.0.0.1:7777  0.0.0.0:0  LISTENING  18196\r\n',
      'wmic process where ProcessId=18196 get CommandLine /value': '',
    }),
  }
  const holders = await findPortHolders([7777], ctx)
  expect(holders).toEqual([{ port: 7777, pid: 18196, cmdline: '' }])
})

test('Windows: same port held by multiple PIDs all listed', async () => {
  const ctx: PortCheckCtx = {
    platform: 'win32',
    spawn: fakeSpawn({
      'netstat -ano':
        '  TCP    0.0.0.0:7777  0.0.0.0:0  LISTENING  100\r\n' +
        '  TCP    [::]:7777     [::]:0     LISTENING  200\r\n',
      'wmic process where ProcessId=100 get CommandLine /value': 'CommandLine=a\r\n',
      'wmic process where ProcessId=200 get CommandLine /value': 'CommandLine=b\r\n',
    }),
  }
  const holders = await findPortHolders([7777], ctx)
  expect(holders).toContainEqual({ port: 7777, pid: 100, cmdline: 'a' })
  expect(holders).toContainEqual({ port: 7777, pid: 200, cmdline: 'b' })
})

test('posix: parses PIDs from lsof + cmdline from ps', async () => {
  const ctx: PortCheckCtx = {
    platform: 'linux',
    spawn: fakeSpawn({
      'lsof -ti:7777': '18196\n21044\n',
      'ps -p 18196 -o command=': 'bun run src/cli.ts start\n',
      'ps -p 21044 -o command=': 'node vite/bin/vite.js\n',
    }),
  }
  const holders = await findPortHolders([7777], ctx)
  expect(holders).toContainEqual({ port: 7777, pid: 18196, cmdline: 'bun run src/cli.ts start' })
  expect(holders).toContainEqual({ port: 7777, pid: 21044, cmdline: 'node vite/bin/vite.js' })
})

test('posix: unoccupied port yields no holder', async () => {
  const ctx: PortCheckCtx = {
    platform: 'darwin',
    spawn: fakeSpawn({ 'lsof -ti:7777': '' }),
  }
  const holders = await findPortHolders([7777], ctx)
  expect(holders).toEqual([])
})

test('any platform: spawn failure degrades to empty (does not throw)', async () => {
  const ctx: PortCheckCtx = {
    platform: 'win32',
    spawn: async () => { throw new Error('netstat not found') },
  }
  const holders = await findPortHolders([7777], ctx)
  expect(holders).toEqual([])
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/port-check.test.ts`
Expected: FAIL（模块不存在 / 函数未导出）

- [ ] **Step 3: 实现 `src/launch/portCheck.ts`（仅 findPortHolders + 类型，其余函数 Task 2/3 加）**

```ts
/**
 * 端口占用防呆（2026-07-28-port-reclaim-guard）：启动前检测目标端口被占时，
 * 列出占用进程 PID + 命令行，询问用户是否杀掉后继续，而非裸抛 EADDRINUSE。
 *
 * 平台 / TTY / spawn 依赖全部参数化注入，便于纯函数单测；生产 ctx 在
 * scripts/start.ts、scripts/dev.ts 顶层组装。
 *
 * 三步：findPortHolders（查）-> promptReclaim（问，Task 2）-> reclaim（杀，Task 3）。
 * daemon/cli 零改动，EADDRINUSE 仍是兜底。
 */

export interface PortHolder {
  port: number
  pid: number
  cmdline: string
}

export interface PortCheckCtx {
  platform: NodeJS.Platform
  spawn: (cmd: string[]) => Promise<{ stdout: string; exitCode: number | null }>
}

/**
 * 查询哪些端口被哪个 PID 占用。Windows: netstat -ano + wmic；posix: lsof + ps。
 * 命令失败/不存在 -> 降级空数组（不阻塞启动，让 EADDRINUSE 兜底）。
 * 同端口多 PID 全列；命令行取不到留空字符串。
 */
export async function findPortHolders(ports: number[], ctx: PortCheckCtx): Promise<PortHolder[]> {
  if (ports.length === 0) return []
  try {
    return ctx.platform === 'win32' ? await findByNetstat(ports, ctx) : await findByLsof(ports, ctx)
  } catch {
    return []
  }
}

async function findByNetstat(ports: number[], ctx: PortCheckCtx): Promise<PortHolder[]> {
  const out = await ctx.spawn(['netstat', '-ano'])
  // 匹配所有 LISTENING 行，按端口过滤。形如：
  //   TCP    127.0.0.1:7777   0.0.0.0:0   LISTENING   18196
  const re = /\s+TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/g
  const pidByPort = new Map<number, number[]>()
  let m: RegExpExecArray | null
  while ((m = re.exec(out.stdout)) !== null) {
    const port = Number(m[1])
    const pid = Number(m[2])
    if (!ports.includes(port) || !Number.isFinite(pid)) continue
    const arr = pidByPort.get(port) ?? []
    if (!arr.includes(pid)) arr.push(pid)
    pidByPort.set(port, arr)
  }
  const holders: PortHolder[] = []
  for (const [port, pids] of pidByPort) {
    for (const pid of pids) {
      holders.push({ port, pid, cmdline: await getCmdlineWin(pid, ctx) })
    }
  }
  return holders
}

async function getCmdlineWin(pid: number, ctx: PortCheckCtx): Promise<string> {
  try {
    const out = await ctx.spawn(['wmic', 'process', 'where', `ProcessId=${pid}`, 'get', 'CommandLine', '/value'])
    const m = out.stdout.match(/CommandLine=(.*)/)
    return m ? m[1].trim() : ''
  } catch {
    return ''
  }
}

async function findByLsof(ports: number[], ctx: PortCheckCtx): Promise<PortHolder[]> {
  const holders: PortHolder[] = []
  for (const port of ports) {
    let pids: number[] = []
    try {
      const out = await ctx.spawn(['lsof', `-ti:${port}`])
      pids = out.stdout.split('\n').map((l) => Number(l.trim())).filter((n) => Number.isFinite(n) && n > 0)
    } catch {
      continue // lsof 非零退出 = 端口未占
    }
    for (const pid of pids) {
      holders.push({ port, pid, cmdline: await getCmdlinePosix(pid, ctx) })
    }
  }
  return holders
}

async function getCmdlinePosix(pid: number, ctx: PortCheckCtx): Promise<string> {
  try {
    const out = await ctx.spawn(['ps', '-p', String(pid), '-o', 'command='])
    return out.stdout.trim()
  } catch {
    return ''
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/port-check.test.ts`
Expected: PASS（7/7）

- [ ] **Step 5: 全量回归 + Commit**

Run: `bun run typecheck && bun test` -> 全绿

```bash
git add src/launch/portCheck.ts tests/port-check.test.ts
git commit -m "feat: findPortHolders 跨平台端口占用查询纯函数"
```

---

### Task 2: `promptReclaim` 询问回收纯函数

**Files:**
- Modify: `src/launch/portCheck.ts`（加 promptReclaim + 扩 ctx 类型）
- Test: `tests/port-check.test.ts`（追加 promptReclaim 测试）

**Interfaces:**
- Consumes: `PortHolder`（Task 1）。
- Produces（Task 3 的 start.ts / dev.ts 依赖）:

```ts
export interface ReclaimCtx {
  isTTY: boolean
  readline: () => Promise<string>
}
export async function promptReclaim(holders: PortHolder[], ctx: ReclaimCtx): Promise<boolean>
```

注意：Task 1 的 `PortCheckCtx` 与本 task 的 `ReclaimCtx` 是**两个独立接口**；脚本层会
把两者合成一个对象传入（鸭子类型兼容），纯函数层各自只声明自己需要的字段。

- [ ] **Step 1: 追加失败测试到 `tests/port-check.test.ts`**

在文件末尾追加（import 行改为同时引入 `promptReclaim`、`type ReclaimCtx`）：

```ts
import { promptReclaim, type ReclaimCtx } from '@/launch/portCheck'

test('promptReclaim: empty holders returns true (no prompt)', async () => {
  const ctx: ReclaimCtx = { isTTY: true, readline: async () => 'n' }
  expect(await promptReclaim([], ctx)).toBe(true)
})

test('promptReclaim: non-TTY prints and returns false', async () => {
  const calls: string[] = []
  const origLog = console.log
  console.log = (s: string) => { calls.push(s) }
  const ctx: ReclaimCtx = { isTTY: false, readline: async () => 'y' }
  try {
    expect(await promptReclaim([{ port: 7777, pid: 1, cmdline: 'x' }], ctx)).toBe(false)
  } finally {
    console.log = origLog
  }
  expect(calls.some((s) => s.includes('7777'))).toBe(true)
})

test('promptReclaim: TTY y/yes returns true', async () => {
  for (const ans of ['y', 'Y', ' yes ', 'YES']) {
    const ctx: ReclaimCtx = { isTTY: true, readline: async () => ans }
    expect(await promptReclaim([{ port: 7777, pid: 1, cmdline: 'x' }], ctx)).toBe(true)
  }
})

test('promptReclaim: TTY n/empty/other returns false', async () => {
  for (const ans of ['n', '', 'no', 'x']) {
    const ctx: ReclaimCtx = { isTTY: true, readline: async () => ans }
    expect(await promptReclaim([{ port: 7777, pid: 1, cmdline: 'x' }], ctx)).toBe(false)
  }
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/port-check.test.ts`
Expected: FAIL（`promptReclaim` 未导出）

- [ ] **Step 3: 实现 promptReclaim，追加到 `src/launch/portCheck.ts`**

在文件末尾追加：

```ts
export interface ReclaimCtx {
  isTTY: boolean
  readline: () => Promise<string>
}

/**
 * 列出占用进程并询问是否杀掉。holders 为空 -> true（继续启动）；非 TTY ->
 * 打印列表 + 提示后返回 false；TTY -> 打印列表 + (y/N) 询问，y/yes 返回 true。
 */
export async function promptReclaim(holders: PortHolder[], ctx: ReclaimCtx): Promise<boolean> {
  if (holders.length === 0) return true
  console.log('memside: 以下端口已被占用：')
  for (const h of holders) {
    console.log(`  [port ${h.port}] PID ${h.pid}: ${h.cmdline || '(命令行未知)'}`)
  }
  if (!ctx.isTTY) {
    console.log('memside: 非交互环境，请手动回收以上进程后重试。')
    return false
  }
  const ans = (await ctx.readline()).trim().toLowerCase()
  return ans === 'y' || ans === 'yes'
}
```

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `bun test tests/port-check.test.ts` -> PASS（11/11）
Run: `bun run typecheck && bun test` -> 全绿

- [ ] **Step 5: Commit**

```bash
git add src/launch/portCheck.ts tests/port-check.test.ts
git commit -m "feat: promptReclaim 端口占用询问回收纯函数"
```

---

### Task 3: `reclaim` 杀进程纯函数 + 脚本接入（start.ts / dev.ts）

**Files:**
- Modify: `src/launch/portCheck.ts`（加 reclaim + 完整 ctx 装配）
- Modify: `scripts/start.ts`
- Modify: `scripts/dev.ts`
- Test: `tests/port-check.test.ts`（追加 reclaim 测试）
- Test: `tests/launch-scripts.test.ts`（追加脚本接入文本断言）

**Interfaces:**
- Consumes: `findPortHolders`（Task 1）、`promptReclaim`（Task 2）、`PortHolder`、
  `buildSpawnPlan`（既有，`plan.port`）。
- Produces: 完整的端口防呆闭环；`reclaim(holders, ctx)` 杀进程。

- [ ] **Step 1: 追加 reclaim 失败测试到 `tests/port-check.test.ts`**

文件末尾追加（import 行加上 `reclaim`）：

```ts
import { reclaim } from '@/launch/portCheck'

test('reclaim: Windows calls taskkill per unique PID', async () => {
  const calls: string[][] = []
  const ctx: PortCheckCtx = {
    platform: 'win32',
    spawn: async (cmd: string[]) => { calls.push(cmd); return { stdout: '', exitCode: 0 } },
  }
  // 同 PID 占两端口 -> 只杀一次
  await reclaim(
    [
      { port: 7777, pid: 18196, cmdline: 'a' },
      { port: 5173, pid: 18196, cmdline: 'a' },
      { port: 5173, pid: 21044, cmdline: 'b' },
    ],
    ctx,
  )
  expect(calls).toEqual([
    ['taskkill', '//PID', '18196', '//F'],
    ['taskkill', '//PID', '21044', '//F'],
  ])
})

test('reclaim: posix uses process.kill SIGKILL', async () => {
  const killed: number[] = []
  const origKill = process.kill
  process.kill = ((pid: number, sig?: string | number) => { killed.push(pid); return true }) as typeof process.kill
  const ctx: PortCheckCtx = { platform: 'linux', spawn: async () => ({ stdout: '', exitCode: 0 }) }
  try {
    await reclaim([{ port: 7777, pid: 42, cmdline: 'x' }], ctx)
  } finally {
    process.kill = origKill
  }
  expect(killed).toEqual([42])
})

test('reclaim: kill failure warns but does not throw', async () => {
  const ctx: PortCheckCtx = {
    platform: 'win32',
    spawn: async () => { throw new Error('access denied') },
  }
  // 不抛即通过
  await reclaim([{ port: 7777, pid: 1, cmdline: '' }], ctx)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/port-check.test.ts`
Expected: FAIL（`reclaim` 未导出）

- [ ] **Step 3: 实现 reclaim，追加到 `src/launch/portCheck.ts`**

文件末尾追加：

```ts
/**
 * 杀掉 holders 里的占用进程。只杀占端口的那一个 PID（不递归父/子），同 PID
 * 去重只杀一次。杀失败（进程已退出/权限不足）打印 warn，不抛、不中止。
 * Windows: taskkill //PID <pid> //F；posix: process.kill(pid, 'SIGKILL')。
 */
export async function reclaim(holders: PortHolder[], ctx: PortCheckCtx): Promise<void> {
  const seen = new Set<number>()
  for (const h of holders) {
    if (seen.has(h.pid)) continue
    seen.add(h.pid)
    try {
      if (ctx.platform === 'win32') {
        await ctx.spawn(['taskkill', '//PID', String(h.pid), '//F'])
      } else {
        process.kill(h.pid, 'SIGKILL')
      }
    } catch (e) {
      console.warn(`memside: 杀进程 PID ${h.pid} 失败（可能已退出）：${(e as Error).message}`)
    }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/port-check.test.ts` -> PASS（14/14）

- [ ] **Step 5: 追加脚本接入文本断言到 `tests/launch-scripts.test.ts`**

在文件末尾追加：

```ts
test('scripts/start.ts wires port-reclaim guard before startDaemon', () => {
  const src = readFileSync(join(repoRoot, 'scripts', 'start.ts'), 'utf8')
  expect(src).toContain('findPortHolders')
  expect(src).toContain('promptReclaim')
  expect(src).toContain('reclaim(')
})

test('scripts/dev.ts wires port-reclaim guard before spawn', () => {
  const src = readFileSync(join(repoRoot, 'scripts', 'dev.ts'), 'utf8')
  expect(src).toContain('findPortHolders')
  expect(src).toContain('promptReclaim')
  expect(src).toContain('reclaim(')
})
```

- [ ] **Step 6: 跑确认失败（脚本尚未接入）**

Run: `bun test tests/launch-scripts.test.ts`
Expected: FAIL（两个新测试，start.ts/dev.ts 还没含 findPortHolders）

- [ ] **Step 7: 接入 `scripts/start.ts`**

把 `scripts/start.ts` 整体替换为：

```ts
#!/usr/bin/env bun
/**
 * 一键启动（生产模式）：daemon 单端口同时服务 API + 构建产物 UI，并幂等
 * 安装 claude code hooks（start-and-install 语义 + 静态托管）。
 *
 * 正常入口是 `bun run start`（package.json 里 `bun run build && bun run
 * scripts/start.ts`），dist 总是新鲜；下面的存在性检查只防御直接调用本
 * 脚本的情况。
 *
 * 端口防呆：启动前检测 7777 是否被占，被占则列出占用进程并询问是否杀掉。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { startDaemon } from '@/daemon'
import { findPortHolders, promptReclaim, reclaim, type PortCheckCtx, type ReclaimCtx } from '@/launch/portCheck'

const PORT = Number(process.env.MEMSIDE_PORT ?? 7777)
const distDir = join(import.meta.dir, '..', 'src', 'web', 'dist')

if (!existsSync(join(distDir, 'index.html'))) {
  console.error('memside: src/web/dist/index.html not found - run `bun run build` first')
  process.exit(1)
}

// 生产 ctx：平台/spawn/TTY 全部绑定真实运行时。
const spawnReal: PortCheckCtx['spawn'] = async (cmd: string[]) => {
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' })
  const stdout = await new Response(proc.stdout).text()
  await proc.exited
  return { stdout, exitCode: proc.exitCode }
}
function readLineStdin(): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin })
    rl.question('', (ans) => { rl.close(); resolve(ans) })
  })
}
const ctx: PortCheckCtx & ReclaimCtx = {
  platform: process.platform,
  spawn: spawnReal,
  isTTY: process.stdin.isTTY ?? false,
  readline: readLineStdin,
}

const holders = await findPortHolders([PORT], ctx)
if (holders.length) {
  if (!(await promptReclaim(holders, ctx))) process.exit(1)
  await reclaim(holders, ctx)
}

await startDaemon({ port: PORT, installClaudeHooks: true, serveStaticDir: distDir })
console.log(`memside on http://127.0.0.1:${PORT} (UI + API, hooks installed)`)
```

- [ ] **Step 8: 接入 `scripts/dev.ts`**

在 `scripts/dev.ts` 顶部 import 区加（紧跟 `buildSpawnPlan` import 之后）：

```ts
import { findPortHolders, promptReclaim, reclaim, type PortCheckCtx, type ReclaimCtx } from '@/launch/portCheck'
import { createInterface } from 'node:readline'
```

把现有这一行：

```ts
const plan = buildSpawnPlan({ MEMSIDE_PORT: process.env.MEMSIDE_PORT }, process.execPath)
```

替换为以下整块（plan 构造 + ctx 装配 + 预检）：

```ts
const plan = buildSpawnPlan({ MEMSIDE_PORT: process.env.MEMSIDE_PORT }, process.execPath)

// 端口防呆：spawn 前检测 daemon 端口 + 5173，被占则列出占用进程并询问是否杀掉。
const spawnReal: PortCheckCtx['spawn'] = async (cmd: string[]) => {
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' })
  const stdout = await new Response(proc.stdout).text()
  await proc.exited
  return { stdout, exitCode: proc.exitCode }
}
function readLineStdin(): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin })
    rl.question('', (ans) => { rl.close(); resolve(ans) })
  })
}
const ctx: PortCheckCtx & ReclaimCtx = {
  platform: process.platform,
  spawn: spawnReal,
  isTTY: process.stdin.isTTY ?? false,
  readline: readLineStdin,
}

const holders = await findPortHolders([plan.port, 5173], ctx)
if (holders.length) {
  if (!(await promptReclaim(holders, ctx))) process.exit(1)
  await reclaim(holders, ctx)
}
```

（后续 `spawnLogged` / `daemon` / `web` / 信号处理 / `Promise.race` 等代码全部不动。）

- [ ] **Step 9: 跑测试确认通过 + 全量回归**

Run: `bun test tests/launch-scripts.test.ts` -> PASS（8/8，含 2 个新断言）
Run: `bun run typecheck && bun test` -> 全绿

- [ ] **Step 10: Commit**

```bash
git add src/launch/portCheck.ts scripts/start.ts scripts/dev.ts tests/port-check.test.ts tests/launch-scripts.test.ts
git commit -m "feat: start/dev 启动前端口占用检测+询问回收（防呆）"
```

---

### Task 4: README 故障排查同步

**Files:**
- Modify: `README.md`（故障排查节）

**Interfaces:**
- Consumes: Task 3 落地的端口防呆行为。
- Produces: 无代码接口；用户文档。

- [ ] **Step 1: 「故障排查」节端口相关条目补充**

在 README「## 故障排查」节，找到现有的「会话变慢/卡顿」一条（讲 daemon 没跑吃满 2s 超时的那条）之后，新增一条：

````markdown
**启动报 `EADDRINUSE` / 端口被占。** 上一次 dev/start 未正常退出留了孤儿进程。
`bun run start` / `bun run dev` 现在会在启动前检测端口占用,列出占用进程的 PID
和命令行并询问是否杀掉;非交互环境(管道/CI)直接退出,需手动回收:

```bash
netstat -ano | findstr :7777      # Windows,拿 PID
taskkill //PID <pid> //F
# 或 posix:
lsof -ti:7777 | xargs kill -9
```
````

- [ ] **Step 2: 全量回归 + Commit**

Run: `bun run typecheck && bun test` -> 全绿

```bash
git add README.md
git commit -m "docs: README 故障排查补端口占用防呆说明"
```

---

## Self-Review 记录

- **Spec coverage**：§4.1 findPortHolders -> Task 1；§4.1 promptReclaim + §4.4 数据流 -> Task 2；§4.1 reclaim + §4.2 start 接入 + §4.3 dev 接入 -> Task 3；§4.5 错误处理（spawn 失败降级 / cmdline 空 / kill 失败 warn / 非 TTY 退出 / 同端口多 PID 全杀）-> 各 task 测试覆盖；§4.6 daemon/cli/spawnPlan/package.json 零改动 -> Global Constraints + Task 3 只改 scripts；§4.7 测试策略 4 条 -> Task 1/2/3 纯函数测试 + launch-scripts 文本断言；README -> Task 4。验收清单 8 条全覆盖。
- **Placeholder scan**：无 TBD/TODO；所有代码步骤含完整代码。
- **Type consistency**：`PortHolder` / `PortCheckCtx` / `ReclaimCtx` 在 Task 1/2/3 间一致；`findPortHolders(ports, ctx)` / `promptReclaim(holders, ctx)` / `reclaim(holders, ctx)` 签名一致；`ctx: PortCheckCtx & ReclaimCtx` 在脚本层合并，纯函数层各自只声明所需字段（鸭子类型兼容，Task 2 注释已说明）。`plan.port` 复用既有 `buildSpawnPlan` 输出。

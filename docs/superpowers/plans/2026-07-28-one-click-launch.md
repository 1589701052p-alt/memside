# 一键构建启动前后端脚本 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 提供 `bun run start`（构建前端 + 单端口托管 UI/API + 装 hooks）和 `bun run dev`（daemon + vite dev 双进程一键开发）两条一键命令，并同步 README。

**Architecture:** 生产模式由 daemon 的 Hono app 增加可选 `staticDir`，用 `hono/bun` 的 `serveStatic` 托管 `vite build` 产物（`src/web/dist/`）；开发模式由 `scripts/dev.ts` 用 `Bun.spawn` 编排两个子进程，端口决策抽成纯函数 `buildSpawnPlan`。设计 spec：`docs/superpowers/specs/2026-07-28-one-click-launch-design.md`。

**Tech Stack:** Bun（runtime + test + spawn）、Hono（`hono/bun` serveStatic）、Vite 6、TypeScript。

## Global Constraints

- 分支：`feat/one-click-launch`（从最新 `origin/master` 切；严禁直推 master）。
- 运行门槛：每个 task 落 commit 前 `bun run typecheck && bun test` 全绿。
- 既有路由 `/api/*`、`/inject`、`/hooks/*` 行为逐字节不变；静态处理**注册在 createApp 末尾**，不得抢占具名路由。
- `src/cli.ts` 的 `start` / `start-and-install` **不传** `serveStaticDir`，裸 daemon 语义不变。
- daemon 端口 `MEMSIDE_PORT ?? 7777`；vite dev 端口 5173（vite 默认，不显式配）。
- 不做：自动开浏览器、端口占用自动切换、SPA 路由 fallback、.ps1/.bat 包装。
- `.gitignore` 已有 `dist/`（无锚点模式，任意层级生效，含 `src/web/dist/`）——**无需改动**，不要重复添加。
- 测试遵循仓库 EBUSY-safe 模式：`beforeAll`  wipe 一次 root、`beforeEach` 给每个测试开新鲜子目录、`afterEach` 关 `db.$client.close()`。

---

### Task 1: 静态托管（createApp staticDir + startDaemon 透传）

**Files:**
- Modify: `src/server.ts`（AppDeps 加 `staticDir?`、createApp 末尾加静态处理、顶部加 import）
- Modify: `src/daemon.ts`（DaemonOpts 加 `serveStaticDir?`、透传给 createApp）
- Test: `tests/server-static.test.ts`（新建）
- Test: `tests/daemon-static.test.ts`（新建）

**Interfaces:**
- Consumes: 现有 `createApp(deps: AppDeps)`、`startDaemon(opts: DaemonOpts)`。
- Produces:
  - `AppDeps.staticDir?: string` — 提供时 `GET /` 返回 `<staticDir>/index.html`，`/assets/*` 走 serveStatic。
  - `DaemonOpts.serveStaticDir?: string` — 透传为 `createApp` 的 `staticDir`。Task 2 的 `scripts/start.ts` 依赖它。

- [ ] **Step 1: 写失败测试 `tests/server-static.test.ts`**

```ts
import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openDb } from '@/db/client'
import { ClaudeCodeAdapter } from '@/adapter/claudeCode'
import { createApp } from '@/server'

// 一键启动（2026-07-28-one-click-launch）：锁 createApp 的 staticDir 托管行为。
// EBUSY-safe 模式同 server.test.ts：root 只 wipe 一次、每测试新鲜子目录、
// afterEach 关 db handle。
const root = join(import.meta.dir, '.tmp-server-static')
let dir = ''
let db: ReturnType<typeof openDb>

beforeAll(() => {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
})

beforeEach(() => {
  dir = join(root, Math.random().toString(36).slice(2))
  mkdirSync(dir, { recursive: true })
  db = openDb(join(dir, 't.db'))
})

afterEach(() => {
  db.$client.close()
})

function makeApp(staticDir?: string) {
  return createApp({
    db,
    adapter: new ClaudeCodeAdapter(db),
    enqueueDistillJob: async () => ({ jobId: 'j', nextRunAt: 0 }),
    broadcast: () => {},
    staticDir,
  })
}

/** 在每测试 tmp dir 里伪造一份 vite build 产物。 */
function makeDist(): string {
  const dist = join(dir, 'dist')
  mkdirSync(join(dist, 'assets'), { recursive: true })
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>memside-ui</title>')
  writeFileSync(join(dist, 'assets', 'app.js'), 'console.log("memside-asset")')
  return dist
}

test('GET / serves index.html when staticDir is provided', async () => {
  const app = makeApp(makeDist())
  const res = await app.fetch(new Request('http://x/'))
  expect(res.status).toBe(200)
  expect(await res.text()).toContain('memside-ui')
})

test('GET /assets/* serves static files when staticDir is provided', async () => {
  const app = makeApp(makeDist())
  const res = await app.fetch(new Request('http://x/assets/app.js'))
  expect(res.status).toBe(200)
  expect(await res.text()).toContain('memside-asset')
})

test('named API routes are not shadowed by static handling', async () => {
  const app = makeApp(makeDist())
  const res = await app.fetch(new Request('http://x/api/memories'))
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body).toEqual({ items: [] })
})

test('GET / does NOT serve static content without staticDir (unchanged behavior)', async () => {
  const app = makeApp()
  const res = await app.fetch(new Request('http://x/'))
  expect(res.status).toBe(404)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/server-static.test.ts`
Expected: FAIL（`staticDir` 不是 AppDeps 成员 / `GET /` 无 index.html）

- [ ] **Step 3: 实现 server.ts 改动**

`src/server.ts` 顶部 import 区加：

```ts
import { join } from 'node:path'
import { serveStatic } from 'hono/bun'
```

`AppDeps` 加一个可选字段（带注释）：

```ts
export interface AppDeps {
  db: DbClient
  adapter: ClaudeCodeAdapter
  enqueueDistillJob: (db: DbClient, input: EnqueueInput) => Promise<{ jobId: string; nextRunAt: number }>
  broadcast: (msg: unknown) => void
  /** 一键启动（生产模式）：vite build 产物目录（src/web/dist）。提供时
   * `GET /` 返回 index.html、`/assets/*` 走 serveStatic；不提供时行为与
   * 之前完全一致（vite dev 模式走 5173，不需要 daemon 托管）。 */
  staticDir?: string
}
```

`createApp` 函数体末尾、`return app` 之前加：

```ts
  // --- Static hosting (one-click launch, production mode) ------------------
  // 注册在末尾：具名路由（/api/*、/inject、/hooks/*）先匹配，静态处理只在
  // 未命中时介入，不会抢占 API（与 CLAUDE.md 的 vite proxy 陷阱同类问题）。
  if (deps.staticDir) {
    app.get('/', serveStatic({ path: join(deps.staticDir, 'index.html') }))
    app.use('/assets/*', serveStatic({ root: deps.staticDir }))
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/server-static.test.ts`
Expected: PASS（4/4）

- [ ] **Step 5: 写失败测试 `tests/daemon-static.test.ts`**

```ts
import { test, expect, beforeAll, beforeEach } from 'bun:test'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startDaemon } from '@/daemon'

// 一键启动（2026-07-28-one-click-launch）：锁 startDaemon 的 serveStaticDir
// 透传——真实 Bun.serve 起来后 GET / 能拿到构建产物。port:0 让 Bun 挑空闲
// 端口，避免与 7777 上可能在跑的 live daemon 冲突。
// 注意：startDaemon 内部自开 db 且不暴露 handle，无法 close；每测试用新鲜
// 子目录、不删目录（EBUSY-safe）。
const root = join(import.meta.dir, '.tmp-daemon-static')
let dir = ''

beforeAll(() => {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
})

beforeEach(() => {
  dir = join(root, Math.random().toString(36).slice(2))
  mkdirSync(dir, { recursive: true })
})

test('startDaemon serves built UI at GET / when serveStaticDir is provided', async () => {
  const dist = join(dir, 'dist')
  mkdirSync(join(dist, 'assets'), { recursive: true })
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>memside-daemon-ui</title>')
  const { server, stop } = await startDaemon({
    dbPath: join(dir, 't.db'),
    port: 0,
    serveStaticDir: dist,
  })
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('memside-daemon-ui')
    // 具名路由不受影响
    const api = await fetch(`http://127.0.0.1:${server.port}/api/memories`)
    expect(api.status).toBe(200)
    expect(await api.json()).toEqual({ items: [] })
  } finally {
    stop()
  }
})
```

- [ ] **Step 6: 跑测试确认失败**

Run: `bun test tests/daemon-static.test.ts`
Expected: FAIL（`serveStaticDir` 不是 DaemonOpts 成员）

- [ ] **Step 7: 实现 daemon.ts 改动**

`DaemonOpts` 加字段：

```ts
export interface DaemonOpts {
  dbPath?: string
  port?: number
  installClaudeHooks?: boolean
  /** 一键启动（生产模式）：vite build 产物目录，透传为 createApp 的
   * staticDir。不传则 daemon 不托管静态文件（裸 daemon 语义不变）。 */
  serveStaticDir?: string
}
```

`startDaemon` 里 createApp 调用改为：

```ts
  const app = createApp({ db, adapter, enqueueDistillJob, broadcast, staticDir: opts.serveStaticDir })
```

- [ ] **Step 8: 跑测试确认通过 + 全量回归**

Run: `bun test tests/daemon-static.test.ts` → PASS
Run: `bun run typecheck && bun test` → 全绿

- [ ] **Step 9: Commit**

```bash
git add src/server.ts src/daemon.ts tests/server-static.test.ts tests/daemon-static.test.ts
git commit -m "feat: daemon 可选托管 vite build 静态产物（一键启动前置）"
```

---

### Task 2: 生产启动脚本 scripts/start.ts + package.json build/start

**Files:**
- Create: `scripts/start.ts`
- Modify: `package.json`（scripts 加 `build`、`start`）
- Modify: `tsconfig.json`（include 加 `"scripts"`）
- Test: `tests/launch-scripts.test.ts`（新建）

**Interfaces:**
- Consumes: `startDaemon({ port, installClaudeHooks, serveStaticDir })`（Task 1）。
- Produces: `bun run build` → `vite build`；`bun run start` → `bun run build && bun run scripts/start.ts`。用户面命令，README（Task 5）引用这两条。

- [ ] **Step 1: 写失败测试 `tests/launch-scripts.test.ts`**

```ts
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// 一键启动（2026-07-28-one-click-launch）：源代码层文本断言兜底（CLAUDE.md
// 允许的运行时最低限度）。锁的是「关键防护不被人顺手删掉」：start.ts 的
// dist 缺失报错、package.json 的命令面。
const repoRoot = join(import.meta.dir, '..')

test('scripts/start.ts errors out with a build hint when dist is missing', () => {
  const src = readFileSync(join(repoRoot, 'scripts', 'start.ts'), 'utf8')
  expect(src).toContain('index.html')
  expect(src).toContain('bun run build')
  expect(src).toContain('process.exit(1)')
})

test('scripts/start.ts starts daemon with hooks + static hosting', () => {
  const src = readFileSync(join(repoRoot, 'scripts', 'start.ts'), 'utf8')
  expect(src).toContain('installClaudeHooks: true')
  expect(src).toContain('serveStaticDir')
})

test('package.json exposes build/start one-click scripts', () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
  expect(pkg.scripts.build).toBe('vite build')
  expect(pkg.scripts.start).toBe('bun run build && bun run scripts/start.ts')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/launch-scripts.test.ts`
Expected: FAIL（scripts/start.ts 不存在）

- [ ] **Step 3: 实现 `scripts/start.ts`**

```ts
#!/usr/bin/env bun
/**
 * 一键启动（生产模式）：daemon 单端口同时服务 API + 构建产物 UI，并幂等
 * 安装 claude code hooks（start-and-install 语义 + 静态托管）。
 *
 * 正常入口是 `bun run start`（package.json 里 `bun run build && bun run
 * scripts/start.ts`），dist 总是新鲜；下面的存在性检查只防御直接调用本
 * 脚本的情况。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { startDaemon } from '@/daemon'

const PORT = Number(process.env.MEMSIDE_PORT ?? 7777)
const distDir = join(import.meta.dir, '..', 'src', 'web', 'dist')

if (!existsSync(join(distDir, 'index.html'))) {
  console.error('memside: src/web/dist/index.html not found - run `bun run build` first')
  process.exit(1)
}

await startDaemon({ port: PORT, installClaudeHooks: true, serveStaticDir: distDir })
console.log(`memside on http://127.0.0.1:${PORT} (UI + API, hooks installed)`)
```

- [ ] **Step 4: package.json 加 scripts + tsconfig include**

`package.json` 的 `"scripts"` 块改为（保留既有三条，加两条）：

```json
  "scripts": {
    "test": "bun test",
    "typecheck": "tsc --noEmit",
    "dev:web": "vite",
    "build": "vite build",
    "start": "bun run build && bun run scripts/start.ts"
  },
```

`tsconfig.json` 的 `"include"` 改为：

```json
  "include": ["src", "tests", "scripts"]
```

- [ ] **Step 5: 跑测试确认通过 + 全量回归**

Run: `bun test tests/launch-scripts.test.ts` → PASS
Run: `bun run typecheck && bun test` → 全绿

- [ ] **Step 6: 手工 smoke（真构建一次）**

Run: `bun run build`
Expected: 产出 `src/web/dist/index.html` + `src/web/dist/assets/*`，无报错。

- [ ] **Step 7: Commit**

```bash
git add scripts/start.ts package.json tsconfig.json tests/launch-scripts.test.ts
git commit -m "feat: bun run build/start 生产模式一键构建启动"
```

---

### Task 3: buildSpawnPlan 纯函数

**Files:**
- Create: `src/launch/spawnPlan.ts`
- Test: `tests/spawn-plan.test.ts`（新建）

**Interfaces:**
- Consumes: 无（纯函数，只读 env 参数）。
- Produces（Task 4 的 `scripts/dev.ts` 依赖）：

```ts
export interface SpawnCmd { cmd: string[] }
export interface SpawnPlan { daemon: SpawnCmd; web: SpawnCmd; port: number }
export function buildSpawnPlan(env: { MEMSIDE_PORT?: string }): SpawnPlan
```

- [ ] **Step 1: 写失败测试 `tests/spawn-plan.test.ts`**

```ts
import { test, expect } from 'bun:test'
import { buildSpawnPlan } from '@/launch/spawnPlan'

// 一键启动（2026-07-28-one-click-launch）：dev 编排的端口/命令决策纯函数层。
// 两条命令都直接跑目标进程（bun run <file> / bun x <bin> 在单个 bun 进程内
// 执行），保证 scripts/dev.ts 杀子进程时不留孙进程残留。

test('default plan: daemon via cli start on 7777, web via bun x vite', () => {
  const plan = buildSpawnPlan({})
  expect(plan.port).toBe(7777)
  expect(plan.daemon.cmd).toEqual(['bun', 'run', 'src/cli.ts', 'start'])
  expect(plan.web.cmd).toEqual(['bun', 'x', 'vite'])
})

test('MEMSIDE_PORT override is reflected in plan.port', () => {
  expect(buildSpawnPlan({ MEMSIDE_PORT: '8888' }).port).toBe(8888)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/spawn-plan.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `src/launch/spawnPlan.ts`**

```ts
/**
 * dev 一键启动的 spawn 计划（纯函数）：给定 env 决定两条子进程命令和
 * daemon 端口。端口决策收敛在这一层是为了可单测；scripts/dev.ts 只做
 * 进程编排，不含决策。
 *
 * 两条命令都选在单个 bun 进程内执行目标的形式（`bun run <file>` /
 * `bun x <bin>`）：dev.ts 杀直接子进程时不会留下孙进程（Windows 上
 * 杀 shell 包装会孤儿化 vite，README 故障排查已有 7777 残留前科）。
 */

export interface SpawnCmd {
  cmd: string[]
}

export interface SpawnPlan {
  daemon: SpawnCmd
  web: SpawnCmd
  port: number
}

const DEFAULT_PORT = 7777

export function buildSpawnPlan(env: { MEMSIDE_PORT?: string }): SpawnPlan {
  const port = Number(env.MEMSIDE_PORT ?? DEFAULT_PORT)
  return {
    daemon: { cmd: ['bun', 'run', 'src/cli.ts', 'start'] },
    web: { cmd: ['bun', 'x', 'vite'] },
    port,
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/spawn-plan.test.ts` → PASS（2/2）

- [ ] **Step 5: Commit**

```bash
git add src/launch/spawnPlan.ts tests/spawn-plan.test.ts
git commit -m "feat: dev 编排 spawn 计划纯函数 buildSpawnPlan"
```

---

### Task 4: 开发编排脚本 scripts/dev.ts + package.json dev

**Files:**
- Create: `scripts/dev.ts`
- Modify: `package.json`（scripts 加 `dev`）
- Test: `tests/launch-scripts.test.ts`（追加 dev 断言）

**Interfaces:**
- Consumes: `buildSpawnPlan(env): SpawnPlan`（Task 3，签名见 Task 3 Interfaces）。
- Produces: `bun run dev` → `bun run scripts/dev.ts`。回收语义：任一子进程先退出 → 杀另一个、以先退者的退出码退出；SIGINT/SIGTERM → 杀两个。

- [ ] **Step 1: 追加失败测试到 `tests/launch-scripts.test.ts`**

在 Task 2 创建的文件末尾追加：

```ts
test('scripts/dev.ts reaps both children on signals and first-exit', () => {
  const src = readFileSync(join(repoRoot, 'scripts', 'dev.ts'), 'utf8')
  expect(src).toContain("process.on('SIGINT'")
  expect(src).toContain("process.on('SIGTERM'")
  expect(src).toContain('daemon.kill()')
  expect(src).toContain('web.kill()')
})

test('scripts/dev.ts prefixes child output lines with [daemon] / [web]', () => {
  const src = readFileSync(join(repoRoot, 'scripts', 'dev.ts'), 'utf8')
  expect(src).toContain('[${name}]')
  expect(src).toContain("spawnLogged('daemon'")
  expect(src).toContain("spawnLogged('web'")
})

test('package.json exposes dev one-click script', () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
  expect(pkg.scripts.dev).toBe('bun run scripts/dev.ts')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/launch-scripts.test.ts`
Expected: FAIL（scripts/dev.ts 不存在 / pkg.scripts.dev undefined）

- [ ] **Step 3: 实现 `scripts/dev.ts`**

```ts
#!/usr/bin/env bun
/**
 * 一键启动（开发模式）：同时拉起 daemon（7777）+ vite dev（5173，热更新），
 * 输出逐行加 [daemon] / [web] 前缀。
 *
 * 回收语义（不留残留进程）：
 * - 任一子进程先退出 -> 杀另一个 -> 以先退者的退出码退出；
 * - 主进程收 SIGINT/SIGTERM -> 杀两个子进程后退出。
 */
import { buildSpawnPlan } from '@/launch/spawnPlan'

const plan = buildSpawnPlan(process.env)

function spawnLogged(name: string, cmd: string[]) {
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe', env: process.env })
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder()
    let buf = ''
    for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const l of lines) console.log(`[${name}] ${l}`)
    }
    if (buf) console.log(`[${name}] ${buf}`)
  }
  void pump(proc.stdout)
  void pump(proc.stderr)
  return proc
}

const daemon = spawnLogged('daemon', plan.daemon.cmd)
const web = spawnLogged('web', plan.web.cmd)

let shuttingDown = false
function killAll() {
  if (shuttingDown) return
  shuttingDown = true
  daemon.kill()
  web.kill()
}

process.on('SIGINT', () => { killAll(); process.exit(130) })
process.on('SIGTERM', () => { killAll(); process.exit(143) })

// 先退者决定退出码；killAll 幂等，信号路径与先退路径不冲突。
const code = await Promise.race([daemon.exited, web.exited])
killAll()
await Promise.allSettled([daemon.exited, web.exited])
process.exit(code ?? 1)
```

- [ ] **Step 4: package.json 加 dev script**

`"scripts"` 块在 `"start"` 后加一条：

```json
    "dev": "bun run scripts/dev.ts"
```

- [ ] **Step 5: 跑测试确认通过 + 全量回归**

Run: `bun test tests/launch-scripts.test.ts` → PASS（6/6）
Run: `bun run typecheck && bun test` → 全绿

- [ ] **Step 6: Commit**

```bash
git add scripts/dev.ts package.json tests/launch-scripts.test.ts
git commit -m "feat: bun run dev 开发模式一键双进程启动"
```

---

### Task 5: README 更新

**Files:**
- Modify: `README.md`（快速开始、使用教程第 1-2 步、CLI 命令、开发、故障排查，共 5 处）

**Interfaces:**
- Consumes: Task 2/4 落地的命令面（`bun run build` / `bun run start` / `bun run dev`）。
- Produces: 无代码接口；用户文档。

- [ ] **Step 1: 「快速开始」替换**

把 ````bash` 块（`git clone` 到 `bun run dev:web` 那段）替换为：

````markdown
```bash
git clone <this-repo> memside && cd memside
bun install
bun run start   # 构建前端 + 启动 daemon + 装 hooks -> http://localhost:7777
```

跑完上面两步,memside 就在后台工作了:浏览器开 `http://localhost:7777`
就是审批 UI。然后**正常用 claude code**即可--不用改你的使用习惯。

> 开发调试想保留前端热更新,用 `bun run dev`(daemon + vite dev 双进程,
> UI 在 5173)。旧的分布命令(`bun run src/cli.ts start-and-install` +
> `bun run dev:web`)仍然可用。
````

（原块下面那段「跑完上面三步,memside 就在后台工作了……」及 `> 上面的 bun run src/cli.ts...` 注记删除，被上述文字取代。）

- [ ] **Step 2: 「使用教程」第 1、2 步合并**

第 1 步整节替换为：

````markdown
### 第 1 步:一键启动 + 打开 web UI

```bash
bun run start
```

输出 `memside on http://127.0.0.1:7777 (UI + API, hooks installed)` 就对了
(daemon 在跑、hooks 已装、UI 已托管)。如果提示端口占用,说明 daemon 已经
在跑了,改用 `bun run src/cli.ts install` 只补装 hooks 即可。

浏览器开 `http://localhost:7777`。此时审批队列是空的--还没有候选记忆。
````

原「### 第 2 步:打开 web UI」整节删除，后续第 3-6 步重新编号为第 2-5 步
（标题里的数字改掉，内容不变）。

- [ ] **Step 3: 「CLI 命令」节首加一键脚本表**

在「## CLI 命令」标题下、原有说明段之前插入：

````markdown
## 一键脚本(推荐日常入口)

| 命令 | 作用 |
|---|---|
| `bun run start` | 生产模式:构建前端 + daemon 单端口(7777)同时服务 UI/API + 幂等装 hooks |
| `bun run dev` | 开发模式:daemon(7777) + vite dev(5173) 双进程,日志带 `[daemon]`/`[web]` 前缀,Ctrl+C 一并回收 |
| `bun run build` | 只构建前端到 `src/web/dist/`(`bun run start` 每次都会先跑它) |

## CLI 命令
````

（原「## CLI 命令」标题降级为跟随其后的说明段，即把原标题行替换为上面整块。）

- [ ] **Step 4: 「开发」一节补 dev 命令**

把「## 开发」下的代码块替换为：

````markdown
```bash
bun test              # 测试套件
bun run typecheck     # tsc --noEmit
bun run dev           # 一键双进程:daemon(7777) + vite dev(5173,代理到 :7777)
bun run dev:web       # 只起 vite dev(5173)——需要 daemon 已单独在跑
```
````

- [ ] **Step 5: 「故障排查」启动命令同步**

「会话变慢/卡顿」一条里的「启动它:`bun run src/cli.ts start`(或
`start-and-install`)」改为「启动它:`bun run start`(构建+daemon+hooks 一
条命令;不想重新构建就用 `bun run src/cli.ts start`)」。

- [ ] **Step 6: 全量回归 + Commit**

Run: `bun run typecheck && bun test` → 全绿（README 改动不应影响，作为门槛照跑）

```bash
git add README.md
git commit -m "docs: README 快速开始/教程/命令面切到一键脚本"
```

---

## Self-Review 记录

- **Spec coverage**：§4.1 命令面 → Task 2/4；§4.2 静态托管 → Task 1；§4.3 start.ts → Task 2；§4.4 dev.ts + buildSpawnPlan → Task 3/4；§4.5 README → Task 5；§4.7 失败模式 → 各 task 实现 + Task 2 Step 6 手工 smoke；§4.8 测试策略 4 条 → Task 1/2/3/4 测试全覆盖。`.gitignore` 经核实已有 `dist/`，spec 该项无需落地（Global Constraints 已注明）。
- **Placeholder scan**：无 TBD/TODO；所有代码步骤含完整代码。
- **Type consistency**：`staticDir`（AppDeps）/ `serveStaticDir`（DaemonOpts）命名在 Task 1/2 间一致；`SpawnPlan`/`SpawnCmd`/`buildSpawnPlan` 在 Task 3 定义、Task 4 消费，签名一致。

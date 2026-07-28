# 一键构建启动前后端脚本 - 设计 spec

日期：2026-07-28
分支：`feat/one-click-launch`
状态：设计已与用户逐段确认通过（含 README 更新补充），待用户复核 spec 文件。

## 1. 背景

memside 目前的启动方式是两条命令、两个终端：

```bash
bun run src/cli.ts start-and-install   # 终端 1：daemon (7777)
bun run dev:web                        # 终端 2：vite dev (5173)
```

日常使用（非开发）其实不需要 vite dev server 的热更新，却被迫开两个终端、记两个端口。
需求：提供**一键构建并启动前后端**的脚本，覆盖两种场景——日常使用的生产模式
（单命令、单端口）和开发调试的开发模式（单命令、双进程、保留热更新）。

### 关键现状（摸底结论）

1. **后端无构建步骤。** Bun 直接跑 TS，`src/cli.ts start` 即起 daemon。
2. **前端只有 dev，没有 build。** `package.json` scripts 只有 `dev:web`（vite dev）；
   从未配置过 `vite build`，也没有静态托管——daemon（`src/server.ts` 的 Hono app）
   只服务 `/api/*`、`/inject`、`/hooks/*` 三组路由。
3. **vite root 是 `src/web`**，默认 build 产物落在 `src/web/dist/`。
4. **CLI 已有三种命令**：`start` / `install` / `start-and-install`（`src/cli.ts`），
   install 幂等。
5. **vite proxy 陷阱**（CLAUDE.md 明示）：proxy 键必须 `/api/` 带尾斜杠；本设计不动
   proxy 配置，但静态托管接入时必须保证 API 路由优先级不被静态回退抢走。

## 2. 目标 / 非目标

### 目标

- **生产模式一键**：`bun run start` = 构建前端（`vite build`）→ 起 daemon（7777）
  同时服务 API + 静态 UI + 幂等装 hooks。浏览器开 `http://localhost:7777` 即用，
  单命令、单终端、单端口。
- **开发模式一键**：`bun run dev` = 单命令同时拉起 daemon（7777）+ vite dev（5173），
  保留前端热更新；日志可区分来源；Ctrl+C 一并回收两个进程。
- **README 同步**：快速开始、使用教程、CLI 命令、开发、故障排查各节更新到新命令面。
- 旧命令（`bun run src/cli.ts ...`、`bun run dev:web`）保持可用，不破坏现有习惯。

### 非目标（YAGNI）

- ❌ 自动打开浏览器。用户自己开，少一个跨平台差异点。
- ❌ 端口占用自动切换 / 探测。端口被占就报错透出，不静默换端口（hooks 里写死了
  端口，静默换端口会让 capture/inject 全断）。
- ❌ Windows 双击用的 .ps1/.bat 包装。用户已选定 bun 脚本形式。
- ❌ watch 模式自动 rebuild（生产模式每次启动都重新 build，已够）。
- ❌ SPA 前端路由 fallback。Web UI 是单页无路由，`GET /` 返回 index.html 即可，
  不做任意路径回退。
- ❌ 改动 vite proxy 配置、daemon 端口结构、hook 安装逻辑本身。

## 3. 用户确认的关键决策

| 决策 | 选项 | 用户选定 |
|------|------|----------|
| 一键启动的形态 | 生产单端口 / 开发双进程 / 两个都要 | **两个都要**（两种模式各一条命令） |
| 脚本承载形式 | bun 脚本 + package.json / PowerShell / 两者 | **bun 脚本 + package.json** |
| 生产模式构建策略 | 总是先构建 / 缺才构建 / build 与 start 分开 | **总是先构建再启动**（保证前端永远最新） |
| README | 不动 / 同步更新 | **同步更新**（用户主动补充） |

方案层面：采用「bun 脚本编排 + daemon 托管静态产物」（对比过 concurrently 类工具
——只为拼命令多一个依赖、且生产模式仍需自己解决静态托管，放弃；纯 shell/ps1 与
用户选定的承载形式矛盾，放弃）。

## 4. 设计

### 4.1 命令面（package.json scripts）

新增三条 scripts：

| 命令 | 内容 | 用途 |
|------|------|------|
| `bun run build` | `vite build` | 只构建前端到 `src/web/dist/` |
| `bun run start` | `bun run build && bun run scripts/start.ts` | 生产：构建 + daemon 单端口全托管 |
| `bun run dev` | `bun run scripts/dev.ts` | 开发：daemon + vite dev 双进程 |

既有 `dev:web`、`test`、`typecheck` 不动。`src/web/dist/` 加入 `.gitignore`。

### 4.2 静态托管（server.ts / daemon.ts 小改）

- `buildApp` 增加可选参数 `staticDir?: string`。提供时：
  - 三组既有路由（`/api/*`、`/inject`、`/hooks/*`）**注册顺序与行为完全不变**，
    Hono 先匹配具名路由，静态处理只在未命中时介入。
  - `GET /` 返回 `staticDir/index.html`；`/assets/*` 等静态文件用 `hono/bun` 的
    `serveStatic` 服务。
  - 不提供 `staticDir` 时行为与现状逐字节一致（vite dev 模式走 5173，不需要它）。
- `startDaemon` 增加对应选项 `serveStaticDir?: string`，透传给 `buildApp`。
- `src/cli.ts` 的 `start` / `start-and-install` **不传** `serveStaticDir`，保持现状
  （这两条仍是「裸 daemon」语义，给不需要 UI 托管的场景）。

### 4.3 生产启动脚本（scripts/start.ts）

流程：

1. 检查 `src/web/dist/index.html` 存在；不存在则报错退出（提示先跑 `bun run build`）。
   正常流程 `bun run start` 总是先 build，这步是防御直接调脚本的情况。
2. 调 `startDaemon({ port: MEMSIDE_PORT ?? 7777, installClaudeHooks: true,
   serveStaticDir: <repo>/src/web/dist })`——即 start-and-install 语义 + 静态托管。
   hooks 安装幂等，每次启动顺带校正不亏。
3. 打印访问入口：`memside on http://127.0.0.1:<port> (UI + API + hooks installed)`。

### 4.4 开发编排脚本（scripts/dev.ts）

- 抽纯函数 `buildSpawnPlan(env): { daemon: SpawnCmd; web: SpawnCmd }`，给定 env 返回
  两条 spawn 命令描述（daemon 端口取 `MEMSIDE_PORT ?? 7777`；web 固定 `vite` dev，
  端口 5173 由 vite 默认）。纯函数层承载端口决策，便于单测。
- 运行时：`Bun.spawn` 两个子进程，stdout/stderr 逐行加 `[daemon]` / `[web]` 前缀
  转发到主进程。
- 回收语义：**任一进程退出 → 杀另一个 → 主进程以相同退出码退出**；主进程收到
  SIGINT/SIGTERM → 杀两个子进程后退出。不留残留进程（README 故障排查里已有
  Windows 残留 bun 占 7777 的前科，不能再添一个来源）。

### 4.5 README 更新

- 「快速开始」：`bun install` → `bun run start` 一条命令，浏览器开
  `http://localhost:7777`。取代现在「daemon 一终端 + dev:web 另一终端」的写法；
  保留一句说明旧命令仍可用。
- 「使用教程」第 1、2 步合并：一条 `bun run start` + 开 7777。
- 新增/并入命令说明：`bun run start`（生产：build + 单端口全托管）、
  `bun run dev`（开发：双进程热更新）、`bun run build`（只构建前端）。
- 「开发」一节补 `bun run dev`；「故障排查」中启动 daemon 的示例命令同步指向
  `bun run start`。
- 「配置参考」表无需新增行（端口仍由 `MEMSIDE_PORT` 控制）。

### 4.6 与现有模块的耦合点

| 模块 | 改动 | 风险 |
|------|------|------|
| `src/server.ts` `buildApp` | 加可选 `staticDir` | 静态处理必须在具名路由之后注册，不能抢 `/api/*`（CLAUDE.md proxy 陷阱同类问题） |
| `src/daemon.ts` `startDaemon` | 加可选 `serveStaticDir` 透传 | 无，纯透传 |
| `src/cli.ts` | 不改 | 保持裸 daemon 语义 |
| `package.json` | 加 3 条 scripts | `start` 名字与 `src/cli.ts start` 子命令撞词，README 里区分清楚 |
| `vite.config.ts` | 不改 | build 默认 outDir 即 `src/web/dist` |
| `.gitignore` | 加 `src/web/dist/` | - |
| `README.md` | 上述 5 处 | - |

### 4.7 失败模式

| 场景 | 行为 |
|------|------|
| `vite build` 失败 | `bun run start` 的 `&&` 链中止，vite 错误原样透出，daemon 不起 |
| 直接跑 `scripts/start.ts` 但 dist 缺失 | 报错退出，提示先 `bun run build` |
| 7777 被占 | daemon 启动报错原样透出（不静默换端口，见非目标） |
| dev 模式 vite 或 daemon 任一侧挂掉 | 另一侧被杀，主进程以相同退出码退出，无残留 |
| dev 模式 Ctrl+C | SIGINT 回收两个子进程 |
| dist 存在但内容旧 | 不会发生：`bun run start` 总是先 build（用户选定策略） |

### 4.8 测试策略

按 CLAUDE.md：纯函数层写足测试，运行时层留少量集成断言 + 文本断言兜底。

1. **`buildSpawnPlan` 纯函数单测**（正向/边界）：默认端口 7777、
   `MEMSIDE_PORT` 覆盖后 daemon 命令带正确端口、web 命令恒为 vite dev。
2. **静态托管集成测试**（在现有 server 测试的 app 层，用 tmp 目录伪造 dist）：
   - `staticDir` 提供时 `GET /` 返回 index.html 内容；
   - `GET /api/memories` 等具名路由不受静态处理影响（防路由抢占回归）；
   - 不提供 `staticDir` 时 `GET /` 不返回静态内容（现状不变回归）。
3. **文本断言兜底**：`scripts/start.ts` 含 dist 缺失的报错提示文案；
   `scripts/dev.ts` 含 SIGINT/SIGTERM 回收逻辑（`process.on` 字样）。
4. 运行门槛：`bun run typecheck && bun test` 全绿才可 push。

## 5. 验收清单

- [ ] `bun run build` 产出 `src/web/dist/index.html` + assets
- [ ] `bun run start` 一条命令后，浏览器开 7777 能看到审批 UI 且 `/api/memories` 正常
- [ ] `bun run start` 后 hooks 已装（`~/.claude/settings.json` 含 memside 条目）
- [ ] `bun run dev` 一条命令拉起双进程，7777 API 通、5173 页面热更新可用，
      日志带 `[daemon]` / `[web]` 前缀
- [ ] dev 模式 Ctrl+C 后无 7777/5173 残留进程
- [ ] `bun run src/cli.ts start` 旧行为不变（裸 daemon，不托管静态）
- [ ] README 五处更新落地
- [ ] `bun run typecheck && bun test` 全绿（含新增测试）

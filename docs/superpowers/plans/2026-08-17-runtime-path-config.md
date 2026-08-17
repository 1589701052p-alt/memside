# 运行环境自定义路径配置 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 memside 能把 claude hooks 装到自定义路径（如 codeagent 的 `~/.cac/setting.json`），用户在 Web UI「设置」tab 配置路径 + 一键安装/卸载 hooks，daemon 与 CLI 启动时读已存配置装到对应路径。

**Architecture:** 复用既有 `app_settings` 表 + `install.ts` 的 idempotent-merge 模式。新增 `RuntimePaths` 配置（三字段落库）+ `installHooks` 加 `settingsFilename` 参数 + `uninstallHooks`（与 install 对偶，按 `MEMSIDE_TAG` marker 移除）+ 4 个 `/api/settings/runtime*` 端点 + Web UI `RuntimeSettings` section。daemon/launcher 启动安装经 `startDaemon` 读 db 配置透传，CLI 透传，全程默认值零回归。

**Tech Stack:** Bun + Hono + Drizzle + bun:sqlite + zod + React 19（既有栈，无新依赖）。

**Spec:** `docs/superpowers/specs/2026-08-17-runtime-path-config-design.md`

## Global Constraints

- **运行门槛**：`bun run typecheck && bun test` 必须全绿才能 push（CLAUDE.md 硬约束）。
- **测试随改动落地**：每任务带正向/边界/错误路径测试；纯函数层优先，运行时组件最低限度源码层文本断言兜底。
- **默认值零回归**：`installHooks` 不传 `settingsFilename` 时必须与旧行为逐字节一致（写 `~/.claude/settings.json`）。
- **不碰的模块**：`creds.ts` / distiller / adapter / scheduler / `installOpencodePlugin` / launcher.ts 本体（经 startDaemon 透传即可）。
- **错误可见性**：install/uninstall 失败不静默，端点返回错误信息让 UI 显横幅（CLAUDE.md 状态可见性）。
- **路径解析**：`installHooks` 的 baseDir 用 `resolveHome()`（已存在）；`loadRuntimePaths` 默认值用同款 `resolveHome()`。存原始字符串，install 端读出后若以 `~` 开头走 `resolveHome` 展开（spec §6.3 决策）。
- **`opencodeDir` 本次存而不用**：UI install/uninstall 端点只管 claude hooks（opencode 安装走 CLI/launcher，spec §6.6）。
- **分支**：从最新 `origin/master` 切 `feat/runtime-path-config`，PR 回 master（CLAUDE.md 禁直推 master）。

---

## File Structure

| 文件 | 责任 | 改动类型 |
|---|---|---|
| `src/settings.ts` | `RuntimePaths` 接口 + `loadRuntimePaths`/`saveRuntimePaths`（app_settings 读写，字段级合并，缺失回默认） | 新增（追加到既有文件） |
| `src/install.ts` | `InstallOpts` 加 `settingsFilename?`；`installHooks` 用之；新增 `uninstallHooks` | 修改 + 新增函数 |
| `src/daemon.ts` | `startDaemon` 在 `installClaudeHooks:true` 时读 `loadRuntimePaths(db)` 透传给 `installHooks`（存储异常降级默认） | 修改 |
| `src/cli.ts` | `install`/`start-and-install` 读 db 配置透传给 `installHooks` | 修改 |
| `src/server.ts` | `AppDeps` 加可选 `installHooksFn?`/`uninstallHooksFn?` 注入点；4 个 `/api/settings/runtime*` 端点 | 修改 |
| `src/web/api.ts` | `getRuntimeSettings`/`saveRuntimeSettings`/`installRuntimeHooks`/`uninstallRuntimeHooks` wrapper + `RuntimeSettingsState` 类型 | 新增（追加） |
| `src/web/App.tsx` | `RuntimeSettings` section 组件 + 挂载点追加 | 修改 |
| `tests/settings.test.ts` | `loadRuntimePaths`/`saveRuntimePaths` 纯函数测试（追加） | 新增测试 |
| `tests/install.test.ts` | `installHooks` settingsFilename 测试 + `uninstallHooks` 测试（追加） | 新增测试 |
| `tests/settings-runtime-api.test.ts` | 4 个 `/api/settings/runtime*` 端点测试（新建） | 新建测试 |
| `tests/web-api.test.ts` | 4 个 runtime wrapper 形状断言（追加） | 新增测试 |
| `tests/app-source-assertions.test.ts` | `RuntimeSettings` section + 按钮源码层文本断言（新建或追加） | 新建测试 |

---

## Task 1: RuntimePaths 配置读写（settings.ts）

**Files:**
- Modify: `src/settings.ts`（追加在文件末尾，JudgeConfig 段之后）
- Test: `tests/settings.test.ts`（追加）

**Interfaces:**
- Consumes: `appSettings` 表（`src/db/schema.ts`，既有）；`DbClient`（`src/db/client.ts`，既有）；`resolveHome` 模式（参考 `src/creds.ts:23`，但 settings.ts 不导入 creds.ts——这里默认值用 `os.homedir()` + env，与 creds.ts 同语义，独立导出 `defaultRuntimePaths()` 避免循环依赖）。
- Produces:
  - `export interface RuntimePaths { claudeDir: string; settingsFilename: string; opencodeDir: string }`
  - `export function defaultRuntimePaths(): RuntimePaths`（返回 `{ claudeDir: join(resolveHome(), '.claude'), settingsFilename: 'settings.json', opencodeDir: join(resolveHome(), '.config', 'opencode') }`）
  - `export function loadRuntimePaths(db: DbClient): RuntimePaths`
  - `export function saveRuntimePaths(db: DbClient, patch: Partial<RuntimePaths>): void`

- [ ] **Step 1: 写失败测试**

追加到 `tests/settings.test.ts` 末尾：

```ts
import { loadRuntimePaths, saveRuntimePaths, defaultRuntimePaths, type RuntimePaths } from '../src/settings'

test('defaultRuntimePaths: 三字段默认值（claudeDir ~/.claude / settings.json / opencode ~/.config/opencode）', () => {
  const d = defaultRuntimePaths()
  expect(d.settingsFilename).toBe('settings.json')
  expect(d.claudeDir.endsWith('.claude')).toBe(true)
  expect(d.opencodeDir.endsWith(join('.config', 'opencode'))).toBe(true)
})

test('loadRuntimePaths: 未配置返回全默认', () => {
  const db = tmpDb()
  expect(loadRuntimePaths(db)).toEqual(defaultRuntimePaths())
})

test('save+load RuntimePaths: 三字段写入后读回', () => {
  const db = tmpDb()
  saveRuntimePaths(db, { claudeDir: '/home/u/.cac', settingsFilename: 'setting.json', opencodeDir: '/home/u/.config/opencode' })
  expect(loadRuntimePaths(db)).toEqual({
    claudeDir: '/home/u/.cac', settingsFilename: 'setting.json', opencodeDir: '/home/u/.config/opencode',
  })
})

test('RuntimePaths 字段级合并: 部分提供保持其余', () => {
  const db = tmpDb()
  saveRuntimePaths(db, { claudeDir: '/x/.cac', settingsFilename: 'setting.json', opencodeDir: '/x/.config/opencode' })
  saveRuntimePaths(db, { settingsFilename: 'other.json' }) // 只改文件名
  expect(loadRuntimePaths(db)).toEqual({
    claudeDir: '/x/.cac', settingsFilename: 'other.json', opencodeDir: '/x/.config/opencode',
  })
})

test('RuntimePaths 空串 = 回默认（删该 key）', () => {
  const db = tmpDb()
  saveRuntimePaths(db, { claudeDir: '/x/.cac', settingsFilename: 'setting.json' })
  saveRuntimePaths(db, { claudeDir: '', settingsFilename: '' }) // 空串删
  const got = loadRuntimePaths(db)
  expect(got.claudeDir).toBe(defaultRuntimePaths().claudeDir)
  expect(got.settingsFilename).toBe('settings.json')
})

test('RuntimePaths 脏数据（非字符串）回默认不抛', () => {
  const db = tmpDb()
  // 直接往 app_settings 写非法值（绕过 saveRuntimePaths 的类型约束）
  db.insert(appSettings).values({ key: 'runtime.claude_dir', value: '123', updatedAt: 0 }).run()
  db.insert(appSettings).values({ key: 'runtime.settings_filename', value: '', updatedAt: 0 }).run()
  const got = loadRuntimePaths(db)
  // 123 是字符串 -> 原样用；空串 -> 回默认
  expect(got.claudeDir).toBe('123')
  expect(got.settingsFilename).toBe('settings.json')
})
```

注意：`tmpDb()` 与 `appSettings` import 已在该文件现有内容中可能缺失——检查文件头，若 `appSettings` 未导入，追加 import：`import { appSettings } from '../src/db/schema'`。`tmpDb()` 已在文件顶部定义（见 settings.test.ts:10）。

- [ ] **Step 2: 运行测试验证失败**

Run: `bun test tests/settings.test.ts`
Expected: FAIL（`loadRuntimePaths` 未导出 / is not a function）

- [ ] **Step 3: 写实现**

追加到 `src/settings.ts` 末尾（在 `saveJudgeConfig` 之后）：

```ts
import { homedir } from 'node:os'
// 注：settings.ts 顶部已有 eq / DbClient / appSettings / JudgeConfig import。
// homedir 顶部若未导入，在文件已有的 node:os import 行补；若无则加这行。

// --- 运行环境路径配置（spec 2026-08-17-runtime-path-config）-----------------
// codeagent 读 ~/.cac/setting.json（目录与文件名双双不同于标准 ~/.claude/settings.json）。
// 用户在 UI 配置路径，install 据此装到正确文件。三字段落 app_settings，缺失回默认。

/** portably resolve home (mirrors resolveHome in creds.ts / install.ts). */
function resolveHome(): string {
  return process.env.HOME || process.env.USERPROFILE || homedir()
}

export interface RuntimePaths {
  /** claude 配置目录，默认 ~/.claude。 */
  claudeDir: string
  /** claude settings 文件名，默认 'settings.json'。codeagent 用 'setting.json'。 */
  settingsFilename: string
  /** opencode 配置目录，默认 ~/.config/opencode（nga 标准路径）。本次存而不用。 */
  opencodeDir: string
}

const RUNTIME_KEYS = {
  claudeDir: 'runtime.claude_dir',
  settingsFilename: 'runtime.settings_filename',
  opencodeDir: 'runtime.opencode_dir',
} as const

/** 三字段默认值（与 install.ts/creds.ts 既有默认路径一致，零回归基准）。 */
export function defaultRuntimePaths(): RuntimePaths {
  return {
    claudeDir: join(resolveHome(), '.claude'),
    settingsFilename: 'settings.json',
    opencodeDir: join(resolveHome(), '.config', 'opencode'),
  }
}

/** 读取：缺失/空串逐字段回默认；脏数据字符串原样用、空串回默认。 */
export function loadRuntimePaths(db: DbClient): RuntimePaths {
  const rows = db.select().from(appSettings).all()
  const map = new Map(rows.map((r) => [r.key, r.value]))
  const d = defaultRuntimePaths()
  const claudeDir = map.get(RUNTIME_KEYS.claudeDir)
  const settingsFilename = map.get(RUNTIME_KEYS.settingsFilename)
  const opencodeDir = map.get(RUNTIME_KEYS.opencodeDir)
  return {
    claudeDir: claudeDir && claudeDir.length > 0 ? claudeDir : d.claudeDir,
    settingsFilename: settingsFilename && settingsFilename.length > 0 ? settingsFilename : d.settingsFilename,
    opencodeDir: opencodeDir && opencodeDir.length > 0 ? opencodeDir : d.opencodeDir,
  }
}

/**
 * 字段级合并写（同 saveUiLlmConfig 语义）：提供才写；空串 = 删该 key（回默认）。
 * 非字符串值不会进 patch（TS 类型守卫 + server 层校验）。
 */
export function saveRuntimePaths(db: DbClient, patch: Partial<RuntimePaths>): void {
  const upsert = (key: string, value: string) => {
    db.insert(appSettings).values({ key, value, updatedAt: Date.now() })
      .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: Date.now() } }).run()
  }
  const del = (key: string) => db.delete(appSettings).where(eq(appSettings.key, key)).run()
  if (patch.claudeDir !== undefined) { patch.claudeDir === '' ? del(RUNTIME_KEYS.claudeDir) : upsert(RUNTIME_KEYS.claudeDir, patch.claudeDir) }
  if (patch.settingsFilename !== undefined) { patch.settingsFilename === '' ? del(RUNTIME_KEYS.settingsFilename) : upsert(RUNTIME_KEYS.settingsFilename, patch.settingsFilename) }
  if (patch.opencodeDir !== undefined) { patch.opencodeDir === '' ? del(RUNTIME_KEYS.opencodeDir) : upsert(RUNTIME_KEYS.opencodeDir, patch.opencodeDir) }
}
```

注意：`join` 已在 settings.ts 顶部导入（检查 `import { join } from 'node:path'`，若无则补）。`eq`、`appSettings`、`DbClient` 顶部已有。

- [ ] **Step 4: 运行测试验证通过**

Run: `bun test tests/settings.test.ts`
Expected: PASS（所有新旧测试绿）

- [ ] **Step 5: typecheck**

Run: `bun run typecheck`
Expected: 无错

- [ ] **Step 6: commit**

```bash
git add src/settings.ts tests/settings.test.ts
git commit -m "feat: add RuntimePaths config (load/save + defaults) for custom hook paths"
```

---

## Task 2: installHooks 加 settingsFilename + uninstallHooks（install.ts）

**Files:**
- Modify: `src/install.ts:23-31`（`InstallOpts` 加字段）、`src/install.ts:109-151`（`installHooks` 用 settingsFilename）、追加 `uninstallHooks`
- Test: `tests/install.test.ts`（追加）

**Interfaces:**
- Consumes: `MEMSIDE_TAG`（既有）、`EVENTS`（既有）、`resolveHome`（既有，install.ts:58）
- Produces:
  - `InstallOpts.settingsFilename?: string`（新增可选字段）
  - `export function uninstallHooks(opts: { baseDir?: string; settingsFilename?: string }): { removed: number; settingsPath: string }`（新增）

- [ ] **Step 1: 写失败测试**

追加到 `tests/install.test.ts` 末尾：

```ts
import { uninstallHooks } from '@/install'

test('installHooks writes to custom settingsFilename (e.g. codeagent setting.json)', () => {
  // 在 fakeHome 下模拟 codeagent 的 ~/.cac/setting.json
  const cacDir = join(fakeHome, '.cac')
  mkdirSync(cacDir, { recursive: true })
  installHooks({ port: 7777, baseDir: cacDir, settingsFilename: 'setting.json' })
  // 文件名是 setting.json 不是 settings.json
  expect(existsSync(join(cacDir, 'setting.json'))).toBe(true)
  expect(existsSync(join(cacDir, 'settings.json'))).toBe(false)
  const raw = JSON.parse(readFileSync(join(cacDir, 'setting.json'), 'utf-8'))
  expect(JSON.stringify(raw.hooks)).toContain(MEMSIDE_TAG)
  expect(JSON.stringify(raw.hooks)).toContain('/hooks/claude/Stop')
})

test('installHooks without settingsFilename defaults to settings.json (regression)', () => {
  // 不传 settingsFilename -> 必须写 settings.json（旧行为，零回归）
  installHooks({ port: 7777 })
  expect(existsSync(join(fakeHome, '.claude', 'settings.json'))).toBe(true)
})

test('uninstallHooks removes memside-managed groups, preserves user hooks', () => {
  // 先装 + 加一个用户自写 hook
  installHooks({ port: 7777 })
  const settingsPath = join(fakeHome, '.claude', 'settings.json')
  const raw = JSON.parse(readFileSync(settingsPath, 'utf-8'))
  // 注入一个用户自写 hook（无 MEMSIDE_TAG marker）
  raw.hooks.Stop.push({ matcher: '*', hooks: [{ type: 'command', command: 'echo user-keep' }] })
  writeFileSync(settingsPath, JSON.stringify(raw))

  const r = uninstallHooks({})
  expect(r.removed).toBeGreaterThan(0)
  expect(r.settingsPath).toBe(settingsPath)
  const after = JSON.parse(readFileSync(settingsPath, 'utf-8'))
  // memside marker 消失
  expect(JSON.stringify(after.hooks)).not.toContain(MEMSIDE_TAG)
  // 用户自写 hook 保留
  expect(JSON.stringify(after.hooks.Stop)).toContain('echo user-keep')
})

test('uninstallHooks on missing file returns removed:0, no throw', () => {
  // 先删 settings.json
  rmSync(join(fakeHome, '.claude', 'settings.json'), { force: true })
  const r = uninstallHooks({})
  expect(r.removed).toBe(0)
})

test('uninstallHooks is idempotent (second run removes nothing)', () => {
  installHooks({ port: 7777 })
  uninstallHooks({})
  const second = uninstallHooks({})
  expect(second.removed).toBe(0)
})

test('uninstallHooks respects custom settingsFilename', () => {
  const cacDir = join(fakeHome, '.cac')
  mkdirSync(cacDir, { recursive: true })
  installHooks({ port: 7777, baseDir: cacDir, settingsFilename: 'setting.json' })
  const r = uninstallHooks({ baseDir: cacDir, settingsFilename: 'setting.json' })
  expect(r.removed).toBeGreaterThan(0)
  expect(r.settingsPath).toBe(join(cacDir, 'setting.json'))
  const after = JSON.parse(readFileSync(join(cacDir, 'setting.json'), 'utf-8'))
  expect(JSON.stringify(after.hooks)).not.toContain(MEMSIDE_TAG)
})
```

注意：`existsSync`, `writeFileSync` 已在文件顶部 import（install.test.ts:2）。`join` 已 import。

- [ ] **Step 2: 运行测试验证失败**

Run: `bun test tests/install.test.ts`
Expected: FAIL（`uninstallHooks` 未导出；`settingsFilename` 参数未生效）

- [ ] **Step 3: 修改 InstallOpts 接口**

在 `src/install.ts:23-30` 的 `InstallOpts` 接口加字段：

```ts
export interface InstallOpts {
  port: number
  /**
   * Override the claude config dir (default `~/.claude`). Tests pass a tmp dir
   * so they never touch the real user settings.
   */
  baseDir?: string
  /**
   * Override the claude settings filename (default `settings.json`).
   * codeagent fork reads `~/.cac/setting.json` (singular), so this lets the
   * install land in the file the agent actually reads. Default keeps the
   * legacy `settings.json` behavior byte-for-byte.
   */
  settingsFilename?: string
}
```

- [ ] **Step 4: 修改 installHooks 用 settingsFilename**

在 `src/install.ts:109` 的 `installHooks` 函数体内，把：

```ts
const claudeDir = opts.baseDir ?? join(resolveHome(), '.claude')
mkdirSync(claudeDir, { recursive: true })
const settingsPath = join(claudeDir, 'settings.json')
```

改为：

```ts
const claudeDir = opts.baseDir ?? join(resolveHome(), '.claude')
mkdirSync(claudeDir, { recursive: true })
const settingsPath = join(claudeDir, opts.settingsFilename ?? 'settings.json')
```

（仅 `settingsPath` 那一行改：`'settings.json'` → `opts.settingsFilename ?? 'settings.json'`。其余 idempotent-merge 逻辑逐字不动。）

- [ ] **Step 5: 写 uninstallHooks**

在 `src/install.ts` 的 `installHooks` 函数之后（`installOpencodePlugin` 之前）追加：

```ts
/**
 * Remove memside-managed hook groups from the claude settings file — the
 * idempotent-merge dual of `installHooks`. For each of the five EVENTS,
 * drops any matcher-group whose command list contains the `MEMSIDE_TAG`
 * marker (i.e. memside's own entries); user-authored hooks (no marker) are
 * always preserved.
 *
 * Resolves the same settings path as `installHooks` (baseDir + settingsFilename,
 * defaults `~/.claude` / `settings.json`). Missing file or malformed JSON ->
 * `removed:0`, never throws (mirrors installHooks's never-throw contract).
 *
 * Returns `{ removed, settingsPath }` where `removed` is the total count of
 * memside-managed groups removed across all five events.
 */
export function uninstallHooks(opts: { baseDir?: string; settingsFilename?: string }): { removed: number; settingsPath: string } {
  const claudeDir = opts.baseDir ?? join(resolveHome(), '.claude')
  const settingsPath = join(claudeDir, opts.settingsFilename ?? 'settings.json')
  if (!existsSync(settingsPath)) return { removed: 0, settingsPath }

  let settings: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      settings = parsed as Record<string, unknown>
    } else {
      return { removed: 0, settingsPath }
    }
  } catch {
    // malformed settings.json: nothing to remove, no throw
    return { removed: 0, settingsPath }
  }

  const hooks = settings.hooks as Record<string, unknown[]> | undefined
  if (!hooks || typeof hooks !== 'object') return { removed: 0, settingsPath }

  let removed = 0
  for (const ev of EVENTS) {
    let groups = hooks[ev]
    if (!Array.isArray(groups)) continue
    const before = groups.length
    groups = groups.filter((group: unknown) => {
      if (!group || typeof group !== 'object') return true
      const g = group as { hooks?: Array<{ command?: string }> }
      const cmds = (g.hooks ?? []).map((h) => h.command ?? '').join('|')
      return !cmds.includes(MEMSIDE_TAG)
    })
    removed += before - groups.length
    hooks[ev] = groups
  }

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n')
  return { removed, settingsPath }
}
```

注意：`existsSync`, `readFileSync`, `writeFileSync` 已在 install.ts 顶部 import（install.ts:1）。`EVENTS`, `MEMSIDE_TAG`, `resolveHome` 在同文件作用域内。

- [ ] **Step 6: 运行测试验证通过**

Run: `bun test tests/install.test.ts`
Expected: PASS（所有新旧测试绿，含默认 settings.json 回归锁）

- [ ] **Step 7: typecheck**

Run: `bun run typecheck`
Expected: 无错

- [ ] **Step 8: commit**

```bash
git add src/install.ts tests/install.test.ts
git commit -m "feat: installHooks custom settingsFilename + uninstallHooks"
```

---

## Task 3: server 4 个 /api/settings/runtime* 端点

**Files:**
- Modify: `src/server.ts`（`AppDeps` 加注入点 + 4 个端点，追加在 judge 端点后 `:978` 附近）
- Test: `tests/settings-runtime-api.test.ts`（新建）

**Interfaces:**
- Consumes: `loadRuntimePaths` / `saveRuntimePaths` / `defaultRuntimePaths`（Task 1）；`installHooks` / `uninstallHooks`（Task 2）；`AppDeps.db`（既有）
- Produces:
  - `AppDeps.installHooksFn?: (opts: { port: number; baseDir?: string; settingsFilename?: string }) => void`（测试注入点，缺省走真实 `installHooks`）
  - `AppDeps.uninstallHooksFn?: (opts: { baseDir?: string; settingsFilename?: string }) => { removed: number; settingsPath: string }`（测试注入点）
  - 4 个端点：
    - `GET /api/settings/runtime` -> `{ claudeDir, settingsFilename, opencodeDir, defaults: RuntimePaths }`
    - `PUT /api/settings/runtime` -> 字段级保存，返回更新后状态（同 GET 形状）
    - `POST /api/settings/runtime/install` -> `{ ok: boolean; settingsPath?: string; error?: string }`
    - `POST /api/settings/runtime/uninstall` -> `{ ok: boolean; removed?: number; settingsPath?: string; error?: string }`

- [ ] **Step 1: 写失败测试**

新建 `tests/settings-runtime-api.test.ts`：

```ts
// spec: docs/superpowers/specs/2026-08-17-runtime-path-config-design.md §3.6
// 锁 4 个 /api/settings/runtime* 端点形状 + install/uninstall 经注入点（不碰真实 ~/.claude）。
import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { openDb } from '@/db/client'
import { ClaudeCodeAdapter } from '@/adapter/claudeCode'
import { OpencodeAdapter } from '@/adapter/opencode'
import { createApp } from '@/server'
import { MEMSIDE_TAG } from '@/install'

const root = join(import.meta.dir, '.tmp-settings-runtime-api')
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

function makeApp(overrides: {
  installHooksFn?: (opts: { port: number; baseDir?: string; settingsFilename?: string }) => void
  uninstallHooksFn?: (opts: { baseDir?: string; settingsFilename?: string }) => { removed: number; settingsPath: string }
} = {}) {
  return createApp({
    db,
    adapter: new ClaudeCodeAdapter(db),
    opencodeAdapter: new OpencodeAdapter(db),
    enqueueDistillJob: async () => ({ jobId: 'j', nextRunAt: 0 }),
    broadcast: () => {},
    ...overrides,
  })
}

async function req(app: ReturnType<typeof createApp>, path: string, init?: RequestInit) {
  const res = await app.fetch(new Request(`http://x${path}`, init))
  return { status: res.status, body: await res.json().catch(() => null) }
}

const putJson = (body: unknown): RequestInit => ({ method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
const post = (path: string): RequestInit => ({ method: 'POST' })

test('GET /api/settings/runtime returns defaults when unconfigured', async () => {
  const app = makeApp()
  const { status, body } = await req(app, '/api/settings/runtime')
  expect(status).toBe(200)
  expect(body.claudeDir).toBe(body.defaults.claudeDir)
  expect(body.settingsFilename).toBe('settings.json')
  expect(body.defaults.settingsFilename).toBe('settings.json')
})

test('PUT /api/settings/runtime saves + returns updated state', async () => {
  const app = makeApp()
  const { status, body } = await req(app, '/api/settings/runtime', putJson({ claudeDir: '/home/u/.cac', settingsFilename: 'setting.json' }))
  expect(status).toBe(200)
  expect(body.claudeDir).toBe('/home/u/.cac')
  expect(body.settingsFilename).toBe('setting.json')
  // opencodeDir 未传 -> 默认
  expect(body.opencodeDir).toBe(body.defaults.opencodeDir)
  // 持久化：再 GET 仍是新值
  const g = await req(app, '/api/settings/runtime')
  expect(g.body.claudeDir).toBe('/home/u/.cac')
})

test('PUT rejects non-string values with 400', async () => {
  const app = makeApp()
  const { status, body } = await req(app, '/api/settings/runtime', putJson({ claudeDir: 123 }))
  expect(status).toBe(400)
  expect(body.error).toBeTruthy()
})

test('POST /api/settings/runtime/install calls installHooksFn with saved paths + port', async () => {
  let called: { port: number; baseDir?: string; settingsFilename?: string } | null = null
  const app = makeApp({
    installHooksFn: (opts) => { called = opts },
  })
  // 先存自定义路径
  await req(app, '/api/settings/runtime', putJson({ claudeDir: '/home/u/.cac', settingsFilename: 'setting.json' }))
  const { status, body } = await req(app, '/api/settings/runtime/install', post('/api/settings/runtime/install'))
  expect(status).toBe(200)
  expect(body.ok).toBe(true)
  expect(body.settingsPath).toBe('/home/u/.cac/setting.json')
  expect(called).not.toBeNull()
  expect(called!.baseDir).toBe('/home/u/.cac')
  expect(called!.settingsFilename).toBe('setting.json')
  expect(typeof called!.port).toBe('number')
})

test('POST /api/settings/runtime/install surfaces install error', async () => {
  const app = makeApp({
    installHooksFn: () => { throw new Error('disk full') },
  })
  const { status, body } = await req(app, '/api/settings/runtime/install', post('/api/settings/runtime/install'))
  expect(status).toBe(200) // 业务结果，不是请求错误
  expect(body.ok).toBe(false)
  expect(body.error).toContain('disk full')
})

test('POST /api/settings/runtime/uninstall calls uninstallHooksFn + returns removed', async () => {
  let called: { baseDir?: string; settingsFilename?: string } | null = null
  const app = makeApp({
    uninstallHooksFn: (opts) => { called = opts; return { removed: 5, settingsPath: '/x/setting.json' } },
  })
  await req(app, '/api/settings/runtime', putJson({ claudeDir: '/x', settingsFilename: 'setting.json' }))
  const { status, body } = await req(app, '/api/settings/runtime/uninstall', post('/api/settings/runtime/uninstall'))
  expect(status).toBe(200)
  expect(body.ok).toBe(true)
  expect(body.removed).toBe(5)
  expect(body.settingsPath).toBe('/x/setting.json')
  expect(called!.baseDir).toBe('/x')
  expect(called!.settingsFilename).toBe('setting.json')
})

test('POST /api/settings/runtime/uninstall surfaces error', async () => {
  const app = makeApp({
    uninstallHooksFn: () => { throw new Error('locked') },
  })
  const { status, body } = await req(app, '/api/settings/runtime/uninstall', post('/api/settings/runtime/uninstall'))
  expect(status).toBe(200)
  expect(body.ok).toBe(false)
  expect(body.error).toContain('locked')
})

test('install endpoint expands ~ in claudeDir before calling installHooksFn', async () => {
  let called: { baseDir?: string } | null = null
  const app = makeApp({ installHooksFn: (opts) => { called = opts } })
  await req(app, '/api/settings/runtime', putJson({ claudeDir: '~/.cac' }))
  await req(app, '/api/settings/runtime/install', post('/api/settings/runtime/install'))
  expect(called!.baseDir).not.toContain('~') // ~ 已展开为真实 home
  expect(called!.baseDir!.endsWith('.cac')).toBe(true)
})
```

- [ ] **Step 2: 运行测试验证失败**

Run: `bun test tests/settings-runtime-api.test.ts`
Expected: FAIL（端点不存在，404）

- [ ] **Step 3: 加 AppDeps 注入点**

在 `src/server.ts:28` 的 `AppDeps` 接口里（`testConnection?` 之后、`callLLM?` 之前或末尾均可）追加：

```ts
  /** 运行环境路径 install/uninstall 注入点（spec 2026-08-17 §3.6）。缺省走真实
   *  install.ts 实现；测试注入假实现，不碰真实 ~/.claude。 */
  installHooksFn?: (opts: { port: number; baseDir?: string; settingsFilename?: string }) => void
  uninstallHooksFn?: (opts: { baseDir?: string; settingsFilename?: string }) => { removed: number; settingsPath: string }
```

- [ ] **Step 4: 在 createApp 里解析注入点 + 写端点**

在 `src/server.ts:132-141` 的 `const testConn = ...` 之后追加：

```ts
  const doInstall = deps.installHooksFn ?? ((opts: { port: number; baseDir?: string; settingsFilename?: string }) => installHooks(opts))
  const doUninstall = deps.uninstallHooksFn ?? ((opts: { baseDir?: string; settingsFilename?: string }) => uninstallHooks(opts))
```

并在 server.ts 顶部 import 行（`:19` 附近）补：`loadRuntimePaths, saveRuntimePaths, defaultRuntimePaths,` 进 settings import；`installHooks, uninstallHooks` 进 install import。检查现有 import——`src/install.ts` 的 `installHooks` 可能已 import（daemon.ts 用，但 server.ts 检查）；若 server.ts 未 import install 则加 `import { installHooks, uninstallHooks } from '@/install'`。

在 judge 端点之后（`src/server.ts:978` 的 `PUT /api/settings/judge` 闭合 `})` 之后、archive 端点之前）追加 4 个端点：

```ts
  // --- 运行环境路径配置（spec 2026-08-17-runtime-path-config §3.6）-----------
  // GET 回当前生效路径 + 默认对照；PUT 字段级保存（空串=回默认）；install/uninstall
  // 读已存路径调 installHooks/uninstallHooks。install/uninstall 失败不静默，
  // 返回 {ok:false,error} 让 UI 显横幅（CLAUDE.md 错误可见性）。
  app.get('/api/settings/runtime', (c) => {
    const rp = loadRuntimePaths(deps.db)
    return c.json({ ...rp, defaults: defaultRuntimePaths() })
  })

  const runtimePutSchema = z.object({
    claudeDir: z.string().optional(),
    settingsFilename: z.string().optional(),
    opencodeDir: z.string().optional(),
  })
  app.put('/api/settings/runtime', async (c) => {
    const parsed = runtimePutSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'invalid body' }, 400)
    saveRuntimePaths(deps.db, parsed.data)
    const rp = loadRuntimePaths(deps.db)
    return c.json({ ...rp, defaults: defaultRuntimePaths() })
  })

  app.post('/api/settings/runtime/install', (c) => {
    const rp = loadRuntimePaths(deps.db)
    // ~ 展开：claudeDir 若以 ~ 开头走 resolveHome（spec §6.3）；绝对路径原样用。
    const baseDir = rp.claudeDir.startsWith('~') ? join(resolveHome(), rp.claudeDir.slice(1)) : rp.claudeDir
    try {
      doInstall({ port, baseDir, settingsFilename: rp.settingsFilename })
      const settingsPath = join(baseDir, rp.settingsFilename)
      return c.json({ ok: true, settingsPath })
    } catch (e) {
      return c.json({ ok: false, error: (e as Error).message })
    }
  })

  app.post('/api/settings/runtime/uninstall', (c) => {
    const rp = loadRuntimePaths(deps.db)
    const baseDir = rp.claudeDir.startsWith('~') ? join(resolveHome(), rp.claudeDir.slice(1)) : rp.claudeDir
    try {
      const r = doUninstall({ baseDir, settingsFilename: rp.settingsFilename })
      return c.json({ ok: true, removed: r.removed, settingsPath: r.settingsPath })
    } catch (e) {
      return c.json({ ok: false, error: (e as Error).message })
    }
  })
```

注意：
- `port` 变量需在 createApp 作用域可见。检查 server.ts：`port` 在 createApp 内是否已有？install 端点要用 daemon 的端口。`AppDeps` 当前**没有** port 字段——需确认。查 `src/daemon.ts:179` 的 `createApp({...})` 调用未传 port。**决策**：给 `AppDeps` 加可选 `port?: number`，install 端点用 `deps.port ?? 7777`。在 AppDeps 接口加 `port?: number` 字段，daemon.ts 传 `port`（见 Task 4）。本任务先在 AppDeps 加 `port?: number`，install 端点 `const port = deps.port ?? 7777`。
- `resolveHome` 在 server.ts 是否已定义？检查——server.ts 大概率没有 `resolveHome`。**决策**：在 server.ts 顶部加一个本地 `resolveHome`（与 install.ts/creds.ts 同语义），或在 install 端点用 `process.env.HOME || process.env.USERPROFILE || homedir()` 内联。最小改动：在 server.ts 加 `import { homedir } from 'node:os'`（若已有则复用）+ 文件内加 `function resolveHome() { return process.env.HOME || process.env.USERPROFILE || homedir() }`（与既有文件同模式，install 端点 + 其它可能复用）。
- `join` 在 server.ts 已 import。
- `z` (zod) 已 import。

- [ ] **Step 5: 运行测试验证通过**

Run: `bun test tests/settings-runtime-api.test.ts`
Expected: PASS（9 个测试绿）

- [ ] **Step 6: typecheck**

Run: `bun run typecheck`
Expected: 无错（AppDeps 加了 `port?` 是可选，不破坏既有调用）

- [ ] **Step 7: commit**

```bash
git add src/server.ts tests/settings-runtime-api.test.ts
git commit -m "feat: /api/settings/runtime* endpoints (get/put/install/uninstall)"
```

---

## Task 4: daemon.ts + cli.ts 启动时读配置透传 install

**Files:**
- Modify: `src/daemon.ts:162-202`（startDaemon 读 loadRuntimePaths 透传 + createApp 传 port）
- Modify: `src/cli.ts:34-41`（install / start-and-install 读 db 透传）

**Interfaces:**
- Consumes: `loadRuntimePaths`（Task 1）；`installHooks`（Task 2）；`openDb`（既有，cli 用）
- Produces: daemon 启动时 hooks 装到用户配的路径（默认零回归）；CLI 同理。

- [ ] **Step 1: 写失败测试**

新建 `tests/daemon-install-paths.test.ts`：

```ts
// spec 2026-08-17-runtime-path-config §3.4/3.5
// 锁 startDaemon 在 installClaudeHooks:true 时读 loadRuntimePaths 透传 installHooks。
// 用真实 startDaemon + 临时 db + 临时 HOME，断言 hooks 落到自定义路径。
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { openDb } from '@/db/client'
import { startDaemon } from '@/daemon'
import { saveRuntimePaths } from '@/settings'
import { MEMSIDE_TAG } from '@/install'

const fakeHome = join(import.meta.dir, '.tmp-daemon-install')
const realHome = process.env.HOME
const realUserprofile = process.env.USERPROFILE
let dbPath: string

beforeEach(() => {
  rmSync(fakeHome, { recursive: true, force: true })
  mkdirSync(fakeHome, { recursive: true })
  ;(process.env as any).HOME = fakeHome
  delete process.env.USERPROFILE
  dbPath = join(fakeHome, 'memside.db')
})

afterEach(async () => {
  ;(process.env as any).HOME = realHome
  if (realUserprofile !== undefined) (process.env as any).USERPROFILE = realUserprofile
  else delete process.env.USERPROFILE
})

test('startDaemon installs hooks to default ~/.claude/settings.json when no config', async () => {
  const { server } = await startDaemon({ dbPath, port: 17801, installClaudeHooks: true })
  try {
    expect(existsSync(join(fakeHome, '.claude', 'settings.json'))).toBe(true)
    const raw = JSON.parse(readFileSync(join(fakeHome, '.claude', 'settings.json'), 'utf-8'))
    expect(JSON.stringify(raw.hooks)).toContain(MEMSIDE_TAG)
  } finally { server.stop() }
})

test('startDaemon installs hooks to configured ~/.cac/setting.json', async () => {
  // 先存配置（codeagent 路径）
  const db = openDb(dbPath)
  saveRuntimePaths(db, { claudeDir: join(fakeHome, '.cac'), settingsFilename: 'setting.json' })
  db.$client.close()

  const { server } = await startDaemon({ dbPath, port: 17802, installClaudeHooks: true })
  try {
    expect(existsSync(join(fakeHome, '.cac', 'setting.json'))).toBe(true)
    expect(existsSync(join(fakeHome, '.cac', 'settings.json'))).toBe(false) // 单数文件名
    const raw = JSON.parse(readFileSync(join(fakeHome, '.cac', 'setting.json'), 'utf-8'))
    expect(JSON.stringify(raw.hooks)).toContain(MEMSIDE_TAG)
  } finally { server.stop() }
})

test('startDaemon without installClaudeHooks does not write settings', async () => {
  const { server } = await startDaemon({ dbPath, port: 17803, installClaudeHooks: false })
  try {
    expect(existsSync(join(fakeHome, '.claude', 'settings.json'))).toBe(false)
  } finally { server.stop() }
})
```

注意：端口用 178xx 避免与其它测试/真实 daemon 撞。`saveRuntimePaths` 已在 Task 1 导出。startDaemon 默认 dbPath 是 `~/.memside/memside.db`，本测试显式传 dbPath 指向 fakeHome 隔离。

- [ ] **Step 2: 运行测试验证失败**

Run: `bun test tests/daemon-install-paths.test.ts`
Expected: FAIL（第二个测试：startDaemon 当前不读配置，写到了 `settings.json` 而非 `setting.json`）

- [ ] **Step 3: 修改 startDaemon**

在 `src/daemon.ts`：

1. 顶部 import 加 `loadRuntimePaths`（`src/settings.ts`）：
   ```ts
   import { loadUiLlmConfig, loadJudgeConfig, loadRuntimePaths, type UiLlmConfig } from './settings'
   ```

2. `startDaemon` 函数体（`:193`）：

   把：
   ```ts
   if (opts.installClaudeHooks) installHooks({ port })
   ```
   改为：
   ```ts
   if (opts.installClaudeHooks) {
     // 读 UI 配置的运行环境路径（codeagent 用 ~/.cac/setting.json 等）。存储异常降级默认。
     let rp = loadRuntimePaths(db)
     try { rp = loadRuntimePaths(db) } catch { rp = { claudeDir: join(homedir(), '.claude'), settingsFilename: 'settings.json', opencodeDir: join(homedir(), '.config', 'opencode') } }
     installHooks({ port, baseDir: rp.claudeDir, settingsFilename: rp.settingsFilename })
   }
   ```

   注意：`homedir` 已在 daemon.ts 顶部 import（`:3`）。`loadRuntimePaths` 失败降级用 homedir() 而非 resolveHome()，避免在 daemon.ts 引入新依赖；语义等价（HOME 优先逻辑在 settings.defaultRuntimePaths 已体现，降级路径用 homedir 兜底足够）。

3. `createApp` 调用（`:179`）加 `port`：
   ```ts
   const app = createApp({ db, adapter, opencodeAdapter, enqueueDistillJob, broadcast, staticDir: opts.serveStaticDir, staticAssets: opts.serveStaticAssets, tracker, callLLM: resolveCallLLM({}, db), port })
   ```

- [ ] **Step 4: 修改 cli.ts**

在 `src/cli.ts`：

1. 顶部 import 加：
   ```ts
   import { openDb } from './db/client'
   import { loadRuntimePaths } from './settings'
   import { homedir } from 'node:os'
   import { join } from 'node:path'
   ```
   （`join` 已 import 于 cli.ts:23，不重复；`homedir` 未 import 则加。）

2. `install` 分支（`:34-37`）：
   ```ts
   } else if (cmd === 'install') {
     const db = openDb(join(homedir(), '.memside', 'memside.db'))
     const rp = loadRuntimePaths(db)
     db.$client.close()
     installHooks({ port: PORT, baseDir: rp.claudeDir, settingsFilename: rp.settingsFilename })
     installOpencodePlugin({ port: PORT, pluginSrcDir })
     console.log('hooks installed into ~/.claude/settings.json; opencode plugin installed into ~/.config/opencode/')
   }
   ```

   注意：db 不存在时 `openDb` 自建，`loadRuntimePaths` 全默认——与「未配置」一致。`db.$client.close()` 释放句柄（与 settings-api.test.ts:37 同模式）。

3. `start-and-install` 分支（`:38-41`）：
   ```ts
   } else if (cmd === 'start-and-install') {
     await startDaemon({ port: PORT, installClaudeHooks: true })
     installOpencodePlugin({ port: PORT, pluginSrcDir })
     console.log(`memside daemon on http://127.0.0.1:${PORT} (hooks installed; opencode plugin installed)`)
   }
   ```
   （start-and-install 的 hooks 安装已由 startDaemon 内部读配置完成，不需再在 CLI 侧重复 installHooks。逐字不动，仅确认。）

- [ ] **Step 5: 运行测试验证通过**

Run: `bun test tests/daemon-install-paths.test.ts`
Expected: PASS

- [ ] **Step 6: 全量测试 + typecheck（回归确认）**

Run: `bun run typecheck && bun test`
Expected: 全绿（基线 + 新增；既有 settings-api / server 测试不回归——AppDeps.port 是可选）

- [ ] **Step 7: commit**

```bash
git add src/daemon.ts src/cli.ts tests/daemon-install-paths.test.ts
git commit -m "feat: daemon + cli read RuntimePaths on startup install"
```

---

## Task 5: Web UI api.ts wrapper + RuntimeSettingsState 类型

**Files:**
- Modify: `src/web/api.ts`（追加 4 个 wrapper + 类型，在判定设置 client 段之后、回收站段之前）
- Test: `tests/web-api.test.ts`（追加）

**Interfaces:**
- Consumes: `FetchLike`（既有 api.ts:35）
- Produces:
  - `export interface RuntimeSettingsState { claudeDir: string; settingsFilename: string; opencodeDir: string; defaults: { claudeDir: string; settingsFilename: string; opencodeDir: string } }`
  - `export async function getRuntimeSettings(fetchFn?: FetchLike): Promise<RuntimeSettingsState>`
  - `export async function saveRuntimeSettings(patch: Partial<{ claudeDir: string; settingsFilename: string; opencodeDir: string }>, fetchFn?: FetchLike): Promise<RuntimeSettingsState>`
  - `export async function installRuntimeHooks(fetchFn?: FetchLike): Promise<{ ok: boolean; settingsPath?: string; error?: string }>`
  - `export async function uninstallRuntimeHooks(fetchFn?: FetchLike): Promise<{ ok: boolean; removed?: number; settingsPath?: string; error?: string }>`

- [ ] **Step 1: 写失败测试**

追加到 `tests/web-api.test.ts` 末尾（参考该文件既有 wrapper 测试模式——用假 fetch）：

```ts
// 先检查文件顶部是否已 import 待测函数；若 web-api.test.ts 用整体 import，追加 import
import { getRuntimeSettings, saveRuntimeSettings, installRuntimeHooks, uninstallRuntimeHooks } from '../src/web/api'

test('getRuntimeSettings returns defaults shape', async () => {
  const fake: FetchLike = async () => new Response(JSON.stringify({
    claudeDir: '/h/.claude', settingsFilename: 'settings.json', opencodeDir: '/h/.config/opencode',
    defaults: { claudeDir: '/h/.claude', settingsFilename: 'settings.json', opencodeDir: '/h/.config/opencode' },
  }), { status: 200 })
  const r = await getRuntimeSettings(fake)
  expect(r.claudeDir).toBe('/h/.claude')
  expect(r.defaults.settingsFilename).toBe('settings.json')
})

test('saveRuntimeSettings PUTs patch + returns updated state', async () => {
  let captured: any = null
  const fake: FetchLike = async (url, init) => {
    captured = { url, init }
    return new Response(JSON.stringify({
      claudeDir: '/h/.cac', settingsFilename: 'setting.json', opencodeDir: '/h/.config/opencode',
      defaults: { claudeDir: '/h/.claude', settingsFilename: 'settings.json', opencodeDir: '/h/.config/opencode' },
    }), { status: 200 })
  }
  const r = await saveRuntimeSettings({ claudeDir: '/h/.cac', settingsFilename: 'setting.json' }, fake)
  expect(captured.init?.method).toBe('PUT')
  expect(r.claudeDir).toBe('/h/.cac')
})

test('installRuntimeHooks POSTs install + returns ok shape', async () => {
  let captured: any = null
  const fake: FetchLike = async (url, init) => {
    captured = { url, init }
    return new Response(JSON.stringify({ ok: true, settingsPath: '/h/.cac/setting.json' }), { status: 200 })
  }
  const r = await installRuntimeHooks(fake)
  expect(captured.init?.method).toBe('POST')
  expect(captured.url).toContain('/api/settings/runtime/install')
  expect(r.ok).toBe(true)
  expect(r.settingsPath).toBe('/h/.cac/setting.json')
})

test('uninstallRuntimeHooks POSTs uninstall + returns removed shape', async () => {
  const fake: FetchLike = async () => new Response(JSON.stringify({ ok: true, removed: 5, settingsPath: '/x/setting.json' }), { status: 200 })
  const r = await uninstallRuntimeHooks(fake)
  expect(r.ok).toBe(true)
  expect(r.removed).toBe(5)
})
```

注意：检查 `tests/web-api.test.ts` 顶部是否已有 `FetchLike` import（从 `../src/web/api`）。若类型在该文件内未定义也未 import，用本地定义 `type FetchLike = (url: string, init?: RequestInit) => Promise<Response>` 或从 api import。参考该文件既有测试的 fake fetch 写法对齐。

- [ ] **Step 2: 运行测试验证失败**

Run: `bun test tests/web-api.test.ts`
Expected: FAIL（4 个函数未导出）

- [ ] **Step 3: 写实现**

在 `src/web/api.ts` 末尾（或判定设置 client 段 `:507` 之后、回收站段 `:509` 之前——任一位置，保持邻近 LLM/judge 设置 client 聚集）追加：

```ts
// --- 运行环境路径配置 client（spec 2026-08-17-runtime-path-config §3.7）---------

export interface RuntimeSettingsState {
  claudeDir: string
  settingsFilename: string
  opencodeDir: string
  defaults: { claudeDir: string; settingsFilename: string; opencodeDir: string }
}

/** GET /api/settings/runtime — 当前生效路径 + 默认值对照。 */
export async function getRuntimeSettings(fetchFn: FetchLike = fetch): Promise<RuntimeSettingsState> {
  const res = await fetchFn('/api/settings/runtime')
  return (await res.json()) as RuntimeSettingsState
}

/** PUT /api/settings/runtime — 字段级保存（空串=回默认）。返回更新后状态。 */
export async function saveRuntimeSettings(
  patch: Partial<{ claudeDir: string; settingsFilename: string; opencodeDir: string }>,
  fetchFn: FetchLike = fetch,
): Promise<RuntimeSettingsState> {
  const res = await fetchFn('/api/settings/runtime', {
    method: 'PUT',
    body: JSON.stringify(patch),
    headers: { 'content-type': 'application/json' },
  })
  return (await res.json()) as RuntimeSettingsState
}

/** POST /api/settings/runtime/install — 读已存路径装 hooks。失败返回 {ok:false,error}。 */
export async function installRuntimeHooks(fetchFn: FetchLike = fetch): Promise<{ ok: boolean; settingsPath?: string; error?: string }> {
  const res = await fetchFn('/api/settings/runtime/install', { method: 'POST' })
  return (await res.json()) as { ok: boolean; settingsPath?: string; error?: string }
}

/** POST /api/settings/runtime/uninstall — 移除 memside-managed hooks（保留用户自写）。 */
export async function uninstallRuntimeHooks(fetchFn: FetchLike = fetch): Promise<{ ok: boolean; removed?: number; settingsPath?: string; error?: string }> {
  const res = await fetchFn('/api/settings/runtime/uninstall', { method: 'POST' })
  return (await res.json()) as { ok: boolean; removed?: number; settingsPath?: string; error?: string }
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `bun test tests/web-api.test.ts`
Expected: PASS

- [ ] **Step 5: typecheck**

Run: `bun run typecheck`
Expected: 无错

- [ ] **Step 6: commit**

```bash
git add src/web/api.ts tests/web-api.test.ts
git commit -m "feat: web api client for runtime path settings (get/save/install/uninstall)"
```

---

## Task 6: Web UI RuntimeSettings section + 挂载点

**Files:**
- Modify: `src/web/App.tsx:7`（import 加 4 个 wrapper + 类型）、`:737-738`（挂载点追加 `<RuntimeSettings />`）、文件末尾追加 `RuntimeSettings` 组件
- Test: `tests/app-source-assertions.test.ts`（新建或追加）

**Interfaces:**
- Consumes: `getRuntimeSettings`/`saveRuntimeSettings`/`installRuntimeHooks`/`uninstallRuntimeHooks` + `RuntimeSettingsState`（Task 5）；既有 section 约定（`<section>` + `<h3>` + 自管理 fetch/保存/错误行，参考 `LlmSettings` `App.tsx:1110`）
- Produces: `RuntimeSettings` 组件 + 设置 tab 第三 section。

- [ ] **Step 1: 写失败测试（源码层文本断言）**

新建 `tests/app-source-assertions.test.ts`（若已存在则追加）：

```ts
// spec: docs/superpowers/specs/2026-08-17-runtime-path-config-design.md §7.5
// 运行时组件兜底面（CLAUDE.md 最低要求）：RuntimeSettings section 挂载点 + 安装/卸载按钮。
// App.tsx 无法在 bun test 直接渲染（需 vite/浏览器），靠源码层文本断言锁接线存在。
import { test, expect } from 'bun:test'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const appPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'web', 'App.tsx')

test('App.tsx mounts RuntimeSettings section in settings tab', () => {
  const src = readFileSync(appPath, 'utf-8')
  // 挂载点存在（与 LlmSettings/JudgeSettings 同级）
  expect(src).toContain('<RuntimeSettings />')
  // 组件定义存在
  expect(src).toContain('function RuntimeSettings()')
  // 安装 + 卸载按钮接线
  expect(src).toContain('installRuntimeHooks')
  expect(src).toContain('uninstallRuntimeHooks')
  // 三个路径输入字段接线（claudeDir / settingsFilename / opencodeDir）
  expect(src).toContain('claudeDir')
  expect(src).toContain('settingsFilename')
  expect(src).toContain('opencodeDir')
})

test('RuntimeSettings section uses standard section convention', () => {
  const src = readFileSync(appPath, 'utf-8')
  // 与 LlmSettings/JudgeSettings 同款 section + h3 结构
  const fnStart = src.indexOf('function RuntimeSettings()')
  expect(fnStart).toBeGreaterThan(-1)
  const fnSlice = src.slice(fnStart, fnStart + 3000)
  expect(fnSlice).toContain('<section')
  expect(fnSlice).toContain('<h3')
})
```

- [ ] **Step 2: 运行测试验证失败**

Run: `bun test tests/app-source-assertions.test.ts`
Expected: FAIL（`<RuntimeSettings />` 未挂载、组件未定义）

- [ ] **Step 3: 修改 import**

在 `src/web/App.tsx:7` 的 import 块（含 `getLlmSettings, saveLlmSettings, ...`）追加：

```ts
  getRuntimeSettings, saveRuntimeSettings, installRuntimeHooks, uninstallRuntimeHooks,
```

并在 `:15` 的 type import（含 `LlmSettingsState, JudgeConfigDto`）追加：

```ts
  type RuntimeSettingsState,
```

- [ ] **Step 4: 挂载点追加**

在 `src/web/App.tsx:737-738`（`<LlmSettings />` + `<JudgeSettings />` 之后）追加第三行：

```tsx
          <LlmSettings />
          <JudgeSettings />
          <RuntimeSettings />
```

- [ ] **Step 5: 写 RuntimeSettings 组件**

在 `src/web/App.tsx` 文件末尾（`JudgeSettings` 组件定义之后）追加：

```tsx
/**
 * 运行环境路径配置区块（spec 2026-08-17-runtime-path-config §3.7）。
 * codeagent 读 ~/.cac/setting.json（目录 + 文件名双双不同于标准），
 * 用户在此配置路径 + 一键安装/卸载 hooks。复用既有 section 约定。
 * 三路径输入框 + 保存 + 安装 + 卸载；fetch/操作失败显错误不静默。
 */
function RuntimeSettings() {
  const [state, setState] = useState<RuntimeSettingsState | null>(null)
  const [claudeDir, setClaudeDir] = useState('')
  const [settingsFilename, setSettingsFilename] = useState('')
  const [opencodeDir, setOpencodeDir] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = async () => {
    try {
      const s = await getRuntimeSettings()
      setState(s)
      setClaudeDir(s.claudeDir)
      setSettingsFilename(s.settingsFilename)
      setOpencodeDir(s.opencodeDir)
      setError(null)
    } catch (e) { setError(String(e)) }
  }
  useEffect(() => { void refresh() }, [])

  const onSave = async () => {
    setBusy(true); setMsg(null)
    try {
      const s = await saveRuntimeSettings({ claudeDir, settingsFilename, opencodeDir })
      setState(s); setClaudeDir(s.claudeDir); setSettingsFilename(s.settingsFilename); setOpencodeDir(s.opencodeDir)
      setMsg('已保存')
    } catch (e) { setMsg(`保存失败: ${e}`) }
    finally { setBusy(false) }
  }
  const onInstall = async () => {
    setBusy(true); setMsg(null)
    try {
      const r = await installRuntimeHooks()
      setMsg(r.ok ? `已安装到 ${r.settingsPath}` : `安装失败: ${r.error ?? '未知错误'}`)
    } catch (e) { setMsg(`安装失败: ${e}`) }
    finally { setBusy(false) }
  }
  const onUninstall = async () => {
    setBusy(true); setMsg(null)
    try {
      const r = await uninstallRuntimeHooks()
      setMsg(r.ok ? `已移除 ${r.removed} 个 hook 组（${r.settingsPath}）` : `卸载失败: ${r.error ?? '未知错误'}`)
    } catch (e) { setMsg(`卸载失败: ${e}`) }
    finally { setBusy(false) }
  }

  return (
    <section style={{ margin: '12px 0', padding: 12, border: '1px solid #ddd', borderRadius: 8 }}>
      <h3 style={{ margin: '0 0 8px' }}>运行环境</h3>
      <p style={{ margin: '0 0 10px', fontSize: 13, color: '#666' }}>
        公司内部 agent（如 codeagent）配置文件路径与官方不同。在此填写你所用 agent 实际读取的配置路径，装好 hooks 才能抓取会话 + 注入记忆。
      </p>
      {error ? <div style={{ color: '#b00', marginBottom: 8 }}>设置加载失败: {error}</div> : null}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        <input style={{ flex: '2 1 260px' }} placeholder={state?.defaults.claudeDir ?? '~/.claude'}
          value={claudeDir} onChange={(e) => setClaudeDir(e.target.value)} />
        <input style={{ flex: '1 1 180px' }} placeholder={state?.defaults.settingsFilename ?? 'settings.json'}
          value={settingsFilename} onChange={(e) => setSettingsFilename(e.target.value)} />
        <input style={{ flex: '2 1 260px' }} placeholder={state?.defaults.opencodeDir ?? '~/.config/opencode'}
          value={opencodeDir} onChange={(e) => setOpencodeDir(e.target.value)} />
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button disabled={busy} onClick={() => void onSave()}>保存路径</button>
        <button disabled={busy} onClick={() => void onInstall()}>安装 hooks</button>
        <button disabled={busy} onClick={() => void onUninstall()}>卸载 hooks</button>
        {busy ? <span style={{ color: '#888' }}>处理中…</span> : null}
        {msg ? <span style={{ color: msg.includes('失败') ? '#b00' : '#080' }}>{msg}</span> : null}
      </div>
      <div style={{ marginTop: 6, fontSize: 12, color: '#888' }}>
        提示：codeagent 用户通常填 claude 目录 <code>~/.cac</code> + 文件名 <code>setting.json</code>。安装前请确认此路径是你所用 agent 实际读取的配置文件。卸载只移除 memside 管理的 hook，不影响你自己写的 hook。
      </div>
    </section>
  )
}
```

注意：`useState`, `useEffect` 已在 App.tsx 顶部 import（既有 LlmSettings 用）。`RuntimeSettingsState` 已在 Step 3 import。

- [ ] **Step 6: 运行测试验证通过**

Run: `bun test tests/app-source-assertions.test.ts`
Expected: PASS

- [ ] **Step 7: typecheck**

Run: `bun run typecheck`
Expected: 无错

- [ ] **Step 8: commit**

```bash
git add src/web/App.tsx tests/app-source-assertions.test.ts
git commit -m "feat: RuntimeSettings section in settings tab (path config + install/uninstall)"
```

---

## Task 7: 全量验证 + STATE.md 回填

**Files:**
- Modify: `STATE.md`（追加新 section）

**Interfaces:** 无（验证 + 文档收尾）

- [ ] **Step 1: 全量测试 + typecheck**

Run: `bun run typecheck && bun test`
Expected: 全绿（基线 + Task 1-6 新增测试）

- [ ] **Step 2: 检查是否有遗漏的回归**

Run: `bun test tests/install.test.ts tests/settings.test.ts tests/settings-api.test.ts tests/settings-runtime-api.test.ts tests/daemon-install-paths.test.ts tests/web-api.test.ts tests/app-source-assertions.test.ts tests/launcher-source-assertions.test.ts`
Expected: 全绿。特别确认 `tests/launcher-source-assertions.test.ts` 不受影响（launcher.ts 未改，应仍绿）。

- [ ] **Step 3: 追加 STATE.md section**

在 `STATE.md` 顶部（`## 成品发布` section 之前，或文件末尾——按既有「新 section 在顶部」惯例，放 `## 成品发布` 之前）追加：

```markdown
## 运行环境自定义路径配置（2026-08-17）

商用适配：codeagent（claude code fork，读 `~/.cac/setting.json`）等公司内部 agent 配置路径与官方不同，原 `installHooks` 硬编码 `~/.claude/settings.json` → hooks 到不了 codeagent → 整个闭环断（STATE 2026-07-23 codeagent 桥接遗留第 5 点）。设计 spec / 计划见
`docs/superpowers/specs|plans/2026-08-17-runtime-path-config*`。

1. `RuntimePaths`（`src/settings.ts`）：三字段（claudeDir/settingsFilename/opencodeDir）落 `app_settings`，缺失回默认（`~/.claude`/`settings.json`/`~/.config/opencode`）。字段级合并 save（空串=回默认）。
2. `installHooks`（`src/install.ts`）：`InstallOpts` 加 `settingsFilename?`（default `settings.json`）；`settingsPath = join(baseDir, settingsFilename ?? 'settings.json')`。新增 `uninstallHooks`——install 的 idempotent-merge 对偶，按 `MEMSIDE_TAG` marker 移除 memside-managed 组（保留用户自写 hook），返回 `{removed, settingsPath}`，文件缺失/malformed 返回 `removed:0` 不抛。
3. daemon/CLI（`src/daemon.ts` + `src/cli.ts`）：`startDaemon(installClaudeHooks:true)` 与 `memside install` 读 `loadRuntimePaths(db)` 透传 baseDir + settingsFilename；存储异常降级默认路径，零回归（首次启动未配置 → `~/.claude/settings.json`）。
4. server 4 端点（`src/server.ts`）：`GET/PUT /api/settings/runtime`（路径读写 + 默认对照）+ `POST /api/settings/runtime/{install,uninstall}`（读已存路径调 installHooks/uninstallHooks，~ 展开，失败 `{ok:false,error}` 不静默）。`AppDeps` 加 `port?` + `installHooksFn?`/`uninstallHooksFn?` 注入点。
5. Web UI（`src/web/App.tsx` + `api.ts`）：设置 tab 第三 section `RuntimeSettings`——三路径输入框（默认值 placeholder）+ 保存/安装/卸载按钮 + 错误行。opencode 路径本次存而不用（安装仍走 CLI/launcher）。

执行：subagent-driven（6 实现 task）。`bun run typecheck && bun test` 全绿。

### 上线后观测（硬要求，结论回填本节）

1. codeagent 用户配 `~/.cac/setting.json` 后点「安装 hooks」→ SessionStart/Stop 是否真的触发（daemon 侧日志 + 新 distill job 出现）。
2. codeagent 闭环端到端跑通（capture → distill → approve → inject），参考 2026-07-31 opencode live smoke 模式。
3. 「卸载 hooks」后 codeagent 是否停止触发 memside（无新 capture）。
4. 部门 API（UI 配 LlmSettings）在 codeagent 环境是否 distill 成功。
```

- [ ] **Step 4: commit**

```bash
git add STATE.md
git commit -m "docs: STATE.md runtime path config section"
```

- [ ] **Step 5: 推远端开 PR**

```bash
git push -u origin feat/runtime-path-config
gh pr create --base master --title "feat: 运行环境自定义路径配置（商用 codeagent 适配）" --body "..."
```

PR body 模板：

```
## 背景
商用前 codeagent（claude code fork，读 `~/.cac/setting.json`）适配——原 installHooks 硬编码 `~/.claude/settings.json` 导致 hooks 到不了 codeagent，整个 capture→inject 闭环断。STATE.md 2026-07-23 codeagent 桥接遗留第 5 点。

## 改动
- RuntimePaths 配置（settings.ts）：三字段路径落库，缺失回默认。
- installHooks 加 settingsFilename + 新增 uninstallHooks（install 的对偶）。
- daemon/CLI 启动读配置透传，零回归。
- server 4 端点 + Web UI RuntimeSettings section（路径配置 + 安装/卸载按钮）。

## 测试
`bun run typecheck && bun test` 全绿（+N 测试）。

## 不碰
creds/distiller/adapter/scheduler（LLM 凭证已由 LlmSettings 覆盖）/ opencode 安装（nga 标准路径）/ launcher 本体。

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

---

## Self-Review

**1. Spec coverage:**
- §3.1 RuntimePaths 数据模型 → Task 1 ✓
- §3.2 install settingsFilename → Task 2 ✓
- §3.3 uninstallHooks → Task 2 ✓
- §3.4 daemon 启动安装 → Task 4 ✓
- §3.5 CLI 透传 → Task 4 ✓
- §3.6 server 4 端点 → Task 3 ✓
- §3.7 Web UI RuntimeSettings section → Task 6 + api wrapper Task 5 ✓
- §6 失败模式：不存在目录 mkdirSync（install.ts 已有，Task 2 沿用）/ ~ 展开（Task 3 install 端点）/ db 异常降级（Task 4 try/catch）/ malformed settings（Task 2 uninstallHooks）/ opencodeDir 存而不用（Task 1 接口 + Task 6 文案）✓
- §7 测试策略：纯函数（Task 1）/ install 层（Task 2）/ server 层（Task 3）/ daemon 层（Task 4）/ web-api 层（Task 5）/ App.tsx 源码层（Task 6）✓
- §8 上线后观测 → Task 7 STATE.md ✓

**2. Placeholder scan:** 无 TBD/TODO。所有 step 含实际测试代码 + 实现代码 + 具体行号。Task 3/4 的「检查 import 是否已有」是带具体决策的可执行指令（不是占位——给了「若无则加」的明确动作）。

**3. Type consistency:**
- `RuntimePaths` 三字段名（claudeDir/settingsFilename/opencodeDir）跨 Task 1/3/5/6 一致 ✓
- `InstallOpts.settingsFilename` 跨 Task 2/3/4 一致 ✓
- `uninstallHooks` 签名 `{ baseDir?, settingsFilename? }` 返回 `{ removed, settingsPath }` 跨 Task 2/3/5 一致 ✓
- `RuntimeSettingsState` 跨 Task 5/6 一致 ✓
- `AppDeps.installHooksFn`/`uninstallHooksFn`/`port` 跨 Task 3/4 一致 ✓
- `defaultRuntimePaths()` 跨 Task 1/3 一致 ✓

无问题，plan 可执行。

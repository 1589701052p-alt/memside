# 运行环境设置四槽独立配置 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把运行环境设置从 3 个共享字段拆成 4 个独立配置槽（claude code / codeagent / opencode / nga），每槽实时显示「已安装 / 未安装」状态。

**Architecture:** 数据模型 `RuntimePaths` 重构为四槽嵌套结构（hooks 型 = dir+settingsFilename、plugin 型 = dir），沿用 `app_settings` 平铺 key + 一次性迁移启发式归位旧 key。新增两个只读探针 `isHooksInstalled`/`isOpencodePluginInstalled` 读磁盘真实文件判安装状态。server 扩 install/uninstall target 维度（2→4）+ 新增 `GET /api/settings/runtime/status` 端点。Web 改 4 卡 + 状态徽标 + 每次 install/uninstall 后 re-probe。

**Tech Stack:** Bun + Hono + Drizzle + bun:sqlite + zod；前端 React 19 + inline style。无新依赖。

**Spec:** `docs/superpowers/specs/2026-08-19-runtime-settings-four-slots-design.md`

## Global Constraints

- 仓库为 Windows 开发环境，PowerShell 5.1 不支持 `&&` 命令连接符——跑 `bun run typecheck && bun test` 这类命令链必须在 **Bash 工具**中执行（或用 `;` 串联），严禁 PowerShell。
- 所有测试一律 `bun test` 运行，严禁 npm test（memside 以 Bun 为运行时，bun:test + bun:sqlite 等 Bun 专有 API，npm 走 Node 会失败）。
- 运行门槛：`bun run typecheck && bun test` 必须全绿才能 push。
- 测试不碰真实 `~/.claude` / `~/.config/opencode`——一律用 tmp dir + 注入 fake。
- 视觉风格复用 `src/web/App.tsx` 既有 inline style + `MemoryCard` 约定，不引新样式框架。
- `~` 展开由 server 端点做（`resolveHome`），UI 预览原样显示 `~`。
- 探针/迁移逻辑永不抛（缺文件/malformed 降级）。

---

## File Structure

- `src/settings.ts` — `RuntimePaths` 四槽重构 + 迁移启发式（`defaultRuntimePaths`/`loadRuntimePaths`/`saveRuntimePaths`）。
- `src/install.ts` — 新增 `isHooksInstalled`/`isOpencodePluginInstalled` 只读探针（纯增量，不动 install/uninstall）。
- `src/server.ts` — AppDeps 加两探针注入点；GET 形状换代；PUT per-slot；新增 GET status；install/uninstall target 扩四值。
- `src/daemon.ts` — `startDaemon` 注入两探针到 `createApp`。
- `src/web/api.ts` — `RuntimeSettingsState` 四槽；新增 `getRuntimeStatus`；target 扩四值。
- `src/web/runtime-paths.ts` — `RuntimePathDefaults` 四槽；resolve 函数签名跟改。
- `src/web/App.tsx` — `RuntimeSettings` 4 卡 + 状态徽标 + re-probe + 共享路径提示。
- 测试：`tests/settings.test.ts` / `tests/install-status.test.ts`(新) / `tests/settings-runtime-api.test.ts` / `tests/daemon-install-paths.test.ts` / `tests/web-runtime-resolve.test.ts` / `tests/web-api-runtime-target.test.ts` / `tests/app-source-assertions.test.ts`。

---

### Task 1: `RuntimePaths` 四槽数据模型 + 迁移启发式

**Files:**
- Modify: `src/settings.ts`（替换 `RuntimePaths` 接口 + `defaultRuntimePaths`/`loadRuntimePaths`/`saveRuntimePaths`）
- Test: `tests/settings.test.ts`

**Interfaces:**
- Consumes: `appSettings` 表（`src/db/schema`）、`eq`（drizzle）、`expandTilde`/`resolveHome`（既有私有函数，保留不动）。
- Produces:
  ```ts
  export interface RuntimePaths {
    claude: { dir: string; settingsFilename: string }
    codeagent: { dir: string; settingsFilename: string }
    opencode: { dir: string }
    nga: { dir: string }
  }
  export function defaultRuntimePaths(): RuntimePaths
  export function loadRuntimePaths(db: DbClient): RuntimePaths
  export function saveRuntimePaths(db: DbClient, patch: DeepPartialSlots): void
  // DeepPartialSlots = { claude?: { dir?: string; settingsFilename?: string }; codeagent?: {...}; opencode?: { dir?: string }; nga?: { dir?: string } }
  ```

- [ ] **Step 1: Write the failing test**

在 `tests/settings.test.ts` 末尾追加测试（用既有 tmp db helper 模式；先读该文件确认 helper 名 `createDb`/`mkTmpDb` 等——沿用文件内既有 db 创建方式）：

```typescript
// === 四槽独立配置（spec 2026-08-19-runtime-settings-four-slots）===
describe('RuntimePaths 四槽', () => {
  test('defaultRuntimePaths 四槽默认值', () => {
    const d = defaultRuntimePaths()
    expect(d.claude.dir.endsWith('.claude')).toBe(true)
    expect(d.claude.settingsFilename).toBe('settings.json')
    expect(d.codeagent.dir.endsWith('.cac')).toBe(true)
    expect(d.codeagent.settingsFilename).toBe('setting.json')
    expect(d.opencode.dir.endsWith('opencode')).toBe(true)
    expect(d.nga.dir.endsWith('opencode')).toBe(true)
  })

  test('loadRuntimePaths 缺失全部回默认', () => {
    const db = /* 既有 tmp db 创建 */
    const rp = loadRuntimePaths(db)
    const d = defaultRuntimePaths()
    expect(rp.claude).toEqual(d.claude)
    expect(rp.codeagent).toEqual(d.codeagent)
    expect(rp.opencode).toEqual(d.opencode)
    expect(rp.nga).toEqual(d.nga)
  })

  test('saveRuntimePaths per-slot 字段级合并', () => {
    const db = /* tmp db */
    saveRuntimePaths(db, { claude: { dir: '/x/.claude' } })
    let rp = loadRuntimePaths(db)
    expect(rp.claude.dir).toBe('/x/.claude')
    expect(rp.claude.settingsFilename).toBe('settings.json') // 未改回默认
    expect(rp.codeagent).toEqual(defaultRuntimePaths().codeagent) // 不动
    saveRuntimePaths(db, { codeagent: { settingsFilename: 'custom.json' } })
    rp = loadRuntimePaths(db)
    expect(rp.codeagent.settingsFilename).toBe('custom.json')
    expect(rp.codeagent.dir).toBe(defaultRuntimePaths().codeagent.dir)
  })

  test('saveRuntimePaths 空串删 key 回默认', () => {
    const db = /* tmp db */
    saveRuntimePaths(db, { claude: { dir: '/x/.claude' } })
    saveRuntimePaths(db, { claude: { dir: '' } })
    expect(loadRuntimePaths(db).claude.dir).toBe(defaultRuntimePaths().claude.dir)
  })

  test('~ 展开到 home（IF-1 回归）', () => {
    const db = /* tmp db */
    saveRuntimePaths(db, { opencode: { dir: '~/.config/opencode' } })
    const rp = loadRuntimePaths(db)
    expect(rp.opencode.dir).not.toContain('~')
    expect(rp.opencode.dir.length).toBeGreaterThan(1)
  })

  test('迁移：旧 claude_dir ~/.cac + settings_filename setting.json 归 codeagent 槽', () => {
    const db = /* tmp db，直接写旧 key */
    db.insert(appSettings).values({ key: 'runtime.claude_dir', value: '~/.cac', updatedAt: 0 }).run()
    db.insert(appSettings).values({ key: 'runtime.settings_filename', value: 'setting.json', updatedAt: 0 }).run()
    const rp = loadRuntimePaths(db)
    expect(rp.codeagent.dir.endsWith('.cac')).toBe(true)
    expect(rp.codeagent.settingsFilename).toBe('setting.json')
    expect(rp.claude).toEqual(defaultRuntimePaths().claude) // 取默认
  })

  test('迁移：旧 claude_dir ~/.claude + settings.json 归 claude 槽', () => {
    const db = /* tmp db */
    db.insert(appSettings).values({ key: 'runtime.claude_dir', value: '~/.claude', updatedAt: 0 }).run()
    db.insert(appSettings).values({ key: 'runtime.settings_filename', value: 'settings.json', updatedAt: 0 }).run()
    const rp = loadRuntimePaths(db)
    expect(rp.claude.dir.endsWith('.claude')).toBe(true)
    expect(rp.codeagent).toEqual(defaultRuntimePaths().codeagent)
  })

  test('迁移：旧 opencode_dir 归 opencode 槽，nga 取默认', () => {
    const db = /* tmp db */
    db.insert(appSettings).values({ key: 'runtime.opencode_dir', value: '~/.config/opencode', updatedAt: 0 }).run()
    const rp = loadRuntimePaths(db)
    expect(rp.opencode.dir.endsWith('opencode')).toBe(true)
    expect(rp.nga).toEqual(defaultRuntimePaths().nga)
  })

  test('迁移：新 key 已写则忽略旧 key', () => {
    const db = /* tmp db */
    db.insert(appSettings).values({ key: 'runtime.claude_dir', value: '~/.cac', updatedAt: 0 }).run()
    db.insert(appSettings).values({ key: 'runtime.settings_filename', value: 'setting.json', updatedAt: 0 }).run()
    saveRuntimePaths(db, { claude: { dir: '/new/.claude' } })
    const rp = loadRuntimePaths(db)
    expect(rp.claude.dir).toBe('/new/.claude') // 新 key 优先，不受旧 key 干扰
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/settings.test.ts`
Expected: FAIL（旧 `RuntimePaths` 是三字段扁平形，新测试断言四槽嵌套，类型/断言不匹配）。

- [ ] **Step 3: Write minimal implementation**

替换 `src/settings.ts` 的 `RuntimePaths` 区段（原 §108-182）。新 key 常量：

```typescript
const RUNTIME_KEYS = {
  claudeDir: 'runtime.claude.dir',
  claudeSettingsFilename: 'runtime.claude.settings_filename',
  codeagentDir: 'runtime.codeagent.dir',
  codeagentSettingsFilename: 'runtime.codeagent.settings_filename',
  opencodeDir: 'runtime.opencode.dir',
  ngaDir: 'runtime.nga.dir',
} as const

// 旧 key（迁移探测，不写）
const LEGACY_KEYS = {
  claudeDir: 'runtime.claude_dir',
  settingsFilename: 'runtime.settings_filename',
  opencodeDir: 'runtime.opencode_dir',
} as const

export interface RuntimePaths {
  claude: { dir: string; settingsFilename: string }
  codeagent: { dir: string; settingsFilename: string }
  opencode: { dir: string }
  nga: { dir: string }
}

export function defaultRuntimePaths(): RuntimePaths {
  const home = resolveHome()
  return {
    claude: { dir: join(home, '.claude'), settingsFilename: 'settings.json' },
    codeagent: { dir: join(home, '.cac'), settingsFilename: 'setting.json' },
    opencode: { dir: join(home, '.config', 'opencode') },
    nga: { dir: join(home, '.config', 'opencode') },
  }
}

export function loadRuntimePaths(db: DbClient): RuntimePaths {
  const rows = db.select().from(appSettings).all()
  const map = new Map(rows.map((r) => [r.key, r.value]))
  const d = defaultRuntimePaths()
  const legClaudeDir = map.get(LEGACY_KEYS.claudeDir)
  const legSettingsFilename = map.get(LEGACY_KEYS.settingsFilename)
  // 迁移启发式：旧 claude_dir + settings_filename 共享 key 归位
  // settingsFilename === 'setting.json' 或 dir 以 .cac 结尾 -> codeagent，否则 claude
  const legIsCodeagent = !!(
    legClaudeDir && (legSettingsFilename === 'setting.json' || legClaudeDir.replace(/\\/g, '/').endsWith('.cac'))
  )
  const slot = <T>(newKey: string | undefined, legacy: string | undefined, def: T): T => {
    const v = (newKey && newKey.length > 0 ? newKey : legacy)
    return (v && v.length > 0 ? (expandTilde(v) as unknown as T) : def)
  }
  // 各槽：新 key 优先，旧 key 仅在归位到本槽时作为 fallback
  const claudeDir = map.get(RUNTIME_KEYS.claudeDir)
  const claudeFn = map.get(RUNTIME_KEYS.claudeSettingsFilename)
  const codeagentDir = map.get(RUNTIME_KEYS.codeagentDir)
  const codeagentFn = map.get(RUNTIME_KEYS.codeagentSettingsFilename)
  const opencodeDir = map.get(RUNTIME_KEYS.opencodeDir)
  const ngaDir = map.get(RUNTIME_KEYS.ngaDir)
  return {
    claude: {
      dir: slot(claudeDir, legIsCodeagent ? undefined : legClaudeDir, d.claude.dir),
      settingsFilename: claudeFn && claudeFn.length > 0 ? claudeFn : (legIsCodeagent ? d.claude.settingsFilename : (legSettingsFilename && legSettingsFilename.length > 0 ? legSettingsFilename : d.claude.settingsFilename)),
    },
    codeagent: {
      dir: slot(codeagentDir, legIsCodeagent ? legClaudeDir : undefined, d.codeagent.dir),
      settingsFilename: codeagentFn && codeagentFn.length > 0 ? codeagentFn : (legIsCodeagent ? (legSettingsFilename && legSettingsFilename.length > 0 ? legSettingsFilename : d.codeagent.settingsFilename) : d.codeagent.settingsFilename),
    },
    opencode: { dir: slot(opencodeDir, map.get(LEGACY_KEYS.opencodeDir), d.opencode.dir) },
    nga: { dir: slot(ngaDir, undefined, d.n ga.dir) },  // nga 无旧 key，仅新 key/默认
  }
}
```

注意上面 `d.n ga.dir` 是笔误占位，实现时写 `d.nga.dir`。

`saveRuntimePaths` 改为 per-slot 字段级：

```typescript
export type RuntimePathsPatch = {
  claude?: { dir?: string; settingsFilename?: string }
  codeagent?: { dir?: string; settingsFilename?: string }
  opencode?: { dir?: string }
  nga?: { dir?: string }
}

export function saveRuntimePaths(db: DbClient, patch: RuntimePathsPatch): void {
  const upsert = (key: string, value: string) => {
    db.insert(appSettings).values({ key, value, updatedAt: Date.now() })
      .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: Date.now() } }).run()
  }
  const del = (key: string) => db.delete(appSettings).where(eq(appSettings.key, key)).run()
  const w = (key: string, v: string | undefined) => {
    if (v === undefined) return
    v === '' ? del(key) : upsert(key, v)
  }
  if (patch.claude) { w(RUNTIME_KEYS.claudeDir, patch.claude.dir); w(RUNTIME_KEYS.claudeSettingsFilename, patch.claude.settingsFilename) }
  if (patch.codeagent) { w(RUNTIME_KEYS.codeagentDir, patch.codeagent.dir); w(RUNTIME_KEYS.codeagentSettingsFilename, patch.codeagent.settingsFilename) }
  if (patch.opencode) { w(RUNTIME_KEYS.opencodeDir, patch.opencode.dir) }
  if (patch.nga) { w(RUNTIME_KEYS.ngaDir, patch.nga.dir) }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/settings.test.ts`
Expected: PASS。

- [ ] **Step 5: Run typecheck + full suite to catch downstream breaks**

Run: `bun run typecheck && bun test`
Expected: **编译报错**——`server.ts` / `api.ts` / `App.tsx` / `runtime-paths.ts` 还在用旧三字段形状。**这是预期的**——本 task 只改数据模型层，下游在后续 task 修。本 task 提交时**仅 `git add src/settings.ts tests/settings.test.ts`**，不 push（全绿门槛在所有 task 完成后）。typecheck 暂时不绿属已知中间态。

- [ ] **Step 6: Commit**

```bash
git add src/settings.ts tests/settings.test.ts
git commit -m "refactor(settings): RuntimePaths 四槽独立配置 + 迁移启发式

把 claude/codeagent/opencode/nga 拆成四个独立配置槽（hooks 型 dir+settingsFilename，
plugin 型 dir）。旧 3 共享 key 启发式归位（settingsFilename=setting.json 或 dir 以
.cac 结尾 -> codeagent），零数据丢失。

Part 1/N of four-slots runtime settings (spec 2026-08-19).

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: 安装状态探针 `isHooksInstalled` / `isOpencodePluginInstalled`

**Files:**
- Modify: `src/install.ts`（追加两个只读探针函数）
- Test: `tests/install-status.test.ts`（新建）

**Interfaces:**
- Consumes: `resolveHome`/`join`/`existsSync`/`readFileSync`（install.ts 既有 import）、`MEMSIDE_TAG`、`EVENTS`。
- Produces:
  ```ts
  export function isHooksInstalled(opts: { baseDir?: string; settingsFilename?: string }): { installed: boolean; settingsPath: string }
  export function isOpencodePluginInstalled(opts: { baseDir?: string }): { installed: boolean; pluginPath: string; dirExists: boolean }
  ```

- [ ] **Step 1: Write the failing test**

新建 `tests/install-status.test.ts`。先用既有 tmp dir + `installHooks`/`installOpencodePlugin` 制造「已装」状态（沿用 `tests/install.test.ts`/`tests/install-opencode.test.ts` 的 tmp dir 模式——先读确认 helper）：

```typescript
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installHooks, installOpencodePlugin, isHooksInstalled, isOpencodePluginInstalled, uninstallHooks, uninstallOpencodePlugin } from '../src/install'

function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), 'memside-status-'))
}

describe('isHooksInstalled', () => {
  test('装后探测为 true', () => {
    const dir = mkTmp()
    installHooks({ port: 7777, baseDir: dir, settingsFilename: 'settings.json' })
    const r = isHooksInstalled({ baseDir: dir, settingsFilename: 'settings.json' })
    expect(r.installed).toBe(true)
    expect(r.settingsPath).toBe(join(dir, 'settings.json'))
  })
  test('未装/缺文件 -> false', () => {
    const dir = mkTmp()
    const r = isHooksInstalled({ baseDir: dir, settingsFilename: 'settings.json' })
    expect(r.installed).toBe(false)
  })
  test('malformed settings.json -> false 不抛', () => {
    const dir = mkTmp()
    const { writeFileSync } = require('node:fs')
    writeFileSync(join(dir, 'settings.json'), '{ not json')
    const r = isHooksInstalled({ baseDir: dir, settingsFilename: 'settings.json' })
    expect(r.installed).toBe(false)
  })
  test('纯用户 hook 无标记 -> false', () => {
    const dir = mkTmp()
    const { writeFileSync } = require('node:fs')
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({
      hooks: { SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo user' }] }] },
    }, null, 2))
    const r = isHooksInstalled({ baseDir: dir, settingsFilename: 'settings.json' })
    expect(r.installed).toBe(false)
  })
  test('卸载后 -> false', () => {
    const dir = mkTmp()
    installHooks({ port: 7777, baseDir: dir, settingsFilename: 'settings.json' })
    uninstallHooks({ baseDir: dir, settingsFilename: 'settings.json' })
    expect(isHooksInstalled({ baseDir: dir, settingsFilename: 'settings.json' }).installed).toBe(false)
  })
})

describe('isOpencodePluginInstalled', () => {
  test('装后探测为 true + dirExists', () => {
    const dir = mkTmp()
    installOpencodePlugin({ port: 7777, baseDir: dir, pluginSrcDir: 'opencode-plugin' })
    const r = isOpencodePluginInstalled({ baseDir: dir })
    expect(r.installed).toBe(true)
    expect(r.dirExists).toBe(true)
  })
  test('删 destDir 但 json 有条目 -> false + dirExists:false', () => {
    const dir = mkTmp()
    installOpencodePlugin({ port: 7777, baseDir: dir, pluginSrcDir: 'opencode-plugin' })
    const { rmSync } = require('node:fs')
    rmSync(join(dir, 'memside-opencode'), { recursive: true, force: true })
    const r = isOpencodePluginInstalled({ baseDir: dir })
    expect(r.installed).toBe(false)  // dir 缺
    expect(r.dirExists).toBe(false)
  })
  test('缺文件/malformed -> false 不抛', () => {
    const dir = mkTmp()
    const r = isOpencodePluginInstalled({ baseDir: dir })
    expect(r.installed).toBe(false)
    expect(r.dirExists).toBe(false)
  })
  test('卸载后 -> false', () => {
    const dir = mkTmp()
    installOpencodePlugin({ port: 7777, baseDir: dir, pluginSrcDir: 'opencode-plugin' })
    uninstallOpencodePlugin({ baseDir: dir })
    expect(isOpencodePluginInstalled({ baseDir: dir }).installed).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/install-status.test.ts`
Expected: FAIL（`isHooksInstalled`/`isOpencodePluginInstalled` 未导出）。

- [ ] **Step 3: Write minimal implementation**

在 `src/install.ts` 末尾追加（复刻 `uninstallHooks`/`uninstallOpencodePlugin` 的读逻辑，只读不写）：

```typescript
/**
 * 只读探针：settings.json 是否含 memside hook 标记（MEMSIDE_TAG）。永不抛。
 * 复刻 uninstallHooks 的解析路径：缺文件/malformed -> installed:false。
 */
export function isHooksInstalled(opts: { baseDir?: string; settingsFilename?: string }): { installed: boolean; settingsPath: string } {
  const claudeDir = opts.baseDir ?? join(resolveHome(), '.claude')
  const settingsPath = join(claudeDir, opts.settingsFilename ?? 'settings.json')
  if (!existsSync(settingsPath)) return { installed: false, settingsPath }
  let settings: Record<string, unknown>
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { installed: false, settingsPath }
    settings = parsed as Record<string, unknown>
  } catch {
    return { installed: false, settingsPath }
  }
  const hooks = settings.hooks as Record<string, unknown[]> | undefined
  if (!hooks || typeof hooks !== 'object') return { installed: false, settingsPath }
  for (const ev of EVENTS) {
    const groups = hooks[ev]
    if (!Array.isArray(groups)) continue
    for (const group of groups) {
      if (!group || typeof group !== 'object') continue
      const g = group as { hooks?: Array<{ command?: string }> }
      const cmds = (g.hooks ?? []).map((h) => h.command ?? '').join('|')
      if (cmds.includes(MEMSIDE_TAG)) return { installed: true, settingsPath }
    }
  }
  return { installed: false, settingsPath }
}

/**
 * 只读探针：opencode.json 是否注册了 memside-opencode 插件且 destDir 存在。永不抛。
 */
export function isOpencodePluginInstalled(opts: { baseDir?: string }): { installed: boolean; pluginPath: string; dirExists: boolean } {
  const ocdDir = opts.baseDir ?? join(resolveHome(), '.config', 'opencode')
  const destDir = join(ocdDir, 'memside-opencode')
  const dirExists = existsSync(destDir)
  const settingsPath = join(ocdDir, 'opencode.json')
  let hasEntry = false
  if (existsSync(settingsPath)) {
    try {
      const p = JSON.parse(readFileSync(settingsPath, 'utf-8'))
      if (p && typeof p === 'object' && !Array.isArray(p)) {
        const plugin = Array.isArray((p as Record<string, unknown>).plugin) ? (p as Record<string, unknown[]>).plugin : []
        hasEntry = plugin.some((e) => typeof e === 'string' && e.includes('memside-opencode'))
      }
    } catch { /* malformed -> no entry */ }
  }
  return { installed: dirExists && hasEntry, pluginPath: settingsPath, dirExists }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/install-status.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/install.ts tests/install-status.test.ts
git commit -m "feat(install): 安装状态只读探针 isHooksInstalled/isOpencodePluginInstalled

复刻 uninstall 读逻辑的只读版本，判 settings.json 含 MEMSIDE_TAG / opencode.json
注册 memside-opencode 且 destDir 存在。永不抛。供设置页状态徽标实时探测磁盘。

Part 2/N of four-slots runtime settings (spec 2026-08-19).

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: server 端点四槽形状 + status 端点 + target 扩四值

**Files:**
- Modify: `src/server.ts`（AppDeps 加两探针注入点；GET/PUT 形状换代；新增 GET status；install/uninstall target 扩四值；§1086-1164）
- Test: `tests/settings-runtime-api.test.ts`

**Interfaces:**
- Consumes: `loadRuntimePaths`/`saveRuntimePaths`/`defaultRuntimePaths`（Task 1 新形状）、`isHooksInstalled`/`isOpencodePluginInstalled`（Task 2）、`resolveHome`/`join`（既有）。
- Produces:
  - `GET /api/settings/runtime` → 4 槽 + defaults
  - `PUT /api/settings/runtime` → per-slot patch
  - `GET /api/settings/runtime/status` → `{claude:{installed,path}, codeagent:..., opencode:..., nga:...}`
  - `POST /api/settings/runtime/{install,uninstall}?target=claude|codeagent|opencode|nga`
  - AppDeps: `isHooksInstalledFn?`/`isOpencodePluginInstalledFn?`

- [ ] **Step 1: Write the failing test**

在 `tests/settings-runtime-api.test.ts` 追加（沿用既有 `createApp` + `deps` fake 模式；先读确认 helper）：

```typescript
// === 四槽 + status（spec 2026-08-19）===
describe('runtime 四槽 + status', () => {
  test('GET 返回四槽 + defaults 形状', async () => {
    const { app } = /* 既有 createApp with fake db */
    const res = await app.request('/api/settings/runtime')
    const data = await res.json()
    expect(data.claude).toEqual(expect.objectContaining({ dir: expect.any(String), settingsFilename: 'settings.json' }))
    expect(data.codeagent).toEqual(expect.objectContaining({ dir: expect.any(String), settingsFilename: 'setting.json' }))
    expect(data.opencode).toEqual(expect.objectContaining({ dir: expect.any(String) }))
    expect(data.nga).toEqual(expect.objectContaining({ dir: expect.any(String) }))
    expect(data.defaults).toBeDefined()
  })

  test('PUT per-slot 只改本槽', async () => {
    const { app } = /* createApp */
    await app.request('/api/settings/runtime', { method: 'PUT', body: JSON.stringify({ claude: { dir: '/x/.claude' } }), headers: { 'content-type': 'application/json' } })
    const res = await app.request('/api/settings/runtime')
    const data = await res.json()
    expect(data.claude.dir).toBe('/x/.claude')
    expect(data.codeagent).toEqual(data.defaults.codeagent) // 不动
  })

  test('GET status 注入 fake 探针', async () => {
    const calls: any[] = []
    const { app } = createApp({
      db: /* fake db */,
      isHooksInstalledFn: (o) => { calls.push(['hooks', o]); return { installed: o.settingsFilename === 'setting.json', settingsPath: join(o.baseDir ?? '', o.settingsFilename ?? 'settings.json') } },
      isOpencodePluginInstalledFn: (o) => { calls.push(['oc', o]); return { installed: true, pluginPath: 'p', dirExists: true } },
    })
    const res = await app.request('/api/settings/runtime/status')
    const data = await res.json()
    expect(data.claude.installed).toBe(false)
    expect(data.codeagent.installed).toBe(true)
    expect(data.opencode.installed).toBe(true)
    expect(data.nga.installed).toBe(true)
    // fake 收到的 baseDir 已展开（无 ~）
    expect(calls.some((c) => c[0] === 'hooks' && !c[1].baseDir.includes('~'))).toBe(true)
  })

  test('GET status 探针缺省 -> installed:false 不抛', async () => {
    const { app } = createApp({ db: /* fake db */ })
    const res = await app.request('/api/settings/runtime/status')
    const data = await res.json()
    expect(data.claude.installed).toBe(false)
    expect(data.codeagent.installed).toBe(false)
    expect(data.opencode.installed).toBe(false)
    expect(data.nga.installed).toBe(false)
  })

  test('install?target=codeagent 调 installHooksFn 传 codeagent 槽字段', async () => {
    const calls: any[] = []
    const { app } = createApp({ db: /* fake db */, installHooksFn: (o) => { calls.push(o) } })
    // 先 PUT codeagent 槽
    await app.request('/api/settings/runtime', { method: 'PUT', body: JSON.stringify({ codeagent: { dir: '~/.cac', settingsFilename: 'setting.json' } }), headers: { 'content-type': 'application/json' } })
    const res = await app.request('/api/settings/runtime/install?target=codeagent', { method: 'POST' })
    const data = await res.json()
    expect(data.ok).toBe(true)
    expect(calls[0].settingsFilename).toBe('setting.json')
    expect(calls[0].baseDir.endsWith('.cac')).toBe(true)
  })

  test('uninstall?target=codeagent', async () => {
    const calls: any[] = []
    const { app } = createApp({ db: /* fake db */, uninstallHooksFn: () => ({ removed: 2, settingsPath: 'p' }) })
    await app.request('/api/settings/runtime', { method: 'PUT', body: JSON.stringify({ codeagent: { dir: '~/.cac' } }), headers: { 'content-type': 'application/json' } })
    const res = await app.request('/api/settings/runtime/uninstall?target=codeagent', { method: 'POST' })
    const data = await res.json()
    expect(data.ok).toBe(true)
    expect(data.removed).toBe(2)
  })

  test('install?target=nga 调 installOpencodePluginFn 传 nga 槽 dir', async () => {
    const calls: any[] = []
    const { app } = createApp({ db: /* fake db */, installOpencodePluginFn: (o) => { calls.push(o) } })
    await app.request('/api/settings/runtime', { method: 'PUT', body: JSON.stringify({ nga: { dir: '~/.config/nga' } }), headers: { 'content-type': 'application/json' } })
    const res = await app.request('/api/settings/runtime/install?target=nga', { method: 'POST' })
    const data = await res.json()
    expect(data.ok).toBe(true)
    expect(calls[0].baseDir.endsWith('nga')).toBe(true)
  })

  test('install?target=claude 默认行为不变（回归锁）', async () => {
    const calls: any[] = []
    const { app } = createApp({ db: /* fake db */, installHooksFn: (o) => { calls.push(o) } })
    await app.request('/api/settings/runtime', { method: 'PUT', body: JSON.stringify({ claude: { dir: '~/.claude' } }), headers: { 'content-type': 'application/json' } })
    await app.request('/api/settings/runtime/install', { method: 'POST' })  // 无 target -> claude
    expect(calls[0].baseDir.endsWith('.claude')).toBe(true)
  })

  test('target=invalid -> 400', async () => {
    const { app } = createApp({ db: /* fake db */ })
    const res = await app.request('/api/settings/runtime/install?target=foo', { method: 'POST' })
    expect(res.status).toBe(400)
  })

  test('install?target=nga 缺 installOpencodePluginFn -> ok:false', async () => {
    const { app } = createApp({ db: /* fake db */ })  // 不注入 installOpencodePluginFn
    const res = await app.request('/api/settings/runtime/install?target=nga', { method: 'POST' })
    const data = await res.json()
    expect(data.ok).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/settings-runtime-api.test.ts`
Expected: FAIL（GET 还是旧三字段形，无 status 端点，target 不认 codeagent/nga）。

- [ ] **Step 3: Write minimal implementation**

改 `src/server.ts`：

1. AppDeps 加两注入点（在现有 `uninstallOpencodePluginFn` 旁）：
```typescript
isHooksInstalledFn?: (opts: { baseDir?: string; settingsFilename?: string }) => { installed: boolean; settingsPath: string }
isOpencodePluginInstalledFn?: (opts: { baseDir?: string }) => { installed: boolean; pluginPath: string; dirExists: boolean }
```

2. import 探针：`import { installHooks, uninstallHooks, isHooksInstalled, isOpencodePluginInstalled } from '@/install'`

3. 替换 §1086-1164 既有 runtime 端点。`~` 展开辅助：
```typescript
const expandTildePath = (p: string) => p.startsWith('~') ? join(resolveHome(), p.slice(1)) : p
const HOOK_TARGETS = ['claude', 'codeagent'] as const
const PLUGIN_TARGETS = ['opencode', 'nga'] as const
type Target = typeof HOOK_TARGETS[number] | typeof PLUGIN_TARGETS[number]
```

GET：
```typescript
app.get('/api/settings/runtime', (c) => {
  const rp = loadRuntimePaths(deps.db)
  return c.json({ ...rp, defaults: defaultRuntimePaths() })
})
```

PUT schema + handler（per-slot）：
```typescript
const runtimePutSchema = z.object({
  claude: z.object({ dir: z.string().optional(), settingsFilename: z.string().optional() }).optional(),
  codeagent: z.object({ dir: z.string().optional(), settingsFilename: z.string().optional() }).optional(),
  opencode: z.object({ dir: z.string().optional() }).optional(),
  nga: z.object({ dir: z.string().optional() }).optional(),
})
app.put('/api/settings/runtime', async (c) => {
  const parsed = runtimePutSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'invalid body' }, 400)
  saveRuntimePaths(deps.db, parsed.data)
  const rp = loadRuntimePaths(deps.db)
  return c.json({ ...rp, defaults: defaultRuntimePaths() })
})
```

GET status（新增）：
```typescript
app.get('/api/settings/runtime/status', (c) => {
  const rp = loadRuntimePaths(deps.db)
  const probeHooks = (dir: string, fn: string) => {
    const baseDir = expandTildePath(dir)
    if (deps.isHooksInstalledFn) {
      const r = deps.isHooksInstalledFn({ baseDir, settingsFilename: fn })
      return { installed: r.installed, path: r.settingsPath }
    }
    return { installed: false, path: join(baseDir, fn).replace(/\\/g, '/') }
  }
  const probePlugin = (dir: string) => {
    const baseDir = expandTildePath(dir)
    if (deps.isOpencodePluginInstalledFn) {
      const r = deps.isOpencodePluginInstalledFn({ baseDir })
      return { installed: r.installed, path: r.pluginPath }
    }
    return { installed: false, path: join(baseDir, 'opencode.json').replace(/\\/g, '/') }
  }
  return c.json({
    claude: probeHooks(rp.claude.dir, rp.claude.settingsFilename),
    codeagent: probeHooks(rp.codeagent.dir, rp.codeagent.settingsFilename),
    opencode: probePlugin(rp.opencode.dir),
    nga: probePlugin(rp.nga.dir),
  })
})
```

install / uninstall（target 扩四值）。先定义共用分流：
```typescript
app.post('/api/settings/runtime/install', (c) => {
  const target = c.req.query('target') ?? 'claude'
  if (!HOOK_TARGETS.includes(target as any) && !PLUGIN_TARGETS.includes(target as any)) {
    return c.json({ error: `invalid target: ${target}` }, 400)
  }
  const rp = loadRuntimePaths(deps.db)
  try {
    if (target === 'claude' || target === 'codeagent') {
      const slot = target === 'claude' ? rp.claude : rp.codeagent
      const baseDir = expandTildePath(slot.dir)
      doInstall({ port, baseDir, settingsFilename: slot.settingsFilename })
      return c.json({ ok: true, settingsPath: join(baseDir, slot.settingsFilename) })
    }
    // opencode / nga
    if (!doInstallOpencode) {
      return c.json({ ok: false, error: 'opencode 插件源在本启动模式下不可用（仅 dev/exe 启动支持），请用命令行安装' })
    }
    const slot = target === 'opencode' ? rp.opencode : rp.nga
    const baseDir = expandTildePath(slot.dir)
    doInstallOpencode({ baseDir })
    return c.json({ ok: true, pluginPath: join(baseDir, 'memside-opencode') })
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message })
  }
})
```
uninstall 同构（hook 分支调 `doUninstall`，plugin 分支调 `doUninstallOpencode`，缺 `doUninstallOpencode` 降级）。

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/settings-runtime-api.test.ts`
Expected: PASS。

- [ ] **Step 5: Run typecheck**

Run: `bun run typecheck`
Expected: 仍可能在 `api.ts`/`App.tsx` 报错（下游未改），但 `server.ts`/`settings.ts`/`install.ts` 自身应干净。下游 task 修。

- [ ] **Step 6: Commit**

```bash
git add src/server.ts tests/settings-runtime-api.test.ts
git commit -m "feat(server): runtime 四槽形状 + status 探针端点 + target 扩四值

GET/PUT 改四槽 per-slot；新增 GET /api/settings/runtime/status 实时探测磁盘安装
状态；install/uninstall target 扩到 claude|codeagent|opencode|nga。

Part 3/N of four-slots runtime settings (spec 2026-08-19).

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: daemon 注入两探针

**Files:**
- Modify: `src/daemon.ts`（`startDaemon` 组装 AppDeps 时注入 `isHooksInstalledFn`/`isOpencodePluginInstalledFn`）
- Test: `tests/daemon-install-paths.test.ts`

**Interfaces:**
- Consumes: `isHooksInstalled`/`isOpencodePluginInstalled`（Task 2）、既有 `installHooks`/`uninstallHooks`/`installOpencodePlugin`/`uninstallOpencodePlugin` 注入。
- Produces: AppDeps 两探针在生产 daemon 中可用。

- [ ] **Step 1: Write the failing test**

在 `tests/daemon-install-paths.test.ts` 追加（沿用既有 startDaemon helper 模式；先读确认）：

```typescript
test('startDaemon 注入 isHooksInstalledFn / isOpencodePluginInstalledFn', () => {
  const captured: any = {}
  /* 既有 startDaemon helper，但拦截 createApp 拿 deps */
  startDaemonWithCapturedDeps(captured, { /* opts */ })
  expect(captured.isHooksInstalledFn).toBeTypeOf('function')
  expect(captured.isOpencodePluginInstalledFn).toBeTypeOf('function')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/daemon-install-paths.test.ts`
Expected: FAIL（deps 无两探针字段）。

- [ ] **Step 3: Write minimal implementation**

`src/daemon.ts` `startDaemon` 组装 AppDeps 处（在现有 `uninstallOpencodePluginFn` 旁）加：

```typescript
isHooksInstalledFn: (o) => isHooksInstalled(o),
isOpencodePluginInstalledFn: (o) => isOpencodePluginInstalled(o),
```

并 import：`import { isHooksInstalled, isOpencodePluginInstalled } from '@/install'`（合并到既有 install.ts import 行）。

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/daemon-install-paths.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/daemon.ts tests/daemon-install-paths.test.ts
git commit -m "feat(daemon): 注入安装状态探针到 createApp

让生产 daemon 的 /api/settings/runtime/status 能读真实磁盘探针。

Part 4/N of four-slots runtime settings (spec 2026-08-19).

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: web-api client 四槽形状 + getRuntimeStatus + target 扩四值

**Files:**
- Modify: `src/web/api.ts`（`RuntimeSettingsState` 四槽；`saveRuntimeSettings` per-slot；新增 `getRuntimeStatus`；target 扩四值）
- Test: `tests/web-api-runtime-target.test.ts`

**Interfaces:**
- Consumes: server 四槽形状（Task 3）。
- Produces:
  ```ts
  export interface RuntimeSettingsState {
    claude: { dir: string; settingsFilename: string }
    codeagent: { dir: string; settingsFilename: string }
    opencode: { dir: string }
    nga: { dir: string }
    defaults: RuntimeSettingsState 去掉 defaults
  }
  export type RuntimeTarget = 'claude' | 'codeagent' | 'opencode' | 'nga'
  export interface RuntimeStatus {
    claude: { installed: boolean; path: string }
    codeagent: { installed: boolean; path: string }
    opencode: { installed: boolean; path: string }
    nga: { installed: boolean; path: string }
  }
  export async function getRuntimeStatus(fetchFn?: FetchLike): Promise<RuntimeStatus>
  ```

- [ ] **Step 1: Write the failing test**

在 `tests/web-api-runtime-target.test.ts` 追加（沿用既有 fake fetch 模式；先读确认 helper）：

```typescript
// === 四槽 + status client（spec 2026-08-19）===
test('RuntimeSettingsState 四槽形状', async () => {
  const fake = asyncFakeFetch(JSON.stringify({
    claude: { dir: '/a', settingsFilename: 'settings.json' },
    codeagent: { dir: '/b', settingsFilename: 'setting.json' },
    opencode: { dir: '/c' },
    nga: { dir: '/d' },
    defaults: { claude: { dir: '', settingsFilename: 'settings.json' }, codeagent: { dir: '', settingsFilename: 'setting.json' }, opencode: { dir: '' }, nga: { dir: '' } },
  }))
  const s = await getRuntimeSettings(fake)
  expect(s.claude.dir).toBe('/a')
  expect(s.codeagent.settingsFilename).toBe('setting.json')
})

test('saveRuntimeSettings per-slot patch 透传', async () => {
  const calls: any[] = []
  const fake = async (url: string, init?: any) => { calls.push({ url, body: init?.body }); return new Response(JSON.stringify({ claude:{dir:'/a',settingsFilename:'settings.json'},codeagent:{dir:'/b',settingsFilename:'setting.json'},opencode:{dir:'/c'},nga:{dir:'/d'},defaults:{...} }), { status: 200 }) }
  await saveRuntimeSettings({ codeagent: { dir: '/b' } }, fake)
  expect(JSON.parse(calls[0].body)).toEqual({ codeagent: { dir: '/b' } })
})

test('getRuntimeStatus 调 status 端点', async () => {
  const calls: any[] = []
  const fake = async (url: string) => { calls.push(url); return new Response(JSON.stringify({ claude:{installed:true,path:'/a'},codeagent:{installed:false,path:'/b'},opencode:{installed:true,path:'/c'},nga:{installed:false,path:'/d'} }), { status: 200 }) }
  const s = await getRuntimeStatus(fake)
  expect(calls[0]).toBe('/api/settings/runtime/status')
  expect(s.claude.installed).toBe(true)
  expect(s.nga.installed).toBe(false)
})

test('installRuntimeHooks 接受四值 target', async () => {
  const calls: any[] = []
  const fake = async (url: string) => { calls.push(url); return new Response(JSON.stringify({ ok: true }), { status: 200 }) }
  await installRuntimeHooks('codeagent', fake)
  await installRuntimeHooks('nga', fake)
  expect(calls[0]).toContain('target=codeagent')
  expect(calls[1]).toContain('target=nga')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/web-api-runtime-target.test.ts`
Expected: FAIL（`getRuntimeStatus` 不存在；target 类型不含 codeagent/nga）。

- [ ] **Step 3: Write minimal implementation**

替换 `src/web/api.ts` §573-619 区段：

```typescript
export type RuntimeTarget = 'claude' | 'codeagent' | 'opencode' | 'nga'

export interface RuntimeSlotDefaults {
  claude: { dir: string; settingsFilename: string }
  codeagent: { dir: string; settingsFilename: string }
  opencode: { dir: string }
  nga: { dir: string }
}

export interface RuntimeSettingsState extends RuntimeSlotDefaults {
  defaults: RuntimeSlotDefaults
}

export async function getRuntimeSettings(fetchFn: FetchLike = fetch): Promise<RuntimeSettingsState> {
  const res = await fetchFn('/api/settings/runtime')
  return (await res.json()) as RuntimeSettingsState
}

export async function saveRuntimeSettings(
  patch: Partial<RuntimeSlotDefaults>,
  fetchFn: FetchLike = fetch,
): Promise<RuntimeSettingsState> {
  const res = await fetchFn('/api/settings/runtime', {
    method: 'PUT',
    body: JSON.stringify(patch),
    headers: { 'content-type': 'application/json' },
  })
  const data = (await res.json()) as RuntimeSettingsState & { error?: string }
  if (!res.ok) throw new Error(data.error ?? 'save runtime settings failed')
  return data
}

export interface RuntimeStatus {
  claude: { installed: boolean; path: string }
  codeagent: { installed: boolean; path: string }
  opencode: { installed: boolean; path: string }
  nga: { installed: boolean; path: string }
}

/** GET /api/settings/runtime/status — 4 槽实时安装状态（读磁盘探针）。 */
export async function getRuntimeStatus(fetchFn: FetchLike = fetch): Promise<RuntimeStatus> {
  const res = await fetchFn('/api/settings/runtime/status')
  return (await res.json()) as RuntimeStatus
}

export async function installRuntimeHooks(
  target: RuntimeTarget = 'claude', fetchFn: FetchLike = fetch,
): Promise<{ ok: boolean; settingsPath?: string; pluginPath?: string; error?: string }> {
  const res = await fetchFn(`/api/settings/runtime/install?target=${target}`, { method: 'POST' })
  return (await res.json()) as { ok: boolean; settingsPath?: string; pluginPath?: string; error?: string }
}

export async function uninstallRuntimeHooks(
  target: RuntimeTarget = 'claude', fetchFn: FetchLike = fetch,
): Promise<{ ok: boolean; removed?: number; settingsPath?: string; pluginPath?: string; dirRemoved?: boolean; error?: string }> {
  const res = await fetchFn(`/api/settings/runtime/uninstall?target=${target}`, { method: 'POST' })
  return (await res.json()) as { ok: boolean; removed?: number; settingsPath?: string; pluginPath?: string; dirRemoved?: boolean; error?: string }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/web-api-runtime-target.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/web/api.ts tests/web-api-runtime-target.test.ts
git commit -m "feat(web-api): RuntimeSettingsState 四槽 + getRuntimeStatus + target 扩四值

Part 5/N of four-slots runtime settings (spec 2026-08-19).

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: runtime-paths 纯函数四槽形状

**Files:**
- Modify: `src/web/runtime-paths.ts`（`RuntimePathDefaults` 四槽；`resolveClaudePath`/`resolveOpencodePath` 签名跟改）
- Test: `tests/web-runtime-resolve.test.ts`

**Interfaces:**
- Consumes: 无（纯函数）。
- Produces:
  ```ts
  export interface RuntimePathDefaults {
    claude: { dir: string; settingsFilename: string }
    codeagent: { dir: string; settingsFilename: string }
    opencode: { dir: string }
    nga: { dir: string }
  }
  export function resolveClaudePath(dir: string, filename: string, slotDefaults: { dir: string; settingsFilename: string }): string
  export function resolveOpencodePath(dir: string, slotDefaults: { dir: string }): string
  ```

- [ ] **Step 1: Write the failing test**

在 `tests/web-runtime-resolve.test.ts` 追加（沿用既有模式；先读确认）：

```typescript
// === 四槽 resolve（spec 2026-08-19）===
test('resolveClaudePath 空串回落 slot 默认', () => {
  const d = { dir: '~/.claude', settingsFilename: 'settings.json' }
  expect(resolveClaudePath('', '', d)).toBe('~/.claude/settings.json')
  expect(resolveClaudePath('~/.cac', 'setting.json', d)).toBe('~/.cac/setting.json')
})
test('resolveOpencodePath 空串回落 slot 默认 + 拼 memside-opencode', () => {
  const d = { dir: '~/.config/opencode' }
  expect(resolveOpencodePath('', d)).toBe('~/.config/opencode/memside-opencode')
  expect(resolveOpencodePath('~/.config/nga', d)).toBe('~/.config/nga/memside-opencode')
})
test('反斜杠归一正斜杠', () => {
  const d = { dir: 'C:\\home\\.claude', settingsFilename: 'settings.json' }
  expect(resolveClaudePath('C:\\x\\.cac', 'setting.json', d)).toBe('C:/x/.cac/setting.json')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/web-runtime-resolve.test.ts`
Expected: FAIL（旧 `RuntimePathDefaults` 是三字段扁平形，resolve 函数签名是三参全量 defaults）。

- [ ] **Step 3: Write minimal implementation**

替换 `src/web/runtime-paths.ts` 全文：

```typescript
// 运行环境路径解析纯函数（spec 2026-08-19-runtime-settings-four-slots §3.8）。
// 独立成模块便于 bun:test 直接断言，不引 React（CLAUDE.md「首选可断言面」）。

export interface RuntimePathDefaults {
  claude: { dir: string; settingsFilename: string }
  codeagent: { dir: string; settingsFilename: string }
  opencode: { dir: string }
  nga: { dir: string }
}

/** 解析 claude/codeagent 目标配置文件路径（per-slot defaults）。空串回落；反斜杠归一。 */
export function resolveClaudePath(
  dir: string,
  filename: string,
  slotDefaults: { dir: string; settingsFilename: string },
): string {
  const d = dir.trim() || slotDefaults.dir
  const f = filename.trim() || slotDefaults.settingsFilename
  return `${d}/${f}`.replace(/\\/g, '/')
}

/** 解析 opencode/nga 目标插件目录路径（per-slot defaults）。空串回落；拼 memside-opencode。 */
export function resolveOpencodePath(
  dir: string,
  slotDefaults: { dir: string },
): string {
  const d = dir.trim() || slotDefaults.dir
  return `${d}/memside-opencode`.replace(/\\/g, '/')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/web-runtime-resolve.test.ts`
Expected: PASS。

- [ ] **Step 5: Run typecheck**

Run: `bun run typecheck`
Expected: `App.tsx` 仍报错（RuntimeSettings 还用旧 defaults 形状），下个 task 修。

- [ ] **Step 6: Commit**

```bash
git add src/web/runtime-paths.ts tests/web-runtime-resolve.test.ts
git commit -m "refactor(web): runtime-paths 纯函数改四槽 per-slot 形状

Part 6/N of four-slots runtime settings (spec 2026-08-19).

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: App.tsx RuntimeSettings 四卡 + 状态徽标

**Files:**
- Modify: `src/web/App.tsx`（`RuntimeSettings` 重构 4 卡 + 状态徽标 + re-probe + 共享路径提示；§2179-2291；import 跟改）
- Test: `tests/app-source-assertions.test.ts`

**Interfaces:**
- Consumes: `getRuntimeSettings`/`saveRuntimeSettings`/`getRuntimeStatus`/`installRuntimeHooks`/`uninstallRuntimeHooks`（Task 5）、`resolveClaudePath`/`resolveOpencodePath`（Task 6）、`RuntimeSettingsState`/`RuntimeStatus`/`RuntimeTarget`/`RuntimeSlotDefaults`（Task 5）。
- Produces: 四卡 UI + 状态徽标。

- [ ] **Step 1: Write the failing test**

在 `tests/app-source-assertions.test.ts` 追加（沿用既有源码层文本断言模式；先读确认切片/读取方式）：

```typescript
// === 四槽设置卡 + 状态徽标（spec 2026-08-19）===
test('RuntimeSettings 四卡标题 + 状态徽标 + getRuntimeStatus', async () => {
  const src = await readAppSlice('function RuntimeSettings')  // 既有 helper
  expect(src).toContain('Claude Code')
  expect(src).toContain('codeagent')
  expect(src).toContain('opencode')
  expect(src).toContain('nga')
  expect(src).toContain('已安装')
  expect(src).toContain('未安装')
  expect(src).toContain('getRuntimeStatus')
  expect(src).toContain('resolveClaudePath')
  expect(src).toContain('resolveOpencodePath')
  // 反向锁：旧双分组标题不应独占（Claude Code / codeagent 合并标题已拆）
  expect(src).not.toContain('Claude Code / codeagent')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/app-source-assertions.test.ts`
Expected: FAIL（仍是双分组，无 `getRuntimeStatus`/`已安装` 徽标）。

- [ ] **Step 3: Write minimal implementation**

改 `src/web/App.tsx`：
1. import 跟改：`getRuntimeStatus`、`RuntimeStatus`、`RuntimeTarget`、`RuntimeSlotDefaults` 加入既有 `./api` import；`resolveClaudePath`/`resolveOpencodePath` 从 `./runtime-paths` 已 import（签名变 per-slot）。
2. 替换 `RuntimeSettings`（§2179-2291）为四卡实现。骨架：

```tsx
function RuntimeSettings() {
  const [state, setState] = useState<RuntimeSettingsState | null>(null)
  const [status, setStatus] = useState<RuntimeStatus | null>(null)
  const [claude, setClaude] = useState({ dir: '', settingsFilename: '' })
  const [codeagent, setCodeagent] = useState({ dir: '', settingsFilename: '' })
  const [opencode, setOpencode] = useState({ dir: '' })
  const [nga, setNga] = useState({ dir: '' })
  const [msg, setMsg] = useState<Partial<Record<RuntimeTarget, string | null>>>({})
  const [busy, setBusy] = useState<Partial<Record<RuntimeTarget, boolean>>>({})
  const [error, setError] = useState<string | null>(null)

  const refresh = async () => {
    try {
      const s = await getRuntimeSettings(); setState(s)
      setClaude(s.claude); setCodeagent(s.codeagent); setOpencode(s.opencode); setNga(s.nga)
      setError(null)
      try { setStatus(await getRuntimeStatus()) } catch { /* status 失败不阻塞设置加载 */ }
    } catch (e) { setError(String(e)) }
  }
  useEffect(() => { void refresh() }, [])

  const d = state?.defaults
  const probe = async () => { try { setStatus(await getRuntimeStatus()) } catch {} }

  const claudePreview = d ? resolveClaudePath(claude.dir, claude.settingsFilename, d.claude) : ''
  const codeagentPreview = d ? resolveClaudePath(codeagent.dir, codeagent.settingsFilename, d.codeagent) : ''
  const opencodePreview = d ? resolveOpencodePath(opencode.dir, d.opencode) : ''
  const ngaPreview = d ? resolveOpencodePath(nga.dir, d.nga) : ''

  const slots: Array<{
    key: RuntimeTarget; title: string; subtitle: string; kind: 'hooks' | 'plugin'
    preview: string; installed: boolean | undefined
    fields: JSX.Element; saveTarget: () => void
  }> = [
    { key: 'claude', title: 'Claude Code', subtitle: '官方', kind: 'hooks', preview: claudePreview,
      installed: status?.claude.installed,
      fields: (<>
        <label style={{ flex: '2 1 260px', fontSize: 12, color: '#555' }}>配置目录
          <input style={{ width: '100%', marginTop: 2 }} placeholder={d?.claude.dir} value={claude.dir} onChange={(e) => setClaude({ ...claude, dir: e.target.value })} />
        </label>
        <label style={{ flex: '1 1 180px', fontSize: 12, color: '#555' }}>文件名
          <input style={{ width: '100%', marginTop: 2 }} placeholder={d?.claude.settingsFilename} value={claude.settingsFilename} onChange={(e) => setClaude({ ...claude, settingsFilename: e.target.value })} />
        </label>
      </>) },
    // codeagent / opencode / nga 同构（codeagent 是 hooks 型，opencode/nga 是 plugin 型只有 dir 一个字段）
    // ...
  ]

  const onInstall = async (key: RuntimeTarget) => {
    setBusy({ ...busy, [key]: true }); setMsg({ ...msg, [key]: null })
    try {
      const patch: any = {}
      if (key === 'claude') patch.claude = claude
      if (key === 'codeagent') patch.codeagent = codeagent
      if (key === 'opencode') patch.opencode = opencode
      if (key === 'nga') patch.nga = nga
      const s = await saveRuntimeSettings(patch); setState(s)
      const r = await installRuntimeHooks(key)
      setMsg({ ...msg, [key]: r.ok ? '✓ 已安装' : `安装失败: ${r.error ?? '未知错误'}` })
      await probe()  // re-probe 状态徽标
    } catch (e) { setMsg({ ...msg, [key]: `操作失败: ${e}` }) }
    finally { setBusy({ ...busy, [key]: false }) }
  }
  const onUninstall = async (key: RuntimeTarget) => {
    setBusy({ ...busy, [key]: true }); setMsg({ ...msg, [key]: null })
    try {
      const r = await uninstallRuntimeHooks(key)
      setMsg({ ...msg, [key]: r.ok ? '✓ 已卸载' : `卸载失败: ${r.error ?? '未知错误'}` })
      await probe()
    } catch (e) { setMsg({ ...msg, [key]: `卸载失败: ${e}` }) }
    finally { setBusy({ ...busy, [key]: false }) }
  }

  const msgStyle = (m: string | null | undefined) =>
    m == null ? undefined : (m.includes('失败') ? { color: '#b00' } : { color: '#080' })
  const badge = (on: boolean | undefined) =>
    on ? <span style={{ color: '#080', fontWeight: 600 }}>✓ 已安装</span>
       : <span style={{ color: '#888' }}>○ 未安装</span>

  // 共享路径提示：opencode.dir 解析后 === nga.dir 解析后
  const sharedPlugin = d && resolveOpencodePath(opencode.dir, d.opencode) === resolveOpencodePath(nga.dir, d.nga)
  const sharedHooks = d && resolveClaudePath(claude.dir, claude.settingsFilename, d.claude) === resolveClaudePath(codeagent.dir, codeagent.settingsFilename, d.codeagent)

  return (
    <section style={{ margin: '12px 0', padding: 12, border: '1px solid #ddd', borderRadius: 8 }}>
      <h3 style={{ margin: '0 0 8px' }}>运行环境</h3>
      <p style={{ margin: '0 0 10px', fontSize: 13, color: '#666' }}>
        memside 往你所用 agent 的配置里写 hooks/plugin，才能抓取会话 + 注入记忆。四个 agent 各自独立配置，互不覆盖。官方 Claude Code / opencode 用默认路径；公司内部 fork 才需改路径。
      </p>
      {error ? <div style={{ color: '#b00', marginBottom: 8 }}>设置加载失败: {error}</div> : null}
      {/* 四张卡：每张 = h4(title+subtitle) + 状态徽标 + 字段 + 预览 + 共享提示 + 保存并安装/卸载按钮 + busy + msg */}
      {slots.map((s) => (
        <div key={s.key} style={{ margin: '12px 0', padding: 10, border: '1px solid #eee', borderRadius: 6 }}>
          <h4 style={{ margin: '0 0 8px', fontSize: 14 }}>{s.title} <span style={{ fontSize: 12, color: '#888' }}>{s.subtitle}</span> <span style={{ marginLeft: 8, fontSize: 12 }}>{badge(s.installed)}</span></h4>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>{s.fields}</div>
          <div style={{ margin: '4px 0 8px', fontSize: 12, color: '#888' }}>→ 将写入：<code>{s.preview}</code></div>
          {s.key === 'opencode' && sharedPlugin ? <div style={{ fontSize: 11, color: '#a70', marginBottom: 4 }}>与 nga 共享同一配置文件，安装/卸载会同时影响两者</div> : null}
          {s.key === 'claude' && sharedHooks ? <div style={{ fontSize: 11, color: '#a70', marginBottom: 4 }}>与 codeagent 共享同一配置文件，安装/卸载会同时影响两者</div> : null}
          {s.key === 'nga' && sharedPlugin ? <div style={{ fontSize: 11, color: '#a70', marginBottom: 4 }}>与 opencode 共享同一配置文件，安装/卸载会同时影响两者</div> : null}
          {s.key === 'codeagent' && sharedHooks ? <div style={{ fontSize: 11, color: '#a70', marginBottom: 4 }}>与 Claude Code 共享同一配置文件，安装/卸载会同时影响两者</div> : null}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button disabled={busy[s.key]} onClick={() => void onInstall(s.key)}>保存并安装</button>
            <button disabled={busy[s.key]} onClick={() => void onUninstall(s.key)}>卸载</button>
            {busy[s.key] ? <span style={{ color: '#888' }}>处理中…</span> : null}
            {msg[s.key] ? <span style={msgStyle(msg[s.key])}>{msg[s.key]}</span> : null}
          </div>
        </div>
      ))}
      <div style={{ marginTop: 6, fontSize: 12, color: '#888' }}>
        提示：codeagent 用户通常填目录 <code>~/.cac</code> + 文件名 <code>setting.json</code>。安装仅写入上述路径，请确认是 agent 实际读取的配置文件。卸载只移除 memside 管理的项，不影响你自己写的 hooks/plugins。
      </div>
    </section>
  )
}
```

实现时把 `slots` 数组四项填全（codeagent 是 hooks 型，opencode/nga 是 plugin 型——plugin 型字段只有 `配置目录` 一个 input，preview 用 `resolveOpencodePath`）。JSX 字段内联进 slots 数组或用 helper 渲染均可，确保四卡都渲染。

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/app-source-assertions.test.ts`
Expected: PASS。

- [ ] **Step 5: Run full typecheck + suite**

Run: `bun run typecheck && bun test`
Expected: **全绿**——所有下游 task 已完成，类型闭环。

- [ ] **Step 6: Commit**

```bash
git add src/web/App.tsx tests/app-source-assertions.test.ts
git commit -m "feat(web): RuntimeSettings 四卡 + 实时安装状态徽标

四 agent 各自独立配置卡；每卡实时显示 ✓已安装/○未安装（读磁盘探针）；
安装/卸载后 re-probe 更新徽标；共享路径时提示共享关系。

Closes four-slots runtime settings (spec 2026-08-19).

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: 全量验证 + STATE.md 回填

**Files:**
- Modify: `STATE.md`（顶部追加本次变更条目）

- [ ] **Step 1: Run full gate**

Run: `bun run typecheck && bun test`
Expected: 全绿，0 fail。记录通过数。

- [ ] **Step 2: Spot-check 迁移不碰真实 home**

确认 `tests/install-status.test.ts` / `tests/settings.test.ts` 均用 tmp dir，无写真实 `~/.claude` 或 `~/.config/opencode`。

- [ ] **Step 3: Append STATE.md**

在 `STATE.md` 顶部插入条目（沿用既有格式）：

```markdown
## 运行环境设置四槽独立配置（2026-08-19）

把运行环境从 3 共享字段拆成 4 独立配置槽 + 每槽实时安装状态徽标。设计 spec / 计划见 `docs/superpowers/specs|plans/2026-08-19-runtime-settings-four-slots*`。

1. **RuntimePaths 四槽**（`src/settings.ts`）：claude/codeagent（hooks 型 dir+settingsFilename）/ opencode/nga（plugin 型 dir）四独立槽；旧 3 共享 key 启发式归位（settingsFilename=setting.json 或 dir 以 .cac 结尾 -> codeagent），零数据丢失。
2. **安装状态探针**（`src/install.ts`）：`isHooksInstalled`/`isOpencodePluginInstalled` 只读、永不抛——复刻 uninstall 读逻辑判 MEMSIDE_TAG / memside-opencode 注册 + destDir 存在。
3. **server**（`src/server.ts`）：GET/PUT 改四槽 per-slot；新增 `GET /api/settings/runtime/status`（4 槽实时探针）；install/uninstall target 扩 claude|codeagent|opencode|nga。
4. **daemon**（`src/daemon.ts`）：注入两探针到 createApp。
5. **Web**（`src/web/{api,runtime-paths,App}.tsx`）：4 卡 + 状态徽标 + 每次 install/uninstall 后 re-probe + 共享路径提示。

执行：subagent-driven（7 实现 task 各带 task review）。`bun run typecheck && bun test` N pass / 0 fail。

### 上线后观测（硬要求，结论回填本节）

1. UI 四卡在 dev + exe 两种模式渲染正确，徽标反映磁盘真实状态。
2. 同时用 claude code + codeagent 的用户两槽分别装到 ~/.claude/settings.json 与 ~/.cac/setting.json，两 agent 都触发 capture。
3. opencode + nga 路径相同：装一个两卡显 ✓；不同则各自独立。
4. daemon 重启 / 手动改文件后徽标如实反映（不谎称已装）。
5. 老库迁移：旧 codeagent 配置（~/.cac/setting.json）正确归位 codeagent 槽。
```

- [ ] **Step 4: Commit**

```bash
git add STATE.md
git commit -m "docs(state): 四槽独立配置变更条目

Co-Authored-By: Claude <noreply@anthropic.com>"
```

- [ ] **Step 5: Push + PR**

```bash
git push -u origin feat/runtime-settings-four-slots
# 然后开 PR 目标 master
```

PR 标题：`feat: 运行环境设置四槽独立配置 + 实时安装状态徽标 (#NN)`
PR body 末尾加：
```
🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

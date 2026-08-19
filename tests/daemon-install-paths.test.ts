// spec 2026-08-17-runtime-path-config §3.4/3.5
// 锁 startDaemon 在 installClaudeHooks:true 时读 loadRuntimePaths 透传 installHooks。
// 用真实 startDaemon + 临时 db + 临时 HOME，断言 hooks 落到自定义路径。
import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDb } from '@/db/client'
import { startDaemon } from '@/daemon'
import { saveRuntimePaths } from '@/settings'
import { MEMSIDE_TAG } from '@/install'

const pluginSrcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'opencode-plugin')

// EBUSY-safe pattern (同 daemon-static.test.ts)：startDaemon 内部自开 db 且 stop()
// 不 close handle，Windows 上重删会 EBUSY。root 仅在 beforeAll 清一次；每测试用
// 新鲜子目录作 fakeHome，互不踩。
const root = join(import.meta.dir, '.tmp-daemon-install')
const realHome = process.env.HOME
const realUserprofile = process.env.USERPROFILE
let fakeHome: string
let dbPath: string

beforeAll(() => {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
})

beforeEach(() => {
  fakeHome = join(root, Math.random().toString(36).slice(2))
  mkdirSync(fakeHome, { recursive: true })
  ;(process.env as any).HOME = fakeHome
  delete process.env.USERPROFILE
  dbPath = join(fakeHome, 'memside.db')
})

afterEach(() => {
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
  // 先存配置（codeagent 槽路径：四槽后 ~/.cac/setting.json 归 codeagent）
  const db = openDb(dbPath)
  saveRuntimePaths(db, { codeagent: { dir: join(fakeHome, '.cac'), settingsFilename: 'setting.json' } })
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

// 回归防护：IF-1 —— 用户在 UI 配 ~/.cac（~ 前缀）后，daemon 重启读 loadRuntimePaths
// 必须把 ~ 展开为真实 HOME 再透传 installHooks。未展开会让 mkdirSync 建字面 `~`
// 目录、hooks 落到 ./~/.cac/setting.json，codeagent 读不到，闭环静默断。
// fakeHome 即 beforeEach 设的 process.env.HOME，~ 展开应指向它。
test('startDaemon expands ~ in configured claudeDir instead of creating a literal ~ dir (IF-1)', async () => {
  // 预存 ~ 前缀路径（codeagent 用户在 UI 配 ~/.cac）
  const db = openDb(dbPath)
  saveRuntimePaths(db, { codeagent: { dir: '~/.cac', settingsFilename: 'setting.json' } })
  db.$client.close()

  const { server } = await startDaemon({ dbPath, port: 17804, installClaudeHooks: true })
  try {
    // ~ 展开为 fakeHome：hooks 落到 fakeHome/.cac/setting.json
    expect(existsSync(join(fakeHome, '.cac', 'setting.json'))).toBe(true)
    // 不得出现字面 `~` 目录（未展开的回归特征）
    expect(existsSync(join(fakeHome, '~', '.cac', 'setting.json'))).toBe(false)
    const raw = JSON.parse(readFileSync(join(fakeHome, '.cac', 'setting.json'), 'utf-8'))
    expect(JSON.stringify(raw.hooks)).toContain(MEMSIDE_TAG)
  } finally { server.stop() }
})

// spec 2026-08-17-runtime-settings-redesign §3.2：startDaemon 经 DaemonOpts.opencodePluginSource
// 把 install/uninstall 接缝注入 createApp。锁：有 source → install 端点可用并真装文件；
// 无 source → install 返回 ok:false 不可用，但 uninstall 恒可用（不依赖 source）。
test('startDaemon with opencodePluginSource.srcDir → createApp 收到能装的 installOpencodePluginFn', async () => {
  const db = openDb(dbPath)
  saveRuntimePaths(db, { opencode: { dir: join(fakeHome, 'opencode') } })
  db.$client.close()

  const { server } = await startDaemon({
    dbPath, port: 17810,
    opencodePluginSource: { srcDir: pluginSrcDir },
  })
  try {
    // 直接打 install 端点（经 UI 按钮的同款路径）
    const res = await fetch(`http://127.0.0.1:17810/api/settings/runtime/install?target=opencode`, { method: 'POST' })
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.pluginPath).toContain('memside-opencode')
    expect(existsSync(join(fakeHome, 'opencode', 'memside-opencode', 'memside.js'))).toBe(true)
  } finally { server.stop() }
})

test('startDaemon with opencodePluginSource.files → install 用 files 模式', async () => {
  const db = openDb(dbPath)
  saveRuntimePaths(db, { opencode: { dir: join(fakeHome, 'opencode2') } })
  db.$client.close()

  const { server } = await startDaemon({
    dbPath, port: 17811,
    opencodePluginSource: { files: { 'memside.js': 'port=__MEMSIDE_PORT__;', 'package.json': '{"name":"memside"}' } },
  })
  try {
    const res = await fetch(`http://127.0.0.1:17811/api/settings/runtime/install?target=opencode`, { method: 'POST' })
    const body = await res.json()
    expect(body.ok).toBe(true)
    const js = readFileSync(join(fakeHome, 'opencode2', 'memside-opencode', 'memside.js'), 'utf-8')
    expect(js).toBe('port=17811;') // 端口烘焙
  } finally { server.stop() }
})

test('startDaemon without opencodePluginSource → install?target=opencode 返回 ok:false 不可用', async () => {
  const db = openDb(dbPath)
  saveRuntimePaths(db, { opencode: { dir: join(fakeHome, 'opencode3') } })
  db.$client.close()

  const { server } = await startDaemon({ dbPath, port: 17812 })
  try {
    const res = await fetch(`http://127.0.0.1:17812/api/settings/runtime/install?target=opencode`, { method: 'POST' })
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.error).toContain('不可用')
  } finally { server.stop() }
})

test('startDaemon always provides uninstallOpencodePluginFn (even without source)', async () => {
  const db = openDb(dbPath)
  saveRuntimePaths(db, { opencode: { dir: join(fakeHome, 'opencode4') } })
  db.$client.close()

  const { server } = await startDaemon({ dbPath, port: 17813 }) // 不传 source
  try {
    const res = await fetch(`http://127.0.0.1:17813/api/settings/runtime/uninstall?target=opencode`, { method: 'POST' })
    const body = await res.json()
    expect(body.ok).toBe(true) // uninstall 不依赖 source，恒可用
    expect(body.removed).toBe(0)
  } finally { server.stop() }
})

// spec 2026-08-19-runtime-settings-four-slots §status：Task 4 让 daemon 把真实探针
// （isHooksInstalled / isOpencodePluginInstalled）注入 createApp。生产 daemon 的
// GET /api/settings/runtime/status 应读真实磁盘——装了 hooks 的槽 installed:true，
// 没装的槽 installed:false。这是「探针已接通」的间接断言：缺省 fallback 会恒返回
// installed:false，只有真实探针才能在装好后读到 true。
test('GET /api/settings/runtime/status reports installed:true after installClaudeHooks (real probe wired)', async () => {
  // installClaudeHooks:true 让 daemon 启动时把 hooks 写进 claude 与 codeagent 槽的
  // settings.json（默认 ~/.claude/settings.json + ~/.cac/setting.json）。真实探针应读到
  // installed:true；opencode/nga 槽没装插件 -> installed:false。
  const { server } = await startDaemon({ dbPath, port: 17820, installClaudeHooks: true })
  try {
    const res = await fetch(`http://127.0.0.1:17820/api/settings/runtime/status`)
    const body = await res.json()
    // claude 槽：daemon 启动时 installHooks 写了 ~/.claude/settings.json，真实探针读到。
    expect(body.claude.installed).toBe(true)
    expect(body.claude.path).toContain('settings.json')
    // codeagent 槽：daemon 启动时也装了（默认 ~/.cac/setting.json），真实探针读到。
    expect(body.codeagent.installed).toBe(true)
    expect(body.codeagent.path).toContain('setting.json')
    // opencode/nga 槽：未装插件，真实探针应 false。
    expect(body.opencode.installed).toBe(false)
    expect(body.nga.installed).toBe(false)
  } finally { server.stop() }
})

test('GET /api/settings/runtime/status reports installed:false for all slots when nothing installed', async () => {
  // 不传 installClaudeHooks -> daemon 不写任何 settings.json。真实探针读空盘 -> 全 false。
  // 与上一测试互证：真实探针在「装了」时返回 true、在「没装」时返回 false。
  const { server } = await startDaemon({ dbPath, port: 17821 })
  try {
    const res = await fetch(`http://127.0.0.1:17821/api/settings/runtime/status`)
    const body = await res.json()
    expect(body.claude.installed).toBe(false)
    expect(body.codeagent.installed).toBe(false)
    expect(body.opencode.installed).toBe(false)
    expect(body.nga.installed).toBe(false)
  } finally { server.stop() }
})

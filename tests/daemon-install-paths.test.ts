// spec 2026-08-17-runtime-path-config §3.4/3.5
// 锁 startDaemon 在 installClaudeHooks:true 时读 loadRuntimePaths 透传 installHooks。
// 用真实 startDaemon + 临时 db + 临时 HOME，断言 hooks 落到自定义路径。
import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { openDb } from '@/db/client'
import { startDaemon } from '@/daemon'
import { saveRuntimePaths } from '@/settings'
import { MEMSIDE_TAG } from '@/install'

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

// 回归防护：IF-1 —— 用户在 UI 配 ~/.cac（~ 前缀）后，daemon 重启读 loadRuntimePaths
// 必须把 ~ 展开为真实 HOME 再透传 installHooks。未展开会让 mkdirSync 建字面 `~`
// 目录、hooks 落到 ./~/.cac/setting.json，codeagent 读不到，闭环静默断。
// fakeHome 即 beforeEach 设的 process.env.HOME，~ 展开应指向它。
test('startDaemon expands ~ in configured claudeDir instead of creating a literal ~ dir (IF-1)', async () => {
  // 预存 ~ 前缀路径（codeagent 用户在 UI 配 ~/.cac）
  const db = openDb(dbPath)
  saveRuntimePaths(db, { claudeDir: '~/.cac', settingsFilename: 'setting.json' })
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

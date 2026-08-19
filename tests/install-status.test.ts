import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '@/db/client'
import { saveRuntimePaths } from '@/settings'
import {
  installHooks,
  installOpencodePlugin,
  isHooksInstalled,
  isOpencodePluginInstalled,
  uninstallHooks,
  uninstallOpencodePlugin,
  checkAllHooksInstalled,
} from '../src/install'

// Regression lock for Task 2 of four-slots runtime settings (spec 2026-08-19):
// read-only probes that report whether memside's hook/plugin markers are on
// disk. They must never write and never throw (missing file / malformed JSON
// -> installed:false). Tests use tmp dirs so they never touch real
// ~/.claude or ~/.config/opencode.

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
    writeFileSync(join(dir, 'settings.json'), '{ not json')
    const r = isHooksInstalled({ baseDir: dir, settingsFilename: 'settings.json' })
    expect(r.installed).toBe(false)
  })
  test('纯用户 hook 无标记 -> false', () => {
    const dir = mkTmp()
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify(
        {
          hooks: { SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo user' }] }] },
        },
        null,
        2,
      ),
    )
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
    rmSync(join(dir, 'memside-opencode'), { recursive: true, force: true })
    const r = isOpencodePluginInstalled({ baseDir: dir })
    expect(r.installed).toBe(false) // dir 缺
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

// Regression lock for Task 2 of hook-missing-notification (spec 2026-08-19 §3.4/§7.2):
// checkAllHooksInstalled 把四槽（claude/codeagent hooks + opencode/nga plugin）
// 探针归一为 allMissing 布尔，供 daemon 周期检查决定是否提醒用户。allMissing 仅在
// 四槽全空时为 true；任一槽已装或探针抛错 -> false（宁可漏提醒也不误报打扰）。
// 测试注入 fake 探针 + tmp db，绝不碰真实 ~/.claude / ~/.config/opencode。
describe('checkAllHooksInstalled 组合判定', () => {
  // 四槽 tmp 路径：每槽独立 tmp 目录，opencode 目录名以 'opencode' 结尾供第 3 个用例断言。
  const tmpClaudeDir = mkTmp()
  const tmpCodeagentDir = mkTmp()
  const tmpOpencodeDir = join(mkTmp(), 'opencode')
  const tmpNgaDir = mkTmp()
  let db: ReturnType<typeof openDb>

  beforeEach(() => {
    const dbPath = join(mkTmp(), 't.db')
    db = openDb(dbPath)
    saveRuntimePaths(db, {
      claude: { dir: tmpClaudeDir, settingsFilename: 'settings.json' },
      codeagent: { dir: tmpCodeagentDir, settingsFilename: 'setting.json' },
      opencode: { dir: tmpOpencodeDir },
      nga: { dir: tmpNgaDir },
    })
  })
  // M2 修复（final review 2026-08-19）：beforeEach 每测 openDb 但无 close，
  // Windows 留文件句柄。沿用 store-notifications.test.ts 既有模式每测后关库。
  afterEach(() => { db.$client.close() })

  test('四槽全 false → allMissing:true', () => {
    const s = checkAllHooksInstalled(db, {
      hooksProbe: () => ({ installed: false, settingsPath: '' }),
      opencodeProbe: () => ({ installed: false, pluginPath: '', dirExists: false }),
    })
    expect(s.allMissing).toBe(true)
    expect(s.details).toEqual({ claude: false, codeagent: false, opencode: false, nga: false })
  })

  test('claude 已装其余未装 → allMissing:false', () => {
    const s = checkAllHooksInstalled(db, {
      hooksProbe: (o) => ({ installed: o.settingsFilename === 'settings.json', settingsPath: '' }),
      opencodeProbe: () => ({ installed: false, pluginPath: '', dirExists: false }),
    })
    expect(s.allMissing).toBe(false)
    expect(s.details.claude).toBe(true)
  })

  test('opencode 已装其余未装 → allMissing:false', () => {
    const s = checkAllHooksInstalled(db, {
      hooksProbe: () => ({ installed: false, settingsPath: '' }),
      opencodeProbe: (o) => ({ installed: o.baseDir?.endsWith('opencode') ?? false, pluginPath: '', dirExists: true }),
    })
    expect(s.allMissing).toBe(false)
    expect(s.details.opencode).toBe(true)
  })

  test('探针抛错 → 降级 allMissing:false 不抛', () => {
    const s = checkAllHooksInstalled(db, {
      hooksProbe: () => { throw new Error('boom') },
      opencodeProbe: () => { throw new Error('boom') },
    })
    expect(s.allMissing).toBe(false) // 降级不提醒
  })

  test('传给探针的 baseDir/settingsFilename 来自 loadRuntimePaths 四槽', () => {
    let seenClaude: { baseDir?: string; settingsFilename?: string } | null = null
    let seenCodeagent: { baseDir?: string; settingsFilename?: string } | null = null
    checkAllHooksInstalled(db, {
      hooksProbe: (o) => {
        if (o.settingsFilename === 'settings.json') seenClaude = o
        else seenCodeagent = o
        return { installed: false, settingsPath: '' }
      },
      opencodeProbe: () => ({ installed: false, pluginPath: '', dirExists: false }),
    })
    expect(seenClaude!.baseDir).toBe(tmpClaudeDir)
    expect(seenClaude!.settingsFilename).toBe('settings.json')
    expect(seenCodeagent!.settingsFilename).toBe('setting.json')
  })

  // M1 补全（final review 2026-08-19，spec §7.2）：缺两个 case。
  // 1) nga 已装（ocProbe 对 nga dir 返回 installed:true）其余未装 → allMissing:false、
  //    details.nga===true。与 claude/opencode 已装 case 对称，锁 nga 槽归一逻辑。
  test('nga 已装其余未装 → allMissing:false、details.nga===true', () => {
    const s = checkAllHooksInstalled(db, {
      hooksProbe: () => ({ installed: false, settingsPath: '' }),
      opencodeProbe: (o) => ({ installed: o.baseDir === tmpNgaDir, pluginPath: '', dirExists: true }),
    })
    expect(s.allMissing).toBe(false)
    expect(s.details.nga).toBe(true)
    expect(s.details.opencode).toBe(false)
    expect(s.details.claude).toBe(false)
    expect(s.details.codeagent).toBe(false)
  })

  // M1 补全（spec §7.2）：2) 生产路径（不传 opts 探针）+ 四槽全 tmp 空目录 →
  //    allMissing:true。验证真实探针（isHooksInstalled/isOpencodePluginInstalled）
  //    + loadRuntimePaths 接线：真实探针读空 tmp 目录返回 installed:false。
  test('生产路径（不传探针）四槽全 tmp 空目录 → allMissing:true', () => {
    const s = checkAllHooksInstalled(db)
    expect(s.allMissing).toBe(true)
    expect(s.details).toEqual({ claude: false, codeagent: false, opencode: false, nga: false })
  })
})

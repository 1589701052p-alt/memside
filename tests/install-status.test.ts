import { test, expect, describe } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  installHooks,
  installOpencodePlugin,
  isHooksInstalled,
  isOpencodePluginInstalled,
  uninstallHooks,
  uninstallOpencodePlugin,
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

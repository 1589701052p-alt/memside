// 回归防护：2026-07-30 distill 全 401 事故（持久 env 静默劫持）——本文件锁
// 「UI 配置存取 + token 打码」语义，spec: docs/superpowers/specs/2026-07-30-llm-settings-ui-design.md
import { test, expect, describe } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/db/client'
import { appSettings } from '../src/db/schema'
import { maskToken, loadUiLlmConfig, saveUiLlmConfig } from '../src/settings'

function tmpDb() {
  const dir = mkdtempSync(join(tmpdir(), 'memside-settings-'))
  return openDb(join(dir, 't.db'))
}

test('maskToken: 正常长度取前6后4', () => {
  expect(maskToken('sk-kimiabcdef12345678fh')).toBe('sk-kim…78fh')
})
test('maskToken: 长度<=10 全码', () => {
  expect(maskToken('short')).toBe('•••••')
  expect(maskToken('1234567890')).toBe('••••••••••')
})

test('loadUiLlmConfig: 未配置返回 null', () => {
  const db = tmpDb()
  expect(loadUiLlmConfig(db)).toBeNull()
})

test('save+load: 三项写入后读回', () => {
  const db = tmpDb()
  saveUiLlmConfig(db, { baseURL: 'https://api.kimi.com/coding/', token: 'sk-abcdefghijklmn', model: 'kimi-for-coding-highspeed' })
  expect(loadUiLlmConfig(db)).toEqual({
    baseURL: 'https://api.kimi.com/coding/', token: 'sk-abcdefghijklmn', model: 'kimi-for-coding-highspeed',
  })
})

test('字段级合并: token 缺省保持已存值；baseURL 空字符串删除该 key', () => {
  const db = tmpDb()
  saveUiLlmConfig(db, { baseURL: 'https://a.example.com', token: 'sk-abcdefghijklmn', model: 'm1' })
  saveUiLlmConfig(db, { baseURL: '', model: 'm2' }) // token 未提供 -> 保持
  expect(loadUiLlmConfig(db)).toEqual({ token: 'sk-abcdefghijklmn', model: 'm2' })
})

test('只有 baseURL 没有 token -> UI 级不存在（load 返回 null）', () => {
  const db = tmpDb()
  saveUiLlmConfig(db, { baseURL: 'https://a.example.com' })
  expect(loadUiLlmConfig(db)).toBeNull()
})

test('clear:true 删除整级', () => {
  const db = tmpDb()
  saveUiLlmConfig(db, { token: 'sk-abcdefghijklmn', model: 'm1' })
  saveUiLlmConfig(db, { clear: true })
  expect(loadUiLlmConfig(db)).toBeNull()
})

// 回归防护：2026-08-06 dual-protocol-llm-settings Task 1 —— protocol 字段随配置读写。
// 锁「UiLlmConfig.protocol 持久化 + clear 连带删除」语义。
test('save+load: protocol 随配置读写', () => {
  const db = tmpDb()
  saveUiLlmConfig(db, { token: 'sk-abcdefghijklmn', protocol: 'openai' })
  expect(loadUiLlmConfig(db)).toEqual({ token: 'sk-abcdefghijklmn', protocol: 'openai' })
})

test('protocol 缺省不写入 -> load 无 protocol 字段', () => {
  const db = tmpDb()
  saveUiLlmConfig(db, { token: 'sk-abcdefghijklmn' })
  expect(loadUiLlmConfig(db)).toEqual({ token: 'sk-abcdefghijklmn' })
})

test('clear:true 连带删除 protocol', () => {
  const db = tmpDb()
  saveUiLlmConfig(db, { token: 'sk-abcdefghijklmn', protocol: 'openai' })
  saveUiLlmConfig(db, { clear: true })
  expect(loadUiLlmConfig(db)).toBeNull()
})

import { loadRuntimePaths, saveRuntimePaths, defaultRuntimePaths } from '../src/settings'

// === 四槽独立配置（spec 2026-08-19-runtime-settings-four-slots）===
// 把 claude/codeagent/opencode/nga 拆成四个独立配置槽（hooks 型 dir+settingsFilename，
// plugin 型 dir）。锁「默认值 / 字段级合并 / 空串删 key 回默认 / ~ 展开 / 旧 3 共享 key
// 迁移归位（READ-ONLY）/ 新 key 优先于旧 key」语义。
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
    const db = tmpDb()
    const rp = loadRuntimePaths(db)
    const d = defaultRuntimePaths()
    expect(rp.claude).toEqual(d.claude)
    expect(rp.codeagent).toEqual(d.codeagent)
    expect(rp.opencode).toEqual(d.opencode)
    expect(rp.nga).toEqual(d.nga)
  })

  test('saveRuntimePaths per-slot 字段级合并', () => {
    const db = tmpDb()
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
    const db = tmpDb()
    saveRuntimePaths(db, { claude: { dir: '/x/.claude' } })
    saveRuntimePaths(db, { claude: { dir: '' } })
    expect(loadRuntimePaths(db).claude.dir).toBe(defaultRuntimePaths().claude.dir)
  })

  test('~ 展开到 home（IF-1 回归）', () => {
    const db = tmpDb()
    saveRuntimePaths(db, { opencode: { dir: '~/.config/opencode' } })
    const rp = loadRuntimePaths(db)
    expect(rp.opencode.dir).not.toContain('~')
    expect(rp.opencode.dir.length).toBeGreaterThan(1)
  })

  test('迁移：旧 claude_dir ~/.cac + settings_filename setting.json 归 codeagent 槽', () => {
    const db = tmpDb()
    db.insert(appSettings).values({ key: 'runtime.claude_dir', value: '~/.cac', updatedAt: 0 }).run()
    db.insert(appSettings).values({ key: 'runtime.settings_filename', value: 'setting.json', updatedAt: 0 }).run()
    const rp = loadRuntimePaths(db)
    expect(rp.codeagent.dir.endsWith('.cac')).toBe(true)
    expect(rp.codeagent.settingsFilename).toBe('setting.json')
    expect(rp.claude).toEqual(defaultRuntimePaths().claude) // 取默认
  })

  test('迁移：旧 claude_dir ~/.claude + settings.json 归 claude 槽', () => {
    const db = tmpDb()
    db.insert(appSettings).values({ key: 'runtime.claude_dir', value: '~/.claude', updatedAt: 0 }).run()
    db.insert(appSettings).values({ key: 'runtime.settings_filename', value: 'settings.json', updatedAt: 0 }).run()
    const rp = loadRuntimePaths(db)
    expect(rp.claude.dir.endsWith('.claude')).toBe(true)
    expect(rp.codeagent).toEqual(defaultRuntimePaths().codeagent)
  })

  test('迁移：旧 opencode_dir 归 opencode 槽，nga 取默认', () => {
    const db = tmpDb()
    db.insert(appSettings).values({ key: 'runtime.opencode_dir', value: '~/.config/opencode', updatedAt: 0 }).run()
    const rp = loadRuntimePaths(db)
    expect(rp.opencode.dir.endsWith('opencode')).toBe(true)
    expect(rp.nga).toEqual(defaultRuntimePaths().nga)
  })

  test('迁移：新 key 已写则忽略旧 key', () => {
    const db = tmpDb()
    db.insert(appSettings).values({ key: 'runtime.claude_dir', value: '~/.cac', updatedAt: 0 }).run()
    db.insert(appSettings).values({ key: 'runtime.settings_filename', value: 'setting.json', updatedAt: 0 }).run()
    saveRuntimePaths(db, { claude: { dir: '/new/.claude' } })
    const rp = loadRuntimePaths(db)
    expect(rp.claude.dir).toBe('/new/.claude') // 新 key 优先，不受旧 key 干扰
  })
})

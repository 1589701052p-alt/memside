// 回归防护：2026-07-30 distill 全 401 事故（持久 env 静默劫持）——本文件锁
// 「UI 配置存取 + token 打码」语义，spec: docs/superpowers/specs/2026-07-30-llm-settings-ui-design.md
import { test, expect } from 'bun:test'
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

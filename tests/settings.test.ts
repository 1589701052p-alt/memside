// 回归防护：2026-07-30 distill 全 401 事故（持久 env 静默劫持）——本文件锁
// 「UI 配置存取 + token 打码」语义，spec: docs/superpowers/specs/2026-07-30-llm-settings-ui-design.md
import { test, expect } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/db/client'
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

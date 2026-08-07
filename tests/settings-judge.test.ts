// tests/settings-judge.test.ts
// 回归防护:判定配置逐字段容错回默认(脏数据不得把判定器配死);夹取范围防 0 轮/天价预算。
import { test, expect } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/db/client'
import { loadJudgeConfig, saveJudgeConfig } from '../src/settings'
import { DEFAULT_JUDGE_CONFIG } from '@/memory/judgeConfig'
import { appSettings } from '@/db/schema'

function tmpDb() { return openDb(join(mkdtempSync(join(tmpdir(), 'memside-judge-cfg-')), 't.db')) }

test('未配置 -> 全默认(质量/30/300)', () => {
  expect(loadJudgeConfig(tmpDb())).toEqual(DEFAULT_JUDGE_CONFIG)
})

test('保存后读回;部分字段保存其余回默认', () => {
  const db = tmpDb()
  saveJudgeConfig(db, { mode: 'economy' })
  expect(loadJudgeConfig(db)).toEqual({ mode: 'economy', maxRounds: 30, timeBudgetS: 300 })
})

test('脏数据容错:非法 mode/非数字/超范围逐字段回默认或夹取', () => {
  const db = tmpDb()
  const up = (key: string, value: string) =>
    db.insert(appSettings).values({ key, value, updatedAt: Date.now() })
      .onConflictDoUpdate({ target: appSettings.key, set: { value } }).run()
  up('judge.mode', 'banana')
  up('judge.max_rounds', '999')
  up('judge.time_budget_s', 'abc')
  expect(loadJudgeConfig(db)).toEqual({ mode: 'quality', maxRounds: 200, timeBudgetS: 300 })
})

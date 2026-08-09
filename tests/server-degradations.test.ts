// tests/server-degradations.test.ts
// Task 9 回归锁：降级可见化服务端面（spec §4.9）。
// 锁的行为：
//   GET /api/status 带 recentDegradations（24h 计数 + 最新一条 + acknowledgedTs）与 waitingJobs；
//   POST /api/degradations/ack -> upsert appSettings key degradations.ack_ts，status 回读；
//   GET /api/distill-runs/:jobId/degradations -> 该 job 的降级明细。
// 测试基建对齐 tests/server-distill-batching.test.ts：createApp + fake adapter +
// 临时文件库（brief 原文 openDb(':memory:') 在 bun 下抛 EEXIST，client.ts mkdirSync 陷阱）。
import { describe, test, expect, beforeEach } from 'bun:test'
import { openDb, type DbClient } from '@/db/client'
import { createApp } from '@/server'
import { logDegradation } from '@/memory/store'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let db: DbClient
let app: ReturnType<typeof createApp>

beforeEach(() => {
  db = openDb(join(mkdtempSync(join(tmpdir(), 'memside-degr-server-')), 'test.db'))
  app = createApp({
    db,
    adapter: { inject: async () => null } as never,
    opencodeAdapter: { inject: async () => null } as never,
    enqueueDistillJob: async () => ({ jobId: 'x', nextRunAt: 0 }),
    broadcast: () => {},
  })
})

describe('GET /api/status recentDegradations（spec §4.9）', () => {
  test('无降级 -> count24h=0 latest=null；waitingJobs 字段存在', async () => {
    const res = await app.request('/api/status')
    const body = await res.json()
    expect(body.recentDegradations.count24h).toBe(0)
    expect(body.recentDegradations.latest).toBeNull()
    expect(body.recentDegradations.acknowledgedTs).toBeNull()
    expect(typeof body.waitingJobs).toBe('number')
  })

  test('有降级 -> 计数 + 最新一条；ack 后 acknowledgedTs 返回', async () => {
    await logDegradation(db, { kind: 'digest_llm_failed', detail: 'ark 502', distillJobId: 'j1' })
    await logDegradation(db, { kind: 'sweep_error' })
    let body = await (await app.request('/api/status')).json()
    expect(body.recentDegradations.count24h).toBe(2)
    expect(['digest_llm_failed', 'sweep_error']).toContain(body.recentDegradations.latest.kind)
    await app.request('/api/degradations/ack', { method: 'POST' })
    body = await (await app.request('/api/status')).json()
    expect(typeof body.recentDegradations.acknowledgedTs).toBe('number')
  })

  test('ack upsert：重复 ack 不炸，ts 更新', async () => {
    const r1 = await app.request('/api/degradations/ack', { method: 'POST' })
    expect((await r1.json()).ok).toBe(true)
    const b1 = await (await app.request('/api/status')).json()
    const r2 = await app.request('/api/degradations/ack', { method: 'POST' })
    expect((await r2.json()).ok).toBe(true)
    const b2 = await (await app.request('/api/status')).json()
    expect(b2.recentDegradations.acknowledgedTs).toBeGreaterThanOrEqual(b1.recentDegradations.acknowledgedTs)
  })
})

describe('GET /api/distill-runs/:jobId/degradations', () => {
  test('返回该 job 的降级明细', async () => {
    await logDegradation(db, { kind: 'digest_read_failed', detail: 'db locked', distillJobId: 'j1' })
    const res = await app.request('/api/distill-runs/j1/degradations')
    const body = await res.json()
    expect(body.degradations.length).toBe(1)
    expect(body.degradations[0].kind).toBe('digest_read_failed')
  })

  test('只回本 job：其它 job 与无 jobId 的行不混入', async () => {
    await logDegradation(db, { kind: 'digest_read_failed', distillJobId: 'j1' })
    await logDegradation(db, { kind: 'sweep_error', distillJobId: 'j2' })
    await logDegradation(db, { kind: 'capture_persist_failed' })
    const body = await (await app.request('/api/distill-runs/j1/degradations')).json()
    expect(body.degradations.length).toBe(1)
    expect(body.degradations[0].kind).toBe('digest_read_failed')
  })
})

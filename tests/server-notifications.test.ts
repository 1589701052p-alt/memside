// 消息中心端点 + status 新字段（spec 2026-08-12 §5.8）。
import { test, expect, describe, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { openDb } from '@/db/client'
import { createApp } from '@/server'
import { insertNotification, saveDistillRun, updateDistillRunDigestMs } from '@/memory/store'
import { createActivityTracker } from '@/activity'

const root = join(import.meta.dir, '.tmp-server-notifications')
let dir = ''
let db: ReturnType<typeof openDb>
let app: ReturnType<typeof createApp>

function mkApp(tracker = createActivityTracker()) {
  return createApp({
    db,
    adapter: { inject: async () => null } as any,
    opencodeAdapter: { inject: async () => null } as any,
    enqueueDistillJob: async () => ({ jobId: 'j', nextRunAt: 0 }),
    broadcast: () => {},
    tracker,
  } as any)
}

beforeAll(() => { rmSync(root, { recursive: true, force: true }); mkdirSync(root, { recursive: true }) })
beforeEach(() => {
  dir = join(root, Math.random().toString(36).slice(2))
  mkdirSync(dir, { recursive: true })
  db = openDb(join(dir, 't.db'))
  app = mkApp()
})
afterEach(() => { db.$client.close() })

describe('GET /api/notifications', () => {
  test('分页 + kind + unread + q + total', async () => {
    await insertNotification(db, { kind: 'degradation', title: 'digest_truncated', body: '切片超时' })
    await insertNotification(db, { kind: 'llm_error', title: 'llm_error', body: 'timeout' })
    const all = await (await app.request('/api/notifications?limit=20')).json() as any
    expect(all.total).toBe(2)
    const onlyDegr = await (await app.request('/api/notifications?limit=20&kind=degradation')).json() as any
    expect(onlyDegr.total).toBe(1)
    const unread = await (await app.request('/api/notifications?limit=20&unread=1')).json() as any
    expect(unread.total).toBe(2)
    const hit = await (await app.request(`/api/notifications?limit=20&q=${encodeURIComponent('超时')}`)).json() as any
    expect(hit.total).toBe(1)
  })
  // C1 回归锁（final review 2026-08-19）：server 端 kind 校验必须读 store 的
  // NOTIFICATION_KINDS（单一真源），不得维护独立硬编码白名单——否则 store 加新 kind
  // 后 server 不同步，前端筛选新 kind 返 400 + 静默空列表。此处锁 hook_missing 合法。
  test('GET /api/notifications?kind=hook_missing 返回 200（C1：白名单读 NOTIFICATION_KINDS）', async () => {
    await insertNotification(db, { kind: 'hook_missing', title: '运行环境未安装 hook', body: 'b' })
    const ok = await app.request('/api/notifications?kind=hook_missing')
    expect(ok.status).toBe(200)
    const data = await ok.json() as any
    expect(data.items.every((n: any) => n.kind === 'hook_missing')).toBe(true)
    expect(data.items.length).toBeGreaterThanOrEqual(1)
    // 非法 kind 仍 400（回归：读单一真源不等于放行任意值）
    expect((await app.request('/api/notifications?kind=bogus')).status).toBe(400)
  })

  test('非法 kind -> 400', async () => {
    expect((await app.request('/api/notifications?kind=bogus')).status).toBe(400)
  })

  // Task 8（spec 2026-08-15 §5.7）：parse_error 通知 kind 合法，过滤只回 parse_error。
  test('GET /api/notifications?kind=parse_error 合法且只回 parse_error；kind=foo 仍 400', async () => {
    await insertNotification(db, { kind: 'parse_error', title: 'parse_error', body: '不是合法 JSON：x' })
    await insertNotification(db, { kind: 'llm_error', title: 'llm_error', body: 'timeout' })
    const ok = await app.request('/api/notifications?kind=parse_error')
    expect(ok.status).toBe(200)
    const data = await ok.json() as any
    expect(data.items.every((n: any) => n.kind === 'parse_error')).toBe(true)
    expect(data.items.length).toBeGreaterThanOrEqual(1)
    const bad = await app.request('/api/notifications?kind=foo')
    expect(bad.status).toBe(400)
  })
})

describe('已读端点', () => {
  test('read 单条幂等；未知 id -> 404', async () => {
    const id = await insertNotification(db, { kind: 'degradation', title: 'a' })
    expect((await app.request(`/api/notifications/${id}/read`, { method: 'POST' })).status).toBe(200)
    expect((await app.request(`/api/notifications/${id}/read`, { method: 'POST' })).status).toBe(200)
    expect((await app.request('/api/notifications/nope/read', { method: 'POST' })).status).toBe(404)
  })
  test('read-all 返回 marked 数', async () => {
    await insertNotification(db, { kind: 'degradation', title: 'a' })
    await insertNotification(db, { kind: 'llm_error', title: 'b' })
    const body = await (await app.request('/api/notifications/read-all', { method: 'POST' })).json() as any
    expect(body.marked).toBe(2)
  })
})

describe('/api/status 扩展', () => {
  test('unreadNotifications 计数；ack 路由退役 404；无 recentDegradations 键', async () => {
    await insertNotification(db, { kind: 'degradation', title: 'a' })
    const body = await (await app.request('/api/status')).json() as any
    expect(body.unreadNotifications).toBe(1)
    expect(body.recentDegradations).toBeUndefined()
    expect((await app.request('/api/degradations/ack', { method: 'POST' })).status).toBe(404)
  })

  test('llmActivity 透传 tracker；空闲为 null', async () => {
    const tracker = createActivityTracker()
    const app2 = mkApp(tracker)
    expect((await (await app2.request('/api/status')).json() as any).llmActivity).toBeNull()
    tracker.begin('distill', 'memside')
    const act = (await (await app2.request('/api/status')).json() as any).llmActivity
    expect(act.phase).toBe('distill')
    expect(act.detail).toBe('memside')
  })

  test('llmStats24h：skipped 不计蒸馏次数；NULL 列不计去重/审查；digest 并入蒸馏', async () => {
    // produced：蒸馏 100ms + digest 50ms + 去重 20ms（无审查）
    await saveDistillRun(db, 'j1', { outcome: 'produced', rawOutput: null, rawCount: 1, acceptedCount: 1, dedupedCount: 1, filteredCount: 1, storedCount: 1, discardedCount: 0, durationMs: 100, errorMessage: null, dedupMs: 20, judgeMs: null })
    await updateDistillRunDigestMs(db, 'j1', 50)
    // skipped：duration=0 不计蒸馏
    await saveDistillRun(db, 'j2', { outcome: 'skipped_trivial', rawOutput: null, rawCount: 0, acceptedCount: 0, dedupedCount: 0, filteredCount: 0, storedCount: 0, discardedCount: 0, durationMs: 0, errorMessage: null })
    const s = (await (await app.request('/api/status')).json() as any).llmStats24h
    expect(s.distill.count).toBe(1)
    expect(s.distill.ms).toBe(150)
    expect(s.dedup).toEqual({ count: 1, ms: 20 })
    expect(s.judge).toEqual({ count: 0, ms: 0 })
  })
})

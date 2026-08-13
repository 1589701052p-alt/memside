import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { openDb } from '@/db/client'
import {
  insertNotification, logLlmErrorNotification, listNotificationsPage,
  markNotificationRead, markAllNotificationsRead, updateDistillRunDigestMs,
  logDegradation, saveDistillRun, getDistillRun,
  NotificationNotFoundError, InvalidNotificationFilterError,
  NOTIFICATION_RETENTION_CAP,
  type PageCursor,
} from '@/memory/store'

const root = join(import.meta.dir, '.tmp-store-notifications')
let dir = ''
let db: ReturnType<typeof openDb>

beforeAll(() => { rmSync(root, { recursive: true, force: true }); mkdirSync(root, { recursive: true }) })
beforeEach(() => {
  dir = join(root, Math.random().toString(36).slice(2))
  mkdirSync(dir, { recursive: true })
  db = openDb(join(dir, 't.db'))
})
afterEach(() => { db.$client.close() })

test('insertNotification 落库全字段；body 超 2000 截断', async () => {
  const long = 'x'.repeat(2500)
  const id = await insertNotification(db, { kind: 'degradation', title: 'digest_truncated', body: long, refType: 'distill_job', refId: 'j1' })
  const pg = await listNotificationsPage(db, {})
  expect(pg.total).toBe(1)
  const n = pg.items[0]!
  expect(n.id).toBe(id)
  expect(n.kind).toBe('degradation')
  expect(n.title).toBe('digest_truncated')
  expect(n.body!.length).toBe(2000)
  expect(n.refType).toBe('distill_job')
  expect(n.refId).toBe('j1')
  expect(n.readAt).toBeNull()
})

test('保留上限：第 501 条写入后总数恒 500，最旧被删', async () => {
  await insertNotification(db, { kind: 'degradation', title: 't0' })
  await new Promise((r) => setTimeout(r, 20)) // t0 落在更旧 ts 桶
  for (let i = 1; i < NOTIFICATION_RETENTION_CAP; i++) {
    await insertNotification(db, { kind: 'degradation', title: `t${i}` })
  }
  await new Promise((r) => setTimeout(r, 20)) // t500 落在最新 ts 桶
  await insertNotification(db, { kind: 'degradation', title: `t${NOTIFICATION_RETENTION_CAP}` })

  const pg = await listNotificationsPage(db, { limit: 1 })
  expect(pg.total).toBe(NOTIFICATION_RETENTION_CAP)
  expect(pg.items[0]!.title).toBe(`t${NOTIFICATION_RETENTION_CAP}`) // 最新在头部

  // 游标翻页收齐全部 retained titles，验证 t0 被裁掉（t0 最旧，只会出现在最后一页）
  const allTitles: string[] = []
  let page = await listNotificationsPage(db, { limit: 200 })
  allTitles.push(...page.items.map((n) => n.title))
  let cursor: PageCursor | null = page.nextCursor
  while (cursor) {
    page = await listNotificationsPage(db, { limit: 200, before: cursor })
    allTitles.push(...page.items.map((n) => n.title))
    cursor = page.nextCursor
  }
  expect(allTitles.length).toBe(NOTIFICATION_RETENTION_CAP)
  expect(allTitles).not.toContain('t0')
})

test('logDegradation 双写：审计行 + 消息行同时出现', async () => {
  await logDegradation(db, { kind: 'digest_llm_failed', detail: 'boom', distillJobId: 'job-9', sessionId: 's1' })
  const pg = await listNotificationsPage(db, {})
  expect(pg.total).toBe(1)
  const n = pg.items[0]!
  expect(n.kind).toBe('degradation')
  expect(n.title).toBe('digest_llm_failed')
  expect(n.body).toBe('boom')
  expect(n.refId).toBe('job-9')
  // 无 jobId 的降级 refId=null
  await logDegradation(db, { kind: 'sweep_error', detail: 'x' })
  const pg2 = await listNotificationsPage(db, { kind: 'degradation' })
  const sweep = pg2.items.find((m) => m.title === 'sweep_error')!
  expect(sweep.refId).toBeNull()
})

test('logLlmErrorNotification 写 kind=llm_error', async () => {
  await logLlmErrorNotification(db, { jobId: 'jx', message: '502 Bad Gateway' })
  const pg = await listNotificationsPage(db, {})
  expect(pg.items[0]!).toMatchObject({ kind: 'llm_error', title: 'llm_error', body: '502 Bad Gateway', refId: 'jx' })
})

test('listNotificationsPage: 排序 / kind / unreadOnly / q / 游标翻页 + total', async () => {
  await insertNotification(db, { kind: 'degradation', title: 'digest_truncated', body: '切片压缩产出超限' })
  await new Promise((r) => setTimeout(r, 5)) // 保证 ts 严格递增
  await insertNotification(db, { kind: 'llm_error', title: 'llm_error', body: 'timeout' })
  await new Promise((r) => setTimeout(r, 5))
  await insertNotification(db, { kind: 'degradation', title: 'sweep_error', body: null })
  const all = await listNotificationsPage(db, {})
  expect(all.items.map((n) => n.title)).toEqual(['sweep_error', 'llm_error', 'digest_truncated']) // ts desc
  expect((await listNotificationsPage(db, { kind: 'llm_error' })).total).toBe(1)
  await markNotificationRead(db, all.items[0]!.id)
  expect((await listNotificationsPage(db, { unreadOnly: true })).total).toBe(2)
  expect((await listNotificationsPage(db, { q: 'timeout' })).total).toBe(1)     // body 命中
  expect((await listNotificationsPage(db, { q: 'sweep' })).total).toBe(1)    // title 命中
  const p1 = await listNotificationsPage(db, { limit: 2 })
  expect(p1.hasMore).toBe(true)
  const p2 = await listNotificationsPage(db, { limit: 2, before: p1.nextCursor! })
  expect(p2.items.length).toBe(1)
  expect(p2.hasMore).toBe(false)
})

test('listNotificationsPage: 非法 kind 抛 InvalidNotificationFilterError', async () => {
  await expect(listNotificationsPage(db, { kind: 'bogus' as any })).rejects.toBeInstanceOf(InvalidNotificationFilterError)
})

test('markNotificationRead 幂等；未知 id 抛 NotificationNotFoundError；markAll 只改未读', async () => {
  const id = await insertNotification(db, { kind: 'degradation', title: 'a' })
  await markNotificationRead(db, id)
  await markNotificationRead(db, id) // 幂等不抛
  await expect(markNotificationRead(db, 'nope')).rejects.toBeInstanceOf(NotificationNotFoundError)
  await insertNotification(db, { kind: 'degradation', title: 'b' })
  await insertNotification(db, { kind: 'llm_error', title: 'c' })
  expect(await markAllNotificationsRead(db)).toBe(2)
  expect((await listNotificationsPage(db, { unreadOnly: true })).total).toBe(0)
})

test('updateDistillRunDigestMs 回填；无行 no-op', async () => {
  await saveDistillRun(db, 'job-1', {
    outcome: 'produced', rawOutput: null, rawCount: 1, acceptedCount: 1,
    dedupedCount: 1, filteredCount: 1, storedCount: 1, discardedCount: 0,
    durationMs: 100, errorMessage: null, dedupMs: 20, judgeMs: 30,
  })
  await updateDistillRunDigestMs(db, 'job-1', 42)
  const run = await getDistillRun(db, 'job-1')
  expect(run!.digestMs).toBe(42)
  expect(run!.dedupMs).toBe(20)
  expect(run!.judgeMs).toBe(30)
  await updateDistillRunDigestMs(db, 'no-such-job', 1) // 不抛
})

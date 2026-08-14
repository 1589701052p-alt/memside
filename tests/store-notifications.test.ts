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

// ---------------------------------------------------------------------------
// 重复通知折叠（spec 2026-08-14 §3.3）：同内容未读不刷屏，已读照常新插
// ---------------------------------------------------------------------------

test('折叠 llm_error：同 body 未读 → 不新插、行数不变、ts 刷新、返回原 id', async () => {
  const id1 = await insertNotification(db, { kind: 'llm_error', title: 'llm_error', body: '502 Bad Gateway', refId: 'j1' })
  const ts1 = (await listNotificationsPage(db, {})).items[0]!.ts
  await new Promise((r) => setTimeout(r, 20))
  const id2 = await insertNotification(db, { kind: 'llm_error', title: 'llm_error', body: '502 Bad Gateway', refId: 'j2' })
  expect(id2).toBe(id1)
  const pg = await listNotificationsPage(db, {})
  expect(pg.total).toBe(1)
  expect(pg.items[0]!.ts).toBeGreaterThan(ts1)
  // refId 等字段保持原行的值，不被新输入覆盖
  expect(pg.items[0]!.refId).toBe('j1')
})

test('折叠 llm_error：body 比较用裁剪后值（同 2000 前缀的长 body 也折叠）', async () => {
  const long1 = 'x'.repeat(2000) + 'AAA'
  const long2 = 'x'.repeat(2000) + 'BBB'
  const id1 = await insertNotification(db, { kind: 'llm_error', title: 'llm_error', body: long1 })
  const id2 = await insertNotification(db, { kind: 'llm_error', title: 'llm_error', body: long2 })
  expect(id2).toBe(id1)
  const pg = await listNotificationsPage(db, {})
  expect(pg.total).toBe(1)
  expect(pg.items[0]!.body).toBe('x'.repeat(2000))
})

test('折叠 llm_error：不同 body → 新插；同 body 已读 → 新插', async () => {
  const id1 = await insertNotification(db, { kind: 'llm_error', title: 'llm_error', body: 'err-A' })
  const id2 = await insertNotification(db, { kind: 'llm_error', title: 'llm_error', body: 'err-B' })
  expect(id2).not.toBe(id1)
  expect((await listNotificationsPage(db, {})).total).toBe(2)
  // 已读的相同内容不折叠（用户已处置，新发生是新事件）
  await markNotificationRead(db, id1)
  const id3 = await insertNotification(db, { kind: 'llm_error', title: 'llm_error', body: 'err-A' })
  expect(id3).not.toBe(id1)
  expect((await listNotificationsPage(db, {})).total).toBe(3)
  // 但新插的未读 err-A 又成为新的折叠锚点
  const id4 = await insertNotification(db, { kind: 'llm_error', title: 'llm_error', body: 'err-A' })
  expect(id4).toBe(id3)
  expect((await listNotificationsPage(db, {})).total).toBe(3)
})

test('折叠 degradation：同 title 未读 → 折叠；不同 title → 新插', async () => {
  const id1 = await insertNotification(db, { kind: 'degradation', title: 'digest_llm_failed', body: 'boom-1' })
  await new Promise((r) => setTimeout(r, 20))
  // 同 title 即折叠，body 不同也折叠（degradation 的折叠键是 title = 降级 kind）
  const id2 = await insertNotification(db, { kind: 'degradation', title: 'digest_llm_failed', body: 'boom-2' })
  expect(id2).toBe(id1)
  const pg = await listNotificationsPage(db, {})
  expect(pg.total).toBe(1)
  expect(pg.items[0]!.body).toBe('boom-1')
  const id3 = await insertNotification(db, { kind: 'degradation', title: 'sweep_error' })
  expect(id3).not.toBe(id1)
  expect((await listNotificationsPage(db, {})).total).toBe(2)
})

test('折叠跨 kind 不混：degradation title 与 llm_error body 内容相同也各自成键', async () => {
  const idD = await insertNotification(db, { kind: 'degradation', title: 'same-text' })
  const idL = await insertNotification(db, { kind: 'llm_error', title: 'llm_error', body: 'same-text' })
  expect(idL).not.toBe(idD)
  expect((await listNotificationsPage(db, {})).total).toBe(2)
})

test('折叠命中不触发保留裁剪：cap 边界上行数不退化、原行保留', async () => {
  // 第一条是折叠目标（最旧）；填满到 cap 后折叠命中，若误走插入+裁剪会把最旧行裁掉
  const targetId = await insertNotification(db, { kind: 'llm_error', title: 'llm_error', body: 'fold-target' })
  for (let i = 1; i < NOTIFICATION_RETENTION_CAP; i++) {
    await insertNotification(db, { kind: 'degradation', title: `t${i}` })
  }
  expect((await listNotificationsPage(db, { limit: 1 })).total).toBe(NOTIFICATION_RETENTION_CAP)

  const foldedId = await insertNotification(db, { kind: 'llm_error', title: 'llm_error', body: 'fold-target' })
  expect(foldedId).toBe(targetId)
  expect((await listNotificationsPage(db, { limit: 1 })).total).toBe(NOTIFICATION_RETENTION_CAP)
  // 折叠把目标行 ts 刷到最新，浮在列表顶部
  expect((await listNotificationsPage(db, { limit: 1 })).items[0]!.id).toBe(targetId)
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

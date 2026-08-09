// tests/store-distill-batching.test.ts
import { describe, test, expect, beforeEach } from 'bun:test'
import { openDb, type DbClient } from '@/db/client'
import {
  findWaitingJob, upsertSessionEvent, releaseWaitingJob, touchLastCapture, listWaitingJobs,
  markFlush, consumeFlush, getSessionDigest, upsertSessionDigest,
  logDegradation, listRecentDegradations, listDegradationsForJob,
} from '@/memory/store'
import { memoryDistillJobs, memoryDistillEvents } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let db: DbClient
// 注：brief 原文用 openDb(':memory:')，但 client.ts 的 mkdirSync(dirname(path))
// 对 ':memory:' 会在 bun 下抛 EEXIST(mkdir '.')，改用每次 fresh 的临时文件库。
const seedJob = async (
  id: string,
  status: 'pending' | 'running' | 'done' | 'failed' | 'canceled' | 'waiting',
  sessionId: string | null = 's1',
  sourceAgentId: string | null = null,
) => {
  await db.insert(memoryDistillJobs).values({
    id, debounceKey: 'k', sourceEventId: 'e', runtime: 'claude-code',
    sessionId, sourceAgentId, status, attempts: 0, nextRunAt: 0, createdAt: 1, finishedAt: null,
  })
}

beforeEach(() => {
  db = openDb(join(mkdtempSync(join(tmpdir(), 'memside-batch-store-')), 'test.db'))
})

describe('findWaitingJob / listWaitingJobs（不变量 A/B）', () => {
  test('命中 waiting；排除 pending/done/subagent/异 session/异 runtime', async () => {
    await seedJob('w1', 'waiting', 's1')
    await seedJob('p1', 'pending', 's1')
    await seedJob('d1', 'done', 's1')
    await seedJob('sub1', 'waiting', 's1', 'agent-x')
    await seedJob('w2', 'waiting', 's2')
    expect((await findWaitingJob(db, 'claude-code', 's1'))?.id).toBe('w1')
    expect(await findWaitingJob(db, 'claude-code', 's1')).not.toBeNull()
    const list = await listWaitingJobs(db)
    expect(list.map((j) => j.id).sort()).toEqual(['w1', 'w2'])
  })
  test('无命中 -> null', async () => {
    expect(await findWaitingJob(db, 'claude-code', 'nope')).toBeNull()
  })
})

describe('upsertSessionEvent（不变量 D：一 job 一行）', () => {
  test('重复 upsert 后恰一行且为最新 payload', async () => {
    await seedJob('j1', 'waiting')
    await upsertSessionEvent(db, 'j1', JSON.stringify([{ role: 'user', content: 'v1' }]))
    await upsertSessionEvent(db, 'j1', JSON.stringify([{ role: 'user', content: 'v2' }]))
    const rows = await db.select().from(memoryDistillEvents).where(eq(memoryDistillEvents.distillJobId, 'j1'))
    expect(rows.length).toBe(1)
    expect(rows[0]!.payload).toContain('v2')
  })
})

describe('releaseWaitingJob / touchLastCapture（不变量 B 单向）', () => {
  test('waiting -> pending 且 nextRunAt 立即可见', async () => {
    await seedJob('j1', 'waiting')
    await releaseWaitingJob(db, 'j1')
    const [j] = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, 'j1'))
    expect(j!.status).toBe('pending')
    expect(j!.nextRunAt).toBeLessThanOrEqual(Date.now())
  })
  test('touchLastCapture 写入 last_capture_at', async () => {
    await seedJob('j1', 'waiting')
    await touchLastCapture(db, 'j1', 12345)
    const [j] = await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, 'j1'))
    expect(j!.lastCaptureAt).toBe(12345)
  })
})

describe('flush 标记（一次性 consume）', () => {
  test('mark 幂等；consume 有则删返 true、二次 consume 返 false', async () => {
    await markFlush(db, 's1')
    await markFlush(db, 's1')
    expect(await consumeFlush(db, 's1')).toBe(true)
    expect(await consumeFlush(db, 's1')).toBe(false)
    expect(await consumeFlush(db, 'nope')).toBe(false)
  })
})

describe('session digest', () => {
  test('无记录 -> null；upsert 覆盖并更新 mode', async () => {
    expect(await getSessionDigest(db, 's1')).toBeNull()
    await upsertSessionDigest(db, 's1', 'v1', 'llm')
    expect(await getSessionDigest(db, 's1')).toEqual({ digest: 'v1', mode: 'llm' })
    await upsertSessionDigest(db, 's1', 'v2', 'deterministic-fallback')
    expect(await getSessionDigest(db, 's1')).toEqual({ digest: 'v2', mode: 'deterministic-fallback' })
  })
})

describe('degradations（降级可见化，spec §5）', () => {
  test('log + 按时间/按 job 查询', async () => {
    const now = Date.now()
    await logDegradation(db, { kind: 'digest_llm_failed', detail: 'boom', distillJobId: 'j1', sessionId: 's1' })
    await logDegradation(db, { kind: 'sweep_error' })
    const recent = await listRecentDegradations(db, now - 60_000)
    expect(recent.length).toBe(2)
    expect(recent[0]!.ts).toBeGreaterThanOrEqual(recent[1]!.ts) // ts DESC
    const forJob = await listDegradationsForJob(db, 'j1')
    expect(forJob.length).toBe(1)
    expect(forJob[0]!.kind).toBe('digest_llm_failed')
    expect(await listRecentDegradations(db, now + 60_000)).toEqual([])
  })
})

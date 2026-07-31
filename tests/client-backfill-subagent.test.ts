import { test, expect, beforeAll } from 'bun:test'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { openDb, type DbClient } from '@/db/client'
import { memories } from '@/db/schema'
import { eq } from 'drizzle-orm'

const root = join(import.meta.dir, '.tmp-backfill-subagent')

beforeAll(() => { rmSync(root, { recursive: true, force: true }); mkdirSync(root, { recursive: true }) })

test('backfill 把 subagent candidate origin 降级为 agent-observed，conversation 不动，且幂等', async () => {
  const path = join(root, 'b.db')
  let db: DbClient = openDb(path)
  // seed：一条 subagent candidate 错标 user-stated；一条 conversation candidate 正常 user-stated
  await db.insert(memories).values({
    id: '01BACKFILL', scopeType: 'project', scopeId: '/r',
    title: '[category:convention] t', bodyMd: 'b', tags: '[]',
    status: 'candidate', sourceKind: 'subagent', sourceCwd: '/r', runtime: null,
    createdAt: 1, version: 1, origin: 'user-stated', evidence: 'task brief',
  })
  await db.insert(memories).values({
    id: '02BACKFILL', scopeType: 'project', scopeId: '/r',
    title: '[category:convention] t2', bodyMd: 'b', tags: '[]',
    status: 'candidate', sourceKind: 'conversation', sourceCwd: '/r', runtime: null,
    createdAt: 2, version: 1, origin: 'user-stated', evidence: 'real user',
  })
  await db.insert(memories).values({
    id: '03BACKFILL', scopeType: 'project', scopeId: '/r',
    title: '[category:convention] t3', bodyMd: 'b', tags: '[]',
    status: 'candidate', sourceKind: 'subagent', sourceCwd: '/r', runtime: null,
    createdAt: 3, version: 1, origin: null, evidence: null,
  })
  db.$client.close()

  // 重开：迁移块跑回填
  db = openDb(path)
  const sub = await db.select().from(memories).where(eq(memories.id, '01BACKFILL'))
  expect(sub[0]!.origin).toBe('agent-observed')     // subagent 被降级
  const conv = await db.select().from(memories).where(eq(memories.id, '02BACKFILL'))
  expect(conv[0]!.origin).toBe('user-stated')       // conversation 不动
  const nul = await db.select().from(memories).where(eq(memories.id, '03BACKFILL'))
  expect(nul[0]!.origin).toBe('agent-observed')   // NULL origin 的 subagent 也被回填（guard 的 origin IS NULL 分支）

  // 幂等：再重开一次，值不变
  db.$client.close()
  db = openDb(path)
  const sub2 = await db.select().from(memories).where(eq(memories.id, '01BACKFILL'))
  expect(sub2[0]!.origin).toBe('agent-observed')
  const nul2 = await db.select().from(memories).where(eq(memories.id, '03BACKFILL'))
  expect(nul2[0]!.origin).toBe('agent-observed')
  db.$client.close()
})

import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { openDb } from '@/db/client'
import { memories, memoryTrash } from '@/db/schema'
import { createCandidate, bulkDeleteMemories, restoreFromTrash, emptyTrash, importMemories, listMemoriesForExport, listTrashPage, getTrash, promoteCandidate } from '@/memory/store'
import type { Memory } from '@/memory/store'

const root = join(import.meta.dir, '.tmp-store-trash')
let dir = ''
let db: ReturnType<typeof openDb>

beforeAll(() => { rmSync(root, { recursive: true, force: true }); mkdirSync(root, { recursive: true }) })
beforeEach(() => { dir = join(root, Math.random().toString(36).slice(2)); mkdirSync(dir, { recursive: true }); db = openDb(join(dir, 't.db')) })
afterEach(() => { db.$client.close() })

async function mkCandidate(over: Record<string, unknown> = {}) {
  return createCandidate(db, { scopeType: 'global', scopeId: null, title: '[category:convention] t', bodyMd: 'b', tags: ['x'], sourceKind: 'manual', runtime: null, ...over } as any)
}
function mkMemory(id: string, over: Partial<Memory> = {}): Memory {
  return { id, scopeType: 'global', scopeId: null, runtime: null, title: '[category:c] T', bodyMd: 'b', tags: [], status: 'approved', sourceKind: 'manual', sourceCwd: null, sourceEventId: null, distillJobId: null, distillAction: null, supersedesId: null, supersededById: null, approvedAt: 1, createdAt: 2, version: 1, valueClass: 'convention', subjectSlug: null, origin: 'user-stated', evidence: 'e', ...over }
}

test('bulkDeleteMemories: 删 memory + 写 trash，approved 状态保留', async () => {
  const a = await mkCandidate(); await promoteCandidate(db, a.id, { action: 'approve' })
  const b = await mkCandidate()
  const r = await bulkDeleteMemories(db, [a.id, b.id])
  expect(r.deleted).toBe(2)
  expect(r.skipped).toBe(0)
  // memory 行已删
  const left = await db.select().from(memories).all()
  expect(left.length).toBe(0)
  // trash 行有 2 条，snapshot 含原 status
  const tr = await db.select().from(memoryTrash).all()
  expect(tr.length).toBe(2)
  const approvedSnap = tr.find((x) => JSON.parse(x.memorySnapshot).status === 'approved')
  expect(approvedSnap).toBeDefined()
})

test('bulkDeleteMemories: 不存在的 id 计 skipped', async () => {
  const a = await mkCandidate()
  const r = await bulkDeleteMemories(db, [a.id, 'nope'])
  expect(r.deleted).toBe(1)
  expect(r.skipped).toBe(1)
})

test('bulkDeleteMemories: 重复删同 id 幂等（第二次计 skipped）', async () => {
  const a = await mkCandidate()
  await bulkDeleteMemories(db, [a.id])
  const r2 = await bulkDeleteMemories(db, [a.id])
  expect(r2.deleted).toBe(0)
  expect(r2.skipped).toBe(1)
  const tr = await db.select().from(memoryTrash).all()
  expect(tr.length).toBe(1) // 不产生第二条 trash
})

test('emptyTrash: 清空 memory_trash 全表 + 返回计数', async () => {
  const a = await mkCandidate(); const b = await mkCandidate()
  await bulkDeleteMemories(db, [a.id, b.id])
  const r = await emptyTrash(db)
  expect(r.emptied).toBe(2)
  const tr = await db.select().from(memoryTrash).all()
  expect(tr.length).toBe(0)
})

test('restoreFromTrash: 恢复后 memory 写回 + status 保留（approved）', async () => {
  const a = await mkCandidate(); await promoteCandidate(db, a.id, { action: 'approve' })
  await bulkDeleteMemories(db, [a.id])
  const tr = await db.select().from(memoryTrash).all()
  const restored = await restoreFromTrash(db, tr[0]!.id, { conflict: 'skip' })
  expect(restored.status).toBe('approved')
  // trash 行已删
  const tr2 = await db.select().from(memoryTrash).all()
  expect(tr2.length).toBe(0)
})

test('restoreFromTrash: 不存在抛 MemoryNotFoundError', async () => {
  await expect(restoreFromTrash(db, 'nope', { conflict: 'skip' })).rejects.toThrow()
})

test('restoreFromTrash: 同 id 已存在 + skip -> 计 skipped 不覆盖', async () => {
  // 删 a，恢复期间 a 又被新建（同 id）。用 importMemories newid 制造冲突场景：
  // 直接造一个 trash snapshot id='X'，库里已有 id='X'
  const existing = await mkCandidate()
  await importMemories(db, [mkMemory(existing.id)], { conflict: 'overwrite' }) // 确保库里有一条
  // 手写一条 trash（绕过 delete，模拟恢复时 id 已存在）
  await db.insert(memoryTrash).values({ id: 'trash1', memorySnapshot: JSON.stringify(mkMemory(existing.id)), originalMemoryId: existing.id, scopeType: 'global', scopeId: null, runtime: null, deletedAt: 1, title: 'T', valueClass: 'convention', subjectSlug: null }).run()
  const restored = await restoreFromTrash(db, 'trash1', { conflict: 'skip' })
  expect(restored.id).toBe(existing.id) // 原行仍在
})

test('importMemories newid: 生成新 ULID 新增', async () => {
  const r = await importMemories(db, [mkMemory('DUP')], { conflict: 'newid' })
  expect(r.imported).toBe(1)
  // 新行 id 不等于 'DUP'
  const rows = await db.select().from(memories).all()
  expect(rows.some((x) => x.id !== 'DUP')).toBe(true)
})

test('importMemories overwrite: 删旧写新保留 id', async () => {
  // 先用 skip 建立一行 id='K1'（newid 会换 id，建不出字面 K1）
  await importMemories(db, [mkMemory('K1', { title: 'old' })], { conflict: 'skip' })
  const r = await importMemories(db, [mkMemory('K1', { title: 'new' })], { conflict: 'overwrite' })
  expect(r.overwritten).toBe(1)
  const rows = await db.select().from(memories).where(eq(memories.id, 'K1')).all()
  // overwrite 删旧 id='K1' 写新 id='K1'（exists 时 writeId=rec.id），id 仍 K1，title 变 new
  expect(rows.length).toBe(1)
  expect(rows[0]!.title).toBe('new')
})

test('importMemories skip: 已存在跳过', async () => {
  // 先用 skip 建立一行 id='S1'（newid 会换 id，建不出字面 S1）
  await importMemories(db, [mkMemory('S1')], { conflict: 'skip' })
  const r = await importMemories(db, [mkMemory('S1')], { conflict: 'skip' })
  expect(r.skipped).toBe(1)
  expect(r.imported).toBe(0)
})

test('listMemoriesForExport selected: 按 ids 取', async () => {
  const a = await mkCandidate(); const b = await mkCandidate()
  const rows = await listMemoriesForExport(db, { scope: 'selected', ids: [a.id] })
  expect(rows.length).toBe(1)
  expect(rows[0]!.id).toBe(a.id)
})

test('listMemoriesForExport all: 全部不受分页限制', async () => {
  await mkCandidate(); await mkCandidate()
  const rows = await listMemoriesForExport(db, { scope: 'all' })
  expect(rows.length).toBe(2)
})

test('listTrashPage: 列表不含 snapshot 大字段', async () => {
  const a = await mkCandidate()
  await bulkDeleteMemories(db, [a.id])
  const page = await listTrashPage(db, { limit: 20 })
  expect(page.items.length).toBe(1)
  expect((page.items[0] as any).memorySnapshot).toBeUndefined()
  expect(page.items[0]!.title).toBe('[category:convention] t')
})

test('getTrash: 详情含反序列化 memory', async () => {
  const a = await mkCandidate(); await promoteCandidate(db, a.id, { action: 'approve' })
  await bulkDeleteMemories(db, [a.id])
  const tr = (await listTrashPage(db, { limit: 20 })).items[0]!
  const detail = await getTrash(db, tr.id)
  expect(detail).not.toBeNull()
  expect(detail!.trash.memory).not.toBeNull()
  expect(detail!.trash.memory!.status).toBe('approved')
})

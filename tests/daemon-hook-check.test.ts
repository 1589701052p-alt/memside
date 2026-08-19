// spec 2026-08-19-hook-missing-notification §3.5、§7.3
// 锁 daemon 层「四槽全空提醒」触发逻辑：allMissing → 写一条 hook_missing（折叠防刷屏）；
// 任一已装 → 清未读 hook_missing；探针抛错 → 降级只 warn 不炸。
// 不碰真实 ~/.claude / ~/.config/opencode：注入 checkAllHooksInstalledFn fake + tmp db。
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { openDb } from '@/db/client'
import { checkHooksAndNotify } from '@/daemon'
import { insertNotification, listNotificationsPage } from '@/memory/store'

const root = join(import.meta.dir, '.tmp-daemon-hook-check')
let dir = ''
let db: ReturnType<typeof openDb>

beforeAll(() => { rmSync(root, { recursive: true, force: true }); mkdirSync(root, { recursive: true }) })
beforeEach(() => {
  dir = join(root, Math.random().toString(36).slice(2))
  mkdirSync(dir, { recursive: true })
  db = openDb(join(dir, 't.db'))
})
afterEach(() => { db.$client.close() })

const allMissingFn = () => ({
  allMissing: true,
  details: { claude: false, codeagent: false, opencode: false, nga: false },
})
const someInstalledFn = () => ({
  allMissing: false,
  details: { claude: true, codeagent: false, opencode: false, nga: false },
})

describe('checkHooksAndNotify', () => {
  it('allMissing:true → 写一条 hook_missing notification', async () => {
    await checkHooksAndNotify(db, { checkAllHooksInstalledFn: allMissingFn })
    const page = await listNotificationsPage(db, { kind: 'hook_missing' })
    expect(page.items.length).toBe(1)
    expect(page.items[0]!.title).toBe('运行环境未安装 hook')
  })

  it('allMissing:false 且有未读 hook_missing → 标已读', async () => {
    await insertNotification(db, { kind: 'hook_missing', title: '运行环境未安装 hook' })
    await checkHooksAndNotify(db, { checkAllHooksInstalledFn: someInstalledFn })
    const page = await listNotificationsPage(db, { kind: 'hook_missing', unreadOnly: true })
    expect(page.items.length).toBe(0) // 已标已读
  })

  it('allMissing:false 且无未读 hook_missing → 表无变化', async () => {
    await checkHooksAndNotify(db, { checkAllHooksInstalledFn: someInstalledFn })
    const page = await listNotificationsPage(db, { kind: 'hook_missing' })
    expect(page.items.length).toBe(0)
  })

  it('折叠：连调两次 allMissing:true → 只一条未读 hook_missing', async () => {
    await checkHooksAndNotify(db, { checkAllHooksInstalledFn: allMissingFn })
    await checkHooksAndNotify(db, { checkAllHooksInstalledFn: allMissingFn })
    const page = await listNotificationsPage(db, { kind: 'hook_missing' })
    expect(page.items.length).toBe(1) // 折叠，不刷屏
  })

  it('checkAllHooksInstalledFn 抛错 → 不写 notification、不抛', async () => {
    await expect(checkHooksAndNotify(db, {
      checkAllHooksInstalledFn: () => { throw new Error('boom') },
    })).resolves.toBeUndefined()
    const page = await listNotificationsPage(db, { kind: 'hook_missing' })
    expect(page.items.length).toBe(0)
  })
})

// tests/server-distill-batching.test.ts
// Task 7 回归锁：会话级累加 capture（spec §3.2/§4.8）。
// 锁的行为：
//   不变量 A —— 同 session 的主会话 capture 最多一个 waiting job（Stop/opencode 两侧统一）；
//   不变量 D —— 一 job 恰一行 memory_distill_events（最新全量快照 upsert）；
//   阈值跨越 -> releaseWaitingJob 放行（status: waiting -> pending）；
//   SessionEnd -> markFlush 落 memory_session_flushes，绝不动 job（放行是 Task 8 tick sweep 的职责）；
//   legacy 无 sessionId / subagent -> 旧行为不变（一次 capture 一个立即 pending job）；
//   解析失败 -> 不炸路由、job 状态可解释（降级可见化，spec §5）。
// 测试基建对齐 tests/server.test.ts：createApp + fake adapter + app.fetch + tmp 文件库。
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { openDb, type DbClient } from '@/db/client'
import { createApp } from '@/server'
import { memoryDistillJobs, memoryDistillEvents, memorySessionFlushes } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { enqueueDistillJob } from '@/scheduler'

let db: DbClient
let app: ReturnType<typeof createApp>
const enqueueResults: { jobId: string }[] = []

// 注：brief 原文用 openDb(':memory:')，但 client.ts 的 mkdirSync(dirname(path))
// 对 ':memory:' 会在 bun 下抛 EEXIST(mkdir '.')，改用每次 fresh 的临时文件库
// （与 tests/store-distill-batching.test.ts 同模式；Windows 下不 rmSync 临时目录）。
beforeEach(() => {
  db = openDb(join(mkdtempSync(join(tmpdir(), 'memside-batch-server-')), 'test.db'))
  enqueueResults.length = 0
  app = createApp({
    db,
    adapter: { inject: async () => null } as never,
    opencodeAdapter: { inject: async () => null } as never,
    // 走真实 enqueueDistillJob（legacy 路径要在 DB 里落 pending job），仅记录结果。
    enqueueDistillJob: (d, input) => enqueueDistillJob(d, input).then((r) => { enqueueResults.push(r); return r }),
    broadcast: () => {},
  })
})

afterEach(() => {
  db.$client.close()
})

// parseTranscriptFile 吃 claude code JSONL；fixture 形状对齐 tests/server.test.ts
// 的 writeJsonlFixture（{type, message:{role, content}}，经 src/claude/transcript.ts 验证）。
const makeTranscript = (turns: { role: string; content: string }[]): string => {
  const dir = mkdtempSync(join(tmpdir(), 'memside-batch-'))
  const p = join(dir, 'transcript.jsonl')
  writeFileSync(p, turns.map((t) => JSON.stringify({ type: t.role, message: { role: t.role, content: t.content } })).join('\n') + '\n')
  return p
}

const req = (path: string, init?: RequestInit) => app.fetch(new Request(`http://x${path}`, init))

const stop = (sessionId: string, transcriptPath: string) =>
  req('/hooks/claude/Stop', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ transcript_path: transcriptPath, cwd: '/proj', session_id: sessionId }),
  })

// fire-and-forget IIFE 落盘等待（对齐 tests/server.test.ts 的 50ms 等待模式）。
const waitIife = () => new Promise((r) => setTimeout(r, 50))

describe('Stop 累加（不变量 A/D）', () => {
  test('首个 Stop -> waiting job 建成且未放行；同 session 第二个 Stop 复用同 job', async () => {
    const tp = makeTranscript([{ role: 'user', content: '短内容' }])
    await stop('sess-1', tp)
    await waitIife()
    let jobs = await db.select().from(memoryDistillJobs)
    expect(jobs.length).toBe(1)
    expect(jobs[0]!.status).toBe('waiting')
    await stop('sess-1', tp)
    await waitIife()
    jobs = await db.select().from(memoryDistillJobs)
    expect(jobs.length).toBe(1) // 不变量 A：仍一个 job
    const events = await db.select().from(memoryDistillEvents)
      .where(eq(memoryDistillEvents.distillJobId, jobs[0]!.id))
    expect(events.length).toBe(1) // 不变量 D：恰一行
    expect(jobs[0]!.lastCaptureAt).not.toBeNull()
  })

  test('异 session 各自建 job', async () => {
    const tp = makeTranscript([{ role: 'user', content: 'x' }])
    await stop('sess-1', tp)
    await stop('sess-2', tp)
    await waitIife()
    expect((await db.select().from(memoryDistillJobs)).length).toBe(2)
  })

  test('阈值跨越 -> 放行 pending', async () => {
    // 9000 chars > DISTILL_RELEASE_MIN_CHARS(8000)；单 user turn 经
    // filterTranscriptForDistill 不截断（NON_TOOL_CAP_CHARS=20000）不丢（user 优先级 0）。
    const tp = makeTranscript([{ role: 'user', content: 'x'.repeat(9000) }])
    await stop('sess-1', tp)
    await waitIife()
    const jobs = await db.select().from(memoryDistillJobs)
    expect(jobs[0]!.status).toBe('pending')
  })

  test('无 sessionId -> 旧行为（立即 pending，一次 capture 一 job）', async () => {
    const tp = makeTranscript([{ role: 'user', content: 'x' }])
    await req('/hooks/claude/Stop', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ transcript_path: tp, cwd: '/proj' }),
    })
    await waitIife()
    expect(enqueueResults.length).toBe(1) // 走 deps.enqueueDistillJob（legacy seam）
    const jobs = await db.select().from(memoryDistillJobs)
    expect(jobs.length).toBe(1)
    expect(jobs[0]!.status).toBe('pending')
  })
})

describe('SessionEnd flush（spec §4.8）', () => {
  test('SessionEnd -> flush 标记落表，不动 job', async () => {
    const tp = makeTranscript([{ role: 'user', content: 'x' }])
    await stop('sess-1', tp)
    await waitIife()
    const r = await req('/hooks/claude/SessionEnd', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'sess-1', cwd: '/proj', reason: 'prompt_input_exit' }),
    })
    expect(r.status).toBe(202) // 同步 ack，不阻塞 claude code 退出路径
    await waitIife()
    const flushes = await db.select().from(memorySessionFlushes)
    expect(flushes.length).toBe(1)
    expect(flushes[0]!.sessionId).toBe('sess-1')
    const jobs = await db.select().from(memoryDistillJobs)
    expect(jobs[0]!.status).toBe('waiting') // flush 的放行由 tick sweep（Task 8）做
  })
})

describe('opencode capture 累加（两侧统一，spec 决策 1）', () => {
  test('同 sessionId 两次 idle 复用同 job', async () => {
    const msg = {
      sessionId: 'oc-1', cwd: '/proj', messages: [
        { info: { role: 'user' }, parts: [{ type: 'text', text: '短' }] },
      ],
    }
    await req('/hooks/opencode/capture', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(msg) })
    await req('/hooks/opencode/capture', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(msg) })
    await waitIife()
    const jobs = await db.select().from(memoryDistillJobs)
    expect(jobs.length).toBe(1)
    expect(jobs[0]!.status).toBe('waiting')
  })

  test('opencode 无 sessionId -> 旧行为（立即 pending）', async () => {
    const msg = { cwd: '/proj', messages: [{ info: { role: 'user' }, parts: [{ type: 'text', text: '短' }] }] }
    await req('/hooks/opencode/capture', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(msg) })
    await waitIife()
    const jobs = await db.select().from(memoryDistillJobs)
    expect(jobs.length).toBe(1)
    expect(jobs[0]!.status).toBe('pending')
  })
})

describe('降级可见化（spec §5）', () => {
  test('transcript 解析失败 -> 不炸路由，job 状态可解释（空切片不放行）', async () => {
    // parseTranscriptFile 对非法 JSONL 行静默跳过（src/claude/transcript.ts C3 注释：
    // 单行坏不丢全文件），全坏 -> 返回 []，不抛。因此走不到 accumulate 的 catch：
    // turns=[] -> computeSliceSignal -> {0,0} -> 不放行，job 停 waiting。
    // 本用例锁的是「解析失败不炸路由（202 + 无 500）、job 状态可解释」。
    const dir = mkdtempSync(join(tmpdir(), 'memside-batch-'))
    const p = join(dir, 'bad.jsonl')
    writeFileSync(p, 'not-json-at-all\n')
    const r = await stop('sess-bad', p)
    expect(r.status).toBe(202)
    await waitIife()
    const jobs = await db.select().from(memoryDistillJobs)
    expect(jobs.length).toBe(1)
    expect(jobs[0]!.status).toBe('waiting') // 空切片信号 {0,0}，shouldRelease=false
  })
})

describe('install.ts SessionEnd 注册（源码层文本断言）', () => {
  test('EVENTS 含 SessionEnd', () => {
    const src = readFileSync('src/install.ts', 'utf8')
    expect(src).toContain("'SessionEnd'")
  })
})

import { test, expect } from 'bun:test'
import { createActivityTracker } from '@/activity'

test('begin -> get 返回阶段实况；end 后归 null', () => {
  let t = 1000
  const tr = createActivityTracker(() => t)
  expect(tr.get()).toBeNull()
  const h = tr.begin('distill', 'memside')
  expect(tr.get()).toEqual({ phase: 'distill', detail: 'memside', since: 1000 })
  t = 13000
  expect(h.end()).toEqual({ calls: 0, ms: 12000 })
  expect(tr.get()).toBeNull()
})

test('wrapCall 递增当前阶段 calls；无当前阶段仅透传', async () => {
  let t = 0
  const tr = createActivityTracker(() => t)
  let delegated = 0
  const wrapped = tr.wrapCall(async () => { delegated++; return 'ok' })
  await wrapped('s', 'u')            // 无 phase：透传不计数
  expect(delegated).toBe(1)
  const h = tr.begin('dedup')
  await wrapped('s', 'u')
  await wrapped('s', 'u')
  expect(h.end().calls).toBe(2)
  expect(delegated).toBe(3)
})

test('后 begin 覆盖前 handle：前 handle.end 不清新 current、返回零值', () => {
  let t = 0
  const tr = createActivityTracker(() => t)
  const h1 = tr.begin('distill', 'a')
  t = 5000
  const h2 = tr.begin('judge', 'b')
  expect(h1.end()).toEqual({ calls: 0, ms: 0 })
  expect(tr.get()?.phase).toBe('judge')   // h1 没有把 judge 清掉
  t = 6000
  expect(h2.end().ms).toBeGreaterThan(0)
  expect(tr.get()).toBeNull()
})

test('detail 缺省为 null', () => {
  const tr = createActivityTracker(() => 0)
  tr.begin('digest')
  expect(tr.get()).toEqual({ phase: 'digest', detail: null, since: 0 })
})

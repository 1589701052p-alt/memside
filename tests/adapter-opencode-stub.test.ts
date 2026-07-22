import { test, expect } from 'bun:test'
import { OpencodeAdapter } from '@/adapter/opencode'

test('opencode adapter capture returns no jobs', async () => {
  const a = new OpencodeAdapter()
  const jobs = await a.capture()
  expect(jobs).toEqual([])
})

test('opencode adapter inject returns null (no-op)', async () => {
  const a = new OpencodeAdapter()
  const block = await a.inject({ cwd: '/r' } as any)
  expect(block).toBeNull()
})

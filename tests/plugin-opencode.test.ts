import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'

const js = readFileSync(new URL('../opencode-plugin/memside.js', import.meta.url), 'utf-8')

test('plugin 注册两钩子', () => {
  expect(js).toContain("'experimental.chat.messages.transform'")
  expect(js).toContain('session.idle')
})

test('plugin 端口 env 优先烘焙回退', () => {
  expect(js).toContain('process.env.MEMSIDE_PORT')
  expect(js).toContain('__MEMSIDE_PORT__')
})

test('inject 幂等守卫标记', () => {
  expect(js).toContain('--- BEGIN INJECTED MEMORY ---')
})

test('best-effort catch 不抛回 opencode', () => {
  expect(js).toMatch(/catch/)
})

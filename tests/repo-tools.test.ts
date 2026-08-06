// tests/repo-tools.test.ts
// 回归防护:agent 工具必须只读 + 沙箱——越界/逃逸一律拒绝且永不抛(炸循环即灌水管线停摆)。
// spec: docs/superpowers/specs/2026-08-06-agentic-value-judge-design.md §4.3
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeRepoTools } from '@/memory/repoTools'

const root = join(import.meta.dir, '.tmp-repo-tools')
beforeAll(() => {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true })
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, 'CLAUDE.md'), '# 规则\n禁止直推 master\n第三行\n')
  writeFileSync(join(root, 'src', 'a.ts'), 'export const sslBackend = 1\n'.repeat(300))
  writeFileSync(join(root, 'node_modules', 'dep', 'x.js'), 'sslBackend 不该被搜到\n')
  writeFileSync(join(root, '.git', 'y'), 'sslBackend 不该被搜到\n')
})
afterAll(() => { rmSync(root, { recursive: true, force: true }) })

const tools = () => makeRepoTools(root)

test('read: 正常读取 + 行数封顶 200', async () => {
  const out = await tools().execute('read', { path: 'src/a.ts', startLine: 1 })
  expect(out).toContain('sslBackend')
  expect(out.split('\n').length).toBeLessThanOrEqual(201)  // 200 行 + 可能的截断说明行
})

test('read: ../ 逃逸与绝对路径越界返回错误文本,不抛', async () => {
  const esc = await tools().execute('read', { path: '../../etc/passwd' })
  expect(esc).toContain('拒绝')
  const abs = await tools().execute('read', { path: 'C:/Windows/win.ini' })
  expect(abs).toContain('拒绝')
})

test('read: 文件不存在返回错误文本,不抛', async () => {
  expect(await tools().execute('read', { path: 'nope.md' })).toContain('不存在')
})

test('grep: 字面量命中 + 跳过 node_modules/.git', async () => {
  const out = await tools().execute('grep', { pattern: 'sslBackend' })
  expect(out).toContain('src')
  expect(out).not.toContain('node_modules')
  expect(out).not.toContain('.git')
})

test('grep: 无命中返回明确文本', async () => {
  expect(await tools().execute('grep', { pattern: '绝不可能存在的字符串xyz' })).toContain('0 处命中')
})

test('list: 列目录 + 条目数封顶', async () => {
  const out = await tools().execute('list', { path: '.' })
  expect(out).toContain('CLAUDE.md')
  expect(out).toContain('src')
})

test('未知工具名返回错误文本,不抛', async () => {
  expect(await tools().execute('write', { path: 'x' })).toContain('未知工具')
})

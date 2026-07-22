import { test, expect, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { loadClaudeCreds } from '@/creds'

const fakeHome = join(import.meta.dir, '.tmp-creds-home')
const realHome = homedir()

beforeEach(() => {
  rmSync(fakeHome, { recursive: true, force: true })
  mkdirSync(join(fakeHome, '.claude'), { recursive: true })
  ;(process.env as any).HOME = fakeHome
  delete process.env.ANTHROPIC_API_KEY
})
afterEach(() => {
  ;(process.env as any).HOME = realHome
})

test('reads api key from ~/.claude/.credentials.json', () => {
  writeFileSync(join(fakeHome, '.claude', '.credentials.json'), JSON.stringify({ apiKeyHelper: { apiKey: 'sk-test-123' } }))
  const c = loadClaudeCreds()
  expect(c.apiKey).toBe('sk-test-123')
  expect(c.source).toContain('credentials.json')
})

test('falls back to ANTHROPIC_API_KEY env', () => {
  process.env.ANTHROPIC_API_KEY = 'sk-env-456'
  const c = loadClaudeCreds()
  expect(c.apiKey).toBe('sk-env-456')
  expect(c.source).toBe('env')
})

test('returns null when no creds available', () => {
  const c = loadClaudeCreds()
  expect(c.apiKey).toBeNull()
})

test('reads oauth accessToken shape from credentials.json', () => {
  writeFileSync(
    join(fakeHome, '.claude', '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: 'sk-oauth-789' } }),
  )
  const c = loadClaudeCreds()
  expect(c.apiKey).toBe('sk-oauth-789')
  expect(c.source).toContain('credentials.json')
})

test('reads top-level apiKey shape from credentials.json', () => {
  writeFileSync(
    join(fakeHome, '.claude', '.credentials.json'),
    JSON.stringify({ apiKey: 'sk-top-000' }),
  )
  const c = loadClaudeCreds()
  expect(c.apiKey).toBe('sk-top-000')
  expect(c.source).toContain('credentials.json')
})

test('malformed credentials.json never throws - falls through to null', () => {
  writeFileSync(join(fakeHome, '.claude', '.credentials.json'), '{ not valid json')
  const c = loadClaudeCreds()
  expect(c.apiKey).toBeNull()
  expect(c.source).toBe('none')
})


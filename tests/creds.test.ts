import { test, expect, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { loadClaudeCreds, loadSettingsEnv } from '@/creds'

const fakeHome = join(import.meta.dir, '.tmp-creds-home')
const realHome = homedir()

// Env vars that touch credential resolution. Saved in beforeEach and restored
// in afterEach so each test starts from a clean slate and leaks nothing.
const ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_MODEL',
] as const

let envSnapshot: Record<string, string | undefined> = {}

beforeEach(() => {
  rmSync(fakeHome, { recursive: true, force: true })
  mkdirSync(join(fakeHome, '.claude'), { recursive: true })
  envSnapshot = {}
  for (const k of ENV_KEYS) {
    envSnapshot[k] = process.env[k]
    delete process.env[k]
  }
  ;(process.env as any).HOME = fakeHome
})
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (envSnapshot[k] === undefined) delete process.env[k]
    else (process.env as any)[k] = envSnapshot[k]
  }
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
  expect(c.source).toBe('env:apiKey')
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

// --- Change 1: proxy auth (authToken + baseURL + model) ---

test('(a) process env ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL -> apiKey=token, baseURL set, source=env:authToken', () => {
  process.env.ANTHROPIC_AUTH_TOKEN = 'ark-token-abc'
  process.env.ANTHROPIC_BASE_URL = 'https://ark.cn-beijing.volces.com/api/plan'
  const c = loadClaudeCreds()
  expect(c.apiKey).toBe('ark-token-abc')
  expect(c.baseURL).toBe('https://ark.cn-beijing.volces.com/api/plan')
  expect(c.source).toBe('env:authToken')
  expect(c.model).toBeUndefined()
})

test('(b) settings.json env with authToken+baseURL+defaultHaikuModel is picked from file', () => {
  writeFileSync(
    join(fakeHome, '.claude', 'settings.json'),
    JSON.stringify({
      env: {
        ANTHROPIC_AUTH_TOKEN: 'ark-from-settings',
        ANTHROPIC_BASE_URL: 'https://ark.example.com/api/plan',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash[1m]',
      },
    }),
  )
  // sanity: loadSettingsEnv returns the env object
  const envMap = loadSettingsEnv()
  expect(envMap.ANTHROPIC_AUTH_TOKEN).toBe('ark-from-settings')
  expect(envMap.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('deepseek-v4-flash[1m]')

  const c = loadClaudeCreds()
  expect(c.apiKey).toBe('ark-from-settings')
  expect(c.baseURL).toBe('https://ark.example.com/api/plan')
  expect(c.model).toBe('deepseek-v4-flash[1m]')
  expect(c.source).toBe('settings.json:authToken')
})

test('(c) process env ANTHROPIC_API_KEY wins over settings.json authToken', () => {
  writeFileSync(
    join(fakeHome, '.claude', 'settings.json'),
    JSON.stringify({
      env: {
        ANTHROPIC_AUTH_TOKEN: 'ark-from-settings',
        ANTHROPIC_BASE_URL: 'https://ark.example.com/api/plan',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash[1m]',
      },
    }),
  )
  process.env.ANTHROPIC_API_KEY = 'sk-env-wins'
  const c = loadClaudeCreds()
  expect(c.apiKey).toBe('sk-env-wins')
  expect(c.source).toBe('env:apiKey')
  // env apiKey path does not read baseURL/model from settings.json; only its own env
  expect(c.baseURL).toBeUndefined()
  expect(c.model).toBeUndefined()
})

test('(d) ANTHROPIC_DEFAULT_HAIKU_MODEL preferred over ANTHROPIC_MODEL for the model field', () => {
  process.env.ANTHROPIC_API_KEY = 'sk-x'
  process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'haiku-id'
  process.env.ANTHROPIC_MODEL = 'generic-model-id'
  const c = loadClaudeCreds()
  expect(c.model).toBe('haiku-id')
  expect(c.source).toBe('env:apiKey')
})

test('(d-cont) ANTHROPIC_MODEL is used when ANTHROPIC_DEFAULT_HAIKU_MODEL is absent', () => {
  process.env.ANTHROPIC_API_KEY = 'sk-x'
  process.env.ANTHROPIC_MODEL = 'generic-model-id'
  const c = loadClaudeCreds()
  expect(c.model).toBe('generic-model-id')
})

test('(e) malformed settings.json falls through to null / other sources', () => {
  writeFileSync(join(fakeHome, '.claude', 'settings.json'), '{ broken json')
  // no other creds -> null
  const c = loadClaudeCreds()
  expect(c.apiKey).toBeNull()
  expect(c.source).toBe('none')
  // and settings env is not the source of a phantom cred
  expect(loadSettingsEnv()).toEqual({})
})

test('settings.json with non-object env is treated as empty', () => {
  writeFileSync(
    join(fakeHome, '.claude', 'settings.json'),
    JSON.stringify({ env: 'not-an-object' }),
  )
  expect(loadSettingsEnv()).toEqual({})
  const c = loadClaudeCreds()
  expect(c.apiKey).toBeNull()
})

test('settings.json with non-string env values drops them', () => {
  writeFileSync(
    join(fakeHome, '.claude', 'settings.json'),
    JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 12345, ANTHROPIC_BASE_URL: 'https://x' } }),
  )
  // 12345 is not a string -> dropped; only string values survive
  const envMap = loadSettingsEnv()
  expect(envMap.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
  expect(envMap.ANTHROPIC_BASE_URL).toBe('https://x')
  // authToken dropped -> no cred resolves -> falls through
  const c = loadClaudeCreds()
  expect(c.apiKey).toBeNull()
})

test('missing settings.json yields empty env map', () => {
  expect(loadSettingsEnv()).toEqual({})
})

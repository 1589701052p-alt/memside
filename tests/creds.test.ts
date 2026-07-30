// 回归防护（2026-07-30 事故）：settings.json 必须先于进程 env；
// UI 配置必须最高优先。spec: docs/superpowers/specs/2026-07-30-llm-settings-ui-design.md
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

test('(c) settings.json authToken 优先于进程 env ANTHROPIC_API_KEY（2026-07-30 事故后链重排）', () => {
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
  process.env.ANTHROPIC_API_KEY = 'sk-env-loses'
  const c = loadClaudeCreds()
  // settings.json 级整体先于进程 env 级（整级短路）：返回 settings.json 的 authToken
  expect(c.apiKey).toBe('ark-from-settings')
  expect(c.source).toBe('settings.json:authToken')
  expect(c.baseURL).toBe('https://ark.example.com/api/plan')
  expect(c.model).toBe('deepseek-v4-flash[1m]')
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

// --- Task 2: creds 链重排 + UI 级（settings.json 先于 env） ---

test('(f) settings.json authToken 优先于进程 env（事故回归：持久 env 不得静默劫持）', () => {
  // settings.json 与进程 env 同时存在 authToken：settings.json 必须先赢
  writeFileSync(
    join(fakeHome, '.claude', 'settings.json'),
    JSON.stringify({
      env: {
        ANTHROPIC_AUTH_TOKEN: 'sk-settings-token',
        ANTHROPIC_BASE_URL: 'https://settings.example.com',
      },
    }),
  )
  process.env.ANTHROPIC_AUTH_TOKEN = 'sk-env-token'
  process.env.ANTHROPIC_BASE_URL = 'https://env.example.com'
  const c = loadClaudeCreds()
  expect(c.apiKey).toBe('sk-settings-token')
  expect(c.baseURL).toBe('https://settings.example.com')
  expect(c.source).toBe('settings.json:authToken')
})

test('(g) UI 配置整级短路：token 非空即生效，source=ui', () => {
  // UI 级还必须盖过 settings.json / env —— 同场布置底层干扰项
  writeFileSync(
    join(fakeHome, '.claude', 'settings.json'),
    JSON.stringify({
      env: {
        ANTHROPIC_AUTH_TOKEN: 'sk-settings-token',
        ANTHROPIC_BASE_URL: 'https://settings.example.com',
      },
    }),
  )
  process.env.ANTHROPIC_AUTH_TOKEN = 'sk-env-token'
  const c = loadClaudeCreds({ token: 'sk-ui-token-123456', baseURL: 'https://ui.example.com', model: 'ui-model' })
  expect(c).toEqual({ apiKey: 'sk-ui-token-123456', baseURL: 'https://ui.example.com', model: 'ui-model', source: 'ui' })
})

test('(h) UI 配置 baseURL/model 缺省 -> 不携带（调用方回默认）', () => {
  const c = loadClaudeCreds({ token: 'sk-ui-token-123456' })
  expect(c.apiKey).toBe('sk-ui-token-123456')
  expect(c.baseURL).toBeUndefined()
  expect(c.model).toBeUndefined()
  expect(c.source).toBe('ui')
})

test('(i) uiConfig 为 null / token 为空 -> 落到兜底链', () => {
  process.env.ANTHROPIC_API_KEY = 'sk-env-456'
  const a = loadClaudeCreds(null)
  const b = loadClaudeCreds({})
  // 两者均不得返回 source='ui'；具体落哪级由本用例的 mock 环境决定，断言不短路即可
  expect(a.source).not.toBe('ui')
  expect(b.source).not.toBe('ui')
})

// spec: docs/superpowers/specs/2026-07-30-llm-settings-ui-design.md §接口契约
// 锁定 Task 5 三端点的响应形状（Task 6/7 依赖）：
//   GET  /api/settings/llm  -> { saved: {...tokenMasked} | null, effective: {...tokenMasked, source} | null }
//   PUT  /api/settings/llm  -> 字段级合并保存后回显同一形状；token 永不回明文（spec 硬约束）
//   POST /api/settings/llm/test -> { ok: boolean; error?: string }
// 4 个注入字段（loadUiConfig/saveUiConfig/loadEffectiveCreds/testConnection）全部用假实现，
// 不碰真实 ~/.claude 与网络。loadUiConfig 抛错时 GET 必须降级 saved:null 而非 500（spec）。
import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { openDb } from '@/db/client'
import { ClaudeCodeAdapter } from '@/adapter/claudeCode'
import { OpencodeAdapter } from '@/adapter/opencode'
import { createApp } from '@/server'
import { maskToken, type UiLlmConfig } from '@/settings'
import type { ClaudeCreds } from '@/creds'
import type { OpenAiCreds } from '@/openai'

// EBUSY-safe pattern (same as server.test.ts): fresh per-test subdir, close the
// raw bun:sqlite handle in afterEach.
const root = join(import.meta.dir, '.tmp-settings-api')
let dir = ''
let db: ReturnType<typeof openDb>

beforeAll(() => {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
})

beforeEach(() => {
  dir = join(root, Math.random().toString(36).slice(2))
  mkdirSync(dir, { recursive: true })
  db = openDb(join(dir, 't.db'))
})

afterEach(() => {
  db.$client.close()
})

type SavePatch = { baseURL?: string; token?: string; model?: string; protocol?: 'anthropic' | 'openai'; clear?: boolean }

/** 可变 UI 配置存储 + 与 Task 1 saveUiLlmConfig 相同的字段级合并语义（假实现）。 */
function makeFakeUiStore(initial: UiLlmConfig | null = null) {
  let saved: UiLlmConfig | null = initial
  const patches: SavePatch[] = []
  return {
    patches,
    loadUiConfig: () => saved,
    saveUiConfig: (patch: SavePatch) => {
      patches.push(patch)
      if (patch.clear) { saved = null; return }
      const cur = saved ?? {}
      const next: UiLlmConfig = {}
      if (patch.baseURL !== undefined) { if (patch.baseURL !== '') next.baseURL = patch.baseURL }
      else if (cur.baseURL) next.baseURL = cur.baseURL
      if (patch.token) next.token = patch.token
      else if (cur.token) next.token = cur.token
      if (patch.model !== undefined) { if (patch.model !== '') next.model = patch.model }
      else if (cur.model) next.model = cur.model
      if (patch.protocol !== undefined) next.protocol = patch.protocol
      else if (cur.protocol) next.protocol = cur.protocol
      saved = next.token ? next : null
    },
  }
}

function makeApp(overrides: {
  loadUiConfig?: () => UiLlmConfig | null
  saveUiConfig?: (patch: SavePatch) => void
  loadEffectiveCreds?: () => ClaudeCreds
  loadEffectiveOpenAiCreds?: () => OpenAiCreds | null
  testConnection?: (cfg: { protocol: 'anthropic' | 'openai'; baseURL?: string; token: string; model?: string }) => Promise<{ ok: boolean; error?: string }>
} = {}) {
  return createApp({
    db,
    adapter: new ClaudeCodeAdapter(db),
    opencodeAdapter: new OpencodeAdapter(db),
    enqueueDistillJob: async () => ({ jobId: 'j', nextRunAt: 0 }),
    broadcast: () => {},
    ...overrides,
  })
}

async function req(app: ReturnType<typeof createApp>, path: string, init?: RequestInit) {
  const res = await app.fetch(new Request(`http://x${path}`, init))
  return { status: res.status, body: await res.json().catch(() => null) }
}

const putJson = (body: unknown): RequestInit => ({
  method: 'PUT',
  body: JSON.stringify(body),
  headers: { 'content-type': 'application/json' },
})

const postJson = (body: unknown): RequestInit => ({
  method: 'POST',
  body: JSON.stringify(body),
  headers: { 'content-type': 'application/json' },
})

test('GET 无 UI 配置 -> saved:null + effective 为注入的兜底级', async () => {
  const ui = makeFakeUiStore(null)
  const app = makeApp({
    ...ui,
    loadEffectiveCreds: () => ({
      apiKey: 'sk-fallback-credential-xyz',
      baseURL: 'https://ark.example.cn',
      model: 'some-model',
      source: 'settings.json:authToken',
    }),
    testConnection: async () => ({ ok: true }),
  })
  const r = await req(app, '/api/settings/llm')
  expect(r.status).toBe(200)
  expect(r.body.saved).toBeNull()
  expect(r.body.effective).toMatchObject({
    source: 'settings.json:authToken',
    baseURL: 'https://ark.example.cn',
    model: 'some-model',
  })
  expect(typeof r.body.effective.tokenMasked).toBe('string')
  // effective 也只回打码，不回明文
  expect(JSON.stringify(r.body)).not.toContain('sk-fallback-credential-xyz')
})

test('PUT 保存后 GET 回显 tokenMasked 且不含明文 token', async () => {
  const ui = makeFakeUiStore(null)
  const app = makeApp({
    ...ui,
    loadEffectiveCreds: () => ({ apiKey: null, source: 'none' }),
    testConnection: async () => ({ ok: true }),
  })
  const put = await req(app, '/api/settings/llm', putJson({
    baseURL: 'https://api.kimi.com',
    token: 'sk-kimiabcdef12345678fh',
    model: 'kimi-k2',
  }))
  expect(put.status).toBe(200)
  // maskToken('sk-kimiabcdef12345678fh') = 前6 + … + 后4（brief 清单里 'sk-kim…5678fh' 是笔误，
  // Task 1 已按前6+后4 落地并通过测试）
  expect(put.body.saved.tokenMasked).toBe('sk-kim…78fh')

  const get = await req(app, '/api/settings/llm')
  expect(get.status).toBe(200)
  expect(get.body.saved).toMatchObject({
    baseURL: 'https://api.kimi.com',
    model: 'kimi-k2',
    tokenMasked: 'sk-kim…78fh',
  })
  // spec 硬约束：任何 API 路径不得回明文 token
  expect(JSON.stringify(put.body)).not.toContain('sk-kimiabcdef12345678fh')
  expect(JSON.stringify(get.body)).not.toContain('sk-kimiabcdef12345678fh')
})

test('PUT token 缺省 -> 保持已存 token（字段级合并）', async () => {
  const ui = makeFakeUiStore({ token: 'sk-kimiabcdef12345678fh', baseURL: 'https://old.example.com' })
  const app = makeApp({
    ...ui,
    loadEffectiveCreds: () => ({ apiKey: null, source: 'none' }),
    testConnection: async () => ({ ok: true }),
  })
  const r = await req(app, '/api/settings/llm', putJson({ baseURL: 'https://new.example.com' }))
  expect(r.status).toBe(200)
  // 合并语义在 saveUiConfig 层（fake 复刻 Task 1 语义）；这里锁定的是端点把 patch 原样
  // 透传给 saveUiConfig（不带 token 字段）且回显的 saved 仍是打码旧 token
  expect(ui.patches[0]).toEqual({ baseURL: 'https://new.example.com' })
  expect(r.body.saved).toMatchObject({
    baseURL: 'https://new.example.com',
    tokenMasked: 'sk-kim…78fh',
  })
  expect(JSON.stringify(r.body)).not.toContain('sk-kimiabcdef12345678fh')
})

test('PUT clear:true -> saved 变 null', async () => {
  const ui = makeFakeUiStore({ token: 'sk-kimiabcdef12345678fh' })
  const app = makeApp({
    ...ui,
    loadEffectiveCreds: () => ({ apiKey: null, source: 'none' }),
    testConnection: async () => ({ ok: true }),
  })
  const r = await req(app, '/api/settings/llm', putJson({ clear: true }))
  expect(r.status).toBe(200)
  expect(ui.patches[0]).toEqual({ clear: true })
  expect(r.body.saved).toBeNull()

  const get = await req(app, '/api/settings/llm')
  expect(get.body.saved).toBeNull()
})

test('PUT 非法 baseURL（非 http URL）-> 400', async () => {
  const ui = makeFakeUiStore(null)
  const app = makeApp({
    ...ui,
    loadEffectiveCreds: () => ({ apiKey: null, source: 'none' }),
    testConnection: async () => ({ ok: true }),
  })
  const r = await req(app, '/api/settings/llm', putJson({ baseURL: 'ftp://nope', token: 'sk-x' }))
  expect(r.status).toBe(400)
  // 校验失败不得落存储
  expect(ui.patches.length).toBe(0)
})

test('POST test 空 body 用已保存配置；无凭证 -> {ok:false,error:"no credentials"}', async () => {
  const ui = makeFakeUiStore(null)
  const calls: { protocol: string; baseURL?: string; token: string; model?: string }[] = []
  const app = makeApp({
    ...ui,
    loadEffectiveCreds: () => ({ apiKey: null, source: 'none' }),
    testConnection: async (cfg) => { calls.push(cfg); return { ok: true } },
  })
  // 无任何已保存配置 -> no credentials（HTTP 200 + ok:false，不是 4xx/5xx）
  const noCred = await req(app, '/api/settings/llm/test', postJson({}))
  expect(noCred.status).toBe(200)
  expect(noCred.body).toEqual({ ok: false, error: 'no credentials' })
  expect(calls.length).toBe(0)

  // 保存后空 body -> 用已保存配置调 testConnection
  const ui2 = makeFakeUiStore({ token: 'sk-kimiabcdef12345678fh', baseURL: 'https://api.kimi.com', model: 'kimi-k2' })
  const calls2: typeof calls = []
  const app2 = makeApp({
    ...ui2,
    loadEffectiveCreds: () => ({ apiKey: null, source: 'none' }),
    testConnection: async (cfg) => { calls2.push(cfg); return { ok: true } },
  })
  const withSaved = await req(app2, '/api/settings/llm/test', postJson({}))
  expect(withSaved.status).toBe(200)
  expect(withSaved.body).toEqual({ ok: true })
  expect(calls2).toEqual([{ protocol: 'anthropic', baseURL: 'https://api.kimi.com', token: 'sk-kimiabcdef12345678fh', model: 'kimi-k2' }])
})

test('POST test body 带 token -> 调注入的 testConnection，成功/失败透传', async () => {
  const ui = makeFakeUiStore(null)
  const calls: { protocol: string; baseURL?: string; token: string; model?: string }[] = []
  let nextResult: { ok: boolean; error?: string } = { ok: true }
  const app = makeApp({
    ...ui,
    loadEffectiveCreds: () => ({ apiKey: null, source: 'none' }),
    testConnection: async (cfg) => { calls.push(cfg); return nextResult },
  })
  const okRes = await req(app, '/api/settings/llm/test', postJson({
    baseURL: 'https://api.kimi.com', token: 'sk-body-token-1234567890ab', model: 'kimi-k2',
  }))
  expect(okRes.status).toBe(200)
  expect(okRes.body).toEqual({ ok: true })
  expect(calls[0]).toEqual({ protocol: 'anthropic', baseURL: 'https://api.kimi.com', token: 'sk-body-token-1234567890ab', model: 'kimi-k2' })
  // body token 只用于本次测试，不得写存储
  expect(ui.patches.length).toBe(0)

  nextResult = { ok: false, error: 'connection refused' }
  const failRes = await req(app, '/api/settings/llm/test', postJson({ token: 'sk-body-token-1234567890ab' }))
  expect(failRes.status).toBe(200)
  expect(failRes.body).toEqual({ ok: false, error: 'connection refused' })
})

test('GET 存储异常 -> saved:null 不 500', async () => {
  const app = makeApp({
    loadUiConfig: () => { throw new Error('SQLITE_BUSY') },
    saveUiConfig: () => {},
    loadEffectiveCreds: () => ({ apiKey: 'sk-fallback-abc', source: 'env:apiKey' }),
    testConnection: async () => ({ ok: true }),
  })
  const r = await req(app, '/api/settings/llm')
  expect(r.status).toBe(200)
  expect(r.body.saved).toBeNull()
  // effective 不受 UI 读异常影响
  expect(r.body.effective).toMatchObject({ source: 'env:apiKey' })
})

// spec §测试连接按协议派发：PUT 存 protocol，空 body test 用已存 protocol 派发到 openai。
test('PUT protocol=openai 保存；空 body test 派发到注入 testConnection 且带 protocol', async () => {
  const ui = makeFakeUiStore(null)
  const calls: { protocol: string; baseURL?: string; token: string; model?: string }[] = []
  const app = makeApp({
    ...ui,
    loadEffectiveCreds: () => ({ apiKey: null, source: 'none' }),
    testConnection: async (cfg) => { calls.push(cfg); return { ok: true } },
  })
  const put = await req(app, '/api/settings/llm', putJson({
    baseURL: 'https://ark.cn-beijing.volces.com/api/plan/v3',
    token: 'sk-abcdefghijklmn',
    model: 'ark-code-latest',
    protocol: 'openai',
  }))
  expect(put.status).toBe(200)
  expect(put.body.saved).toMatchObject({ protocol: 'openai', tokenMasked: 'sk-abc…klmn' })

  const t = await req(app, '/api/settings/llm/test', postJson({}))
  expect(t.status).toBe(200)
  expect(calls[0]).toEqual({
    protocol: 'openai',
    baseURL: 'https://ark.cn-beijing.volces.com/api/plan/v3',
    token: 'sk-abcdefghijklmn',
    model: 'ark-code-latest',
  })
})

test('PUT protocol 缺省 -> saved.protocol 默认 anthropic', async () => {
  const ui = makeFakeUiStore(null)
  const app = makeApp({
    ...ui,
    loadEffectiveCreds: () => ({ apiKey: null, source: 'none' }),
    testConnection: async () => ({ ok: true }),
  })
  const put = await req(app, '/api/settings/llm', putJson({ baseURL: 'https://a.example.com', token: 'sk-abcdefghijklmn' }))
  expect(put.status).toBe(200)
  expect(put.body.saved.protocol).toBe('anthropic')
})

test('PUT 非法 protocol -> 400', async () => {
  const ui = makeFakeUiStore(null)
  const app = makeApp({
    ...ui,
    loadEffectiveCreds: () => ({ apiKey: null, source: 'none' }),
    testConnection: async () => ({ ok: true }),
  })
  const r = await req(app, '/api/settings/llm', putJson({ token: 'sk-x', protocol: 'grpc' }))
  expect(r.status).toBe(400)
  expect(ui.patches.length).toBe(0)
})

// spec §生效 API 解析：openai 协议下 effective 反映 OpenAI creds（非 Anthropic 链），
// source=ui/env:openai，token 打码。
test('GET openai 协议 -> effective 用 loadEffectiveOpenAiCreds（OpenAI creds，source 正确）', async () => {
  const ui = makeFakeUiStore({ token: 'sk-openai-abcdefghijkl', protocol: 'openai', baseURL: 'https://ark.example.cn/api/plan/v3', model: 'ark-code-latest' })
  const app = makeApp({
    ...ui,
    loadEffectiveOpenAiCreds: () => ({ apiKey: 'sk-openai-abcdefghijkl', baseURL: 'https://ark.example.cn/api/plan/v3', model: 'ark-code-latest', source: 'ui' }),
    loadEffectiveCreds: () => ({ apiKey: 'sk-wrong-anthropic', source: 'settings.json:authToken' }), // 证明 openai 不走它
    testConnection: async () => ({ ok: true }),
  })
  const r = await req(app, '/api/settings/llm')
  expect(r.status).toBe(200)
  expect(r.body.effective).toMatchObject({
    protocol: 'openai',
    source: 'ui',
    baseURL: 'https://ark.example.cn/api/plan/v3',
    model: 'ark-code-latest',
  })
  expect(r.body.effective.tokenMasked).toBe(maskToken('sk-openai-abcdefghijkl'))
  expect(JSON.stringify(r.body)).not.toContain('sk-openai-abcdefghijkl')
})

test('GET anthropic 协议（缺省）-> effective 仍用 loadEffectiveCreds（不回归）', async () => {
  const ui = makeFakeUiStore(null)
  const app = makeApp({
    ...ui,
    loadEffectiveCreds: () => ({ apiKey: 'sk-fallback-xyz', baseURL: 'https://a.example.com', source: 'settings.json:authToken' }),
    testConnection: async () => ({ ok: true }),
  })
  const r = await req(app, '/api/settings/llm')
  expect(r.status).toBe(200)
  expect(r.body.effective).toMatchObject({ protocol: 'anthropic', source: 'settings.json:authToken', baseURL: 'https://a.example.com' })
})

// spec §test-effective：无 body 解析生效 creds，按协议派发 testConn；无 creds -> no credentials。
test('POST test-effective openai -> 用生效 OpenAI creds 调 testConn', async () => {
  const ui = makeFakeUiStore({ token: 'sk-openai-abcdefghijkl', protocol: 'openai', baseURL: 'https://ark.example.cn/api/plan/v3', model: 'ark-code-latest' })
  const calls: { protocol: string; baseURL?: string; token: string; model?: string }[] = []
  const app = makeApp({
    ...ui,
    loadEffectiveOpenAiCreds: () => ({ apiKey: 'sk-openai-abcdefghijkl', baseURL: 'https://ark.example.cn/api/plan/v3', model: 'ark-code-latest', source: 'ui' }),
    loadEffectiveCreds: () => ({ apiKey: 'sk-wrong-anthropic', source: 'none' }),
    testConnection: async (cfg) => { calls.push(cfg); return { ok: true } },
  })
  const r = await req(app, '/api/settings/llm/test-effective', postJson({}))
  expect(r.status).toBe(200)
  expect(r.body).toEqual({ ok: true })
  expect(calls).toEqual([{ protocol: 'openai', baseURL: 'https://ark.example.cn/api/plan/v3', token: 'sk-openai-abcdefghijkl', model: 'ark-code-latest' }])
})

test('POST test-effective 无 creds -> {ok:false, error:"no credentials"}', async () => {
  const ui = makeFakeUiStore(null)
  const app = makeApp({
    ...ui,
    loadEffectiveOpenAiCreds: () => null,
    loadEffectiveCreds: () => ({ apiKey: null, source: 'none' }),
    testConnection: async () => ({ ok: true }),
  })
  const r = await req(app, '/api/settings/llm/test-effective', postJson({}))
  expect(r.status).toBe(200)
  expect(r.body).toEqual({ ok: false, error: 'no credentials' })
})

test('POST test-effective 存储读异常 -> no credentials 不 500', async () => {
  const app = makeApp({
    loadUiConfig: () => { throw new Error('SQLITE_BUSY') },
    saveUiConfig: () => {},
    loadEffectiveOpenAiCreds: () => null,
    loadEffectiveCreds: () => ({ apiKey: null, source: 'none' }),
    testConnection: async () => ({ ok: true }),
  })
  const r = await req(app, '/api/settings/llm/test-effective', postJson({}))
  expect(r.status).toBe(200)
  expect(r.body).toEqual({ ok: false, error: 'no credentials' })
})

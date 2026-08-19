import { DEFAULT_LLM_MAX_TOKENS, type LLMCall, type LLMCallOpts } from './llm'
import type { UiLlmConfig } from './settings'

export interface OpenAiCreds {
  apiKey: string
  baseURL: string // 不含尾斜杠；chat/completions 拼在后面
  model: string
  source: string // 来源标识：'ui' | 'env:openai'
}

export interface OpenAiDeps {
  /** Injectable for tests; production reads env. */
  loadOpenAiCreds?: () => OpenAiCreds | null
  /** 注入 UI 级 LLM 配置；存在时 makeLLMCall 走 UI creds（loadOpenAiUiCreds），否则走注入/默认 loader。 */
  loadUiConfig?: () => UiLlmConfig | null
  /** 单次请求硬超时；默认 120s。 */
  timeoutMs?: number
}

/**
 * 从 env 读 OpenAI 凭证。`OPENAI_API_KEY` 缺 -> 返回 null（调用方抛错）。
 * `OPENAI_API_KEY` 有但 `OPENAI_MODEL` 缺 -> 抛错（明确的配置错误）。
 * `OPENAI_BASE_URL` 缺省 `https://api.openai.com/v1`，尾斜杠剥除。
 */
export function loadOpenAiCreds(): OpenAiCreds | null {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) return null
  const baseURL = (process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '')
  const model = process.env.OPENAI_MODEL
  if (!model) throw new Error('OPENAI_API_KEY set but OPENAI_MODEL missing; set OPENAI_MODEL')
  return { apiKey, baseURL, model, source: 'env:openai' }
}

/**
 * UI 级凭证合并：UI token 存在优先用 UI creds（model/baseURL 缺省回退 env），
 * model 与 env 都缺则抛错；UI 为 null 或 token 缺失回退 loadOpenAiCreds()（env）。
 */
export function loadOpenAiUiCreds(
  ui: UiLlmConfig | null,
  env: Record<string, string | undefined> = process.env,
): OpenAiCreds | null {
  if (ui?.token) {
    const model = ui.model ?? env.OPENAI_MODEL
    if (!model) throw new Error('OpenAI model missing; set model in UI settings or OPENAI_MODEL')
    const baseURL = (ui.baseURL ?? env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '')
    return { apiKey: ui.token, baseURL, model, source: 'ui' }
  }
  return loadOpenAiCreds()
}

/**
 * 构造由 OpenAI /chat/completions 支撑的 LLMCall seam。fetch 直连，Bearer 鉴权，
 * system+user 两条 message，取 choices[0].message.content。max_tokens 走
 * opts?.maxTokens ?? DEFAULT_LLM_MAX_TOKENS。无凭据 / HTTP 非 2xx / 超时 / 响应异常
 * 均抛错，交由 runLlmSession 执行器重试 + 各层降级。
 */
export function makeLLMCall(deps: OpenAiDeps = {}): LLMCall {
  const load = deps.loadOpenAiCreds ?? loadOpenAiCreds
  const loadUi = deps.loadUiConfig
  const timeoutMs = deps.timeoutMs ?? 120_000
  return async function callLLM(system: string, user: string, opts?: LLMCallOpts): Promise<string> {
    const c = loadUi ? loadOpenAiUiCreds(loadUi(), process.env) : load()
    if (!c) throw new Error('no OpenAI credentials; set OPENAI_API_KEY + OPENAI_BASE_URL + OPENAI_MODEL')
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const resp = await fetch(`${c.baseURL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.apiKey}` },
        body: JSON.stringify({
          model: c.model,
          max_tokens: opts?.maxTokens ?? DEFAULT_LLM_MAX_TOKENS,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
        signal: ctrl.signal,
      })
      if (!resp.ok) {
        const body = await resp.text().catch(() => '')
        throw new Error(`OpenAI HTTP ${resp.status}: ${body.slice(0, 200)}`)
      }
      const data = await resp.json() as { choices?: { message?: { content?: unknown } }[] }
      const text = data?.choices?.[0]?.message?.content
      if (typeof text !== 'string') throw new Error('OpenAI response missing choices[0].message.content')
      return text
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * 向 OpenAI 兼容端点发最小连通性请求（max_tokens:1, messages:[{role:'user',content:'hi'}]）。
 * 默认 15s 超时；返回 {ok,error}，不抛错。
 */
export async function testConnection(
  cfg: { baseURL?: string; token: string; model?: string },
  opts?: { timeoutMs?: number },
): Promise<{ ok: boolean; error?: string }> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts?.timeoutMs ?? 15_000)
  try {
    const baseURL = (cfg.baseURL ?? 'https://api.openai.com/v1').replace(/\/$/, '')
    const resp = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.token}` },
      body: JSON.stringify({ model: cfg.model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
      signal: ctrl.signal,
    })
    if (!resp.ok) {
      const body = await resp.text().catch(() => '')
      return { ok: false, error: `OpenAI HTTP ${resp.status}: ${body.slice(0, 200)}` }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  } finally {
    clearTimeout(timer)
  }
}

import { DEFAULT_LLM_MAX_TOKENS, type LLMCall, type LLMCallOpts } from './llm'
import type { UiLlmConfig } from './settings'
import { parseSseChunks } from './memory/sse'

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
  /** 单次请求硬超时；默认 600s（流式总上限兜底，字节流动期间不触发）。 */
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
 * system+user 两条 message，流式读 body 累加 choices[0].delta.content。max_tokens 走
 * opts?.maxTokens ?? DEFAULT_LLM_MAX_TOKENS。无凭据 / HTTP 非 2xx / 超时 / 响应异常
 * 均抛错，交由 runLlmSession 执行器重试 + 各层降级。
 */
export function makeLLMCall(deps: OpenAiDeps = {}): LLMCall {
  const load = deps.loadOpenAiCreds ?? loadOpenAiCreds
  const loadUi = deps.loadUiConfig
  const timeoutMs = deps.timeoutMs ?? 600_000
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
          stream: true,
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
      if (!resp.body) throw new Error('OpenAI streaming response missing body')
      // 流式：逐块读 body，SSE 解析，累加 delta.content。字节持续流动期间不触发超时。
      const reader = resp.body.getReader()
      const decoder = new TextDecoder('utf-8')
      let leftover = ''
      let text = ''
      let dataEventCount = 0
      let rawBody = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const decoded = decoder.decode(value, { stream: true })
        rawBody += decoded
        leftover += decoded
        const { events, leftover: next } = parseSseChunks(leftover, '')
        leftover = next
        for (const ev of events) {
          dataEventCount++
          if (ev.data === '[DONE]') { reader.cancel(); break }
          let parsed: unknown
          try { parsed = JSON.parse(ev.data) } catch { continue }
          // Finding 2：流式 error 帧（如 Azure content-filter）显式抛错，避免截断文本冒充成功。
          if (typeof parsed === 'object' && parsed !== null && 'error' in parsed) {
            throw new Error(`OpenAI 流式响应含错误帧: ${JSON.stringify((parsed as { error: unknown }).error).slice(0, 200)}`)
          }
          const delta = (parsed as { choices?: { delta?: { content?: unknown } }[] })?.choices?.[0]?.delta?.content
          if (typeof delta === 'string') text += delta
        }
      }
      // Finding 1：网关忽略 stream:true 返回非 SSE JSON body 时，无任何 data: 事件被解析、
      // 原始响应非空 —— 旧码会返回 ''（下游变 opaque aborted 重试暂停）。现抛诊断错误带原始响应前缀。
      if (dataEventCount === 0 && rawBody.trim().length > 0) {
        throw new Error(`OpenAI 非流式响应（网关可能忽略 stream:true；原始响应: ${rawBody.slice(0, 200)})`)
      }
      // 兼容：响应可能为空（极少），返回空串（与旧「无 content 抛错」略不同——
      // 流式语义下空响应更可能合法地返回空串；调用方 shouldRetry 路径会兜住非 JSON）。
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

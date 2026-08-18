import Anthropic from '@anthropic-ai/sdk'
import { loadClaudeCreds, type ClaudeCreds } from './creds'
import { DEFAULT_LLM_MAX_TOKENS, type LLMCall, type LLMCallOpts } from './llm'
import { isAbortLike } from './memory/stepPrompt'
import type { UiLlmConfig } from './settings'

export interface AnthropicDeps {
  /** Injectable for tests; production uses the real `loadClaudeCreds`. */
  loadClaudeCreds?: (uiConfig?: UiLlmConfig | null) => ClaudeCreds
  /** UI 级配置读取（daemon 注入 db-backed；缺省 = 无 UI 级）。 */
  loadUiConfig?: () => UiLlmConfig | null
}

/**
 * Model id for distill calls.
 *
 * This is the **fallback** used when the user has not configured a haiku model.
 * The user's `ANTHROPIC_DEFAULT_HAIKU_MODEL` (or `ANTHROPIC_MODEL`) env var /
 * `~/.claude/settings.json` `env` value takes precedence via `loadClaudeCreds`
 * and is passed straight through to `messages.stream`; `DISTILL_MODEL` only
 * applies when no such override is present (e.g. the official
 * `ANTHROPIC_API_KEY` path with no model env). When routing through a proxy
 * (Volcengine Ark) the resolved model is typically a non-Anthropic id like
 * `deepseek-v4-flash[1m]`, so honoring it is required for the call to land.
 *
 * Verification debt (Task 17 live-smoke): the reachability of this exact id
 * with the user's credential is not locked by these tests (they mock the SDK).
 * If the id shape is wrong, the unit tests stay green while the live daemon
 * 4xx's. Confirm against `https://docs.anthropic.com/en/docs/about-claude/models`
 * during the Task 17 manual smoke.
 */
export const DISTILL_MODEL = 'claude-haiku-4-5-20251001'

/**
 * Build the `callLLM(system, user, opts?)` seam the distiller / dedup /
 * valueFilter (via runLlmSession) consume. Production wires the real
 * `@anthropic-ai/sdk` client using `loadClaudeCreds`; tests inject a mock
 * `callLLM` directly (or `loadClaudeCreds` here).
 *
 * The resolved credentials drive three SDK inputs:
 *   - `apiKey`: the auth key (official `ANTHROPIC_API_KEY` or a proxy
 *     `ANTHROPIC_AUTH_TOKEN`).
 *   - `baseURL`: forwarded only when present, so a proxy (Ark) endpoint is used
 *     while the official API keeps its default.
 *   - `model`: the creds model when configured, otherwise `DISTILL_MODEL`.
 *
 * `max_tokens` defaults to `DEFAULT_LLM_MAX_TOKENS` (8192); override per call
 * via `opts.maxTokens`. Throws if no credential is resolvable - the distiller's
 * top-level try/catch degrades that to "no candidates this round" and records
 * `lastError` on the job, so a misconfigured daemon never crashes the loop.
 *
 * 流式化说明（2026-08-14 根因修复）：调用走 `messages.stream` + `finalMessage()`，
 * 不用非流式 `messages.create`。实测当前 LLM 端点对生成超过约 60s 的非流式请求
 * 准时断连（非流式期间响应方向零字节，必撞 TTFB 墙）；流式字节持续流动，同载荷
 * 可稳定完成。`timeout: 600_000` 是 10 分钟硬上限兜底（正常流式 170-210s），
 * `maxRetries` 保留 SDK 默认（连接错误自动重试）。返回值语义与非流式一致，
 * 调用方零感知。
 *
 * UI 配置经由 `deps.loadUiConfig` 注入：每次调用先读一次（读到的值原样传给
 * `loadClaudeCreds`），UI 级整级短路语义见 `creds.ts`。
 */
export function makeLLMCall(deps: AnthropicDeps = {}): LLMCall {
  const load = deps.loadClaudeCreds ?? loadClaudeCreds
  return async function callLLM(system: string, user: string, opts?: LLMCallOpts): Promise<string> {
    const creds = load(deps.loadUiConfig ? deps.loadUiConfig() : undefined)
    if (!creds.apiKey) {
      throw new Error('no claude credentials; run memside with ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN (+ ANTHROPIC_BASE_URL), or log in to claude code')
    }
    const client = new Anthropic({
      apiKey: creds.apiKey,
      ...(creds.baseURL ? { baseURL: creds.baseURL } : {}),
    })
    const stream = client.messages.stream(
      {
        model: creds.model ?? DISTILL_MODEL,
        max_tokens: opts?.maxTokens ?? DEFAULT_LLM_MAX_TOKENS,
        system,
        messages: [{ role: 'user', content: user }],
      },
      { timeout: 600_000 },
    )
    let msg
    try {
      msg = await stream.finalMessage()
    } catch (e) {
      // 诊断化（spec §缺陷3 / Task 10）：只有当原始错误确实是 abort / 连接中断 /
      // 超时 / socket 复位等「网关掐断」类异常时，才 re-throw 带诊断前缀的 Error
      // （供 runLlmSession 接续重试落盘 + UI 可见，原文作 cause 保留）。
      // 其它错误（401 / 400 / 校验失败等）原样 re-throw——保留 SDK 原生消息，
      // 避免把鉴权 / 入参错误误诊为「网关掐断」（P1/P8：失败要准确、不可静默）。
      //
      // P6 不变量：memside 与 LLM/网关解耦——不设主动 setTimeout / AbortController
      // 掐断（已有的 timeout:600_000 是 SDK 硬上限兜底，流式字节流动期间不触发）。
      // 只改错误文案，不改流式语义、不加主动超时。
      if (isAbortLike(e)) {
        const raw = e instanceof Error ? e.message : String(e)
        throw new Error(
          `LLM 调用被中断，可能是网关掐断或超时；memside 会自动接续重试（原始错误：${raw}）`,
          { cause: e },
        )
      }
      throw e
    }
    // extract text from content blocks (TextBlock has type:'text' + text:string;
    // ToolUseBlock is silently dropped). The `ContentBlock` union doesn't narrow
    // through `.filter` without a type predicate, so narrow explicitly.
    const text = msg.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('')
    return text
  }
}

/**
 * 「测试连接」端点的默认实现：用给定配置发 max_tokens=1 的最小请求。
 * 不保存任何配置；错误描述透传（与 distiller 错误格式同源：Error.message）。
 * 默认超时 15s。
 */
export async function testConnection(
  cfg: { baseURL?: string; token: string; model?: string },
  opts?: { timeoutMs?: number },
): Promise<{ ok: boolean; error?: string }> {
  try {
    const client = new Anthropic({
      apiKey: cfg.token,
      ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}),
    })
    await client.messages.create(
      { model: cfg.model ?? DISTILL_MODEL, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] },
      { timeout: opts?.timeoutMs ?? 15_000 },
    )
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

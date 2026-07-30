import Anthropic from '@anthropic-ai/sdk'
import { loadClaudeCreds, type ClaudeCreds } from './creds'
import { DEFAULT_LLM_MAX_TOKENS, type LLMCall, type LLMCallOpts } from './llm'
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
 * and is passed straight through to `messages.create`; `DISTILL_MODEL` only
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
 * valueFilter (via callWithRetry) consume. Production wires the real
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
    const msg = await client.messages.create({
      model: creds.model ?? DISTILL_MODEL,
      max_tokens: opts?.maxTokens ?? DEFAULT_LLM_MAX_TOKENS,
      system,
      messages: [{ role: 'user', content: user }],
    })
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

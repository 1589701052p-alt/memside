/** 单次 LLM 调用的可选参数。 */
export interface LLMCallOpts {
  /** 输出 token 上限；缺省时实现用 DEFAULT_LLM_MAX_TOKENS。 */
  maxTokens?: number
}

/**
 * vendor-neutral 的 LLM 调用 seam。核心记忆模块（distiller / dedup /
 * valueFilter / scheduler）与 runLlmSession 执行器依赖此类型，而非任何具体
 * provider。实现（src/anthropic.ts）只在组合根（daemon.ts）装配；测试注入
 * mock。返回模型响应的拼接文本。
 *
 * 本模块刻意不 import `@anthropic-ai/sdk` / `./creds`，使"核心不依赖 SDK"
 * 成为结构保证：核心 `import type { LLMCall }` 编译期擦除，运行时零 SDK
 * 依赖，且即便误写运行时 import 也碰不到 SDK。
 */
export type LLMCall = (system: string, user: string, opts?: LLMCallOpts) => Promise<string>

/** opts.maxTokens 缺省时的默认 max_tokens。 */
export const DEFAULT_LLM_MAX_TOKENS = 8192

/** 组合根可选的 LLM 后端实现。vendor 名留在实现层（anthropic.ts / openai.ts）。 */
export type LLMBackend = 'anthropic' | 'openai'

/**
 * 混合后端选择：显式 `MEMSIDE_LLM_BACKEND=anthropic|openai` 覆盖；未设（或空串）
 * 时按 `OPENAI_API_KEY` 存在性探测——有则 openai，无则 anthropic。未识别的非空
 * 值抛错（防拼错静默回退）。纯函数、SDK-free、不 import 任何实现，易单测。
 *
 * 不取 `hasAnthropicCreds` 参数：无 OPENAI_API_KEY 时默认 anthropic，若 anthropic
 * 凭证也缺，由 `makeLLMCall`(anthropic) 在调用时抛 "no credentials"，语义正确。
 */
export function resolveLLMBackend(env: Record<string, string | undefined>): LLMBackend {
  const e = env.MEMSIDE_LLM_BACKEND
  if (e === 'openai') return 'openai'
  if (e === 'anthropic') return 'anthropic'
  if (e !== undefined && e !== '') throw new Error(`unknown MEMSIDE_LLM_BACKEND: ${e} (want 'anthropic' | 'openai')`)
  return env.OPENAI_API_KEY ? 'openai' : 'anthropic'
}

export type LLMProtocol = LLMBackend

/**
 * 每次调用动态解析协议（spec §决策 3，即时生效）：
 * - UI 配置有 token 时，UI 存的 protocol 优先（缺省 anthropic），压过 env。
 * - UI 无 token（UI 级未激活）时回退 resolveLLMBackend(env)（现状）。
 * 纯函数、SDK-free、不 import settings（结构参数保持解耦）。
 */
export function resolveCallLLMProtocol(
  uiConfig: { token?: string; protocol?: LLMProtocol } | null,
  env: Record<string, string | undefined>,
): LLMProtocol {
  if (uiConfig?.token) return uiConfig.protocol ?? 'anthropic'
  return resolveLLMBackend(env)
}

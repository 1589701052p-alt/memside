/** 单次 LLM 调用的可选参数。 */
export interface LLMCallOpts {
  /** 输出 token 上限；缺省时实现用 DEFAULT_LLM_MAX_TOKENS。 */
  maxTokens?: number
}

/**
 * vendor-neutral 的 LLM 调用 seam。核心记忆模块（distiller / dedup /
 * valueFilter / scheduler）与 callWithRetry 中介依赖此类型，而非任何具体
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

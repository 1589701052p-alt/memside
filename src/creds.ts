import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { UiLlmConfig } from './settings'

export interface ClaudeCreds {
  apiKey: string | null
  /** Anthropic-compatible base URL (proxy). Set when going through e.g. a Volcengine Ark proxy. */
  baseURL?: string
  /** Resolved model id; takes precedence over `DISTILL_MODEL` in the call site. */
  model?: string
  source: string
}

/**
 * Resolve the user's home directory in a portable way.
 *
 * `os.homedir()` reads `USERPROFILE` on Windows and ignores `HOME`, so we honor
 * an explicit `HOME` override first (tests rely on this; on Windows a user-set
 * `HOME` is also what claude code itself honors when present). Falls back to
 * `USERPROFILE`, then the OS-reported home.
 */
function resolveHome(): string {
  return process.env.HOME || process.env.USERPROFILE || homedir()
}

/**
 * Result of scanning an env-like map for Anthropic credentials. Returned by
 * `pickFromEnv` when a usable credential is present; `null` otherwise.
 */
interface PickedCred {
  apiKey: string
  baseURL?: string
  model?: string
  source: string
}

/**
 * Extract `{ apiKey, baseURL?, model? }` from an env-like map (either
 * `process.env` or a `settings.json` env object), applying the
 * **apiKey-then-authToken** preference the Anthropic SDK conventions use.
 *
 * `model` is resolved as `ANTHROPIC_DEFAULT_HAIKU_MODEL` falling back to
 * `ANTHROPIC_MODEL` (the former is what claude code writes for the haiku slot).
 *
 * `sourceTag` is prefixed onto the returned `source` so the same logic serves
 * both process env (`'env'`) and settings.json env (`'settings.json'`):
 * yields `'env:apiKey'` / `'env:authToken'` / `'settings.json:apiKey'` /
 * `'settings.json:authToken'`. Returns `null` when neither key is present.
 *
 * Pure and side-effect free so it is trivially testable.
 */
function pickFromEnv(
  env: Record<string, string | undefined>,
  sourceTag: string,
): PickedCred | null {
  const apiKey = env.ANTHROPIC_API_KEY
  if (apiKey && apiKey.length > 0) {
    const baseURL = env.ANTHROPIC_BASE_URL
    const model = env.ANTHROPIC_DEFAULT_HAIKU_MODEL || env.ANTHROPIC_MODEL
    return {
      apiKey,
      ...(baseURL ? { baseURL } : {}),
      ...(model ? { model } : {}),
      source: `${sourceTag}:apiKey`,
    }
  }
  const authToken = env.ANTHROPIC_AUTH_TOKEN
  if (authToken && authToken.length > 0) {
    const baseURL = env.ANTHROPIC_BASE_URL
    const model = env.ANTHROPIC_DEFAULT_HAIKU_MODEL || env.ANTHROPIC_MODEL
    return {
      apiKey: authToken,
      ...(baseURL ? { baseURL } : {}),
      ...(model ? { model } : {}),
      source: `${sourceTag}:authToken`,
    }
  }
  return null
}

/**
 * Read `~/.claude/settings.json` and return its `env` object as a plain
 * `Record<string,string>` (the shape claude code writes for proxy / model
 * overrides, e.g. `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL` /
 * `ANTHROPIC_DEFAULT_HAIKU_MODEL`).
 *
 * - Missing file -> `{}`.
 * - Missing / non-object `env` -> `{}`.
 * - Non-string values within `env` are silently dropped (only string-string
 *   pairs are kept).
 * - Malformed JSON -> `{}`.
 *
 * Never throws: any read/parse error degrades to `{}` so `loadClaudeCreds`
 * stays non-throwing.
 */
export function loadSettingsEnv(): Record<string, string> {
  const settingsPath = join(resolveHome(), '.claude', 'settings.json')
  if (!existsSync(settingsPath)) return {}
  try {
    const raw = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>
    const env = raw.env
    if (!env || typeof env !== 'object') return {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

/**
 * Load claude code credentials for calling the Anthropic API.
 *
 * 解析顺序（2026-07-30 重排，spec: docs/superpowers/specs/2026-07-30-llm-settings-ui-design.md）：
 *   1. UI 配置（uiConfig 参数，daemon 从 app_settings 表读；token 非空整级短路，
 *      baseURL/model 缺省则不携带 -> 调用方回官方端点 / DISTILL_MODEL）。
 *      source=`'ui'`。
 *   2. `~/.claude/settings.json` 的 env 块（用户主动维护的文件，先于 env）——
 *      同一 apiKey-then-authToken 偏好应用在 settings env 值上。source=
 *      `'settings.json:apiKey'` / `'settings.json:authToken'`。
 *   3. 进程 env（持久 env 残留不得再静默劫持 settings.json —— 2026-07-30 事故）：
 *      `ANTHROPIC_API_KEY`（source=`'env:apiKey'`）或
 *      `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL`（source=`'env:authToken'`）。
 *   4. `~/.claude/.credentials.json`（形状探测，不变）——`apiKeyHelper.apiKey` /
 *      `claudeAiOauth.accessToken` / 顶层 `apiKey`。此处无法推导 baseURL/model，
 *      调用方回退到 `DISTILL_MODEL` 与 SDK 默认 base URL。
 *   5. null - the distiller logs a "configure credentials" message (Task 14).
 *
 * 不抛异常：任何文件读取/解析失败降级到下一级。
 */
export function loadClaudeCreds(uiConfig?: UiLlmConfig | null): ClaudeCreds {
  if (uiConfig?.token) {
    return {
      apiKey: uiConfig.token,
      ...(uiConfig.baseURL ? { baseURL: uiConfig.baseURL } : {}),
      ...(uiConfig.model ? { model: uiConfig.model } : {}),
      source: 'ui',
    }
  }

  const fromSettings = pickFromEnv(loadSettingsEnv(), 'settings.json')
  if (fromSettings) return fromSettings

  const fromProc = pickFromEnv(process.env, 'env')
  if (fromProc) return fromProc

  const credPath = join(resolveHome(), '.claude', '.credentials.json')
  if (existsSync(credPath)) {
    try {
      const raw = JSON.parse(readFileSync(credPath, 'utf-8')) as Record<string, unknown>
      // claude code stores under a few possible shapes
      const helper = raw.apiKeyHelper as Record<string, unknown> | undefined
      if (helper && typeof helper.apiKey === 'string') return { apiKey: helper.apiKey, source: 'credentials.json:apiKeyHelper' }
      const oauth = raw.claudeAiOauth as Record<string, unknown> | undefined
      if (oauth && typeof oauth.accessToken === 'string') return { apiKey: oauth.accessToken, source: 'credentials.json:claudeAiOauth' }
      if (typeof raw.apiKey === 'string') return { apiKey: raw.apiKey, source: 'credentials.json:apiKey' }
    } catch {
      // fall through to null
    }
  }
  return { apiKey: null, source: 'none' }
}

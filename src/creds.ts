import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

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
 * Order of resolution:
 *   1. Process env `ANTHROPIC_API_KEY` (official key; explicit override wins).
 *      If `ANTHROPIC_BASE_URL` is also set it is carried through; `model` is
 *      `ANTHROPIC_DEFAULT_HAIKU_MODEL` || `ANTHROPIC_MODEL` if set.
 *      source=`'env:apiKey'`.
 *   2. Process env `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL` (proxy auth,
 *      e.g. Volcengine Ark). apiKey=token, baseURL carried, model resolved as
 *      above. source=`'env:authToken'`.
 *   3. `~/.claude/settings.json`'s `env` object - the same apiKey-then-authToken
 *      preference applied over the settings env values. source=
 *      `'settings.json:apiKey'` / `'settings.json:authToken'`.
 *   4. `~/.claude/.credentials.json` - claude code stores the key here on most
 *      Windows/Linux installs. The exact shape varies by version, so several
 *      known shapes are tried: `apiKeyHelper.apiKey`, `claudeAiOauth.accessToken`,
 *      and a top-level `apiKey`. No baseURL/model is derivable here, so the
 *      call site falls back to `DISTILL_MODEL` and the SDK default base URL.
 *   5. null - the distiller logs a "configure credentials" message (Task 14).
 *
 * Never throws: malformed files are swallowed and treated as null.
 */
export function loadClaudeCreds(): ClaudeCreds {
  const fromProc = pickFromEnv(process.env, 'env')
  if (fromProc) return fromProc

  const fromSettings = pickFromEnv(loadSettingsEnv(), 'settings.json')
  if (fromSettings) return fromSettings

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

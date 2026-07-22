import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export interface ClaudeCreds {
  apiKey: string | null
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
 * Load claude code credentials for calling the Anthropic API.
 *
 * Order of resolution:
 *   1. `ANTHROPIC_API_KEY` env var (explicit override wins)
 *   2. `~/.claude/.credentials.json` - claude code stores the key here on most
 *      Windows/Linux installs. The exact shape varies by version, so several
 *      known shapes are tried: `apiKeyHelper.apiKey`, `claudeAiOauth.accessToken`,
 *      and a top-level `apiKey`.
 *   3. null - the distiller logs a "configure credentials" message (Task 14).
 *
 * Never throws: a malformed credentials file is swallowed and treated as null.
 */
export function loadClaudeCreds(): ClaudeCreds {
  const env = process.env.ANTHROPIC_API_KEY
  if (env && env.length > 0) return { apiKey: env, source: 'env' }
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

import Anthropic from '@anthropic-ai/sdk'
import { loadClaudeCreds } from './creds'

export interface AnthropicDeps {
  /** Injectable for tests; production uses the real `loadClaudeCreds`. */
  loadClaudeCreds?: () => { apiKey: string | null; source: string }
}

/**
 * Model id for distill calls.
 *
 * Verification debt (Task 17 live-smoke): the reachability of this exact id
 * with the user's credential is not locked by these tests (they mock the SDK).
 * If the id shape is wrong, the unit tests stay green while the live daemon
 * 4xx's. Confirm against `https://docs.anthropic.com/en/docs/about-claude/models`
 * during the Task 17 manual smoke.
 */
export const DISTILL_MODEL = 'claude-haiku-4-5-20251001'

/**
 * Build the `callAnthropic(systemPrompt, userPrompt)` seam the distiller
 * consumes. Production wires the real `@anthropic-ai/sdk` client using
 * `loadClaudeCreds`; tests inject a mock `loadClaudeCreds` (or the daemon /
 * distill tests inject `callAnthropic` directly, bypassing this entirely).
 *
 * Throws if no credential is resolvable - the distiller's top-level try/catch
 * degrades that to "no candidates this round" and records `lastError` on the
 * job, so a misconfigured daemon never crashes the loop.
 */
export function makeCallAnthropic(deps: AnthropicDeps = {}) {
  const load = deps.loadClaudeCreds ?? loadClaudeCreds
  return async function callAnthropic(systemPrompt: string, userPrompt: string): Promise<string> {
    const creds = load()
    if (!creds.apiKey) {
      throw new Error('no claude credentials; run memside with ANTHROPIC_API_KEY or log in to claude code')
    }
    const client = new Anthropic({ apiKey: creds.apiKey })
    const msg = await client.messages.create({
      model: DISTILL_MODEL,
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
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

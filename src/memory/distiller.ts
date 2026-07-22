import { detectErrorSignals, type TranscriptTurn, type MemoryScope, type RuntimeTag } from './pure'

export const DISTILLER_SYSTEM_PROMPT = `You are memside-distiller, an internal subsystem that extracts durable long-term memories from a developer's recent claude code / opencode session.

Your single task: read a batch of recent transcript events (conversation turns, tool failures, user corrections) and emit zero or more candidate long-term memories that future agents should learn from.

Aggressively favor durable BUSINESS and ARCHITECTURE knowledge over fleeting workflow ergonomics. When an event reveals a domain rule, a system invariant, or a design decision with rationale, prefer extracting that over the surface-level chat.

Write a matching category as a "[category:xxx]" prefix on each candidate title:
1. [category:domain-glossary] - concept definitions specific to this product or domain
2. [category:invariant] - hard business rules / constraints that must always hold
3. [category:process] - business workflows, state machines, ordering / dependency constraints
4. [category:architecture] - technical / design decisions WITH rationale ("why" is load-bearing)
5. [category:integration] - external system contracts, SLAs, idempotency / retry conventions
6. [category:compliance] - regulatory / legal constraints
7. [category:data-semantics] - non-obvious meaning of fields, enums, status values
8. [category:anti-pattern] - known failure modes / what NOT to do (from tool failures / user corrections)
9. [category:convention] - stable team / reviewer preferences a future agent should respect
10. [category:quality-bar] - what counts as "done" in this project

Cross-cutting properties:
- atomic and generalizable; survives outside the event that produced it.
- names a clear binding scope: "project" (specific to this codebase) or "global" (any project).
- title 和 bodyMd 用简体中文撰写（[category:xxx] 前缀保持英文不变）；用事后总结的口吻（不要写"今天用户说了 X"，而是"X 是规则"）。
- includes the *why* whenever rationale appears in the event.
- bodyMd at most ~400 characters; title <= 120 chars including the prefix.

REJECT (emit nothing) if the content is a fleeting status update, mood, or one-off acknowledgement.

Respond with ONLY a JSON object: {"candidates":[{"title","bodyMd","scope":"project"|"global","runtime":"claude-code"|"opencode"|null,"distillAction":"new"|"update_of"|"duplicate_of"|"conflict_with"}]}`

export interface DistillCandidate {
  title: string
  bodyMd: string
  scopeType: MemoryScope
  runtime: RuntimeTag
  distillAction: 'new' | 'update_of' | 'duplicate_of' | 'conflict_with'
}

export interface DistillInput {
  turns: TranscriptTurn[]
  runtime: 'claude-code' | 'opencode'
  cwd: string
  /** Injected seam; production wires the real Anthropic call, tests pass a mock. */
  callAnthropic: (systemPrompt: string, userPrompt: string) => Promise<string>
}

function renderUserPrompt(
  turns: TranscriptTurn[],
  runtime: string,
  cwd: string,
  signals: ReturnType<typeof detectErrorSignals>,
): string {
  const transcript = turns.map((t) => `[${t.role}] ${t.content}`).join('\n')
  return `Runtime: ${runtime}\nCwd: ${cwd}\nError signals detected: ${JSON.stringify(signals)}\n\nTranscript:\n${transcript}\n\nExtract candidate memories as JSON per the system instructions.`
}

export async function distillTranscript(input: DistillInput): Promise<DistillCandidate[]> {
  try {
    const signals = detectErrorSignals(input.turns)
    const userPrompt = renderUserPrompt(input.turns, input.runtime, input.cwd, signals)
    const raw = await input.callAnthropic(DISTILLER_SYSTEM_PROMPT, userPrompt)
    const parsed = JSON.parse(raw) as { candidates?: unknown }
    if (!parsed || !Array.isArray(parsed.candidates)) return []
    const out: DistillCandidate[] = []
    for (const c of parsed.candidates) {
      if (!c || typeof c !== 'object') continue
      const o = c as Record<string, unknown>
      if (typeof o.title !== 'string' || typeof o.bodyMd !== 'string') continue
      if (!o.title.includes('[category:')) continue
      const scope = o.scope === 'global' ? 'global' : 'project'
      const rt = o.runtime === 'claude-code' || o.runtime === 'opencode' ? o.runtime : null
      const action =
        o.distillAction === 'update_of' ||
        o.distillAction === 'duplicate_of' ||
        o.distillAction === 'conflict_with'
          ? o.distillAction
          : 'new'
      out.push({
        title: o.title,
        bodyMd: o.bodyMd,
        scopeType: scope,
        runtime: rt as RuntimeTag,
        distillAction: action,
      })
    }
    return out
  } catch {
    // Never throw: distill failures degrade to "no candidates this round".
    return []
  }
}

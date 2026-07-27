import { detectErrorSignals, filterTranscriptForDistill, type TranscriptTurn, type MemoryScope, type RuntimeTag } from './pure'
import type { LLMCall } from '@/llm'
import { callWithRetry } from './retry'

export const DISTILLER_SYSTEM_PROMPT = `You are memside-distiller, an internal subsystem that extracts durable long-term memories from a developer's recent claude code / opencode session.

Your single task: read a batch of recent transcript events (conversation turns, tool failures, user corrections) and emit zero or more candidate long-term memories that future agents should learn from.

Aggressively favor durable BUSINESS and ARCHITECTURE knowledge over fleeting workflow ergonomics. When an event reveals a domain rule, a system invariant, or a design decision with rationale, prefer extracting that over the surface-level chat.

Write a matching category as a "[category:xxx]" prefix on each candidate title:
1. [category:domain-glossary] - concept definitions specific to this product or domain
2. [category:invariant] - hard business rules about the user's DOMAIN (NOT about this codebase's own implementation) that must always hold
3. [category:process] - business workflows, state machines, ordering / dependency constraints
4. [category:architecture] - technical / design decisions WITH rationale ("why" is load-bearing)
5. [category:integration] - external system contracts, SLAs, idempotency / retry conventions
6. [category:compliance] - regulatory / legal constraints
7. [category:data-semantics] - non-obvious meaning of fields, enums, status values
8. [category:anti-pattern] - known failure modes / what NOT to do (from tool failures / user corrections)
9. [category:convention] - stable team / reviewer preferences a future agent should respect
10. [category:quality-bar] - what counts as "done" in this project

对每条候选标记 subject：
- codebase = 这条规则描述的是当前仓库自身的代码、配置、模块行为或实现逻辑。
  判据：规则的主语是仓库内的具体组件/符号/流程（如 valueFilter、daemon、scheduler、
  某个函数的调用约定）。脱离这个仓库，规则就失去所指对象。
- domain = 这条规则描述的是仓库之外的东西：用户的业务规则、外部系统契约、法规约束、
  跨项目的领域知识。判据：换一个仓库这条规则依然成立、依然有意义。

拿不准时标 codebase。

Cross-cutting properties:
- atomic and generalizable; survives outside the event that produced it.
- names a clear binding scope: "project" (specific to this codebase) or "global" (any project).
- title 和 bodyMd 用简体中文撰写（[category:xxx] 前缀保持英文不变）；用事后总结的口吻（不要写"今天用户说了 X"，而是"X 是规则"）。
- includes the *why* whenever rationale appears in the event.
- bodyMd at most ~400 characters; title <= 120 chars including the prefix.

REJECT (emit nothing) if the content is a fleeting status update, mood, or one-off acknowledgement.
Also REJECT 被开发仓库自身源码的实现细节（文件内容、内部实现、配置默认值、符号名）--这些可从仓库源码重新推导，不是持久记忆。把记忆锚定到用户或领域明确陈述的规则、决策与约束；不要总结 agent 读到的文件内容。

输出格式如下（仅示范结构，勿照抄内容；只输出这一个 JSON 对象，不要 markdown 围栏，不要在 JSON 前后加任何解释文字，键与字符串值用双引号，最后一个属性后无逗号，不要用单引号）：
{
  "candidates": [
    {
      "title": "[category:convention] 每个 PR 必须在 CHANGELOG.md 的 Unreleased 部分加一条",
      "bodyMd": "项目约定：PR 合并前需在 CHANGELOG.md 的 Unreleased 段落补充变更条目。",
      "scope": "project",
      "runtime": "claude-code",
      "distillAction": "new",
      "subject": "codebase"
    }
  ]
}`

export interface DistillCandidate {
  title: string
  bodyMd: string
  scopeType: MemoryScope
  runtime: RuntimeTag
  distillAction: 'new' | 'update_of' | 'duplicate_of' | 'conflict_with'
  /** 瞬态：规则对象是当前仓库自身代码(codebase) 还是外部业务领域(domain)。
   *  valueFilter 条件门据此决定是否强制保留 protected category。不入库。
   *  distiller 漏标/非法时默认 'codebase'（精度优先：不保护）。 */
  subject: 'codebase' | 'domain'
}

export interface DistillInput {
  turns: TranscriptTurn[]
  runtime: 'claude-code' | 'opencode'
  cwd: string
  /** Injected seam; production wires the real Anthropic call, tests pass a mock. */
  callLLM: LLMCall
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

/**
 * Validate parsed distill output for retry-worthiness. Returns an error message
 * to trigger a retry, or null to accept. Checks: parsed is an object with a
 * `candidates` array, each candidate has string title/bodyMd, and each title
 * carries a `[category:` prefix. Exhausted retries fall through to the existing
 * per-candidate `continue` drop logic, so a missing prefix is still tolerated.
 */
function distillShouldRetry(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== 'object') return '返回的不是 JSON 对象'
  const p = parsed as { candidates?: unknown }
  if (!Array.isArray(p.candidates)) return '缺少 candidates 数组'
  for (let i = 0; i < p.candidates.length; i++) {
    const c = p.candidates[i] as Record<string, unknown> | null
    if (!c || typeof c.title !== 'string' || typeof c.bodyMd !== 'string') {
      return `候选 ${i} 缺少 title 或 bodyMd`
    }
    if (!c.title.includes('[category:')) {
      return `候选 ${i} 的 title 缺少 [category:xxx] 前缀`
    }
    const subj = (c as { subject?: unknown }).subject
    if (subj !== undefined && subj !== 'codebase' && subj !== 'domain') {
      return `候选 ${i} 的 subject 非法（必须是 codebase 或 domain）`
    }
  }
  return null
}

export async function distillTranscript(input: DistillInput): Promise<DistillCandidate[]> {
  try {
    const signals = detectErrorSignals(input.turns)
    const filtered = filterTranscriptForDistill(input.turns)
    const userPrompt = renderUserPrompt(filtered, input.runtime, input.cwd, signals)
    const parsed = await callWithRetry({
      call: input.callLLM,
      system: DISTILLER_SYSTEM_PROMPT,
      user: userPrompt,
      shouldRetry: distillShouldRetry,
    }) as { candidates?: unknown } | undefined
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
      const rawSubject = o.subject
      const subject: 'codebase' | 'domain' =
        rawSubject === 'domain' ? 'domain' : 'codebase'
      out.push({
        title: o.title,
        bodyMd: o.bodyMd,
        scopeType: scope,
        runtime: rt as RuntimeTag,
        distillAction: action,
        subject,
      })
    }
    return out
  } catch {
    // Never throw: distill failures degrade to "no candidates this round".
    return []
  }
}

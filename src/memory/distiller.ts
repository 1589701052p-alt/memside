import { detectErrorSignals, filterTranscriptForDistill, normalizeSubjectSlug, type TranscriptTurn, type MemoryScope, type RuntimeTag } from './pure'
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

对每条候选标记 ruleObject：
- codebase = 这条规则描述的是当前仓库自身的代码、配置、模块行为或实现逻辑。
  判据：规则的主语是仓库内的具体组件/符号/流程（如 valueFilter、daemon、scheduler、
  某个函数的调用约定）。脱离这个仓库，规则就失去所指对象。
- domain = 这条规则描述的是仓库之外的东西：用户的业务规则、外部系统契约、法规约束、
  跨项目的领域知识。判据：换一个仓库这条规则依然成立、依然有意义。

拿不准时标 codebase。

判定时问自己：这条规则的主语，是这个仓库里能 grep 到的具体东西（文件、函数、配置项、模块名、某个常量值），还是一个仓库之外的业务/领域概念？
- 如果主语是仓库内的具体东西，即使规则本身听起来像"通用经验"，它也是 codebase--因为脱离这个仓库它就失去所指对象，或可从源码重新读出。
- 如果主语是仓库外的业务/领域概念（用户业务规则、外部系统契约、法规、跨项目共识），且换一个仓库依然成立，才是 domain。

通用示例（仅示判定模式，勿照抄内容）：
  codebase: "X 模块的 Y 函数以 Z 方式调用" -- 主语是仓库内符号
  codebase: "本项目把 W 配置为值 V" -- 主语是仓库内配置项
  codebase: "A 组件的 B 行为在 C 条件下触发" -- 主语是仓库内组件
  domain: "用户业务的退款须在发货后 N 天内" -- 主语是外部业务规则
  domain: "外部系统 X 的 SLA 要求 Y" -- 主语是仓库外契约
  domain: "法规要求 Z" -- 主语是仓库外法规

对每条候选标记 subjectSlug：这条记忆的主题标识（kebab-case，2~4 个英文小写
单词，如 refund-policy、hook-install）。同一主题的记忆必须共用同一个 slug--
优先从 user prompt 的 "Existing subject slugs" 清单里复用；只有确实是清单
没有的新主题才造新 slug。拿不准主题可以不输出该字段。

Cross-cutting properties:
- atomic and generalizable; survives outside the event that produced it.
- names a clear binding scope: "project" (specific to this codebase) or "global" (any project).
- title 和 bodyMd 用简体中文撰写（[category:xxx] 前缀保持英文不变）；用事后总结的口吻（不要写"今天用户说了 X"，而是"X 是规则"）。
- includes the *why* whenever rationale appears in the event.
- bodyMd at most ~400 characters; title <= 120 chars including the prefix.

Origin discipline（[stated] 起源判定）：记用户或领域在会话中明确陈述的持久事实、规则、决策与约束；也记 agent 在 transcript 中明确给出、且被用户采纳的设计 rationale（"为什么"是承重的）。REJECT (emit nothing) 以下内容--它们不该当作记忆：
1. 你自己推出的结论或推断（用户没明说，是你脑补的因果、意图或规律）--脑补闸门，必须 REJECT。
2. 前瞻状态、待办、下一步计划（"以后要 X"、"接下来做 Y"）--意图、非已成事实，会过期。
3. 研究输出：搜索结果、文档摘录（纯信息搬运，非设计 rationale）。
4. 对用户原话的丰富化或升级（用户说"用 bun"，你写成"用户强烈推崇 bun 生态"）。
5. 道听途说（"听说 X"、"人们说 Y"），非用户直接陈述。
6. agent 自言自语的推理过程（未经用户采纳的散漫推理）；但 agent 给出且被用户采纳的设计 rationale 可记。
硬约束：记 rationale 时必须能在所给 transcript 中找到 agent 原话出处；找不到出处的不记（防止脑补）。

REJECT fleeting status updates, moods, one-off acknowledgements.
Also REJECT 被开发仓库自身源码的实现细节（文件内容、内部实现、配置默认值、符号名）--这些可从仓库源码重新推导，不是持久记忆。不要总结 agent 读到的文件内容。

输出格式如下（仅示范结构，勿照抄内容；只输出这一个 JSON 对象，不要 markdown 围栏，不要在 JSON 前后加任何解释文字，键与字符串值用双引号，最后一个属性后无逗号，不要用单引号）：
{
  "candidates": [
    {
      "title": "[category:convention] 每个 PR 必须在 CHANGELOG.md 的 Unreleased 部分加一条",
      "bodyMd": "项目约定：PR 合并前需在 CHANGELOG.md 的 Unreleased 段落补充变更条目。",
      "scope": "project",
      "runtime": "claude-code",
      "distillAction": "new",
      "ruleObject": "codebase",
      "subjectSlug": "refund-policy"
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
  ruleObject: 'codebase' | 'domain'
  /** 主题归组键（spec §4.3）。LLM 漏标/非法时 normalizeSubjectSlug 降级为 null。 */
  subjectSlug: string | null
}

export interface DistillInput {
  turns: TranscriptTurn[]
  runtime: 'claude-code' | 'opencode'
  cwd: string
  /** 该 scope 现有 slug 清单（scheduler 查询注入），prompt 附给模型促复用（spec D3）。 */
  existingSlugs: string[]
  /** Injected seam; production wires the real Anthropic call, tests pass a mock. */
  callLLM: LLMCall
}

export interface DistillResult {
  candidates: DistillCandidate[]
  filteredTurns: TranscriptTurn[]   // 实际喂给模型的过滤版，零偏差快照源
}

function renderUserPrompt(
  turns: TranscriptTurn[],
  runtime: string,
  cwd: string,
  signals: ReturnType<typeof detectErrorSignals>,
  existingSlugs: string[],
): string {
  const transcript = turns.map((t) => `[${t.role}] ${t.content}`).join('\n')
  const slugs = existingSlugs.length > 0 ? existingSlugs.join(', ') : '(none)'
  return `Runtime: ${runtime}\nCwd: ${cwd}\nError signals detected: ${JSON.stringify(signals)}\nExisting subject slugs (reuse these when a candidate matches an existing subject): ${slugs}\n\nTranscript:\n${transcript}\n\nExtract candidate memories as JSON per the system instructions.`
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
    const subj = (c as { ruleObject?: unknown }).ruleObject
    if (subj !== undefined && subj !== 'codebase' && subj !== 'domain') {
      return `候选 ${i} 的 ruleObject 非法（必须是 codebase 或 domain）`
    }
    const slug = (c as { subjectSlug?: unknown }).subjectSlug
    if (slug !== undefined && typeof slug !== 'string') {
      return `候选 ${i} 的 subjectSlug 必须是字符串`
    }
  }
  return null
}

export async function distillTranscript(input: DistillInput): Promise<DistillResult> {
  try {
    const signals = detectErrorSignals(input.turns)
    const filtered = filterTranscriptForDistill(input.turns)
    const userPrompt = renderUserPrompt(filtered, input.runtime, input.cwd, signals, input.existingSlugs)
    // callWithRetry swallows callLLM throws (returns undefined after exhausting
    // retries). Track whether the underlying call threw so the !parsed branch can
    // distinguish "API failure" (can't trust what was sent -> empty filteredTurns,
    // matching the catch() degrade contract) from "model returned unparseable
    // output" (turns WERE sent -> return filtered snapshot).
    let callThrew = false
    const wrappedCall: LLMCall = async (sys, user, opts) => {
      try {
        return await input.callLLM(sys, user, opts)
      } catch (e) {
        callThrew = true
        throw e
      }
    }
    const parsed = await callWithRetry({
      call: wrappedCall,
      system: DISTILLER_SYSTEM_PROMPT,
      user: userPrompt,
      shouldRetry: distillShouldRetry,
    }) as { candidates?: unknown } | undefined
    if (!parsed || !Array.isArray(parsed.candidates)) return { candidates: [], filteredTurns: callThrew ? [] : filtered }
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
      const rawSubject = o.ruleObject
      const ruleObject: 'codebase' | 'domain' =
        rawSubject === 'domain' ? 'domain' : 'codebase'
      out.push({
        title: o.title,
        bodyMd: o.bodyMd,
        scopeType: scope,
        runtime: rt as RuntimeTag,
        distillAction: action,
        ruleObject,
        subjectSlug: normalizeSubjectSlug(o.subjectSlug),
      })
    }
    return { candidates: out, filteredTurns: filtered }
  } catch {
    // Never throw: distill failures degrade to "no candidates this round".
    return { candidates: [], filteredTurns: [] }
  }
}

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

对每条候选标记 subjectSlug：这条记忆的主题标识（kebab-case，2~4 个英文小写
单词，如 refund-policy、hook-install）。同一主题的记忆必须共用同一个 slug--
优先从 user prompt 的 "Existing subject slugs" 清单里复用；只有确实是清单
没有的新主题才造新 slug。拿不准主题可以不输出该字段。

对每条候选标记 origin（出处）：
- user-stated = 用户原话明确说出的规则、决策、约束、偏好。
- user-confirmed = agent 提出、用户明确采纳（"对"/"就这么办"/"可以"）。
- agent-observed = 其余一切（agent 从工具报错/代码阅读/事件自行总结）。

每条候选必须带 evidence：从 transcript 摘抄的出处原句（不超过 1 句；user-confirmed
摘 agent 提议句 + 用户采纳句；agent-observed 摘观察依据的对话片段）。
硬约束：找不到原话出处，就不许标 user-stated / user-confirmed，只能标 agent-observed。

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
不要复述 agent 读到的文件内容或符号细节（那些翻翻代码就能重新知道，不算记忆）。
但用户亲口陈述的关于本仓库的规则、决策、约束、偏好必须记--用户说过就是价值，
与它在代码里能否看到无关。

输出格式如下（仅示范结构，勿照抄内容；只输出这一个 JSON 对象，不要 markdown 围栏，不要在 JSON 前后加任何解释文字，键与字符串值用双引号，最后一个属性后无逗号，不要用单引号）：
{
  "candidates": [
    {
      "title": "[category:convention] 每个 PR 必须在 CHANGELOG.md 的 Unreleased 部分加一条",
      "bodyMd": "项目约定：PR 合并前需在 CHANGELOG.md 的 Unreleased 段落补充变更条目。",
      "scope": "project",
      "runtime": "claude-code",
      "distillAction": "new",
      "origin": "user-stated",
      "evidence": "每个 PR 必须在 CHANGELOG.md 的 Unreleased 部分加一条",
      "subjectSlug": "refund-policy"
    }
  ]
}`

/**
 * subagent 蒸馏专用警示段(spec §4.2):追加在 user prompt 末尾。role:user 是主 agent
 * 派发的任务工单,其中一次性任务约束(改哪些文件/验收标准)任务结束即失效,不得产记忆。
 * 只动 user prompt,系统 prompt 一字不动。
 */
export const SUBAGENT_BRIEF_NOTE = `\n\n注意:本 transcript 来自 subagent。其中 role:user 的发言是主 agent 派发的任务工单,不是真人陈述。工单中只针对本次任务的约束(允许修改哪些文件、做到什么程度、验收标准)在任务结束时即失效,不得提取为候选记忆;只有跨会话持续成立的规则、决策、踩坑才可提取。`

export type DistillOrigin = 'user-stated' | 'user-confirmed' | 'agent-observed'

export interface DistillCandidate {
  title: string
  bodyMd: string
  scopeType: MemoryScope
  runtime: RuntimeTag
  distillAction: 'new' | 'update_of' | 'duplicate_of' | 'conflict_with'
  /** 出处（spec §R1）。LLM 漏标/非法 -> 'agent-observed'（精度优先：不保护）。 */
  origin: DistillOrigin
  /** 出处原句摘抄。stated/confirmed 但 evidence 空 -> origin 降级 agent-observed（贴金防护）。 */
  evidence: string | null
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
  /** 来源类型。subagent -> 候选 origin 强制降级 agent-observed；可选，默认 'conversation'（spec §3.1）。 */
  sourceKind?: 'subagent' | 'conversation'
}

export interface DistillResult {
  candidates: DistillCandidate[]
  filteredTurns: TranscriptTurn[]
  /** LLM 原始解析输出（candidates 数组原样，含被格式校验丢弃的）。无候选/跳过/报错时为 null。 */
  rawOutput: unknown | null
  /** LLM 返回的原始候选数（含格式不合格被丢的）。 */
  rawCount: number
  /** 底层 LLM 调用是否抛错（scheduler 据此判 llm_error vs empty_output）。 */
  callThrew: boolean
  /** LLM 调用错误描述（最后一次 attempt 的错误 message）。仅 llm_error 时非 null；
   *  produced/empty_output/skipped 时 null。retry-success 时 null（错误被成功覆盖）。 */
  errorMessage: string | null
}

function renderUserPrompt(
  turns: TranscriptTurn[],
  runtime: string,
  cwd: string,
  signals: ReturnType<typeof detectErrorSignals>,
  existingSlugs: string[],
  sourceKind?: 'subagent' | 'conversation',
): string {
  const transcript = turns.map((t) => `[${t.role}] ${t.content}`).join('\n')
  const slugs = existingSlugs.length > 0 ? existingSlugs.join(', ') : '(none)'
  const base = `Runtime: ${runtime}\nCwd: ${cwd}\nError signals detected: ${JSON.stringify(signals)}\nExisting subject slugs (reuse these when a candidate matches an existing subject): ${slugs}\n\nTranscript:\n${transcript}\n\nExtract candidate memories as JSON per the system instructions.`
  return sourceKind === 'subagent' ? base + SUBAGENT_BRIEF_NOTE : base
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
    const slug = (c as { subjectSlug?: unknown }).subjectSlug
    if (slug !== undefined && typeof slug !== 'string') {
      return `候选 ${i} 的 subjectSlug 必须是字符串`
    }
    const og = (c as { origin?: unknown }).origin
    if (og !== undefined && og !== 'user-stated' && og !== 'user-confirmed' && og !== 'agent-observed') {
      return `候选 ${i} 的 origin 非法（必须是 user-stated/user-confirmed/agent-observed）`
    }
  }
  return null
}

export async function distillTranscript(input: DistillInput): Promise<DistillResult> {
  try {
    const signals = detectErrorSignals(input.turns)
    const filtered = filterTranscriptForDistill(input.turns)
    const userPrompt = renderUserPrompt(filtered, input.runtime, input.cwd, signals, input.existingSlugs, input.sourceKind)
    // callWithRetry swallows callLLM throws (returns undefined after exhausting
    // retries). callThrew tracks whether the underlying call threw, for two uses:
    // (a) errorMessage 取值（callThrew ? lastErrorMessage : null）,
    // (b) scheduler 分类 llm_error vs empty_output.
    // filteredTurns 已与调用成败解耦（恒为过滤快照，见下方注释）。
    let callThrew = false
    let lastErrorMessage: string | null = null
    const wrappedCall: LLMCall = async (sys, user, opts) => {
      // reset per attempt: a prior failed attempt must not stain a later success.
      // callWithRetry re-invokes wrappedCall on throw; without this reset, an
      // attempt-0 throw (callThrew=true) would persist even after attempt-1
      // succeeds, misclassifying a produced result as llm_error (spec §4).
      callThrew = false
      try {
        return await input.callLLM(sys, user, opts)
      } catch (e) {
        callThrew = true
        lastErrorMessage = e instanceof Error ? e.message : String(e)
        throw e
      }
    }
    const parsed = await callWithRetry({
      call: wrappedCall,
      system: DISTILLER_SYSTEM_PROMPT,
      user: userPrompt,
      shouldRetry: distillShouldRetry,
    }) as { candidates?: unknown } | undefined
    const rawOutput: unknown = parsed ?? null
    if (!parsed || !Array.isArray(parsed.candidates)) {
      // filteredTurns 恒为过滤快照（调用前已算出，与调用成败无关）。
      // 历史 bug 曾在 callThrew 时清空 -> llm_error job 丢失 source input（spec §source input 修复）。
      return { candidates: [], filteredTurns: filtered, rawOutput, rawCount: 0, callThrew,
        errorMessage: callThrew ? lastErrorMessage : null }
    }
    const rawCount = parsed.candidates.length
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
      const rawOrigin = o.origin
      let origin: DistillOrigin =
        rawOrigin === 'user-stated' || rawOrigin === 'user-confirmed' ? rawOrigin : 'agent-observed'
      const evidence =
        typeof o.evidence === 'string' && o.evidence.trim() ? o.evidence.trim() : null
      // 贴金防护（spec §R1）：摘不出原话就不许戴 user-stated/user-confirmed 的帽子。
      if (origin !== 'agent-observed' && evidence === null) origin = 'agent-observed'
      // subagent 降级（spec §3.2）：subagent 的 role:user 是主 agent 派发的 task brief，
      // 非真人陈述。强制 agent-observed，不享受 stated 免疫。evidence 保留作观察依据。
      if (input.sourceKind === 'subagent') origin = 'agent-observed'
      out.push({
        title: o.title,
        bodyMd: o.bodyMd,
        scopeType: scope,
        runtime: rt as RuntimeTag,
        distillAction: action,
        origin,
        evidence,
        subjectSlug: normalizeSubjectSlug(o.subjectSlug),
      })
    }
    return { candidates: out, filteredTurns: filtered, rawOutput, rawCount, callThrew, errorMessage: null }
  } catch (e) {
    // Never throw: distill failures degrade to "no candidates this round".
    // 顶层兜底（detectErrorSignals/filterTranscriptForDistill 等纯函数抛错时），
    // 不可达路径，errorMessage 仍透出异常 message 供诊断。
    return { candidates: [], filteredTurns: [], rawOutput: null, rawCount: 0, callThrew: true,
      errorMessage: e instanceof Error ? e.message : String(e) }
  }
}

import { detectErrorSignals, filterTranscriptForDistill, normalizeSubjectSlug, type TranscriptTurn, type MemoryScope, type RuntimeTag } from './pure'
import type { LLMCall } from '@/llm'
import { runLlmSession, type RoundRecord } from './llmSession'

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

[thinking] 标签说明：[thinking] 是 agent 未对用户展示的内部推理。它可以作为 rationale 的「原话出处」证据（evidence 可摘 thinking 原文）；但仅在 thinking 中出现、未在对话浮现也未被用户采纳的推理，仍按上面的 Origin discipline 不得提取为候选。

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
  /** 前文 digest（spec §4.6）。null/空串 = 无背景节（向后兼容）。 */
  priorContext?: string | null
  /** 已审批记忆标题清单（上限 100 条由调用方保证）。空数组 = 无该节。 */
  approvedTitles?: string[]
  /**
   * Task 7 断点续跑接线（spec 2026-08-18 §5）：传 loadHistory 即走「带历史接续」
   * 模式——每次调用只跑一轮新回合（maxAttempts = history.length + 1），由 scheduler
   * 的 tick 逐轮驱动；persistRound 把每轮对话落 memory_distill_events。缺省（测试/
   * 独立调用）为无记忆的 3 轮。
   */
  jobId?: string
  persistRound?: (r: RoundRecord) => Promise<void>
  loadHistory?: () => Promise<RoundRecord[]>
}

export interface DistillResult {
  candidates: DistillCandidate[]
  filteredTurns: TranscriptTurn[]
  /** LLM 原始解析输出（candidates 数组原样，含被格式校验丢弃的）。无候选/跳过/报错时为 null。 */
  rawOutput: unknown | null
  /** LLM 返回的原始候选数（含格式不合格被丢的）。 */
  rawCount: number
  /**
   * Task 7：session 失败标识（runLlmSession ok:false，重试轮耗尽）。scheduler 据此
   * 走 step 失败分支（回 pending 退避 / 3 次暂停 + 通知），绝不把失败当「0 候选」
   * 业务结果吞掉（spec P1）。
   */
  sessionFailed: boolean
  /** session 失败原因列表（每轮一条，前缀 aborted/format/incomplete）。 */
  reasons: string[]
  /** 旧失败分类字段（向后兼容保留，由 reasons 推导）：末轮为 aborted 时 true。 */
  callThrew: boolean
  /** 末次 aborted 轮的错误描述（剥前缀）。仅 sessionFailed 且末轮 aborted 时非 null。 */
  errorMessage: string | null
  /** 非 aborted 的失败原因汇总。仅 sessionFailed 且末轮非 aborted 时非 null。 */
  parseError: string | null
  /** 兼容字段：原始输出文本现落 llm_round 历史（saveLlmRound），此处恒 null。 */
  lastRawText: string | null
}

function renderUserPrompt(
  turns: TranscriptTurn[],
  runtime: string,
  cwd: string,
  signals: ReturnType<typeof detectErrorSignals>,
  existingSlugs: string[],
  sourceKind?: 'subagent' | 'conversation',
  priorContext?: string | null,
  approvedTitles?: string[],
): string {
  const transcript = turns
    .map((t) => {
      if (t.role !== 'tool') return `[${t.role}] ${t.content}`
      const label = t.toolName ? `[tool:${t.toolName}]` : '[tool]'
      return t.toolCall ? `${label} 调用: ${t.toolCall}\n结果: ${t.content}` : `${label} ${t.content}`
    })
    .join('\n')
  const slugs = existingSlugs.length > 0 ? existingSlugs.join(', ') : '(none)'
  const sections: string[] = []
  // 空节整节省略：两字段均空时输出与旧 prompt 逐字节一致（spec §4.6 向后兼容锁）。
  if (priorContext && priorContext.trim()) {
    sections.push(`## 背景（仅供理解上下文，禁止从中提炼）\n${priorContext}\n\n`)
  }
  if (approvedTitles && approvedTitles.length > 0) {
    sections.push(`## 已记录的记忆标题（禁止重复提炼）\n${approvedTitles.map((s) => `- ${s}`).join('\n')}\n\n`)
  }
  const base = `${sections.join('')}Runtime: ${runtime}\nCwd: ${cwd}\nError signals detected: ${JSON.stringify(signals)}\nExisting subject slugs (reuse these when a candidate matches an existing subject): ${slugs}\n\nTranscript:\n${transcript}\n\nExtract candidate memories as JSON per the system instructions.`
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

/**
 * 解析 + 规范化 distill 产出（Task 7 从 distillTranscript 抽出）：parsed 形状不对
 * 返回 null；合法时逐条规范化（origin/evidence 贴金防护、subjectSlug 降级等，
 * 语义与旧内联实现逐字一致）。
 */
function parseDistillCandidates(parsed: unknown, sourceKind?: 'subagent' | 'conversation'): { candidates: DistillCandidate[]; rawCount: number } | null {
  if (!parsed || typeof parsed !== 'object') return null
  const p = parsed as { candidates?: unknown }
  if (!Array.isArray(p.candidates)) return null
  const rawCount = p.candidates.length
  const out: DistillCandidate[] = []
  for (const c of p.candidates) {
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
    if (sourceKind === 'subagent') origin = 'agent-observed'
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
  return { candidates: out, rawCount }
}

export async function distillTranscript(input: DistillInput): Promise<DistillResult> {
  try {
    const signals = detectErrorSignals(input.turns)
    const filtered = filterTranscriptForDistill(input.turns)
    const userPrompt = renderUserPrompt(filtered, input.runtime, input.cwd, signals, input.existingSlugs, input.sourceKind, input.priorContext, input.approvedTitles)
    // filteredTurns 恒为过滤快照（调用前已算出，与调用成败无关——既有不变量）。
    // Task 7：蒸馏步走可接续执行器（runLlmSession）。传 loadHistory = 断点续跑模式
    // （单次只跑一轮新回合，历史/落盘由 scheduler 经 memory_distill_events 驱动）；
    // 缺省 = 无记忆 3 轮（独立调用/旧测试语义）。
    const history = input.loadHistory ? await input.loadHistory() : []
    const session = await runLlmSession({
      callLLM: input.callLLM,
      system: DISTILLER_SYSTEM_PROMPT,
      initialUser: userPrompt,
      step: 'distill',
      jobId: input.jobId ?? '',
      persistRound: input.persistRound,
      shouldRetry: distillShouldRetry,
      ...(input.loadHistory
        ? { loadHistory: async () => history, maxAttempts: history.length + 1 }
        : {}),
    })
    if (!session.ok) {
      // 执行器重试耗尽：失败就是失败（P1），绝不吞成「0 候选」业务结果。
      // callThrew/parseError 由 reasons 推导（末轮 aborted → callThrew）。
      const lastReason = session.reasons[session.reasons.length - 1] ?? 'aborted:'
      const callThrew = lastReason.startsWith('aborted')
      return {
        candidates: [], filteredTurns: filtered, rawOutput: null, rawCount: 0,
        sessionFailed: true, reasons: session.reasons,
        callThrew,
        errorMessage: callThrew ? lastReason.replace(/^aborted:/, '') : null,
        parseError: callThrew ? null : (session.reasons.join('；') || '解析失败：无错误描述'),
        lastRawText: null,
      }
    }
    const rawOutput: unknown = session.parsed
    const parsedRes = parseDistillCandidates(session.parsed, input.sourceKind)
    if (!parsedRes) {
      // 空字符串/纯空白 = 模型无产出（与 {"candidates":[]} 同义），归 empty_output 非
      // parse_error——session ok 意味着末轮 parse+shouldRetry 已通过（合法 JSON 且有
      // candidates 数组），此分支仅防御形状突变（不可达路径）。
      return { candidates: [], filteredTurns: filtered, rawOutput, rawCount: 0,
        sessionFailed: false, reasons: [], callThrew: false, errorMessage: null,
        parseError: null, lastRawText: null }
    }
    return { candidates: parsedRes.candidates, filteredTurns: filtered, rawOutput, rawCount: parsedRes.rawCount,
      sessionFailed: false, reasons: [], callThrew: false, errorMessage: null,
      parseError: null, lastRawText: null }
  } catch (e) {
    // Never throw: 顶层兜底（detectErrorSignals/filterTranscriptForDistill 等纯函数抛错时），
    // 不可达路径，转成 session 失败标识让 scheduler 走 step 失败分支（不再吞成 done）。
    const msg = e instanceof Error ? e.message : String(e)
    return { candidates: [], filteredTurns: [], rawOutput: null, rawCount: 0,
      sessionFailed: true, reasons: [`aborted:${msg}`], callThrew: true,
      errorMessage: msg, parseError: null, lastRawText: null }
  }
}

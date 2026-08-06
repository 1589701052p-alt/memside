// src/memory/agentJudge.ts
import type { DistillCandidate } from '@/memory/distiller'
import type { LLMCall } from '@/llm'
import { runAgentLoop, type AgentStep } from './agentLoop'
import { makeRepoTools, type RepoTools } from './repoTools'
import {
  VALUE_JUDGE_HEADER, VALUE_JUDGE_RULES, AGENT_VALID_CATEGORIES,
  verdictsFromCategories, detectTaming, type ValueVerdict,
} from './valueFilter'

// agent 模式协议段:第 10 类 duplicate + 工具使用说明 + 每轮单 JSON 协议。
// 头+规则段与单发判定器逐字共享(VALUE_JUDGE_HEADER/RULES),避免两份规则文本漂移。
const AGENT_PROTOCOL_SECTION = `
10. duplicate - TEST: is this entry already covered by an existing approved memory
   (titles listed in the user message)? Same rule or fact, even if worded differently.
   Unlike derivable, duplicate MAY be assigned to user-stated/user-confirmed candidates:
   a user restating an already-approved rule is still a duplicate.

你可以使用三个只读工具亲手查验项目仓库(根目录见用户消息)再下判决。derivable 判定
应以亲手查验为准,不要凭猜。已审批记忆标题清单用于判 duplicate(语义重复即可,
不要求逐字相同);若两条候选或候选与清单互相矛盾,以更新、更持久的为准,被取代方判
fleeting。来源为 subagent 的候选:其 user 发言是任务工单,重点核对是否一次性任务约束。

每轮必须且只能输出一个 JSON 对象(无 markdown 围栏,无解释文字),二选一:
{"tool": "grep", "args": {"pattern": "要搜的文本", "path": "可选子路径"}}
{"tool": "read", "args": {"path": "文件路径", "startLine": 1, "endLine": 200}}
{"tool": "list", "args": {"path": "可选目录路径"}}
{"final": {"verdicts": [{"index": 0, "category": "decision"}, ...]}}
final 必须给每条候选一个 verdict(按输入 index);工具结果会以 [工具结果] 形式回给你。`

export const AGENT_JUDGE_SYSTEM_PROMPT = VALUE_JUDGE_HEADER + VALUE_JUDGE_RULES + AGENT_PROTOCOL_SECTION

export interface AgentJudgeOpts {
  callLLM: LLMCall
  /** 项目根目录;null = 无仓库可读(工具全部返回错误文本,agent 仍可凭材料判)。 */
  rootDir: string | null
  /** 同 scope(project ∪ global)已审批记忆标题清单(判 duplicate/矛盾用)。 */
  approvedTitles: string[]
  sourceKind: 'conversation' | 'subagent'
  maxRounds: number
  timeBudgetMs: number
}

export interface AgentJudgeResult {
  verdicts: ValueVerdict[]
  trace: AgentStep[]
}

const AGENT_DISCARD_CATEGORIES: ReadonlySet<string> = new Set(['public-knowledge', 'derivable', 'fleeting', 'duplicate'])

function renderAgentUserPrompt(candidates: DistillCandidate[], opts: AgentJudgeOpts): string {
  const cs = candidates.map((c, i) =>
    `[${i}] (origin: ${c.origin}, source: ${opts.sourceKind}) ${c.title}\n${c.bodyMd}${c.evidence ? `\n出处: ${c.evidence}` : ''}`,
  ).join('\n---\n')
  const titles = opts.approvedTitles.length > 0 ? opts.approvedTitles.join('\n') : '(none)'
  return `项目根目录: ${opts.rootDir ?? '(无可读仓库)'}\n已审批记忆标题:\n${titles}\n\n候选记忆:\n${cs}\n\n按系统指示逐条判定;需要查证时先用工具。`
}

/**
 * 质量模式判定器(spec §4.5):agent 终审全部候选。永不抛——任何故障
 * (LLM 报错/预算耗尽/格式乱)倒向 R3 全保留兜底。taming 守卫最后跑,覆盖 stated 免疫。
 */
export async function judgeValueAgentic(
  candidates: DistillCandidate[],
  opts: AgentJudgeOpts,
): Promise<AgentJudgeResult> {
  const n = candidates.length
  if (n === 0) return { verdicts: [], trace: [] }
  const keepAll = (): ValueVerdict[] =>
    candidates.map((c, i) => ({
      index: i, keep: true,
      valueClass: c.origin === 'agent-observed' ? null : 'decision',
    }))
  try {
    const tools: RepoTools = makeRepoTools(opts.rootDir ?? '/')
    const loop = await runAgentLoop({
      callLLM: opts.callLLM,
      system: AGENT_JUDGE_SYSTEM_PROMPT,
      user: renderAgentUserPrompt(candidates, opts),
      tools, maxRounds: opts.maxRounds, timeBudgetMs: opts.timeBudgetMs,
    })
    const final = loop.final as { verdicts?: unknown } | null
    if (!final || !Array.isArray(final.verdicts)) {
      // 预算耗尽 / LLM 报错 / final 形状不对 -> 全保留兜底;trace 保底留一条停止原因,
      // 让落盘的 agentTrace 能解释「为什么这批是全保留」。
      const trace = loop.trace.length > 0 ? loop.trace
        : [{ kind: 'correction' as const, text: `agent loop ended without final: ${loop.stopReason}` }]
      return { verdicts: keepAll(), trace }
    }
    const entries = (final.verdicts as unknown[]).filter(
      (v): v is { index: number; category: string } =>
        !!v && typeof v === 'object' &&
        typeof (v as { index?: unknown }).index === 'number' &&
        typeof (v as { category?: unknown }).category === 'string',
    )
    const mapped = verdictsFromCategories(entries, candidates, AGENT_VALID_CATEGORIES, AGENT_DISCARD_CATEGORIES)
    const verdicts = mapped.map((v, i) =>
      detectTaming(candidates[i]!.title, candidates[i]!.bodyMd)
        ? { index: i, keep: false as const, reason: 'taming' as const }
        : v,
    )
    return { verdicts, trace: loop.trace }
  } catch {
    return { verdicts: keepAll(), trace: [] }
  }
}

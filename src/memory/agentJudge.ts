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

/**
 * Task 6（2026-08-18 spec §缺陷2/§8.4）：judge 失败绝不走 keepAll 全保留冒充成功。
 * agent 终审失败（LLM 报错/预算耗尽/final 形状不对）时返回 {failed:true,reasons}，
 * 由 scheduler 据此暂停任务（Task 7 接正式暂停）。成功路径 taming 守卫最后跑，
 * 覆盖 stated 免疫（安全 > stated 免疫）。
 */
export type AgentJudgeResultOrFailed = AgentJudgeResult | { failed: true; reasons: string[] }

const AGENT_DISCARD_CATEGORIES: ReadonlySet<string> = new Set(['public-knowledge', 'derivable', 'fleeting', 'duplicate'])

/**
 * rootDir=null 时的 stub 工具:execute 永远返回错误文本。纵深防御——绝不构造
 * makeRepoTools('/')(盘根沙箱 = 任意文件可读)。scheduler 侧已在 rootDir 缺失时
 * 降级经济模式;此处再兜一道,保证 judgeValueAgentic 单独被调用时也安全。
 */
const NO_REPO_TOOLS: RepoTools = {
  execute: async (tool) => `工具不可用:无可读项目仓库(rootDir 未提供),请凭材料判定(请求的工具:${tool})`,
}

function renderAgentUserPrompt(candidates: DistillCandidate[], opts: AgentJudgeOpts): string {
  const cs = candidates.map((c, i) =>
    `[${i}] (origin: ${c.origin}, source: ${opts.sourceKind}) ${c.title}\n${c.bodyMd}${c.evidence ? `\n出处: ${c.evidence}` : ''}`,
  ).join('\n---\n')
  const titles = opts.approvedTitles.length > 0 ? opts.approvedTitles.join('\n') : '(none)'
  return `项目根目录: ${opts.rootDir ?? '(无可读仓库)'}\n已审批记忆标题:\n${titles}\n\n候选记忆:\n${cs}\n\n按系统指示逐条判定;需要查证时先用工具。`
}

/**
 * 质量模式判定器(spec §4.5):agent 终审全部候选。Task 6：失败不再 keepAll 全保留
 * 冒充成功——返回 {failed:true,reasons} 让 scheduler 暂停（Task 7 接正式暂停）。
 * 成功路径 taming 守卫最后跑，覆盖 stated 免疫。
 */
export async function judgeValueAgentic(
  candidates: DistillCandidate[],
  opts: AgentJudgeOpts,
): Promise<AgentJudgeResultOrFailed> {
  const n = candidates.length
  if (n === 0) return { verdicts: [], trace: [] }
  try {
    const tools: RepoTools = opts.rootDir ? makeRepoTools(opts.rootDir) : NO_REPO_TOOLS
    const loop = await runAgentLoop({
      callLLM: opts.callLLM,
      system: AGENT_JUDGE_SYSTEM_PROMPT,
      user: renderAgentUserPrompt(candidates, opts),
      tools, maxRounds: opts.maxRounds, timeBudgetMs: opts.timeBudgetMs,
    })
    const final = loop.final as { verdicts?: unknown } | null
    if (!final || !Array.isArray(final.verdicts)) {
      // 预算耗尽 / LLM 报错 / final 形状不对 -> 失败标识（不再 keepAll 冒充成功）。
      // Task 7 接 scheduler 暂停逻辑；loop.stopReason 进 reasons 备查（trace 暂丢弃，
      // 与 brief 的 failed 变体对齐——Task 7 若需落盘 agentTrace 再扩 failed 变体）。
      return { failed: true, reasons: [`agent loop ended without final: ${loop.stopReason}`] }
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
  } catch (e) {
    return { failed: true, reasons: [e instanceof Error ? e.message : String(e)] }
  }
}

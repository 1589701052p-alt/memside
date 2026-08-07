// src/memory/agentLoop.ts
import { extractJsonObject } from './pure'
import type { LLMCall } from '@/llm'
import type { RepoTools } from './repoTools'

export interface AgentStep {
  kind: 'tool' | 'final' | 'correction'
  /** 该轮模型回复的原文(截断 500 字符,落盘用)。 */
  text: string
  toolName?: string
  /** 工具结果(截断 500 字符,落盘用)。 */
  toolResult?: string
}

export interface AgentLoopResult {
  /** 模型的最终判决 JSON(已 parse)。预算耗尽且强制收尾失败 / LLM 报错时为 null。 */
  final: unknown | null
  trace: AgentStep[]
  stopReason: 'final' | 'rounds-budget' | 'time-budget' | 'llm-error'
}

export interface AgentLoopOpts {
  callLLM: LLMCall
  system: string
  user: string
  tools: RepoTools
  maxRounds: number
  timeBudgetMs: number
}

const TRACE_CAP = 500

/**
 * 通用 agent 循环(spec §4.4)。与 callWithRetry 的根本区别:对话全程累积——
 * 初始材料、模型每轮回复、每次工具结果、每条纠正消息全部留在 user 侧文本里,
 * 模型看得到自己的完整试错历史(不会重复查同一词);格式纠错是末尾追加,不重置。
 *
 * 协议:模型每轮必须只输出一个 JSON 对象——
 *   {"tool": "grep"|"read"|"list", "args": {...}}  或  {"final": {...}}
 * 预算(maxRounds / timeBudgetMs)耗尽:追加强制收尾消息再试最后一轮;
 * 仍无 final -> final=null(调用方走全保留兜底)。
 */
export async function runAgentLoop(opts: AgentLoopOpts): Promise<AgentLoopResult> {
  const trace: AgentStep[] = []
  const deadline = Date.now() + opts.timeBudgetMs
  let conversation = opts.user
  let rounds = 0
  const FORCE_FINAL = '\n\n[系统] 预算已尽,请立即用已获取的信息输出 {"final": ...},不得再调用工具。'

  const callOnce = async (forced: boolean): Promise<'continue' | AgentLoopResult> => {
    let raw: string
    try {
      raw = await opts.callLLM(opts.system, conversation)
    } catch {
      return { final: null, trace, stopReason: 'llm-error' }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(extractJsonObject(raw))
    } catch {
      if (forced) return { final: null, trace, stopReason: rounds >= opts.maxRounds ? 'rounds-budget' : 'time-budget' }
      rounds++
      trace.push({ kind: 'correction', text: raw.slice(0, TRACE_CAP) })
      conversation += `\n\n[assistant]\n${raw}\n\n[系统] 你刚才的回复格式不对:必须只输出一个 JSON 对象(tool 或 final),不要 markdown 围栏,不要解释文字。`
      return 'continue'
    }
    const o = parsed as Record<string, unknown>
    if (o && typeof o === 'object' && 'final' in o) {
      trace.push({ kind: 'final', text: raw.slice(0, TRACE_CAP) })
      return { final: o.final, trace, stopReason: forced ? (rounds >= opts.maxRounds ? 'rounds-budget' : 'time-budget') : 'final' }
    }
    if (o && typeof o === 'object' && typeof o.tool === 'string') {
      if (forced) {
        // 强制收尾轮仍要工具:拒绝执行,记 correction,返回预算耗尽。
        trace.push({ kind: 'correction', text: raw.slice(0, TRACE_CAP) })
        return { final: null, trace, stopReason: rounds >= opts.maxRounds ? 'rounds-budget' : 'time-budget' }
      }
      rounds++
      const result = await opts.tools.execute(o.tool, (o.args ?? {}) as Record<string, unknown>)
      trace.push({ kind: 'tool', text: raw.slice(0, TRACE_CAP), toolName: o.tool, toolResult: result.slice(0, TRACE_CAP) })
      conversation += `\n\n[assistant]\n${raw}\n\n[工具结果]\n${result}`
      return 'continue'
    }
    if (forced) return { final: null, trace, stopReason: rounds >= opts.maxRounds ? 'rounds-budget' : 'time-budget' }
    rounds++
    trace.push({ kind: 'correction', text: raw.slice(0, TRACE_CAP) })
    conversation += `\n\n[assistant]\n${raw}\n\n[系统] 你刚才的回复格式不对:JSON 必须含 "tool" 或 "final" 键。`
    return 'continue'
  }

  while (rounds < opts.maxRounds && Date.now() < deadline) {
    const r = await callOnce(false)
    if (r !== 'continue') return r
  }
  // 预算耗尽:强制收尾最后一轮。
  conversation += FORCE_FINAL
  return callOnce(true) as Promise<AgentLoopResult>
}

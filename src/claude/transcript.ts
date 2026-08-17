import { readFileSync, statSync, existsSync, readdirSync } from 'node:fs'
import type { TranscriptTurn } from '@/memory/pure'
import { captureToolCall } from '@/memory/pure'

/**
 * Guard against pathological inputs: a real claude code transcript JSONL is
 * at most a few MB, so anything over 50MB is almost certainly a wrong path or
 * a non-transcript file handed to us by mistake. Reading such a file into
 * memory would waste hundreds of ms on the collector's hot path for no gain.
 */
const MAX_TRANSCRIPT_BYTES = 50 * 1024 * 1024

/**
 * Extract a plain-text string from a claude code `content` value, which may be:
 * - a string (returned as-is),
 * - an array of content blocks whose `text` fields are joined (e.g. tool_result
 *   content blocks shaped like `{type:'text', text:'...'}`),
 * - anything else -> `''`.
 *
 * Exported so tests can assert on it directly; production callers go through
 * `parseTranscriptFile`.
 */
export function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    let out = ''
    for (const item of content) {
      if (item && typeof item === 'object' && 'text' in item) {
        const t = (item as { text?: unknown }).text
        if (typeof t === 'string') out += t
      }
    }
    return out
  }
  return ''
}

/**
 * Extract a file path from a tool_use `input` object, checking common keys.
 * Used to pair `toolName` + `toolInputPath` onto the following tool_result.
 */
function extractToolInputPath(input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  const o = input as Record<string, unknown>
  for (const k of ['file_path', 'notebook_path', 'path', 'filePath']) {
    const v = o[k]
    if (typeof v === 'string') return v
  }
  return undefined
}

/**
 * Parse a claude code transcript JSONL file into `TranscriptTurn[]`.
 *
 * claude code hook stdin payloads carry `transcript_path` - a path to a JSONL
 * file where each line is one JSON object with a `type` field (verified against
 * claude code 2.1.217 + a real local transcript). Only `user` and `assistant`
 * rows carry conversation; everything else (`last-prompt`, `mode`,
 * `permission-mode`, `attachment`, `ai-title`, `system`, `queue-operation`,
 * `file-history-snapshot`, `file-history-delta`, ...) is skipped.
 *
 * Row mapping:
 * - `type:"user"` with `message.content` a string -> `{role:'user', content}`.
 *   With `content` an array, each `{type:'tool_result'}` item becomes a
 *   `{role:'tool', content: extractText(item.content), isError: !!is_error}`
 *   turn (so `detectErrorSignals` can count tool failures).
 * - `type:"assistant"`: each `{type:'text'}` item -> `{role:'assistant', content}`.
 *   `{type:'thinking'}` with a string `thinking` field -> `{role:'thinking',
 *   content}`（spec 2026-08-09 §4.1；独立 role 使 retry 检测结构性免疫，旧版
 *   skip 的污染顾虑由类型消除）。`redacted_thinking` / 缺文本字段的块跳过。
 *   `{type:'tool_use'}` is QUEUED (name + file_path extracted) and
 *   paired FIFO with the following user row's `tool_result` blocks, so the
 *   distill-time filter can compact file-source results by tool name.
 *   tool_use.input 经 captureToolCall 序列化截断后作 toolCall 落配对 tool turn。
 *
 * Pure + deterministic (only reads the given path). Never throws: file missing
 * / unreadable / empty / too large (>50MB) / malformed lines all degrade to a
 * possibly-shorter `[]`-or-valid-prefix result. Order of turns is preserved as
 * they appear in the file.
 */
export function parseTranscriptFile(path: string): TranscriptTurn[] {
  try {
    // Stat first so we can refuse oversized files without reading them.
    let size = 0
    try {
      size = statSync(path).size
    } catch {
      // missing / unreadable path -> nothing to parse
      return []
    }
    if (size > MAX_TRANSCRIPT_BYTES) return []

    const raw = readFileSync(path, 'utf-8')
    const turns: TranscriptTurn[] = []
    // Pending tool_use blocks from the most recent assistant message,
    // consumed FIFO by following user-row tool_result blocks.
    const pendingToolUses: { name: string; inputPath?: string; call?: string }[] = []
    // Split on '\n'; trimming each line also strips a trailing '\r' from CRLF
    // files. Newlines cannot appear inside valid JSON string values (they must
    // be escaped as \n), so a raw newline split is safe for JSONL.
    const lines = raw.split('\n')
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let row: unknown
      try {
        row = JSON.parse(trimmed)
      } catch {
        // skip malformed lines silently (C3: a single bad line must not lose
        // the rest of the transcript)
        continue
      }
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue
      const r = row as { type?: unknown; message?: unknown }
      if (typeof r.type !== 'string') continue

      if (r.type === 'user') {
        const msg = r.message
        if (!msg || typeof msg !== 'object' || Array.isArray(msg)) continue
        const content = (msg as { content?: unknown }).content
        if (typeof content === 'string') {
          turns.push({ role: 'user', content })
        } else if (Array.isArray(content)) {
          for (const item of content) {
            if (item && typeof item === 'object' && !Array.isArray(item)) {
              const it = item as { type?: unknown; content?: unknown; is_error?: unknown }
              if (it.type === 'tool_result') {
                  const paired = pendingToolUses.shift()
                  const base = {
                    role: 'tool' as const,
                    content: extractText(it.content),
                    isError: it.is_error === true,
                  }
                  turns.push(
                    paired
                      ? { ...base, toolName: paired.name, ...(paired.inputPath ? { toolInputPath: paired.inputPath } : {}), ...(paired.call ? { toolCall: paired.call } : {}) }
                      : base,
                  )
                }
            }
          }
        }
      } else if (r.type === 'assistant') {
        const msg = r.message
        if (!msg || typeof msg !== 'object' || Array.isArray(msg)) continue
        const content = (msg as { content?: unknown }).content
        if (Array.isArray(content)) {
          for (const item of content) {
            if (item && typeof item === 'object' && !Array.isArray(item)) {
              const it = item as { type?: unknown; text?: unknown; thinking?: unknown; name?: unknown; input?: unknown }
              if (it.type === 'text' && typeof it.text === 'string') {
                turns.push({ role: 'assistant', content: it.text })
              } else if (it.type === 'thinking' && typeof it.thinking === 'string') {
                turns.push({ role: 'thinking', content: it.thinking })
              } else if (it.type === 'tool_use' && typeof it.name === 'string') {
                pendingToolUses.push({
                  name: it.name,
                  inputPath: extractToolInputPath(it.input),
                  call: captureToolCall(it.input),
                })
              }
              // redacted_thinking / 缺 thinking 字段的块 -> 跳过
            }
          }
        }
      }
      // all other row types -> SKIP
    }
    return turns
  } catch {
    // never throw to the caller (collector hot path)
    return []
  }
}

/**
 * `statSync(p).isFile()` 的永不抛包装：路径不存在/指向目录/畸形/无权限 → false。
 * 取证专用（agentTranscriptPathExists 契约是"存在且为文件"，existsSync 对目录
 * 也 true 会误判）。
 */
function safeIsFile(p: string): boolean {
  try { return statSync(p).isFile() } catch { return false }
}

/**
 * Derive the subagent's own transcript file path from a SubagentStop payload's
 * `transcript_path` (main-session `<dir>/<sid>.jsonl`) + `agent_id`. The
 * subagent file lives at `<dir>/<sid>/subagents/agent-<agentId>.jsonl`
 * (verified on disk against claude code 2.1.220). Returns null when the inputs
 * can't yield a valid path (agentId empty, transcriptPath not a .jsonl, etc.)
 * so callers can fall back to the raw transcript_path. Pure + never throws.
 */
export function subagentFilePathFromPayload(
  transcriptPath: string,
  agentId: string | null | undefined,
): string | null {
  try {
    if (!transcriptPath || !transcriptPath.endsWith('.jsonl')) return null
    if (!agentId) return null
    // strip trailing '.jsonl' -> the <sid> directory; join with subagents/agent-<id>.jsonl
    const sep = transcriptPath.includes('\\') && !transcriptPath.includes('/') ? '\\' : '/'
    const base = transcriptPath.slice(0, -'.jsonl'.length)
    return `${base}${sep}subagents${sep}agent-${agentId}.jsonl`
  } catch {
    return null
  }
}

/**
 * 解析 subagent 自有 transcript（spec 2026-08-15 §5.2）：不再有「退回主会话」兜底——
 * 主会话内容由其自有累加 job 蒸馏，兜底既重复又会把 origin 强制降级。
 * 文件缺失/为空一律空 turns + 取证 diag（供 subagent_transcript_missing degradation）。
 * 永不抛（collector 热路径契约同 parseTranscriptFile）。
 */
export interface SubagentResolveDiag {
  agentId: string
  transcriptPath: string
  /** subagentFilePathFromPayload 推导结果；推不出为 null */
  derivedPath: string | null
  /** derivedPath 存在且为文件 */
  derivedExists: boolean
  /** 文件解析出的 turn 数（0 = 缺失或空/无有效 turn） */
  derivedTurns: number
  /** transcript_path 指向的主会话文件是否存在（不读内容） */
  mainTranscriptExists: boolean
  /** <base>/subagents/ 目录当时真实 basename（cap 30）；目录不存在/不可读为 [] */
  subagentsDirEntries: string[]
  // —— 新增（方案 A 取证：subagent 直连路径，仅记取证不参与决策）——
  /** payload 的 agent_transcript_path 直连路径值；payload 无此字段/调用方未传为 null */
  agentTranscriptPath: string | null
  /** agentTranscriptPath 存在且为文件；null 路径恒 false */
  agentTranscriptPathExists: boolean
}

export function resolveSubagentTranscript(
  transcriptPath: string,
  agentId: string | null | undefined,
  agentTranscriptPath?: string | null,
): { turns: TranscriptTurn[]; diag: SubagentResolveDiag } {
  const diag: SubagentResolveDiag = {
    agentId: agentId ?? '', transcriptPath,
    derivedPath: null, derivedExists: false, derivedTurns: 0,
    mainTranscriptExists: false, subagentsDirEntries: [],
    agentTranscriptPath: null, agentTranscriptPathExists: false,
  }
  try {
    diag.mainTranscriptExists = !!transcriptPath && existsSync(transcriptPath)
    const subPath = subagentFilePathFromPayload(transcriptPath, agentId)
    diag.derivedPath = subPath
    // 目录现场清单（抓「文件为什么不存在」的现行：命名漂移/目录缺失一目了然）
    if (transcriptPath.endsWith('.jsonl')) {
      const sep = transcriptPath.includes('\\') && !transcriptPath.includes('/') ? '\\' : '/'
      const dir = `${transcriptPath.slice(0, -'.jsonl'.length)}${sep}subagents`
      try {
        if (existsSync(dir)) diag.subagentsDirEntries = readdirSync(dir).slice(0, 30)
      } catch { /* 目录不可读保持 [] */ }
    }
    // 方案 A 取证：记 payload 的 agent_transcript_path 直连路径值 + 它指向文件的存在性。
    // 仅赋值，绝不参与 derivedExists/turns 决策（控制流一字不动）。
    diag.agentTranscriptPath = typeof agentTranscriptPath === 'string' && agentTranscriptPath ? agentTranscriptPath : null
    // 用 statSync().isFile() 而非 existsSync：契约是"存在且为文件"（直连路径指向目录时
    // existsSync 仍 true，会误判为"文件存在"，污染观测决策树）。statSync 抛错（路径畸形/
    // 不存在）被外层 try/catch 兜底，diag 保持初始 false。
    diag.agentTranscriptPathExists = !!diag.agentTranscriptPath && safeIsFile(diag.agentTranscriptPath)
    if (subPath && existsSync(subPath)) {
      diag.derivedExists = true
      const turns = parseTranscriptFile(subPath)
      diag.derivedTurns = turns.length
      return { turns, diag }
    }
    return { turns: [], diag }
  } catch {
    return { turns: [], diag }
  }
}

// src/memory/sse.ts
// 纯函数 SSE（Server-Sent Events）行解析器：把流式读到的文本块切成 data: 事件。
// spec: docs/superpowers/specs/2026-08-20-openai-streaming-and-failure-visibility-design.md §3.1
// 零运行时依赖；跨 chunk 的不完整行通过 leftover 延续到下次。

export interface SseEvent {
  /** data: 行的 payload（已剥前缀）；[DONE] 哨兵原样返回。 */
  data: string
}

/**
 * 解析一段新读到的 SSE 文本块。
 *
 * @param buffer 本次新读到的文本（可能是半行）。
 * @param leftover 上次切剩的尾巴（可空串）。
 * @returns events=本次完整解析出的事件；leftover=本次仍不完整的尾巴。
 *
 * 规则：按 \n 切行（行尾 \r\n 去 \r）；data: / data: 前缀取 payload；
 * [DONE] 也作为事件返回（调用方判终止）；空行 / :开头心跳行跳过；无换行结尾的行留作 leftover。
 */
export function parseSseChunks(buffer: string, leftover: string): { events: SseEvent[]; leftover: string } {
  const text = leftover + buffer
  const events: SseEvent[] = []
  // 按行扫描，最后一行若无换行结尾则留作 leftover
  let lastNewline = -1
  let lineStart = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      let line = text.slice(lineStart, i)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      processLine(line, events)
      lastNewline = i
      lineStart = i + 1
    }
  }
  const leftoverNext = lastNewline === -1 ? text : text.slice(lastNewline + 1)
  return { events, leftover: leftoverNext }
}

function processLine(line: string, events: SseEvent[]): void {
  if (line === '') return                 // 空行（事件分隔）
  if (line.startsWith(':')) return        // SSE 心跳注释
  if (line.startsWith('data:')) {
    const payload = line.slice('data:'.length).replace(/^ /, '')
    events.push({ data: payload })
    return
  }
  // 其它字段（event:/id:/retry:）暂不处理，跳过
}

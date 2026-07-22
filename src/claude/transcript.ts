import { readFileSync, statSync } from 'node:fs'
import type { TranscriptTurn } from '@/memory/pure'

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
 *   `{type:'thinking'}` is SKIPPED (internal reasoning would pollute retry
 *   detection). `{type:'tool_use'}` is SKIPPED (its result is captured by the
 *   tool_result on the following user row).
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
                turns.push({
                  role: 'tool',
                  content: extractText(it.content),
                  isError: it.is_error === true,
                })
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
              const it = item as { type?: unknown; text?: unknown }
              if (it.type === 'text' && typeof it.text === 'string') {
                turns.push({ role: 'assistant', content: it.text })
              }
              // thinking + tool_use are deliberately skipped (see JSDoc above).
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

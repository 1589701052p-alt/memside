import type { DbClient } from '@/db/client'
import { listApprovedByScope } from '@/memory/store'
import { formatMemoryBlock } from '@/memory/pure'
import type { RuntimeAdapter, CaptureEvent, InjectInput } from './types'

/**
 * Opencode runtime adapter.
 *
 * Mirrors ClaudeCodeAdapter's structure:
 * - `pushCapture(event)`: the collector HTTP handler calls this when an
 *   opencode hook fires. Events buffer in an in-memory queue.
 * - `capture()`: drains and returns the queue (empties it). The scheduler
 *   polls this to enqueue distill jobs.
 * - `inject({cwd})`: queries approved memories for the project (cross-runtime,
 *   spec §5) and renders the markdown block the SessionStart hook prepends.
 *   Returns null when there is nothing to inject (no db, no approved memories,
 *   or any store error) so injection never throws to the caller.
 */
export class OpencodeAdapter implements RuntimeAdapter {
  readonly kind = 'opencode' as const
  private queue: CaptureEvent[] = []

  constructor(private db?: DbClient) {}

  /** Called by the collector HTTP handler when an opencode hook fires. */
  pushCapture(event: CaptureEvent): void {
    this.queue.push(event)
  }

  async capture(): Promise<CaptureEvent[]> {
    const out = this.queue
    this.queue = []
    return out
  }

  async inject(input: InjectInput): Promise<string | null> {
    if (!this.db) return null
    try {
      const set = await listApprovedByScope(this.db, { projectId: input.cwd })
      return formatMemoryBlock(set)
    } catch {
      // injection must never throw to the caller (SessionStart hook)
      return null
    }
  }
}

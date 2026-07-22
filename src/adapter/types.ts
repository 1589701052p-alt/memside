import type { InjectableMemorySet } from '@/memory/pure'

export type RuntimeKind = 'claude-code' | 'opencode'

/** A captured hook event waiting to be enqueued as a distill job. */
export interface CaptureEvent {
  sourceEventId: string
  runtime: RuntimeKind
  cwd: string
  debounceKey: string
  /** Raw turns already extracted; the adapter is responsible for reading transcript files. */
  turns: import('@/memory/pure').TranscriptTurn[]
  sourceKind: 'conversation' | 'error'
}

export interface InjectInput {
  cwd: string
  memorySet: InjectableMemorySet
}

export interface RuntimeAdapter {
  readonly kind: RuntimeKind
  /** Poll/accept captured events. claude code reads webhook queue; opencode stub returns []. */
  capture(): Promise<CaptureEvent[]>
  /** Render+return the injection block for a session start. null = no inject. */
  inject(input: InjectInput): Promise<string | null>
}

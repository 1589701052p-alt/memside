import type { RuntimeAdapter, CaptureEvent, InjectInput } from './types'

/** MVP stub: opencode capture/inject are no-ops. Real impl lands post-MVP
 *  after verifying opencode plugin event + startup-injection capabilities. */
export class OpencodeAdapter implements RuntimeAdapter {
  readonly kind = 'opencode' as const
  async capture(): Promise<CaptureEvent[]> {
    return []
  }
  async inject(_input: InjectInput): Promise<string | null> {
    return null
  }
}

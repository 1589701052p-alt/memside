// src/memory/dedup.ts —— 语义去重职责已由 src/memory/consolidate.ts 接管。
// 本文件仅保留 ExistingMemoryForDedup type（合并步 + listForDedupByScope 复用）。
import type { MemoryScope, MemoryStatus } from '@/memory/pure'

export interface ExistingMemoryForDedup {
  id: string
  title: string
  bodyMd: string
  scopeType: MemoryScope
  scopeId: string | null
  status: MemoryStatus
  subjectSlug?: string | null
}

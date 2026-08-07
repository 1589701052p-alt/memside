// src/memory/exactDedup.ts
import type { DbClient } from '@/db/client'
import type { DistillCandidate } from '@/memory/distiller'
import { listForDedupByScope } from '@/memory/store'
import type { MemoryScope } from '@/memory/pure'

/**
 * 逐字级标题规范化(spec §4.1):去 [category:xxx] 前缀 → 去全部空白/标点/符号 → 转小写。
 * 只做逐字相同合并,零语义判断——前缀相近但内容不同的标题(parseTranscriptFile 组)
 * 规范化后仍不同,绝不误合并。
 */
export function normalizeTitleForDup(title: string): string {
  return title
    .replace(/\[category:[^\]]*\]/gi, '')
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .toLowerCase()
}

export interface ExactDupDrop {
  /** 被合并候选在输入数组中的下标。 */
  index: number
  /** true = 与同 scope 存量重复;false = 与同批更早候选重复。 */
  matchedExisting: boolean
}

/**
 * 找出应合并的候选:同批内规范化标题逐字相同留最早;与 existingTitles 逐字相同即合并。
 * 空规范化结果(纯前缀标题)不参与比对,保守保留。
 */
export function findExactDuplicates(
  candidates: DistillCandidate[],
  existingTitles: string[],
): ExactDupDrop[] {
  const existingKeys = new Set(existingTitles.map(normalizeTitleForDup).filter((k) => k.length > 0))
  const batchSeen = new Set<string>()
  const drops: ExactDupDrop[] = []
  for (let i = 0; i < candidates.length; i++) {
    const key = normalizeTitleForDup(candidates[i]!.title)
    if (!key) continue
    if (batchSeen.has(key)) { drops.push({ index: i, matchedExisting: false }); continue }
    batchSeen.add(key)
    if (existingKeys.has(key)) drops.push({ index: i, matchedExisting: true })
  }
  return drops
}

function resolveScopeId(scopeType: MemoryScope, cwd: string | null): string | null {
  return scopeType === 'project' ? (cwd ?? 'unknown') : null
}

/**
 * 按 (scopeType, scopeId) 分组(与 scheduler.dedupCandidates 同规则,防 scopeId 漂移),
 * 每组查存量 candidate+approved 标题做逐字比对。返回幸存者与合并项。
 * listForDedupByScope 的 DB 错误上抛(基础设施故障 → job 重试,与 dedupCandidates 一致)。
 */
export async function exactDedupCandidates(
  db: DbClient,
  candidates: DistillCandidate[],
  jobCwd: string | null,
): Promise<{ kept: DistillCandidate[]; drops: { cand: DistillCandidate; matchedExisting: boolean }[] }> {
  if (candidates.length === 0) return { kept: [], drops: [] }
  const groups = new Map<string, { scopeType: MemoryScope; scopeId: string | null; idxs: number[] }>()
  candidates.forEach((c, i) => {
    const scopeId = resolveScopeId(c.scopeType, jobCwd)
    const key = `${c.scopeType}:${scopeId ?? ''}`
    if (!groups.has(key)) groups.set(key, { scopeType: c.scopeType, scopeId, idxs: [] })
    groups.get(key)!.idxs.push(i)
  })
  const dropByIndex = new Map<number, boolean>()  // index -> matchedExisting
  for (const g of groups.values()) {
    const existing = await listForDedupByScope(db, { scopeType: g.scopeType, scopeId: g.scopeId })
    const sub = g.idxs.map((i) => candidates[i]!)
    for (const d of findExactDuplicates(sub, existing.map((e) => e.title))) {
      dropByIndex.set(g.idxs[d.index]!, d.matchedExisting)
    }
  }
  const kept: DistillCandidate[] = []
  const drops: { cand: DistillCandidate; matchedExisting: boolean }[] = []
  candidates.forEach((c, i) => {
    const m = dropByIndex.get(i)
    if (m === undefined) kept.push(c)
    else drops.push({ cand: c, matchedExisting: m })
  })
  return { kept, drops }
}

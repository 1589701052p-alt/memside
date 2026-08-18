// src/memory/rescan.ts
import { existsSync } from 'node:fs'
import { parse as parsePath } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import { memories, memoryDistillJobs } from '@/db/schema'
import type { LLMCall } from '@/llm'
import type { DistillCandidate } from '@/memory/distiller'
import type { MemoryScope } from '@/memory/pure'
import { judgeValue } from '@/memory/valueFilter'
import { judgeValueAgentic } from '@/memory/agentJudge'
import { DEFAULT_JUDGE_CONFIG, type JudgeConfig } from '@/memory/judgeConfig'
import {
  listAllCandidatesForRescan, listApprovedByScope, logDiscards, updateJudgedFields,
  saveLlmRound, markJobPaused, logStepFailureNotification,
  type Memory,
} from '@/memory/store'

export interface RescanDeps {
  callLLM: LLMCall
  loadJudgeConfig: () => JudgeConfig
}

export interface RescanReport {
  processed: number
  discarded: number
  skipped: number
  keptUpdated: number
  /** 被 shouldStop 截停(true)= 还有候选没判,可重跑续判。 */
  stopped: boolean
}

const RESCAN_BATCH = 15

const toCandidate = (m: Memory): DistillCandidate => ({
  title: m.title, bodyMd: m.bodyMd, scopeType: m.scopeType as MemoryScope,
  runtime: m.runtime, distillAction: 'new',
  origin: m.origin ?? 'agent-observed',
  evidence: m.evidence ?? null,
  subjectSlug: m.subjectSlug ?? null,
})

/**
 * 存量回扫(spec §4.7):按当前判定模式重判全部候选。判丢 -> memory_discards(可恢复)
 * + memories.status='rejected'(离开候选池,天然不重复判);判留 -> 只补 NULL 的
 * value_class/origin;仓库目录已删除的跳过不动。单批判定抛错(DB 层故障)倒向保留。
 * judge LLM 失败(Task 7,spec 2026-08-18 §5.2):合成 job 暂停 + 汇总通知 + 该批
 * 候选标 pending_review(不进审批队列、不丢弃),回扫停住可重跑续判。
 */
export async function rescanCandidates(
  db: DbClient, deps: RescanDeps,
  onProgress?: (done: number, total: number, discarded: number) => void,
  shouldStop?: () => boolean,
): Promise<RescanReport> {
  const all = await listAllCandidatesForRescan(db)
  const report: RescanReport = { processed: 0, discarded: 0, skipped: 0, keptUpdated: 0, stopped: false }
  if (all.length === 0) return report
  // 审计行挂一个合成 job 行(distill_job_id NOT NULL + FK)。
  const jobId = ulid()
  const now = Date.now()
  await db.insert(memoryDistillJobs).values({
    id: jobId, debounceKey: `rescan:${jobId}`, sourceEventId: `rescan:${jobId}`,
    runtime: 'claude-code', cwd: '(rescan)', sessionId: null, sourceAgentId: null,
    status: 'done', attempts: 0, nextRunAt: now, createdAt: now, finishedAt: now,
  })
  const cfg = deps.loadJudgeConfig?.() ?? DEFAULT_JUDGE_CONFIG
  // 按仓库根分组(目录缺失的整组跳过)。
  const byRoot = new Map<string, Memory[]>()
  for (const m of all) {
    const rootDir = (m.sourceCwd ?? m.scopeId ?? '')
    if (!byRoot.has(rootDir)) byRoot.set(rootDir, [])
    byRoot.get(rootDir)!.push(m)
  }
  for (const [rootDir, group] of byRoot) {
    // 目录缺失或就是文件系统根('/' / 'C:\')整组跳过:根目录 existsSync 为真,
    // 但 makeRepoTools(根) 等于盘根沙箱,agent 工具可读全盘整盘——与 scheduler
    // 同款防护,spec 失败矩阵按「无可用仓库根」处理(跳过不动,可恢复)。
    if (!rootDir || !existsSync(rootDir) || parsePath(rootDir).root === rootDir) {
      report.skipped += group.length
      report.processed += group.length
      onProgress?.(report.processed, all.length, report.discarded)
      continue
    }
    let approvedTitles: string[] = []
    try {
      const set = await listApprovedByScope(db, { projectId: rootDir })
      approvedTitles = [...set.byScope.project, ...set.byScope.global].map((m) => m.title).slice(0, 100)
    } catch { approvedTitles = [] }
    // 同 rootDir 内再按 sourceKind 分组:judge 批次必须同质——judgeValueAgentic 只收
    // 单个 sourceKind,混批硬编码 'conversation' 会让 subagent 候选永远触发不了
    // 系统提示里的 subagent 核对段(agentJudge 协议段),③ backlog 正是为此设。
    const byKind = new Map<'conversation' | 'subagent', Memory[]>()
    for (const m of group) {
      const k = m.sourceKind === 'subagent' ? 'subagent' : 'conversation'
      if (!byKind.has(k)) byKind.set(k, [])
      byKind.get(k)!.push(m)
    }
    for (const [sourceKind, kindGroup] of byKind) {
    for (let i = 0; i < kindGroup.length; i += RESCAN_BATCH) {
      // 批边界停止(spec §3.2):批内不查——正在判的批照常判完落库,无脏状态。
      if (shouldStop?.()) { report.stopped = true; return report }
      const batch = kindGroup.slice(i, i + RESCAN_BATCH)
      const cands = batch.map(toCandidate)
      // Task 7（spec 2026-08-18 §5.2/D4）：judge 失败不再当空 verdicts 过渡——正式
      // 暂停 + 通知 + 该批判 pending_review（不进审批队列、不丢弃），回扫就此停住
      // （报告 stopped=true，剩余批次可重跑续判）。单批判定抛错仍倒向保留（DB 层
      // 故障与 LLM 失败分开处理）。
      let verdicts
      let judgeFailed: { reasons: string[] } | null = null
      try {
        if (cfg.mode === 'economy') {
          const r = await judgeValue(cands, deps.callLLM, {
            jobId,
            persistRound: (rr) => saveLlmRound(db, { jobId, step: 'judge', round: rr.round, request: rr.request, response: rr.response, result: rr.result }),
          })
          if (Array.isArray(r)) verdicts = r
          else judgeFailed = { reasons: r.reasons }
        } else {
          const r = await judgeValueAgentic(cands, {
            callLLM: deps.callLLM, rootDir, approvedTitles,
            sourceKind, maxRounds: cfg.maxRounds, timeBudgetMs: cfg.timeBudgetS * 1000,
          })
          if ('failed' in r) judgeFailed = { reasons: r.reasons }
          else verdicts = r.verdicts
        }
      } catch (e) {
        console.warn('memside: rescan batch judge failed, keeping batch', e)
        report.keptUpdated += batch.length
        report.processed += batch.length
        onProgress?.(report.processed, all.length, report.discarded)
        continue
      }
      if (judgeFailed) {
        await markJobPaused(db, jobId, 'judge')
        await logStepFailureNotification(db, { jobId, step: 'judge', reasons: judgeFailed.reasons })
        for (const m of batch) {
          try {
            await db.update(memories).set({ status: 'pending_review' }).where(eq(memories.id, m.id)).run()
          } catch (e) { console.warn('memside: rescan pending_review update failed', e) }
        }
        report.stopped = true
        return report
      }
      const batchVerdicts = verdicts ?? []
      for (let j = 0; j < batch.length; j++) {
        const v = batchVerdicts[j]
        const m = batch[j]!
        if (v && !v.keep) {
          try {
            await logDiscards(db, jobId, [{
              title: m.title, bodyMd: m.bodyMd, reason: v.reason,
              scopeType: m.scopeType, scopeId: m.scopeId,
              sourceCwd: rootDir, runtime: m.runtime,
              sourceKind: (m.sourceKind === 'subagent' ? 'subagent' : 'conversation'),
            }])
            await db.update(memories).set({ status: 'rejected' }).where(eq(memories.id, m.id)).run()
            report.discarded++
          } catch (e) { console.warn('memside: rescan discard failed', e) }
        } else {
          try {
            await updateJudgedFields(db, m.id, {
              valueClass: v?.keep ? v.valueClass : undefined,
              origin: m.origin ?? undefined,
            })
            report.keptUpdated++
          } catch (e) { console.warn('memside: rescan update failed', e) }
        }
      }
      report.processed += batch.length
      onProgress?.(report.processed, all.length, report.discarded)
    }
    }
  }
  return report
}

import { test, expect } from 'bun:test'
import { judgeDuplicates } from '@/memory/dedup'
// 注意：DistillCandidate 实际导出在 src/memory/distiller.ts:85（brief 原写 '@/memory/pure'，
// 已按 src/ 实际定义修正——grep 核实 pure.ts 不含该类型，与 live-helpers.ts 一致）。
import type { DistillCandidate } from '@/memory/distiller'
import { realCallLLM, LIVE_GUARD } from './live-helpers'

/**
 * Live dedup e2e（spec 2026-08-16 §5 检查 ④ dedup 分支）。
 * 真打模型：judgeDuplicates 喂真实 callLLM，验 verdicts 形状合法。
 * 默认 skip（无 MEMSIDE_RUN_LIVE 或无凭证）；npm run test:live 才跑。
 */
test.skipIf(!LIVE_GUARD)(
  'live dedup: 真模型产出合法 verdicts',
  async () => {
    // 2 条候选，第 1 条与 existing 语义重复，触发 dedup 真打（existing 非空）。
    const newCandidates: DistillCandidate[] = [
      { title: '[category:invariant] refund within 14 days', bodyMd: 'Refunds allowed within 14 days of shipment.', scopeType: 'project', runtime: null, distillAction: 'new', origin: 'agent-observed', evidence: null, subjectSlug: null },
      { title: '[category:convention] use bun test not npm test', bodyMd: 'All tests run via bun test.', scopeType: 'project', runtime: null, distillAction: 'new', origin: 'agent-observed', evidence: null, subjectSlug: null },
    ]
    const existing = [
      { id: 'EXIST-1', title: '[category:invariant] 14-day refund window', bodyMd: 'Refunds only within 14 days of shipment.', scopeType: 'project' as const, scopeId: '/live-test/proj', status: 'approved' as const },
    ]

    const result = await judgeDuplicates({ newCandidates, existing, callLLM: realCallLLM })
    // Task 7：judgeDuplicates 返回 union（LLM 失败 → failed 标识）。live 路径真模型
    // 正常时是 verdicts 数组；failed 时 fail-fast（live 门禁不绿即问题）。
    expect(Array.isArray(result)).toBe(true)
    if (!Array.isArray(result)) throw new Error(`live dedup failed: ${result.reasons.join(' | ')}`)
    const verdicts = result

    // 检查 ④ dedup：每条 verdict index 在范围内
    expect(verdicts.length).toBeLessThanOrEqual(newCandidates.length)
    for (const v of verdicts) {
      expect(v.index).toBeGreaterThanOrEqual(0)
      expect(v.index).toBeLessThan(newCandidates.length)
      if (v.duplicate) {
        // isDuplicate:true 必配 duplicateOfId 且指向合法（existing id 或 new-j j<i）
        expect(typeof v.duplicateOfId).toBe('string')
        const validExisting = existing.some((e) => e.id === v.duplicateOfId)
        const validSibling = /^new-\d+$/.test(v.duplicateOfId) && parseInt(v.duplicateOfId.slice(4)) < v.index
        expect(validExisting || validSibling, `非法 duplicateOfId: ${v.duplicateOfId}`).toBe(true)
      }
    }
  },
  { timeout: 300_000 },
)

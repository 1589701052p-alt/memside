import { test, expect } from 'bun:test'
import { judgeValue, AGENT_VALID_CATEGORIES } from '@/memory/valueFilter'
// 注意：DistillCandidate 实际导出在 src/memory/distiller.ts:85（brief 原写 '@/memory/pure'，
// 以源码实际为准修正——pure.ts 不含该类型）。
import type { DistillCandidate } from '@/memory/distiller'
import { realCallLLM, LIVE_GUARD } from './live-helpers'

/**
 * Live judgeValue e2e（spec 2026-08-16 §5 检查 ④ judge 分支）。
 * 真打模型：judgeValue 喂真实 callLLM，验 verdicts category 合法。
 * 默认 skip（无 MEMSIDE_RUN_LIVE 或无凭证）；npm run test:live 才跑。
 */
test.skipIf(!LIVE_GUARD)(
  'live judge: 真模型产出合法 category',
  async () => {
    const candidates: DistillCandidate[] = [
      { title: '[category:invariant] refund within 14 days', bodyMd: 'Refunds allowed within 14 days of shipment.', scopeType: 'project', runtime: null, distillAction: 'new', origin: 'agent-observed', evidence: null, subjectSlug: null },
      { title: '[category:convention] use bun test not npm test', bodyMd: 'All tests run via bun test.', scopeType: 'project', runtime: null, distillAction: 'new', origin: 'agent-observed', evidence: null, subjectSlug: null },
    ]

    const verdicts = await judgeValue(candidates, realCallLLM)

    // 检查 ④ judge：judgeValue 不崩、返回与候选数等长的 verdicts
    expect(verdicts.length).toBe(candidates.length)
    for (const v of verdicts) {
      expect(v.index).toBeGreaterThanOrEqual(0)
      expect(v.index).toBeLessThan(candidates.length)
      // ValueVerdict union：keep===true 才有 valueClass 字段，需 narrow
      if (v.keep) {
        // valueClass 非 null 时必须在合法集内（AGENT_VALID_CATEGORIES 是 9 类超集）
        if (v.valueClass != null) {
          expect(
            AGENT_VALID_CATEGORIES.has(v.valueClass),
            `非法 category: ${v.valueClass}`,
          ).toBe(true)
        }
      }
    }
  },
  { timeout: 300_000 },
)

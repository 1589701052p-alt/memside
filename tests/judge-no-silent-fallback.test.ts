// 锁 spec 2026-08-18 §缺陷2/§8.4：judge 失败绝不走 keepNull/keepAll 全保留
// 冒充成功。这是用户最初踩的坑（全"未评估"+AI自动拒绝0）。未来 refactor
// 变红即回归意图。链接 spec 2026-08-18。
import { describe, expect, test } from 'bun:test'
import { judgeValue } from '@/memory/valueFilter'
import type { LLMCall } from '@/llm'
import type { DistillCandidate } from '@/memory/distiller'

const failingCall: LLMCall = async () => { throw new Error('the operation was aborted') }

const cand = (i: number): DistillCandidate => ({
  title: `[category:convention] test ${i}`, bodyMd: 'b', scopeType: 'project',
  runtime: 'claude-code', distillAction: 'new', origin: 'agent-observed',
  evidence: 'e', subjectSlug: null,
})

describe('judge 失败不静默全保留', () => {
  test('LLM 永远报错 → judgeValue 不返回全保留 verdicts，而是返回失败标识', async () => {
    const r = await judgeValue([cand(0), cand(1)], failingCall)
    // 旧行为：返回 [{keep:true,valueClass:null},...]（全未评估）。新行为：返回失败标识。
    expect(Array.isArray(r)).toBe(false)
    expect((r as { failed: true }).failed).toBe(true)
  })

  test('反向断言：失败时不再出现"全候选 keep+null+0丢弃"旧症状', async () => {
    const r = await judgeValue([cand(0)], failingCall)
    if (Array.isArray(r)) {
      // 不该走到这：若仍是数组，不应是全 keep+null
      const allNull = r.every((v) => v.keep && v.valueClass === null)
      expect(allNull).toBe(false)
    }
  })
})

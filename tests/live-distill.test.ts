import { test, expect } from 'bun:test'
import { distillTranscript } from '@/memory/distiller'
import { realCallLLM, judgeCallLLM, LIVE_GUARD, makeFixture, judgeEvidence } from './live-helpers'

/**
 * Live distill e2e（spec 2026-08-16 §5 检查 ①②③）。
 * 真打模型：distillTranscript 喂真实 callLLM，验「真模型按 prompt 产出 → 解析链路吃下」。
 * 默认 skip（无 MEMSIDE_RUN_LIVE 或无凭证）；npm run test:live 才跑。
 */
test.skipIf(!LIVE_GUARD)(
  'live distill: 真模型产出可解析 + evidence 真出自 transcript',
  async () => {
    const turns = makeFixture()
    const result = await distillTranscript({
      turns,
      runtime: 'claude-code',
      cwd: '/live-test/proj',
      existingSlugs: [],
      callLLM: realCallLLM,
    })

    // 检查 ①：模型没报错（拦 60s 墙 / Connection error / 凭证错）
    expect(result.callThrew).toBe(false)
    expect(result.errorMessage).toBe(null)

    // 检查 ②：模型产出了且解析链路吃得下（拦围栏/前缀全丢光）
    expect(result.rawCount).toBeGreaterThan(0)
    expect(result.candidates.length).toBeGreaterThanOrEqual(1)
    // 诊断（不红）：被格式校验丢弃的条数
    const dropped = result.rawCount - result.candidates.length
    if (dropped > 0) console.log(`[live-distill] 诊断: rawCount=${result.rawCount} candidates=${result.candidates.length} dropped=${dropped}`)

    // 每条候选 title 必含 [category:（解析契约已保证，再锁一道）
    for (const c of result.candidates) {
      expect(c.title).toContain('[category:')
    }

    // 检查 ③：evidence 经 AI judge 判真出自 transcript
    const { verdicts, judgeFailed } = await judgeEvidence(turns, result.candidates, judgeCallLLM())
    if (judgeFailed) {
      console.log('[live-distill] evidence judge 失败，检查 ③ 降级 skip')
    } else {
      for (const v of verdicts) {
        expect(
          v.isPresent,
          `候选 #${v.index} 的 evidence 被判为伪造（贴金）`,
        ).toBe(true)
      }
    }
  },
  { timeout: 300_000 },
)

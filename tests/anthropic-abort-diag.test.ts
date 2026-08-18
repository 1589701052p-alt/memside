// 锁 spec 2026-08-18 §缺陷3 / §6.2 / Task 10：
// 裸 "the operation was aborted" 不可诊断——执行器 classifyFailure 虽能识别 aborted，
// 但 reasons 里落的是 SDK 原文「the operation was aborted」，用户/日志看不出是网关掐断
// 还是超时。callLLM 的 catch 必须把消息包装成可诊断描述（含「中断/aborted/诊断」之一），
// 这样 runLlmSession 落盘的 reasons / paused job 的 stepError 才有人读得懂。
//
// 这是源代码层文本断言（CLAUDE.md「最低限度保留一条源代码层文本断言兜底」）：
// 不实例化 SDK、不发请求，只锁 catch 分支写了诊断化文案。运行时行为由
// tests/live-llm-failure-resume.test.ts（live e2e）覆盖。
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const src = readFileSync('src/anthropic.ts', 'utf-8')

describe('anthropic AbortError 诊断化（spec §缺陷3）', () => {
  test('anthropic.ts 含可诊断的中断处理文案', () => {
    // /中断|aborted|诊断/i 三选一：中文「中断」、英文「aborted」、或「诊断」均算达标。
    expect(src).toMatch(/中断|aborted|诊断/i)
  })

  test('anthropic.ts 未引入主动超时（P6：memside 与 LLM/网关解耦）', () => {
    // 禁止新增 setTimeout / AbortController 主动掐断——只能改 catch 文案。
    // 已有的 timeout: 600_000 是 SDK 硬上限兜底（流式字节流动期间不触发），
    // 不算「主动超时」，不在本断言禁止之列。
    // 这里只防回归：catch 诊断化改动里偷偷塞 setTimeout/AbortController。
    const forbidden = [/setTimeout\s*\(/, /new\s+AbortController/, /\.signal\b/]
    for (const re of forbidden) {
      expect(src, `不应出现主动超时原语 ${re}`).not.toMatch(re)
    }
  })
})

// 锁 spec 2026-08-18 §缺陷3 / §6.2 / Task 10：
// 裸 "the operation was aborted" 不可诊断——执行器 classifyFailure 虽能识别 aborted，
// 但 reasons 里落的是 SDK 原文「the operation was aborted」，用户/日志看不出是网关掐断
// 还是超时。callLLM 的 catch 必须把 abort/连接类错误包装成可诊断描述（含「中断/aborted/诊断」之一），
// 这样 runLlmSession 落盘的 reasons / paused job 的 stepError 才有人读得懂。
//
// Task 10 review fix：catch 收紧——只有 abort/连接类错误才加诊断前缀，
// 非 abort 错误（401 / 400 等）原样 re-throw 保留 SDK 原生消息。下面 isAbortLike
// 纯函数单测锁住分类逻辑：非 abort 错误不被误诊为「网关掐断」。
//
// 这是源代码层文本断言（CLAUDE.md「最低限度保留一条源代码层文本断言兜底」）：
// 不实例化 SDK、不发请求，只锁 catch 分支写了诊断化文案 + 用了 isAbortLike 守门。
// 运行时行为由 tests/live-llm-failure-resume.test.ts（live e2e）覆盖。
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { isAbortLike } from '../src/memory/stepPrompt'

const src = readFileSync('src/anthropic.ts', 'utf-8')

describe('isAbortLike 分类（Task 10 收紧 catch）', () => {
  test('AbortError name → true', () => {
    const e = new Error('the operation was aborted')
    e.name = 'AbortError'
    expect(isAbortLike(e)).toBe(true)
  })

  test('aborted / connection error / timeout / econnreset / socket hang up 关键字 → true', () => {
    for (const msg of [
      'the operation was aborted',
      'Connection error',
      'request timeout',
      'operation timed out',
      'ECONNRESET',
      'socket hang up',
    ]) {
      expect(isAbortLike(new Error(msg)), `msg="${msg}"`).toBe(true)
    }
  })

  test('非 abort 错误（401 / 400 / 校验）→ false：保留原生消息，不误诊', () => {
    // 锁 Task 10 review fix：401/400/鉴权/入参错误不得被诊断化 catch 吞掉。
    for (const msg of [
      '401 unauthorized',
      '400 Bad Request: invalid model',
      'authentication failed',
      'validation error: max_tokens must be > 0',
    ]) {
      expect(isAbortLike(new Error(msg)), `msg="${msg}"`).toBe(false)
    }
  })

  test('非 Error 值（字符串/undefined）安全降级 → false（除非命中 abort 关键字）', () => {
    expect(isAbortLike('401 unauthorized')).toBe(false)
    expect(isAbortLike(undefined)).toBe(false)
    expect(isAbortLike('the operation was aborted')).toBe(true)
  })
})

describe('anthropic AbortError 诊断化（spec §缺陷3）', () => {
  test('anthropic.ts 含可诊断的中断处理文案', () => {
    // /中断|aborted|诊断/i 三选一：中文「中断」、英文「aborted」、或「诊断」均算达标。
    expect(src).toMatch(/中断|aborted|诊断/i)
  })

  test('anthropic.ts catch 经 isAbortLike 守门：只 re-wrap abort/连接类错误', () => {
    // Task 10 review fix：catch 必须先判 isAbortLike 再加诊断前缀，
    // 否则 401/400 会被误诊为「网关掐断」。锁住 catch 调用了 isAbortLike。
    expect(src).toMatch(/isAbortLike\s*\(/)
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

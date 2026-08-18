// 锁 spec 2026-08-18 §5.3：失败分类决定追问措辞。incomplete=接着回，
// format=格式不对，aborted=重发。三类必须可区分。
import { describe, expect, test } from 'bun:test'
import { buildFollowupPrompt, classifyFailure } from './stepPrompt'
import type { DistillStep } from './stepState'

const step: DistillStep = 'judge'

describe('stepPrompt 追问措辞', () => {
  test('incomplete: 带上轮回复要求接着回', () => {
    const s = buildFollowupPrompt('incomplete', '{"verdicts":[{"index":0', step)
    expect(s).toContain('接着')
    expect(s).toContain('{"verdicts":[{"index":0')
  })

  test('format: 提示格式不对 + JSON 模板提醒', () => {
    const s = buildFollowupPrompt('format', 'not json at all', step)
    expect(s).toContain('格式')
    expect(s).toContain('JSON')
  })

  test('aborted: 提示上次中断需重新输出', () => {
    const s = buildFollowupPrompt('aborted', '', step)
    expect(s).toContain('中断')
    expect(s).toContain('重新输出')
  })

  test('三类追问互斥（不含对方关键词）', () => {
    const inc = buildFollowupPrompt('incomplete', 'x', step)
    const fmt = buildFollowupPrompt('format', 'x', step)
    const abt = buildFollowupPrompt('aborted', 'x', step)
    expect(inc).not.toContain('格式')
    expect(fmt).not.toContain('中断')
    expect(abt).not.toContain('接着')
  })
})

describe('classifyFailure 失败分类', () => {
  test('AbortError / aborted 关键字 → aborted', () => {
    expect(classifyFailure(new Error('the operation was aborted'), null)).toBe('aborted')
    expect(classifyFailure(new Error('Request aborted'), null)).toBe('aborted')
  })

  test('Connection error / timeout 关键字 → aborted', () => {
    expect(classifyFailure(new Error('Connection error.'), null)).toBe('aborted')
  })

  test('有响应但非法 JSON → format', () => {
    expect(classifyFailure(null, 'not json')).toBe('format')
    expect(classifyFailure(new Error('Unexpected token'), '{"bad')).toBe('format')
  })

  test('有响应且像 JSON 但截断（缺闭合括号）→ incomplete', () => {
    expect(classifyFailure(null, '{"verdicts":[{"index":0}')).toBe('incomplete')
  })

  test('无响应无异常兜底 → aborted', () => {
    expect(classifyFailure(null, '')).toBe('aborted')
    expect(classifyFailure(null, null)).toBe('aborted')
  })
})

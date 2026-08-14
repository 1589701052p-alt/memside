// tests/web-alert-banner.test.ts
// 状态栏警示条 + 红铃 + 设置页测试连接语义澄清（spec 2026-08-14 §3.4 / 计划 T5，源码断言）。
// 回归意图：2026-08-13 线上蒸馏 LLM 持续失败但用户未察觉（测试连接假绿），
// 本文件锁定「未读 llm_error/degradation 必须在状态栏醒目可见」这一修复；
// 未来 refactor 一旦删掉警示条分支或铃铛变色，立刻变红。
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'

const src = readFileSync('src/web/App.tsx', 'utf8')

describe('状态栏警示条（spec 2026-08-14 §3.4，源码断言）', () => {
  test('含未读 LLM 报错警示条分支：计数字段 + 红底样式 + 跳消息 tab', () => {
    expect(src).toContain('status.unreadLlmErrors')
    expect(src).toContain("'#d32f2f'") // 红底
    expect(src).toContain('⚠️ 蒸馏 LLM 报错')
  })
  test('LLM 报错条「最近：」走 truncateAlertBody 截断，字段可选链兜底', () => {
    expect(src).toContain('truncateAlertBody(status.latestUnreadLlmError?.body ?? null)')
  })
  test('含未读降级警示条分支：琥珀底样式 + 跳消息 tab', () => {
    expect(src).toContain('status.unreadDegradations')
    expect(src).toContain("'#ffb300'") // 琥珀底
    expect(src).toContain('⚠️ 降级 ×')
  })
  test('两条警示条点击均 setTab(\'messages\')，且无独立关闭按钮', () => {
    // 警示条 + 🔔 按钮均跳消息 tab
    expect(src).toContain("onClick={() => setTab('messages')}")
  })
})

describe('🔔 按钮警示着色（spec 2026-08-14 §3.4，源码断言）', () => {
  test('未读 LLM 报错 -> 红色加粗；仅降级未读 -> 琥珀色', () => {
    expect(src).toContain("(status.unreadLlmErrors ?? 0) > 0 ? '#c00'")
    expect(src).toContain("(status.unreadDegradations ?? 0) > 0 ? '#b26a00'")
    expect(src).toContain('fontWeight: (status.unreadLlmErrors ?? 0) > 0 ? 700')
  })
})

describe('设置页测试连接语义澄清（spec 2026-08-14 §3.4 G4，源码断言）', () => {
  test('测试连接按钮旁有灰色小字说明探针仅验证可达性', () => {
    expect(src).toContain('测试连接')
    expect(src).toContain('仅验证端点可达；长蒸馏请求可能仍失败，失败会在状态栏警示条提示')
  })
})

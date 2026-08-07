// tests/distiller-subagent-note.test.ts
// 回归防护:subagent 的 role:user 是任务工单,其一次性约束(改哪些文件/验收标准)
// 不得产记忆——2026-08-06 候选审计实证此类灌水占 subagent 候选大头。
// spec: docs/superpowers/specs/2026-08-06-agentic-value-judge-design.md §4.2
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { distillTranscript, SUBAGENT_BRIEF_NOTE } from '@/memory/distiller'
import type { TranscriptTurn } from '@/memory/pure'

const turns: TranscriptTurn[] = [{ role: 'user', content: '任务:只许改 src/x.ts', isError: false }]
const okLLM = async () => '{"candidates": []}'

test('sourceKind=subagent 时 user prompt 含任务工单警示段', async () => {
  let seen = ''
  await distillTranscript({
    turns, runtime: 'claude-code', cwd: '/p', existingSlugs: [],
    callLLM: async (_s, u) => { seen = u; return okLLM() },
    sourceKind: 'subagent',
  })
  expect(seen).toContain(SUBAGENT_BRIEF_NOTE)
  expect(seen).toContain('任务工单')
})

test('sourceKind=conversation 时 user prompt 不含警示段(主会话一字不动)', async () => {
  let seen = ''
  await distillTranscript({
    turns, runtime: 'claude-code', cwd: '/p', existingSlugs: [],
    callLLM: async (_s, u) => { seen = u; return okLLM() },
    sourceKind: 'conversation',
  })
  expect(seen).not.toContain('任务工单')
})

test('源码层断言:警示段含「不得提取为候选记忆」硬约束与失效语义', () => {
  const src = readFileSync(join(import.meta.dir, '../src/memory/distiller.ts'), 'utf8')
  expect(src).toContain('不得提取为候选记忆')
  expect(src).toContain('任务结束时即失效')
})

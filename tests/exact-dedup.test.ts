// tests/exact-dedup.test.ts
// 回归防护:本文件锁「逐字去重只合并规范化后逐字相同的标题」——
// 审计实证(parseTranscriptFile 前缀组 9 条实为多个不同事实),模糊匹配必误杀。
// spec: docs/superpowers/specs/2026-08-06-agentic-value-judge-design.md §4.1
import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { openDb } from '@/db/client'
import { normalizeTitleForDup, findExactDuplicates, exactDedupCandidates } from '@/memory/exactDedup'
import { createCandidate } from '@/memory/store'
import type { DistillCandidate } from '@/memory/distiller'

const cand = (title: string, scopeType: 'project' | 'global' = 'project'): DistillCandidate => ({
  title, bodyMd: 'b', scopeType, runtime: 'claude-code',
  distillAction: 'new', origin: 'agent-observed', evidence: null, subjectSlug: null,
})

test('normalizeTitleForDup: 去前缀/标点/空白/大小写后逐字相同', () => {
  const a = normalizeTitleForDup('[category:convention] 每个 PR 必须在 CHANGELOG.md 的 Unreleased 段添加一条条目')
  const b = normalizeTitleForDup('[category:process] 每个PR必须在CHANGELOG.md的Unreleased段添加一条条目')
  expect(a).toBe(b)
  expect(a).not.toBe(normalizeTitleForDup('[category:convention] 每个 PR 必须更新 CHANGELOG'))
})

test('findExactDuplicates: 同批重复留最早,其余进 drops', () => {
  const drops = findExactDuplicates(
    [cand('[category:a] 同一条规则 X'), cand('[category:b] 同一条规则 X'), cand('[category:a] 不同规则 Y')],
    [],
  )
  expect(drops).toEqual([{ index: 1, matchedExisting: false }])
})

test('findExactDuplicates: 与存量重复(含大小写/前缀差异)命中 matchedExisting', () => {
  const drops = findExactDuplicates(
    [cand('[category:b] 已审批过的规则 Z')],
    ['[category:a] 已审批过的规则 Z'],
  )
  expect(drops).toEqual([{ index: 0, matchedExisting: true }])
})

test('findExactDuplicates: 标题相近但内容不同,绝不合并(误杀回归锁)', () => {
  const drops = findExactDuplicates(
    [cand('[category:architecture] parseTranscriptFile 采用从不抛出设计保护收集器热路径'),
     cand('[category:architecture] parseTranscriptFile 跳过 tool_use 行导致缺乏工具上下文')],
    [],
  )
  expect(drops).toEqual([])
})

// --- DB 接线测试(种子模式同 store-crud.test.ts) ---
const root = join(import.meta.dir, '.tmp-exact-dedup')
let dir = ''
let db: ReturnType<typeof openDb>
beforeAll(() => { rmSync(root, { recursive: true, force: true }); mkdirSync(root, { recursive: true }) })
beforeEach(() => { dir = join(root, Math.random().toString(36).slice(2)); mkdirSync(dir, { recursive: true }); db = openDb(join(dir, 't.db')) })
afterEach(() => { db.$client.close() })

test('exactDedupCandidates: 跨批对同 scope 存量(candidate+approved)查重', async () => {
  await createCandidate(db, {
    scopeType: 'project', scopeId: '/proj', title: '[category:a] 存量规则 W', bodyMd: 'b',
    tags: [], sourceKind: 'conversation', sourceCwd: '/proj', runtime: 'claude-code',
  })
  const { kept, drops } = await exactDedupCandidates(db,
    [cand('[category:b] 存量规则 W'), cand('[category:a] 全新规则 V')], '/proj')
  expect(kept.map((c) => c.title)).toEqual(['[category:a] 全新规则 V'])
  expect(drops).toHaveLength(1)
  expect(drops[0]!.matchedExisting).toBe(true)
})

test('exactDedupCandidates: global 候选只跟 global 存量比,不串 project', async () => {
  await createCandidate(db, {
    scopeType: 'project', scopeId: '/proj', title: '[category:a] 同名规则 G', bodyMd: 'b',
    tags: [], sourceKind: 'conversation', sourceCwd: '/proj', runtime: 'claude-code',
  })
  const { kept } = await exactDedupCandidates(db, [cand('[category:a] 同名规则 G', 'global')], '/proj')
  expect(kept).toHaveLength(1)  // project 存量的同名不阻挡 global 候选
})

import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// 源码层兜底断言（CLAUDE.md「运行时巨型组件难直接覆盖时最低限度保留一条源代码层
// 文本断言」）。React 组件 App.tsx 不单测；排序算法本身已在 tests/ui-utils.test.ts
// 覆盖。本测试锁住「App.tsx 用 sortCandidatesByTime 接线、且旧的 priorityRank
// 价值排序 comparator 已移除」，防止未来 refactor 静默回退到价值排序而无感知。
// 设计依据：docs/superpowers/specs/2026-07-27-candidate-time-sort-design.md §7。

const APP_SRC = readFileSync(join(import.meta.dir, '..', 'src', 'web', 'App.tsx'), 'utf8')

test('App.tsx 候选排序接线：用 sortCandidatesByTime，旧 priorityRank comparator 已移除', () => {
  expect(APP_SRC).toContain('sortCandidatesByTime')
  expect(APP_SRC).not.toContain('priorityRank(a.valueClass) - priorityRank(b.valueClass)')
})

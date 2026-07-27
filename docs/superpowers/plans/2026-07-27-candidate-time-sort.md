# 候选记忆时间展示与倒序排序 - 任务计划

设计 spec：`docs/superpowers/specs/2026-07-27-candidate-time-sort-design.md`

## 任务分解

### Task 1：抽纯函数 + 单测
- 新建 `src/web/ui-utils.ts`：导出 `formatMemoryTime(ts)` 与 `sortCandidatesByTime<T>(items)`（签名见 spec §3.1）。
  - `formatMemoryTime`：`ts == null` 或 `!Number.isFinite(ts)` → `''`；否则 `new Date(ts).toLocaleString()`。
  - `sortCandidatesByTime`：`[...items].sort((a,b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))`，返回新数组。
- 新建 `tests/ui-utils.test.ts`：
  - `formatMemoryTime`：合法 ts 非空且含 4 位年；`undefined`/`null`/`NaN`/`Infinity`/`-Infinity` → `''`。
  - `sortCandidatesByTime`：三 ts 倒序；缺值排尾；全缺值稳定；输入不 mutate；负 ts 按数值排。
- 验收：`bun test tests/ui-utils.test.ts` 全绿；`bun run typecheck` 干净。

### Task 2：接入 App.tsx
- `App.tsx` import `formatMemoryTime`、`sortCandidatesByTime`。
- `candidates`（行 75-77）改为 `sortCandidatesByTime(items.filter((i) => i.status === 'candidate'))`，删除价值排序 comparator。
- `MemoryCard` 元信息行（行 228-230）：`const time = formatMemoryTime(m.createdAt)`，非空时追加 ` · {time}`。
- 保留 `priorityRank`（`bulkRejectUnevaluated` 仍用）、`valueBadge`（仍显示）。
- 验收：手动启 `bun run dev:web`，候选卡片显示时间、顺序最新在前、价值徽标仍在、批量拒绝未评估仍可用；`bun run typecheck` 干净。

### Task 3：源码层兜底断言
- 新建 `tests/ui-sort-source.test.ts`：读 `src/web/App.tsx` 源码文本，断言含 `sortCandidatesByTime`、不含 `priorityRank(a.valueClass) - priorityRank(b.valueClass)`。顶端注释说明：锁排序方式防回退（链接 spec §7）。
- 验收：`bun test` 全绿。

## 依赖关系
Task 1 → Task 2（App 引用纯函数）→ Task 3（断言 App 源码）。

## 验收清单
- [ ] 候选卡片显示 `createdAt` 本地化时间。
- [ ] 候选列表按时间倒序；价值排序 comparator 已移除。
- [ ] 价值徽标仍显示；`bulkRejectUnevaluated` 仍按未评估筛选。
- [ ] `formatMemoryTime` / `sortCandidatesByTime` 纯函数测试覆盖正向/边界/错误。
- [ ] 源码层兜底断言锁定排序方式。
- [ ] `bun run typecheck && bun test` 全绿。
- [ ] spec + plan 落档；`.superpowers/sdd` 已清理。
- [ ] 从 origin/master 切分支，PR 目标 master。

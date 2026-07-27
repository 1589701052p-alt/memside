# 候选记忆时间展示与倒序排序设计

## 1. 背景

Web UI 审批队列（`src/web/App.tsx`）的候选记忆卡片当前**不显示任何时间**，且候选列表按**价值优先级**排序（PR #9：decision/convention → trap/topology → 未评估，见 `App.tsx:75-77` 的 `priorityRank` comparator）。用户希望看到每条候选的时间，并按时间倒序（最新在前）浏览。

### 1.1 数据链路已通（无需改数据/API/schema）

- `memories.created_at`（Unix ms，`src/db/schema.ts:28`）由 `createCandidate` 写 `Date.now()`（`src/memory/store.ts:77,85`），`NOT NULL`，且有索引 `idx_memories_status_created`。
- 服务端 `/api/memories`（`src/server.ts:186-189`）已 `orderBy(desc(memories.createdAt))`，`c.json({ items: rows })` 直接序列化 Drizzle 原始行（camelCase 键），故响应里**已有 `createdAt`**。
- `MemoryItem.createdAt?: number`（`src/web/api.ts:24`）已声明。前端只是没用它。

### 1.2 `createdAt` 语义

候选行入库时刻 = distill 完成写出候选的时刻（**非**原始对话发生时刻；distill 异步，二者间隔通常 15-30s）。对"候选记忆时间"展示而言，"它何时出现在队列里"是最自然、且唯一现成可用的每候选时间戳。取原始对话时刻需新管道（读 `memory_distill_events.ts`），非本次范围。

## 2. 目标 / 非目标

### 目标
- 每张候选卡片显示 `createdAt` 格式化时间。
- 候选列表按 `createdAt` 倒序（newest first），**完全替换**现有价值优先级排序。
- 价值徽标（`valueBadge`）仍显示，只是不再决定顺序。

### 非目标
- 不改 schema / API / store（`createdAt` 已端到端可用）。
- 不改服务端排序（已 createdAt DESC）。
- 不显示"原始对话时刻"。
- 不动 `bulkRejectUnevaluated`（仍按 `priorityRank===2` 选未评估条目，与列表排序正交）。
- 不动已审批/归档等非候选视图。

## 3. 接口契约

### 3.1 纯函数（新文件 `src/web/ui-utils.ts`）

抽两个纯函数，便于单测（CLAUDE.md「首选可断言面 = 纯函数层」）：

```ts
// undefined / null / NaN / 非有限数 -> ''（绝不返回 "Invalid Date"）
// 否则 -> new Date(ts).toLocaleString()（用户本地时区）
export function formatMemoryTime(ts: number | undefined | null): string

// 按 createdAt 倒序，缺值排尾；返回新数组，不 mutate 输入
export function sortCandidatesByTime<T extends { createdAt?: number }>(items: T[]): T[]
// 实现：[...items].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
```

### 3.2 排序接入（`App.tsx:75-77`）

现状：
```ts
const candidates = items
  .filter((i) => i.status === 'candidate')
  .sort((a, b) => priorityRank(a.valueClass) - priorityRank(b.valueClass))
```
改为：
```ts
const candidates = sortCandidatesByTime(items.filter((i) => i.status === 'candidate'))
```

> 服务端虽已 `orderBy(desc(createdAt))`，前端 filter 后仍显式 sort：保证语义独立于服务端顺序、且对缺值兜底排尾。

### 3.3 时间展示（`MemoryCard`，`App.tsx:228-230` 元信息行）

在 `<small>` 元信息行追加时间片段。先算 `const time = formatMemoryTime(m.createdAt)`，非空才渲染 `· {time}`。缺值不显示，避免空碎片。

## 4. 数据流

不动数据流。`/api/memories` → `listMemories` → `items` → `candidates`(filter + `sortCandidatesByTime`) → `MemoryCard` 读 `m.createdAt` 调 `formatMemoryTime`。

## 5. 与现有模块耦合点

- `priorityRank`（`App.tsx:17-21`）：**保留**。`bulkRejectUnevaluated`（行 66-73）仍用它筛选未评估条目；候选列表排序不再调它。
- `valueBadge`（`App.tsx:14-16`）：保留，卡片仍显示徽标。
- 服务端 `listMemories` 排序（`server.ts:187`）：不动。
- `MemoryItem` 类型（`api.ts`）：不动。

## 6. 失败模式

- `createdAt` 缺失（schema `NOT NULL`，理论上不会；但 TS 类型可选 + 防御）：排序兜底为 0（排尾），展示兜底为不显示。不抛错。
- 时区：`toLocaleString()` 走用户本地时区，符合"显示给用户看"预期，无需服务端时区协商。
- 轮询覆盖：3s 轮询 `setItems` 全量替换；排序在 render 期纯函数算，每次一致，无闪烁错位。
- `sortCandidatesByTime` 不 mutate 输入（拷贝后再 sort），避免污染 `items` state。

## 7. 测试策略

纯函数层（`tests/ui-utils.test.ts`）：
- `formatMemoryTime`：合法 ts → 非空字符串且含 4 位年成分；`undefined`/`null`/`NaN`/`Infinity` → `''`。
- `sortCandidatesByTime`：正向（三不同 ts → 倒序）；边界（缺值条目排尾、全缺值稳定不抛）；非 mutate（输入数组不变）；错误路径（负数 ts 仍按数值排）。

UI 层兜底（CLAUDE.md「运行时巨型组件难直接覆盖时最低限度保留一条源代码层文本断言」）：
- `tests/ui-sort-source.test.ts`：读 `src/web/App.tsx` 源码，断言含 `sortCandidatesByTime` 调用、且**不含**旧 comparator `priorityRank(a.valueClass) - priorityRank(b.valueClass)`。锁住"排序方式 = 时间倒序"，防未来 refactor 静默回退到价值排序。测试顶端注释说明意图。

# 实现计划：subagent 直连路径取证（方案 A）

设计 spec：`docs/superpowers/specs/2026-08-17-subagent-transcript-path-diag-design.md`。本计划按 spec 落地，4 个任务，每任务独立可测、可由 subagent 实现（implementer）+ 复核（reviewer）。

基线：origin/master HEAD `477a19e`。运行门槛：`bun run typecheck && bun test` 全绿才能 push。

---

## Task 1：`SubagentResolveDiag` 扩两字段 + `resolveSubagentTranscript` 加第三参数

**文件**：`src/claude/transcript.ts`

**改 `SubagentResolveDiag` 接口**（spec §接口契约）：在 `subagentsDirEntries` 后追加
```ts
  /** payload 的 agent_transcript_path 直连路径值；payload 无此字段/调用方未传为 null */
  agentTranscriptPath: string | null
  /** agentTranscriptPath 存在且为文件；null 路径恒 false */
  agentTranscriptPathExists: boolean
```

**改 `resolveSubagentTranscript` 签名**：第三参数 `agentTranscriptPath?: string | null`。

**改 diag 初始值**（`resolveSubagentTranscript` body 起始的 diag 对象字面量）：追加
```ts
    agentTranscriptPath: null, agentTranscriptPathExists: false,
```

**改 try 块**（在 `subagentsDirEntries` 赋值之后、`if (subPath && existsSync(subPath))` 之前——spec §取证逻辑，仅记取证不改控制流）：
```ts
    diag.agentTranscriptPath = typeof agentTranscriptPath === 'string' && agentTranscriptPath ? agentTranscriptPath : null
    diag.agentTranscriptPathExists = !!diag.agentTranscriptPath && existsSync(diag.agentTranscriptPath)
```

**约束**：
- 第三参数可选 → 已有调用点（server.ts SubagentStop 分支之外的，若有测试 mock）不传时行为与旧版逐字节一致。
- 取证两字段**仅赋值**，不参与 derivedExists/turns 决策。
- existsSync 已 import（同文件 `mainTranscriptExists` 用过），无需新 import。

**验收**：
- `bun run typecheck` 干净（`SubagentResolveDiag` 两新字段类型对齐，第三参数可选）。
- 现有 transcript 测试不回归（不传第三参数 → 行为不变）。

**测试**（本任务的纯函数测试，落 `tests/subagent-resolve.test.ts` 或既有 transcript 测试文件——先查仓库已存在的 subagent 测试文件名，复用而非新建）：
- 覆盖 spec 测试策略 #1–#4（直连路径存在/不存在/缺省/derivedPath 存在四态的 diag 断言）。
- 用 tmp 文件构造真实存在路径（`bun:sqlite` 风格的 tmpdir + 写一个 `.jsonl`）。
- 向后兼容回归锁：第三参数缺省时 derivedExists/turns/derivedPath 与旧版逐字节一致。

**交付物**：transcript.ts 改动 + 测试文件。implementer 完成后 reviewer 复核约束（取证不进决策、第三参数可选、两字段初始 null/false）。

---

## Task 2：SubagentStop handler 透传 `agent_transcript_path`

**文件**：`src/server.ts`（SubagentStop 分支，约 312–335 行）

**改**（spec §SubagentStop handler）：
- 在 `const agentId` / `const transcriptPath` 之后加：
  ```ts
  const agentTranscriptPath: string = body.agent_transcript_path ?? ''
  ```
- 把 `resolveSubagentTranscript(transcriptPath, agentId)` 改为 `resolveSubagentTranscript(transcriptPath, agentId, agentTranscriptPath)`。

**约束**：
- `body.agent_transcript_path` 缺失时 `?? ''` → 传空串 → Task 1 的 diag 判空 → null/false（与旧版行为一致）。
- 不改 detail 拼接（`JSON.stringify({ ...diag, payloadKeys })` spread 自动带出两新字段）。
- 不改判断逻辑（仍 `turns.length > 0 ? 蒸馏 : 降级`）。
- `body` 的类型若是 inline 接口（server.ts:234 附近 `transcript_path?: string; ... agent_id?: string`），把 `agent_transcript_path?: string` 加进去（若已是 `Record<string,unknown>` 或宽松类型则无需改类型）。

**验收**：
- `bun run typecheck` 干净。
- 现有 server 测试不回归。

**测试**：
- spec 测试策略 #7 源码层文本断言：server.ts SubagentStop 分支调用 `resolveSubagentTranscript` 传了 `agentTranscriptPath`（grep 级，防未来 refactor 丢第三参数）。
- 若既有 server.test.ts 有 SubagentStop 用例，补一例：mock body 带 `agent_transcript_path` → 降级 detail 含 `agentTranscriptPath` 值（端到端验证透传到位）。若无既有用例，最低保留文本断言。

**交付物**：server.ts 改动 + 测试。reviewer 复核透传正确 + detail 自动带新字段。

---

## Task 3：取证的端到端断言 + 直连路径优先信号锁

**目的**：锁定 spec §测试策略 #1 的核心价值——"直连路径存在但 derivedPath 不存在"时 diag 如实记录 `agentTranscriptPathExists:true`，这是未来转方案 B/修读路径的判据，必须在测试里钉死。

**文件**：tests/（Task 1 测试文件，或独立 `tests/subagent-resolve-diag.test.ts`）

**测试**：
1. 构造 tmp 主会话 transcript + tmp subagent 直连文件（放与 derivedPath **不同**的位置，模拟 claude code 用了不同落盘位置）。
2. `resolveSubagentTranscript(主transcriptPath, agentId, 直连路径)`：
   - 断言 `diag.derivedExists === false`（推导路径不存在）；
   - 断言 `diag.agentTranscriptPath === 直连路径`；
   - 断言 `diag.agentTranscriptPathExists === true`（直连路径真实存在）；
   - 断言 `turns.length === 0`（仍未切到读直连路径，走降级）。
3. 反向锁：直连路径也不存在时 `agentTranscriptPathExists === false`。

**验收**：测试红能复现"补丁缺失"（删 Task 1 的两赋值行 → 断言失败），绿能锁住取证行为。

**交付物**：测试文件。reviewer 复核断言精度（钉的是 diag 两字段而非 turns，避免误锁行为）。

---

## Task 4：终审 + 验证门槛

**动作**：
1. `bun run typecheck && bun test` 全绿（记录通过数 vs 基线 477a19e）。
2. 全分支 code-review（`/code-review` 或 whole-branch review）：0 Critical / 0 Important，deferred minor 记 ledger。
3. 复核 spec 非目标未越界：未静默 phantom、未改判断逻辑、未改 UI、未修读路径逻辑、无 schema 迁移、无新依赖。
4. commit + push + 开 PR 到 master（标题 `feat(claude): subagent transcript 直连路径取证（方案 A）`）。

**验收**：PR 绿、review 通过。STATE.md「2026-08-15 上线观测 #2」回填一句"取证补丁已落，待 1–2 天观测 diag 后转方案 B 或修读路径"（可选，PR 内或单独 docs commit）。

---

## 任务依赖

- Task 1 → Task 2（server 依赖新签名）→ Task 3（端到端依赖 1+2 落地）→ Task 4（终审全分支）。
- Task 1/2 可由 implementer 顺序做（同一 transcript/server 两文件，串行避免冲突）；Task 3 在 1+2 后；Task 4 最后。

## subagent-driven 执行参数

- implementer：sonnet（小改动，sonnet 足够）。
- reviewer：sonnet（约束裁决，非难题）。
- Task 1、2、3 各一个 implementer+reviewer 往返；Task 4 由 controller（本会话）直接核验 + 开 PR。
- 每个 implementer 任务 prompt 含：本计划对应 Task 全文 + spec 文件路径 + 约束（取证不进决策、不改判断逻辑、向后兼容、`bun run typecheck && bun test` 门槛）。
- reviewer prompt 含：Task 全文 + 验收清单 + spec 非目标清单（防越界）。

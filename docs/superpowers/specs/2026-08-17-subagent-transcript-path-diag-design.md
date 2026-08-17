# subagent 直连路径取证（方案 A）

## 背景

诊断 memside "subagent_transcript_missing" 降级（STATE.md「2026-08-15 上线观测 #2」排队项）时发现一个取证盲点：

claude code 的 SubagentStop payload **携带 `agent_transcript_path` 直连字段**（`payloadKeys` 证实，5/5 phantom 均含此键），但 memside 的 `resolveSubagentTranscript`（`src/claude/transcript.ts:221`）只用 `transcript_path`（主会话路径）+ `agent_id` **自己推导**子 agent 路径（`subagentFilePathFromPayload`，`transcript.ts:184`），从未读取 `agent_transcript_path` 的值。diag 只记了 `payloadKeys`（键名清单），没记字段值——所以无法验证"claude code 给的直连路径指向的文件在不在"。

近期 5 条 phantom 降级（agentId `a8f5855a…`/`a0d1659d…`/`a28ce0df…`/`a0e5a1c8…`/`ab0bc003…`），复核结论：
- 它们的 agentId 在"事后"（数小时后）的 subagents 目录、整个 `~/.claude` 树、所有会话 transcript 内容里**都查无此人**（最可能是 claude code 对后台/被中断子 agent 发了 SubagentStop 但从未写其对话文件）；
- 文件产出确实有延迟（一个会话发生时 15 个 jsonl，事后 44 个），但这 5 个 phantom 事后也没出现——非延迟问题；
- **未排除的口子**：memside 没读 `agent_transcript_path` 值，无法证明"直连路径指向的文件也不存在"。理论上 claude code 对异常子 agent 可能用了不同的落盘位置，memside 找错地方误报幽灵。

本需求是**一次性取证补丁**：把 `agent_transcript_path` 的实际值 + 它指向文件的存在性记进降级 diag，下次再冒 phantom 时一锤定音（直连路径也不存在 = 真幽灵，可安心静默；直连路径存在 = 找错地方的真 bug，需修读路径逻辑）。

## 目标 / 非目标

### 目标
1. `resolveSubagentTranscript` 接收 `agentTranscriptPath`（payload 的直连路径），对它 `existsSync` 并记进 diag。
2. diag 的 `SubagentResolveDiag` 结构新增 `agentTranscriptPath`（值）+ `agentTranscriptPathExists`（存在性）两字段。
3. SubagentStop handler（`server.ts:319`）把 `body.agent_transcript_path` 透传给 `resolveSubagentTranscript`。
4. 降级通知 `detail`（`server.ts:329`，`JSON.stringify({ ...diag, payloadKeys })`）自动带出新字段（spread diag，无需改 detail 拼接）。

### 非目标
- **不改判断逻辑**：仍是"derivedPath 存在且为文件才蒸馏；缺失/为空写降级"。直连路径**仅取证，不参与是否蒸馏的决策**（避免在取证阶段引入行为变更，污染观测）。
- **不改 UI**：降级通知的展示不变（detail 里多两 JSON 键，UI 不解析这两键，纯文本展示）。Web UI 不新增任何解析/渲染。
- **不静默 phantom**：那是方案 B，等本补丁观测一两天出结论后再独立 brainstorming。
- **不修读路径逻辑**：即便直连路径存在，本补丁也不切换到用直连路径读文件——保持观测纯净。修读路径是观测后可能的事，独立 spec。

## 接口契约

### `resolveSubagentTranscript`（`src/claude/transcript.ts`）

签名从
```ts
function resolveSubagentTranscript(
  transcriptPath: string, agentId: string | null | undefined,
): { turns: TranscriptTurn[]; diag: SubagentResolveDiag }
```
改为
```ts
function resolveSubagentTranscript(
  transcriptPath: string, agentId: string | null | undefined,
  agentTranscriptPath?: string | null,
): { turns: TranscriptTurn[]; diag: SubagentResolveDiag }
```

第三参数可选（向后兼容：已有调用点不传则直连路径取证两字段为 null/false，行为与旧版逐字节一致）。

### `SubagentResolveDiag` 结构新增两字段

```ts
export interface SubagentResolveDiag {
  agentId: string
  transcriptPath: string
  derivedPath: string | null
  derivedExists: boolean
  derivedTurns: number
  mainTranscriptExists: boolean
  subagentsDirEntries: string[]
  // —— 新增（方案 A 取证）——
  /** payload 的 agent_transcript_path 直连路径值；payload 无此字段/调用方未传为 null */
  agentTranscriptPath: string | null
  /** agentTranscriptPath 存在且为文件；null 路径恒 false */
  agentTranscriptPathExists: boolean
}
```

### 取证逻辑（resolveSubagentTranscript body 内）

在推导路径分支之后、return 之前，**仅记取证、不改控制流**：

```ts
diag.agentTranscriptPath = typeof agentTranscriptPath === 'string' && agentTranscriptPath ? agentTranscriptPath : null
diag.agentTranscriptPathExists = !!diag.agentTranscriptPath && existsSync(diag.agentTranscriptPath)
```

放在 `try` 块内（existsSync 不会抛到能逃出 try 的程度；即便抛，外层 catch 兜底返回空 turns + diag，diag 两字段保持初始 null/false，契约不破）。

### SubagentStop handler（`src/server.ts:319`）

```ts
const agentTranscriptPath: string = body.agent_transcript_path ?? ''
const { turns, diag } = resolveSubcriptTranscript(transcriptPath, agentId, agentTranscriptPath)
```

（`body.agent_transcript_path` 缺失时 `?? ''` → 传空串 → diag 内部判空 → null/false。）

## 数据流

```
claude code SubagentStop payload
  ├─ transcript_path  ──┐
  ├─ agent_id          ──┼──► resolveSubagentTranscript(transcriptPath, agentId, agentTranscriptPath)
  └─ agent_transcript_path ┘          │
                                      ├─ derivedPath = subagentFilePathFromPayload(transcriptPath, agentId)
                                      ├─ derivedExists = existsSync(derivedPath)
                                      ├─ agentTranscriptPath = payload 直连值 (新)
                                      ├─ agentTranscriptPathExists = existsSync(agentTranscriptPath) (新)
                                      └─ derivedExists ? 蒸馏 : 写降级(含 diag)
```

直连路径取证**不进入** derivedExists 分支判断——derivedPath 仍是唯一决策依据。

## 失败模式

1. **payload 无 `agent_transcript_path`**：`?? ''` → diag.agentTranscriptPath=null、agentTranscriptPathExists=false。与旧版行为逐字节一致（旧版无此字段，detail 多两个 `"agentTranscriptPath":null,"agentTranscriptPathExists":false` 键——这是期望的取证留痕，非 bug）。
2. **existsSync 抛**（路径畸形/权限）：被 try/catch 兜底，diag 两字段保持初始值，返回空 turns + 降级。契约不破。
3. **直连路径存在但 derivedPath 不存在**：本补丁**不切换到读直连路径**，仍走 derivedExists=false → 降级。但 diag 会如实记录 `agentTranscriptPathExists:true`——这正是要抓的"找错地方"信号，留给观测后独立修。

## 与现有模块的耦合点

- `src/claude/transcript.ts`：`resolveSubagentTranscript` + `SubagentResolveDiag`（主改）。
- `src/server.ts:312-335`：SubagentStop handler（透传第三参数）。
- 无 schema 迁移（diag 进 `notifications.body`/`memory_degradations.detail` 自由 text，无结构约束）。
- 无 UI 改动（detail 文本展示）。
- `subagentFilePathFromPayload`（`transcript.ts:184`）不动——derivedPath 推导逻辑保持。

## 测试策略

### 纯函数层（`tests/` 下，主战场）

1. **直连路径存在、derivedPath 不存在**：`resolveSubagentTranscript(tp, aid, '/real/agent.jsonl')`（用 tmp 真实文件）→ diag.agentTranscriptPath=该路径、agentTranscriptPathExists=true、derivedExists=false、turns=[]。**锁定"找错地方信号被如实记录"**（这是本补丁的核心价值断言）。
2. **直连路径不存在**：传一个不存在的路径 → agentTranscriptPathExists=false。
3. **payload 无直连路径（第三参数空串/undefined）**：agentTranscriptPath=null、agentTranscriptPathExists=false，且 derivedExists/turns 行为与旧版逐字节一致（向后兼容回归锁）。
4. **derivedPath 存在（正常路径）**：turns 非空、仍正常蒸馏；diag 两字段照样填（直连路径值 + existsSync 结果），不干扰主路径。
5. **直连路径 existsSync 抛**（传畸形路径如 `Buffer` 不可 stat 的）：被 try/catch 兜底，diag 两字段保持初始，契约不破。（若难构造抛错路径，最低保留源码层文本断言锁定两字段在 try 内被赋值。）

### 源码层文本断言（CLAUDE.md 运行时组件兜底面）

6. `tests/` 下加一条断言：`resolveSubagentTranscript` 源码含 `agentTranscriptPath` / `agentTranscriptPathExists` 赋值行（grep 级文本守卫，防未来 refactor 误删取证）。
7. `server.ts` 断言：SubagentStop 分支调用 `resolveSubagentTranscript` 时传了第三参数 `body.agent_transcript_path`（文本守卫）。

### 运行门槛

`bun run typecheck && bun test` 必须全绿才能 push。基线为 origin/master HEAD（477a19e）测试数。

## 上线后观测（硬要求，结论回填 STATE.md）

部署后跑 1–2 天，对照新 phantom 降级的 diag：
- 若 **agentTranscriptPathExists 恒 false**（直连路径也指向不存在的文件）→ 确认真幽灵，转方案 B（静默纯幽灵），独立 brainstorming。
- 若出现 **agentTranscriptPathExists=true 但 derivedExists=false** → 确认 memside 找错地方，开独立 spec 修读路径逻辑（直连路径优先于推导）。
- 记录直连路径的常见形态（与 derivedPath 是否同目录/同命名），辅助判断 claude code 是否对异常子 agent 用了不同落盘位置。

## 本补丁的过渡性声明

本补丁是**一次性取证工具**，不是根治。观测出结论后（方案 B 静默 或 修读路径），`agentTranscriptPath`/`agentTranscriptPathExists` 两字段的取证使命完成，可在那次改动里决定保留（长期诊断价值）或移除（避免 diag 膨胀）。本补丁不预先决定去留。

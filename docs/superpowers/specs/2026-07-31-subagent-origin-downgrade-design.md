# 设计 spec:subagent 蒸馏 origin 强制降级

日期:2026-07-31
分支:`fix/subagent-origin-downgrade`(基线 `origin/master`)

## 1. 背景

DB(`~/.memside/memside.db`)审计发现:52 条 `status='candidate'` 的候选记忆被标成
`origin='user-stated'`/`'user-confirmed'`(用户陈述 / 用户采纳),但实测其中 47 条
来自 `source_kind='subagent'` 的蒸馏任务。

根因:subagent 蒸馏任务的 transcript 里,`role:'user'` 不是真人,而是主 agent 派发的
英文 task brief(如 `You are implementing Task 1: opencode transcript 转换纯函数
## Task Description Read your task brief first: ...`)。机器给机器派活,与"用户陈述"
无关。但 `scheduler.ts:158` 调 `distillTranscript` 时没传来源信息,distiller 对所有来源
套用同一套 `user-stated` 语义,把主 agent 的 task 指令当成"用户陈述",evidence 里全是
英文 task 指令 / 代码片段 / spec 文本(52 条里只有 1 条是真用户原话)。

错标还带来连锁危害:`origin ∈ {user-stated, user-confirmed}` 的候选被两层特殊保护--

1. `valueFilter.ts:182` 代码兜底让 stated/confirmed **免疫 `derivable` 丢弃**;
2. `judgeValueBase` 失败兜底给 stated/confirmed 打 `valueClass='decision'`(`:156`/`:175`),
   非 null 的 valueClass **免疫 Web UI「批量拒绝未评估」按钮**(该按钮 target
   `value_class IS NULL`)。

于是错标候选被双重锁定,既不被自动丢,也不被批量清,只能逐条人工拒绝。

## 2. 目标 / 非目标

### 目标
- 新产出:subagent 蒸馏任务的候选 `origin` 一律强制降级为 `'agent-observed'`(确定性,
  零启发式)。
- 存量:把已入库的 `status='candidate' AND source_kind='subagent'` 行回填为
  `'agent-observed'`(evidence 保留作观察依据)。

### 非目标(本轮明确不做)
- 不做 evidence 回溯校验(用户判定为不稳定的启发式方案,否决)。
- 不做关键词扫描判 fleeting(同上,易误杀,否决)。
- 不改 DISTILLER_SYSTEM_PROMPT 的 origin 定义 / 不教模型区分"选项采纳"(prompt 调参,
  模型行为不可控,否决)。
- 不碰 valueFilter 逻辑 / stated 免疫兜底(它们对真正的主会话 user-stated 仍正确)。
- 不碰 `approved` / `rejected` 存量(范围限定 `candidate`);主会话侧 5 条
  `source_kind='conversation'` 错标留人工审批,不在本次范围。

## 3. 接口契约

### 3.1 `DistillInput` 新增字段(`src/memory/distiller.ts`)

```ts
export interface DistillInput {
  turns: TranscriptTurn[]
  runtime: 'claude-code' | 'opencode'
  cwd: string
  existingSlugs: string[]
  callLLM: LLMCall
  /** 来源类型。subagent -> 候选 origin 强制降级 agent-observed;可选,默认 'conversation'。 */
  sourceKind?: 'subagent' | 'conversation'
}
```

- **可选 + 默认 `'conversation'`**:全仓 27 个测试调用点都不传,强制必填要改 27 处
  fixture。默认 `'conversation'` 是安全方向--某个调用方忘了传,最坏退化为现有 buggy
  行为(不会变更糟);生产侧唯一调用方 scheduler 显式传。

### 3.2 `distillTranscript` 降级逻辑

在逐候选解析循环中,现有贴金防护之后加一行(`src/memory/distiller.ts:217` 之后):

```ts
// 现有贴金防护(spec §R1):摘不出原话就不许戴 stated/confirmed 帽子。
if (origin !== 'agent-observed' && evidence === null) origin = 'agent-observed'
// 新增:subagent 无真人交互,不配 stated/confirmed,强制降级。
if (input.sourceKind === 'subagent') origin = 'agent-observed'
```

- 放最后 = 最防御,subagent 覆盖一切,不被前面逻辑翻案。
- **evidence 不动**:LLM 摘的句子保留作"观察依据",只摘 origin 帽子。
- 确定性:一个相等判断,零启发式。

### 3.3 scheduler 接线(`src/scheduler.ts:158-164`)

`distillTranscript` 调用对象加一行,复用 `:186`/`:200` 已在用的谓词:

```ts
sourceKind: job.sourceAgentId ? 'subagent' : 'conversation',
```

不引入新判定逻辑,与现有 `sourceKind` 写入判断完全一致。

### 3.4 存量回填(`src/db/client.ts` 迁移块)

```sql
UPDATE memories SET origin = 'agent-observed'
WHERE source_kind = 'subagent' AND status = 'candidate'
```

- 放 client.ts 迁移块(跟现有
  `UPDATE memories SET source_cwd = scope_id WHERE scope_type='project'` 同模式),
  daemon 重启时自动跑。
- **天然幂等**:已是 `'agent-observed'` 的行不变,无需额外守卫。
- **范围限定 `candidate`**:只修待审队列。`approved` 的 origin 只影响 UI 徽标、不影响
  注入;`rejected` 无意义。
- **生效时机**:client.ts 迁移只在 daemon 重启时跑(与 STATE.md 已知债务 #4 同款);
  需重启 daemon 才落到存量。迁移应放在迁移序列中 `origin` 列 ALTER 之后(本列在
  7-30 origin-driven 落地时已加,这里只回填数据,不涉及 DDL)。

## 4. 数据流

```
主会话 Stop hook ─┐
                  ├─> enqueueDistillJob(sourceAgentId=null)
SubagentStop hook ┴─> enqueueDistillJob(sourceAgentId=<aid>)
                                    │
                                    ▼
scheduler.tick: job.sourceAgentId ?
  ├─ null   -> distillTranscript(sourceKind='conversation') -> stated/confirmed 保留
  └─ <aid>  -> distillTranscript(sourceKind='subagent')     -> 全部 origin='agent-observed'
                                                            │
                              ┌─────────────────────────────┘
                              ▼
                    judgeValue(候选, callLLM)
                    (agent-observed 不享受 derivable 免疫 / 失败兜底给 null)
```

## 5. 与现有模块的耦合点

- **distiller.ts**:`DistillInput` 加字段 + 降级一行。`DistillCandidate.origin` 类型不变,
  仍是 `DistillOrigin` 三值之一(只是 subagent 路径下取值被钳到 `'agent-observed'`)。
- **scheduler.ts**:调用对象加一行。`origin`/`evidence` 入库透传(`:208`/`:209`)不变;
  `sourceKind` 写入判断(`:186`/`:200`)不变。
- **valueFilter.ts**:不动。subagent 降级后的 `agent-observed` 候选走正常九分类,
  `agent-observed` 被判 `derivable` 时代码兜底不再改判 keep(`valueFilter.ts:182` 的
  `origin !== 'agent-observed'` 为 false),符合预期。
- **store.ts / schema.ts**:不动(`origin` 列 7-30 已存在)。
- **client.ts**:加一条回填 UPDATE(幂等)。
- **Web UI**:不动(origin 徽标对 `agent-observed` 已有显示分支)。

## 6. 失败模式

| 场景 | 行为 | 是否阻塞 |
|------|------|---------|
| scheduler 传 sourceKind 传错值 | TS 类型拦截(`'subagent'\|'conversation'`);运行时 distiller `=== 'subagent'` 不成立则当 conversation,不崩 | 否 |
| 测试调用方不传 sourceKind | 默认 `'conversation'`,现有行为不变 | 否 |
| 回填迁移重复执行 | 幂等,`agent-observed` 行不变 | 否 |
| 回填迁移遇到老行 origin IS NULL | `source_kind='subagent' AND status='candidate'` 的 NULL 行被设为 `'agent-observed'`(语义正确:未标注的 subagent 候选本就不该当 stated) | 否 |
| daemon 未重启 | 存量回填不生效;新产出逻辑也不生效(代码未部署)。已知约束,非 bug | 否 |

## 7. 测试策略

### 7.1 新单测(`tests/distiller.test.ts`)
1. **核心回归锁**:subagent + LLM 返回 `origin:'user-stated'` + 合法 evidence ->
   断言 `candidate.origin === 'agent-observed'` 且 `evidence` 保留。
2. **守默认方向**:不传 sourceKind + `origin:'user-stated'` + 合法 evidence ->
   仍 `'user-stated'`(锁 conversation 路径不变)。
3. **subagent 覆盖贴金已降级场景**:subagent + `origin:'user-confirmed'` + 空 evidence ->
   `'agent-observed'`(确认 subagent 标志在贴金防护之后仍生效)。

### 7.2 scheduler 集成测试(`tests/scheduler.test.ts`)
4. job 带 `sourceAgentId` -> 产出的候选 origin 全 `agent-observed`。

### 7.3 回填迁移测试(`tests/client-migration.test.ts` 或就近)
5. seed 一条 subagent candidate(origin=user-stated)-> 跑迁移 -> origin 翻
   `agent-observed`;再跑一次 -> 不变(幂等锁)。

### 7.4 回归
6. `bun run typecheck && bun test` 全绿(含既有 origin/evidence 测试不被破坏,
   由 sourceKind 默认 `'conversation'` 保证)。

## 8. 验收清单

- [ ] `DistillInput.sourceKind` 字段加好,可选默认 `'conversation'`。
- [ ] `distillTranscript` 在贴金防护后加 subagent 降级一行。
- [ ] `scheduler.ts` 调用传 `sourceKind: job.sourceAgentId ? 'subagent' : 'conversation'`。
- [ ] `client.ts` 幂等回填 UPDATE 落地。
- [ ] 测试 1-5 全绿,既有套件无回归。
- [ ] `bun run typecheck && bun test` 全绿。
- [ ] spec/plan 落档后清理 `.superpowers/sdd/`。

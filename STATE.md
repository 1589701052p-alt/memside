# STATE.md - memside 构建状态

## MVP 构建:已完成

全部 17 个任务均已实现。完整测试套件全绿(`bun test` -> 100 通过,
0 失败),`tsc --noEmit` 干净无报错。

### 任务总览

| 任务 | 描述 | 状态 |
|------|-------------|--------|
| 1  | 仓库脚手架 + bun/tsconfig               | 完成 |
| 2  | SQLite schema + db 客户端                | 完成 |
| 3  | 纯注入层(formatMemoryBlock、budget clip)| 完成 |
| 4  | 纯错误信号检测                            | 完成 |
| 5  | 纯状态机(canTransition)                  | 完成 |
| 6  | 记忆存储:createCandidate                 | 完成 |
| 7  | 记忆存储:promote/patch/archive           | 完成 |
| 8  | Distiller(LLM prompt + JSON 解析)       | 完成 |
| 9  | Scheduler(enqueue + tick + loop)         | 完成 |
| 10 | opencode stub adapter                    | 完成 |
| 11 | claude code adapter(捕获 + 注入)        | 完成 |
| 12 | 凭证加载器(claude code API key)         | 完成 |
| 13 | Hono server(collector + injector + API) | 完成 |
| 14 | Hook 安装器(幂等 settings.json)         | 完成 |
| 15 | Web UI(React 审批队列)                  | 完成 |
| 16 | Daemon(串联 collector + scheduler + server)| 完成 |
| 17 | CLI 入口 + e2e smoke 测试                | 完成 |

### 如何运行

```bash
# 启动 daemon + 安装 claude code hooks(每台机器一次性)
bun run src/cli.ts start-and-install

# 启动 Web UI(另开一个终端)
bun run dev:web

# 在任意仓库里照常使用 claude code。
# Stop hook 触发后,Web UI 上会出现一条候选记忆。
# 审批它,再开一个新的 claude code 会话,记忆块即被注入。

# 测试
bun test
bun run typecheck
```

### CLI 命令

- `memside start` - 仅启动 daemon(不安装 hook)
- `memside install` - 仅安装 claude code hooks(不启动 daemon)
- `memside start-and-install` - 两者都做

端口由 `MEMSIDE_PORT` env 控制(默认 7777)。

## 验证状态(final-fix1..4 之后 + daemon 层 live smoke)

MVP 的 capture -> distill -> approve -> inject 闭环已在 daemon 层通过
`smoke-live.ts` 端到端验证(真实 Ark LLM、真实 HTTP、无 mock):真实
transcript -> 候选 `[category:invariant] Refunds allowed only within 14 days
of shipment` -> 审批通过 -> SessionStart 返回带 `## Learned context` 块的
`hookSpecificOutput` additionalContext envelope。测试套件:`bun test` ->
100 通过 / 0 失败,`tsc --noEmit` 干净。

### 已由 final-fix 轮次解决(live-verified)
1. **凭证加载**(final-fix4,`0a25a1a`):`src/creds.ts` 现在从
   `~/.claude/settings.json` 的 env 中读取 `ANTHROPIC_AUTH_TOKEN` +
   `ANTHROPIC_BASE_URL` + `ANTHROPIC_DEFAULT_HAIKU_MODEL`(进程 env 优先,
   其次 settings 文件),支持目标用户实际使用的 Volcengine Ark 代理
   (`https://ark.cn-beijing.volces.com/api/plan` + `deepseek-v4-flash`)。
   Live smoke 确认 distiller 调用了 Ark 模型并拿到合法候选。
3. **模型可达性**(final-fix4):distiller 不再硬编码
   `claude-haiku-4-5-20251001`;改为使用 `creds.model ?? DISTILL_MODEL`,
   因此用户配置的 haiku 档模型优先。已 live-verified。
2. **C2/C3 捕获+注入**(final-fix3,`ac73ce4`):捕获侧通过
   `src/claude/transcript.ts` 的 `parseTranscriptFile` 读取
   `transcript_path`(已对照 2.1.217 二进制 + 一个真实本地 transcript 验证);
   SessionStart 返回 `hookSpecificOutput` additionalContext envelope
   (envelope 形状已对照二进制自身的错误字符串验证)。daemon 层 live smoke
   通过了完整闭环。

### 仍需真实 claude-code 会话验证(无法自动化)
4. **SessionStart additionalContext 抵达新会话 - 已验证**:
   在 memside 仓库内执行 `claude -p "say hi"` 触发了 SessionStart hook
   (daemon diag 日志:`SessionStart hit cwd=C:\Users\admin\Desktop\memside
   hasBlock=true`),daemon 返回了 envelope,claude code 把
   `additionalContext` 注入了会话 - 由会话 transcript 中包含
   `"additionalContext":"## Learned context (auto-injected, advisory)
   ...memside injection probe..."` 得到确认。注意:print 模式的
   `YES/NO` 探针回答了 NO,因为模型在回答直接提问时不会扫描注入的上下文;
   transcript 才是事实来源。完整闭环 - capture -> distill -> approve ->
   inject - 现已用真实 claude code 会话 + 真实 Ark LLM 完成端到端
   live-verified。

### Live smoke harness
`bun run smoke-live.ts`(仓库根目录)用 tmp DB + tmp transcript + 真实
Ark LLM 跑完整闭环。在代理环境下,设置 `NO_PROXY=127.0.0.1,localhost`
让本地 HTTP fetch 绕过系统代理:
`NO_PROXY=127.0.0.1,localhost bun run smoke-live.ts`(Ark 调用仍走
`HTTPS_PROXY`)。distill 耗时约 15-30s(异步 fire-and-forget,不阻塞
hook ack)。

## 已知债务 - 候选队列审计(2026-07-23)

审计了 live DB(`~/.memside/memside.db`:**571 候选 / 2 已审批**,
102 MB;约 19 小时运行)。候选队列实质上是坏的:生产速度远超审批,
且没有去重。**去重已落地**(PR #5,`src/memory/dedup.ts` 语义近重复聚合);
**候选价值过滤已落地**(PR #9,`src/memory/valueFilter.ts` 中性 6 类分类 ->
自动丢弃规则 1/2 + 优先级打标规则 3-6 + UI 排序 + `memory_discards` 审计表),
直接缓解下方第 2 项。其余发现作为后续工作记录于此:

1. **events/jobs 从不清理 + 存了完整 transcript** - `src/server.ts:113-127`
   在每次 Stop hook 时把*整个* transcript JSON 序列化进
   `memory_distill_events.payload`;对已完成/失败的 job 及其 event 没有
   delete / TTL(grep 确认 - 只有 FK `ON DELETE CASCADE`,没有任何地方
   删 job)。102 MB DB 里有 92 MB 是 `memory_distill_events.payload`
   (316 行;最大单行 660 KB)。需要清理策略 + 只存摘要而非完整 transcript
   副本。
2. **候选队列增长快于审批**(部分缓解) - 约 19 小时内 571 候选 vs 2 已审批。
   审批步骤是 capture->distill->approve->inject 闭环里断掉的那一环。**已缓解**:
   dedup(PR #5)做近重复聚合;value filter(PR #9)自动丢弃 public-knowledge/derivable
   类低价值候选 + 按价值优先级排序 + "批量拒绝未评估"一键清理。**仍开放**:队列上限 /
   老化策略未做(value filter 降噪声后优先级降)。
3. **`scope_id` 是原始 cwd,无归一化** - `src/scheduler.ts:76` 写入
   `scopeId = job.cwd`;`src/adapter/claudeCode.ts:38` 用
   `projectId = input.cwd` 注入,靠精确字符串 `eq` 匹配。Windows 路径大小写 /
   尾斜杠 / 符号链接 / 8.3 短名漂移会静默打断 project-scope 注入(已审批的
   project 记忆永远到不了新会话)。需要在写入和匹配两处都做 cwd 归一化。
4. **schema 漂移 + 迁移回填缺口** - live DB 的 `memories` 表**没有
   `source_cwd` 列**(`PRAGMA table_info` 确认):运行中的 daemon 是从
   pre-`source_cwd` 代码启动的、从未重启,所以 `client.ts:66-75` 的迁移
   从未运行。此外回填
   `UPDATE memories SET source_cwd = scope_id WHERE scope_type='project'`
   (`client.ts:73`)只覆盖 project 行 - **global 记忆的 `source_cwd`
   会保持 NULL**,丢失其来源项目。需要重启 daemon 以应用迁移,并修复回填
   使 global 行的 `source_cwd` 从其 distill job 的 `cwd` 填入。
5. **卡住的 `running` distill job** - 2 个 job 卡在
   `status='running'`;`sweepStuckRunning`(`src/daemon.ts:108`)只在
   daemon 启动时跑一次,所以长寿命 daemon 永远恢复不了它们。需要周期性
   sweep,或在 tick 侧对 `running` 行做超时跳过。

## 已知债务 - 候选价值过滤 minor (PR #9, 2026-07-23)

PR #9(judgeValue 中性 6 类分类 + 优先级打标 + `memory_discards` 丢弃审计 +
UI 排序/徽标/批量拒绝)已合并。最终 whole-branch 评审 verdict=SHIP,下列
minor 经判定 defer(非阻塞,记此追踪):

1. `tests/store-crud.test.ts` 的 logDiscards 测试未断言 `bodyMd`(写入路径已覆盖)。
2. `tests/scheduler.test.ts` Test 7 throw-path mock 有死分支(dedup 短路致第 3 mock 不触发;测试气味,非正确性)。
3. `src/server.ts` bulk-promote 的 bare `catch` 可收窄为 `MemoryNotFoundError`/`MemoryConflictError`(当前 skip+continue 语义可接受)。
4. `src/web/App.tsx` `bulkRejectUnevaluated` 无本地 try/catch(与既有 approve/reject 一致,pre-existing)。
5. `memories.value_class` 无 DB-level CHECK(全 TS 类型化,不可利用;同 `status`/`runtime` 现状)。

## Known debt - codeagent 桥接遗留 (2026-07-23)

探索"用公司内部 codeagent CLI(Claude Code 封装,不暴露 API 凭证)替代直连 Anthropic SDK 驱动 distill"的结论:**技术上可行**。memside 的 `callAnthropic` seam(`src/scheduler.ts:38`、`src/daemon.ts:117`)可替换为 spawn `codeagent -p --system-prompt <sys> --output-format json --tools "" --no-session-persistence`,stdin 传 user prompt,从 envelope 的 `.result` 取文本返回;distiller / scheduler / store 核心不动。本机用标准 `claude` + Ark 代理实测两次均成立(envelope `type:"result"` / `result` 字段、stdin + `--system-prompt` 共存、中文编码正常、~12s / $0.02 一次)。**硬前提**:codeagent 必须透传 `-p` / `--system-prompt` / `--output-format` / stdin(公司机器上待验证,验证清单见对话记录)。

桥接有五个脆弱点,第 1 个已解决(PR #7),其余四个在此追踪:

1. **markdown 围栏包裹致 `JSON.parse` 静默失败** - 模型 `result` 可能被 ```` ```json ... ``` ```` 围栏包裹,`src/memory/distiller.ts:63` 的 `JSON.parse(raw)` 抛错 -> catch 吞掉 -> 产出 0 候选(实测撞到,间歇性)。**已解决**(PR #7,三道防线:`extractJsonObject` 状态机扒围栏 + distiller/dedup SYSTEM_PROMPT 加 JSON 模板 + `callWithRetry` 重试喂错误回模型;170/170 测试全绿,final review verdict Yes)。
2. **`[category:xxx]` 前缀校验过严** - `src/memory/distiller.ts:70` 的 `if (!o.title.includes('[category:')) continue` 会丢弃后端模型输出。codeagent 后端若非 Claude(实测 glm 把 `[category:convention]` 写成 `[convention]`),候选被静默丢弃。需放宽校验或加固 prompt。
3. **长 transcript vs context window** - `src/daemon.ts:28` 的 `makeLoadTranscript` 全量加载不截断(已知最大单条 payload 660KB,见上方 candidate-queue debt 第 1 项)。codeagent 后端 context 可能小于直连 haiku,长 transcript 超限 / 被截。需在 codeagent 模式下加预算裁剪(复用 `clipByBudget` 思路)。
4. **system prompt 可能被 codeagent 覆盖 / 拼接** - 公司封装常强制注入企业合规 / 审计 system prompt,稀释 distiller "ONLY a JSON object" 指令 -> 输出格式乱 -> 回到第 1 项。备选 fallback:把 system prompt 拼进 user prompt 开头(user prompt 一般不被覆盖)。
5. **hooks 兼容性(闭环层面,独立于 distill)** - capture / inject 依赖 `~/.claude/settings.json` 的 hooks(`src/install.ts`)。若 codeagent 用别的配置目录(如 `~/.codeagent/`)或不读 claude hooks,hooks 装不上 -> capture 抓不到 transcript、inject 注不进新会话,整个闭环断。需验证 codeagent 配置路径 + 可能适配 `installHooks` 的 `baseDir`。**此项决定产品能否闭环,优先级高于 2-4。**

## 记忆质量修复(PR #13,2026-07-27)

针对"留存候选 ~82% 复述 memside 自身源码、输入 98% 是 tool I/O、同义重复严重"
的质量问题,落地七项修复(设计 spec / 计划见 `docs/superpowers/specs|plans/
2026-07-24-memory-quality-fix*`):

1. `filterTranscriptForDistill`(pure.ts)— 文件类工具结果替换为占位、其余工具
   截断 1500、单条 cap 4000、12000 token 预算裁剪(user / error 必留)。
2. `parseTranscriptFile` 配对 tool_use↔tool_result(toolName/toolInputPath)。
3. distiller 先过滤再渲染 prompt;REJECT 被开发仓库自身实现细节。
4. valueFilter 逻辑门:invariant/integration/compliance 强制 keep +
   valueClass='decision'(免疫"批量拒绝未评估");derivable/public-knowledge 定义收紧。
5. dedup 一次 LLM 调用覆盖同批兄弟 + 跨批 existing;失败保守全留。
6. tick 重排为 distill→dedup→judgeValue;删除 valueClass 重挂 hack。
7. e2e 门禁测试锁定受保护候选在 LLM 误判时仍入库且不进 discards。

执行方式:subagent-driven(每任务独立 implementer + reviewer;终审 whole-branch
review 通过,0 Critical)。`bun run typecheck && bun test` 247/247 全绿。

### 终审 deferred minor(后续 issue)

1. transcript.ts FIFO 配对未按 tool_use_id  keyed;pendingToolUses 跨 assistant 行不清空。
2. pure.ts catch-all 降级返回未截断原 turns(更稳的降级应仍套单条 cap)。
3. parseCategory(行首锚定)与 distillShouldRetry(.includes)对"有 category"判定不一致。
4. Edit/Write/MultiEdit 占位文案"原文 N 行"对短确认结果不准确(仅措辞)。
5. dedupCandidates 可加注释说明为何无需特判 new-j(j<i + 留最早使普通过滤已正确)。

DB 膨胀 / events 保留策略仍为独立后续 issue(见上方 2026-07-23 审计第 1 项)。

## 记忆质量修复第六轮(2026-07-27)

对照 `OPUS-5.md`(Claude 内置记忆 `<memory_filesystem>` 设计)提炼出四项改进,用户确认做第 1、4 项;第 2 项(校准)、第 3 项(隐私)砍掉--用户立场「单次观察见到一次就该记录」,memside 有人工审批兜底,liberal 捕获 + 用户把关,与 Claude 内置记忆(无审批、自动应用)的保守校准取向不同。

1. **[stated] 起源判定**(`src/memory/distiller.ts` REJECT 扩展):显式排除 6 类非陈述内容(推断 / 前瞻状态 / 研究输出 / 丰富化 / 道听途说 / agent 自己的推理建议)。仅 prompt 层,不动 category / subject / JSON 模板段。与 liberal-capture 不冲突:这六类是「非观察 / 非陈述」,不是「单次观察」。
2. **驯化守卫**(`src/memory/valueFilter.ts`):纯函数 `detectTaming(title, bodyMd)`(确定性关键词集,精度优先,限定反馈 / 评价动词,不碰任务规则动词,避免误杀 `always use bun`)+ `judgeValue` 拆 `judgeValueBase`(旧逻辑逐字不动)+ 末尾 taming override map(覆盖 protected force-keep,安全 > 保护)。`DiscardReason` 加 `'taming'`;taming 丢弃走 tick 现有 `logDiscards` 审计。无 schema 迁移(`memory_discards.reason` 自由 text)。

执行:subagent-driven(4 任务各 implementer + reviewer;终审 opus whole-branch review verdict=Ready to merge=Yes)。`bun run typecheck && bun test` 304/304 全绿。设计 spec / 计划见 `docs/superpowers/specs|plans/2026-07-27-memory-quality-fix6*`。

### 终审 deferred minor(非阻塞)

1. `detectTaming` 的 try/catch 实际不可达(`${}`/`.toLowerCase()`/`.includes()` 对 string 不抛),属 spec §3.2 既定防御形态。
2. 缺大写 taming 短语测试(`NEVER CRITICIZE`)--大小写不敏感已实现(lowercase 双侧),未显式锁定。
3. 个别 borderline pattern(`never argue` / `always agree` / `roleplay`)可能误杀合法 convention--spec §6 既定精度权衡,靠 `memory_discards WHERE reason='taming'` 审计数据后续调参。

## Subject-keyed 聚合层第一期(PR #21,2026-07-28)

对照 `OPUS-5.md` 特性 6(subject-keyed 聚合:一个 subject 一组事实,而非 N 条平铺)
落地第一期「确定性分组渲染」;LLM 合成压缩为第二期(基于本次 slug 列),未做。
设计 spec / 计划见 `docs/superpowers/specs|plans/2026-07-28-subject-keyed-aggregation*`。

1. `memories.subject_slug` 新列(幂等迁移,老行 NULL = 未分组,零回填)。
2. `normalizeSubjectSlug`(pure.ts):kebab-case 校验,非法静默 null,不 retry 不丢记忆。
3. store 层:slug 读写 + `listSubjectSlugs`(candidate+approved、DISTINCT、LIMIT 50)
   + `patchMemory` 校验(非法抛 MemoryConflictError → server 409)。
4. distiller 旧瞬态字段 `subject`(codebase|domain)机械改名 `ruleObject`,为 slug 概念腾名。
5. distiller 输出 `subjectSlug`;user prompt 附 project∪global 现有 slug 清单促复用
   (对抗同义碎裂--本特性最大失败模式)。
6. `formatMemoryBlock` 裁剪后按 slug 分节渲染;**clipByBudget 语义零变更**,
   全 NULL slug 输出与旧格式逐字节一致。
7. scheduler 接线:slug 清单失败降级空数组(distill 照常);slug 随 createCandidate 入库。
8. Web UI:审批卡片 slug 徽标 + 可编辑输入框(留空 = 未分组);server 零改动(PATCH 透传)。

执行:subagent-driven(8 任务各 implementer + reviewer;终审 opus whole-branch review
verdict=Ready to merge=Yes,0 Critical / 0 Important)。`bun run typecheck && bun test`
351/351 全绿。

### 终审 deferred minor(后续 issue,建议打包一个 follow-up PR)

1. `createCandidate` 直存 `input.subjectSlug` 未规范化(distiller/UI 路径安全,但
   `POST /api/memories` 直接调用可写入非法 slug)→ 一行 `normalizeSubjectSlug` hardening。
2. patch-undefined 时 slug 不变无显式测试;`listSubjectSlugs` LIMIT 50 截断无测试;
   listSubjectSlugs-throws 降级路径(scheduler warn + 空清单)无测试。
3. `pure-transcript-filter.test.ts:77` 注释残留 "判 subject/category";
   `distiller.ts` 局部变量 `rawSubject` 未同步改名。
4. LLM 显式输出 `"subjectSlug": null` 会触发一次 retry 再降级(retry 耗尽仍正常解析,
   仅浪费一次调用);修法:shouldRetry 同时放行 null。
5. 跨 scope 同 slug 渲染时合并为一节(spec-conformant 语义边缘,第二期 spec 考虑)。
6. `clipByBudget` 按平铺行长度计价,分组渲染后预算略偏保守(保守方向,可接受)。
7. patchMemory 中 `normalizeSubjectSlug` 调用两次(纯函数,冗余无害)。

## 蒸馏输入信号丢失三层治(2026-07-29)

诊断:distill 管线三层把记忆信号丢光,设计/brainstorming 会话只产出 trivial 记忆。
三层一起治(分支 `feat/distill-signal-recovery`,基线 `origin/master` 84b03e6):

1. **第三层(主力,origin discipline 重平衡)**:`src/memory/distiller.ts` 的
   `DISTILLER_SYSTEM_PROMPT` Origin discipline 段重写。放宽第 3/6 条--agent 在
   transcript 里说过、且被用户采纳的设计 rationale 可记;第 1/2/4/5 条维持 REJECT
   (脑补/前瞻/研究输出/丰富化/道听途说)。加硬约束「记 rationale 必须能在 transcript
   找到 agent 原话出处,找不到不记」防脑补。只改 prompt 文本,不动 distillTranscript 逻辑。
2. **第一层(subagent 单独蒸馏)**:`src/server.ts` SubagentStop 钩子从早返回改为
   fire-and-forget 处理:payload 的 `agent_id` 定位该 subagent 自己的对话文件
   (`<slug>/<sid>/subagents/agent-<agentId>.jsonl`,已核实官方文档 SubagentStop 带
   agent_id 字段),`loadSubagentTranscript` 双路兜底读取(agent_id 推路径 -> 退回
   transcript_path -> 空),单独蒸馏成独立任务(与主会话互不可见)。schema 加
   `memory_distill_jobs.source_agent_id` 列 + `memories.source_kind` 加 `'subagent'`
   enum(旧库 CHECK 约束需表重建 migration,已幂等)。scheduler 对 subagent job 走
   sourceKind='subagent'、跳过偏移切片/更新。
3. **第二层(过滤上限放宽)**:`src/memory/pure.ts` `NON_TOOL_CAP_CHARS` 8000->20000,
   设计讨论的长段 assistant 文本(rationale)不被腰斩。文件类工具结果压占位、预算裁剪不动。

执行:subagent-driven(7 实现 + 1 验证任务,每任务 implementer + reviewer;
终审 pending)。`bun run typecheck && bun test` 402/402 全绿。设计 spec / 计划见
`docs/superpowers/specs|plans/2026-07-29-distill-signal-recovery*`。

### 已知 follow-up(本轮 deferred minor,非阻塞)

1. App.tsx `sourceLabel` 无 `'subagent'` 专用 UI 标签(spec 明确推迟;subagent job
   带 cwd 显示 basename,无回归)。
2. `subagentFilePathFromPayload` 的"subagent 文件存在但解析出空 turns -> 退回主会话"
   边界已实现(transcript.ts turns.length>0 守卫)未直接测。
3. schema 表重建 migration 的 `memories_new` DDL 与原 DDL 重复(SQLite 无法 ALTER
   CHECK,brief mandate;未来加列需 lockstep 更新)。
4. origin discipline 的脑补防护为 LLM 行为,以 prompt 文本断言为 proxy(与现有
   distiller.test.ts 源码层断言模式一致),LLM 遵循度由 dogfood 验证。

## 记忆审计视图（2026-07-29）

补齐 Web UI「审批后/拒绝后」可视面：4-tab（候选审批 / 已审批 / 已拒绝 /
AI自动拒绝），给三类记忆各加最小操作能力。设计 spec / 计划见
`docs/superpowers/specs|plans/2026-07-29-memory-audit-views*`。

1. 状态机加 `rejected -> candidate`（`pure.ts` TRANSITIONS），superseded 保持终态。
2. `memory_discards` 加 6 nullable 列（scope_type/scope_id/source_cwd/runtime/
   source_kind/promoted_memory_id），ALTER TABLE 幂等迁移（不表重建）；logDiscards
   + scheduler tick 接线写入来源（scopeType/scopeId/sourceCwd/runtime/sourceKind）。
3. store 新增 `restoreMemory`（rejected->candidate，清 approvedAt，specific-source
   guard）、`promoteDiscard`（discard->candidate + 回填 promoted_memory_id；幂等守卫
   + 老行 scope 缺失守卫；不删审计行）、`listDiscards`（ORDER BY ts DESC LIMIT 200）+
   `DiscardRow` 类型。
4. server：`GET /api/memories?status=…` 服务端 status 过滤（inArray；不带 status 全量
   向后兼容；非法值宽松忽略不 400）；`GET /api/discards`；`/api/status` 加 discards
   计数；4 写路由 `POST /api/memories/:id/{archive,unarchive,restore}` +
   `POST /api/discards/:id/promote`（MemoryNotFoundError->404，冲突->409，success
   broadcast WS）。
5. Web UI 4-tab + 计数徽标（candidate / approved+archived+superseded / rejected /
   status.discards）+ `DiscardCard`（reason 徽标 + 来源 + 时间；已提升显「已提升」）+
   切 tab 切轮询（useEffect `[tab]` + clearInterval，tabRef 防 stale-fetch 竞态）；
   MemoryCard 抽通用骨架按 tab 注入操作（候选 4 回调不变 / 已审批 archive↔unarchive +
   superseded 只读 / 已拒绝 restore）；no-throw 契约（操作后 void refresh）。

执行：subagent-driven（8 实现 task 各 implementer + reviewer；终审 pending）。
`bun run typecheck && bun test` 440/440 全绿。

### 已知 follow-up（本轮 deferred minor，非阻塞）

1. `store.ts:447` `(d.runtime ?? null) as RuntimeTag` 类型安全谎言（MemoryInput.runtime
   非空但表达式可 yield null；runtime 安全因列 nullable）。Brief-verbatim。
2. `promoteDiscard` 三步（读/createCandidate/回填）非单事务；同 id 并发双提升会产生
   一个 orphan candidate 行（discard 幂等仍成立）。Brief 接受的低频手动操作权衡。
3. `server.ts:225` 内联 `MemoryStatus` 类型重复 `pure.ts:151` 导出，可漂移；应改为
   `import type { MemoryStatus } from '@/memory/pure'`。VALID Set 仍需留本地。
4. web api 4 个新 POST wrapper（restore/archive/unarchive/promote）不检查 res.ok/throw，
   404/409 时返回 undefined（与 promoteMemory 同模式，异于 patchMemory）。UI 已按
   no-throw 契约处理；未来可统一所有 mutating wrapper 的错误处理。
5. status-filter / discards 测试未 seed 非匹配行（部分断言 vacuously true）；
   archive/unarchive broadcast 分支未断言（与已测的 restore/promote 同模式）；
   scope-missing 守卫第二臂（project && scopeId===null）未单测。CLAUDE.md 错误路径
   覆盖可后续补齐。
6. App.tsx 切 tab 有一帧 stale-data 闪烁（useEffect reset 在 paint 后），自纠正非
   stall；`tabRef.current=tab` 在 render 期赋值（latest-value ref，功能安全但违 React
   书面规则，可移到 depless effect）；h1 仍「审批队列」（chrome 稳定优先，cosmetic）。

## 蒸馏工作记录透明化（2026-07-29）

诊断「近一天无新增记忆」时发现 distill 管线是黑盒：只能反推 session offset 表
确认 LLM 被调，看不到模型到底返回了什么、为什么 0 候选。本需求把每次 distill job
的工作过程落盘透明化。设计 spec / 计划见 `docs/superpowers/specs|plans/
2026-07-29-distill-work-record*`。

1. `memory_distill_runs` 新表（1:1 随 job，无 FK 与 inputs 表一致解耦清理）：outcome
   四态（skipped_no_new_turns / empty_output / llm_error / produced）+ LLM 原始产出
   `raw_output_json`（含被格式校验丢弃的候选）+ 四道闸计数（distilled/accepted/
   deduped/filtered/stored/discarded）+ duration。幂等 `CREATE TABLE IF NOT EXISTS`。
2. `distillTranscript` 返回值透出 `rawOutput`/`rawCount`/`callThrew`（callThrew 区分
   LLM 报错 vs 返回空）；`wrappedCall` 每次 attempt 重置 `callThrew`（防 sticky 跨
   retry 误判），catch 降级 callThrew=true。
3. `scheduler.tick` 接线：outcome 判定（`candidates.length===0 ? (callThrew ?
   llm_error : empty_output) : produced`，candidates 优先匹配 spec §4 produced 定义）
   + 计数采集 + 两处 best-effort `saveDistillRun`（skipped 分支 + 主路径，与
   `logDiscards`/`setSessionOffset` 同级）+ `saveSourceInput` 去门（0 产出 job 也存
   过滤版输入）。
4. store：`saveDistillRun`（UPSERT）/`getDistillRun`（反序列化失败 rawOutput=null 不崩）
   /`listRecentDistillRuns`（两段查询避免 join 键名不确定，列表不含 rawOutput）。
5. server：`GET /api/distill-runs`（列表无 rawOutput）/`GET /api/distill-runs/:jobId`
   （详情含 rawOutput）/`GET /api/distill-runs/:jobId/source-input`（复用 getSourceInput）
   + `/api/status` 加 `distillRuns: {total, byOutcome}`（最近 24h）。
6. Web UI 第 5 tab「蒸馏记录」：列表行 outcome 徽标 + 计数链 `N->M->K->J`
   （`formatRunCounts`/`formatOutcome` 纯函数）+ 点开 `DistillRunModal`（产出区展示
   rawOutput 候选 + rawCount>acceptedCount 时提示「N 条格式不合格被丢弃」+ 输入区
   懒加载 + 三态 + sourceError/sourceLoaded 空反馈）。

执行：subagent-driven（8 实现 task 各 implementer + reviewer；终审 opus whole-branch
review verdict=With fixes，一轮 fix wave 修 3 Important + 1 Minor must-fix 后 scoped
re-review 全绿）。`bun run typecheck && bun test` 470/470 全绿。

### 已知 follow-up（本轮 deferred，非阻塞）

1. spec §4 `discarded_count` 文案「= accepted - filtered」不精确（实为 `= deduped -
   filtered`，当 dedup 有丢弃时 accepted-filtered 会多算）；实现用 `discarded.length`
   正确，spec 文案待 docs follow-up 修正。
2. `/api/status` distillRuns 全量加载后 JS 过滤 24h（与 events/memories/discards 同
   模式）；长寿命 daemon 行数增长后改 SQL `WHERE ts > ?` follow-up。
3. `DistillOutcome` 类型在 store/api/ui-utils 三处重复定义（与既有跨层类型重复同模式）；
   `formatOutcome` if-else fallthrough 未做 `switch + never` 穷尽检查。
4. Task 4 计数链测试用全等值（未覆盖 accepted>deduped>filtered 的发散链）；skipped
   分支 saveDistillRun-throw 无独立测试（与已测主路径同模式）。
5. events 表存完整 transcript 的膨胀债务（STATE.md 已知债务#1）仍独立未碰；runs 表
   每行结构化记录体积有界，去门后 inputs 多写 0 产出 job 的过滤版输入（已压缩截断）。

## 蒸馏 LLM 错误捕获与透传（2026-07-29）

distill-work-record 透明化上线后，第 5 tab 显示近期 distill job 全是 llm_error，但点开
详情是空的--看不到「报了什么错」。诊断发现错误 message 被 callWithRetry（catch 后只拼
进重试 prompt 不透出）-> distiller（顶层 catch 丢弃）-> scheduler（distiller 不抛 so
不进外层 catch，job.last_error 不写）链路层层吞掉，加上 callThrew 时 filteredTurns 被清空
（source input 也丢），llm_error 在最该透明的场景变成黑盒。本需求补错误捕获透传 + 两个
伴生缺口。设计 spec / 计划见 `docs/superpowers/specs|plans/2026-07-29-distill-error-capture*`。

1. `memory_distill_runs` 加 `error_message TEXT`（nullable）+ 幂等 ALTER 迁移。llm_error
   时存错误描述（含 HTTP status 若有），其余 outcome null。
2. `distillTranscript`（方案 2，只动 distiller 不改 callWithRetry）：`wrappedCall` catch
   记 `lastErrorMessage`（每次 attempt 更新，最后一次留存）；`DistillResult` 加
   `errorMessage: string | null`；三路径取值--!parsed(callThrew?lastErrorMessage:null) /
   成功(null，retry-success 显式返回 null 防 attempt 0 残留) / 顶层 catch(e message)。
3. **filteredTurns 修复**：`callThrew ? [] : filtered` -> `filtered`（callThrew 时不再
   清空 source input 快照，llm_error job 也能看到喂给模型的 transcript）。
4. store：`DistillRunRecord`/`Row`/`ListRow` + `saveDistillRun`/`getDistillRun`/
   `listRecentDistillRuns` 适配 errorMessage。
5. scheduler：解构 errorMessage + 主路径 saveDistillRun 传 + **llm_error 时回写
   `memory_distill_jobs.last_error`**（best-effort），修 `/api/status` 的 lastError（原查
   j.lastError 非空但 llm_error job 的 last_error 为 null，顶部状态栏看不到 LLM 错误）。
6. server 端点无代码改动（store 加字段后自动带出）；web-api 类型加 errorMessage；Web UI
   `DistillRunModal` llm_error 分支展示 errorMessage（pre 红色块 + 无值兜底「无错误描述」
   不空白）+ `DistillRunRow` 列表行截断错误（ellipsis）。

执行：subagent-driven（6 实现 task 各 implementer + reviewer；终审 opus whole-branch
review verdict=Clean，1 条 Minor 注释 finding 一轮 fix wave 修后 scoped re-review 全绿）。
`bun run typecheck && bun test` 486/486 全绿。

### 已知 follow-up（本轮 deferred minor，非阻塞）

1. `store-crud.test.ts:266` 测试名「all columns」但 arrayContaining 未含 error_message
   （列存在性已由 schema.test.ts 覆盖，仅测试名过承诺）。
2. scheduler done update 从不清 job.lastError（既有行为）--job 失败重试成功后 lastError
   残留；非本需求引入，独立 follow-up。
3. `DistillRunRow` 截断错误行 marginTop:2 vs 来源行 marginTop:6 轻微不一致（有意设计）；
   web-ui 测试只断言 textOverflow 未断言 whiteSpace/overflow（源码层文本断言粒度）。
4. server.test.ts/web-api.test.ts 新测试风格与邻近测试略不一致（app.request vs req()
   helper / hand-roll fake vs new Response），no action needed。

诊断附注：根因是 Ark 端点间歇性不稳（成功 8-23s，失败每次 attempt ~6.4s × 3 耗尽重试），
非配置错误（用 settings.json 凭证实调简单调用 + distiller 真实 prompt 均成功）。本需求
不解决 Ark 稳定性（外部服务），只让间歇失败时错误可见、可诊断。

## LLM 凭证 UI 配置（2026-07-30）

实现 LLM 凭证的 Web UI 配置与优先级修复（分支 `feat/llm-settings-ui`）。设计 spec / 计划见
`docs/superpowers/specs|plans/2026-07-30-llm-settings-ui*`（8 个 task）。

- **事故根因**：Windows 用户级持久 env 残留过期中转站配置，旧优先级「进程 env > settings.json」
  导致其静默劫持有效凭证，全部 distill 401。
- **修复方式**：UI 配置最高优先 + settings.json 先于 env + UI 常驻「当前生效」回显行，
  让被 env 劫持的过期配置可被用户直接看见。

执行：`bun run typecheck && bun test` 518/518 全绿。

## 出处驱动的价值判定（origin-driven value judgment，2026-07-30）

把价值判定锚点从「domain vs codebase」换成「用户陈述 vs 可重新推导」。设计 spec / 计划见
`docs/superpowers/specs|plans/2026-07-30-origin-driven-value-judgment*`（8 个 task）。

- **事故根因**：旧 judge 的 derivable 规则「描述本仓库的、哪怕带 rationale 也算 derivable -> 丢」
  把用户亲口确认的决策（凭证链优先级、UI 回显硬性要求等）和源码琐事一刀切。7-30 新代码上线后
  实测：8 条候选全数被判 derivable 丢弃、0 条入库。
- **新判定规则全集（spec §R0-R4）**：
  - R0 驯化守卫（纯代码，不变）。
  - R1 出处门：distiller 每条候选带 `origin`（user-stated/user-confirmed/agent-observed）
    + `evidence`（原话摘句）；贴金防护--标了 stated/confirmed 却摘不出原话 -> 降级 agent-observed。
  - R2 九分类 judge（6 留 3 丢）：6 价值筐（user-rule/decision/preference/convention/trap/
    topology，扩编补「用户立的规矩」「偏好」「事故教训」缺口）+ 3 丢弃理由各配考题
    （Q1 公开知识 / Q2 仓库重推 / Q3 时效 fleeting）。**Q2 仅对 agent-observed 合法**：
    prompt 禁考 + 代码硬兜底（stated/confirmed 被判 derivable -> 改判 keep+decision）双保险。
    Q3 是 AI 对用户话语的判断权（随口琐事可丢，但理由只能是 fleeting）。
  - R3 LLM 失败全保留（stated->decision / observed->null）。
  - R4 dedup / 审计表 / 提升按钮不动。
- **诚实声明**：开发仓库自身源码实现细节不记（翻代码就能知道，不算记忆）；但蒸馏器看不到
  仓库源码，Q2 只能启发式推断。Q2 的安全性靠 origin 门禁 + 代码兜底，不靠模型聪明。
- **数据模型**：memories 加 `origin`/`evidence` 两列（幂等 ALTER，刻意放在 subagent 表重建块
  之后覆盖所有升级路径）；value_class 6 枚举 / memory_discards.reason 加 fleeting 均免迁移
  （自由文本列）。
- **Web UI**：审批卡片 origin 徽标（用户陈述/用户采纳/agent 观察）+ evidence 出处行
  （「出处：原话」紫色）+ 6 筐徽标；DiscardCard fleeting 中文文案。

执行：subagent-driven（8 task 各 implementer + reviewer；终审 pending）。
`bun run typecheck && bun test` 522/522 全绿。

### 已知 follow-up（本轮 deferred，非阻塞）

1. **valueFilter 幻觉类别兜底不全**（Task 2 minor）：per-verdict hallucinated-category
   路径（valueFilter.ts:171-174）对 stated/confirmed 也只给 keep+null，未给 decision ->
   这类候选落到 valueClass:null，不免疫「批量拒绝未评估」。非安全缺口（stated 不会被丢弃，
   只是没打 decision 标），与 keepNull/return 段的 stated->decision 不一致。后续可统一。
2. **grep 预检（第二期）**：scheduler 本机可读 job.cwd 仓库，可从候选抽符号 token grep
   把「仓库实锤」证据附给判定器，让 Q2 从启发式升级为带证判定。纯增量（判定规则不用改），
   本次不做--一次改太多变量不好归因。
3. **存量 573 候选不重判**（非目标）：可用现有「批量拒绝未评估」+ 手动审批自行清理。
4. **evidence 暂仅审批卡片可见**：注入块（formatMemoryBlock）未呈现 evidence，留第二期。
5. Task 1 遗留：scheduler.test.ts 若干 mock JSON 残留 dead `ruleObject` 字段（harmless，
   distiller 忽略）；valueFilter.ts:106 bridge 注释已随 Task 2 重写移除。
6. Task 6：Web UI 徽标/evidence 行未做浏览器视觉手测（无浏览器面），建议交互环境过一遍
   审批 tab（老行无 origin/evidence 时不显徽标为预期）。

## opencode 支持完整闭环（2026-07-31）

opencode 支持完整闭环 landed（分支 `feat/opencode-support`）。设计 spec / 计划见
`docs/superpowers/specs|plans/2026-07-31-opencode-support*`。

- **Task 1**：`parseOpencodeMessages`（`src/opencode/transcript.ts`）— opencode 全量 messages JSON
  转换为 `TranscriptTurn[]`，适配 claude/openai 角色映射（user/assistant → user/assistant，
  tool 结果转为 tool role + tool_call_id）。
- **Task 2**：`listApprovedByScope` 跨 runtime 共享（`src/memory/store.ts`）— `getApproved` 改为
  按 `scopeType + scopeId` 查询，不再过滤 `runtime`，让 claude code 和 opencode 共用 project 记忆。
- **Task 3**：`OpencodeAdapter`（`src/adapter/opencode.ts`）— 实现 `RuntimeAdapter` 接口，
  `inject` 方法走 `listApprovedByScope` 获取 approved 记忆，包 `## Learned context` 块返回。
- **Task 4**：daemon 双 adapter 接线（`src/daemon.ts`）— daemon 同时实例化 `ClaudeCodeAdapter` 和
  `OpencodeAdapter`，分别注入 `AppDeps.adapter` / `AppDeps.opencodeAdapter`。
- **Task 5**：daemon 两路由（`src/server.ts`）— `POST /hooks/opencode/capture`（idle hook 全量
  messages 接收，fire-and-forget IIFE enqueueDistillJob + events 行，202 ack）+ `GET
  /hooks/opencode/inject`（opencodeAdapter.inject，query 传 cwd）。
- **Task 6**：opencode 两 plugin 钩子（`src/opencode/plugin.ts`）— `idle` hook（会话空闲 POST
  /hooks/opencode/capture 含全量 messages）+ `messages.transform` hook（新会话 GET
  /hooks/opencode/inject 注入记忆块）。
- **Task 7**：`installOpencodePlugin`（`src/install.ts`）— 本地 plugin 文件安装到
  `~/.config/opencode/plugins/` + 更新 `opencode.json` 注册；`start-and-install` 自动调用。
- **Task 8**：Web UI sourceLabel + README/STATE 收尾 — App.tsx `sourceLabel` 加 `runtime==='opencode'`
  分支；README 去 opencode 限制 + 加 opencode 用法；STATE.md 本段。

执行：subagent-driven（8 实现 task 各 implementer + reviewer；终审 pending）。
`bun run typecheck && bun test` 546/546 全绿。

### 验证缺口（post-merge 手动 live smoke，spec §测试策略 live-only）

opencode 1.15.5 真实环境手动验证（非本机，需 opencode 可执行环境）：

1. **local-path plugin 加载**：`~/.config/opencode/plugins/memside.js` 是否被 opencode
   正确加载并注册 idle / messages.transform 钩子。
2. **session.idle payload 形状**：opencode idle hook 实际发出的 POST body 字段
   （sessionId/cwd/messages）是否与 `plugin.ts` 假设一致（依赖 opencode 文档，未在
   1.15.5 上实测）。
3. **`client.session.messages` return 形状**：`messages.transform` hook 的 GET /hooks/opencode/inject
   返回的 `{block}` 形状是否被 opencode 正确解析为注入上下文（`additionalContext` envelope
   格式差异风险）。
4. **Bun fetch vs 代理**：plugin 中 `fetch`（Bun 运行时）在用户有系统代理时的行为
   （`NO_PROXY` 等效绕过 loopback 需求）。
5. **messages.transform 幂等性**：多次 GET /hooks/opencode/inject（如重试）是否重复注入
   （server 侧无状态 GET，幂等由 opencode 保证，需验证）。
6. **opencode.json ~ 扩展**：`installOpencodePlugin` 写入 `~/.config/opencode/opencode.json`
   时 `~` 是否被 shell 展开（Bun 的 `homedir()` vs shell tilde 差异）。

以上 6 项验证缺口不阻塞合并，但需在 opencode 环境中手动验证后标记为已解决。

### Live smoke 结果（2026-07-31，真实 opencode 1.15.5 + Bun 1.3.14 + 系统代理 :7897）

本机真实 opencode 环境全闭环验证通过，6 项缺口全部闭合：

1. **plugin 加载** ✅ — `opencode run` 与 `opencode serve` 两种模式均加载 memside plugin，
   idle + messages.transform 两钩子注册生效。
2. **session.idle payload** ✅ — `event.properties.sessionID`（字符串 `ses_...`）确认；
   插件据此拉全量 messages。
3. **client.session.messages 形状** ✅（**修复**）— SDK 期望 `client.session.messages({ path: { id: sessionID } })`，
   非 `{ sessionID }`（后者把字面量对象拼进 URL 报 "Expected a string starting with ses"）；
   返回 `res.data` 为 `{info:{role}, parts:[]}` 数组。
4. **Bun fetch vs 代理** ✅（**修复**）— Bun fetch 原生尊重 `HTTP_PROXY`/`HTTPS_PROXY` 且不豁免
   loopback，系统代理 :7897 会把 `127.0.0.1:7777` 请求转发出去 -> 502，capture+inject 双双静默失效。
   修复：plugin 启动时 `process.env.NO_PROXY` 追加 `127.0.0.1,localhost`（追加非覆盖，保留出站代理）。
5. **messages.transform 幂等** ✅ — `INJECT_MARK` 守卫 + 首条 user message 注入；多次触发不重复。
6. **opencode.json 路径** ✅ — install 用 `homedir()` 解析，写入正斜杠路径
   `C:/Users/admin/.config/opencode/memside-opencode`，opencode 正确加载（无 shell tilde 问题）。

**全闭环 end-to-end**（capture -> distill -> approve -> inject）：
- **capture**：真实 `opencode run` 会话 -> session.idle -> plugin fetch messages -> POST `/hooks/opencode/capture`
  （NO_PROXY 生效）-> daemon 存 1221-byte 真实 transcript -> enqueue（runtime=opencode）。
- **distill**：distiller 调 LLM 11.2s -> outcome=`produced` -> 1 候选入库。
  （另：琐碎 2-turn 问答正确产出 `empty_output`，非 bug。）
- **approve**：`POST /api/memories/:id/promote` -> status=approved。
- **inject**：`GET /hooks/opencode/inject?cwd=...` 返回 1690-byte 块，含刚批准的 opencode-runtime
  记忆 `[bun-proxy-bypass]` + 5 条 claude-code 记忆（**跨 runtime 共享**实证）。
  真实 `opencode run` LLM 确认上下文开头见 `BEGIN INJECTED MEMORY` 块，首条即 opencode-runtime 记忆。

**随验证落地的代码改动**（本分支 commit）：
- `opencode-plugin/memside.js`：NO_PROXY loopback 旁路 + `path:{id}` SDK 签名 + `Array.isArray(res.data)` 归一化。
- `tests/plugin-opencode.test.ts`：3 条源码层文本断言守卫（CLAUDE.md 运行时组件兜底面），回退任一修复即红。
- `bun run typecheck && bun test` 550/550 全绿。


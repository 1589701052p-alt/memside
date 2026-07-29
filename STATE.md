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

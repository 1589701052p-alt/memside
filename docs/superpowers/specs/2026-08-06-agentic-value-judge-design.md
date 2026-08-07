# Agentic 价值判定器设计 spec(记忆灌水根治)

- 日期:2026-08-06
- 状态:已评审(brainstorming 产出的最终设计)
- 计划:`docs/superpowers/plans/2026-08-06-agentic-value-judge.md`(待写)

## 1. 背景与诊断

对 live DB(`~/.memside/memside.db`)的审计(2026-08-06,脚本 `scripts/audit-candidates*.ts`):

- 总量 3022 条:已审批 **7**、已拒绝 2281、待审批候选 **734**。
- 734 条候选中 573 条(78%)是 7-30 origin 判定框架上线前的存量(origin IS NULL),从未按现行标准判定。
- 对新框架产出的最近 ~150 条候选逐条阅读,无用记忆分五类:

| # | 类别 | 实例(真实候选) | 现有机制为何拦不住 |
|---|------|----------------|---------------------|
| ① | 仓库实现细节复述 | 「parseTranscriptFile 采用从不抛出设计保护收集器热路径」 | Q2(derivable)是启发式;**判定器看不到仓库**,只能靠猜;grep 预检第二期一直 deferred |
| ② | CLAUDE.md / 技能已有流程重复 | 「本仓库要求分支 + PR,禁止直接推 master」×3 | 判定器看不到 CLAUDE.md,不知道内容已被每次会话自动注入的上下文覆盖 |
| ③ | 一次性任务约束 | 「任务范围边界:不修改 valueFilter/prompts/store/schema/Web UI」 | 来自 subagent 蒸馏:role:user 是任务工单;Q3 fleeting 判定不知道发言性质 |
| ④ | 时效性状态 / 自相矛盾 | 「OpenAI 后端不接 Web UI 配置」vs「openai 后端已接入 UI 配置」同时在队列 | 判定时看不到其他候选与已审批记忆,无矛盾检测;无老化概念 |
| ⑤ | 重复条目 | 「每个 PR 必须在 CHANGELOG.md 添加条目」×3 逐字相同 | dedup LLM 连逐字重复都漏;只入库时跑,从不清存量 |

另发现有害条目:smoke-live 测试 fixture 的虚构业务规则(「退款只能在发货后 14 天内发起」×2)经 Temp 目录进入真队列。

### 根因

现行 origin 驱动判定只回答「这话谁说的」,不回答**「下次会话注入这条,AI 的行为会改变吗」**。用户确认过 ≠ 值得记(确认的可能是代码里读得到的实现);出处最硬的(CLAUDE.md 已写规则被用户在会话中复述)效用最零。要回答效用问题,判定器必须能**读到当前项目**——这是本 spec 的核心。

### 头脑风暴中被否决的方案(记录决策轨迹)

1. **分层漏斗(0 层确定性闸 + 1 层程序预取证据 + 2 层 agent 深查)**:被否。0/1 层在质量模式下握有处决权则违背质量优先(标题相近≠内容重复,审计实证 parseTranscriptFile 前缀组 9 条实为多个不同事实)。
2. **嫌疑标记(关键词清单贴 fleeting / 任务工单便签)**:被否。关键词规则需要大量实验数据调教,误贴会带偏 AI。
3. **质量模式下程序预取证据(grep + 读 CLAUDE.md 打包进 prompt)**:被否。agent 自己会查,程序代查是重复劳动且查的不一定是 AI 想查的。
4. **经济模式预取证据**:被否。「仓库命中 N 处」会锚定 AI 向 derivable 倾斜(命中只证明代码里有,不证明记忆的 why 部分可重推);「0 命中」反向锚定(复述性中文必然 0 命中,给灌水记忆留了借口)。

最终原则:**没有任何程序替 AI 做半成品判断、或筛半成品信息。要么完全不查(经济模式 = 现状判定器),要么 AI 亲手查(质量模式 = agent 终审)。** 唯一的确定性步骤是逐字去重(零信息损失,不算判断)。

## 2. 目标 / 非目标

### 目标

1. 质量模式:判定器升级为带只读工具的 agent,可在 `job.cwd` 项目内亲手查证,终审全部候选(六留三丢规则不变)。
2. 经济模式:保留现有单发 judgeValue 原样,作为低成本选项。
3. 双模式用户可选,默认质量;agent 预算(轮次/时间)用户可配,即时生效。
4. 逐字去重(同批 + 对同 scope 存量的已审批/候选),合并走审计表。
5. 蒸馏器 subagent prompt 改进:任务工单的一次性约束不产记忆(源头治理 ③)。
6. 存量回扫:对 734 条现存候选按当前模式重判,判丢进 discards(可恢复),不物理删除。
7. agent 判定全程透明:查了什么、读了什么、为何判,落 `memory_distill_runs` 可回看。

### 非目标

- 不改六留三丢的判定规则本身(R0-R4、stated 免疫、taming 守卫全部保留)。
- 不改 distill / dedup LLM 的现有逻辑(dedup LLM 保留,agent 手中的已审批标题清单兜底其漏网)。
- 不做记忆老化 / TTL(④由 agent 终审时矛盾识别缓解,不做系统化过期)。
- 不物理删除任何记忆;所有判丢都可恢复。
- 不引入各 vendor 原生 tool-use API(后端可能是 Anthropic/OpenAI/GLM,纯文本 JSON 约定保兼容)。

## 3. 总体设计

```
现在:  会话 → 蒸馏 → dedup(LLM) → judge(单发) → 入库
改后:  会话 → 蒸馏(prompt小改,仅subagent) → 逐字去重(免费) → dedup(LLM,不动) → judge(二选一) → 入库
                                                                          ├ 经济: 现有单发 judgeValue 原样
                                                                          └ 质量: agent judge(新建)
```

**模式 = 判定器二选一**,scheduler tick 按配置选执行者。两个模式共用:蒸馏改进、逐字去重、判定规则文本、stated 免疫代码兜底、taming 守卫、discards 审计。

### 质量模式的判定语义(与头脑风暴结论一致)

- agent 终审**全部**非逐字重复候选,包括它初步想丢的——不存在「前置闸先杀一批」。
- agent 手握:判定规则、本批候选全文(标题/正文/出处/来源)、同 scope(project ∪ global)已审批记忆标题清单(查重、查矛盾)、三个只读工具。
- 逐字去重是唯一前置步骤,且只做「规范化后逐字相同才合并」,零语义判断。

## 4. 组件设计

### 4.1 逐字去重(纯函数 + 接线)

```
normalizeTitleForDup(title) = 去掉 [category:xxx] 前缀 → 去全部空白与标点 → 转小写
```

- **同批**:规范化后逐字相同的分组,留最早一条,其余进 `memory_discards`(reason = `exact-duplicate`)。
- **跨批**:入库前对同 scope(scopeType + scopeId)的存量候选 + 已审批记忆做同样比对,命中即合并(新条目进 discards,保留已存在的)。
- 语义近重复**不归它管**(审计实证:前缀相同组内含多个不同事实,模糊匹配必误杀)。
- 接线位置:scheduler tick 中 dedup(LLM)之前。

### 4.2 蒸馏器 subagent prompt 改进

仅 `sourceKind='subagent'` 时,在 user prompt 追加一段(系统 prompt 不动):

> 你看到的 role:user 发言是主 agent 派发的任务工单,不是真人陈述。工单中只针对本次任务的约束(允许修改哪些文件、做到什么程度、验收标准)在任务结束时即失效,**不得提取为候选记忆**;只有跨会话持续成立的规则、决策、踩坑才可提取。

现有 subagent origin 强制降级(7-31)保留不变。主会话蒸馏一字不动。

### 4.3 三个只读工具(agent 的手)

全部锁死在 `job.cwd` 项目目录内,全部只读:

| 工具 | 参数 | 行为与封顶 |
|------|------|-----------|
| `grep` | `pattern`, `path?`(默认项目根) | 文本搜索;跳过 `.git`/`node_modules`;最多 20 处命中,每处截 200 字符,总输出 ≤ 4000 字符 |
| `read` | `path`, `startLine?`, `endLine?` | 读文件片段;一次最多 200 行;二进制/超大文件拒绝并说明 |
| `list` | `path?`(默认项目根) | 列目录条目;最多 200 条 |

**沙箱**(每个工具入口统一做):路径解析(相对转绝对、解析 `..`/`.`)后必须仍以项目根为前缀;符号链接解析后同样校验;越界一律返回错误文本(不抛异常炸循环)。

### 4.4 agent 循环(本 spec 唯一的新基础设施)

**为什么不能复用 callWithRetry**(经源码确认,`src/memory/retry.ts:36,46,53`):现有重试是「原始 prompt + 最新一句错误描述」,AI 看不到自己上次的错误输出,更早的试错也被覆盖。单发格式纠错这够用;agent 的价值恰在累积上下文(查过什么、结果如何),每轮失忆重来等于没查。

**循环设计:自维护对话累积。** 每轮把 AI 回复与工具结果追加进对话;格式错误时在累积对话末尾追加纠正消息(「你刚才的回复格式不对,问题是 X」),不推倒重来。AI 全程保有完整试错历史(包括走过的弯路,避免重复查同一词)。

**协议(纯文本 JSON,不用 vendor tool-use API,复用 extractJsonObject 围栏剥离):**

```
AI 每轮必须且只能回复一个 JSON 对象,二选一:
{"tool": "grep", "args": {"pattern": "...", "path": "..."}}   → 程序执行,结果作为下一条用户消息塞回
{"tool": "read",  "args": {"path": "...", "startLine": 1}}    → 同上
{"tool": "list",  "args": {"path": "..."}}                    → 同上
{"final": {"verdicts": [{"index": 0, "category": "..."}, ...]}} → 循环结束
```

**预算(用户可配,见 4.6):** 每批候选工具轮次上限(默认 30)、时间预算秒数(默认 300)。预算耗尽:向 AI 发强制收尾消息(「预算已尽,请立即用已获取的信息输出 final verdicts」);仍判不出 → 整批 R3 兜底全保留。

**新 seam:** 与 `LLMCall` 并列定义 `AgentCall`(或同签名多轮驱动器),组合根(daemon)装配,测试注入剧本 mock。核心模块仍不 import SDK(结构保证不变)。

### 4.5 agent 判定器(规则 + 判决映射)

**系统 prompt = 现有 VALUE_JUDGE_SYSTEM_PROMPT 的判定段原文**(六留三丢 + Q1/Q2/Q3 考题 + stated 禁考 Q2)+ agent 增补段:

- 工具用法与 JSON 协议(4.4);
- 「你可以亲手查仓库再下判决;Q2(derivable)判定应以亲手查验为准,而非猜测」;
- 已审批记忆标题清单的用途:「与清单逐字或语义重复 → 丢弃(duplicate 按 fleeting 之外的既有丢弃类映射,见下);与清单矛盾 → 以更新、更持久者为准,矛盾另一方判 fleeting」;
- 来源提示:subagent 来源候选重点核对是否一次性任务约束(Q3)。

**用户消息 = 本批候选全文**(含 origin/evidence/sourceKind)+ 已审批标题清单(封顶 100 条,超出取最近)。

**判决映射(以现有 judgeValue 为基线,agent 模式扩一个丢弃类):**

- agent 模式的 verdict 枚举 = 现有 9 类 + 第 10 类 `duplicate`(丢弃类,专表「与已审批/存量记忆重复」);校验逻辑同 valueShouldRetry,集合扩一项。经济模式枚举不变(单发 judge 看不到清单,无权判 duplicate);
- retain 6 类 → keep + valueClass;drop 4 类(public-knowledge / derivable / fleeting / duplicate)→ discard(`memory_discards.reason` 分别为同名自由文本,免迁移);与清单矛盾 → 以更新、更持久者为准,被取代方判 `fleeting`;
- **stated 免疫代码兜底原样保留**:origin 非 agent-observed 被判 derivable → 改判 keep + decision(duplicate 不免疫——用户复述一条已审批记忆同样是重复);
- taming 守卫最后跑,可覆盖 stated 免疫(安全 > 保护);
- LLM/协议失败 → R3 全保留兜底(stated → decision,observed → null)。

**透明化:** agent 全过程(每轮工具调用 + 结果摘要 + 最终判决)落 `memory_distill_runs.raw_output_json`(该列已存在,形状扩展为 `{candidates, agentTrace?}`);Web UI 蒸馏记录 tab 详情可回看「它查了哪些词、读了哪些文件、为什么这么判」。

### 4.6 配置面(Web UI 设置区新增「判定」小节)

| 配置项 | 取值 | 默认 | 说明 |
|--------|------|------|------|
| 判定模式 | `quality` / `economy` | `quality` | 质量 = agent 终审;经济 = 现有单发 judge |
| agent 工具轮次上限 | 正整数 | 30 | 每批候选 |
| agent 时间预算 | 正整数(秒) | 300 | 每批候选 |

- 存储与优先级走现有 UI LLM 配置同链路(UI 配置最高优先,改动即时生效不重启);
- scheduler 每次 tick 读配置选执行者(与协议动态解析先例一致);
- server 端配置读写端点复用现有 settings 通道扩展字段。

### 4.7 存量回扫

Web UI 候选 tab 加「回扫存量」按钮(fire-and-forget,顶部状态栏可见进度):

- 对所有 `status='candidate'` 记忆按当前配置的判定模式重判,每批 15 条;
- 每条的仓库根 = 其 `source_cwd`(缺则 `scope_id`);目录不存在 → 跳过不判,留队列待人工;
- 判丢 → `memory_discards`(可恢复);判留 → 更新 `value_class`/`origin` 缺失值;**不物理删除**;
- 判丢的候选离开 candidate 池,天然不重复判;判留的仍是候选,重按按钮会重判(幂等但费 token——回扫是低频手动操作,接受);中断后直接重按即可,无脏状态;
- 完成报告:处理 N、判丢 M、跳过 K。

回扫同样区分模式:经济模式存量重判用单发 judge,质量模式用 agent。

## 5. 数据流(质量模式一次 tick)

1. scheduler 取 job → distill(subagent 时带新 prompt 段)→ 候选集;
2. 逐字去重:同批合并 + 对存量比对,合并项写 discards;
3. dedup LLM(不动);
4. 读配置 → 质量模式 → 组 agent 输入(候选 + origin/evidence/sourceKind + 已审批标题清单);
5. agent 循环:JSON 协议,工具在 job.cwd 沙箱执行,预算监督;
6. final verdicts → 校验 → stated 免疫兜底 → taming 守卫 → 入库 / discards;
7. agentTrace + 计数链落 `memory_distill_runs`;
8. 回扫:同一套 4-7,数据源从 job 候选换成存量 candidate 表。

## 6. 失败模式矩阵

总原则:**任何故障倒向「保留」,绝不倒向「丢弃」。**

| 故障 | 行为 |
|------|------|
| agent LLM 调用报错/超时 | 整批 R3 全保留;错误写蒸馏记录 + job.last_error(现有链路) |
| AI 回复格式乱(坏 JSON/围栏) | 累积对话追加纠正消息重试;耗尽 → 全保留 |
| 工具执行出错(越界/文件不存在) | 错误文本当工具结果塞回,循环继续 |
| 预算(轮次/时间)耗尽 | 强制收尾消息;仍无 final → 全保留 |
| 候选项目目录已删除 | 该批降级经济模式判定,蒸馏记录注明降级 |
| 已审批标题清单查询失败 | 降级为空清单,判定照常(与 slug 清单降级先例一致) |
| 回扫中途 daemon 重启 | 判丢的已离开候选池不重判;判留的下次回扫会重判(幂等,接受),直接重按按钮即可 |
| 配置读取失败 | 默认质量模式 + 默认预算 |

最坏情况 = 回到现状(候选全留等人工),永远不会比现状更糟。

## 7. 测试策略

沿用仓库惯例(纯函数层写足,运行时组件留源码文本断言兜底):

1. **逐字去重**:纯函数测试——前缀剥离、标点/大小写、留早不留晚;跨批对已审批 + 候选查重(种子 DB);discards 审计写入。
2. **三个工具**:tmp 目录真文件——`../`/绝对路径越界拒绝、符号链接越界拒绝、`.git`/`node_modules` 跳过、命中数/行数/总字符封顶。
3. **agent 循环**(核心):剧本 mock LLM——第一轮要 grep → 给造的结果 → 第二轮下 final。锁定:循环收敛、对话累积(第二轮 prompt 含第一轮工具结果)、格式错误追加纠正而非重置、预算耗尽强制收尾、LLM 报错全保留。
4. **判决映射**:9 类校验、stated 免疫(agent 路径同样生效)、taming 覆盖、duplicate/fleeting 映射。
5. **模式开关**:scheduler 按配置选对执行者;缺配置默认质量。
6. **回扫**:种子 DB + mock 判定——判丢进 discards、判留更新标签、目录不存在跳过、重复跑不重复判、中断续跑。
7. **蒸馏器 subagent prompt**:源码文本断言(现有模式)。
8. **门禁 e2e**:受保护候选(用户陈述类)在 agent 各类故障下仍入库且不进 discards(照现有门禁测试形状)。

## 8. 落地顺序

| # | 任务 | 依赖 |
|---|------|------|
| 1 | 逐字去重(纯函数 + 接线 + 审计) | 无 |
| 2 | 蒸馏器 subagent prompt 改进 | 无 |
| 3 | 三个只读工具(沙箱 + 封顶) | 无 |
| 4 | agent 循环(JSON 协议 + 对话累积 + 预算 + 兜底) | 3 |
| 5 | agent 判定器(规则 prompt + 判决映射 + agentTrace 落盘) | 4 |
| 6 | 配置面(模式 + 预算,存储 + server + Web UI) | 5 |
| 7 | 存量回扫(按钮 + 后台批处理 + 进度) | 6 |

1~3 互相独立可并行。每任务独立 implementer + reviewer,终审 whole-branch review,照旧。

## 9. 与现有模块的耦合点

- `src/scheduler.ts`:tick 插入逐字去重;judge 段改模式分发;回扫复用 tick 的判定段。
- `src/memory/valueFilter.ts`:规则 prompt 判定段被 agent 复用(抽取共用,不改语义);经济模式入口原样。
- `src/memory/dedup.ts` 前:逐字去重新文件(如 `src/memory/exactDedup.ts`)。
- `src/memory/distiller.ts`:仅 subagent user prompt 追加段。
- `src/memory/retry.ts`:不动;agent 循环自建对话累积,新文件(如 `src/memory/agentLoop.ts`)。
- `src/memory/store.ts` / `src/client.ts`:回扫所需的候选批量读取与判后写回;`memory_discards.reason` 新增 `exact-duplicate`/`duplicate` 自由文本(免迁移)。
- `src/server.ts` + `src/web/App.tsx`:配置字段扩展 + 回扫按钮与进度。
- `memory_distill_runs.raw_output_json`:形状向后兼容扩展(agentTrace 可选键)。

# 价值判定器 prompt 精度修复 设计 spec（2026-08-14）

## 1. 背景与诊断

2026-08-14 对 live DB 做了抽样审计：最近 50 条候选（C1–C50）+ 最近 50 条 AI 自动丢弃
（D1–D50），逐条核对 title + body。结论：判定器主体健康（两轴约 95% 准确，
derivable / public-knowledge 校准良好），但发现两个系统性 prompt 缺陷：

### 缺陷 A：fleeting 被误用到永久项目规则（3 条实测误判）

fleeting 的考题本身是对的（"三个月后还有约束力吗"），但模型对**措辞上像规矩**
的候选不应用考题，直接判 fleeting：

- D17「LLM prompt 必须中立，不得匹配 keep/discard/丢弃 等词」——有 grep 测试守卫
  的永久硬约束，判了 fleeting。同一内容的 D25/D32/D34 却正确判了 derivable。
- D21「终验门槛：typecheck && bun test 全绿后才可 push」——永久质量门，判了
  fleeting。孪生条 D19 同内容正确判了 derivable。
- D4「task review 报告格式：先给 spec-compliance 判定、file:line 指证」——长期
  稳定的评审格式约定，判了 fleeting。

共同特征：标题/正文含「必须 / 门槛 / 一律」类长期约束措辞，模型未做三个月考题。

### 缺陷 B：derivable 边界跨批次漂移（3 组同事实相反判决）

「规则已写进仓库文档」这类候选，derivable 考题的字面答案显然是 yes（读文档即可
重推），但模型时而被「这读起来像团队惯例」带偏判成 convention / user-rule 留下：

| 事实 | 留存判决 | 丢弃判决 |
|------|---------|---------|
| TDD 先红后绿 | C26 user-rule（留） | D33 derivable（丢） |
| STATE.md 新节追加到末尾 | C24 convention（留） | D20 derivable（丢） |
| UI 文案逐字照抄 spec | C35 convention（留） | D49 derivable（丢） |

净结果无害（规则至少留一份），但判决不唯一 = prompt 边界没钉死。**用户已裁决
收敛方向：已写进仓库文档（CLAUDE.md / README / STATE.md / docs/ / 测试守卫）
的长期规矩一律判 derivable（丢）**——CLAUDE.md 每个会话本来就注入，重复记忆是
噪音。

### 附带观察（本 spec 明确不处理）

- C16 origin 错标（正文写明「用户明确要求」却标 agent-observed）——origin 由
  **蒸馏器** prompt 打标，属另一条 prompt，记入 follow-up。
- D37「查询 app_settings 勿回显 auth_token」被判 derivable 有争议（该规矩仓库里
  没写）——缺陷 B 的边界钉死后，"nowhere written down" 类自动归 convention/trap，
  此误伤方向同步消除。
- 近重复未合并（C16/C17、C45/C47 等）是去重环节的事，与判定 prompt 无关。

## 2. 目标 / 非目标

**目标**：

1. fleeting 加硬规则：长期项目规则 / 工作流 / 质量门槛永远不得判 fleeting；
   fleeting 只用于会话性琐事与条目自身标明已被取代的指导。
2. derivable 钉死文档化边界："docs" 显式包含项目自己的规矩文件与测试守卫；
   已写进其中的长期规矩一律 derivable，不得判 convention。
3. 只改 prompt 文本（用户明确要求），不加任何代码机制。

**非目标**：

- 不改 verdict 映射代码（`verdictsFromCategories` / stated 免疫代码兜底原样保留）。
- 不改 taming 守卫、失败兜底（R3）、输出格式段、agent 协议段。
- 不重判存量（已误判条目用户在 Web UI 手动处置）。
- 不动蒸馏器 prompt（origin 错标为 follow-up）。
- 不改 10 分类（category）体系。

## 3. 接口契约（权威文本表——实现逐字照抄，含标点）

唯一改动：`src/memory/valueFilter.ts` 的 `VALUE_JUDGE_RULES` 常量。改动后**完整**
权威文本如下（与现行文本的差异仅两处插入，已在 §4 标注）：

```
Each candidate carries an origin tag: user-stated (the user said it in this session),
user-confirmed (the agent proposed it and the user explicitly adopted it), or
agent-observed (the agent derived it on its own).

Retain categories (assign the best fit):
1. user-rule - an explicit rule or hard constraint the user laid down: workflow rules,
   quality bars, safety constraints.
2. decision - the WHY behind a choice the user made or adopted: abandoned alternatives,
   driving constraints.
3. preference - the user's personal preferences and collaboration habits.
4. convention - an unwritten team/repo norm that holds steady without being stated by
   the user in this session.
5. trap - counterintuitive behavior, known gotchas, postmortem lessons from incidents.
6. topology - a cross-boundary connection (cross-module/service/repo) invisible from
   any single vantage point.

Drop categories (assign only when the stated test passes):
7. public-knowledge - TEST: could an engineer who never read this repo and never saw
   this session write this entry from general knowledge or official docs alone?
   ("Python dicts preserve insertion order" -> yes; "refunds only within 14 days of
   shipment in this product" -> no.)
8. derivable - TEST: reading only this repository's code/docs/config, never this
   conversation, could one re-derive this entry's content? ("the token mask retains the
   first 6 and last 4 chars" -> yes; "the credential chain puts UI first because stale
   env vars once caused a 401 outage" -> no - the code shows the order, not the why.)
   "Docs" includes this project's own rulebooks and specs (CLAUDE.md, README,
   STATE.md, docs/, and test files that grep-guard a rule): a standing rule already
   written there is derivable even when it also reads as a convention or process
   norm - assign derivable, not convention. ("tests must run with bun test, per
   CLAUDE.md" -> derivable; "reviewers here prefer merge commits over squash,
   nowhere written down" -> convention.)
   HARD RULE: never assign derivable to a candidate whose origin is user-stated or
   user-confirmed.
9. fleeting - TEST: in a brand-new session three months from now, would this entry
   still bind or inform? ("let's stop here for today" -> no; "every change lands via
   branch + PR" -> yes.)
   HARD RULE: fleeting is ONLY for session logistics (scheduling, "for today",
   "after lunch") and for guidance the entry itself marks as superseded. A standing
   rule, workflow, or quality gate of this project - however small - still binds
   three months from now by definition; never assign fleeting to one. ("never commit
   directly to master" -> not fleeting; "we'll merge PR #58 after lunch" ->
   fleeting.)
```

### 措辞要点（评审核对单）

1. fleeting 硬规则**保留"entry itself marks as superseded"口子**——agent 判定器
   协议段（`agentJudge.ts` AGENT_PROTOCOL_SECTION）有「互相矛盾时被取代方判
   fleeting」的合法用法，不得误伤。
2. derivable 新段放在考题之后、stated 免疫 HARD RULE **之前**；stated 免疫一字
   不动（用户亲口说的规矩永远优先留下）。
3. 沿用原文标点风格：连字符用 ` - `（不用 em-dash）、箭头用 `->`、直引号；
   续行 3 空格缩进。
4. 两处插入只加文本，不删不改任何既有字句（6 留 3 丢定义、考题、既有例子、
   stated 免疫逐字保留）。

## 4. 数据流与耦合点

```
distiller → 候选（含 origin/evidence）
   ↓
dedup（不动）
   ↓
judgeValue（经济模式单发）/ judgeValueAgentic（质量模式 agent）
   └─ 共用 VALUE_JUDGE_HEADER + VALUE_JUDGE_RULES（本 spec 唯一改动点）
      ├─ 单发：+ VALUE_JUDGE_OUTPUT_SECTION（不动）
      └─ agent：+ AGENT_PROTOCOL_SECTION（不动）
   ↓
verdictsFromCategories 映射（不动）→ keep+valueClass / discard(reason)
```

- **agent 判定器自动继承**：`agentJudge.ts:31` 逐字复用 RULES，改一处两模式同时
  生效——这正是当初共享设计的目的，无需双改。
- **字节锁测试**：`tests/value-filter-prompt.test.ts` 的 ORIGINAL 字面量锁
  `VALUE_JUDGE_SYSTEM_PROMPT`（HEADER+RULES+输出段 拼接）全文，必须同步更新为
  新拼接结果。
- 既有测试 `value-filter.test.ts` / `agent-judge.test.ts` 只 mock LLM 返回，
  不锁 prompt 文本，预期零改动全绿。

## 5. 失败模式

| 失败模式 | 防护 |
|---------|------|
| 模型仍违规把长期规则判 fleeting | 与 derivable 硬规则同级：prompt 层约束，无代码兜底变化（现状即如此，本 spec 不新增机制）；靠上线后观测复测 |
| 措辞被后续改动悄悄回退 | 字节锁测试 + 新增两条意图断言（§6），回退即红 |
| 新 derivable 边界误伤「仓库里没写的规矩」 | 权威文本明示 "nowhere written down" → convention 反例 |
| 新 fleeting 硬规则误伤 superseded 用法 | 措辞要点第 1 条的保留口子 |
| agent 模式行为漂移 | RULES 共享，天然同步；agent 协议段不动 |

## 6. 测试策略

TDD（先红后绿）：

1. **红**：先把 `tests/value-filter-prompt.test.ts` 的 ORIGINAL 字面量更新为
   §3 权威文本的完整拼接（HEADER + 新 RULES + 输出段），并新增意图断言测试
   （锁两条新 HARD RULE 的关键文本）。此时源码未改，测试必红。
2. **绿**：`src/memory/valueFilter.ts` 的 `VALUE_JUDGE_RULES` 逐字照抄 §3 权威
   文本，测试转绿。
3. **全量门槛**：`bun run typecheck && bun test` 全绿才可 push。

新增意图断言（命名直点回归意图）：

- `VALUE_JUDGE_RULES` 含 `'HARD RULE: fleeting is ONLY for session logistics'`
  与 `'never assign fleeting to one'`（缺陷 A 回归锁）。
- `VALUE_JUDGE_RULES` 含 `'"Docs" includes this project'` 与
  `'assign derivable, not convention'`（缺陷 B 回归锁）。

## 7. 上线后观测（硬要求，结论回填 STATE.md）

- 后续 24–48h 的 `memory_discards` 抽样：reason='fleeting' 的新行是否仍命中
  长期规则措辞（预期近零）。
- 文档化规矩类候选的判决分布：derivable 占比应收敛到 ~100%，不再出现
  convention/user-rule 留存版。
- 副作用监测：convention 留存是否异常减少（"nowhere written down" 类被误丢
  的信号）。

## 8. Follow-up（本 spec 不做）

1. 蒸馏器 prompt 的 origin 打标准确性（C16 类错标）：考虑在 distiller SYSTEM
   PROMPT 加「正文出现"用户明确要求/用户说"时 origin 不得标 agent-observed」
   硬规则。
2. 存量误判条目不重判：D4/D17/D21/D37 可在 Web UI「AI自动拒绝」tab 手动提升。
3. 去重环节对 C16/C17、C45/C47 类近重复双胞胎的漏并，独立议题。

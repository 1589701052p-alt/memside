// 回归防护:Task 5 把 VALUE_JUDGE_SYSTEM_PROMPT 拆成 头+RULES+输出段 重组,
// 重组后必须与原字面量逐字节一致(判定规则文本语义零变更,spec Global Constraints)。
// 2026-08-14(spec value-judge-prompt-accuracy):RULES 段插入 fleeting/derivable
// 两条新 HARD RULE(实测 fleeting 误判永久规则、derivable 边界跨批漂移),
// 本锁同步更新为新权威文本。
import { test, expect } from 'bun:test'
import { VALUE_JUDGE_SYSTEM_PROMPT, VALUE_JUDGE_RULES } from '@/memory/valueFilter'

const ORIGINAL = `You are memside-value-judge. Assign exactly one category to each candidate memory.

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

输出格式如下（仅示范结构，勿照抄内容；只输出这一个 JSON 对象，无 markdown 围栏，无解释文字）：
{
  "verdicts": [
    {"index": 0, "category": "decision"},
    {"index": 1, "category": "public-knowledge"}
  ]
}
Emit one verdict per candidate, keyed by index.`

test('拆分重组后 VALUE_JUDGE_SYSTEM_PROMPT 与原字面量字节一致', () => {
  expect(VALUE_JUDGE_SYSTEM_PROMPT).toBe(ORIGINAL)
})

test('VALUE_JUDGE_RULES 含六留三丢全部 9 类与 stated 禁考 Q2 硬规则', () => {
  for (const s of ['user-rule', 'decision', 'preference', 'convention', 'trap', 'topology',
    'public-knowledge', 'derivable', 'fleeting', 'HARD RULE']) {
    expect(VALUE_JUDGE_RULES).toContain(s)
  }
})

// 回归锁(2026-08-14 审计):fleeting 曾把「LLM prompt 必须中立」等永久规则误判丢弃;
// derivable 曾对「已写进 CLAUDE.md 的 TDD 规则」判决跨批漂移。两条新 HARD RULE 的
// 关键措辞被回退时本测试必须变红。
test('VALUE_JUDGE_RULES 含 fleeting 长期规则禁判与 derivable 文档化边界两条新硬规则', () => {
  for (const s of [
    'HARD RULE: fleeting is ONLY for session logistics',
    'never assign fleeting to one',
    '"Docs" includes this project\'s own rulebooks and specs',
    'assign derivable, not convention',
  ]) {
    expect(VALUE_JUDGE_RULES).toContain(s)
  }
})

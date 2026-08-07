// 回归防护:Task 5 把 VALUE_JUDGE_SYSTEM_PROMPT 拆成 头+RULES+输出段 重组,
// 重组后必须与原字面量逐字节一致(判定规则文本语义零变更,spec Global Constraints)。
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
   HARD RULE: never assign derivable to a candidate whose origin is user-stated or
   user-confirmed.
9. fleeting - TEST: in a brand-new session three months from now, would this entry
   still bind or inform? ("let's stop here for today" -> no; "every change lands via
   branch + PR" -> yes.)

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

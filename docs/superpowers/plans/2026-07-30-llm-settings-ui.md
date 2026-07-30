# LLM 凭证 UI 配置 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户在 Web UI 配置 LLM 凭证（baseURL/token/model），UI 配置占凭证链最高优先级，兜底链改为 settings.json 先于进程 env，并常驻回显当前生效来源 —— 根治 2026-07-30「持久 env 残留静默劫持导致全部 distill 401」事故。

**Architecture:** 新增 sqlite `app_settings` 表存 UI 配置；`loadClaudeCreds` 改为四级链（UI → settings.json → env → credentials.json）；daemon 三个新端点（GET/PUT/test）；Web UI 状态栏下方新增「LLM 设置」区块，含生效回显行与测试连接按钮。

**Tech Stack:** Bun + Hono + Drizzle + bun:sqlite + zod；前端 React 19 inline style；测试 bun:test。

**Spec:** `docs/superpowers/specs/2026-07-30-llm-settings-ui-design.md`（已批准）。

## Global Constraints

- 凭证链顺序（`src/creds.ts`）：**UI 配置 → settings.json env → 进程 env → credentials.json**。整级短路：UI 级 token 非空即整级生效，不做跨级字段拼接。
- token 任何 API 路径不回明文：打码 = 前 6 + `…` + 后 4；长度 ≤ 10 全码（`•` 重复）。
- PUT 字段级合并：`token` 缺省/空 = 保持已存值；`baseURL`/`model` 空字符串 = 删除该 key 回默认；`clear:true` = 删除整级。
- 已知限制（非目标）：`MEMSIDE_LLM_BACKEND=openai` / `OPENAI_API_KEY` 路径不接 UI 配置（UI 配置只进 anthropic 链）；不改写 `~/.claude/settings.json` 文件本体。
- 每个 Task 结束 `bun run typecheck && bun test` 全绿才 commit。
- commit 信息结尾带 `Co-Authored-By: Claude <noreply@anthropic.com>`。
- 分支：`feat/llm-settings-ui`（已从 origin/master 切出，spec 已在其上）。
- **开工前**：若 `.superpowers/sdd/` 存在，删除其下所有文件（CLAUDE.md 强制闸门；本次会话检查时不存在，执行时复核）。

---

### Task 1: app_settings 表 + settings 存储模块（maskToken / save / load）

**Files:**
- Modify: `src/db/schema.ts`（加表定义）
- Modify: `src/db/client.ts`（DDL + 幂等迁移，加在 error_message 迁移块之后、`return db` 之前）
- Create: `src/settings.ts`
- Test: `tests/settings.test.ts`（新建）、`tests/schema.test.ts`（加一条）

**Interfaces:**
- Produces（后续 Task 依赖这些签名）:
  ```ts
  // src/settings.ts
  export interface UiLlmConfig { baseURL?: string; token?: string; model?: string }
  export function maskToken(token: string): string
  export function loadUiLlmConfig(db: DbClient): UiLlmConfig | null  // token 缺失/空 -> null
  export function saveUiLlmConfig(db: DbClient, patch: { baseURL?: string; token?: string; model?: string; clear?: boolean }): void
  ```
- Consumes: `DbClient` from `src/db/client.ts`。

- [ ] **Step 1: 写失败测试 `tests/settings.test.ts`**

```ts
// 回归防护：2026-07-30 distill 全 401 事故（持久 env 静默劫持）——本文件锁
// 「UI 配置存取 + token 打码」语义，spec: docs/superpowers/specs/2026-07-30-llm-settings-ui-design.md
import { test, expect } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/db/client'
import { maskToken, loadUiLlmConfig, saveUiLlmConfig } from '../src/settings'

function tmpDb() {
  const dir = mkdtempSync(join(tmpdir(), 'memside-settings-'))
  return openDb(join(dir, 't.db'))
}

test('maskToken: 正常长度取前6后4', () => {
  expect(maskToken('sk-kimiabcdef12345678fh')).toBe('sk-kim…5678fh')
})
test('maskToken: 长度<=10 全码', () => {
  expect(maskToken('short')).toBe('•••••')
  expect(maskToken('1234567890')).toBe('••••••••••')
})

test('loadUiLlmConfig: 未配置返回 null', () => {
  const db = tmpDb()
  expect(loadUiLlmConfig(db)).toBeNull()
})

test('save+load: 三项写入后读回', () => {
  const db = tmpDb()
  saveUiLlmConfig(db, { baseURL: 'https://api.kimi.com/coding/', token: 'sk-abcdefghijklmn', model: 'kimi-for-coding-highspeed' })
  expect(loadUiLlmConfig(db)).toEqual({
    baseURL: 'https://api.kimi.com/coding/', token: 'sk-abcdefghijklmn', model: 'kimi-for-coding-highspeed',
  })
})

test('字段级合并: token 缺省保持已存值；baseURL 空字符串删除该 key', () => {
  const db = tmpDb()
  saveUiLlmConfig(db, { baseURL: 'https://a.example.com', token: 'sk-abcdefghijklmn', model: 'm1' })
  saveUiLlmConfig(db, { baseURL: '', model: 'm2' }) // token 未提供 -> 保持
  expect(loadUiLlmConfig(db)).toEqual({ token: 'sk-abcdefghijklmn', model: 'm2' })
})

test('只有 baseURL 没有 token -> UI 级不存在（load 返回 null）', () => {
  const db = tmpDb()
  saveUiLlmConfig(db, { baseURL: 'https://a.example.com' })
  expect(loadUiLlmConfig(db)).toBeNull()
})

test('clear:true 删除整级', () => {
  const db = tmpDb()
  saveUiLlmConfig(db, { token: 'sk-abcdefghijklmn', model: 'm1' })
  saveUiLlmConfig(db, { clear: true })
  expect(loadUiLlmConfig(db)).toBeNull()
})
```

`tests/schema.test.ts` 追加一条（放在文件尾部 describe 内，风格与既有用例一致）：

```ts
test('app_settings table exists with expected columns (idempotent on reopen)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memside-schema-'))
  const p = join(dir, 't.db')
  openDb(p).close?.() // 若 openDb 无 close，直接二次 openDb 即可
  const db = openDb(p) // 二次打开：迁移幂等不抛错
  const raw = (db as any).$client as import('bun:sqlite').Database
  const cols = raw.prepare("PRAGMA table_info(app_settings)").all() as { name: string }[]
  expect(cols.map((c) => c.name).sort()).toEqual(['key', 'updated_at', 'value'])
})
```

> 若 `db.$client` 类型拿不到，参照 `tests/schema.test.ts:241` 既有用法（直接 `new Database(path)` 开 raw 句柄）改写。

- [ ] **Step 2: 跑测试确认红**

Run: `bun test tests/settings.test.ts tests/schema.test.ts`
Expected: FAIL（`../src/settings` 模块不存在 / `app_settings` 表不存在）

- [ ] **Step 3: 实现**

`src/db/schema.ts` 末尾追加：

```ts
export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at').notNull(),
})
```

`src/db/client.ts`：import 列表加 `appSettings`；drizzle schema 对象加 `appSettings`；DDL 块尾部（`memory_distill_runs` 建表语句之后）加：

```sql
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
```

新建 `src/settings.ts`：

```ts
import { eq } from 'drizzle-orm'
import type { DbClient } from './db/client'
import { appSettings } from './db/schema'

/** UI 配置的三项 LLM 凭证。token 非空时整级生效（spec：整级短路）。 */
export interface UiLlmConfig {
  baseURL?: string
  token?: string
  model?: string
}

const KEYS = { baseURL: 'llm.base_url', token: 'llm.auth_token', model: 'llm.model' } as const

/** token 打码：前6+…+后4；长度<=10 全码。任何 API 路径不得回明文（spec 硬约束）。 */
export function maskToken(token: string): string {
  if (token.length <= 10) return '•'.repeat(token.length)
  return `${token.slice(0, 6)}…${token.slice(-4)}`
}

/** 读取 UI 级配置；token 缺失（从未设置或被 clear）-> null（UI 级不存在）。 */
export function loadUiLlmConfig(db: DbClient): UiLlmConfig | null {
  const rows = db.select().from(appSettings).all()
  const map = new Map(rows.map((r) => [r.key, r.value]))
  const token = map.get(KEYS.token)
  if (!token) return null
  const out: UiLlmConfig = { token }
  const baseURL = map.get(KEYS.baseURL)
  const model = map.get(KEYS.model)
  if (baseURL) out.baseURL = baseURL
  if (model) out.model = model
  return out
}

/**
 * 字段级合并写（spec）：
 * - clear:true -> 删除整级三个 key。
 * - token 提供且非空 -> upsert；缺省/空 -> 保持已存值。
 * - baseURL/model 提供（含 ''）-> 覆盖；'' = 删除该 key（回默认端点/默认模型）。
 */
export function saveUiLlmConfig(
  db: DbClient,
  patch: { baseURL?: string; token?: string; model?: string; clear?: boolean },
): void {
  if (patch.clear) {
    for (const k of Object.values(KEYS)) db.delete(appSettings).where(eq(appSettings.key, k)).run()
    return
  }
  const upsert = (key: string, value: string) => {
    db.insert(appSettings).values({ key, value, updatedAt: Date.now() })
      .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: Date.now() } })
      .run()
  }
  if (patch.token) upsert(KEYS.token, patch.token)
  if (patch.baseURL !== undefined) {
    if (patch.baseURL === '') db.delete(appSettings).where(eq(appSettings.key, KEYS.baseURL)).run()
    else upsert(KEYS.baseURL, patch.baseURL)
  }
  if (patch.model !== undefined) {
    if (patch.model === '') db.delete(appSettings).where(eq(appSettings.key, KEYS.model)).run()
    else upsert(KEYS.model, patch.model)
  }
}
```

- [ ] **Step 4: 跑测试确认绿**

Run: `bun test tests/settings.test.ts tests/schema.test.ts && bun run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts src/db/client.ts src/settings.ts tests/settings.test.ts tests/schema.test.ts
git commit -m "feat(settings): app_settings 表 + UI LLM 配置存取（maskToken/字段级合并/clear）"
```

---

### Task 2: creds 链重排 + UI 级（settings.json 先于 env）

**Files:**
- Modify: `src/creds.ts`（`loadClaudeCreds` 加重排 + 可选 `uiConfig` 参数；文件头注释的解析顺序同步改）
- Test: `tests/creds.test.ts`（新增 UI 级用例；**翻转** 121 行旧用例 (c)）

**Interfaces:**
- Consumes: `UiLlmConfig` from `src/settings.ts`（type-only import）。
- Produces: `loadClaudeCreds(uiConfig?: UiLlmConfig | null): ClaudeCreds`——Task 3/5 以此签名接线；UI 级 `source='ui'`。

- [ ] **Step 1: 写失败测试（追加到 `tests/creds.test.ts`）**

文件顶端加注释说明回归意图；新增用例：

```ts
// 回归防护（2026-07-30 事故）：settings.json 必须先于进程 env；
// UI 配置必须最高优先。spec: docs/superpowers/specs/2026-07-30-llm-settings-ui-design.md
test('(f) settings.json authToken 优先于进程 env（事故回归：持久 env 不得静默劫持）', () => {
  // 复用本文件既有的 HOME/settings.json mock 模式：
  // settings.json env 含 ANTHROPIC_AUTH_TOKEN=sk-settings-token + BASE_URL=https://settings.example.com
  // 进程 env 含 ANTHROPIC_AUTH_TOKEN=sk-env-token + BASE_URL=https://env.example.com
  const creds = loadClaudeCreds()
  expect(creds.apiKey).toBe('sk-settings-token')
  expect(creds.baseURL).toBe('https://settings.example.com')
  expect(creds.source).toBe('settings.json:authToken')
})

test('(g) UI 配置整级短路：token 非空即生效，source=ui', () => {
  const creds = loadClaudeCreds({ token: 'sk-ui-token-123456', baseURL: 'https://ui.example.com', model: 'ui-model' })
  expect(creds).toEqual({ apiKey: 'sk-ui-token-123456', baseURL: 'https://ui.example.com', model: 'ui-model', source: 'ui' })
})

test('(h) UI 配置 baseURL/model 缺省 -> 不携带（调用方回默认）', () => {
  const creds = loadClaudeCreds({ token: 'sk-ui-token-123456' })
  expect(creds.baseURL).toBeUndefined()
  expect(creds.model).toBeUndefined()
  expect(creds.source).toBe('ui')
})

test('(i) uiConfig 为 null / token 为空 -> 落到兜底链', () => {
  const a = loadClaudeCreds(null)
  const b = loadClaudeCreds({})
  // 两者均不得返回 source='ui'；具体落哪级由本用例的 mock 环境决定，断言不短路即可
  expect(a.source).not.toBe('ui')
  expect(b.source).not.toBe('ui')
})
```

**翻转既有用例 (c)**（`tests/creds.test.ts:121`）：原标题 `'(c) process env ANTHROPIC_API_KEY wins over settings.json authToken'`。链重排后 settings.json 的 authToken 应赢过进程 env 的 `ANTHROPIC_API_KEY` 吗？——注意 `pickFromEnv` 内部是 apiKey-then-authToken，跨级比较是整级短路：settings.json 级（其 env 块内含 authToken）整体先于进程 env 级（含 apiKey）。所以新预期：返回 settings.json 的 authToken。改标题为 `'(c) settings.json authToken 优先于进程 env ANTHROPIC_API_KEY（2026-07-30 事故后链重排）'`，断言改为 settings.json 的值。

- [ ] **Step 2: 跑测试确认红**

Run: `bun test tests/creds.test.ts`
Expected: (f)(g)(h) FAIL；(c) 按新预期 FAIL（当前实现 env 优先）

- [ ] **Step 3: 实现 `src/creds.ts`**

```ts
import type { UiLlmConfig } from './settings'
```

`loadClaudeCreds` 改为：

```ts
/**
 * 解析顺序（2026-07-30 重排，spec: docs/superpowers/specs/2026-07-30-llm-settings-ui-design.md）：
 *   1. UI 配置（uiConfig 参数，daemon 从 app_settings 表读；token 非空整级短路，
 *      baseURL/model 缺省则不携带 -> 调用方回官方端点 / DISTILL_MODEL）
 *   2. ~/.claude/settings.json 的 env 块（用户主动维护的文件，先于 env）
 *   3. 进程 env（持久 env 残留不得再静默劫持 settings.json —— 2026-07-30 事故）
 *   4. ~/.claude/.credentials.json（形状探测，不变）
 * 不抛异常：任何文件读取/解析失败降级到下一级。
 */
export function loadClaudeCreds(uiConfig?: UiLlmConfig | null): ClaudeCreds {
  if (uiConfig?.token) {
    return {
      apiKey: uiConfig.token,
      ...(uiConfig.baseURL ? { baseURL: uiConfig.baseURL } : {}),
      ...(uiConfig.model ? { model: uiConfig.model } : {}),
      source: 'ui',
    }
  }
  const fromSettings = pickFromEnv(loadSettingsEnv(), 'settings.json')
  if (fromSettings) return fromSettings
  const fromProc = pickFromEnv(process.env, 'env')
  if (fromProc) return fromProc
  // ...credentials.json 探测段保持原样...
  return { apiKey: null, source: 'none' }
}
```

文件头第 113-135 行的顺序注释同步替换为上面新顺序。

- [ ] **Step 4: 跑测试确认绿 + 全量回归**

Run: `bun test tests/creds.test.ts tests/anthropic.test.ts && bun run typecheck`
Expected: PASS（anthropic 测试注入 mock loadClaudeCreds，不受签名可选参数影响）

- [ ] **Step 5: Commit**

```bash
git add src/creds.ts tests/creds.test.ts
git commit -m "feat(creds): 凭证链重排 settings.json 先于 env + UI 配置最高优先（事故回归防护）"
```

---

### Task 3: anthropic.ts — makeLLMCall 接 loadUiConfig + testConnection

**Files:**
- Modify: `src/anthropic.ts`（deps 加 `loadUiConfig`；新增 `testConnection`）
- Test: `tests/anthropic.test.ts`（追加；沿用该文件既有 mock `@anthropic-ai/sdk` 模式）

**Interfaces:**
- Consumes: `UiLlmConfig`（src/settings.ts）、`loadClaudeCreds(uiConfig?)`（Task 2）。
- Produces:
  ```ts
  export interface AnthropicDeps {
    loadClaudeCreds?: (uiConfig?: UiLlmConfig | null) => ClaudeCreds
    loadUiConfig?: () => UiLlmConfig | null
  }
  export function testConnection(
    cfg: { baseURL?: string; token: string; model?: string },
    opts?: { timeoutMs?: number },
  ): Promise<{ ok: boolean; error?: string }>
  ```
  Task 5 的 server 端点用 `testConnection` 作默认实现。

- [ ] **Step 1: 写失败测试（追加 `tests/anthropic.test.ts`）**

```ts
test('callLLM 把 loadUiConfig 的结果传给 loadClaudeCreds（UI 级注入点）', async () => {
  // 沿用本文件既有 mock 模式捕获 loadClaudeCreds 收到的参数
  const seen: unknown[] = []
  const call = makeLLMCall({
    loadClaudeCreds: (ui?: any) => { seen.push(ui); return { apiKey: 'k', model: 'm', source: 'ui' } },
    loadUiConfig: () => ({ token: 'sk-ui-token-123456', baseURL: 'https://ui.example.com' }),
  })
  await call('sys', 'user')
  expect(seen).toEqual([{ token: 'sk-ui-token-123456', baseURL: 'https://ui.example.com' }])
})

test('testConnection: SDK 成功 -> {ok:true}', async () => {
  // mock messages.create resolve
  const r = await testConnection({ token: 'sk-abcdefghijklmn' })
  expect(r).toEqual({ ok: true })
})

test('testConnection: SDK 抛 401 -> {ok:false,error 含 401}', async () => {
  // mock messages.create reject new Error('401 {"error":...}')
  const r = await testConnection({ token: 'sk-abcdefghijklmn' })
  expect(r.ok).toBe(false)
  expect(r.error).toContain('401')
})

test('testConnection: 走 cfg.baseURL 与 cfg.model 进 SDK', async () => {
  // 断言 ctor 收到 baseURL、create 收到 model/max_tokens=1
})
```

- [ ] **Step 2: 跑测试确认红**

Run: `bun test tests/anthropic.test.ts`
Expected: FAIL（`testConnection` 未定义；deps 无 `loadUiConfig`）

- [ ] **Step 3: 实现**

`src/anthropic.ts`：

```ts
import { loadClaudeCreds, type ClaudeCreds } from './creds'
import type { UiLlmConfig } from './settings'

export interface AnthropicDeps {
  loadClaudeCreds?: (uiConfig?: UiLlmConfig | null) => ClaudeCreds
  /** UI 级配置读取（daemon 注入 db-backed；缺省 = 无 UI 级）。 */
  loadUiConfig?: () => UiLlmConfig | null
}
```

`makeLLMCall` 内 `const creds = load(deps.loadUiConfig ? deps.loadUiConfig() : undefined)`。文件头注释补一句：UI 配置经由 `loadUiConfig` 注入，整级短路语义见 `creds.ts`。

文件末尾新增：

```ts
/**
 * 「测试连接」端点的默认实现：用给定配置发 max_tokens=1 的最小请求。
 * 不保存任何配置；错误描述透传（与 distiller 错误格式同源：Error.message）。
 * 默认超时 15s。
 */
export async function testConnection(
  cfg: { baseURL?: string; token: string; model?: string },
  opts?: { timeoutMs?: number },
): Promise<{ ok: boolean; error?: string }> {
  try {
    const client = new Anthropic({
      apiKey: cfg.token,
      ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}),
    })
    await client.messages.create(
      { model: cfg.model ?? DISTILL_MODEL, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] },
      { timeout: opts?.timeoutMs ?? 15_000 },
    )
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
```

- [ ] **Step 4: 跑测试确认绿**

Run: `bun test tests/anthropic.test.ts && bun run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/anthropic.ts tests/anthropic.test.ts
git commit -m "feat(anthropic): makeLLMCall 接 UI 配置注入点 + testConnection（测试连接）"
```

---

### Task 4: daemon 接线（UI 配置注入 distill 链路）

**Files:**
- Modify: `src/daemon.ts`（`resolveCallLLM` 加可选 `db` 参数；`runDistillOnce` / `startDaemon` 传入）
- Test: `tests/daemon.test.ts`（追加一条接线断言）

**Interfaces:**
- Consumes: `loadUiLlmConfig`（Task 1）、`AnthropicDeps.loadUiConfig`（Task 3）。
- Produces: `resolveCallLLM(deps?, db?)` 内部使用；外部接口（`runDistillOnce`/`startDaemon` 签名）不变。

- [ ] **Step 1: 写失败测试（追加 `tests/daemon.test.ts`）**

```ts
// 接线回归：UI 配置必须能进入 anthropic 链的 loadUiConfig。
test('runDistillOnce 的 anthropic 链带 db-backed loadUiConfig（UI 配置进 distill 链路）', async () => {
  // 模式：建 tmp db，saveUiLlmConfig 写入 token；注入 loadClaudeCreds 捕获 uiConfig 参数；
  // 构造一个 pending job + event，跑 runDistillOnce，断言捕获到 { token: 'sk-ui-...' }
  // （job/event 构造参照本文件既有用例）
})
```

- [ ] **Step 2: 跑测试确认红**

Run: `bun test tests/daemon.test.ts`
Expected: FAIL（捕获到 undefined —— loadUiConfig 未接线）

- [ ] **Step 3: 实现 `src/daemon.ts`**

```ts
import { loadUiLlmConfig } from './settings'

function resolveCallLLM(deps: ResolveCallLLMDeps = {}, db?: DbClient): LLMCall {
  return resolveLLMBackend(process.env) === 'openai'
    ? makeOpenAiCall(deps.loadOpenAiCreds ? { loadOpenAiCreds: deps.loadOpenAiCreds } : {})
    : makeAnthropicCall({
        ...(deps.loadClaudeCreds ? { loadClaudeCreds: deps.loadClaudeCreds } : {}),
        ...(db ? { loadUiConfig: () => loadUiLlmConfig(db) } : {}),
      })
}
```

`runDistillOnce` 内 `resolveCallLLM({...}, db)`；`startDaemon` 内同样把 `db` 传入（找到其 `resolveCallLLM(...)` 调用点补第二参）。注释补一句：openai 后端路径不接 UI 配置（已知限制，见 plan Global Constraints）。

- [ ] **Step 4: 跑测试确认绿 + 全量**

Run: `bun test tests/daemon.test.ts && bun run typecheck && bun test`
Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add src/daemon.ts tests/daemon.test.ts
git commit -m "feat(daemon): UI 配置注入 distill 的 anthropic 凭证链"
```

---

### Task 5: server 三端点（GET/PUT /api/settings/llm + POST test）

**Files:**
- Modify: `src/server.ts`（AppDeps 加 4 个可选注入；三个路由，放在 `/api/distill-runs` 组之后）
- Test: `tests/settings-api.test.ts`（新建；app 构造模式参照 `tests/server.test.ts`）

**Interfaces:**
- Consumes: `loadUiLlmConfig/saveUiLlmConfig/maskToken`（Task 1）、`loadClaudeCreds`（Task 2）、`testConnection`（Task 3）。
- Produces（Task 6/7 依赖的响应形状）:
  ```ts
  // GET /api/settings/llm 与 PUT 的响应：
  interface LlmSettingsState {
    saved: { baseURL: string | null; model: string | null; tokenMasked: string } | null
    effective: { source: string; baseURL: string | null; model: string | null; tokenMasked: string } | null
  }
  // POST /api/settings/llm/test 的响应：{ ok: boolean; error?: string }
  ```
- AppDeps 新增（均可选，缺省走真实实现）:
  ```ts
  loadUiConfig?: () => UiLlmConfig | null
  saveUiConfig?: (patch: { baseURL?: string; token?: string; model?: string; clear?: boolean }) => void
  loadEffectiveCreds?: () => ClaudeCreds
  testConnection?: (cfg: { baseURL?: string; token: string; model?: string }) => Promise<{ ok: boolean; error?: string }>
  ```

- [ ] **Step 1: 写失败测试 `tests/settings-api.test.ts`**

```ts
// spec: docs/superpowers/specs/2026-07-30-llm-settings-ui-design.md §接口契约
import { test, expect } from 'bun:test'
// ...参照 tests/server.test.ts 构造 createApp({ db, adapter, enqueueDistillJob, broadcast })
// 注入假 saveUiConfig/loadUiConfig/loadEffectiveCreds/testConnection，避免碰真实 ~/.claude 与网络

test('GET 无 UI 配置 -> saved:null + effective 为注入的兜底级', ...)
test('PUT 保存后 GET 回显 tokenMasked 且不含明文 token', async () => {
  // PUT {baseURL, token:'sk-kimiabcdef12345678fh', model}
  // GET -> saved.tokenMasked === 'sk-kim…5678fh'；响应 JSON 字符串不含 'sk-kimiabcdef12345678fh'
})
test('PUT token 缺省 -> 保持已存 token（字段级合并）', ...)
test('PUT clear:true -> saved 变 null', ...)
test('PUT 非法 baseURL（非 http URL）-> 400', ...)
test('POST test 空 body 用已保存配置；无凭证 -> {ok:false,error:"no credentials"}', ...)
test('POST test body 带 token -> 调注入的 testConnection，成功/失败透传', ...)
test('GET 存储异常 -> saved:null 不 500', async () => {
  // loadUiConfig 注入抛错 -> 200 且 saved:null
})
```

- [ ] **Step 2: 跑测试确认红**

Run: `bun test tests/settings-api.test.ts`
Expected: FAIL（404）

- [ ] **Step 3: 实现 `src/server.ts`**

import 增加：

```ts
import { z } from 'zod'
import { loadUiLlmConfig, saveUiLlmConfig, maskToken, type UiLlmConfig } from '@/settings'
import { loadClaudeCreds, type ClaudeCreds } from './creds'
import { testConnection as defaultTestConnection } from './anthropic'
```

AppDeps 加上面 4 个可选字段。`createApp` 顶部：

```ts
const loadUi = deps.loadUiConfig ?? (() => loadUiLlmConfig(deps.db))
const saveUi = deps.saveUiConfig ?? ((patch: { baseURL?: string; token?: string; model?: string; clear?: boolean }) => saveUiLlmConfig(deps.db, patch))
const loadEff = deps.loadEffectiveCreds ?? (() => loadClaudeCreds(loadUi()))
const testConn = deps.testConnection ?? defaultTestConnection

const buildState = () => {
  let saved: UiLlmConfig | null = null
  try { saved = loadUi() } catch { /* 存储异常降级 saved:null，不 500（spec） */ }
  let effective: ClaudeCreds | null = null
  try { const c = loadEff(); effective = c.apiKey ? c : null } catch { effective = null }
  return {
    saved: saved?.token
      ? { baseURL: saved.baseURL ?? null, model: saved.model ?? null, tokenMasked: maskToken(saved.token) }
      : null,
    effective: effective?.apiKey
      ? {
          source: effective.source,
          baseURL: effective.baseURL ?? null,
          model: effective.model ?? null,
          tokenMasked: maskToken(effective.apiKey),
        }
      : null,
  }
}
```

路由：

```ts
app.get('/api/settings/llm', (c) => c.json(buildState()))

const putSchema = z.object({
  baseURL: z.string().regex(/^https?:\/\//, 'baseURL must be http(s) URL').optional().or(z.literal('')),
  token: z.string().optional(),
  model: z.string().optional(),
  clear: z.boolean().optional(),
})
app.put('/api/settings/llm', async (c) => {
  const parsed = putSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'invalid body' }, 400)
  saveUi(parsed.data)
  return c.json(buildState())
})

const testSchema = z.object({
  baseURL: z.string().optional(),
  token: z.string().optional(),
  model: z.string().optional(),
})
app.post('/api/settings/llm/test', async (c) => {
  const body = testSchema.parse(await c.req.json().catch(() => ({})))
  const saved = loadUi()
  const cfg = {
    baseURL: body.baseURL ?? saved?.baseURL,
    token: body.token ?? saved?.token,
    model: body.model ?? saved?.model,
  }
  if (!cfg.token) return c.json({ ok: false, error: 'no credentials' })
  return c.json(await testConn({ baseURL: cfg.baseURL, token: cfg.token, model: cfg.model }))
})
```

- [ ] **Step 4: 跑测试确认绿 + 全量**

Run: `bun test tests/settings-api.test.ts tests/server.test.ts && bun run typecheck && bun test`
Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add src/server.ts tests/settings-api.test.ts
git commit -m "feat(server): LLM 设置三端点（GET/PUT/test，token 打码 + 字段级合并 + 降级）"
```

---

### Task 6: Web client（api.ts 三函数）

**Files:**
- Modify: `src/web/api.ts`（追加）
- Test: `tests/web-api.test.ts`（追加；沿用该文件 fetchFn mock 模式）

**Interfaces:**
- Produces（Task 7 UI 依赖）:
  ```ts
  export interface LlmSettingsState {
    saved: { baseURL: string | null; model: string | null; tokenMasked: string } | null
    effective: { source: string; baseURL: string | null; model: string | null; tokenMasked: string } | null
  }
  export function getLlmSettings(fetchFn?: FetchLike): Promise<LlmSettingsState>
  export function saveLlmSettings(body: { baseURL?: string; token?: string; model?: string; clear?: boolean }, fetchFn?: FetchLike): Promise<LlmSettingsState>
  export function testLlmConnection(body: { baseURL?: string; token?: string; model?: string }, fetchFn?: FetchLike): Promise<{ ok: boolean; error?: string }>
  ```

- [ ] **Step 1: 写失败测试（追加 `tests/web-api.test.ts`）**

```ts
test('getLlmSettings 解析 saved/effective', async () => {
  const state = await getLlmSettings(async () => new Response(JSON.stringify({
    saved: { baseURL: 'https://a', model: 'm', tokenMasked: 'sk-kim…5678fh' },
    effective: { source: 'ui', baseURL: 'https://a', model: 'm', tokenMasked: 'sk-kim…5678fh' },
  })) as Response)
  expect(state.effective?.source).toBe('ui')
})
test('saveLlmSettings PUT 序列化 body（含 clear）', async () => {
  let seen: any
  await saveLlmSettings({ clear: true }, async (_url, init) => { seen = JSON.parse(String(init?.body)); return new Response('{}') } as any)
  expect(seen).toEqual({ clear: true })
})
test('testLlmConnection POST 到 /api/settings/llm/test 并透传 {ok,error}', ...)
```

- [ ] **Step 2: 跑测试确认红**

Run: `bun test tests/web-api.test.ts`
Expected: FAIL（函数未导出）

- [ ] **Step 3: 实现（`src/web/api.ts` 追加）**

```ts
// --- LLM 设置（凭证 UI 配置）client -------------------------------------------

export interface LlmSettingsState {
  saved: { baseURL: string | null; model: string | null; tokenMasked: string } | null
  effective: { source: string; baseURL: string | null; model: string | null; tokenMasked: string } | null
}

/** GET /api/settings/llm — saved = UI 配置（打码）；effective = 当前凭证链生效级。 */
export async function getLlmSettings(fetchFn: FetchLike = fetch): Promise<LlmSettingsState> {
  const res = await fetchFn('/api/settings/llm')
  return (await res.json()) as LlmSettingsState
}

/** PUT /api/settings/llm — 字段级合并；clear:true 删除整级。返回最新状态。 */
export async function saveLlmSettings(
  body: { baseURL?: string; token?: string; model?: string; clear?: boolean },
  fetchFn: FetchLike = fetch,
): Promise<LlmSettingsState> {
  const res = await fetchFn('/api/settings/llm', {
    method: 'PUT',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
  return (await res.json()) as LlmSettingsState
}

/** POST /api/settings/llm/test — 不保存，当场验证凭证。空 body 测已保存配置。 */
export async function testLlmConnection(
  body: { baseURL?: string; token?: string; model?: string },
  fetchFn: FetchLike = fetch,
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetchFn('/api/settings/llm/test', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
  return (await res.json()) as { ok: boolean; error?: string }
}
```

- [ ] **Step 4: 跑测试确认绿**

Run: `bun test tests/web-api.test.ts && bun run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/web/api.ts tests/web-api.test.ts
git commit -m "feat(web-api): LLM 设置 client 三函数（get/save/test）"
```

---

### Task 7: Web UI 设置区块 + 生效回显行

**Files:**
- Modify: `src/web/ui-utils.ts`（加 `llmSourceLabel`）
- Modify: `src/web/App.tsx`（import 三函数；新增 `LlmSettings` 组件；挂在状态栏下方）
- Test: `tests/ui-utils.test.ts`（`llmSourceLabel` 用例）、`tests/web-ui.test.ts`（源码文本断言）

**Interfaces:**
- Consumes: Task 6 三函数 + `LlmSettingsState`。
- Produces: `llmSourceLabel(source: string | null): string`——`'ui'→'UI 配置'`、`'settings.json:*'→'settings.json'`、`'env:*'→'进程 env'`、`'credentials.json:*'→'credentials.json'`、`null→'未配置'`。

- [ ] **Step 1: 写失败测试**

`tests/ui-utils.test.ts` 追加：

```ts
test('llmSourceLabel 映射各来源', () => {
  expect(llmSourceLabel('ui')).toBe('UI 配置')
  expect(llmSourceLabel('settings.json:authToken')).toBe('settings.json')
  expect(llmSourceLabel('settings.json:apiKey')).toBe('settings.json')
  expect(llmSourceLabel('env:authToken')).toBe('进程 env')
  expect(llmSourceLabel('credentials.json:apiKey')).toBe('credentials.json')
  expect(llmSourceLabel(null)).toBe('未配置')
})
```

`tests/web-ui.test.ts` 追加（沿用该文件读源码文本断言的模式）：

```ts
// 兜底回归（CLAUDE.md 最低限度）：生效回显行与三按钮必须存在于 App.tsx 源码
test('App.tsx 含 LLM 设置区块：生效回显行 + 保存/测试连接/清除', () => {
  const src = readFileSync(join(__dirname, '../src/web/App.tsx'), 'utf8')
  expect(src).toContain('当前生效')
  expect(src).toContain('测试连接')
  expect(src).toContain('getLlmSettings')
  expect(src).toContain('saveLlmSettings')
  expect(src).toContain('testLlmConnection')
})
```

- [ ] **Step 2: 跑测试确认红**

Run: `bun test tests/ui-utils.test.ts tests/web-ui.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`src/web/ui-utils.ts` 追加：

```ts
/** LLM 凭证来源标签（生效回显行用）。null = 凭证链无可用凭证。 */
export function llmSourceLabel(source: string | null): string {
  if (source === null) return '未配置'
  if (source === 'ui') return 'UI 配置'
  if (source.startsWith('settings.json')) return 'settings.json'
  if (source.startsWith('env')) return '进程 env'
  if (source.startsWith('credentials.json')) return 'credentials.json'
  return source
}
```

`src/web/App.tsx`：import 区加 `getLlmSettings, saveLlmSettings, testLlmConnection, type LlmSettingsState`（from './api'）与 `llmSourceLabel`（from './ui-utils'）。新增组件（放在 `MemoryCard` 组件定义附近，文件尾部组件区）：

```tsx
/** LLM 设置区块（spec：状态可见性 + 生效回显硬需求）。
 * 常驻生效回显行：当前生效来源 · baseURL · model · 打码 token。
 * 三输入框 + 保存 / 测试连接 / 清除；token 留空保存 = 保持原值。 */
function LlmSettings() {
  const [state, setState] = useState<LlmSettingsState | null>(null)
  const [baseURL, setBaseURL] = useState('')
  const [token, setToken] = useState('')
  const [model, setModel] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = async () => {
    try { setState(await getLlmSettings()); setError(null) }
    catch (e) { setError(String(e)) } // fetch 失败显错误（不静默）
  }
  useEffect(() => { void refresh() }, [])

  const onSave = async () => {
    setBusy(true); setMsg(null)
    try {
      setState(await saveLlmSettings({
        ...(baseURL !== '' ? { baseURL } : {}),
        ...(token !== '' ? { token } : {}),
        ...(model !== '' ? { model } : {}),
      }))
      setToken(''); setMsg('已保存')
    } catch (e) { setMsg(`保存失败: ${e}`) }
    finally { setBusy(false) }
  }
  const onClear = async () => {
    setBusy(true); setMsg(null)
    try { setState(await saveLlmSettings({ clear: true })); setBaseURL(''); setModel(''); setMsg('已清除 UI 配置') }
    catch (e) { setMsg(`清除失败: ${e}`) }
    finally { setBusy(false) }
  }
  const onTest = async () => {
    setBusy(true); setMsg(null)
    try {
      const r = await testLlmConnection({
        ...(baseURL !== '' ? { baseURL } : {}),
        ...(token !== '' ? { token } : {}),
        ...(model !== '' ? { model } : {}),
      })
      setMsg(r.ok ? '连接成功' : `连接失败: ${r.error ?? '未知错误'}`)
    } catch (e) { setMsg(`测试失败: ${e}`) }
    finally { setBusy(false) }
  }

  const eff = state?.effective ?? null
  return (
    <section style={{ margin: '12px 0', padding: 12, border: '1px solid #ddd', borderRadius: 8 }}>
      <h3 style={{ margin: '0 0 8px' }}>LLM 设置</h3>
      {/* 生效回显行（硬需求）：让用户一眼看到当前实际生效的是哪套 API */}
      <div style={{ marginBottom: 8, fontSize: 13 }}>
        当前生效：{eff
          ? <><b>{llmSourceLabel(eff.source)}</b>{' · '}{eff.baseURL ?? '官方端点'}{' · '}{eff.model ?? '默认模型'}{' · '}token <code>{eff.tokenMasked}</code></>
          : <b>未配置</b>}
      </div>
      {error ? <div style={{ color: '#b00', marginBottom: 8 }}>设置加载失败: {error}</div> : null}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        <input style={{ flex: '2 1 260px' }} placeholder={state?.saved?.baseURL ?? 'baseURL（留空=官方端点）'}
          value={baseURL} onChange={(e) => setBaseURL(e.target.value)} />
        <input style={{ flex: '2 1 260px' }} placeholder={state?.saved ? `token（留空保持 ${state.saved.tokenMasked}）` : 'token'}
          value={token} onChange={(e) => setToken(e.target.value)} />
        <input style={{ flex: '1 1 180px' }} placeholder={state?.saved?.model ?? 'model（留空=默认）'}
          value={model} onChange={(e) => setModel(e.target.value)} />
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button disabled={busy} onClick={() => void onSave()}>保存</button>
        <button disabled={busy} onClick={() => void onTest()}>测试连接</button>
        <button disabled={busy} onClick={() => void onClear()}>清除</button>
        {busy ? <span style={{ color: '#888' }}>处理中…</span> : null}
        {msg ? <span style={{ color: msg.startsWith('连接失败') || msg.includes('失败') ? '#b00' : '#080' }}>{msg}</span> : null}
      </div>
    </section>
  )
}
```

主组件 JSX 中状态栏（`{status ? (...) : ...}` 区块）之后插入 `<LlmSettings />`。

- [ ] **Step 4: 跑测试确认绿 + 全量**

Run: `bun test tests/ui-utils.test.ts tests/web-ui.test.ts && bun run typecheck && bun test`
Expected: 全绿

- [ ] **Step 5: 手动冒烟（真 daemon + vite dev）**

```bash
bun run src/cli.ts start   # 终端 A
bun run dev:web            # 终端 B
```

浏览器开 5173：设置区块显示「当前生效」行；填入一组有效凭证 → 测试连接 = 成功；保存后回显行来源变「UI 配置」；清除后回退到兜底来源。

- [ ] **Step 6: Commit**

```bash
git add src/web/ui-utils.ts src/web/App.tsx tests/ui-utils.test.ts tests/web-ui.test.ts
git commit -m "feat(web): LLM 设置区块（生效回显行 + 保存/测试连接/清除）"
```

---

### Task 8: 收尾 — STATE.md + 验证 + PR

**Files:**
- Modify: `STATE.md`（记录本功能交付 + 事故根因与修复方式）

- [ ] **Step 1: 全量验证**

Run: `bun run typecheck && bun test`
Expected: 全绿（这是 push 门槛，CLAUDE.md）

- [ ] **Step 2: 更新 STATE.md**

在 STATE.md 顶部「当前状态」区追加一条：本功能（分支、spec/plan 路径、任务数）、事故根因一句话（持久 env 静默劫持 → UI 配置最高优先 + settings.json 先于 env + 生效回显）。

- [ ] **Step 3: Commit + push + 开 PR**

```bash
git add STATE.md
git commit -m "docs(state): 记录 LLM 凭证 UI 配置交付（8-task）"
git -c http.sslBackend=openssl push -u origin feat/llm-settings-ui
gh pr create --base master --title "feat: LLM 凭证 UI 配置（修复持久 env 静默劫持事故）" --body "spec: docs/superpowers/specs/2026-07-30-llm-settings-ui-design.md"
```

> push 必须带 `-c http.sslBackend=openssl`（本机代理 + schannel 握手失败，见记忆 git-push-openssl-backend）。

- [ ] **Step 4: 事故环境层收尾（提醒用户，不代做）**

PR 描述与本 Task 完成后向用户复述：Windows 用户级过期 env（`ANTHROPIC_BASE_URL=cn.luckyapi.chat` + 旧 token）是否删除由用户决定——功能上线后它不再能劫持（settings.json 已先于 env），但未配置时仍会被回显行暴露。

## Self-Review 记录

- Spec 覆盖：四级链(T2) / 整级短路(T1,T2) / app_settings(T1) / 打码(T1,T5) / GET·PUT·test 端点(T5) / 字段级合并(T1,T5) / 生效回显行(T7) / 测试按钮(T3,T5,T6,T7) / fetch 失败横幅与加载态(T7) / 存储异常降级(T5) / 测试策略 1-6(T1-T7) / STATE.md(T8)。非目标均未被任务越界。
- 类型一致：`UiLlmConfig`(T1)→creds(T2)/anthropic(T3)/server(T5) 同一形状；`LlmSettingsState`(T5 定义/T6 导出/T7 消费) 字段一致；`maskToken`(T1)→T5 使用。
- 已知取舍：openai 后端不接 UI 配置（Global Constraints 注明）；GET 的 `effective` 由 `loadEffectiveCreds` 现算，不缓存（与每次调用现读语义一致）。

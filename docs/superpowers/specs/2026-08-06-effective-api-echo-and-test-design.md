# 生效 API 回显与测试连接设计 spec

- 日期：2026-08-06
- 状态：已批准（brainstorming 逐节确认）
- 关联 plan：`docs/superpowers/plans/2026-08-06-effective-api-echo-and-test.md`
- 前置：`docs/superpowers/specs/2026-08-06-dual-protocol-llm-settings-design.md`（双协议已合并入 master）

## 背景与问题

双协议功能合并后，Web UI 的「生效回显行」与「测试连接」存在两处缺口：

1. **生效回显不反映真正生效的 API**（`src/server.ts:100,113-128`）：`effective` 恒走 `loadClaudeCreds`（Anthropic 四级链），与协议无关。协议为 openai 时（env 有 `OPENAI_API_KEY` 或 UI 选 openai），distill 实际用 OpenAI creds，但回显行展示的仍是 Anthropic 链的 token/baseURL/model。这是双协议功能 final review 的 I-1（已 park 为 deferred）。
2. **测试连接测不到非-UI 的生效 API**（`src/server.ts:498-509`）：body 留空时只回落到 `saved`（UI 配置）。UI 未配置、API 靠 env/settings.json 生效时，`saved` 为 null、body 无 token -> 直接 `{ok:false,error:'no credentials'}`，测不了生效的那套。

**目标**：
1. 生效回显行显示真正生效的 API（按协议派发解析）。
2. 生效配置旁加「测试生效」按钮，测当前真正生效的 API。
3. 保留原「测试连接」按钮（测输入框 / 已保存 UI 配置）。

**非目标**：
- 不改原 `POST /api/settings/llm/test` 端点语义（仍测输入框 / 已保存 UI 配置）。
- 不为 OpenAI 引入 settings.json / credentials.json 链（与双协议 spec 一致，OpenAI 链保持 UI -> env 两级）。
- 不改 distill 调用路径（本特性只影响展示与测试探测）。

## 决策记录

1. **生效 API 解析**：镜像 distill 路径。新增 `loadEffectiveOpenAiCreds(ui, env)`，与 distill 实际调用的 `loadOpenAiUiCreds` 同源；anthropic 协议保持 `loadClaudeCreds` 四级链。`buildState` 按协议派发解析 effective。
2. **测生效端点**：新增独立端点 `POST /api/settings/llm/test-effective`，无 body，后端自解析生效 creds + 协议。不复用原 test 端点（语义分离）。
3. **UI 双按钮布局**：生效回显行内加「测试生效」按钮；底部保留原「测试连接」按钮。位置即语义。

## 接口契约

### 生效 API 解析（`src/openai.ts`）

新增纯函数：

```ts
export function loadEffectiveOpenAiCreds(
  ui: UiLlmConfig | null,
  env: Record<string, string | undefined> = process.env,
): OpenAiCreds | null
```

- UI token 存在 -> 用 UI creds（model/baseURL 缺省回 env；model 与 env 都缺则抛 `'OpenAI model missing; ...'`，与 `loadOpenAiUiCreds` 同）。
- 否则读 `OPENAI_API_KEY` env：有 -> 组装 creds（model 缺抛错；baseURL 缺省 `https://api.openai.com/v1`）；无 -> 返回 null。
- **与 `loadOpenAiUiCreds` 同源**：distill 经 `loadOpenAiUiCreds` 走同一逻辑，保证回显/测试与 distill 实际调用一致。

`OpenAiCreds` 增加 `source: string` 字段（用于回显来源标识）：UI 来源 `'ui'`，env 来源 `'env:openai'`。

### server `buildState`（`src/server.ts`）

```ts
const proto = resolveCallLLMProtocol(saved, process.env)
const effective = proto === 'openai'
  ? loadEffectiveOpenAiCreds(saved, process.env)
  : loadClaudeCreds(saved)  // 现状 anthropic 四级链
```

- `effective` 形状不变（`source` / `protocol` / `baseURL` / `model` / `tokenMasked`），openai 时填 OpenAI creds。
- `effective.source`：openai 走 `loadEffectiveOpenAiCreds` 返回的 source；anthropic 走 `loadClaudeCreds` 现有 source。
- `effective` 仍只回 `maskToken` 打码（硬约束）。
- 无 creds -> `effective: null`。

### test-effective 端点（`src/server.ts`）

```ts
POST /api/settings/llm/test-effective   // 无 body（body 被忽略）
```

- 后端自解析：`saved = loadUi()` -> `proto = resolveCallLLMProtocol(saved, env)` -> 按 proto 解析生效 creds（与 `buildState` 同源）。
- 无 token -> `{ok:false, error:'no credentials'}`（HTTP 200）。
- 有 token -> `testConn({ protocol: proto, baseURL, token, model })`（复用现有 `testConn` 派发器：openai -> `openAiTestConnection`，anthropic -> `defaultTestConnection`）。
- 存储读异常降级（try/catch），不 500。
- 复用现有可注入 `testConn` dep（测试零网络）。

### Web UI（`src/web/App.tsx` + `src/web/api.ts`）

- `api.ts` 新增 `testEffectiveLlmConnection(fetchFn?): Promise<{ok, error?}>`，POST `/api/settings/llm/test-effective`，空 body。
- `App.tsx` 生效回显行（`eff` 非空时）末尾加「测试生效」按钮，调 `testEffectiveLlmConnection()`。
- 底部按钮行保留原「测试连接」按钮不动。
- 两按钮共用 `msg` / `busy` 状态（互斥：点任一都置 busy）。

## 数据流

```
GET /api/settings/llm
  └─ buildState()
       ├─ saved = loadUiLlmConfig(db)
       ├─ proto = resolveCallLLMProtocol(saved, env)
       ├─ proto=anthropic -> effective = loadClaudeCreds(saved)        # 四级链
       └─ proto=openai    -> effective = loadEffectiveOpenAiCreds(saved, env)  # UI->env
       └─ 返回 { saved, effective(打码) }

POST /api/settings/llm/test-effective   (无 body)
  └─ saved = loadUi(); proto = resolveCallLLMProtocol(saved, env)
  └─ proto=anthropic -> creds = loadClaudeCreds(saved)
     proto=openai    -> creds = loadEffectiveOpenAiCreds(saved, env)
  └─ 无 token -> {ok:false, error:'no credentials'}
  └─ testConn({protocol:proto, baseURL, token, model})  # 按协议派发，不碰网络(注入)

UI 生效行 [测试生效] -> testEffectiveLlmConnection() -> test-effective
UI 底部  [测试连接]  -> testLlmConnection({...})      -> test（测输入框/已保存，不变）
```

## 与现有模块的耦合点

| 模块 | 改动 |
|------|------|
| `src/openai.ts` | 新增 `loadEffectiveOpenAiCreds`；`OpenAiCreds` 加 `source` 字段 |
| `src/server.ts` | `buildState` 按协议派发 effective；新增 `POST /api/settings/llm/test-effective` |
| `src/web/api.ts` | 新增 `testEffectiveLlmConnection` |
| `src/web/App.tsx` | 生效行内加「测试生效」按钮 |
| `src/daemon.ts` | 不变（distill 路径不动） |
| `src/creds.ts` | 不变 |
| `src/llm.ts` | 不变 |
| `src/settings.ts` | 不变 |

## 失败模式与降级

- **`loadEffectiveOpenAiCreds` 不抛异常**：env 缺返回 null（与 `loadOpenAiCreds` 一致）；model 缺抛错只在"有 key 无 model"时（明确配置错误，交调用方处理）。
- **test-effective 无 creds**：`{ok:false, error:'no credentials'}`（HTTP 200，业务结果）。
- **测试请求失败**：错误透传（与原 test 端点同源 `Error.message`）。
- **存储读异常**：`buildState` 与 test-effective 都 try/catch 降级，不 500。
- **生效 creds 来自 env**：回显与测试都用打码 token / 现解析 creds，不泄露明文。

## 测试策略

1. **`loadEffectiveOpenAiCreds` 纯函数**：UI token 存在用 UI / 否则 env / 都缺返回 null / source 标识正确（`tests/openai.test.ts`）。
2. **`buildState` 按协议派发**：openai 协议下 effective 反映 OpenAI creds（非 Anthropic 链）、source 正确、token 打码；anthropic 协议回归不变（`tests/settings-api.test.ts`）。
3. **test-effective 端点**：无 body 解析生效 creds、按协议派发 testConn、无 creds 返回 no credentials、存储异常不 500（`tests/settings-api.test.ts`，注入 mock testConn 零网络）。
4. **UI 层**：最低限度一条文本断言（生效行内有「测试生效」按钮 + api.ts 有 `testEffectiveLlmConnection`）（`tests/web-ui.test.ts`）。
5. **回归**：原 `POST /api/settings/llm/test` 端点行为不变（既有用例全绿）。

门槛：`bun run typecheck && bun test` 全绿。

## 验收清单

- [ ] UI 未配置、API 靠 `OPENAI_*` env 生效时，生效回显行显示 OpenAI creds（打码 token + baseURL + model + source），不再是 Anthropic 链内容。
- [ ] 生效回显行内有「测试生效」按钮，点击测当前生效 API（openai 走 `/chat/completions`，anthropic 走 `/v1/messages`）。
- [ ] 底部「测试连接」按钮行为不变（测输入框 / 已保存 UI 配置）。
- [ ] 协议 anthropic 时生效回显与测试回归通过（不回归双协议功能）。
- [ ] 任何 API 路径不回明文 token。
- [ ] `bun run typecheck && bun test` 全绿。
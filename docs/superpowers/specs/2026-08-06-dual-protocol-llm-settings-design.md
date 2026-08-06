# 双协议 LLM 设置（Web UI 支持 Anthropic 与 OpenAI）设计 spec

- 日期：2026-08-06
- 状态：已批准（brainstorming 逐节确认）
- 关联 plan：`docs/superpowers/plans/2026-08-06-dual-protocol-llm-settings.md`

## 背景与问题

memside 的 Web UI LLM 设置面板（`src/web/App.tsx` 的 `LlmSettings`）只支持 **Anthropic 协议**：

- UI 存的 `baseURL` 被 `@anthropic-ai/sdk` 拼成 `{baseURL}/v1/messages`（`src/anthropic.ts:92-99`）。
- 「测试连接」固定走 Anthropic SDK（`src/server.ts:488`）。
- OpenAI 后端（`src/openai.ts`）**不接 UI 配置**，只读 `OPENAI_*` env（`src/openai.ts:22-27`）；`src/daemon.ts:76-82` 的 `resolveCallLLM` 只按 env 在启动时选一次后端。

用户实证：Volcengine Ark 同时暴露两个端点——
`https://ark.cn-beijing.volces.com/api/plan`（Anthropic 协议，`/v1/messages` 尾缀，成功）与
`https://ark.cn-beijing.volces.com/api/plan/v3`（OpenAI 协议，`/v3/chat/completions`）。
把 OpenAI 的 `/v3` baseURL 填进面板会被当成 Anthropic baseURL，请求打到
`.../v3/v1/messages`，Ark 回 401。

**目标**：让 Web UI 设置面板同时支持 Anthropic 与 OpenAI 两种协议，涵盖 distill 调用与测试连接。

**非目标**：
- 不改 Anthropic 侧的四级生效链（`creds.ts:134`）。
- 不为 OpenAI 引入 settings.json / credentials 链（协议本质差异，不硬套）。
- 不重构 vendor-seam（`LLMCall`）本身；保持「核心模块不依赖 SDK」结构保证。

## 决策记录

1. **配置存储模型**：单配置 + 协议开关（用户选定）。`UiLlmConfig` 加 `protocol` 字段，存 `llm.protocol`。已有配置无该 key → 默认 `'anthropic'`（向后兼容）。
2. **选择优先级**：UI 协议优先。UI 配置有 token 时，UI 存的 `protocol` 决定后端；UI 级不存在（无 token）时回退 `resolveLLMBackend(process.env)`（现状，用于 UI 未配置时）。
3. **生效即时性**：协议在**每次调用**现读解析，而非 daemon 启动时定死——UI 切协议无需重启 daemon，与现有「UI 每次现读」行为一致（`anthropic.ts:57`）。

## 接口契约

### 存储层（`src/settings.ts`）

```ts
interface UiLlmConfig {
  protocol: 'anthropic' | 'openai'   // 新增，存 llm.protocol
  baseURL?: string
  token?: string
  model?: string
}
```

- `KEYS` 加一项 `protocol: 'llm.protocol'`。
- `loadUiLlmConfig`：token 缺失时整个 UI 级不存在（现有语义保持）；protocol 缺省回 `'anthropic'`。
- `saveUiLlmConfig`：
  - `patch` 加 `protocol?: 'anthropic' | 'openai'`，提供才 upsert，缺省保持已存值。
  - `clear:true` 连带删除 `llm.protocol`。
- `maskToken` 不变。

### 动态协议派发器（`src/daemon.ts`）

把 `resolveCallLLM(deps, db)` 重构为每次调用动态解析：

```ts
// 每次调用时：
//  1. 读当前 UI 配置（loadUiLlmConfig(db)）
//  2. 定协议：UI 有 token 且 protocol 有值 → 用 UI protocol；
//     否则回退 resolveLLMBackend(process.env)
//  3. 按协议派发到 makeAnthropicCall / makeOpenAiCall，注入当前 UI 配置
```

- 返回类型仍是 `LLMCall`（`src/llm.ts:17`），核心模块无感知。
- 抽纯函数 `resolveCallLLMProtocol(uiConfig, env): 'anthropic' | 'openai'` 承载协议选择逻辑，便于单测（UI token 存在用 UI protocol；否则 env 探测；未知非空值抛错）。

### openai 后端（`src/openai.ts`）

镜像 anthropic 的 `loadUiConfig` 注入：

- `OpenAiDeps` 加 `loadUiConfig?: () => UiLlmConfig | null`。
- 新增 `loadOpenAiUiCreds(uiConfig, env)`：UI token 存在 → 用 UI creds（baseURL/model 缺省回默认）；否则回退 `OPENAI_*` env（现有 `loadOpenAiCreds` 逻辑）。
- `makeLLMCall` 每次调用读取注入的 UI 配置。

### 测试连接（`src/openai.ts` + `src/server.ts`）

- `testConnection` 签名加 `protocol`：`{ protocol, baseURL?, token, model? }`。
- **Anthropic** → 现有 `src/anthropic.ts:87-104`（`messages.create` → `/v1/messages`）。
- **OpenAI** → 新增 `src/openai.ts` 的 `testConnection`：`POST {baseURL}/chat/completions`，`max_tokens:1`，`messages:[{role:'user',content:'hi'}]`，Bearer 鉴权，超时 15s，错误透传。
- `server.ts` test 端点：body 带 `protocol` 本次用；缺省回落到已存 UI 配置的 protocol（再缺省 `'anthropic'`）。

### Web UI（`src/web/App.tsx` + `src/web/api.ts`）

- 设置面板加协议下拉（Anthropic / OpenAI）+ 三个输入框；保存 / 测试 / 清除都带 protocol。
- 生效回显行加协议标识：`当前生效: Anthropic（ui）· baseURL · model · token xxxx`。
- baseURL placeholder 按协议提示（Anthropic 提示 `/v1/messages`，OpenAI 提示 `/v3/chat/completions` 类）。
- `LlmSettingsState` 同步加 `protocol`。
- `api.ts` 的 `saveLlmSettings` / `testLlmConnection` body 透传 protocol。

## 数据流

```
UI 协议下拉 + baseURL/token/model
  └─ PUT /api/settings/llm {protocol, baseURL, token, model}   (server.ts:473)
       └─ saveUiLlmConfig(db, patch) → app_settings (llm.protocol / base_url / auth_token / model)

distill 循环 (1Hz)
  └─ callLLM(system, user)   ← 每次调用现读
       ├─ 读 loadUiLlmConfig(db)
       ├─ resolveCallLLMProtocol(uiConfig, env) → protocol
       ├─ anthropic → makeAnthropicCall().callLLM(...) → {baseURL}/v1/messages
       └─ openai    → makeOpenAiCall().callLLM(...) → {baseURL}/chat/completions

测试连接
  └─ POST /api/settings/llm/test {protocol, baseURL, token, model}   (server.ts:488)
       └─ testConnection({protocol,...})
```

## 与现有模块的耦合点

| 模块 | 改动 |
|------|------|
| `src/settings.ts` | `UiLlmConfig.protocol`、`KEYS`、`load/save` 逻辑 |
| `src/daemon.ts` | `resolveCallLLM` 动态化 + 抽纯函数 |
| `src/openai.ts` | `loadUiConfig` 注入、`loadOpenAiUiCreds`、`testConnection` |
| `src/server.ts` | test 端点协议感知、dispatch testConnection |
| `src/web/App.tsx` | 协议下拉 + 回显 + placeholder |
| `src/web/api.ts` | body 透传 protocol |
| `src/creds.ts` | 不变（Anthropic 四级链原样） |
| `src/llm.ts` | 不变（`LLMCall` / `LLMBackend`） |

## 失败模式与降级

- **某协议缺 creds**：distiller 顶层 try/catch 降级为「本轮无候选」并记 `lastError`（现有机制，不崩循环）。
- **协议切换后 creds 不全**：错误信息明确（OpenAI 无 creds 时 `no OpenAI credentials; set OPENAI_API_KEY...`），UI token 存在时同样生效。
- **存储读异常**：`buildState` 内降级 `saved:null` / `effective:null`，不 500（现有 spec 约束保持）。
- **测试连接**：错误透传（与 distiller 同源 `Error.message`）。

## 测试策略

1. **协议解析纯函数**：`resolveCallLLMProtocol`——UI protocol / env 回退 / 未知值抛错。
2. **`saveUiLlmConfig` / `loadUiLlmConfig`**：protocol 读写、缺省 anthropic、`clear` 连带删 protocol（`tests/settings.test.ts`）。
3. **openai creds 合并**：UI token 存在用 UI / 缺省回退 env（`tests/openai.test.ts`）。
4. **openai testConnection**：mock fetch，验证 URL 拼 `/chat/completions`、请求体、错误透传（`tests/openai.test.ts`）。
5. **server 端点**：PUT 带 protocol / 缺省回落、test 端点协议感知（`tests/settings-api.test.ts`）。
6. **daemon 集成**：`resolveCallLLM` 注入 db，验证 UI 协议驱动后端选择（`tests/daemon.test.ts`）。
7. **UI 层**：最低限度一条文本断言（协议下拉存在 / 回显含协议）（`tests/web-ui.test.ts`）。

门槛：`bun run typecheck && bun test` 全绿。

## 验收清单

- [ ] UI 面板可选协议，保存后生效回显含协议标识。
- [ ] 选 OpenAI + 填 Ark `.../api/plan/v3` → 测试连接请求打到 `.../v3/chat/completions`，不再 401。
- [ ] 选 Anthropic + 填 `.../api/plan` → 依旧走 `/v1/messages`，回归通过。
- [ ] UI 切协议即时生效，无需重启 daemon。
- [ ] 既有无 protocol 的配置默认行为不变（anthropic）。
- [ ] `bun run typecheck && bun test` 全绿。
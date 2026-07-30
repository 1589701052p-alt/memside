# LLM 凭证 UI 配置 — 设计 spec

日期：2026-07-30
状态：已批准（brainstorming 完成，待写实现计划）

## 背景

2026-07-30 线上事故：全部 21 条 distill 运行记录均为 `llm_error`，最新错误为
`401 Invalid token ... new_api_error`。根因链：

1. Windows 用户级持久环境变量残留旧中转站配置
   （`ANTHROPIC_BASE_URL=https://cn.luckyapi.chat` + 已失效 token）。
2. `loadClaudeCreds`（`src/creds.ts:136-158`）的解析顺序是
   **进程 env → settings.json → credentials.json**，进程 env 优先。
3. daemon 启动时继承过期 env，于是永远调旧中转站；
   `~/.claude/settings.json` 里可用的 Kimi 凭证被静默遮挡。
4. 用户无任何界面能看到"当前实际生效的是哪套凭证"，故障长期静默。

教训：配置藏在看不见的地方会静默出错。需要让用户在 Web UI 里直接配置、
并**随时能看到当前生效的凭证来源与端点**。

## 目标

- Web UI 可配置 LLM 凭证三项：baseURL / token / model。
- UI 配置处于凭证链最高优先级，保存后**无需重启 daemon** 下一次 distill 即生效。
- 兜底链顺序调整为 **settings.json 先于进程 env**，消除"持久 env 残留静默劫持"整类故障。
- UI 常驻回显**当前生效来源**（哪一级、baseURL、model、打码 token）。
- 提供「测试连接」按钮，当场验证凭证可用性。

## 非目标

- 不改 capture / inject 链路。
- 不做多配置档（profile）切换。
- 不改写 `~/.claude/settings.json` 文件本体（只读）。
- 不为存量 21 条失败记录做专门回填（由 daemon 正常重试/新事件消化）。
- token 不做加密存储（本地单用户工具，与 settings.json 明文现状一致）。

## 架构与凭证链

`loadClaudeCreds()` 改造为四级链，每级返回
`{ apiKey, baseURL?, model?, source }`：

```
1. UI 配置（sqlite app_settings 表，新增）     source='ui'
2. ~/.claude/settings.json 的 env 块           ← 从第 2 位上调（原第 3）
3. 进程 env                                    ← 从第 1 位下调
4. ~/.claude/.credentials.json（现状不变）
```

短路规则：**整级短路**。UI 级只要 token 非空即整级生效——此时 baseURL 空 =
官方默认端点，model 空 = `DISTILL_MODEL`（`src/anthropic.ts:28`），不做跨级
字段拼接。UI 配置三项全空 = 该级不存在，落入兜底链。

生效时机：`makeLLMCall` 每次调用现读凭证（`src/anthropic.ts:51`），UI 保存
后下一次 distill 调用即读到新值，无需重启 daemon。

### 数据存储

新表 `app_settings`：

```sql
CREATE TABLE app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

三个 key：`llm.base_url` / `llm.auth_token` / `llm.model`。token 明文存储
（见非目标）。建表走 `src/db/client.ts` 既有 migration 套路（旧库检测 +
`CREATE TABLE IF NOT EXISTS`，幂等）。

## 接口契约（daemon 新端点，`src/server.ts`）

| 端点 | 行为 |
|---|---|
| `GET /api/settings/llm` | 返回 `{ saved: { baseURL, model, tokenMasked } \| null, effective: { source, baseURL, model, tokenMasked } \| null }`。`saved` = UI 配置（无则 null）；`effective` = 当前凭证链实际生效级，**无任何可用凭证时为 null**（`source` ∈ `ui / settings.json:apiKey / settings.json:authToken / env:apiKey / env:authToken / credentials.json:*`）。token 一律打码（前 6 + 后 4，短 token 全码），**任何路径不回明文**。存储读取异常时降级为 `saved: null`，不返回 500。 |
| `PUT /api/settings/llm` | body `{ baseURL?, token?, model?, clear? }`，zod 校验（baseURL 非空时须为 http(s) URL）。**字段级合并**语义：① `clear: true` → 删除整级 UI 配置（回落兜底链）；② 否则 `token` 提供且非空 → 更新，`token` 缺省或空 → **保持已存值不变**（避免改 baseURL 时要重填 token）；③ `baseURL` / `model` 提供（含空字符串）→ 覆盖，空字符串 = 清除该字段回默认（官方端点 / `DISTILL_MODEL`）。UI 级生效条件不变：token 非空才整级生效。返回与 GET 同形的新状态。 |
| `POST /api/settings/llm/test` | body 可选：空 body 用已保存的 UI 配置测试；否则用 body 里的 `{ baseURL?, token, model? }` 测试（**不保存**）。发 `max_tokens=1` 的最小 messages 请求，超时 15s。返回 `{ ok: true }` 或 `{ ok: false, error }`，error 透传上游错误描述（与 distiller 错误格式一致）。无凭证可测时返回 `{ ok: false, error: 'no credentials' }`。 |

vite proxy 已覆盖 `/api/`（带尾斜杠），新端点无需改 proxy 配置。

## UI 与生效回显（硬需求）

位置：Web UI 新增「LLM 设置」区块（置于状态栏下方，复用 `App.tsx` 既有
inline style 与 `MemoryCard` 风格，不引入新样式框架）。

- 三个输入框：baseURL / token / model；按钮：保存 / 测试连接 / 清除
  （「清除」发 `clear: true`，删除整级 UI 配置）。
- **生效回显行**（区块顶部常驻）：
  `当前生效：UI 配置 · https://api.kimi.com/coding/ · kimi-for-coding-highspeed · token sk-kim…48fh`。
  未配 UI 配置时显示实际兜底来源，如 `当前生效：settings.json · …` /
  `当前生效：进程 env · …` / `当前生效：未配置`。
- token 输入框占位符显示已保存的打码值；留空保存 = **保持原 token 不变**
  （对应 PUT 的字段级合并语义），只有「清除」按钮才删除 UI 配置。
- 测试连接结果就地显示成功 / 失败 + 错误信息。
- fetch 失败显示错误横幅，加载中显示进度（遵循 CLAUDE.md 状态可见性规则，
  不得静默空白）。

## 错误处理

- `GET`：存储/解析异常 → `saved: null` + `effective` 尽力而为，不 500。
- `PUT`：zod 校验失败 → 400 + 具体字段错误。
- `test`：网络失败 / 4xx / 超时（15s）→ `{ ok: false, error }`，error 为
  人类可读描述。
- daemon 任何情况下不因为设置端点异常而崩溃（与 distiller 的降级哲学一致）。

## 失败模式

| 模式 | 表现 | 缓解 |
|---|---|---|
| 用户在 UI 配了错误凭证 | 测试连接当场报错；distill 仍会失败但回显行显示「UI 配置」来源，一眼定位 | 测试按钮 + 回显 |
| 用户忘记 UI 配置的存在，后续改了 settings.json 却不生效 | 回显行显示来源为「UI 配置」 | 回显 |
| token 短于打码阈值 | 打码函数全码 | 打码边界测试 |
| 旧库无 app_settings 表 | 首次启动 migration 建表 | 幂等建表 + schema 测试 |

## 测试策略

纯函数层为主，UI/运行时层少量集成断言：

1. **凭证链顺序**（`creds.ts` 层）：UI 有 token → 短路且 source='ui'；
   UI 空 → settings.json 优先于进程 env（本事故回归防护，describe 命名点明）；
   全空 → credentials.json → null。每级至少一条。
2. **app_settings CRUD**：写入/读取/三空清除/幂等建表（含旧库无表迁移）。
3. **token 打码**：正常长度（前6后4）、短 token（全码）、空值。
4. **端点**：PUT→GET 回显无明文 token；`clear:true` 清除整级；token 留空
   PUT 保持已存 token 不变；zod 拒绝非法 baseURL；test 端点 mock LLM 调用
   成功 / 401 / 超时 三路径；GET 在存储异常时降级不 500。
5. **UI 层**：生效来源行渲染的源码文本断言（兜底回归防护，遵循
   CLAUDE.md 最低限度规则）。
6. 门槛：`bun run typecheck && bun test` 全绿才能 push。

## 耦合点

- `src/creds.ts` — `loadClaudeCreds` 链重排 + UI 级插入；新增 DB 读取依赖
  （注意保持纯函数可测性：DB 读取作为可注入依赖）。
- `src/db/schema.ts` + `src/db/client.ts` — 新表与幂等 migration。
- `src/anthropic.ts` — 无需改动（凭证本来就是每次调用现读）。
- `src/server.ts` — 三个新端点。
- `src/web/App.tsx` + `src/web/api.ts` — 设置区块与 client 函数。
- `src/daemon.ts` — 若 `loadClaudeCreds` 注入点需要携带 DB 句柄，在此接线。

## 遗留事项

- 本次事故的环境层修复（删除/更新 Windows 用户级过期 env 变量）与本功能
  正交，单独处理；本功能上线后该类残留只能被"回显"暴露，不能再静默劫持
  （UI 配置存在时），未配 UI 配置时靠回显可见。

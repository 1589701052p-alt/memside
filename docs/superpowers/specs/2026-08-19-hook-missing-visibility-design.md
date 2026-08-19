# hook_missing 提醒显眼化 spec

日期：2026-08-19
状态：待批准
关联：`docs/superpowers/specs/2026-08-19-hook-missing-notification-design.md`（前作，落地四槽全空 `hook_missing` 通知 + daemon 周期复探）。本 spec 在其基础上解决用户实测暴露的两个问题：① 检测间隔 5min 太久；② 提醒只进消息 tab、状态栏不显眼。

## 1. 背景

前作交付后用户实测：daemon 启动自动装 claude hook → 用户卸载 → 四槽全空 → **等了一直没收到提醒**（原因是运行中的 daemon 是旧代码进程，但即使新代码进程，5min 后消息才进表）。实测发现两个体验缺陷：

1. **5 分钟太久**：`HOOK_CHECK_INTERVAL_MS = 5 * 60 * 1000`（前作 §3.5）。探针本身是毫秒级（4 个 `existsSync`/`readFileSync` 读小 JSON），5min 间隔无性能依据——用户卸载 hook 后最长要等 5min 才被提醒，不够及时。
2. **状态栏不显眼**：前作把 `hook_missing` 进 `notifications` 表，但顶部状态栏只对 `llm_error`/`degradation` 渲染红/琥珀警示条（`App.tsx:662-702`），`hook_missing` 只被计入 `unreadNotifications` 总数（🔔 角标 +1），**没有专门警示条**。用户不点开消息 tab 根本注意不到——而 hook 未装会导致整个记忆捕获失效，属严重状态，应像 LLM 报错那样在状态栏有显眼提示。违背 CLAUDE.md 状态可见性。

### 1.1 用户需求

用户明确：
1. 检测间隔改成 **30 秒**（探针毫秒级，30s 无负担；卸载后 ≤30s 提醒，接近即时）。
2. 状态栏要 **顶部警示条 + 🔔 角标变色**两者都要（不只藏消息 tab 里）。

## 2. 目标 / 非目标

### 目标

1. **30s 检测间隔**：`HOOK_CHECK_INTERVAL_MS` 从 5min 改 30s。探针毫秒级，无性能负担。
2. **顶部警示条**：四槽全空（有未读 `hook_missing`）时，状态栏渲染一条琥珀警示横条（复刻现有降级条样式 `App.tsx:683-702`），文案显眼，**点击跳「设置」tab**（非 messages tab——用户需去设置页装 hook，不是看消息）。
3. **🔔 角标变色**：有未读 `hook_missing` 时，🔔 角标变琥珀色（复刻现有 `unreadDegradations` 分支 `App.tsx:627-631`）。
4. **零回归**：现有 llm_error/parse_error/degradation 警示条 + 角标行为逐字节不变；status 端点新字段是 optional（老前端兼容）；前作的折叠/复探/永不抛契约不动。

### 非目标

- **不改折叠/复探/永不抛逻辑**（前作已稳）——只改间隔常量 + UI 渲染 + status 字段。
- **不改 hook_missing 通知 title/body 文案**（前作 §3.5 已定，警示条文案是前端拼装的简短版，不复用 body）。
- **不碰 installClaudeHooks 启动自动装**（前作 §5 零回归延续）。
- **不做 settings tab 的轮询**（status 轮询是 list tab 3s 一次；settings tab 用户停留时 hook_missing 警示条仍可见，因警示条在所有 tab 外的顶部状态栏区域 `App.tsx:599-709`，刷新依赖 list tab 轮询或切 tab 时拉。30s daemon 写 + 3s 前端拉 ≈ 33s 内可见，可接受）。

## 3. 接口契约

### 3.1 检测间隔（`src/daemon.ts`）

`HOOK_CHECK_INTERVAL_MS`（`daemon.ts:160`）从 `5 * 60 * 1000` 改为 `30 * 1000`。其余（启动立即一次 + setInterval + unref + stop clearInterval + checkHooksAndNotify 永不抛）不动。折叠防刷屏（前作 §3.2 修复的 foldConds）保证 30s 复探仍全空时只刷新同一条 ts 不新插——30s 频率下折叠更重要，必须锁。

### 3.2 status 端点加字段（`src/server.ts`）

`GET /api/status`（`server.ts:497-577`）现有按 kind 未读聚合 `unreadByKind`（`server.ts:532-535`）。新增两个 optional 字段：

```json
{
  "unreadHookMissing": 1,
  "latestUnreadHookMissing": { "body": "...", "ts": 1234567890 }
}
```

- `unreadHookMissing`：`unreadByKind['hook_missing'] ?? 0`（复刻 `unreadDegradations:570` 模式）。
- `latestUnreadHookMissing`：照搬 `latestUnreadLlmError`（`server.ts:536-539`）但 `kind IN ('hook_missing')`，取最新一条未读的 `{body, ts}`，无则 `null`。
- 两个字段 optional（沿用现有字段 optional 风格，老前端不崩）。

### 3.3 前端 client 类型（`src/web/api.ts`）

`MemsideStatus` 接口（`api.ts:116-122`）加：
```ts
unreadHookMissing?: number
latestUnreadHookMissing?: { body: string | null; ts: number } | null
```

### 3.4 🔔 角标变色（`src/web/App.tsx`）

`App.tsx:627-631` 现有颜色逻辑（红 if llm_error > 0，elif 琥珀 if degradation > 0，else 默认）。**在 degradation 分支后加 hook_missing 分支**（hook_missing 同琥珀，warning 级）：

```ts
const bellColor =
  (status.unreadLlmErrors ?? 0) > 0 ? '#c00' :
  (status.unreadDegradations ?? 0) > 0 ? '#b26a00' :
  (status.unreadHookMissing ?? 0) > 0 ? '#b26a00' : '#666'
```

> 注：degradation 与 hook_missing 同琥珀色（都 warning 级，非 error 红）。优先级 llm_error（红）> degradation > hook_missing > 默认。实际二者颜色相同，分支顺序保证 degradation 先匹配（语义：降级比 hook 缺失更紧急），但视觉一致。

### 3.5 顶部 hook_missing 警示条（`src/web/App.tsx`）

在现有降级条（`App.tsx:683-702`）之后新增一条，复刻降级条样式（背景 `#ffb300` 白字，或用 pausedJobs 那种琥珀+边框 `#fff3e0`/`#b26a00`/`1px solid #ffb300`——后者更柔和，warning 级，**用后者**）：

```tsx
{(status.unreadHookMissing ?? 0) > 0 ? (
  <button
    onClick={() => setTab('settings')}
    style={{ display:'block', width:'100%', marginTop:4, padding:'6px 12px',
      background:'#fff3e0', color:'#b26a00', border:'1px solid #ffb300',
      borderRadius:4, cursor:'pointer', fontSize:13, textAlign:'left' }}
  >
    ⚠️ 运行环境未安装 hook——记忆捕获将不生效，去「设置」装一个 agent 的 hook
  </button>
) : null}
```

- 渲染条件：`status.unreadHookMissing > 0`。
- 点击：`setTab('settings')`（去设置页装 hook，不是 messages）。
- 文案简短版（不复用 body）：`⚠️ 运行环境未安装 hook——记忆捕获将不生效，去「设置」装一个 agent 的 hook`。
- 无关闭按钮（未读清零后自动消失，复刻现有警示条契约——任一槽装上后 daemon 复探 markNotificationsReadByKind 清零）。

## 4. 数据流

1. daemon 每 30s 复探 → 四槽全空 → 折叠刷新/新写 `hook_missing` 通知（前作链路不动）。
2. 前端 list tab 每 3s 拉 status → `unreadHookMissing > 0` → 顶部琥珀警示条出现 + 🔔 角标变琥珀。
3. 用户点警示条 → 跳「设置」tab → 装任一槽 hook。
4. daemon 下次 30s 复探 → `allMissing:false` → `markNotificationsReadByKind('hook_missing')` → 未读清零。
5. 前端下次拉 status → `unreadHookMissing === 0` → 警示条消失 + 角标恢复默认。
6. **时延**：卸载 → daemon 写（≤30s）→ 前端感知（≤3s）≈ ≤33s 警示条出现，可接受。

## 5. 与现有模块的耦合点

| 模块 | 改动 | 兼容性 |
|---|---|---|
| `src/daemon.ts` | `HOOK_CHECK_INTERVAL_MS` 5min→30s | 纯常量改，折叠锁防刷屏，零回归 |
| `src/server.ts` | status 加 `unreadHookMissing`+`latestUnreadHookMissing` | optional 字段，老前端兼容 |
| `src/web/api.ts` | `MemsideStatus` 加两 optional 字段 | 纯增量 |
| `src/web/App.tsx` | 🔔 角标加 hook_missing 琥珀分支；降级条后加 hook_missing 警示条（跳 settings） | 复刻现有模式，纯增量，既有警示条不动 |

## 6. 失败模式

1. **30s 频率 + 折叠**：前作 foldConds 修复（按 kind+title 折叠未读）保证 30s 复探仍全空只刷新 ts 不新插——防刷屏。测试锁（前作 §7.1 已锁，本 spec 不重测但确认绿）。
2. **status 字段老 daemon 不返回**：前端 `?? 0`/`?? null` 兜底，警示条/角标不渲染（optional 兼容）。
3. **settings tab 无轮询**：用户停在 settings tab 时警示条不自动刷新，但装完 hook 后切回 list tab 或重进会拉 status 更新——可接受（警示条在顶部所有 tab 可见，但数据刷新依赖轮询 tab）。非 bug。
4. **latestUnreadHookMissing 无未读**：`null`，警示条条件用 `unreadHookMissing` 计数（非 latest），不依赖 latest 字段渲染（latest 留作未来扩展/消息 tab 用，本 spec 警示条不消费 latest body——文案是前端固定简短版）。

## 7. 测试策略

### 7.1 server 层（`tests/server-notifications.test.ts` 或既有 status 测试扩展）

- `GET /api/status` 含 `unreadHookMissing`（有未读 hook_missing 时非 0）+ `latestUnreadHookMissing`（{body,ts}）。
- 无未读 hook_missing → `unreadHookMissing:0`、`latestUnreadHookMissing:null`。
- 既有 unreadLlmErrors/unreadDegradations 字段不变（回归锁）。

### 7.2 daemon 层

- `HOOK_CHECK_INTERVAL_MS === 30 * 1000`（源码断言/常量导出断言）。
- 既有 checkHooksAndNotify 行为 + 折叠 + 永不抛回归不动（前作已锁，确认绿即可）。

### 7.3 前端兜底（`tests/app-source-assertions.test.ts`）

- App.tsx 源含 `unreadHookMissing` token + `setTab('settings')`（警示条点击跳 settings）+ 琥珀色 `#b26a00`（角标）/`#fff3e0`（警示条）。
- api.ts `MemsideStatus` 含 `unreadHookMissing`+`latestUnreadHookMissing`。

## 8. 上线后观测（结论回填 STATE.md）

1. daemon 跑新代码 → 四槽全空 → ≤33s 顶部出现琥珀警示条 + 🔔 角标变琥珀。
2. 点警示条 → 跳设置 tab。
3. 装任一槽 → ≤33s 警示条消失 + 角标恢复。
4. 卸载 → ≤33s 警示条再现。
5. 30s 复探仍全空 → 消息 tab 只一条未读 hook_missing（折叠生效，不刷屏）。

## 9. deferred

1. settings tab 轮询（本 spec §2 非目标，YAGNI）。
2. latestUnreadHookMissing body 在警示条展示（本 spec 用固定文案，YAGNI）。

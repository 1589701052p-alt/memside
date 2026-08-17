# STATE.md - memside 构建状态

## 成品发布：npm 包 + Windows exe + NSIS 安装器 + GHA 发版（2026-08-17，Spec B）

把 memside 从"clone 仓库才能用"变成一键安装。设计 spec / 计划见
`docs/superpowers/specs|plans/2026-08-17-packaged-distribution*`（双 spec 分解的
**Spec B**；Spec A 见下一节）。三分发路径共享同一 `startDaemon`/`createApp`/`install*`
代码，新增两个旁路接缝不改既有磁盘路径行为。

1. **createApp 内存静态资产**（`src/server.ts`）：`AppDeps.staticAssets?`
   （`{indexHtml, assets: Record<string,Uint8Array>}`）旁路——exe 用内嵌 web dist
   内存托管，`GET /` 返回 indexHtml、`/assets/*` 从内存 map 返回（`mimeFor` 内联
   扩展名→MIME，不引依赖）。既有 `staticDir` 磁盘分支不变，staticAssets 优先（互斥）。
2. **startDaemon 透传**（`src/daemon.ts`）：`DaemonOpts.serveStaticAssets?` 透传到
   createApp，与 serveStaticDir 互斥。
3. **installOpencodePlugin 内容模式**（`src/install.ts`）：`files?`
   （`{memside.js, package.json}` 字符串）旁路——exe 从内嵌资产字符串写盘（跳过
   cpSync），端口烘焙照旧。既有 pluginSrcDir 磁盘分支不变，两者都缺抛错。
4. **exe 资产装配**（`src/exe/assets.ts` + `scripts/gen-manifest.ts`）：实测 Bun 1.3.14
   的 `bun build --compile` **不支持** directory import / `type:file` / `type:bytes`
   （仅 text/json），按 spec 失败模式 #2 回退到构建期 manifest——gen-manifest.ts 把
   dist（base64 二进制安全）+ opencode 插件（转义字符串）写进 `src/exe/manifest.ts`
   （普通 TS 模块，无 `with` 语法 → typecheck 干净无需 @ts-expect-error，bonus 可被
   bun test 直接 import 写真实字节级 round-trip 测试）。`loadEmbeddedAssets()` 返回
   统一对象 `{indexHtml, assets, pluginJs, pluginPkg}`（Ruling-A/B：launcher 从统一
   对象取插件资产，不重复 import）。assets key `assets/<file>` + vite base '/'（script
   引用根绝对路径），与 createApp 消费端一致。
5. **exe launcher**（`src/exe/launcher.ts`）：`bun build --compile` 编译入口。双击即
   生产启动：port-check（复用 `@/launch/portCheck`）→ startDaemon(installClaudeHooks:true,
   serveStaticAssets=内嵌) → installOpencodePlugin(files=内嵌) → 控制台常驻。用内嵌
   资产而非磁盘 dist，不做 dist 存在性检查。
6. **package.json**（`private:false` + `files` allowlist `["src","opencode-plugin","tsconfig.json"]`
   + `gen-manifest`/`build:exe`/`build:installer`/`prepublishOnly` 脚本）。`build:exe`
   严格顺序 `bun run build(vite) → gen-manifest → bun build --compile`（Task 4 硬指针：
   manifest 须在 compile 前生成）。npm 包带预构建 dist（prepublishOnly 保证新鲜），
   bin 仍指 src/cli.ts（npm 路径推荐 bunx memside）。
7. **NSIS 安装器**（`installer/installer.nsi`）：per-user（`RequestExecutionLevel user`，
   `%LOCALAPPDATA%\memside`，免 UAC）+ 开始菜单/桌面快捷方式 + PATH 追加（EnVar）。
   **不自启**（无开机注册）。uninstall 只删程序 + 快捷方式 + PATH 条目，**保留用户数据**
   （`~/.memside`/`~/.claude`/`~/.config/opencode`）。
8. **GitHub Actions 发版**（`.github/workflows/release.yml`）：`v*` tag 触发。windows
   job：build → build:exe → choco install nsis → build:installer → softprops
   action-gh-release 上传 memside.exe + memside-setup.exe。ubuntu job（needs:windows）：
   npm publish（prepublishOnly 保 dist 新鲜，NPM_TOKEN）。

执行：subagent-driven（9 task，implementer haiku/sonnet + reviewer haiku/sonnet；Task 6
implementer 时预算超时 controller 代提交验证完成的改动，Task 7/8 reviewer 提前结束由
controller 直接核验约束裁决）。`bun run typecheck && bun test` 1077/1077 全绿（2999
expects，95 文件；基线 1060 → +17 测试）。无新运行时依赖（Bun 资产导入/readdir node
内建；NSIS 构建期工具 CI 装；GHA 外部 CI）。

### 上线后观测（硬要求，结论回填本节）

1. **CI 首跑**（`v0.1.0` tag，2026-08-17）：**端到端跑通**，暴露并修复两个真实问题：
   - ✅ `bun build --compile`：CI windows job 产 `memside.exe`（99MB）成功。
   - ✅ EnVar 插件获取：fix wave（PR #70 前置）加的 `Install EnVar NSIS plugin` step 生效，DLL 落位正确。
   - ⚠️→✅ **makensis 不在 PATH**：choco 装的 nsis 把 `makensis.exe` 放在
     `C:\Program Files (x86)\NSIS\` 但**不写 PATH**，`bun run build:installer` 报
     `command not found: makensis`。修法（PR #72）：EnVar step 末尾
     `Add-Content $env:GITHUB_PATH $nsisDir` + 断言 `makensis.exe` 存在；测试锁回归。
   - ⚠️→✅ **npm publish 2FA 拦截**：账号开 2FA 时 Granular token 发布报
     `E403 ... Two-factor authentication or granular access token with bypass 2fa
     enabled is required`。修法（用户侧）：账号 2FA 设为 "Auth only"（仅登录要 2FA，
     发布不要），重跑后过。`@memside-h/memside@0.1.0` 已发布（npm 包名 `memside` 被
     外部占用，改 scoped `@memside-h/memside`，PR #70；bin 命令仍 `memside`）。
   - ✅ Release 资产上传：`memside.exe` + `memside-setup.exe` 双资产挂 v0.1.0 Release。
2. 未签名 exe SmartScreen 拦截率 + 用户反馈——决定 v1.1 是否上代码签名。
3. npm 包下载量 + `bunx @memside-h/memside` vs `npm i -g @memside-h/memside` 占比——决定是否优化 PATH shim。
4. NSIS 安装器安装/卸载成功率 + 卸载后用户数据保留验证（抽样）。
5. exe 体积（Bun runtime ~99MB + JS + dist，用户友好优先于体积，观测是否需瘦身）。

### deferred minor（非阻塞，建议 follow-up）

1. ~~EnVar 插件 CI 验证~~ → **已闭环**（CI 首跑验证，见上线后观测 1）。
2. ~~`build:exe` 未本地实跑验证~~ → **已闭环**（CI 首跑验证，exe 产出正常）。
3. workflow_dispatch 无 tag_name 兜底（手动调试受影响，tag 主路径无影响）。
4. npm 版本号 `0.1.0` 与 `v*` tag 无自动联动（无 npm version 同步步骤）。
5. Task 1 F1：缺 staticAssets+staticDir 同时传优先级显式测试（if/else if 结构保证）。
6. Task 4 F1：gen-manifest 对 `assets/` 子目录非递归（当前 vite dist 扁平，未来子目录时改 recursive:true）。
7. Task 6 F1/F2：build:exe 仅 toDefined 未锁 gen-manifest 顺序；manifest.ts stale payload 随 npm 包发布（无害，可 .npmignore）。
8. Task 8：测试未锁步骤顺序（build:installer 在 nsis 之后）+ 上传 files 路径。
9. macOS/Linux exe（npm 包覆盖；bun build --compile cross-compile 留后续）。
10. 托盘图标 / 自动更新检查 / portable 模式（v1.1+）。

## 记忆批量删除（回收站）+ 导出/导入 + 多选批量操作（2026-08-16，Spec A）

商用前记忆管理层补齐四块能力。设计 spec / 计划见
`docs/superpowers/specs|plans/2026-08-16-memory-portability-and-batch-ops*`
（双 spec 分解的 **Spec A**；**Spec B（npm 包 + exe + 安装器一键发布）** 待后续独立头脑风暴）。

1. **回收站机制**（`src/db/schema.ts` + `client.ts`）：新增 `memory_trash` 表
   （沿用 `memory_discards` 审计表模式，幂等迁移）。删除 = 单事务内 `DELETE memories`
   + `INSERT memory_trash` 快照（删 memory 真删，快照留 trash）；恢复 = 反序列化
   snapshot → `importMemories(skip)` 写回（保留 status 高保真）→ 删 trash 行（仅当
   实际写入时删，skip 冲突保留快照可重试）；清空 = `DELETE FROM memory_trash` 全表
   物理删（不可恢复）。
2. **trash 快照纯函数**（`src/memory/trash.ts`）：`snapshotMemory`/`restoreFromSnapshot`
   全字段往返，schema 演进容错（缺字段回 null，永不抛）。
3. **exchange 纯函数**（`src/memory/exchange.ts`）：memside JSON 高保真
   （`{format,version,exportedAt,memories}` envelope + 逐条 zod 式校验，非法跳过计
   errors）+ Markdown 低保真（`## [category:xxx]` 小节 + 元信息列表，`---` 分隔，
   bodyMd 含 `---` 不误切）+ `detectExchangeFormat` 自动识别（JSON.parse 成功且
   format 匹配 → json，否则 markdown 兜底）。
4. **store 层**（`src/memory/store.ts`）：`bulkDeleteMemories`（逐条事务删+写 trash，
   吞错计 skipped，幂等）/`restoreFromTrash`（默认 skip 冲突）/`emptyTrash`/
   `importMemories`（高保真 seam：绕过 createCandidate 的 status:'candidate' 硬编码，
   三冲突策略 skip/overwrite/newid，load-bearing writeId 逻辑
   `conflict==='newid'?ulid():rec.id`）/`listMemoriesForExport`（三档 scope，无分页）/
   `listTrashPage`/`listTrashFacets`/`getTrash`/`TrashRow`。
5. **server 7 路由**（`src/server.ts`）：`POST /api/memories/bulk-delete`、
   `GET/POST /api/trash`（列表分页+筛选 / 详情 / 恢复 / 清空）、
   `POST /api/memories/export`（scope selected|filter|all × format json|markdown，
   markdown 走 Content-Disposition 下载）、`POST /api/memories/import`（multipart
   `parseBody`，格式自动识别，JSON→importMemories/MD→createCandidate 循环，条数 cap
   10000）。`/api/status` 加 `trashCount`。导入路由合并 parseMemoriesJson 的 parse
   errors 进响应 errors。
6. **Web UI**（`src/web/App.tsx` + `api.ts` + `tab-cache.ts`）：新增「回收站」tab
   （第 8 个，计数徽标 + TrashCard + 恢复/清空 + 空态，暂不接筛选条 follow-up）；
   记忆三 tab 多选（per-tab `selectedIds` + MemoryCard checkbox + 批量操作条
   `MemoryBatchBar`：批量批准/拒绝/归档/取消归档/恢复/删除）；导出入口
   （ExportTrigger：选中/当前筛选/全部 × JSON/MD，`scope:'filter'` 透传 filter+statuses
   `project→sourceCwd` 映射，浏览器 Blob 下载）；导入入口（ImportTrigger：文件上传 +
   三冲突策略选择）。`bulkDelete`/`emptyTrash` api wrapper 检 res.ok 失败抛错，
   UI 层 try/catch + setError 横幅（CLAUDE.md 错误可见性）。

执行：subagent-driven（10 实现 task + 1 fix wave 各 implementer + reviewer；终审 opus
whole-branch review verdict=FIX BEFORE MERGE → 1 Important + 5 Minor 一轮 fix wave 全
修后 scoped re-review 全绿 ADDRESSED）。`bun run typecheck && bun test` 1060/1060
全绿（2914 expects，91 文件；基线 980 → +80 测试）。无新依赖（multipart 用 Hono
parseBody；Blob 下载用浏览器原生；ULID 复用现有）。

### 上线后观测（硬要求，结论回填本节）

1. 回收站使用频率（删除/恢复/清空计数）——验证回收站是否缓解"删不掉"痛点；
2. 导出格式偏好（JSON vs Markdown 比例）+ 导出 scope 分布（选中/筛选/全部）；
3. 导入冲突策略选择分布（skip/overwrite/newid）+ 导入 errors 占比（衡量导入文件质量）；
4. 批量操作是否被采用（vs 逐条 approve/reject）——批量删除是否进回收站而非误以为是硬删；
5. 大表导出内存峰值（live DB 3000+ 条，YAGNI 未做流式，观测是否需升级）。

### 终审 deferred minor（非阻塞，建议 follow-up issue）

1. `emptyTrash` COUNT+DELETE 非事务（emptied 计数竞态下可能不准；emptied 未在 UI 展示，低危）。
2. `changeFilter` trash 分支 `(tab as TabKey) === 'trash'` cast 无 inline NOTE（dead code
   因 trash 不在 isFilterTab；接 trash 筛选条时可去 cast）。
3. `listTrashFacets` 已导出但未接线（trash tab 无筛选 UI；未来接 trash 筛选时复用）。
4. `rowToTrash`/`listTrashPage` conds 的 `any` cast（pre-existing store.ts 模式，非本次引入）。
5. 回收站 tab 暂不接四维筛选条（discards 同模式两维）；`listTrashPage`/`listTrashFacets`
   已就绪待 UI。
6. 批量 approve/reject/archive/unarchive/restore 逐条 N 次 round-trip（仅 bulkDelete 用
   批量端点）；大选中慢，v1 接受，后续可加批量端点。

## 蒸馏解析失败可视化 + subagent 兜底治理（2026-08-15）

设计 spec / 计划见 `docs/superpowers/specs|plans/2026-08-15-distill-parse-error-visibility*`。
parse_error 独立 outcome（raw_text 落盘 + 消息中心折叠 + 状态栏红条覆盖）；
SubagentStop 删除主会话兜底，缺失改写 subagent_transcript_missing 取证 degradation。
全量门槛：`bun run typecheck && bun test` → 1001 pass / 0 fail / 84 文件。

### 上线后观测（硬要求，结论回填本节）

1. parse_error 24h 计数与占比；raw_text 抽样判型（截断断口 / 围栏 / 散文），给后续 retry prompt 调优定罪。
2. `subagent_transcript_missing` 降解的 dir listing 对照 agentId——抓 phantom agent 文件缺失现行。
3. empty_output 是否回归纯真空（抽样应全部 raw_output_json 非 NULL）。
4. parse_error 通知折叠效果：同签名是否收成一条。

### 本轮遗留（minor，不阻塞合并）

- retry.ts / distiller 缺「先 parse 败后末次抛错」混合序列优先级测试（T1/T2 deferred）。
- capRawText 恰等于 24000 边界 case 未测；测试 import RAW_TEXT_CAP_CHARS 未用。
- listDistillRunsPage 的 rawText 排除无独立断言（与 listRecentDistillRuns 共用 RUN_LIST_COLS）。
- SubagentStop catch 块（broadcast memory.enqueue.failed）未测；吞 logDegradation 失败时事件 type 语义略偏（enqueue 没失败），属事件协议 follow-up。
- notificationTitle parse_error 分支返回固定文案（与 llm_error 既有模式一致，丢细粒度信息）。
- separator 启发式在 subagentFilePathFromPayload 与 resolveSubagentTranscript 重复（plan-mandated 逐字）。

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

## 记忆审计视图（2026-07-29）

补齐 Web UI「审批后/拒绝后」可视面：4-tab（候选审批 / 已审批 / 已拒绝 /
AI自动拒绝），给三类记忆各加最小操作能力。设计 spec / 计划见
`docs/superpowers/specs|plans/2026-07-29-memory-audit-views*`。

1. 状态机加 `rejected -> candidate`（`pure.ts` TRANSITIONS），superseded 保持终态。
2. `memory_discards` 加 6 nullable 列（scope_type/scope_id/source_cwd/runtime/
   source_kind/promoted_memory_id），ALTER TABLE 幂等迁移（不表重建）；logDiscards
   + scheduler tick 接线写入来源（scopeType/scopeId/sourceCwd/runtime/sourceKind）。
3. store 新增 `restoreMemory`（rejected->candidate，清 approvedAt，specific-source
   guard）、`promoteDiscard`（discard->candidate + 回填 promoted_memory_id；幂等守卫
   + 老行 scope 缺失守卫；不删审计行）、`listDiscards`（ORDER BY ts DESC LIMIT 200）+
   `DiscardRow` 类型。
4. server：`GET /api/memories?status=…` 服务端 status 过滤（inArray；不带 status 全量
   向后兼容；非法值宽松忽略不 400）；`GET /api/discards`；`/api/status` 加 discards
   计数；4 写路由 `POST /api/memories/:id/{archive,unarchive,restore}` +
   `POST /api/discards/:id/promote`（MemoryNotFoundError->404，冲突->409，success
   broadcast WS）。
5. Web UI 4-tab + 计数徽标（candidate / approved+archived+superseded / rejected /
   status.discards）+ `DiscardCard`（reason 徽标 + 来源 + 时间；已提升显「已提升」）+
   切 tab 切轮询（useEffect `[tab]` + clearInterval，tabRef 防 stale-fetch 竞态）；
   MemoryCard 抽通用骨架按 tab 注入操作（候选 4 回调不变 / 已审批 archive↔unarchive +
   superseded 只读 / 已拒绝 restore）；no-throw 契约（操作后 void refresh）。

执行：subagent-driven（8 实现 task 各 implementer + reviewer；终审 pending）。
`bun run typecheck && bun test` 440/440 全绿。

### 已知 follow-up（本轮 deferred minor，非阻塞）

1. `store.ts:447` `(d.runtime ?? null) as RuntimeTag` 类型安全谎言（MemoryInput.runtime
   非空但表达式可 yield null；runtime 安全因列 nullable）。Brief-verbatim。
2. `promoteDiscard` 三步（读/createCandidate/回填）非单事务；同 id 并发双提升会产生
   一个 orphan candidate 行（discard 幂等仍成立）。Brief 接受的低频手动操作权衡。
3. `server.ts:225` 内联 `MemoryStatus` 类型重复 `pure.ts:151` 导出，可漂移；应改为
   `import type { MemoryStatus } from '@/memory/pure'`。VALID Set 仍需留本地。
4. web api 4 个新 POST wrapper（restore/archive/unarchive/promote）不检查 res.ok/throw，
   404/409 时返回 undefined（与 promoteMemory 同模式，异于 patchMemory）。UI 已按
   no-throw 契约处理；未来可统一所有 mutating wrapper 的错误处理。
5. status-filter / discards 测试未 seed 非匹配行（部分断言 vacuously true）；
   archive/unarchive broadcast 分支未断言（与已测的 restore/promote 同模式）；
   scope-missing 守卫第二臂（project && scopeId===null）未单测。CLAUDE.md 错误路径
   覆盖可后续补齐。
6. App.tsx 切 tab 有一帧 stale-data 闪烁（useEffect reset 在 paint 后），自纠正非
   stall；`tabRef.current=tab` 在 render 期赋值（latest-value ref，功能安全但违 React
   书面规则，可移到 depless effect）；h1 仍「审批队列」（chrome 稳定优先，cosmetic）。

## 蒸馏工作记录透明化（2026-07-29）

诊断「近一天无新增记忆」时发现 distill 管线是黑盒：只能反推 session offset 表
确认 LLM 被调，看不到模型到底返回了什么、为什么 0 候选。本需求把每次 distill job
的工作过程落盘透明化。设计 spec / 计划见 `docs/superpowers/specs|plans/
2026-07-29-distill-work-record*`。

1. `memory_distill_runs` 新表（1:1 随 job，无 FK 与 inputs 表一致解耦清理）：outcome
   四态（skipped_no_new_turns / empty_output / llm_error / produced）+ LLM 原始产出
   `raw_output_json`（含被格式校验丢弃的候选）+ 四道闸计数（distilled/accepted/
   deduped/filtered/stored/discarded）+ duration。幂等 `CREATE TABLE IF NOT EXISTS`。
2. `distillTranscript` 返回值透出 `rawOutput`/`rawCount`/`callThrew`（callThrew 区分
   LLM 报错 vs 返回空）；`wrappedCall` 每次 attempt 重置 `callThrew`（防 sticky 跨
   retry 误判），catch 降级 callThrew=true。
3. `scheduler.tick` 接线：outcome 判定（`candidates.length===0 ? (callThrew ?
   llm_error : empty_output) : produced`，candidates 优先匹配 spec §4 produced 定义）
   + 计数采集 + 两处 best-effort `saveDistillRun`（skipped 分支 + 主路径，与
   `logDiscards`/`setSessionOffset` 同级）+ `saveSourceInput` 去门（0 产出 job 也存
   过滤版输入）。
4. store：`saveDistillRun`（UPSERT）/`getDistillRun`（反序列化失败 rawOutput=null 不崩）
   /`listRecentDistillRuns`（两段查询避免 join 键名不确定，列表不含 rawOutput）。
5. server：`GET /api/distill-runs`（列表无 rawOutput）/`GET /api/distill-runs/:jobId`
   （详情含 rawOutput）/`GET /api/distill-runs/:jobId/source-input`（复用 getSourceInput）
   + `/api/status` 加 `distillRuns: {total, byOutcome}`（最近 24h）。
6. Web UI 第 5 tab「蒸馏记录」：列表行 outcome 徽标 + 计数链 `N->M->K->J`
   （`formatRunCounts`/`formatOutcome` 纯函数）+ 点开 `DistillRunModal`（产出区展示
   rawOutput 候选 + rawCount>acceptedCount 时提示「N 条格式不合格被丢弃」+ 输入区
   懒加载 + 三态 + sourceError/sourceLoaded 空反馈）。

执行：subagent-driven（8 实现 task 各 implementer + reviewer；终审 opus whole-branch
review verdict=With fixes，一轮 fix wave 修 3 Important + 1 Minor must-fix 后 scoped
re-review 全绿）。`bun run typecheck && bun test` 470/470 全绿。

### 已知 follow-up（本轮 deferred，非阻塞）

1. spec §4 `discarded_count` 文案「= accepted - filtered」不精确（实为 `= deduped -
   filtered`，当 dedup 有丢弃时 accepted-filtered 会多算）；实现用 `discarded.length`
   正确，spec 文案待 docs follow-up 修正。
2. `/api/status` distillRuns 全量加载后 JS 过滤 24h（与 events/memories/discards 同
   模式）；长寿命 daemon 行数增长后改 SQL `WHERE ts > ?` follow-up。
3. `DistillOutcome` 类型在 store/api/ui-utils 三处重复定义（与既有跨层类型重复同模式）；
   `formatOutcome` if-else fallthrough 未做 `switch + never` 穷尽检查。
4. Task 4 计数链测试用全等值（未覆盖 accepted>deduped>filtered 的发散链）；skipped
   分支 saveDistillRun-throw 无独立测试（与已测主路径同模式）。
5. events 表存完整 transcript 的膨胀债务（STATE.md 已知债务#1）仍独立未碰；runs 表
   每行结构化记录体积有界，去门后 inputs 多写 0 产出 job 的过滤版输入（已压缩截断）。

## 蒸馏 LLM 错误捕获与透传（2026-07-29）

distill-work-record 透明化上线后，第 5 tab 显示近期 distill job 全是 llm_error，但点开
详情是空的--看不到「报了什么错」。诊断发现错误 message 被 callWithRetry（catch 后只拼
进重试 prompt 不透出）-> distiller（顶层 catch 丢弃）-> scheduler（distiller 不抛 so
不进外层 catch，job.last_error 不写）链路层层吞掉，加上 callThrew 时 filteredTurns 被清空
（source input 也丢），llm_error 在最该透明的场景变成黑盒。本需求补错误捕获透传 + 两个
伴生缺口。设计 spec / 计划见 `docs/superpowers/specs|plans/2026-07-29-distill-error-capture*`。

1. `memory_distill_runs` 加 `error_message TEXT`（nullable）+ 幂等 ALTER 迁移。llm_error
   时存错误描述（含 HTTP status 若有），其余 outcome null。
2. `distillTranscript`（方案 2，只动 distiller 不改 callWithRetry）：`wrappedCall` catch
   记 `lastErrorMessage`（每次 attempt 更新，最后一次留存）；`DistillResult` 加
   `errorMessage: string | null`；三路径取值--!parsed(callThrew?lastErrorMessage:null) /
   成功(null，retry-success 显式返回 null 防 attempt 0 残留) / 顶层 catch(e message)。
3. **filteredTurns 修复**：`callThrew ? [] : filtered` -> `filtered`（callThrew 时不再
   清空 source input 快照，llm_error job 也能看到喂给模型的 transcript）。
4. store：`DistillRunRecord`/`Row`/`ListRow` + `saveDistillRun`/`getDistillRun`/
   `listRecentDistillRuns` 适配 errorMessage。
5. scheduler：解构 errorMessage + 主路径 saveDistillRun 传 + **llm_error 时回写
   `memory_distill_jobs.last_error`**（best-effort），修 `/api/status` 的 lastError（原查
   j.lastError 非空但 llm_error job 的 last_error 为 null，顶部状态栏看不到 LLM 错误）。
6. server 端点无代码改动（store 加字段后自动带出）；web-api 类型加 errorMessage；Web UI
   `DistillRunModal` llm_error 分支展示 errorMessage（pre 红色块 + 无值兜底「无错误描述」
   不空白）+ `DistillRunRow` 列表行截断错误（ellipsis）。

执行：subagent-driven（6 实现 task 各 implementer + reviewer；终审 opus whole-branch
review verdict=Clean，1 条 Minor 注释 finding 一轮 fix wave 修后 scoped re-review 全绿）。
`bun run typecheck && bun test` 486/486 全绿。

### 已知 follow-up（本轮 deferred minor，非阻塞）

1. `store-crud.test.ts:266` 测试名「all columns」但 arrayContaining 未含 error_message
   （列存在性已由 schema.test.ts 覆盖，仅测试名过承诺）。
2. scheduler done update 从不清 job.lastError（既有行为）--job 失败重试成功后 lastError
   残留；非本需求引入，独立 follow-up。
3. `DistillRunRow` 截断错误行 marginTop:2 vs 来源行 marginTop:6 轻微不一致（有意设计）；
   web-ui 测试只断言 textOverflow 未断言 whiteSpace/overflow（源码层文本断言粒度）。
4. server.test.ts/web-api.test.ts 新测试风格与邻近测试略不一致（app.request vs req()
   helper / hand-roll fake vs new Response），no action needed。

诊断附注：根因是 Ark 端点间歇性不稳（成功 8-23s，失败每次 attempt ~6.4s × 3 耗尽重试），
非配置错误（用 settings.json 凭证实调简单调用 + distiller 真实 prompt 均成功）。本需求
不解决 Ark 稳定性（外部服务），只让间歇失败时错误可见、可诊断。

## LLM 凭证 UI 配置（2026-07-30）

实现 LLM 凭证的 Web UI 配置与优先级修复（分支 `feat/llm-settings-ui`）。设计 spec / 计划见
`docs/superpowers/specs|plans/2026-07-30-llm-settings-ui*`（8 个 task）。

- **事故根因**：Windows 用户级持久 env 残留过期中转站配置，旧优先级「进程 env > settings.json」
  导致其静默劫持有效凭证，全部 distill 401。
- **修复方式**：UI 配置最高优先 + settings.json 先于 env + UI 常驻「当前生效」回显行，
  让被 env 劫持的过期配置可被用户直接看见。

执行：`bun run typecheck && bun test` 518/518 全绿。

## 出处驱动的价值判定（origin-driven value judgment，2026-07-30）

把价值判定锚点从「domain vs codebase」换成「用户陈述 vs 可重新推导」。设计 spec / 计划见
`docs/superpowers/specs|plans/2026-07-30-origin-driven-value-judgment*`（8 个 task）。

- **事故根因**：旧 judge 的 derivable 规则「描述本仓库的、哪怕带 rationale 也算 derivable -> 丢」
  把用户亲口确认的决策（凭证链优先级、UI 回显硬性要求等）和源码琐事一刀切。7-30 新代码上线后
  实测：8 条候选全数被判 derivable 丢弃、0 条入库。
- **新判定规则全集（spec §R0-R4）**：
  - R0 驯化守卫（纯代码，不变）。
  - R1 出处门：distiller 每条候选带 `origin`（user-stated/user-confirmed/agent-observed）
    + `evidence`（原话摘句）；贴金防护--标了 stated/confirmed 却摘不出原话 -> 降级 agent-observed。
  - R2 九分类 judge（6 留 3 丢）：6 价值筐（user-rule/decision/preference/convention/trap/
    topology，扩编补「用户立的规矩」「偏好」「事故教训」缺口）+ 3 丢弃理由各配考题
    （Q1 公开知识 / Q2 仓库重推 / Q3 时效 fleeting）。**Q2 仅对 agent-observed 合法**：
    prompt 禁考 + 代码硬兜底（stated/confirmed 被判 derivable -> 改判 keep+decision）双保险。
    Q3 是 AI 对用户话语的判断权（随口琐事可丢，但理由只能是 fleeting）。
  - R3 LLM 失败全保留（stated->decision / observed->null）。
  - R4 dedup / 审计表 / 提升按钮不动。
- **诚实声明**：开发仓库自身源码实现细节不记（翻代码就能知道，不算记忆）；但蒸馏器看不到
  仓库源码，Q2 只能启发式推断。Q2 的安全性靠 origin 门禁 + 代码兜底，不靠模型聪明。
- **数据模型**：memories 加 `origin`/`evidence` 两列（幂等 ALTER，刻意放在 subagent 表重建块
  之后覆盖所有升级路径）；value_class 6 枚举 / memory_discards.reason 加 fleeting 均免迁移
  （自由文本列）。
- **Web UI**：审批卡片 origin 徽标（用户陈述/用户采纳/agent 观察）+ evidence 出处行
  （「出处：原话」紫色）+ 6 筐徽标；DiscardCard fleeting 中文文案。

执行：subagent-driven（8 task 各 implementer + reviewer；终审 pending）。
`bun run typecheck && bun test` 522/522 全绿。

### 已知 follow-up（本轮 deferred，非阻塞）

1. **valueFilter 幻觉类别兜底不全**（Task 2 minor）：per-verdict hallucinated-category
   路径（valueFilter.ts:171-174）对 stated/confirmed 也只给 keep+null，未给 decision ->
   这类候选落到 valueClass:null，不免疫「批量拒绝未评估」。非安全缺口（stated 不会被丢弃，
   只是没打 decision 标），与 keepNull/return 段的 stated->decision 不一致。后续可统一。
2. **grep 预检（第二期）**：scheduler 本机可读 job.cwd 仓库，可从候选抽符号 token grep
   把「仓库实锤」证据附给判定器，让 Q2 从启发式升级为带证判定。纯增量（判定规则不用改），
   本次不做--一次改太多变量不好归因。
3. **存量 573 候选不重判**（非目标）：可用现有「批量拒绝未评估」+ 手动审批自行清理。
4. **evidence 暂仅审批卡片可见**：注入块（formatMemoryBlock）未呈现 evidence，留第二期。
5. Task 1 遗留：scheduler.test.ts 若干 mock JSON 残留 dead `ruleObject` 字段（harmless，
   distiller 忽略）；valueFilter.ts:106 bridge 注释已随 Task 2 重写移除。
6. Task 6：Web UI 徽标/evidence 行未做浏览器视觉手测（无浏览器面），建议交互环境过一遍
   审批 tab（老行无 origin/evidence 时不显徽标为预期）。

## opencode 支持完整闭环（2026-07-31）

opencode 支持完整闭环 landed（分支 `feat/opencode-support`）。设计 spec / 计划见
`docs/superpowers/specs|plans/2026-07-31-opencode-support*`。

- **Task 1**：`parseOpencodeMessages`（`src/opencode/transcript.ts`）— opencode 全量 messages JSON
  转换为 `TranscriptTurn[]`，适配 claude/openai 角色映射（user/assistant → user/assistant，
  tool 结果转为 tool role + tool_call_id）。
- **Task 2**：`listApprovedByScope` 跨 runtime 共享（`src/memory/store.ts`）— `getApproved` 改为
  按 `scopeType + scopeId` 查询，不再过滤 `runtime`，让 claude code 和 opencode 共用 project 记忆。
- **Task 3**：`OpencodeAdapter`（`src/adapter/opencode.ts`）— 实现 `RuntimeAdapter` 接口，
  `inject` 方法走 `listApprovedByScope` 获取 approved 记忆，包 `## Learned context` 块返回。
- **Task 4**：daemon 双 adapter 接线（`src/daemon.ts`）— daemon 同时实例化 `ClaudeCodeAdapter` 和
  `OpencodeAdapter`，分别注入 `AppDeps.adapter` / `AppDeps.opencodeAdapter`。
- **Task 5**：daemon 两路由（`src/server.ts`）— `POST /hooks/opencode/capture`（idle hook 全量
  messages 接收，fire-and-forget IIFE enqueueDistillJob + events 行，202 ack）+ `GET
  /hooks/opencode/inject`（opencodeAdapter.inject，query 传 cwd）。
- **Task 6**：opencode 两 plugin 钩子（`src/opencode/plugin.ts`）— `idle` hook（会话空闲 POST
  /hooks/opencode/capture 含全量 messages）+ `messages.transform` hook（新会话 GET
  /hooks/opencode/inject 注入记忆块）。
- **Task 7**：`installOpencodePlugin`（`src/install.ts`）— 本地 plugin 文件安装到
  `~/.config/opencode/plugins/` + 更新 `opencode.json` 注册；`start-and-install` 自动调用。
- **Task 8**：Web UI sourceLabel + README/STATE 收尾 — App.tsx `sourceLabel` 加 `runtime==='opencode'`
  分支；README 去 opencode 限制 + 加 opencode 用法；STATE.md 本段。

执行：subagent-driven（8 实现 task 各 implementer + reviewer；终审 pending）。
`bun run typecheck && bun test` 546/546 全绿。

### 验证缺口（post-merge 手动 live smoke，spec §测试策略 live-only）

opencode 1.15.5 真实环境手动验证（非本机，需 opencode 可执行环境）：

1. **local-path plugin 加载**：`~/.config/opencode/plugins/memside.js` 是否被 opencode
   正确加载并注册 idle / messages.transform 钩子。
2. **session.idle payload 形状**：opencode idle hook 实际发出的 POST body 字段
   （sessionId/cwd/messages）是否与 `plugin.ts` 假设一致（依赖 opencode 文档，未在
   1.15.5 上实测）。
3. **`client.session.messages` return 形状**：`messages.transform` hook 的 GET /hooks/opencode/inject
   返回的 `{block}` 形状是否被 opencode 正确解析为注入上下文（`additionalContext` envelope
   格式差异风险）。
4. **Bun fetch vs 代理**：plugin 中 `fetch`（Bun 运行时）在用户有系统代理时的行为
   （`NO_PROXY` 等效绕过 loopback 需求）。
5. **messages.transform 幂等性**：多次 GET /hooks/opencode/inject（如重试）是否重复注入
   （server 侧无状态 GET，幂等由 opencode 保证，需验证）。
6. **opencode.json ~ 扩展**：`installOpencodePlugin` 写入 `~/.config/opencode/opencode.json`
   时 `~` 是否被 shell 展开（Bun 的 `homedir()` vs shell tilde 差异）。

以上 6 项验证缺口不阻塞合并，但需在 opencode 环境中手动验证后标记为已解决。

### Live smoke 结果（2026-07-31，真实 opencode 1.15.5 + Bun 1.3.14 + 系统代理 :7897）

本机真实 opencode 环境全闭环验证通过，6 项缺口全部闭合：

1. **plugin 加载** ✅ — `opencode run` 与 `opencode serve` 两种模式均加载 memside plugin，
   idle + messages.transform 两钩子注册生效。
2. **session.idle payload** ✅ — `event.properties.sessionID`（字符串 `ses_...`）确认；
   插件据此拉全量 messages。
3. **client.session.messages 形状** ✅（**修复**）— SDK 期望 `client.session.messages({ path: { id: sessionID } })`，
   非 `{ sessionID }`（后者把字面量对象拼进 URL 报 "Expected a string starting with ses"）；
   返回 `res.data` 为 `{info:{role}, parts:[]}` 数组。
4. **Bun fetch vs 代理** ✅（**修复**）— Bun fetch 原生尊重 `HTTP_PROXY`/`HTTPS_PROXY` 且不豁免
   loopback，系统代理 :7897 会把 `127.0.0.1:7777` 请求转发出去 -> 502，capture+inject 双双静默失效。
   修复：plugin 启动时 `process.env.NO_PROXY` 追加 `127.0.0.1,localhost`（追加非覆盖，保留出站代理）。
5. **messages.transform 幂等** ✅ — `INJECT_MARK` 守卫 + 首条 user message 注入；多次触发不重复。
6. **opencode.json 路径** ✅ — install 用 `homedir()` 解析，写入正斜杠路径
   `C:/Users/admin/.config/opencode/memside-opencode`，opencode 正确加载（无 shell tilde 问题）。

**全闭环 end-to-end**（capture -> distill -> approve -> inject）：
- **capture**：真实 `opencode run` 会话 -> session.idle -> plugin fetch messages -> POST `/hooks/opencode/capture`
  （NO_PROXY 生效）-> daemon 存 1221-byte 真实 transcript -> enqueue（runtime=opencode）。
- **distill**：distiller 调 LLM 11.2s -> outcome=`produced` -> 1 候选入库。
  （另：琐碎 2-turn 问答正确产出 `empty_output`，非 bug。）
- **approve**：`POST /api/memories/:id/promote` -> status=approved。
- **inject**：`GET /hooks/opencode/inject?cwd=...` 返回 1690-byte 块，含刚批准的 opencode-runtime
  记忆 `[bun-proxy-bypass]` + 5 条 claude-code 记忆（**跨 runtime 共享**实证）。
  真实 `opencode run` LLM 确认上下文开头见 `BEGIN INJECTED MEMORY` 块，首条即 opencode-runtime 记忆。

**随验证落地的代码改动**（本分支 commit）：
- `opencode-plugin/memside.js`：NO_PROXY loopback 旁路 + `path:{id}` SDK 签名 + `Array.isArray(res.data)` 归一化。
- `tests/plugin-opencode.test.ts`：3 条源码层文本断言守卫（CLAUDE.md 运行时组件兜底面），回退任一修复即红。
- `bun run typecheck && bun test` 550/550 全绿。

## subagent 蒸馏 origin 强制降级（2026-07-31）

修复 subagent 蒸馏任务候选 origin 错标：subagent transcript 的 role:user 是
主 agent 派发的 task brief（非真人陈述），distiller 不知来源导致 47/52 条候选
被错标 user-stated/confirmed，被双重保护（derivable 免疫 + decision 兜底）锁定
只能逐条人工拒。设计 spec / 计划见 `docs/superpowers/specs|plans/
2026-07-31-subagent-origin-downgrade*`。

1. `DistillInput.sourceKind`（distiller.ts）可选字段默认 'conversation'；subagent
   时候选 origin 强制降级 agent-observed（贴金防护之后，最防御），evidence 保留。
2. scheduler tick 调 distillTranscript 传 `sourceKind: job.sourceAgentId ? 'subagent'
   : 'conversation'`（复用 :186/:200 谓词）。
3. client.ts openDb 加幂等回填 UPDATE（source_kind='subagent' AND status='candidate'
   -> origin='agent-observed'，守卫 `AND (origin IS NULL OR origin != 'agent-observed')`
   覆盖 NULL 行 + 避免重复 WAL 写）。

后果：降级后这些候选失去 stated 双重保护，回正常价值判定（临时指令可能被丢、
持久约定以 agent-observed 身份留下）。主会话侧 5 条 conversation 错标本轮不碰，
留人工。回填需重启 daemon 生效（与已知债务 #4 同款）。

执行：subagent-driven（3 实现 task 各 implementer + reviewer，全部 review clean，
3 条 deferred minor 见 sdd ledger；终审 pending）。`bun run typecheck && bun test`
555/555 全绿。

## opencode plugin 新旧 SDK 签名兼容 + capture 可观测性（2026-08-03）

诊断「opencode 会话结束了但蒸馏记录里没有」（本会话亲测）。根因链：opencode
在会话运行期间**自动升级 1.15.5 -> 1.18.10**（日志 `installation method=npm
target=1.18.10 upgraded` 实证），SDK `client.session.messages` 签名从
`{ path: { id: sessionID } }` **翻转回扁平 `{ sessionID }`**（1.18.10 二进制
内部调用形态取证），plugin 旧签名调用失败被 `catch (e) { /* best-effort */ }`
**静默吞掉**——capture 从不发出，且零可观测性。排查证据链（DB 对照 / 版本对照 /
binary 取证 / 假设排除）完整记录于 spec。设计 spec / 计划见
`docs/superpowers/specs|plans/2026-08-03-opencode-sdk-compat*`。

1. `fetchSessionMessages`（opencode-plugin/memside.js）双签名探测 + 成功记忆：
   flat `{ sessionID, limit: 1000 }` 优先、`{ path: { id: sessionID } }` 兜底；
   成功判据 = `res.data` 真值（生成的 SDK 可能返回错误响应对象而非 throw，
   二进制内 `session.get` 显式 `{throwOnError:true}` 是反证）。探测 catch
   记 warn（Task 3 plan 矛盾经用户裁决选「probe 加 warn」方案，守卫不变量普适）。
2. 可观测性：`log(client, level, message, extra)` 走 `client.app.log`（opencode
   日志文件；TUI 下 stderr 不可见），自身失败降级 console.error。四类打点：
   成功 capture info（sessionID + 条数 + 命中形态）/ 签名回退 warn /
   失败与 sessionID 缺失 error / inject 失败 error。
3. 测试双层：假 client 驱动真实 hooks 的功能测试（`freshPlugin()` Bun
   `?fresh=N` 缓存击穿隔离模块级 compat 状态，锁定形态调用**顺序** + 回退 +
   记忆 + 终态）+ 源码层文本断言（双签名 / `res.data` 判据 / catch 必记日志 /
   default-only 导出守卫）。

**Task 5 live 冒烟暴露的第二次破坏性变更（修复）**：冒烟期间 opencode 再次
自动升级 **1.18.10 -> 1.18.11**（这也是一开始执行 subagent 挂数小时的元凶：
npm 升级耗时 + TUI 进程占用 opencode.exe 的 EPERM 纠缠）。1.18.11 plugin
加载器改为**遍历模块所有 export**：非函数且非 `{server: fn}` 的 export 直接
`throw TypeError("Plugin export is not a function")` 拒绝加载整个 plugin，
函数形 export 还会被当 plugin 调用——本分支 Task 1 加的 `export const compat`
（对象）正中枪口（live 日志 `failed to load plugin` 实证）。修复：**回归
default-only 导出**（compat/fetchSessionMessages 转模块内私有，删
resetCompatState），探测层测试全部改走钩子层驱动；新增文本守卫锁定源码恰一个
export 行。opencode plugin 从此不得加 named export（守卫红即意图）。

执行：subagent-driven（4 计划 task + 1 现场 fix task，各 implementer + reviewer；
Task 3 plan 内部矛盾与 Task 5 加载器事故均经用户拍板；全部 review Approved，
deferred minor 见 sdd ledger）。`bun run typecheck && bun test` 全绿（568 通过）。
终审 whole-branch review verdict=Ready to merge=Yes（0 Critical / 0 Important，
8 条 deferred minor 全判可 defer，其中 plan-mandated 5 条）。PR #35。

### 终审 deferred minor（建议打包一个 follow-up issue）

1. `log()` 最内层 `console.error('[memside] log fallback also failed')` 未设防：
   console.error 自身抛错时 rejection 可沿 probe catch -> 事件钩子 catch 链抵达
   opencode，违 best-effort 契约（需运行时根本性损坏才可达）；修法
   `try { console.error(...) } catch {}`（bare catch 无括号，不被 catch 守卫正则
   误伤，两不变量共存）。含同根的「probe await log 理论 reject 路径」。
2. 文本断言可收紧：export 守卫只匹配 `'export '` 前缀（漏 `export{x}` / 缩进 /
   多行形态），`/^\s*export\b/` 更严；catch 守卫的非贪婪切片止于首个 `}`
   （当前 5 处切片均实证含日志 token，危险方向窄）。
3. spec 文案两处漂移（仅文档）：双形态失败处 spec 写「抛最后一个错误」，实现随
   plan 是**首个**错误；spec §1e named-export 测试接缝已被 1.18.11 事故推翻
   （STATE.md 已载加载器偏差，未载 firstError 语义）。
4. `tests/plugin-opencode.test.ts:4` 顶层设 `MEMSIDE_PORT` 在 bun 单进程跨文件
   残留（今日实证无害：7777 处处默认）；`freshPlugin()` 每次重载模块顶层致
   NO_PROXY 追加重复累积（功能惰性）。
5. ambient d.ts 通配声明在改动态 import 后不再匹配任何 import（`?fresh=N` 模板
   说明符解析为 any），仅余形状文档作用，头部注释过期。

### live 冒烟结果（2026-08-03，本机 opencode 1.18.11，受控超时重跑）

- `opencode run`（scratch 目录，`autoupdate` 经 `OPENCODE_CONFIG_CONTENT`
  内联关闭）-> capture 闭环恢复：memside DB 出新 `runtime='opencode'` job
  （status=done）+ event payload 为真实冒烟对话两轮。
- plugin 加载干净（对照证据：修复前同路径报 `failed to load plugin`，修复后无）。
- **验证缺口 1（1.15.5 回归）**：本机已升级无法真机降级，旧形态行为由假 client
  功能测试覆盖（flat 抛错 -> path 兜底用例）。
- **验证缺口 2（app.log 落盘）**：`opencode run` 快退模式下进程退出早于日志
  落盘，capture-ok 行未见于日志文件（plugin 侧调用未报错——无 console.error
  兜底输出可证）；常驻 TUI / serve 进程日志持续写盘（该文件增长过程实观察），
  真实使用场景不受影响。
- **附带发现（待用户处置）**：7/25 挂死的 `bun test tests/openai.test.ts`
  进程（PID 25208）九天烧约 77.7 万 CPU 秒；opencode 自动升级在 TUI 占用
  exe 时可能挂死非交互调用——冒烟类脚本应内联关 `autoupdate` + 进程级超时。



## opencode TUI capture �ٳɹ��޸���res.ok ��� + ������ NO_PROXY��2026-08-04��

PR #35 �ϲ����û����� TUI �ع飺plugin ��־ `capture ok messages=124 shape=path`
�� daemon ���� job��֤������λ������Ӹ���

1. **bun �ڽ����׸� fetch ʱ�̻���������**������ʵ��ʵ֤��NO_PROXY ����ǰ��λ
   -> 202 ֱ����⣻�׸� fetch ����� -> 502 �ߴ�����ʧ����TUI �� opencode ����
   ������������ plugin ģ����أ�plugin �ڵ� NO_PROXY ��д��Զ̫����
   7/31 �� 4 �γɹ� capture ȫ�� `opencode run` ���̣�ʱ����������**TUI capture
   �ӵ�һ�����δ�ɹ�**��opencode �ٷ� Network �ĵ���˵ NO_PROXY �����ڽ���
   ����ǰ�Ļ��������required����
2. **ϵͳ������ loopback POST ���� 502**��GET ����ͨ��curl ʵ����գ���
3. **plugin ���� `res.ok`**��bun fetch �� 502 �ճ� resolve���ɴ���ѡ�daemon ����
   û�յ����ǳ� capture ok�����۲���ȱ��������ʹ����

�޸�����֧ fix/opencode-capture-res-ok��С bug fix �������

1. capture / inject ���� fetch �� `res.ok` ��飬�� 2xx ������� catch �� error
   ��־���� HTTP ״̬�룩��NO_PROXY ����ע�������¹ʽ�ѵ��in-process ��дֻ��
   belt-and-suspenders�������ǻ���������
2. ��ά������Windows �û����������� `NO_PROXY=127.0.0.1,localhost`��ԭ��Ϊ�գ�����
   opencode �ٷ��Ƽ����ƣ�������������Ч��
3. ���ԣ�502 �ٳɹ����ܲ��ԣ�capture + inject��+ �ı������������� res.ok ���
   ����Դ�� RED ʵ֤������ socket ���ߴ���������Bun.connect�����û��İ� YAGNI ������

`bun run typecheck && bun test` 571/571 ȫ�̡���֤����Ч���û�������һ�� opencode
������ plugin + �»�������������һ�� idle Ӧ�� capture ok �� daemon ���� opencode job��

## opencode 插件挂死根治（裸 socket 传输 + 钩子结算不变量，2026-08-06）

用户实测：opencode 装 memside plugin 即整体冻住，卸载恢复。根因链（完整取证
见 spec）：bun（opencode 内嵌运行时）node:http 的 destroy 吞没 bug（timeout 后
destroy 不结算 Promise，Node/bun 对照实验证实）× 系统代理吞掉 loopback 请求
不回应 × opencode 1.18.13 Plugin.trigger 在消息管线关键路径串行 await
transform 钩子 = 永久挂死。设计 spec / 计划见
`docs/superpowers/specs|plans/2026-08-05-opencode-plugin-hang-settlement*`。

1. `settleWithin`（opencode-plugin/memside.js）：纯 Promise.race 硬预算，
   transform 钩子 2s / event 钩子 30s 内必然结算——不依赖任何可能被 bun
   破坏的运行时行为。钩子 body 搬入私有 handleTransform/handleSessionIdle，
   入口 try/catch 包 settleWithin；全部 log() 改 fire-and-forget（void），
   堵 catch 通道后门挂点。
2. 传输层 node:http -> node:net 裸 socket：手写 HTTP/1.1（Content-Length +
   chunked 解析），结构上不读代理 env（live 实证），从根消除代理论劫。
   接口形状与错误语义不变（调用点零改动）。NO_PROXY 追加保留为无害冗余。
3. 测试：黑洞服务器挂死回归红测试（现代码撞 test timeout 失败）+ wire 级
   framing 契约（Content-Length/chunked/非 2xx）+ hostile 代理 env 行为锁 +
   文本守卫重写（node:net + 禁 node:http + settleWithin 双包裹 + 预算常量）。

执行：subagent-driven（2 实现 task 各 implementer + reviewer，全部 Approved；
deferred minor 见 sdd ledger）。`bun run typecheck && bun test` 582/582 全绿。

### 真机冒烟（post-merge，硬门槛）
1. daemon 在运行装修复版插件 -> `opencode run` 注入成功（无 transform 错误日志）。
2. 杀 daemon -> `opencode run` 毫秒级跳过（ECONNREFUSED 日志），无挂死。
3. 用户 TUI 验收：正常使用一轮不卡 + capture ok + daemon 新 opencode job。
4. 大会话抽查：长会话 idle 捕获不被 30s 预算误杀。

## 设置 tab 统一收拢 LLM/判定配置（2026-08-07）

Web UI 新增第 6 个「设置」tab：把原本常驻状态栏下方的 LLM 设置（生效回显 +
保存/测试/清除）与判定设置（质量/经济模式 + agent 预算）两个区块收拢进去，
为后续更多设置项留扩展位。设计 spec / 计划见
`docs/superpowers/specs|plans/2026-08-07-settings-tab*`。

1. `tab-cache.ts` 纯函数 `isListTab`：settings 无列表数据流的唯一判据。
2. `App.tsx`：TabKey 加 'settings'（无计数徽标）；refresh/loadMore/轮询/
   observer/列表尾部五处入口经 isListTab 短路；列表尾部整块门控
   （tabPageOf 对 settings 索引 undefined 会抛 TypeError，必现 crash 防护）；
   两区块从常驻位置移入 settings 分支（组件本体逐字不动，切走卸载/切回重挂载
   每次重 fetch 生效配置）。
3. 进入设置 tab 一次性 getStatus()（不轮询不拉列表）：daemon 断连时全局错误
   banner + 区块内错误行均可见。

执行：subagent-driven（2 实现 task 各 implementer + reviewer，全部 Approved；
终审 opus whole-branch review verdict=Ready to merge=Yes，0 Critical /
0 Important）。`bun run typecheck && bun test` 718/718 全绿。

### 终审 deferred minor（非阻塞）

1. `isListTab` 为 `(tab: string) => boolean` 非 type guard，App.tsx 6 处
   `as MemoryTabKey` cast（守卫后运行时恒真；升级 type guard 可消 cast，留 follow-up）。
2. `isListTab('foo')` 未断言（spec §5 限定测试集；调用点均传编译期 TabKey）。
3. tab-cache.ts / tab-cache.test.ts 结尾无换行符（pre-existing 风格延续）。

## 蒸馏上下文补全与攒量批处理（2026-08-09）

方案 C 会话级累加 job（spec：`docs/superpowers/specs/2026-08-09-distill-context-and-batching-design.md`）：

1. **累加机制**：一个 (runtime, sessionId) 最多一个 waiting job；capture upsert
   全量快照（events 一 job 一行，顺手消掉已知债务 #1 的重复快照增长）；阈值
   （8000 字符 / 50 turn 护栏）放行，SessionEnd flush + TTL 2h sweep 双兜底，
   低于 1000 字符判 skipped_trivial 不调 LLM。
2. **distiller 上下文**：新切片 + 前文 digest（质量模式滚动 LLM 摘要存
   memory_session_digests / 经济模式确定性截断）+ 已审批标题清单（≤100 条）；
   两节均空时 prompt 与旧行为逐字节一致。
3. **降级可见化**：memory_degradations 审计表 + /api/status recentDegradations
   + 状态栏琥珀横幅（可确认）+ 蒸馏记录 modal 降级明细。任何降级不得静默。

### 上线后观测（硬要求，结论回填本节）

- waiting->放行分布 / skipped_trivial 占比 / 阈值松紧；
- degradations 24h 计数：哪个 kind 高频；
- 滚动摘要质量：质量模式候选与既有记忆重复率变化；
- events 表体积增速变化（对比已知债务 #1 的 92MB 基线）。

## Thinking 捕获 + 工具名渲染（2026-08-09）

诊断：distill 输入整体丢弃 AI 思考内容（claude thinking 块刻意 skip、opencode
reasoning part 过滤），而 origin discipline 放宽后「agent 给出且被用户采纳的
rationale 可记但需原话出处」——thinking 正是 rationale 主要载体，distiller 看不
到；伴生缺陷：toolName 已配对拿到但渲染只剩 `[tool]`，LLM 与用户都分不清
Read/Bash。设计 spec / 计划见 `docs/superpowers/specs|plans/
2026-08-09-thinking-capture*`。

1. `TranscriptTurn.role` 加 `'thinking'`（方案 A 独立 role）：retry 检测只看
   assistant，旧版 skip 的污染顾虑结构性消除。
2. claude `parseTranscriptFile` 捕获 `{type:'thinking', thinking}` 块；
   opencode `parseOpencodeMessages` 捕获 `{type:'reasoning', text}` part；
   redacted / 缺文本字段跳过，解析器永不抛。
3. 同等对待：thinking 与 assistant 同 20000 cap、同 turnPriority=2、digest
   同 300 字 `THINKING:` 行；三档压缩策略逐字不动。
4. 渲染：distiller prompt `[thinking]` / `[tool:Name]`（无名兜底 `[tool]`）；
   SYSTEM_PROMPT 加 thinking 说明段（可作 rationale 出处证据，未浮现未采纳
   仍 REJECT）；Web 遮罩 thinking 紫徽标 + tool:Name 标签。
5. e2e 闭环锁：fixture 带 thinking 块，断言 `[thinking] …` 抵达 distiller
   输入。无 schema 迁移。
6. 攒量批处理交互：thinking 计入 slice signal（computeSliceSignal 复用
   filterTranscriptForDistill），放行阈值（8000 chars）与琐碎下限
   （1000 chars）对 thinking 同等计数——以 thinking 为主的 session 会更早
   放行/更少 skipped_trivial，方向与「同等对待」自洽，上线观测对照
   skipped_trivial 占比变化（测试锁定见 threshold.test.ts）。

### 上线后观测（并入 2026-08-09 攒量批处理清单）

- thinking turn 占蒸馏输入比例（distill runs 抽样）；
- events 表体积增速变化（thinking 全文入快照，对比 92MB 基线）；
- evidence 摘自 thinking 的候选质量（人工审批抽样）与 LLM 过度提取迹象
  （origin=agent-observed 且 evidence 仅出自 thinking 的占比）。
- skipped_trivial 占比是否因 thinking 计入 slice signal 而下降（对照攒量
  批处理基线）。

## 工具调用信息捕获（2026-08-09）

诊断：thinking 捕获（PR #54）让 distiller 看到 `[tool:Read]` 标签，但工具调用的
input（Bash 命令、Grep pattern 等）仍被整体丢弃--distiller 看到工具结果却不知
是哪条命令跑出来的。设计 spec / 计划见 `docs/superpowers/specs|plans/
2026-08-09-tool-call-capture*`。

1. `TranscriptTurn` 加 `toolCall?: string`：input 紧凑 JSON，捕获时截
   `TOOL_INPUT_CAP_CHARS`(300) 字。一刀切，无按工具特判（新工具自动覆盖）。
2. claude `parseTranscriptFile` 配对时从 tool_use.input 取 toolCall；
   opencode `parseOpencodeMessages` 按 callID 取。input 缺失/畸形 -> 不设，
   解析器永不抛契约不变。老 payload 无 toolCall -> 全链路走无调用分支（向后兼容）。
3. 全链路呈现：distiller prompt 两段式 `调用: {...}` + `结果: ...`（无 toolCall
   时逐字节兼容单行）；digest tool 行带截 100 字调用摘要；Web 原始输入遮罩展示。
4. 预算诚实化：`filterTranscriptForDistill` 计量含 toolCall，避免 300 字 × N
   个工具调用绕过 64000 token 预算。三档压缩策略逐字不动（只作用于 content）。
5. e2e 闭环锁：fixture 加 Bash tool_use+result，断言 `调用: {"command"...`
   抵达 distiller 输入。无 schema 迁移、无新依赖。

### 上线后观测（并入既有清单）

- events 表体积增速变化（toolCall 入快照，每条 tool turn 至多 +300 字）；
- 蒸馏候选中 evidence 引自命令调用（`调用:` 行）的质量抽样；
- distill runs 抽样：toolCall 占蒸馏输入的比例。

## Web 记忆列表多维筛选（2026-08-11）

诊断：分页架构（每页 20 条、服务端游标）下客户端一次只持有一页数据，
跨多项目的记忆（live DB 3135 条候选/已拒）无法定位——客户端侧筛选
必错，全部下沉服务端。设计 spec / 计划见 `docs/superpowers/specs|plans/
2026-08-11-web-memory-filters*`。

1. **四维服务端筛选**（记忆 tab）：项目（source_cwd 精确匹配）、slug
   （subject_slug）、分类（title 的 `[category:xxx]` 前缀 instr 匹配，
   带闭括号防 `arch` 误配 `architecture`；facets 数据驱动含幻觉值）、
   价值六筐（value_class，`unevaluated` 哨兵筛 NULL）。四个记忆 tab
   （候选/已审批/已拒绝/AI自动拒绝）每维单选下拉，跨维 AND 组合；
   discards tab 两维（项目/分类——表无 slug/value_class 列）。
2. **新 `GET /api/facets`**：全局口径（不分 tab），项目/分类 UNION
   memories+memory_discards 两表（丢弃行永不进 memories 表），slug 仅
   memories 非空值，value_class 含未评估桶；count 降序 + 值字典序，
   cap 200；随 3s 轮询刷新。
3. **分页响应加 total**（`PageWithTotal`）：筛选激活时列表头显示服务端
   COUNT 诚实计数，不是前端已加载条数。
4. **改筛选 = 四个记忆 tab 缓存全部作废**——`mergeRefreshPage` 会追加
   不在页 1 的旧条目，不作废则旧筛选条目混进新列表；**filterRef** 镜像
   最新 filter，防 3s 轮询 setInterval 闭包读旧值（loadMoreRef 同模式）。
5. 无 schema 迁移、注入链路 / distiller / scheduler / 状态机零改动；
   筛选参数仅分页路径（带 limit）识别，旧无 limit 全量路径不变。

执行：subagent-driven（7 实现 task 各 implementer + reviewer，全部
Approved；deferred minor 见 sdd ledger）。`bun run typecheck && bun test`
860/860 全绿。

### 终审 deferred minor（非阻塞）

1. pure-category / store-filter / store-facets 测试文件结尾无换行符
   （cosmetic，pre-existing 风格延续）。
2. `projectDisplayName` 混合分隔符/盘符根升级路径无测试（brief 未要求，
   评审判定非缺陷）。
3. filter conds 为 `any[]`（可用 drizzle `SQL[]` 收紧；与 store.ts 原生
   风格一致，行为无差）。
4. `listFacets` categories 全量 title 载入 JS 解析（超大表时的规模上限，
   现量级无压力）。
5. 空串 query 参数无显式测试（代码经 truthiness 正确处理）。
6. 「筛选选项加载失败」文案在首次 facets 正常加载期间也显示（brief 既定
   JSX；失败与加载中同一降级表现）。

## 记忆列表筛选按 tab 圈定（2026-08-11，修订 PR #56）

PR #56 上线后用户反馈：所有 tab 的筛选看起来都是候选审批 tab 的。根因是两个设计
决策——facets 全局口径（旧 spec 决策 D2）+ 筛选状态跨 tab 共享——在 live 数据极端
分布下（candidate 574 / approved 7 / rejected 2554 / discards 691）全面暴露：小 tab
下拉里全是本 tab 不存在的值、计数不属于本 tab、共享选择跨 tab 携带即空。设计
spec / 计划见 `docs/superpowers/specs|plans/2026-08-11-per-tab-memory-filters*`。

1. `listFacets(db, scope)`：scope = `{kind:'memories', statuses}` | `{kind:'discards'}`；
   废除两表 UNION 全局口径，每 tab 只数自己的数据；discards scope 的 slugs/
   valueClasses 恒空（表无对应列）。排序 / FACET_LIST_CAP / unevaluated 桶不变。
2. `GET /api/facets?tab=candidate|approved|rejected|discards`：tab→statuses 映射与
   `memoryTabFilter` 一致（approved 含 archived/superseded 三态）；缺失/非法 -> 400。
3. App.tsx：筛选态改 per-tab `Record<FacetTab, MemoryFilter>`（切 tab 不携带）；
   facets 按 tab 缓存 `facetsByTab`（SWR：切回立显，首访未载灰字禁用）；changeFilter
   收窄为只作废当前 tab 缓存（四缓存全作废是共享态配套，随共享态废除）；filterRef
   防轮换闭包模式不变。
4. 注入链路 / distiller / scheduler / 状态机零改动，无 schema 迁移。

执行：subagent-driven（2 实现 task 各 implementer + reviewer，全部 Approved 零发现）。
`bun run typecheck && bun test` 865/865 全绿。

## Web UI 可理解性改造（记忆审阅页信息架构重构，2026-08-11）

用户反馈记忆审阅页「非常不直观」，五痛点：category 含义不透明、`[slug]` 标签无解释、
`中·陷阱`/`agent 观察` 式徽章缩写难懂、`project · claude-code · 来源: memside` 元信息
行无字段名、筛选栏无标题。方案：全部「黑话 → 人话」语义映射抽为 `src/web/ui-utils.ts`
纯函数层（单一事实来源），App.tsx 只做「分类：/价值：/出处：/主题：」等前缀拼接与
`title` 悬停挂载；视觉风格不动、数据模型 / 服务端 / 注入链路零改动、筛选值仍传英文原值。
设计 spec / 计划见 `docs/superpowers/specs|plans/2026-08-11-ui-clarity*`。

1. **ui-utils 语义纯函数层**（`src/web/ui-utils.ts`）：`categoryInfo`（10 标准分类
   中文名 + tip，幻觉值兜底显原值）、`valueClassInfo`（6 筐 + 未评估，含 priority/tip）、
   `stripCategoryPrefix`（显示剥 `[category:xxx]` 前缀，剥空回退原标题）、
   `categoryFromTitle`（web 本地副本，决策 D7：vite 无 `@` alias 不跨层 import，
   一致性测试锁 `@/memory/pure` 同语义）、`scopeInfo`/`runtimeLabel`/`runtimeTip`、
   `SLUG_BADGE_TIP`；`originBadge` 加 tip 字段（label/color 逐字不变）。
2. **MemoryCard 信息架构重构**（App.tsx）：title 剥离前缀 + 徽章行（分类/价值/出处/
   主题，各带字段名前缀 + 悬停 tip）+ 元信息字段化（范围/会话工具/源项目/提炼于，
   各带 tip）。删死代码 VALUE_LABEL/valueBadge/priorityRank；`store.ts:987` 注释同步。
   **编辑表单 title 保留含前缀原值**（stripCategoryPrefix 只走显示路径，服务端分类筛选
   靠 title 前缀 instr 匹配，不动存储值）。
3. **DiscardCard 同步**：title 剥离前缀 + 分类 chip + 拒绝理由前缀（`拒绝理由: ` + tip，
   红色保留）+ 元信息字段化（范围/源项目/拒绝于）；promoted/提升按钮逻辑不动。
4. **筛选栏**：加「筛选」标题 + 说明行、布局改列向；维度改名（源项目/分类/主题(slug)/
   价值，「价值筐」黑话退役）；分类/价值选项中文化（`categoryInfo`/`valueClassInfo`，
   幻觉值兜底显原值、option title 挂英文原值）。数据流（changeFilter/facetsByTab/
   filterRef/清除筛选/灰字降级）零触碰。

回归防护：源码层文本断言锁新接线（stripCategoryPrefix/categoryInfo/scopeInfo/runtimeLabel/
runtimeTip 等）+ 反向断言（`高·`/`中·` 缩写与 `label="价值筐"` 不得复活）+ D7 跨模块
一致性测试（web 副本 vs `@/memory/pure` 逐例相等、剥后提不出分类）。

执行：subagent-driven（4 实现 task 各 implementer + reviewer 全 Approved；终审 opus
whole-branch review verdict=Ready to merge=Yes，1 Minor——runtime tip 静态文案——经一轮
fix wave 对齐 spec §4.5 按值措辞后 scoped re-review ADDRESSED）。plan 两处测试用例内部
矛盾经裁定改测试（实现符合 spec）。`bun run typecheck && bun test` 891/891 全绿。

### 终审 deferred minor（非阻塞）

1. `tests/ui-clarity.test.ts` 结尾无换行符（cosmetic）。
2. `valueClassInfo` 不 trim/小写输入（与 `categoryInfo` 不对称；valueClass 是内部枚举
   无自由文本路径，spec 未要求）。
3. `categoryInfo` 幻觉兜底 name 用未 trim 原值（spec §4.1 明文「name = 原值」，合规）。
4. `label="分类"` 锚点未加强为「恰一处」断言（既有值非本次回归面，polish）。
5. 筛选标题 div 无 marginBottom，间距由说明行承担（spec §7.1 既定结构，视觉 polish）。
6. 同一卡片两个「出处：」并存（origin chip + evidence 行，spec §6.1 已批准设计；后续
   若用户困惑可考虑 origin chip 改名「来源类型」）。

## 滚动摘要职责反转：会话事实账本（2026-08-11）

实测 4/4 `digest_truncated` 连环降级（单 session）+ 复现证明超预算是系统性偏差
（11840 字输入 -> 3834 字产出，128% of budget，stop_reason=end_turn）。根治：
LLM 只做按片压缩（配额 = 渲染长度/2，钳制 [600, 3000]），全局预算 6000 与留存
（丢最旧、保最近，trimOldestLines 两模式共用）收归代码。spec / plan 见
`docs/superpowers/specs|plans/2026-08-11-digest-ledger-redesign*`。

1. `DIGEST_MAX_CHARS` 3000 -> 6000（用户确认；蒸馏 prompt 背景节占比增量 ~5%）。
2. `contextDigest.ts` 抽出 `renderDigestLines` / `trimOldestLines`；
   `buildDeterministicDigest` 重组，逐字节不变（既有测试为回归锁）。
3. `rollingSummary.ts` 重写为 `updateSessionLedger`：小切片（渲染 <1200 字）直追
   免 LLM；大切片 LLM 压缩（prompt 附账本最后 ≤5 行衔接）；产出超配额按行裁最旧
   + `digest_truncated`（detail 含 actual/budget 数值）；追加后全局裁剪不记降级。
4. 遗留 prose 摘要 `isLineStructured` 探测，首次合并一次性重整（满额预算），无迁移脚本。
5. 删除 `mergeRollingSummary` / `ROLLING_SUMMARY_SYSTEM_PROMPT`；UI 标签改「摘要压缩超限」。
6. `bun run typecheck && bun test` 918/918 全绿（75 files，2427 expect() calls）。

### 上线后观测（硬要求，结论回填本节）

- `digest_truncated` 24h 计数（预期近零；仍高频 -> sliceBudget 比例偏紧，纯函数一行可调）；
- 账本长度分布（length(digest) 贴 6000 频率，评估预算再调）；
- 跨片指代质量：候选与既有记忆重复率是否因「只看切片 + 尾 5 行衔接」上升；
- 对照 2026-08-09 观测清单的 degradations kind 分布变化。

## 状态栏 LLM 实况 + 消息中心（2026-08-12）

诊断：原顶部状态栏只有「已捕获事件 / distill 进行中 / 记忆计数 / 最近错误」，信息密度低、用户看不到 LLM 内部三阶段进展；降级与 LLM 报错混在状态栏里一闪而过，既吵又不人性化。本次重写状态栏并新增「消息」tab 作为统一收件箱。

1. **状态栏 LLM 三阶段实况**：蒸馏(distill/digest) / 去重(dedup) / 审查(judge) 的进行中状态与耗时、近 24h 各阶段统计（次数 / 累计耗时）。
2. **`ActivityTracker` 单例注入 scheduler 与 server**：在 daemon 层用一个单例跟踪当前 job 各阶段起止时间，避免 scheduler/server 两端各自记状态导致漂移。
3. **`memory_distill_runs` 三耗时列**：`digest_ms` / `dedup_ms` / `judge_ms`（均可空，NULL = 该阶段未调 LLM；既有 `duration_ms` 仍是 distill 阶段耗时），scheduler tick 接线写入。
4. **统一消息收件箱**：新建 `notifications` 表，`logDegradation` 双写降级 + scheduler llm_error 路径写消息；Web UI 新增「消息」tab，支持未读计数徽标、筛选、搜索、逐条已读、全部已读；旧的 `/api/degradations/ack` 端点与 `recentDegradations` 状态字段退役（`memory_degradations` 审计表与按 job 明细端点保留）。
5. **`/api/status` 新字段**：`llmActivity` / `llmStats24h` / `unreadNotifications`，驱动状态栏与消息入口。

执行方式：subagent-driven（10 实现 task 各 implementer + reviewer；全部 Approved）。`bun run typecheck && bun test` 955/955 全绿。设计 spec / 计划见 `docs/superpowers/specs/2026-08-12-llm-status-and-message-center-design.md` 与 `docs/superpowers/plans/2026-08-12-llm-status-and-message-center.md`。

### 终审 deferred minor（非阻塞）

全分支终审对 8 条任务级 deferred minor 的裁决：

1. T1 `ActivityTracker.get()` 返回活引用——**接受**（plan-mandated，下游只读）。
2. T2 无老库 ALTER 回归测试——**follow-up**（与既有迁移块同缺口，并入测试卫生 issue）。
3. T3 吞错路径无负向测试 + 5ms sleep 单调性余量——**接受**（console-only 设计契约）。
4. T4 waitingJobs 断言丢失 + clampPageLimit docstring（50 vs 实际 20，pre-existing）——**follow-up**（测试卫生 issue）。
5. T5 scheduler-activity 未用 import / 测试 4 标题夸大 / catch 文案 stale——**接受**（并入测试卫生 issue 更佳）。
6. T6 tracker 参数顺序迁就测试正则——**接受**（语义无差）。
7. T9 反向锁收窄为七个完整旧标签 + 双处未读徽标——**接受**（锁意图保全；双徽标 brief mandated）。
8. T10 首帧闪空态 + markAllRead 无 try/catch——**接受**（轮询自愈兜底）。

follow-up 清单：scheduler digest 接线测试（spec §8 #12 缺口，quality 模式断言 digestMs 非 NULL + seen 含 'digest'）；llmStats24h 窗口外行回归；waitingJobs 断言补回；clampPageLimit docstring；listRecentDegradations 去留决策（现仅测试引用，生产无调用方）。

## 蒸馏 LLM 流式化 + 失败可见性（2026-08-14）

诊断：2026-08-13 起蒸馏 LLM 调用持续失败（`Connection error.`，单次失败耗时 448-566s），但设置页「测试连接」始终报成功，用户未察觉故障（去重/审查计数连日为 0 才暴露）。systematic-debugging 一次性脚本实测结论（完整对照表见 spec §1）：当前 LLM 端点（kimi coding）对**生成时长超过约 60 秒的非流式请求准时断连**（60s 整 Connection error，代理 7897 与直连同现，排除本地代理因素；60s 整的特征指向端点/网关的 TTFB 类限制）；同载荷流式请求（字节持续流动）170-203s 稳定完成；「测试连接」成功是假象——max_tokens=1 的秒级探针永远碰不到 60s 墙。设计 spec / 计划见 `docs/superpowers/specs/2026-08-14-llm-streaming-and-failure-visibility-design.md`。

1. **`makeLLMCall` 流式化**（`src/anthropic.ts`）：`messages.create` 改为 `messages.stream` + `finalMessage()`，显式 `timeout: 600_000`（10 分钟硬上限兜底，正常流式 170-210s）；文本提取与返回值语义不变，distiller / dedup / judge 调用方零感知；`maxRetries` 保留 SDK 默认。
2. **通知同内容折叠**（`insertNotification`，`src/memory/store.ts`）：插入前查最新未读同内容通知——llm_error 按裁剪后 body、degradation 按 title 匹配；命中则不新插，只刷新该行 ts 保持浮顶并返回原 id（跳过保留裁剪）。折叠刷新 ts 用 `MAX(Date.now(), MAX(ts)+1)` 决胜，防快速连插时同毫秒撞车被 ULID 更大的填充行压顶。已读同内容不折叠。
3. **status 三新字段**（`GET /api/status`）：`unreadLlmErrors` / `unreadDegradations`（notifications 按 kind 分组未读计数）、`latestUnreadLlmError`（最新一条未读 llm_error 的 body/ts，无则 null）；既有 `unreadNotifications` 总数保留。
4. **状态栏警示条**（`src/web/App.tsx`）：`unreadLlmErrors > 0` 渲染红条「⚠️ 蒸馏 LLM 报错 ×N（最近：<body 截断 40 字>）→ 点击查看」，`unreadDegradations > 0` 渲染琥珀条「⚠️ 降级 ×N → 点击查看」，点击均 `setTab('messages')`；两条可同时存在（红条在上），无独立关闭按钮，未读清零后自动消失。截断走新纯函数 `truncateAlertBody`（`src/web/ui-utils.ts`，null → `'（无详情）'`）。
5. **🔔 三态变色**：未读 LLM 报错 → 红色加粗；仅降级未读 → 琥珀色；都无保持默认。
6. **设置页测试连接语义澄清**：按钮下方加灰色小字「仅验证端点可达；长蒸馏请求可能仍失败，失败会在状态栏警示条提示」，消除「测试绿 = 蒸馏必成」错觉；探测方式不变（仍是 max_tokens=1 非流式小探针，测的就是可达性）。

执行：subagent-driven（5 实现 task 各 implementer + reviewer，全部 Approved）。`bun run typecheck && bun test` 979/979 全绿。设计 spec / 计划见 `docs/superpowers/specs|plans/2026-08-14-llm-streaming-and-failure-visibility*`。

### 终审 deferred minor（非阻塞）

1. **T3（status 字段）**：`tests/server.test.ts` 新增用例的注释块排版与邻近风格不齐；status 新字段三次查询为顺序 await，可改 `Promise.all` 并行（现量级无压力）。
2. **T5（警示条 UI）**：源码断言测试名超出实际保证（文本断言只锁源码含警示条分支 token，不锁渲染行为本身）；设置页语义澄清小字落在按钮下方（spec §3.4 原写「按钮旁」，实现为下方 marginTop 6px 行，语义等效）。

## 价值判定器 prompt 精度修复（2026-08-14）

审计 live DB 最近 50 候选 + 50 自动丢弃（详见 spec §1）发现两个系统性 prompt 缺陷并修复
（设计 spec / 计划见 `docs/superpowers/specs|plans/2026-08-14-value-judge-prompt-accuracy*`）：

1. **fleeting 误用于永久规则**（实测 D17 prompt 中立硬约束 / D21 push 终验门槛 / D4 review
   报告格式被误判丢弃）：fleeting 加 HARD RULE——只许用于会话性琐事与条目自身标明已被
   取代的指导；长期项目规则 / 工作流 / 质量门槛永远不得判 fleeting。保留 superseded 口子
   兼容 agent 协议段「被取代方判 fleeting」的合法用法。
2. **derivable 边界跨批漂移**（TDD 规则 / STATE.md 追加顺序 / UI 文案照抄三组同事实相反
   判决）：derivable 的 "docs" 显式钉死包含 CLAUDE.md / README / STATE.md / docs/ / 测试
   守卫——已写进仓库文档的长期规矩一律 derivable（用户裁决方向：CLAUDE.md 每会话本就
   注入，重复记忆是噪音）；stated 免疫 HARD RULE 一字不动。

纯 prompt 文本改动：仅 `VALUE_JUDGE_RULES` 两处插入，agent 判定器经共享常量自动继承；
映射代码 / taming / 失败兜底 / 输出段零改动。字节锁测试更新为新权威文本 + 两条意图断言
回归锁。`bun run typecheck && bun test` 980/980 全绿。

### 上线后观测（硬要求，结论回填本节）

- 24–48h 内 `memory_discards` 新行 reason='fleeting' 是否仍命中长期规则措辞（预期近零）；
- 文档化规矩类候选判决是否收敛到 derivable（不再出现 convention/user-rule 留存版）；
- convention 留存是否异常减少（"nowhere written down" 类被误丢的副作用信号）。

### 终审 deferred minor（非阻塞）

全分支终审 verdict=Ready to merge=Yes（0 Critical / 0 Important），2 条 Minor 经裁定 defer：

1. `tests/value-filter-prompt.test.ts` 旧测试名承诺锁「stated 禁考硬规则」但断言只含泛
   `'HARD RULE'` 子串（pre-existing，非本分支引入）；实际防护由字节锁兜底，无真实漏洞。
2. fleeting 新 HARD RULE 口子措辞「the entry itself marks as superseded」与 agent 协议段
   「被另一条取代判 fleeting」严格读有语义缝隙（spec 措辞核对单第 1 条已逐字批准该措辞）；
   并入上线后观测，若实测 superseded 类候选判决异常再收紧。

### Follow-up

1. 蒸馏器 origin 打标准确性（C16 类：正文写"用户明确要求"却标 agent-observed）——
   考虑 distiller prompt 加 origin 硬规则，独立 spec。
2. 存量误判条目（D4/D17/D21/D37）在 Web UI「AI自动拒绝」tab 手动提升，不重判。

## 真实 LLM e2e + AI-as-judge 门禁（2026-08-16）

新增 `npm run test:live`（= `MEMSIDE_RUN_LIVE=1 bun test tests/live-*`）发版门禁：手动 opt-in 真打 distill/dedup/judgeValue 三阶段，默认 `bun test` 因双守卫（凭证 + MEMSIDE_RUN_LIVE env）全 skip 不真打模型。AI judge 在 evidence 真伪上场。4 条硬检查（①callThrew ②rawCount/candidates ③evidence AI judge ④三阶段形状）。不改任何 src/ 生产代码，只新增 tests/live-* + package.json script。设计 spec / 计划见 `docs/superpowers/specs|plans/2026-08-16-live-llm-e2e-eval*`。

### 已知盲区（终审 parked，非阻塞）

1. **检查④虚设**：live-dedup/live-judge 的形状断言对模型幻觉产出无检测力——生产兜底（幻觉 category→keep+null/decision、非法 duplicateOfId→duplicate:false）使断言恒真。门禁对模型/凭证失败的检测力主要靠 live-distill 检查①（callThrew）。真跑实测：本机 401 失效凭证下 live-distill 正确红、live-dedup/live-judge 仍 pass（兜底吞错）。抓幻觉需在 callWithRetry raw parsed 层刺探，留独立 spec。
2. **LIVE_GUARD 只查 apiKey 非空不验有效性**：失效凭证下门禁真跑并红（live-distill）。属环境+既有守卫设计，非本需求引入。后续可考虑凭证有效性预检。
3. **plan 文本 import 路径笔误**：brief 写 DistillCandidate from @/memory/pure，实际 @/memory/distiller:85，实现均已修正。

### 上线后观测（硬要求，结论回填本节）

- 首次有有效凭证环境跑通 `npm run test:live`：三阶段耗时、候选数、evidence judge 判定结果。
- 401/凭证失效在 live-distill 是否稳定抓到（检查①）。

## 蒸馏输入噪声剔除（2026-08-17，诚实更正）

`filterTranscriptForDistill`（`src/memory/pure.ts`）新增 `stripNoiseTurns`，剔除 task-notification XML 块与 compact 续接块两类 user-role 噪声。设计 spec / 计划见 `docs/superpowers/specs|plans/2026-08-17-distill-noise-filter*`。

### 诊断反转（重要，勿重复犯错）

**原判断**：8 月 17 日蒸馏记录大量 empty_output/parse_error，归因于「user role 的 task-notification(~70KB)+compact(~31KB) 噪声没被 filter 识别，占满 255KB 喂模型」。

**实测真相（合并后验证）**：最终喂模型的内容里 task-notification/compact 残留 = **0**。budget 裁剪（`x.p > 1`，user priority=0 永不丢的逻辑下，这些噪声在更早路径已被消化）。最终 248KB 真实构成：**assistant 129.8KB（rationale）+ tool 114.1KB（已压缩工具结果）+ user 4.3KB**。

**结论**：stripNoiseTurns 没解决 empty_output/parse_error 根因——因为噪声本来就不在最终喂模型的内容里。它只在「原始层」减了 ~111KB（DB 中间处理/存储有意义），对「喂模型 248KB 仍超窗口」无改善。

### stripNoiseTurns 仍有价值（保留合并）

- 原始 transcript 层减容 111KB（965.7KB→854.8KB），对 events 存储/中间处理有意义。
- 纯函数、永不抛、零回归（1068 pass / 0 fail），实现正确。
- 只是它不是 empty_output 的解。

### empty_output/parse_error 真因（待新 spec）

最终喂模型 248KB 仍过大，真实构成 assistant 130KB + tool 114KB：
- **assistant rationale 130KB**：长寿会话大量 assistant 解释文本，NON_TOOL_CAP_CHARS=20000 单条 cap 但总量不控。
- **tool 114KB**：已压缩（TOOL_RESULT_CAP_CHARS=3000）但长会话累积大量 tool turn。

直击真因需针对 assistant/tool 总量做 budget 级减容（非单条 cap），新开 brainstorming。

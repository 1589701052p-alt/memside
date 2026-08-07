# 判定设置与存量回扫 UX 改造设计 spec

- 日期:2026-08-07
- 状态:已评审(brainstorming 产出,用户批准)
- 前置:agentic value judge(PR #47)已落地,本 spec 只改其暴露给用户的两个界面,不改判定逻辑

## 1. 背景与诊断

用户试用 PR #47 后的反馈(2026-08-07 原话归纳):

1. **判定设置区看不懂**:「质量 / 经济」「单发判定」「轮次上限」「时间预算」全是内部术语,用户不知道两个模式意味着什么、选了会怎样;输入框与「当前生效」回显行隔得远,没有关联。
2. **回扫存量看不懂**:按钮只有「回扫存量」四个字,用户不知道它干什么、按下去会发生什么。
3. **回扫速度感知差**:质量模式下 734 条候选要跑很久,进度只有一行小字 `回扫中 3/734`,没有进度条。
4. **不能中途停**:回扫一按就跑到底,后端没有取消机制。
5. **效果不可见**:跑完只显示一行计数(处理/判丢/跳过),用户看不到具体哪些被丢了、队列发生了什么变化。

现状代码锚点:

- 判定设置:`src/web/App.tsx` `JudgeSettings()`(约 493-565 行)——下拉 + 两个裸 number 输入(只有 placeholder)+ 独立回显行。
- 回扫:`src/web/App.tsx` candidate tab 工具栏(约 280-294 行)——按钮 + 一行进度/报告小字;`src/server.ts` `rescanState`(约 336-391 行)——无 cancel;`src/memory/rescan.ts` `rescanCandidates()` 跑到底,无中断点。

## 2. 目标 / 非目标

### 目标

1. 判定设置区改成「人能看懂」的形态:模式选择带后果说明,预算字段带完整中文标签,配置值与保存入口聚合。
2. 回扫按钮说明它做什么;进度用真进度条(百分比 + 计数),实时显示已判丢数。
3. 回扫支持中途停止,停止粒度 = **判完当前这批再停**(用户已选定):点「停止」后正在判的那批照常判完、结果照常落库,后续批次不再开始。
4. 回扫结束(含被停止)后显示结果卡片:处理/判丢/保留/跳过计数,且能从结果卡片直接跳到「AI自动拒绝」tab 看判丢明细。

### 非目标

- 不改判定逻辑、判定 prompt、agent 循环、双模式语义本身(PR #47 已评审定稿)。
- 不做「立即中断当前批」级取消:不给 LLM 调用链加 AbortController 中断,改动面与收益不成比例(用户已选定批边界停止)。
- 不新增结果持久化/历史记录:回扫报告仍是内存态(daemon 重启即失),与现状一致。
- 不物理删除任何记忆;判丢仍走 discards 可恢复。

## 3. 设计

### 3.1 判定设置区(JudgeSettings 重写)

布局自上而下:

1. **一句话说明**(灰字):「每条候选记忆进审批队列前,AI 先判一遍值不值得记;被判丢的直接进『AI自动拒绝』,可恢复。」
2. **模式选择**:两张可点选的卡片(radio 语义,选中高亮边框),取代裸下拉:
   - **质量模式(默认)**——说明:「AI 会打开候选来源的项目仓库,亲手搜代码、读文件查证后再判决。判得准,但慢、费 token。」
   - **经济模式**——说明:「AI 只看候选文字本身,一次出判决,不查仓库。快、省 token;拿不准时倾向把候选留下(不会误丢有用的)。」
3. **预算字段仅在选择质量模式时显示**(经济模式下隐藏整段),两个字段各自带完整中文 label(不再靠 placeholder):
   - 「查证次数上限」:每批 15 条候选,AI 最多动手查多少次;查满就用已有信息直接判决。默认 30,范围 1-200。
   - 「查证时间上限(秒)」:每批最多花多少秒,超时同上。默认 300,范围 30-3600。
   - 附注(灰字):「预算耗尽或出任何故障,结果都是『保留』,不会误丢。」
4. **保存行聚合**:输入框初值 = 当前生效值;用户改动后保存按钮旁显「有未保存修改」,保存成功显「已保存,立即生效」,保存失败显红字。不再有独立的「当前生效」回显行(输入框本身就是回显)。

样式:沿用现有 inline style 约定(border/borderRadius/fontSize 与 LlmSettings 同族),不引入新框架。

### 3.2 回扫交互(candidate tab 工具栏重写)

- **按钮**改名「重新筛查全部候选」;旁边灰字说明:「把候选队列按当前判定模式全部重判一遍,判丢的进『AI自动拒绝』,可恢复。」(说明文字常驻,工具栏下方一行。)
- **进度**:跑动中显示
  - 真进度条:宽度 = done/total,显示百分比与 `已处理 X/Y`;
  - 实时计数:「已判丢 N 条」(N 来自后端新增字段,见 3.3);
  - 「停止筛查」按钮(取代跑动时被禁用的开始按钮)。
- **停止**:点「停止筛查」→ 按钮旁显「正在停止(当前这批判完即停)」;该批判完落库后回扫退出,进入结果卡片态。
- **结果卡片**(完成或被停止后显示,直到下次点击开始或切走 tab 再回来——保留现有 status 轮询语义即可):
  - 标题:「筛查完成」或「已停止(剩余 M 条未筛查)」;
  - 计数行:处理 X · 判丢 Y · 保留 Z · 跳过 K(目录已删除的项目);
  - 链接:「查看判丢的 Y 条 →」,点击切到 discards tab。
  - 若 Y = 0 则不显示链接。
- 失败保持现有红字行,不静默。

### 3.3 后端配套(server.ts + rescan.ts,改动面很小)

1. **rescanState 扩展**:`{ running, done, total, discarded, stopping, cancelRequested, report }`
   - `discarded`:实时判丢计数,rescanCandidates 的进度回调带上(回调签名改为 `(done, total, discarded)`);
   - `cancelRequested`:由 `POST /api/rescan/cancel` 置位;`stopping` 供 UI 显示「正在停止」;
   - 报告结构在现有 `{ processed, discarded, skipped, keptUpdated }` 上加 `stopped: boolean`(是否被取消截停),既有字段一律不改名;UI 的「保留 Z」即 `keptUpdated`。
2. **取消机制**:`rescanCandidates` 增加可选参数 `shouldStop?: () => boolean`,**仅在每批开始前**检查一次(批内不查,保证批边界完整性);为真则直接返回当前 report(`stopped = true`)。已判完批次的结果全部已落库,无脏状态——幂等性沿用 spec §4.7 既有结论。
3. **新端点** `POST /api/rescan/cancel`:running 时置 `cancelRequested = true`、`stopping = true`,回 202;未在跑回 409。不做鉴权变化(与现有 /api/rescan 一致,loopback 信任)。
4. **进度通道**:不新增广播——前端沿用现有 /api/status 轮询,rescan 进度经 `status.rescan.{done,total,discarded,stopping}` 下发(现有机制,PR #47 已在用);结束时的 `deps.broadcast({ type: 'rescan' })` 保留。
5. **崩溃恢复**:POST /api/rescan 的 catch 分支补 `rescanState.error`(现会静默解锁按钮,终审遗留 minor,顺手修掉);UI 读到此字段显红字。

### 3.4 失败模式

| 故障 | 行为 |
|------|------|
| 回扫中 daemon 重启 | 与现状一致:已判丢的不重判,剩余重按按钮重判(幂等) |
| 取消请求到达时最后一批恰好结束 | 正常返回 report,stopped 可能为 false;UI 显示「筛查完成」——语义正确,无竞态伤害 |
| cancel 时未在跑 | 409,UI 忽略(轮询会自愈) |
| 进度回调抛错 | 回调由 rescan 内部 try/catch 包裹,不得中断回扫 |
| 单批判定失败 | 沿用现状:该批全保留并继续,不因取消机制改变 |

## 4. 测试策略

沿用仓库惯例(纯函数层写足,UI 留源码文本断言兜底):

1. **rescan 取消**(核心,tests/rescan.test.ts 扩展):
   - shouldStop 第 2 批前为真 → 只判了第 1 批,report.stopped=true,processed=15,剩余候选仍在 candidate 池;
   - 取消发生在最后一批之后 → stopped=false 正常报告;
   - 取消后重跑:剩余候选被正常判(幂等);
   - 进度回调带 discarded 实时计数。
2. **server 端点**(tests/server.test.ts 扩展):cancel 409(未在跑);cancel 202 后 status 里 `rescan.stopping=true`;崩溃路径 status 里带 error。
3. **UI 文本断言**(tests/web-ui.test.ts 扩展):
   - JudgeSettings 源码含两张模式卡的说明文案、预算 label 文本、「不会误丢」附注;预算段条件渲染;
   - candidate 工具栏源码含「重新筛查全部候选」、停止按钮文案、结果卡片文案、「查看判丢」链接;
   - 进度条元素(百分比计算逻辑若抽纯函数则单测之,否则文本断言)。
4. **回归**:现有 rescan.test.ts 全部用例保持绿(回调签名变更做兼容——新参数可选,旧调用方不受影响)。

## 5. 与现有模块的耦合点

- `src/memory/rescan.ts`:回调签名扩展、shouldStop 参数、report 加 kept/stopped。
- `src/server.ts`:rescanState 形状、cancel 端点、crash 时 error 字段、进度广播节奏。
- `src/web/api.ts`:`rescan` 状态类型扩展(discarded/stopping/error)、`cancelRescan()`。
- `src/web/App.tsx`:JudgeSettings 重写(模式卡 + 条件预算段)、candidate 工具栏重写(进度条 + 停止 + 结果卡片)、点链接切 tab(已有 setTab)。
- 判定逻辑、agent 循环、prompt、judgeConfig:一律不动。

## 6. 落地顺序

| # | 任务 | 依赖 |
|---|------|------|
| 1 | rescan.ts 取消机制 + 进度带 discarded + report kept/stopped | 无 |
| 2 | server.ts rescanState 扩展 + cancel 端点 + crash error + 广播节奏 | 1 |
| 3 | api.ts 类型与 cancelRescan() + App.tsx JudgeSettings 重写 | 2 |
| 4 | App.tsx candidate 工具栏重写(进度条/停止/结果卡片/跳 discards) | 2、3(同文件,顺序做) |

每任务独立 implementer + reviewer,终审 whole-branch review,照旧。

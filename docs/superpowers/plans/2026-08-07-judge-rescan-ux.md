# 判定设置与存量回扫 UX 改造 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把判定设置区改成「人能看懂」的模式卡片 + 条件预算段;回扫加真进度条、批边界停止和可跳转的结果卡片。

**Architecture:** 后端只加三样东西——rescan 的批边界停止标记、实时判丢计数、崩溃错误透传;判定逻辑/prompt/agent 循环一律不动。前端重写 JudgeSettings 与 candidate 工具栏两块 JSX,纯函数(进度百分比)抽到 ui-utils 单测,React 组件照旧靠源码文本断言兜底。

**Tech Stack:** Bun + Hono + bun:sqlite;React 19 inline style;bun:test。

**Spec:** `docs/superpowers/specs/2026-08-07-judge-rescan-ux-design.md`

## Global Constraints

- **判定逻辑不动**:`src/memory/agentJudge.ts`、`agentLoop.ts`、`valueFilter.ts`、`judgeConfig.ts`、`repoTools.ts`、判定相关 prompt 一律不碰。
- **停止粒度 = 批边界**:`shouldStop` 只在每批判定开始前检查一次,批内不中断;被停的批结果照常落库,无脏状态。
- **不物理删除任何记忆**;判丢仍走 memory_discards 可恢复。
- **中文文案逐字使用本 plan 中的文本**——测试锁这些字符串,改文案必须同步改测试。
- **UI 沿用 inline style 既有约定**(border `#ddd`、borderRadius 8、fontSize 13/12 灰字),不引入样式框架。
- **运行门槛**:`bun run typecheck && bun test` 全绿才能 push;测试一律 `bun test`,严禁 npm test。
- **绝不 commit** `scripts/audit-candidates*.ts`(一次性审计脚本)。
- **rescanState 新字段对老 daemon 向后兼容**:api.ts 类型里新字段全部 optional,UI 读 `?? 0` / `?? false`。

---

### Task 1: rescan 批边界取消 + 实时判丢计数 + report.stopped

**Files:**
- Modify: `src/memory/rescan.ts`
- Test: `tests/rescan.test.ts`

**Interfaces:**
- Consumes: 现有 `RescanDeps { callLLM, loadJudgeConfig }` 不变。
- Produces(Task 2 依赖):
  - `RescanReport { processed: number; discarded: number; skipped: number; keptUpdated: number; stopped: boolean }`
  - `rescanCandidates(db, deps, onProgress?, shouldStop?)`
  - `onProgress?: (done: number, total: number, discarded: number) => void`(第 3 个参数为**实时累计判丢数**)
  - `shouldStop?: () => boolean`——每批判定开始前调用一次,返回 true 则立即返回当前 report(`stopped: true`)。

- [ ] **Step 1: 改既有断言(红)**

`tests/rescan.test.ts` 两处 `expect(report).toEqual({...})` 的对象字面量各加 `stopped: false`:
- 第 43 行:`expect(report).toEqual({ processed: 3, discarded: 1, skipped: 1, keptUpdated: 1, stopped: false })`
- 第 112 行:`expect(report).toEqual({ processed: 1, discarded: 0, skipped: 1, keptUpdated: 0, stopped: false })`

在文件末尾追加三个新测试:

```ts
// 回归防护(spec 2026-08-07 §3.3):回扫停止粒度=批边界——shouldStop 只在每批判定
// 开始前检查,批内不中断(该批结果完整落库)。stopped=true 时剩余候选仍在 candidate
// 池,重跑可继续(幂等)。
test('回扫取消:第 2 批前 shouldStop 为真 -> 只判第 1 批,stopped=true,剩余可重跑', async () => {
  for (let i = 0; i < 20; i++) {
    await createCandidate(db, {
      scopeType: 'project', scopeId: dir, title: `[category:a] 候选${i}`, bodyMd: 'b',
      tags: [], sourceKind: 'conversation', sourceCwd: dir, runtime: 'claude-code', origin: 'agent-observed',
    })
  }
  let checks = 0
  const report = await rescanCandidates(db, {
    callLLM: economyLLM, loadJudgeConfig: economyCfg,
  }, undefined, () => ++checks > 1)  // 第 1 批前放行,第 2 批前停止
  expect(report.stopped).toBe(true)
  expect(report.processed).toBe(15)  // RESCAN_BATCH=15:只有第 1 批判完
  const remaining = await db.select().from(memories).where(eq(memories.status, 'candidate'))
  expect(remaining).toHaveLength(5)  // 剩余 5 条还在候选池
  // 重跑:剩余 5 条正常判完,不带停止标记
  const second = await rescanCandidates(db, { callLLM: economyLLM, loadJudgeConfig: economyCfg })
  expect(second.stopped).toBe(false)
  expect(second.processed).toBe(5)
})

test('回扫取消:shouldStop 恒假 -> stopped=false(与未取消语义一致)', async () => {
  await createCandidate(db, {
    scopeType: 'project', scopeId: dir, title: '[category:a] 一条', bodyMd: 'b',
    tags: [], sourceKind: 'conversation', sourceCwd: dir, runtime: 'claude-code', origin: 'agent-observed',
  })
  const report = await rescanCandidates(db, {
    callLLM: economyLLM, loadJudgeConfig: economyCfg,
  }, undefined, () => false)
  expect(report.stopped).toBe(false)
  expect(report.processed).toBe(1)
})

test('回扫进度回调第 3 参 = 实时累计判丢数', async () => {
  for (let i = 0; i < 20; i++) {
    await createCandidate(db, {
      scopeType: 'project', scopeId: dir, title: `[category:a] 候选${i}`, bodyMd: 'b',
      tags: [], sourceKind: 'conversation', sourceCwd: dir, runtime: 'claude-code', origin: 'agent-observed',
    })
  }
  const events: Array<[number, number, number]> = []
  await rescanCandidates(db, {
    callLLM: economyLLM, loadJudgeConfig: economyCfg,
  }, (done, total, discarded) => events.push([done, total, discarded]))
  // economyLLM 每批把 index 0 判 derivable:两批各丢 1 条,末次回调 discarded=2
  expect(events.at(-1)).toEqual([20, 20, 2])
})
```

- [ ] **Step 2: 跑测试确认红**

Run: `bun test tests/rescan.test.ts`
Expected: FAIL——`toEqual` 多出 `stopped` 字段不匹配;新测试报 `shouldStop`/`stopped` 不存在。

- [ ] **Step 3: 实现**

`src/memory/rescan.ts` 三处改动:

1. `RescanReport` 加字段:

```ts
export interface RescanReport {
  processed: number
  discarded: number
  skipped: number
  keptUpdated: number
  /** 被 shouldStop 截停(true)= 还有候选没判,可重跑续判。 */
  stopped: boolean
}
```

2. 签名与初始化:

```ts
export async function rescanCandidates(
  db: DbClient, deps: RescanDeps,
  onProgress?: (done: number, total: number, discarded: number) => void,
  shouldStop?: () => boolean,
): Promise<RescanReport> {
  const all = await listAllCandidatesForRescan(db)
  const report: RescanReport = { processed: 0, discarded: 0, skipped: 0, keptUpdated: 0, stopped: false }
```

3. 批循环开头加停止检查(`for (let i = 0; i < kindGroup.length; i += RESCAN_BATCH) {` 下一行):

```ts
      // 批边界停止(spec §3.2):批内不查——正在判的批照常判完落库,无脏状态。
      if (shouldStop?.()) { report.stopped = true; return report }
```

4. 所有 `onProgress?.(report.processed, all.length)` 改为 `onProgress?.(report.processed, all.length, report.discarded)`(共 3 处:跳过组、批失败 catch、批末)。

- [ ] **Step 4: 跑测试确认绿**

Run: `bun test tests/rescan.test.ts`
Expected: PASS(7 个用例)

- [ ] **Step 5: typecheck + 全量回归 + commit**

Run: `bun run typecheck && bun test`
Expected: 全绿(server.ts 里旧的两参 onProgress 调用仍兼容——第 3 参可选,调用方少传不错)。

```bash
git add src/memory/rescan.ts tests/rescan.test.ts
git commit -m "feat(rescan): 批边界取消 + 实时判丢计数 + report.stopped"
```

---

### Task 2: server rescanState 扩展 + cancel 端点 + 崩溃错误透传

**Files:**
- Modify: `src/server.ts`(rescanState 约 334-393 行)
- Test: `tests/server.test.ts`(Task 7 区块约 750-801 行之后追加)

**Interfaces:**
- Consumes: Task 1 的 `rescanCandidates(db, deps, onProgress, shouldStop)` 与新 `RescanReport`。
- Produces(Task 3/4 依赖,经 GET /api/status 下发):
  - `status.rescan = { running, done, total, discarded, stopping, cancelRequested, report, error }`
  - `report` 含 `stopped: boolean`;`error: string | null` 为运行级崩溃信息。
  - `POST /api/rescan/cancel`:running → 202 `{ stopping: true }`;未在跑 → 409 `{ error: 'no rescan running' }`。

- [ ] **Step 1: 写失败测试(红)**

`tests/server.test.ts` 先改既有「202 fire-and-forget」用例(约 771 行)的报告断言:

```ts
  expect(st.rescan.report).toEqual({ processed: 0, discarded: 0, skipped: 0, keptUpdated: 0, stopped: false })
  // 新字段随 status 下发(老 UI 忽略,新 UI 依赖)
  expect(st.rescan.discarded).toBe(0)
  expect(st.rescan.stopping).toBe(false)
  expect(st.rescan.error).toBeNull()
```

文件末尾(Task 7 区块之后)追加:

```ts
// --- 回扫取消与崩溃透传(spec 2026-08-07 §3.2/§3.3) --------------------------
// 回归防护:停止粒度=批边界——cancel 只置标记,正在判的批照常判完;运行级崩溃
// 必须落 rescan.error(UI 红字可见),不得静默解锁按钮。
test('POST /api/rescan/cancel 未在跑 -> 409', async () => {
  app = createApp({
    db, adapter, opencodeAdapter,
    enqueueDistillJob: async () => ({ jobId: 'j', nextRunAt: 0 }),
    broadcast: () => {},
    callLLM: async () => '{"verdicts": []}',
  })
  const r = await req('/api/rescan/cancel', { method: 'POST' })
  expect(r.status).toBe(409)
  expect(r.body.error).toBe('no rescan running')
})

test('POST /api/rescan/cancel 批边界停止:第 2 批前停,stopped=true,stopping 可见', async () => {
  for (let i = 0; i < 20; i++) {
    await createCandidate(db, {
      scopeType: 'project', scopeId: dir, title: `[category:a] 候选${i}`, bodyMd: 'b',
      tags: [], sourceKind: 'conversation', sourceCwd: dir, runtime: 'claude-code', origin: 'agent-observed',
    })
  }
  let onFirstCall: () => void = () => {}
  const firstCall = new Promise<void>((res) => { onFirstCall = res })
  let release: (s: string) => void = () => {}
  const gate = new Promise<string>((res) => { release = res })
  let called = false
  app = createApp({
    db, adapter, opencodeAdapter,
    enqueueDistillJob: async () => ({ jobId: 'j', nextRunAt: 0 }),
    broadcast: () => {},
    callLLM: () => { if (!called) { called = true; onFirstCall() } return gate },
  })
  const r1 = await req('/api/rescan', { method: 'POST' })
  expect(r1.status).toBe(202)
  await firstCall  // 第 1 批判定已开始(默认质量模式,agent 循环首轮 LLM)
  const rc = await req('/api/rescan/cancel', { method: 'POST' })
  expect(rc.status).toBe(202)
  expect(rc.body.stopping).toBe(true)
  expect((await req('/api/status')).body.rescan.stopping).toBe(true)
  release('{"final": {"verdicts": []}}')  // 放行:第 1 批判完(全留),随后批边界停止
  let st = (await req('/api/status')).body
  for (let i = 0; i < 200 && st.rescan.running; i++) {
    await new Promise((r2) => setTimeout(r2, 10))
    st = (await req('/api/status')).body
  }
  expect(st.rescan.running).toBe(false)
  expect(st.rescan.report.stopped).toBe(true)
  expect(st.rescan.report.processed).toBe(15)
})

test('POST /api/rescan 运行级崩溃 -> status.rescan.error 可见(不静默解锁)', async () => {
  await createCandidate(db, {
    scopeType: 'project', scopeId: dir, title: '[category:a] 一条', bodyMd: 'b',
    tags: [], sourceKind: 'conversation', sourceCwd: dir, runtime: 'claude-code', origin: 'agent-observed',
  })
  // 只让 insert 抛错(合成 job 落库即崩,/api/status 只 select 不受影响)
  const brokenDb = new Proxy(db, {
    get: (t, p, r) => (p === 'insert'
      ? () => { throw new Error('boom-insert') }
      : Reflect.get(t, p, r)),
  })
  app = createApp({
    db: brokenDb as typeof db, adapter, opencodeAdapter,
    enqueueDistillJob: async () => ({ jobId: 'j', nextRunAt: 0 }),
    broadcast: () => {},
    callLLM: async () => '{"verdicts": []}',
  })
  const r = await req('/api/rescan', { method: 'POST' })
  expect(r.status).toBe(202)
  let st = (await req('/api/status')).body
  for (let i = 0; i < 100 && st.rescan.running; i++) {
    await new Promise((r2) => setTimeout(r2, 10))
    st = (await req('/api/status')).body
  }
  expect(st.rescan.running).toBe(false)
  expect(st.rescan.error).toContain('boom-insert')
})
```

- [ ] **Step 2: 跑测试确认红**

Run: `bun test tests/server.test.ts`
Expected: FAIL——`/api/rescan/cancel` 404;`st.rescan.discarded/stopping/error` undefined。

- [ ] **Step 3: 实现**

`src/server.ts` rescanState 与两个端点:

```ts
  // 回扫状态(单实例,随 createApp 闭包;fire-and-forget 与 distill loop 同款)。
  // running 期间重按 -> 409;进度(done/total/discarded)、停止标记(stopping/
  // cancelRequested)、完成报告与运行级崩溃 error 经 GET /api/status 暴露。
  let rescanState: {
    running: boolean; done: number; total: number; discarded: number
    stopping: boolean; cancelRequested: boolean
    report: RescanReport | null; error: string | null
  } = { running: false, done: 0, total: 0, discarded: 0, stopping: false, cancelRequested: false, report: null, error: null }
```

POST /api/rescan 主体改为:

```ts
  app.post('/api/rescan', (c) => {
    if (rescanState.running) return c.json({ error: 'rescan already running' }, 409)
    if (!deps.callLLM) return c.json({ error: 'rescan unavailable: no LLM configured' }, 503)
    const callLLM = deps.callLLM
    rescanState = {
      running: true, done: 0, total: 0, discarded: 0,
      stopping: false, cancelRequested: false, report: null, error: null,
    }
    void (async () => {
      try {
        const report = await rescanCandidates(deps.db, {
          callLLM,
          loadJudgeConfig: () => loadJudgeConfig(deps.db),
        },
        (done, total, discarded) => {
          rescanState.done = done; rescanState.total = total; rescanState.discarded = discarded
        },
        () => rescanState.cancelRequested)  // 批边界停止(spec §3.2)
        rescanState.report = report
      } catch (e) {
        console.warn('memside: rescan failed', e)
        rescanState.error = String(e)  // 崩溃透传:UI 红字可见,不静默解锁
      } finally {
        rescanState.running = false
        rescanState.stopping = false
        rescanState.cancelRequested = false
        deps.broadcast({ type: 'rescan' })
      }
    })()
    return c.json({ started: true }, 202)
  })

  // 回扫取消(spec §3.2):只置标记,粒度=批边界——正在判的批照常判完落库,
  // 后续批次不再开始;未在跑 409(UI 忽略,轮询自愈)。
  app.post('/api/rescan/cancel', (c) => {
    if (!rescanState.running) return c.json({ error: 'no rescan running' }, 409)
    rescanState.cancelRequested = true
    rescanState.stopping = true
    return c.json({ stopping: true }, 202)
  })
```

- [ ] **Step 4: 跑测试确认绿**

Run: `bun test tests/server.test.ts`
Expected: PASS

- [ ] **Step 5: typecheck + 全量回归 + commit**

Run: `bun run typecheck && bun test`

```bash
git add src/server.ts tests/server.test.ts
git commit -m "feat(server): 回扫取消端点 + 实时判丢/停止/崩溃透传"
```

---

### Task 3: api.ts 类型与 cancelRescan + JudgeSettings 模式卡片重写

**Files:**
- Modify: `src/web/api.ts`
- Modify: `src/web/App.tsx`(`JudgeSettings` 约 487-565 行,整体替换)
- Test: `tests/web-ui.test.ts`

**Interfaces:**
- Consumes: Task 2 的 status.rescan 形状与 `POST /api/rescan/cancel`。
- Produces(Task 4 依赖):
  - `RescanReportDto { processed; discarded; skipped; keptUpdated; stopped: boolean }`
  - `RescanState { running; done; total; discarded?: number; stopping?: boolean; cancelRequested?: boolean; report: RescanReportDto | null; error?: string | null }`
  - `cancelRescan(fetchFn?): Promise<void>`——409 静默返回(未在跑,轮询自愈),其余非 ok 抛错。

- [ ] **Step 1: 写失败测试(红)**

`tests/web-ui.test.ts` 末尾追加:

```ts
// 回归防护(spec 2026-08-07 §3.1):判定设置区必须让人看懂——模式卡片带后果说明、
// 预算字段完整中文 label + 「不会误丢」附注、预算段仅质量模式显示、保存行有
// 「有未保存修改」脏提示。源码文本断言,refactor 删除即变红。
test('JudgeSettings 模式卡片 + 人话说明(source text)', () => {
  const s = readFileSync(join(import.meta.dir, '..', 'src', 'web', 'App.tsx'), 'utf8')
  expect(s).toContain('每条候选记忆进审批队列前')
  expect(s).toContain('质量模式(默认)')
  expect(s).toContain('经济模式')
  expect(s).toContain('亲手搜代码、读文件查证后再判决')
  expect(s).toContain('不会误丢有用的')
})

test('JudgeSettings 预算段:完整 label + 附注 + 仅质量模式显示(source text)', () => {
  const s = readFileSync(join(import.meta.dir, '..', 'src', 'web', 'App.tsx'), 'utf8')
  expect(s).toContain('查证次数上限')
  expect(s).toContain('查证时间上限(秒)')
  expect(s).toContain('查满就用已有信息直接判决')
  expect(s).toContain('不会误丢')
  expect(s).toContain("mode === 'quality'")  // 预算段条件渲染
  expect(s).toContain('有未保存修改')
  expect(s).toContain('已保存,立即生效')
})

test('api.ts cancelRescan 走 /api/rescan/cancel + 409 静默(source text)', () => {
  const s = readFileSync(join(import.meta.dir, '..', 'src', 'web', 'api.ts'), 'utf8')
  expect(s).toContain('/api/rescan/cancel')
  expect(s).toContain('export async function cancelRescan')
  expect(s).toContain('res.status === 409')
})
```

- [ ] **Step 2: 跑测试确认红**

Run: `bun test tests/web-ui.test.ts`
Expected: FAIL

- [ ] **Step 3: api.ts 实现**

`src/web/api.ts`:

```ts
export interface RescanReportDto { processed: number; discarded: number; skipped: number; keptUpdated: number; stopped: boolean }

export interface RescanState {
  running: boolean
  done: number
  total: number
  /** 实时累计判丢数;老 daemon 无此字段。 */
  discarded?: number
  /** 已请求停止(批边界停);老 daemon 无此字段。 */
  stopping?: boolean
  cancelRequested?: boolean
  report: RescanReportDto | null
  /** 运行级崩溃信息;老 daemon 无此字段。 */
  error?: string | null
}
```

`startRescan` 之后追加:

```ts
/** POST /api/rescan/cancel — 批边界停止(spec 2026-08-07 §3.2):只置标记,
 * 正在判的批照常判完。409(未在跑)静默返回——轮询自愈,不算错误。 */
export async function cancelRescan(fetchFn: FetchLike = fetch): Promise<void> {
  const res = await fetchFn('/api/rescan/cancel', { method: 'POST' })
  if (res.status === 409) return
  if (!res.ok) {
    const data = (await res.json()) as { error?: string }
    throw new Error(data.error ?? `cancel failed (${res.status})`)
  }
}
```

- [ ] **Step 4: JudgeSettings 整体替换**

`src/web/App.tsx` 的 `JudgeSettings`(注释头 + 函数整体)替换为:

```tsx
/**
 * 判定设置区块(spec 2026-08-07 §3.1)。模式卡片(radio 语义,带后果说明)+
 * 预算段(仅质量模式显示,完整中文 label)+ 保存行聚合(输入框初值=生效值,
 * 改动显「有未保存修改」)。fetch/保存失败显错误,不静默。scheduler 每 tick 现读,
 * UI 改动即时生效不重启 daemon。
 */
function JudgeSettings() {
  const [cfg, setCfg] = useState<JudgeConfigDto | null>(null)
  const [mode, setMode] = useState<'quality' | 'economy'>('quality')
  const [maxRounds, setMaxRounds] = useState('30')
  const [timeBudgetS, setTimeBudgetS] = useState('300')
  const [msg, setMsg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = async () => {
    try {
      const c = await fetchJudgeConfig()
      setCfg(c)
      setMode(c.mode)
      setMaxRounds(String(c.maxRounds))
      setTimeBudgetS(String(c.timeBudgetS))
      setError(null)
    }
    catch (e) { setError(String(e)) } // fetch 失败显错误（不静默）
  }
  useEffect(() => { void refresh() }, [])

  const onSave = async () => {
    setBusy(true); setMsg(null)
    try {
      const c = await saveJudgeConfig({
        mode,
        maxRounds: Number(maxRounds),
        timeBudgetS: Number(timeBudgetS),
      })
      setCfg(c)
      setMode(c.mode)
      setMaxRounds(String(c.maxRounds))
      setTimeBudgetS(String(c.timeBudgetS))
      setMsg('已保存,立即生效')
    } catch (e) { setMsg(`保存失败: ${e}`) }
    finally { setBusy(false) }
  }

  const dirty = cfg !== null && (
    mode !== cfg.mode
    || Number(maxRounds) !== cfg.maxRounds
    || Number(timeBudgetS) !== cfg.timeBudgetS)

  return (
    <section style={{ margin: '12px 0', padding: 12, border: '1px solid #ddd', borderRadius: 8 }}>
      <h3 style={{ margin: '0 0 8px' }}>判定</h3>
      <p style={{ margin: '0 0 10px', fontSize: 13, color: '#666' }}>
        每条候选记忆进审批队列前,AI 先判一遍值不值得记;被判丢的直接进「AI自动拒绝」,可恢复。
      </p>
      {error ? <div style={{ color: '#b00', marginBottom: 8 }}>设置加载失败: {error}</div> : null}
      {/* 模式卡片:radio 语义,选中高亮边框,带后果说明 */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <div onClick={() => setMode('quality')}
          style={{
            flex: '1 1 260px', cursor: 'pointer', padding: 10, borderRadius: 8, fontSize: 13,
            border: mode === 'quality' ? '2px solid #222' : '1px solid #ddd',
            background: mode === 'quality' ? '#fafafa' : '#fff',
          }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            <input type="radio" checked={mode === 'quality'} onChange={() => setMode('quality')} style={{ marginRight: 6 }} />
            质量模式(默认)
          </div>
          <div style={{ color: '#666' }}>
            AI 会打开候选来源的项目仓库,亲手搜代码、读文件查证后再判决。判得准,但慢、费 token。
          </div>
        </div>
        <div onClick={() => setMode('economy')}
          style={{
            flex: '1 1 260px', cursor: 'pointer', padding: 10, borderRadius: 8, fontSize: 13,
            border: mode === 'economy' ? '2px solid #222' : '1px solid #ddd',
            background: mode === 'economy' ? '#fafafa' : '#fff',
          }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            <input type="radio" checked={mode === 'economy'} onChange={() => setMode('economy')} style={{ marginRight: 6 }} />
            经济模式
          </div>
          <div style={{ color: '#666' }}>
            AI 只看候选文字本身,一次出判决,不查仓库。快、省 token;拿不准时倾向把候选留下(不会误丢有用的)。
          </div>
        </div>
      </div>
      {/* 预算段:仅质量模式显示(经济模式不跑 agent,预算无意义) */}
      {mode === 'quality' ? (
        <div style={{ marginBottom: 8 }}>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 6 }}>
            <label style={{ fontSize: 13 }}>
              查证次数上限
              <input type="number" min={1} max={200} value={maxRounds}
                onChange={(e) => setMaxRounds(e.target.value)}
                style={{ display: 'block', marginTop: 4, width: 120 }} />
              <span style={{ display: 'block', marginTop: 4, color: '#888', fontSize: 12, maxWidth: 240 }}>
                每批 15 条候选,AI 最多动手查多少次;查满就用已有信息直接判决。
              </span>
            </label>
            <label style={{ fontSize: 13 }}>
              查证时间上限(秒)
              <input type="number" min={30} max={3600} value={timeBudgetS}
                onChange={(e) => setTimeBudgetS(e.target.value)}
                style={{ display: 'block', marginTop: 4, width: 120 }} />
              <span style={{ display: 'block', marginTop: 4, color: '#888', fontSize: 12, maxWidth: 240 }}>
                每批最多花多少秒,超时同上。
              </span>
            </label>
          </div>
          <div style={{ fontSize: 12, color: '#888' }}>预算耗尽或出任何故障,结果都是「保留」,不会误丢。</div>
        </div>
      ) : null}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button disabled={busy} onClick={() => void onSave()}>保存</button>
        {busy ? <span style={{ color: '#888' }}>处理中…</span> : null}
        {!busy && dirty ? <span style={{ color: '#b80', fontSize: 13 }}>有未保存修改</span> : null}
        {msg ? <span style={{ color: msg.includes('失败') ? '#b00' : '#080' }}>{msg}</span> : null}
      </div>
    </section>
  )
}
```

- [ ] **Step 5: 跑测试确认绿**

Run: `bun test tests/web-ui.test.ts`
Expected: PASS

- [ ] **Step 6: typecheck + 全量回归 + commit**

Run: `bun run typecheck && bun test`

```bash
git add src/web/api.ts src/web/App.tsx tests/web-ui.test.ts
git commit -m "feat(settings-ui): 判定设置改模式卡片 + 条件预算段 + 脏提示"
```

---

### Task 4: 回扫工具栏重写——进度条 + 停止 + 结果卡片

**Files:**
- Modify: `src/web/ui-utils.ts`(加纯函数 `rescanPercent`)
- Modify: `src/web/App.tsx`(candidate tab 工具栏约 273-295 行 + 顶部 rescan() 函数区)
- Test: `tests/ui-utils.test.ts`、`tests/web-ui.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `RescanState`、`cancelRescan()`。
- Produces:
  - `rescanPercent(done: number, total: number): number`(ui-utils 纯函数)
  - App 内:`const rs = status?.rescan`、停止按钮、`setTab('discards')` 跳转(既有 setTab)。

- [ ] **Step 1: 写失败测试(红)**

`tests/ui-utils.test.ts` 追加(import 行加 `rescanPercent`):

```ts
// 回扫进度条百分比(spec 2026-08-07 §3.2):total=0 -> 0;上限夹取 100。
test('rescanPercent: 百分比计算与夹取', () => {
  expect(rescanPercent(0, 0)).toBe(0)
  expect(rescanPercent(0, 734)).toBe(0)
  expect(rescanPercent(367, 734)).toBe(50)
  expect(rescanPercent(734, 734)).toBe(100)
  expect(rescanPercent(800, 734)).toBe(100)  // 夹取:不得超过 100
})
```

`tests/web-ui.test.ts`:
1. 改既有用例(约 219-230 行,旧文案「回扫存量」「回扫中」已不存在)——把该用例整体替换为以下三个自包含用例(各用例内局部 readFileSync,与该文件既有惯例一致):

```ts
// 回归防护(spec 2026-08-07 §3.2):回扫工具栏必须让人看懂——按钮说清干什么、
// 跑动中进度条 + 实时判丢数 + 停止按钮、结束有结果卡片且能跳 discards。
test('App.tsx 候选 tab 回扫:按钮文案 + 说明行 + 进度条 + 停止(source text)', () => {
  const appSrc = readFileSync(join(import.meta.dir, '..', 'src', 'web', 'App.tsx'), 'utf8')
  expect(appSrc).toContain('重新筛查全部候选')
  expect(appSrc).toContain('停止筛查')
  expect(appSrc).toContain('正在停止(当前这批判完即停)')
  expect(appSrc).toContain('把候选队列按当前判定模式全部重判一遍')
  expect(appSrc).toContain('已判丢')
  expect(appSrc).toContain('rescanPercent(')  // 进度条走纯函数
  expect(appSrc).toContain('回扫失败')
  expect(appSrc).toContain('/api/rescan')  // 按钮注释锚定端点
})

test('App.tsx 回扫结果卡片:计数 + 停止标题 + 跳 discards(source text)', () => {
  const appSrc = readFileSync(join(import.meta.dir, '..', 'src', 'web', 'App.tsx'), 'utf8')
  expect(appSrc).toContain('筛查完成')
  expect(appSrc).toContain('条未筛查')
  expect(appSrc).toContain('保留')
  expect(appSrc).toContain('目录已删除的项目')
  expect(appSrc).toContain('查看判丢的')
  expect(appSrc).toContain("setTab('discards')")
})

test('api.ts RescanState 带 discarded/stopping/error 可选字段 + /api/rescan(source text)', () => {
  const apiSrc = readFileSync(join(import.meta.dir, '..', 'src', 'web', 'api.ts'), 'utf8')
  expect(apiSrc).toContain('/api/rescan')
  expect(apiSrc).toContain('discarded?: number')
  expect(apiSrc).toContain('stopping?: boolean')
  expect(apiSrc).toContain('error?: string | null')
})
```

2. `readFileSync`/`join` 在该文件顶部已 import,直接用。

- [ ] **Step 2: 跑测试确认红**

Run: `bun test tests/web-ui.test.ts tests/ui-utils.test.ts`
Expected: FAIL

- [ ] **Step 3: ui-utils.ts 加纯函数**

```ts
/**
 * 回扫进度条百分比(0-100,整数)。total<=0 -> 0(未开始/空队列不显示 NaN);
 * 上限夹取 100(回调乱序不得撑破进度条)。纯函数,可单测。
 *
 * 设计依据:docs/superpowers/specs/2026-08-07-judge-rescan-ux-design.md §3.2。
 */
export function rescanPercent(done: number, total: number): number {
  if (total <= 0) return 0
  return Math.min(100, Math.round((done / total) * 100))
}
```

- [ ] **Step 4: App.tsx 工具栏替换**

App 组件内 import 行补 `rescanPercent`、`cancelRescan`;`rescan()` 函数不变;在 `const showLoading = ...` 附近加:

```tsx
  // 回扫状态缩写(spec 2026-08-07 §3.2):rs 驱动进度条/停止按钮/结果卡片。
  const rs = status?.rescan
  const rsPct = rescanPercent(rs?.done ?? 0, rs?.total ?? 0)
```

candidate tab 工具栏(旧 `<div style={{ display: 'flex', gap: 8, marginBottom: 12, ... }}>` 整块,含旧回扫按钮/进度行/报告行/错误行)替换为:

```tsx
          <div style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              {memItems.some((m) => priorityRank(m.valueClass) === 2) ? (
                <button onClick={() => bulkRejectUnevaluated()}>
                  批量拒绝未评估
                </button>
              ) : null}
              {/* 回扫端点 /api/rescan(开始)与 /api/rescan/cancel(批边界停止) */}
              {rs?.running ? (
                <button onClick={() => void cancelRescan().catch(() => {})}>
                  停止筛查
                </button>
              ) : (
                <button onClick={() => rescan()}>重新筛查全部候选</button>
              )}
              {rs?.running && rs?.stopping ? (
                <span style={{ fontSize: 13, color: '#b80' }}>正在停止(当前这批判完即停)…</span>
              ) : null}
            </div>
            <div style={{ fontSize: 12, color: '#888', margin: '6px 0' }}>
              把候选队列按当前判定模式全部重判一遍,判丢的进「AI自动拒绝」,可恢复。
            </div>
            {rs?.running ? (
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 8 }}>
                <div style={{ width: 240, height: 10, background: '#eee', borderRadius: 5, overflow: 'hidden' }}>
                  <div style={{ width: `${rsPct}%`, height: '100%', background: '#222', transition: 'width .3s' }} />
                </div>
                <span style={{ fontSize: 13, color: '#666' }}>
                  已处理 {rs.done}/{rs.total}({rsPct}%) · 已判丢 {rs.discarded ?? 0} 条
                </span>
              </div>
            ) : null}
            {!rs?.running && rs?.report ? (
              <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 10, marginBottom: 8, fontSize: 13, background: '#fafafa' }}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>
                  {rs.report.stopped
                    ? `已停止(剩余 ${rs.total - rs.report.processed} 条未筛查)`
                    : '筛查完成'}
                </div>
                <div>
                  处理 {rs.report.processed} · 判丢 {rs.report.discarded} · 保留 {rs.report.keptUpdated} · 跳过 {rs.report.skipped}(目录已删除的项目)
                </div>
                {rs.report.discarded > 0 ? (
                  <button style={{ marginTop: 6, fontSize: 13 }} onClick={() => setTab('discards')}>
                    查看判丢的 {rs.report.discarded} 条 →
                  </button>
                ) : null}
              </div>
            ) : null}
            {rs?.error ? (
              <div style={{ fontSize: 13, color: '#c00' }}>回扫失败: {rs.error}</div>
            ) : null}
            {rescanError ? (
              <span style={{ fontSize: 13, color: '#c00' }}>回扫失败: {rescanError}</span>
            ) : null}
          </div>
```

- [ ] **Step 5: 跑测试确认绿**

Run: `bun test tests/web-ui.test.ts tests/ui-utils.test.ts`
Expected: PASS

- [ ] **Step 6: typecheck + 全量回归 + commit**

Run: `bun run typecheck && bun test`
Expected: 全绿(含既有 663+ 用例回归)

```bash
git add src/web/ui-utils.ts src/web/App.tsx tests/ui-utils.test.ts tests/web-ui.test.ts
git commit -m "feat(rescan-ui): 进度条 + 批边界停止 + 结果卡片跳 discards"
```

---

## 验收清单(终审对照 spec)

- [ ] spec §3.1:JudgeSettings 一句话说明 / 两张模式卡带后果说明 / 预算段仅质量模式 + 完整 label + 「不会误丢」附注 / 保存行聚合(无独立回显行,有脏提示)
- [ ] spec §3.2:按钮「重新筛查全部候选」+ 常驻说明行 / 真进度条(百分比+计数)/ 实时已判丢 / 「停止筛查」+「正在停止」提示 / 结果卡片(完成或已停止)+ 跳 discards 链接(discarded=0 不显示)
- [ ] spec §3.3:rescanState 含 discarded/stopping/cancelRequested/error;report 加 stopped(既有字段不改名);cancel 端点 202/409;崩溃 error 透传;进度走 /api/status 轮询(无新广播)
- [ ] spec §4:四条测试策略全部落地;既有 rescan/server/web-ui 用例全绿
- [ ] 判定逻辑零改动:`git diff master -- src/memory/agentJudge.ts src/memory/agentLoop.ts src/memory/valueFilter.ts src/memory/judgeConfig.ts src/memory/repoTools.ts` 为空

import { useEffect, useRef, useState } from 'react'
import {
  listMemories, promoteMemory, patchMemory, getStatus, bulkPromote, getSourceInput,
  listDiscards, restoreMemory, archiveMemory, unarchiveMemory, promoteDiscard,
  listDistillRuns, getDistillRun, getDistillRunSourceInput,
  getLlmSettings, saveLlmSettings, testLlmConnection,
  type MemoryItem, type MemsideStatus, type SourceInput, type SourceTurn, type DiscardItem,
  type DistillRunListItem, type LlmSettingsState,
} from './api'
import { formatMemoryTime, sortCandidatesByTime, formatSourceTurn, formatOutcome, formatRunCounts, llmSourceLabel, originBadge, discardReasonLabel } from './ui-utils'

/**
 * valueClass -> 中文徽标 / 优先级排序。模块顶层定义以便 MemoryCard 直接复用
 * valueBadge,不必经 props 透传。
 *
 * 6 筐优先级:user-rule/decision=高(0),preference/convention/trap/topology=中(1),
 * null=未评估(2)。候选队列按此排序,高价值先审;未评估条目可一键批量拒绝。
 * 出处驱动的价值判定（2026-07-30）扩 6 筐。
 */
const VALUE_LABEL: Record<string, string> = {
  'user-rule': '高·规矩', decision: '高·决策',
  preference: '中·偏好', convention: '中·约定', trap: '中·陷阱', topology: '中·拓扑',
}
function valueBadge(vc: string | null | undefined): string {
  return vc && VALUE_LABEL[vc] ? VALUE_LABEL[vc] : '未评估'
}
function priorityRank(vc: string | null | undefined): number {
  if (vc === 'user-rule' || vc === 'decision') return 0
  if (vc && VALUE_LABEL[vc]) return 1
  return 2
}

type TabKey = 'candidate' | 'approved' | 'rejected' | 'discards' | 'runs'

/**
 * 4-tab 审计视图。顶部 tab 切换:候选审批 / 已审批 / 已拒绝 / AI自动拒绝。每 tab
 * 独立数据源 + 操作 + 3s 轮询;切 tab 清旧 interval 建新的(useEffect 依赖 tab)。
 * 候选 tab 仍同时拉 status;其余 tab 也拉 status(计数徽标 + 状态栏)。
 *
 * 状态栏(后台可见性)保持不动:已捕获事件 / distill 进行中 / 最近错误,让用户
 * 看到 daemon 在干活。fetch 失败显错误 banner,切 tab 显「加载中…」,空列表显
 * 对应文案,不静默 stall 出白页。
 *
 * 操作契约:no-throw(Task 7 carried finding)。restoreMemory/archiveMemory/
 * unarchiveMemory/promoteDiscard 不检查 res.ok,server 404/409 时返回 undefined。
 * UI 层不 catch,操作后调 refresh() 让列表自然更新(成功的会移动/消失,失败的因
 * 状态没变会留下),与现有 approve/reject 同模式。
 */
export default function App() {
  const [tab, setTab] = useState<TabKey>('candidate')
  const [items, setItems] = useState<MemoryItem[]>([])
  const [discards, setDiscards] = useState<DiscardItem[]>([])
  const [status, setStatus] = useState<MemsideStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sourceInputFor, setSourceInputFor] = useState<string | null>(null)
  const [runs, setRuns] = useState<DistillRunListItem[]>([])
  const [runDetailFor, setRunDetailFor] = useState<string | null>(null)

  // tabRef 始终指向最新 tab,用于丢弃切 tab 后才返回的过期 fetch 结果,避免旧 tab
  // 数据短暂覆盖新 tab 列表(stale-write 竞态)。
  const tabRef = useRef(tab)
  tabRef.current = tab

  async function refresh() {
    // 捕获调用时的 tab;若切 tab 后此 fetch 才返回,tabRef.current 已变,丢弃结果。
    const myTab = tab
    try {
      if (myTab === 'discards') {
        const [ds, st] = await Promise.all([listDiscards(), getStatus()])
        if (tabRef.current !== myTab) return
        setDiscards(ds)
        setStatus(st)
      } else if (myTab === 'runs') {
        const [runItems, st] = await Promise.all([listDistillRuns(fetch), getStatus(fetch)])
        if (tabRef.current !== myTab) return
        setRuns(runItems)
        setStatus(st)
      } else {
        const filter = myTab === 'candidate'
          ? 'candidate'
          : myTab === 'approved'
            ? 'approved,archived,superseded'
            : 'rejected'
        const [mems, st] = await Promise.all([listMemories(fetch, filter), getStatus()])
        if (tabRef.current !== myTab) return
        setItems(mems)
        setStatus(st)
      }
      setError(null)
    } catch (e) {
      if (tabRef.current !== myTab) return
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (tabRef.current === myTab) setLoading(false)
    }
  }

  // 切 tab:重置视图状态(清旧列表 + 加载中 + 清错误)→ 立即 refresh → 建 3s 轮询。
  // cleanup 清旧 interval,无轮询泄漏。依赖 [tab],切 tab 才重建。
  useEffect(() => {
    setItems([])
    setDiscards([])
    setRuns([])
    setLoading(true)
    setError(null)
    void refresh()
    const t = setInterval(() => void refresh(), 3000)
    return () => clearInterval(t)
  }, [tab])

  async function approve(id: string) {
    await promoteMemory(id, { action: 'approve' })
    void refresh()
  }
  async function reject(id: string) {
    await promoteMemory(id, { action: 'reject' })
    void refresh()
  }
  async function edit(id: string, title: string, bodyMd: string, scopeType: 'project' | 'global', subjectSlug: string | null) {
    await patchMemory(id, { title, bodyMd, scopeType, subjectSlug })
    void refresh()
  }
  async function archive(id: string) {
    await archiveMemory(id)
    void refresh()
  }
  async function unarchive(id: string) {
    await unarchiveMemory(id)
    void refresh()
  }
  async function restore(id: string) {
    await restoreMemory(id)
    void refresh()
  }
  async function promote(id: string) {
    await promoteDiscard(id)
    void refresh()
  }

  async function bulkRejectUnevaluated() {
    const ids = items
      .filter((i) => i.status === 'candidate' && priorityRank(i.valueClass) === 2)
      .map((i) => i.id)
    if (ids.length === 0) return
    await bulkPromote(ids, 'reject')
    void refresh()
  }

  // 记忆列表按 createdAt 倒序(newest first)。items 在 candidate/approved/rejected
  // tab 分别是对应 status 的子集(server 已过滤),客户端再排一次保证顺序一致。
  const memItems = sortCandidatesByTime(items)
  const jobs = status?.jobs ?? {}
  const running = (jobs.running ?? 0) + (jobs.pending ?? 0)
  const listEmpty = tab === 'discards' ? discards.length === 0 : tab === 'runs' ? runs.length === 0 : memItems.length === 0

  const tabs: ReadonlyArray<{ key: TabKey; label: string; count: number }> = [
    { key: 'candidate', label: '候选审批', count: status?.memories.candidate ?? 0 },
    { key: 'approved', label: '已审批', count: (status?.memories.approved ?? 0) + (status?.memories.archived ?? 0) + (status?.memories.superseded ?? 0) },
    { key: 'rejected', label: '已拒绝', count: status?.memories.rejected ?? 0 },
    { key: 'discards', label: 'AI自动拒绝', count: status?.discards ?? 0 },
    { key: 'runs', label: '蒸馏记录', count: status?.distillRuns?.total ?? 0 },
  ]

  return (
    <div style={{ fontFamily: 'system-ui', maxWidth: 900, margin: '0 auto', padding: 24 }}>
      <h1>memside · 审批队列</h1>

      {/* tab 栏 - 4 审计视图,active 高亮,计数徽标来自 status */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        {tabs.map((t) => {
          const active = t.key === tab
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              style={{
                padding: '8px 14px',
                borderRadius: 8,
                border: '1px solid #e0e0e0',
                background: active ? '#222' : '#f5f5f5',
                color: active ? '#fff' : '#444',
                cursor: 'pointer',
                fontSize: 14,
              }}
            >
              {t.label}
              <span style={{ marginLeft: 6, fontSize: 12, opacity: 0.85 }}>{t.count}</span>
            </button>
          )
        })}
      </div>

      {/* 状态栏 - 后台可见性 */}
      <div
        style={{
          background: '#f5f5f5',
          border: '1px solid #e0e0e0',
          borderRadius: 8,
          padding: 12,
          marginBottom: 16,
          fontSize: 13,
          color: '#444',
        }}
      >
        {status ? (
          <>
            <span>
              已捕获事件 <b>{status.events}</b>
            </span>
            {' · '}
            <span>
              distill: <b>{running > 0 ? `${running} 进行中` : '空闲'}</b>
            </span>
            {jobs.done ? (
              <>
                {' · '}
                <span>完成 {jobs.done}</span>
              </>
            ) : null}
            {jobs.failed ? (
              <>
                {' · '}
                <span style={{ color: '#c00' }}>失败 {jobs.failed}</span>
              </>
            ) : null}
            {' · '}
            <span>
              记忆: {status.memories.candidate ?? 0} 待审 / {status.memories.approved ?? 0} 已批准
            </span>
            {status.lastError ? (
              <div style={{ marginTop: 6, color: '#c00' }}>
                最近错误: {String(status.lastError.error).slice(0, 160)}
              </div>
            ) : null}
          </>
        ) : error ? (
          <span style={{ color: '#c00' }}>连不上 daemon</span>
        ) : (
          <span>读取状态中…</span>
        )}
      </div>

      {/* LLM 设置区块 - 生效回显行 + 保存/测试连接/清除 */}
      <LlmSettings />

      {error ? (
        <div
          style={{
            background: '#fee',
            border: '1px solid #c00',
            borderRadius: 8,
            padding: 12,
            marginBottom: 16,
            color: '#c00',
          }}
        >
          连不上 daemon(端口 7777)。确认 daemon 在跑:<code> bun run src/cli.ts start</code>。错误: {error}
        </div>
      ) : null}

      {/* 列表 - 按 tab 渲染对应数据 + 操作;加载中 / 空 / 错误三态不静默 stall */}
      {error ? null : loading && listEmpty ? (
        <p>加载中…</p>
      ) : tab === 'candidate' ? (
        <>
          <p>{memItems.length} 条候选记忆待审</p>
          {memItems.some((m) => priorityRank(m.valueClass) === 2) ? (
            <button onClick={() => bulkRejectUnevaluated()} style={{ marginBottom: 12 }}>
              批量拒绝未评估
            </button>
          ) : null}
          {memItems.map((m) => (
            <MemoryCard
              key={m.id}
              m={m}
              onApprove={() => approve(m.id)}
              onReject={() => reject(m.id)}
              onEdit={(t, b, s, slug) => edit(m.id, t, b, s, slug)}
              onViewSource={() => setSourceInputFor(m.id)}
            />
          ))}
          {memItems.length === 0 && !loading && (
            <p style={{ color: '#666' }}>
              暂无候选记忆。结束一个 claude code 会话后,后台会异步提炼(distill 约 15-30s),候选记忆会自动出现在这里。上方状态栏可看后台进度。
            </p>
          )}
        </>
      ) : tab === 'approved' ? (
        <>
          <p>{memItems.length} 条已审批记忆</p>
          {memItems.map((m) => (
            <MemoryCard
              key={m.id}
              m={m}
              readOnlyReason={m.status === 'superseded' ? '已被取代' : undefined}
              onArchive={m.status === 'approved' ? () => archive(m.id) : undefined}
              onUnarchive={m.status === 'archived' ? () => unarchive(m.id) : undefined}
            />
          ))}
          {memItems.length === 0 && !loading && (
            <p style={{ color: '#666' }}>暂无已审批记忆</p>
          )}
        </>
      ) : tab === 'rejected' ? (
        <>
          <p>{memItems.length} 条已拒绝记忆</p>
          {memItems.map((m) => (
            <MemoryCard
              key={m.id}
              m={m}
              onRestore={() => restore(m.id)}
            />
          ))}
          {memItems.length === 0 && !loading && (
            <p style={{ color: '#666' }}>暂无已拒绝记忆</p>
          )}
        </>
      ) : tab === 'runs' ? (
        <div>
          <p>共 {runs.length} 条蒸馏记录</p>
          {runs.map((r) => (
            <DistillRunRow key={r.distillJobId} r={r} onOpen={() => setRunDetailFor(r.distillJobId)} />
          ))}
          {runs.length === 0 && !loading && (
            <p style={{ color: '#666' }}>暂无蒸馏记录</p>
          )}
        </div>
      ) : (
        <>
          <p>{discards.length} 条 AI 自动拒绝记录</p>
          {discards.map((d) => (
            <DiscardCard key={d.id} d={d} onPromote={() => promote(d.id)} />
          ))}
          {discards.length === 0 && !loading && (
            <p style={{ color: '#666' }}>暂无 AI 自动拒绝记录</p>
          )}
        </>
      )}

      {sourceInputFor ? (
        <SourceInputModal memoryId={sourceInputFor} onClose={() => setSourceInputFor(null)} />
      ) : null}

      {runDetailFor ? (
        <DistillRunModal jobId={runDetailFor} onClose={() => setRunDetailFor(null)} />
      ) : null}
    </div>
  )
}

/**
 * LLM 设置区块（spec：状态可见性 + 生效回显硬需求）。
 * 常驻生效回显行：当前生效来源 · baseURL · model · 打码 token。
 * 三输入框 + 保存 / 测试连接 / 清除；token 留空保存 = 保持原值。
 */
function LlmSettings() {
  const [state, setState] = useState<LlmSettingsState | null>(null)
  const [protocol, setProtocol] = useState<'anthropic' | 'openai'>('anthropic')
  const [baseURL, setBaseURL] = useState('')
  const [token, setToken] = useState('')
  const [model, setModel] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = async () => {
    try {
      const s = await getLlmSettings()
      setState(s)
      if (s?.saved?.protocol) setProtocol(s.saved.protocol) // 下拉跟随已存协议
      setError(null)
    }
    catch (e) { setError(String(e)) } // fetch 失败显错误（不静默）
  }
  useEffect(() => { void refresh() }, [])

  const onSave = async () => {
    setBusy(true); setMsg(null)
    try {
      const s = await saveLlmSettings({
        protocol,
        ...(baseURL !== '' ? { baseURL } : {}),
        ...(token !== '' ? { token } : {}),
        ...(model !== '' ? { model } : {}),
      })
      setState(s)
      if (s?.saved?.protocol) setProtocol(s.saved.protocol)
      setToken(''); setMsg('已保存')
    } catch (e) { setMsg(`保存失败: ${e}`) }
    finally { setBusy(false) }
  }
  const onClear = async () => {
    setBusy(true); setMsg(null)
    try { setState(await saveLlmSettings({ clear: true })); setBaseURL(''); setModel(''); setProtocol('anthropic'); setMsg('已清除 UI 配置') }
    catch (e) { setMsg(`清除失败: ${e}`) }
    finally { setBusy(false) }
  }
  const onTest = async () => {
    setBusy(true); setMsg(null)
    try {
      const r = await testLlmConnection({
        protocol,
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
          ? <><b>{llmSourceLabel(eff.source)}</b>{' · '}{eff?.protocol ?? 'anthropic'}{' · '}{eff.baseURL ?? '官方端点'}{' · '}{eff.model ?? '默认模型'}{' · '}token <code>{eff.tokenMasked}</code></>
          : <b>未配置</b>}
      </div>
      {error ? <div style={{ color: '#b00', marginBottom: 8 }}>设置加载失败: {error}</div> : null}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
        <label style={{ fontSize: 13 }}>协议</label>
        <select value={protocol} onChange={(e) => setProtocol(e.target.value as 'anthropic' | 'openai')}
          style={{ flex: '0 0 auto' }}>
          <option value="anthropic">Anthropic</option>
          <option value="openai">OpenAI</option>
        </select>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        <input style={{ flex: '2 1 260px' }} placeholder={state?.saved?.baseURL ?? (protocol === 'openai' ? 'baseURL（OpenAI 格式，拼 /chat/completions）' : 'baseURL（留空=官方端点，拼 /v1/messages）')}
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

/**
 * 通用记忆卡片骨架。操作按钮按 tab 注入(可选回调):候选 tab 传 onApprove/
 * onReject/onEdit/onViewSource(现有行为);已审批 tab 传 onArchive/onUnarchive
 * (按 status 决定显示哪个),superseded 传 readOnlyReason='已被取代' 只读;已拒绝
 * tab 传 onRestore。未提供的回调不渲染对应按钮,保持各 tab 操作集干净。
 */
function MemoryCard({
  m,
  onApprove,
  onReject,
  onEdit,
  onViewSource,
  onArchive,
  onUnarchive,
  onRestore,
  readOnlyReason,
}: {
  m: MemoryItem
  onApprove?: () => void
  onReject?: () => void
  onEdit?: (title: string, bodyMd: string, scopeType: 'project' | 'global', subjectSlug: string | null) => Promise<void>
  onViewSource?: () => void
  onArchive?: () => void
  onUnarchive?: () => void
  onRestore?: () => void
  readOnlyReason?: string
}) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(m.title)
  const [body, setBody] = useState(m.bodyMd ?? '')
  const [scope, setScope] = useState<'project' | 'global'>(m.scopeType === 'project' ? 'project' : 'global')
  const [slug, setSlug] = useState(m.subjectSlug ?? '')
  const [editError, setEditError] = useState<string | null>(null)
  const sourceLabel = m.sourceCwd
    ? (m.sourceCwd.split(/[\\/]/).filter(Boolean).pop() ?? m.sourceCwd)
    : m.sourceKind === 'manual'
      ? '手动'
      : m.runtime === 'opencode'
        ? 'opencode'
        : '未知'
  const time = formatMemoryTime(m.createdAt)
  async function save() {
    setEditError(null)
    try {
      await onEdit?.(title, body, scope, slug.trim() === '' ? null : slug.trim())
      setEditing(false)
    } catch (e) {
      setEditError(e instanceof Error ? e.message : String(e))
    }
  }
  return (
    <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 16, marginBottom: 12 }}>
      {editing && onEdit ? (
        <>
          <div style={{ marginBottom: 8 }}>
            <label style={{ marginRight: 12 }}>
              <input type="radio" checked={scope === 'project'} onChange={() => setScope('project')} /> project
            </label>
            <label>
              <input type="radio" checked={scope === 'global'} onChange={() => setScope('global')} /> global
            </label>
          </div>
          <input value={title} onChange={(e) => setTitle(e.target.value)} style={{ width: '100%', marginBottom: 8 }} />
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} style={{ width: '100%', marginBottom: 8 }} />
          <input
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder="subject slug（kebab-case，可留空）"
            style={{ width: '100%', marginBottom: 8 }}
          />
          <button onClick={save}>保存</button>
          <button onClick={() => setEditing(false)}>取消</button>
          {editError && <div style={{ color: '#c00', fontSize: 12, marginTop: 6 }}>{editError}</div>}
        </>
      ) : (
        <>
          <strong>{m.title}</strong>
          <span style={{ marginLeft: 8, fontSize: 12, color: '#888' }}>{valueBadge(m.valueClass)}</span>
          {(() => { const ob = originBadge(m.origin); return ob ? (
            <span style={{ marginLeft: 8, fontSize: 12, color: ob.color }}>{ob.label}</span>
          ) : null })()}
          {m.subjectSlug ? (
            <span style={{ marginLeft: 8, fontSize: 12, color: '#36c' }}>[{m.subjectSlug}]</span>
          ) : null}
          {m.evidence ? (
            <p style={{ color: '#6a1b9a', fontSize: 13, margin: '4px 0' }}>出处：{m.evidence}</p>
          ) : null}
          {m.bodyMd && <p style={{ color: '#555' }}>{m.bodyMd}</p>}
          <small>
            {m.scopeType} · {m.runtime ?? '任意 runtime'} · 来源: <span title={m.sourceCwd ?? ''}>{sourceLabel}</span>
            {time ? ` · ${time}` : ''}
          </small>
          <div style={{ marginTop: 8 }}>
            {readOnlyReason ? (
              <span style={{ color: '#888', fontSize: 13 }}>{readOnlyReason}</span>
            ) : (
              <>
                {onApprove && (
                  <button onClick={onApprove} style={{ marginRight: 8 }}>
                    批准
                  </button>
                )}
                {onReject && (
                  <button onClick={onReject} style={{ marginRight: 8 }}>
                    拒绝
                  </button>
                )}
                {onArchive && (
                  <button onClick={onArchive} style={{ marginRight: 8 }}>
                    归档
                  </button>
                )}
                {onUnarchive && (
                  <button onClick={onUnarchive} style={{ marginRight: 8 }}>
                    取消归档
                  </button>
                )}
                {onRestore && (
                  <button onClick={onRestore} style={{ marginRight: 8 }}>
                    撤回拒绝
                  </button>
                )}
                {onEdit && <button onClick={() => { setEditError(null); setEditing(true) }}>编辑</button>}
                {onViewSource && m.distillJobId ? (
                  <button onClick={onViewSource} style={{ marginLeft: 8 }}>
                    查看原始输入
                  </button>
                ) : null}
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}

/**
 * AI 自动拒绝记录卡片(discards tab)。展示 title/bodyMd/reason 徽标/来源/时间。
 * promotedMemoryId 非 null -> 已提升为候选,显「已提升」标注并禁用 promote 按钮;
 * 否则显「提升为候选」按钮调 promoteDiscard(no-throw,操作后 refresh 自然更新)。
 */
function DiscardCard({ d, onPromote }: { d: DiscardItem; onPromote: () => void }) {
  const promoted = !!d.promotedMemoryId
  const sourceLabel = d.sourceCwd
    ? (d.sourceCwd.split(/[\\/]/).filter(Boolean).pop() ?? d.sourceCwd)
    : d.sourceKind === 'manual'
      ? '手动'
      : (d.sourceKind ?? '未知')
  const time = formatMemoryTime(d.ts)
  return (
    <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 16, marginBottom: 12 }}>
      <strong>{d.title}</strong>
      <span style={{ marginLeft: 8, fontSize: 12, color: '#c00' }}>{discardReasonLabel(d.reason)}</span>
      {d.bodyMd && <p style={{ color: '#555' }}>{d.bodyMd}</p>}
      <small>
        {d.scopeType ?? '未知 scope'} · 来源: <span title={d.sourceCwd ?? ''}>{sourceLabel}</span>
        {time ? ` · ${time}` : ''}
      </small>
      <div style={{ marginTop: 8 }}>
        {promoted ? (
          <span style={{ color: '#080', fontSize: 13 }}>已提升</span>
        ) : (
          <button onClick={onPromote}>提升为候选</button>
        )}
      </div>
    </div>
  )
}

/**
 * 蒸馏记录列表行(runs tab)。outcome 徽标 + 计数链 + 来源/时间/耗时 + 「查看详情」
 * 按钮（打开 DistillRunModal）。subagent 来源显 'subagent'，否则显 cwd 末段。
 * 复用 formatOutcome / formatRunCounts / formatMemoryTime 纯函数。
 */
function DistillRunRow({ r, onOpen }: { r: DistillRunListItem; onOpen: () => void }) {
  const oc = formatOutcome(r.outcome)
  const cwdLabel = r.cwd ? (r.cwd.split(/[\\/]/).filter(Boolean).pop() ?? r.cwd) : '未知'
  const time = formatMemoryTime(r.createdAt)
  return (
    <div style={{ border: '1px solid #eee', borderRadius: 6, padding: 12, marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ background: oc.color, color: '#fff', borderRadius: 4, padding: '2px 8px', fontSize: 12 }}>{oc.label}</span>
        <span style={{ fontFamily: 'monospace', fontSize: 13 }}>{formatRunCounts({ distilled: r.rawCount, deduped: r.dedupedCount, filtered: r.filteredCount, stored: r.storedCount })}</span>
      </div>
      {r.outcome === 'llm_error' && r.errorMessage && (
        <div style={{ color: '#c00', fontSize: 12, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {r.errorMessage}
        </div>
      )}
      <div style={{ fontSize: 13, color: '#555', marginTop: 6 }}>
        {r.sourceAgentId ? 'subagent' : cwdLabel}{time ? ` · ${time}` : ''} · {r.durationMs}ms
      </div>
      <button onClick={onOpen} style={{ marginTop: 8 }}>查看详情</button>
    </div>
  )
}

function SourceInputModal({ memoryId, onClose }: { memoryId: string; onClose: () => void }) {
  const [data, setData] = useState<SourceInput | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setData(null)
    getSourceInput(memoryId)
      .then((d) => { if (!cancelled) setData(d) })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [memoryId])

  // ESC 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
        background: 'rgba(0,0,0,0.5)', display: 'flex',
        alignItems: 'flex-start', justifyContent: 'center', padding: 40,
        overflow: 'auto', zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff', borderRadius: 8, maxWidth: 900, width: '100%',
          maxHeight: '85vh', overflow: 'auto', padding: 20,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <strong>{data?.title ?? '原始输入'}</strong>
          <button onClick={onClose} style={{ fontSize: 18, lineHeight: 1 }}>×</button>
        </div>

        {loading ? (
          <p style={{ color: '#666' }}>加载中…</p>
        ) : error ? (
          <p style={{ color: '#c00' }}>无法加载原始输入: {error}</p>
        ) : data && data.available ? (
          <>
            <p style={{ fontSize: 12, color: '#888', marginBottom: 12 }}>
              蒸馏时喂给模型的过滤版（文件类工具已压缩、超长已截断）· {data.turnCount ?? 0} turn · 约 {data.charCount ?? 0} 字
            </p>
            {data.bodyMd ? <p style={{ color: '#555', marginBottom: 12 }}>{data.bodyMd}</p> : null}
            <div>
              {(data.turns ?? []).map((t: SourceTurn, i: number) => {
                const { label, color } = formatSourceTurn(t)
                return (
                  <div key={i} style={{ marginBottom: 8, border: '1px solid #eee', borderRadius: 4, padding: 8 }}>
                    <span style={{ color, fontWeight: 600, fontSize: 12 }}>[{label}]</span>
                    <pre style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 13 }}>{t.content}</pre>
                  </div>
                )
              })}
            </div>
          </>
        ) : (
          <p style={{ color: '#666' }}>该记忆无原始输入快照</p>
        )}
      </div>
    </div>
  )
}

/**
 * 蒸馏记录详情遮罩层(runs tab 点「查看详情」打开)。三态:加载中 / 错误 / 数据。
 * ESC / × / 背景点击关闭(参照 SourceInputModal)。产出区按 outcome 分支:
 * produced -> rawOutput.candidates JSON 展示;empty_output/llm_error/skipped 各显
 * 对应文案。「模型返回 N 条，M 条格式不合格被丢弃」hint 仅在 rawCount >
 * acceptedCount 时出现。原始输入懒加载(点按钮才拉 getDistillRunSourceInput)。
 */
function DistillRunModal({ jobId, onClose }: { jobId: string; onClose: () => void }) {
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof getDistillRun>> | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [source, setSource] = useState<{ turnCount: number; charCount: number; turns: SourceTurn[] } | null>(null)
  const [sourceLoading, setSourceLoading] = useState(false)
  const [sourceError, setSourceError] = useState<string | null>(null)
  const [sourceLoaded, setSourceLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setDetail(null)
    getDistillRun(jobId)
      .then((d) => { if (!cancelled) setDetail(d) })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [jobId])

  // ESC 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const loadSource = async () => {
    // Reset all source states on each load so prior results/errors don't linger.
    setSourceLoading(true)
    setSourceError(null)
    setSource(null)
    setSourceLoaded(false)
    try {
      setSource(await getDistillRunSourceInput(jobId))
      setSourceLoaded(true)
    } catch (e) {
      // fetch itself rejected (network error): getDistillRunSourceInput only
      // returns null on !res.ok; a transport failure throws and must surface
      // (CLAUDE.md state-visibility: no silent stalls).
      setSourceError(e instanceof Error ? e.message : String(e))
    } finally {
      setSourceLoading(false)
    }
  }

  const cands = (detail?.rawOutput as { candidates?: unknown[] } | null | undefined)?.candidates
  const oc = detail ? formatOutcome(detail.outcome) : null
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
        background: 'rgba(0,0,0,0.5)', display: 'flex',
        alignItems: 'flex-start', justifyContent: 'center', padding: 40,
        overflow: 'auto', zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff', borderRadius: 8, maxWidth: 900, width: '100%',
          maxHeight: '85vh', overflow: 'auto', padding: 20,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <strong>蒸馏记录详情</strong>
          <button onClick={onClose} style={{ fontSize: 18, lineHeight: 1 }}>×</button>
        </div>

        {loading ? (
          <p style={{ color: '#666' }}>加载中…</p>
        ) : error ? (
          <p style={{ color: '#c00' }}>无法加载: {error}</p>
        ) : detail && oc ? (
          <>
            <div style={{ marginBottom: 8 }}>
              <span style={{ background: oc.color, color: '#fff', borderRadius: 4, padding: '2px 8px', fontSize: 12 }}>{oc.label}</span>
              <span style={{ marginLeft: 8, fontFamily: 'monospace' }}>{formatRunCounts({ distilled: detail.rawCount, deduped: detail.dedupedCount, filtered: detail.filteredCount, stored: detail.storedCount })}</span>
              {detail.rawCount > detail.acceptedCount && (
                <span style={{ marginLeft: 8, color: '#999' }}>模型返回 {detail.rawCount} 条，{detail.rawCount - detail.acceptedCount} 条格式不合格被丢弃</span>
              )}
            </div>
            <div style={{ marginBottom: 12 }}>
              <strong>产出：</strong>
              {detail.outcome === 'empty_output' ? <span>LLM 返回 0 候选</span>
                : detail.outcome === 'llm_error' ? (
                  <div>
                    <span style={{ color: '#c00' }}>LLM 调用失败</span>
                    {detail.errorMessage ? (
                      <pre style={{ background: '#fff4f4', color: '#c00', padding: 8, margin: '4px 0', whiteSpace: 'pre-wrap', borderLeft: '3px solid #c00' }}>{detail.errorMessage}</pre>
                    ) : <span style={{ color: '#999', marginLeft: 8 }}>（无错误描述）</span>}
                  </div>
                )
                : detail.outcome === 'skipped_no_new_turns' ? <span>该 job 无新 turn，未调用 LLM</span>
                : Array.isArray(cands) ? cands.map((c, i) => (
                    <pre key={i} style={{ background: '#f7f7f7', padding: 8, margin: '4px 0', whiteSpace: 'pre-wrap' }}>{JSON.stringify(c, null, 2)}</pre>
                  )) : <span>（无产出解析）</span>}
            </div>
            <div>
              <button onClick={loadSource} disabled={sourceLoading}>{sourceLoading ? '加载中…' : '查看原始输入'}</button>
              {sourceError ? (
                <p style={{ color: '#c00', marginTop: 8 }}>无法加载原始输入: {sourceError}</p>
              ) : source === null && sourceLoaded ? (
                <p style={{ color: '#666', marginTop: 8 }}>该 job 无原始输入快照</p>
              ) : source ? (
                <div style={{ marginTop: 8 }}>
                  <p style={{ color: '#666' }}>{source.turnCount} turn · 约 {source.charCount} 字</p>
                  {source.turns.map((t, i) => {
                    const f = formatSourceTurn(t)
                    return (
                      <pre key={i} style={{ borderLeft: `3px solid ${f.color}`, padding: '4px 8px', margin: '4px 0', whiteSpace: 'pre-wrap' }}>[{f.label}] {t.content}</pre>
                    )
                  })}
                </div>
              ) : null}
            </div>
          </>
        ) : (
          <p style={{ color: '#666' }}>无记录</p>
        )}
      </div>
    </div>
  )
}

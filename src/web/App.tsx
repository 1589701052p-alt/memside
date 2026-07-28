import { useEffect, useState } from 'react'
import { listMemories, promoteMemory, patchMemory, getStatus, bulkPromote, getSourceInput, type MemoryItem, type MemsideStatus, type SourceInput, type SourceTurn } from './api'
import { formatMemoryTime, sortCandidatesByTime, formatSourceTurn } from './ui-utils'

/**
 * valueClass -> 中文徽标 / 优先级排序。模块顶层定义以便 MemoryCard 直接复用
 * valueBadge,不必经 props 透传。
 *
 * 优先级:decision/convention=高(0),trap/topology=中(1),null=未评估(2)。
 * 候选队列按此排序,高价值先审;未评估条目可一键批量拒绝。
 */
const VALUE_LABEL: Record<string, string> = {
  decision: '高·决策', convention: '高·约定', trap: '中·陷阱', topology: '中·拓扑',
}
function valueBadge(vc: string | null | undefined): string {
  return vc && VALUE_LABEL[vc] ? VALUE_LABEL[vc] : '未评估'
}
function priorityRank(vc: string | null | undefined): number {
  if (vc === 'decision' || vc === 'convention') return 0
  if (vc === 'trap' || vc === 'topology') return 1
  return 2
}

/**
 * 审批队列 UI。每 3s 轮询 /api/memories + /api/status。顶部状态栏展示后台
 * 活动(已捕获事件 / distill 进行中 / 最近错误),让用户看到 daemon 在干活,
 * 而不是对着空队列干等。fetch 失败时显示错误 banner,不会卡在 "加载中"。
 */
export default function App() {
  const [items, setItems] = useState<MemoryItem[]>([])
  const [status, setStatus] = useState<MemsideStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sourceInputFor, setSourceInputFor] = useState<string | null>(null)

  async function refresh() {
    try {
      const [mems, st] = await Promise.all([listMemories(), getStatus()])
      setItems(mems)
      setStatus(st)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
    const t = setInterval(() => void refresh(), 3000)
    return () => clearInterval(t)
  }, [])

  async function approve(id: string) {
    await promoteMemory(id, { action: 'approve' })
    void refresh()
  }
  async function reject(id: string) {
    await promoteMemory(id, { action: 'reject' })
    void refresh()
  }
  async function edit(id: string, title: string, bodyMd: string, scopeType: 'project' | 'global') {
    await patchMemory(id, { title, bodyMd, scopeType })
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

  // 候选按 createdAt 倒序（newest first），完全替换 PR #9 的价值优先级排序。
  // 价值徽标仍显示，只是不再决定顺序。priorityRank 仍被 bulkRejectUnevaluated 用。
  const candidates = sortCandidatesByTime(items.filter((i) => i.status === 'candidate'))
  const jobs = status?.jobs ?? {}
  const running = (jobs.running ?? 0) + (jobs.pending ?? 0)

  return (
    <div style={{ fontFamily: 'system-ui', maxWidth: 900, margin: '0 auto', padding: 24 }}>
      <h1>memside · 审批队列</h1>

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

      <p>{candidates.length} 条候选记忆待审</p>
      {candidates.some((m) => priorityRank(m.valueClass) === 2) ? (
        <button onClick={() => bulkRejectUnevaluated()} style={{ marginBottom: 12 }}>
          批量拒绝未评估
        </button>
      ) : null}
      {loading && candidates.length === 0 && <p>加载中…</p>}
      {candidates.map((m) => (
        <MemoryCard
          key={m.id}
          m={m}
          onApprove={() => approve(m.id)}
          onReject={() => reject(m.id)}
          onEdit={(t, b, s) => edit(m.id, t, b, s)}
          onViewSource={() => setSourceInputFor(m.id)}
        />
      ))}
      {candidates.length === 0 && !loading && !error && (
        <p style={{ color: '#666' }}>
          暂无候选记忆。结束一个 claude code 会话后,后台会异步提炼(distill 约 15-30s),候选记忆会自动出现在这里。上方状态栏可看后台进度。
        </p>
      )}
      {sourceInputFor ? (
        <SourceInputModal memoryId={sourceInputFor} onClose={() => setSourceInputFor(null)} />
      ) : null}
    </div>
  )
}

function MemoryCard({
  m,
  onApprove,
  onReject,
  onEdit,
  onViewSource,
}: {
  m: MemoryItem
  onApprove: () => void
  onReject: () => void
  onEdit: (title: string, bodyMd: string, scopeType: 'project' | 'global') => Promise<void>
  onViewSource: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(m.title)
  const [body, setBody] = useState(m.bodyMd ?? '')
  const [scope, setScope] = useState<'project' | 'global'>(m.scopeType === 'project' ? 'project' : 'global')
  const [editError, setEditError] = useState<string | null>(null)
  const sourceLabel = m.sourceCwd
    ? (m.sourceCwd.split(/[\\/]/).filter(Boolean).pop() ?? m.sourceCwd)
    : m.sourceKind === 'manual'
      ? '手动'
      : '未知'
  const time = formatMemoryTime(m.createdAt)
  async function save() {
    setEditError(null)
    try {
      await onEdit(title, body, scope)
      setEditing(false)
    } catch (e) {
      setEditError(e instanceof Error ? e.message : String(e))
    }
  }
  return (
    <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 16, marginBottom: 12 }}>
      {editing ? (
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
          <button onClick={save}>保存</button>
          <button onClick={() => setEditing(false)}>取消</button>
          {editError && <div style={{ color: '#c00', fontSize: 12, marginTop: 6 }}>{editError}</div>}
        </>
      ) : (
        <>
          <strong>{m.title}</strong>
          <span style={{ marginLeft: 8, fontSize: 12, color: '#888' }}>{valueBadge(m.valueClass)}</span>
          {m.bodyMd && <p style={{ color: '#555' }}>{m.bodyMd}</p>}
          <small>
            {m.scopeType} · {m.runtime ?? '任意 runtime'} · 来源: <span title={m.sourceCwd ?? ''}>{sourceLabel}</span>
            {time ? ` · ${time}` : ''}
          </small>
          <div style={{ marginTop: 8 }}>
            <button onClick={onApprove} style={{ marginRight: 8 }}>
              批准
            </button>
            <button onClick={onReject} style={{ marginRight: 8 }}>
              拒绝
            </button>
            <button onClick={() => { setEditError(null); setEditing(true) }}>编辑</button>
            {m.distillJobId ? (
              <button onClick={onViewSource} style={{ marginLeft: 8 }}>
                查看原始输入
              </button>
            ) : null}
          </div>
        </>
      )}
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

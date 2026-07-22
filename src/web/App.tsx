import { useEffect, useState } from 'react'
import { listMemories, promoteMemory, patchMemory, type MemoryItem } from './api'

/**
 * Approval queue UI (Task 15).
 *
 * Polls GET /api/memories every 3s and lists candidate memories with
 * Approve / Reject / Edit actions. Edit is an inline form that PATCHes the
 * title + body; Approve / Reject POST to the promote endpoint. After every
 * mutation we refresh immediately rather than waiting for the next poll.
 */
export default function App() {
  const [items, setItems] = useState<MemoryItem[]>([])
  const [loading, setLoading] = useState(true)

  async function refresh() {
    setLoading(true)
    setItems(await listMemories())
    setLoading(false)
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
  async function edit(id: string, title: string, bodyMd: string) {
    await patchMemory(id, { title, bodyMd })
    void refresh()
  }

  const candidates = items.filter((i) => i.status === 'candidate')
  return (
    <div style={{ fontFamily: 'system-ui', maxWidth: 900, margin: '0 auto', padding: 24 }}>
      <h1>memside · approval queue</h1>
      <p>{candidates.length} candidate(s) awaiting review</p>
      {loading && <p>loading…</p>}
      {candidates.map((m) => (
        <MemoryCard
          key={m.id}
          m={m}
          onApprove={() => approve(m.id)}
          onReject={() => reject(m.id)}
          onEdit={(t, b) => edit(m.id, t, b)}
        />
      ))}
      {candidates.length === 0 && !loading && <p>Nothing to review. Distilled memories will appear here.</p>}
    </div>
  )
}

function MemoryCard({
  m,
  onApprove,
  onReject,
  onEdit,
}: {
  m: MemoryItem
  onApprove: () => void
  onReject: () => void
  onEdit: (title: string, bodyMd: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(m.title)
  const [body, setBody] = useState(m.bodyMd ?? '')
  return (
    <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 16, marginBottom: 12 }}>
      {editing ? (
        <>
          <input value={title} onChange={(e) => setTitle(e.target.value)} style={{ width: '100%', marginBottom: 8 }} />
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} style={{ width: '100%', marginBottom: 8 }} />
          <button onClick={() => { onEdit(title, body); setEditing(false) }}>save</button>
          <button onClick={() => setEditing(false)}>cancel</button>
        </>
      ) : (
        <>
          <strong>{m.title}</strong>
          {m.bodyMd && <p style={{ color: '#555' }}>{m.bodyMd}</p>}
          <small>
            {m.scopeType} · {m.runtime ?? 'any runtime'}
          </small>
          <div style={{ marginTop: 8 }}>
            <button onClick={onApprove} style={{ marginRight: 8 }}>
              approve
            </button>
            <button onClick={onReject} style={{ marginRight: 8 }}>
              reject
            </button>
            <button onClick={() => setEditing(true)}>edit</button>
          </div>
        </>
      )}
    </div>
  )
}

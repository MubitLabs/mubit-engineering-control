import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../api/client'
import { ErrorBox, Status } from '../../components/ui'

interface Message {
  id: string
  body: string
  status: string
  authorLogin: string
  createdAt: string
}

/** One ordered steering queue per attempt (PDF §12): queued until the runner confirms delivery. */
export function Messages({ attemptId, canSend }: { attemptId: string; canSend: boolean }) {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['attempt', attemptId, 'detail'],
    queryFn: () => api.get<{ messages: Message[] }>(`/api/attempts/${attemptId}`),
  })
  const [text, setText] = useState('')
  const send = useMutation({
    mutationFn: () =>
      api.post(`/api/attempts/${attemptId}/messages`, { text, clientKey: crypto.randomUUID() }),
    onSuccess: () => {
      setText('')
      qc.invalidateQueries({ queryKey: ['attempt', attemptId] })
    },
  })
  const messages = q.data?.messages ?? []
  if (!canSend && messages.length === 0) return null
  return (
    <div className="panel-body stack small" style={{ borderTop: '1px solid var(--border)' }}>
      {messages.map((m) => (
        <div key={m.id} className="row">
          <Status value={m.status} /> <span className="muted">{m.authorLogin}:</span> <span>{m.body}</span>
        </div>
      ))}
      {canSend && (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault()
            if (text.trim()) send.mutate()
          }}
        >
          <input
            style={{ flex: 1 }}
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-label="Message to the agent"
            placeholder="Steer the agent (queued, delivered in order)"
          />
          <button type="submit" className="btn small" disabled={!text.trim() || send.isPending}>
            Send
          </button>
        </form>
      )}
      <ErrorBox error={send.error} />
    </div>
  )
}

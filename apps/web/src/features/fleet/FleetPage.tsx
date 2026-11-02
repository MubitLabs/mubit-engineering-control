import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../api/client'
import { Empty, ErrorBox, Panel, Status, Time } from '../../components/ui'

interface RunnerView {
  id: string
  name: string
  hostname: string | null
  os: string | null
  arch: string | null
  runnerVersion: string | null
  capacity: { maxAttempts?: number; cpus?: number; memoryMb?: number; diskFreeMb?: number | null }
  agents: { kind: string; version: string | null; available: boolean; auth: string; capabilities: string[] }[]
  status: 'online' | 'offline'
  draining: boolean
  revokedAt: string | null
  lastSeenAt: string | null
  ownerLogin: string
  activeAttempts: number
  connected: boolean
}

/** Fleet and accounts (PDF §12): owner, agent, runner, authentication, capacity. */
export function FleetPage() {
  const qc = useQueryClient()
  const runners = useQuery({
    queryKey: ['fleet'],
    queryFn: () => api.get<{ runners: RunnerView[] }>('/api/runners'),
    refetchInterval: 5_000,
  })
  const drain = useMutation({
    mutationFn: (r: RunnerView) => api.post(`/api/runners/${r.id}/drain`, { draining: !r.draining }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['fleet'] }),
  })
  const revoke = useMutation({
    mutationFn: (r: RunnerView) => api.post(`/api/runners/${r.id}/revoke`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['fleet'] }),
  })

  return (
    <div className="stack">
      <div className="page-head">
        <h1>Fleet</h1>
      </div>
      <Panel title="Runners" flush>
        {runners.data?.runners.length === 0 ? (
          <Empty>No runners enrolled. Create an invitation below.</Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Runner</th>
                <th>Owner</th>
                <th>Status</th>
                <th>Agents</th>
                <th>Capacity</th>
                <th>Active</th>
                <th>Last seen</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {runners.data?.runners.map((r) => (
                <tr key={r.id}>
                  <td>
                    <div>{r.name}</div>
                    <div className="faint small">
                      {r.hostname} · {r.arch} · v{r.runnerVersion ?? '?'}
                    </div>
                  </td>
                  <td className="muted">{r.ownerLogin}</td>
                  <td>
                    <div className="row">
                      <Status value={r.revokedAt ? 'revoked' : r.status} />
                      {r.draining && !r.revokedAt && <Status value="draining" />}
                    </div>
                  </td>
                  <td className="small">
                    {r.agents.map((a) => (
                      <div key={a.kind} title={a.capabilities.join(', ')}>
                        {a.kind} {a.version ?? ''} <span className="faint">auth: {a.auth}</span>
                      </div>
                    ))}
                  </td>
                  <td className="small muted">
                    {r.capacity.maxAttempts ?? '?'} attempts · {r.capacity.cpus ?? '?'} cpu ·{' '}
                    {Math.round((r.capacity.memoryMb ?? 0) / 1024)} GB
                  </td>
                  <td>{r.activeAttempts}</td>
                  <td>
                    <Time value={r.lastSeenAt} />
                  </td>
                  <td>
                    {!r.revokedAt && (
                      <div className="row">
                        <button type="button" className="btn small" onClick={() => drain.mutate(r)}>
                          {r.draining ? 'Undrain' : 'Drain'}
                        </button>
                        <button type="button" className="btn small danger" onClick={() => revoke.mutate(r)}>
                          Revoke
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <ErrorBox error={drain.error ?? revoke.error} />
      </Panel>
      <Invite />
    </div>
  )
}

function Invite() {
  const [label, setLabel] = useState('')
  const [ownerLogin, setOwner] = useState('')
  const create = useMutation({
    mutationFn: () =>
      api.post<{ token: string; command: string; invite: { expiresAt: string; owner: string } }>(
        '/api/runners/invites',
        { label, ownerLogin: ownerLogin || undefined },
      ),
  })
  return (
    <Panel title="Enrol a runner">
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault()
          create.mutate()
        }}
      >
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <label className="field" style={{ flex: 1 }}>
            Label
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="max's droplet" />
          </label>
          <label className="field" style={{ flex: 1 }}>
            Employee (GitHub login, default you)
            <input value={ownerLogin} onChange={(e) => setOwner(e.target.value)} />
          </label>
          <button type="submit" className="btn primary" disabled={!label || create.isPending}>
            Create invitation
          </button>
        </div>
        <ErrorBox error={create.error} />
        {create.data && (
          <div className="notice">
            <div>
              Single-use invitation for {create.data.invite.owner}, valid until{' '}
              {new Date(create.data.invite.expiresAt).toLocaleTimeString()}. Run on the employee's machine:
            </div>
            <pre className="panel panel-body small">{create.data.command}</pre>
          </div>
        )}
      </form>
    </Panel>
  )
}

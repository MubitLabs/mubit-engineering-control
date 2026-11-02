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
      <Dispatch />
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

interface FleetStatus {
  dispatchPaused: boolean
  limits: { global: number; perEmployee: number; perDelivery: number; perProfile: number }
  load: { total: number }
  latestStop: {
    id: string
    createdAt: string
    reason: string
    summary: { total: number; stopped: number; unreachable: number }
    attempts: {
      attemptId: string
      state: string
      acknowledged: boolean
      stopped: boolean
      runnerReachable: boolean
    }[]
  } | null
}

/** Dispatch status and the fleet stop (PDF §13): stop requests are tracked until each runner confirms. */
function Dispatch() {
  const qc = useQueryClient()
  const status = useQuery({
    queryKey: ['fleet', 'status'],
    queryFn: () => api.get<FleetStatus>('/api/fleet/status'),
    refetchInterval: 3_000,
  })
  const stop = useMutation({
    mutationFn: () => api.post('/api/fleet/stop', { reason: 'stopped from the fleet page' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['fleet'] }),
  })
  const resume = useMutation({
    mutationFn: () => api.post('/api/fleet/resume'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['fleet'] }),
  })
  const d = status.data
  if (!d) return null
  return (
    <Panel
      title={
        <div className="row">
          <h2>Dispatch</h2> {d.dispatchPaused ? <Status value="paused" /> : <Status value="active" />}
        </div>
      }
      actions={
        d.dispatchPaused ? (
          <button type="button" className="btn small primary" onClick={() => resume.mutate()}>
            Resume dispatch
          </button>
        ) : (
          <button type="button" className="btn small danger" onClick={() => stop.mutate()}>
            Stop fleet
          </button>
        )
      }
    >
      <div className="stack small">
        <div className="muted">
          {d.load.total} active attempts · limits: {d.limits.global} global, {d.limits.perEmployee} per
          employee, {d.limits.perDelivery} per delivery, {d.limits.perProfile} per profile
        </div>
        {d.latestStop && (
          <div>
            Last stop <Time value={d.latestStop.createdAt} />: {d.latestStop.summary.stopped}/
            {d.latestStop.summary.total} confirmed stopped
            {d.latestStop.summary.unreachable > 0 && (
              <span className="status err"> {d.latestStop.summary.unreachable} unreachable</span>
            )}
          </div>
        )}
        <ErrorBox error={stop.error ?? resume.error} />
      </div>
    </Panel>
  )
}

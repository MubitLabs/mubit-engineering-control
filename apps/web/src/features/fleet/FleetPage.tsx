import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../api/client'
import { useTitle } from '../../components/Layout'
import { Empty, ErrorBox, Panel, Status, Time } from '../../components/ui'
import { useMe } from '../auth/useMe'

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
  useTitle('Fleet')
  const isAdmin = useMe().data?.user.isAdmin ?? false
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
          <Empty>
            {isAdmin
              ? 'No runners enrolled. Create an invitation below.'
              : 'You have no runners. An admin can create an enrolment invitation for you.'}
          </Empty>
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
                    {r.capacity.maxAttempts === undefined ? (
                      <span className="faint">not connected yet</span>
                    ) : (
                      <>
                        {r.capacity.maxAttempts} attempts · {r.capacity.cpus ?? '?'} cpu ·{' '}
                        {Math.round((r.capacity.memoryMb ?? 0) / 1024)} GB
                      </>
                    )}
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
                        <button
                          type="button"
                          className="btn small danger"
                          onClick={() => {
                            if (
                              window.confirm(
                                `Revoke ${r.name}? It is disconnected and must be enrolled again.`,
                              )
                            )
                              revoke.mutate(r)
                          }}
                        >
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
      {isAdmin && <Dispatch />}
      {isAdmin && <Invite runners={runners.data?.runners ?? []} />}
    </div>
  )
}

function runnerName(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 64)
    .replace(/-+$/, '')
}

function Invite({ runners }: { runners: RunnerView[] }) {
  const [label, setLabel] = useState('')
  const [ownerLogin, setOwner] = useState('')
  const [customName, setName] = useState<string | null>(null)
  const name = customName ?? runnerName(label)
  const create = useMutation({
    mutationFn: () =>
      api.post<{
        token: string
        command: string
        invite: { expiresAt: string; owner: string; label: string }
      }>('/api/runners/invites', { label, name: name || undefined, ownerLogin: ownerLogin || undefined }),
  })
  const [known, setKnown] = useState<Set<string>>(new Set())
  const issued = create.data
  const enrolled = issued && runners.find((r) => r.name === name && !known.has(r.id))
  const taken = !issued && runners.some((r) => r.name === name)
  return (
    <Panel title="Enrol a runner">
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault()
          setKnown(new Set(runners.map((r) => r.id)))
          create.mutate()
        }}
      >
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <label className="field" style={{ flex: 1 }}>
            Label
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Max's laptop" />
          </label>
          <label className="field" style={{ flex: 1 }}>
            Runner name
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="maxs-laptop" />
          </label>
          <label className="field" style={{ flex: 1 }}>
            Employee (GitHub login, default you)
            <input value={ownerLogin} onChange={(e) => setOwner(e.target.value)} />
          </label>
          <button type="submit" className="btn primary" disabled={!label || taken || create.isPending}>
            Create invitation
          </button>
        </div>
        {taken && <div className="error-box">A runner named {name} already exists. Choose another name.</div>}
        <ErrorBox error={create.error} />
        {issued && enrolled && (
          <div className="notice stack">
            <div>
              <Status value={enrolled.status} /> {enrolled.name} is enrolled for {enrolled.ownerLogin}.{' '}
              {enrolled.status === 'online'
                ? 'Next, its owner offers the agent account to projects on the Accounts page.'
                : 'Start it on that machine and it comes online here:'}
            </div>
            {enrolled.status !== 'online' && <Step command="node apps/runner/dist/main.js" />}
          </div>
        )}
        {issued && !enrolled && (
          <div className="notice stack">
            <div>
              Single-use invitation for {issued.invite.owner}, valid until{' '}
              {new Date(issued.invite.expiresAt).toLocaleTimeString()}. On that machine, with Node 22+, git
              and the agent CLI signed in:
            </div>
            <Step
              n={1}
              text="In a checkout of this repository, build the runner:"
              command="pnpm install && pnpm build"
            />
            <Step n={2} text="Enrol it (writes ~/.config/mec/runner.env):" command={issued.command} />
            <Step n={3} text="Start it:" command="node apps/runner/dist/main.js" />
            <div className="faint small">This page notices when the runner enrols.</div>
          </div>
        )}
      </form>
    </Panel>
  )
}

function Step({ n, text, command }: { n?: number; text?: string; command: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div>
      {text && (
        <div>
          {n}. {text}
        </div>
      )}
      <div className="row" style={{ alignItems: 'stretch' }}>
        <pre
          className="panel panel-body small"
          style={{ flex: 1, margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}
        >
          {command}
        </pre>
        <button
          type="button"
          className="btn small"
          onClick={() =>
            navigator.clipboard.writeText(command).then(
              () => setCopied(true),
              () => setCopied(false),
            )
          }
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
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
          <button
            type="button"
            className="btn small danger"
            onClick={() => {
              if (
                window.confirm(
                  `Stop the fleet? ${d.load.total} running attempt(s) are interrupted and nothing new starts until dispatch is resumed.`,
                )
              )
                stop.mutate()
            }}
          >
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

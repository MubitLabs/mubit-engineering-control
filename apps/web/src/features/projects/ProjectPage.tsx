import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { api } from '../../api/client'
import { useProjectEvents } from '../../api/events'
import type { Delivery, Member, Project, ProjectRole, Repository, StoredEvent } from '../../api/types'
import { Empty, ErrorBox, Panel, Status, Time } from '../../components/ui'

interface ProjectDetail {
  project: Project
  role: ProjectRole | null
  members: Member[]
  repositories: Repository[]
}

export function ProjectPage() {
  const { projectId } = useParams()
  const [feed, setFeed] = useState<StoredEvent[]>([])
  const { connected } = useProjectEvents(projectId, (e) => setFeed((f) => [e, ...f].slice(0, 200)))
  const detail = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.get<ProjectDetail>(`/api/projects/${projectId}`),
  })
  const deliveries = useQuery({
    queryKey: ['project', projectId, 'deliveries'],
    queryFn: () => api.get<{ deliveries: Delivery[] }>(`/api/projects/${projectId}/deliveries`),
  })
  const canWrite = detail.data?.role === 'owner' || detail.data?.role === 'member'
  const isOwner = detail.data?.role === 'owner'

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <div className="crumbs">
            <Link to="/">projects</Link> / {detail.data?.project.slug}
          </div>
          <h1>{detail.data?.project.name}</h1>
        </div>
        <span className="row small muted">
          <span className={`dot ${connected ? 'live' : ''}`} /> {connected ? 'live' : 'reconnecting'}
        </span>
      </div>
      <div className="grid-2">
        <div className="stack">
          <Panel title="Deliveries" flush>
            {deliveries.data?.deliveries.length === 0 ? (
              <Empty>No deliveries yet.</Empty>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Delivery</th>
                    <th>State</th>
                    <th>Tasks</th>
                    <th>Decisions</th>
                    <th>Owner</th>
                    <th>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {deliveries.data?.deliveries.map((d) => (
                    <tr key={d.id}>
                      <td>
                        <Link to={`/projects/${projectId}/deliveries/${d.id}`}>{d.title}</Link>
                      </td>
                      <td>
                        <Status value={d.state} />
                      </td>
                      <td>{d.taskCount}</td>
                      <td>
                        {d.pendingApprovals ? <Status value="pending" /> : <span className="faint">—</span>}
                      </td>
                      <td className="muted">{d.ownerLogin}</td>
                      <td>
                        <Time value={d.updatedAt} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
          {canWrite && detail.data && (
            <NewDelivery projectId={projectId!} repositories={detail.data.repositories} />
          )}
          <Panel title="Live events" flush>
            {feed.length === 0 ? (
              <Empty>Waiting for activity…</Empty>
            ) : (
              <div className="feed">
                {feed.map((e) => (
                  <div className="feed-row" key={e.id}>
                    <span className="faint">#{e.seq}</span>
                    <span>
                      <span className="feed-type">{e.type}</span>{' '}
                      <span className="muted">{summarise(e.payload)}</span>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </div>
        <div className="stack">
          <Panel title="Repositories" flush>
            {detail.data?.repositories.length === 0 && <Empty>No repositories registered.</Empty>}
            {detail.data?.repositories.map((r) => (
              <div key={r.id} className="panel-body" style={{ borderBottom: '1px solid var(--border)' }}>
                <div className="spread">
                  <strong>{r.name}</strong>
                  <span className="faint small">{r.defaultBranch}</span>
                </div>
                <div className="muted small mono-ellipsis">{r.cloneUrl}</div>
                <div className="small faint">
                  checks: {r.validationProfile.checks.map((c) => c.name).join(', ') || 'none'}
                </div>
              </div>
            ))}
            {isOwner && <AddRepository projectId={projectId!} />}
          </Panel>
          <Panel title="Members" flush>
            <table className="table">
              <tbody>
                {detail.data?.members.map((m) => (
                  <tr key={m.id}>
                    <td>{m.login}</td>
                    <td className="muted">{m.role}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {isOwner && <AddMember projectId={projectId!} />}
          </Panel>
        </div>
      </div>
    </div>
  )
}

function summarise(payload: Record<string, unknown>): string {
  const parts = Object.entries(payload)
    .filter(([, v]) => typeof v === 'string' || typeof v === 'number')
    .slice(0, 4)
    .map(([k, v]) => `${k}=${String(v).slice(0, 40)}`)
  return parts.join(' ')
}

function NewDelivery({ projectId, repositories }: { projectId: string; repositories: Repository[] }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [title, setTitle] = useState('')
  const [repositoryId, setRepositoryId] = useState('')
  const [planMarkdown, setPlan] = useState('')
  const [key] = useState(() => crypto.randomUUID())
  const create = useMutation({
    mutationFn: () =>
      api.post<{ delivery: Delivery }>('/api/deliveries', {
        projectId,
        repositoryId: repositoryId || repositories[0]?.id,
        title,
        planMarkdown,
        idempotencyKey: key,
      }),
    onSuccess: ({ delivery }) => {
      qc.invalidateQueries({ queryKey: ['project', projectId] })
      navigate(`/projects/${projectId}/deliveries/${delivery.id}`)
    },
  })
  if (repositories.length === 0) return null
  return (
    <Panel title="New delivery">
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault()
          create.mutate()
        }}
      >
        <div className="row">
          <label className="field" style={{ flex: 2 }}>
            Title
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Audit log endpoint"
            />
          </label>
          <label className="field" style={{ flex: 1 }}>
            Repository
            <select value={repositoryId} onChange={(e) => setRepositoryId(e.target.value)}>
              {repositories.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="field">
          Implementation plan (markdown)
          <textarea rows={6} value={planMarkdown} onChange={(e) => setPlan(e.target.value)} />
        </label>
        <ErrorBox error={create.error} />
        <div>
          <button className="btn primary" type="submit" disabled={!title || create.isPending}>
            Create delivery
          </button>
        </div>
      </form>
    </Panel>
  )
}

function AddMember({ projectId }: { projectId: string }) {
  const qc = useQueryClient()
  const [login, setLogin] = useState('')
  const [role, setRole] = useState<ProjectRole>('member')
  const add = useMutation({
    mutationFn: () => api.post(`/api/projects/${projectId}/members`, { login, role }),
    onSuccess: () => {
      setLogin('')
      qc.invalidateQueries({ queryKey: ['project', projectId] })
    },
  })
  return (
    <form
      className="panel-body form"
      onSubmit={(e) => {
        e.preventDefault()
        add.mutate()
      }}
    >
      <div className="row">
        <input
          style={{ flex: 2 }}
          value={login}
          onChange={(e) => setLogin(e.target.value)}
          placeholder="github login"
        />
        <select style={{ flex: 1 }} value={role} onChange={(e) => setRole(e.target.value as ProjectRole)}>
          <option value="owner">owner</option>
          <option value="member">member</option>
          <option value="viewer">viewer</option>
        </select>
        <button className="btn small" type="submit" disabled={!login}>
          Add
        </button>
      </div>
      <ErrorBox error={add.error} />
    </form>
  )
}

function AddRepository({ projectId }: { projectId: string }) {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [cloneUrl, setCloneUrl] = useState('')
  const [checks, setChecks] = useState('test: pnpm test\nlint: pnpm lint')
  const add = useMutation({
    mutationFn: () =>
      api.post(`/api/projects/${projectId}/repositories`, {
        name,
        cloneUrl,
        validationProfile: {
          bootstrap: [{ name: 'install', argv: ['pnpm', 'install', '--frozen-lockfile'], timeoutSec: 600 }],
          checks: checks
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
            .map((l) => {
              const [checkName, cmd] = l.split(':')
              return { name: checkName!.trim(), argv: (cmd ?? '').trim().split(/\s+/), timeoutSec: 600 }
            }),
        },
      }),
    onSuccess: () => {
      setName('')
      setCloneUrl('')
      qc.invalidateQueries({ queryKey: ['project', projectId] })
    },
  })
  return (
    <form
      className="panel-body form"
      onSubmit={(e) => {
        e.preventDefault()
        add.mutate()
      }}
    >
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="name" />
      <input
        value={cloneUrl}
        onChange={(e) => setCloneUrl(e.target.value)}
        placeholder="https://github.com/org/repo.git"
      />
      <label className="field">
        Checks (name: command, one per line)
        <textarea rows={3} value={checks} onChange={(e) => setChecks(e.target.value)} />
      </label>
      <ErrorBox error={add.error} />
      <div>
        <button className="btn small" type="submit" disabled={!name || !cloneUrl}>
          Register repository
        </button>
      </div>
    </form>
  )
}

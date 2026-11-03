import type { CheckCommand } from '@mec/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { api, errorMessage } from '../../api/client'
import { useProjectEvents } from '../../api/events'
import type { Delivery, Member, Project, ProjectRole, Repository, StoredEvent } from '../../api/types'
import { useTitle } from '../../components/Layout'
import { Empty, ErrorBox, Panel, Status, Time } from '../../components/ui'
import { formatCommandLines, parseCommandLines } from './commands'

interface ProjectDetail {
  project: Project
  role: ProjectRole | null
  members: Member[]
  repositories: Repository[]
}

export function ProjectPage() {
  const { projectId } = useParams()
  const [feed, setFeed] = useState<StoredEvent[]>([])
  const detail = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.get<ProjectDetail>(`/api/projects/${projectId}`),
  })
  useTitle(detail.data?.project.name)
  const { connected } = useProjectEvents(detail.error ? undefined : projectId, (e) =>
    setFeed((f) => [e, ...f].slice(0, 200)),
  )
  const deliveries = useQuery({
    queryKey: ['project', projectId, 'deliveries'],
    queryFn: () => api.get<{ deliveries: Delivery[] }>(`/api/projects/${projectId}/deliveries`),
  })
  const canWrite = detail.data?.role === 'owner' || detail.data?.role === 'member'
  const isOwner = detail.data?.role === 'owner'
  const qc = useQueryClient()
  const removeMember = useMutation({
    mutationFn: (userId: string) => api.post(`/api/projects/${projectId}/members/${userId}/remove`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project', projectId] }),
  })

  if (detail.error)
    return (
      <div className="stack">
        <ErrorBox error={detail.error} />
        <Link to="/">Back to projects</Link>
      </div>
    )
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
          {detail.data?.project.pausedAt && <Status value="paused" />}
          {isOwner && <PauseButton projectId={projectId!} paused={!!detail.data?.project.pausedAt} />}
          <span className={`dot ${connected ? 'live' : ''}`} /> {connected ? 'live' : 'reconnecting'}
        </span>
      </div>
      <div className="grid-2">
        <div className="stack">
          <Panel title="Deliveries" flush>
            {deliveries.data?.deliveries.length === 0 ? (
              <Empty>
                No deliveries yet.
                {detail.data?.repositories.length === 0 &&
                  ' Register a repository first; deliveries run against one.'}
              </Empty>
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
                      <td style={{ minWidth: 180 }}>
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
            <NewDelivery
              key={deliveries.data ? 'loaded' : 'loading'}
              projectId={projectId!}
              repositories={detail.data.repositories}
              startOpen={deliveries.data?.deliveries.length === 0}
            />
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
              <RepositoryItem key={r.id} projectId={projectId!} repository={r} canEdit={isOwner} />
            ))}
            {isOwner && detail.data && (
              <AddRepository projectId={projectId!} startOpen={detail.data.repositories.length === 0} />
            )}
          </Panel>
          <Panel title="Members" flush>
            <table className="table">
              <tbody>
                {detail.data?.members.map((m) => (
                  <tr key={m.id}>
                    <td>{m.login}</td>
                    <td className="muted">{m.role}</td>
                    {isOwner &&
                      (m.role !== 'owner' ||
                        (detail.data?.members.filter((x) => x.role === 'owner').length ?? 0) > 1) && (
                        <td style={{ textAlign: 'right' }}>
                          <button
                            type="button"
                            className="btn small"
                            disabled={removeMember.isPending}
                            onClick={() => {
                              if (window.confirm(`Remove ${m.login} from this project?`))
                                removeMember.mutate(m.id)
                            }}
                          >
                            Remove
                          </button>
                        </td>
                      )}
                  </tr>
                ))}
              </tbody>
            </table>
            <ErrorBox error={removeMember.error} />
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

function NewDelivery({
  projectId,
  repositories,
  startOpen,
}: {
  projectId: string
  repositories: Repository[]
  startOpen: boolean
}) {
  const [open, setOpen] = useState(startOpen)
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
  if (!open)
    return (
      <div>
        <button type="button" className="btn primary" onClick={() => setOpen(true)}>
          New delivery
        </button>
      </div>
    )
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
          <textarea
            rows={6}
            value={planMarkdown}
            onChange={(e) => setPlan(e.target.value)}
            placeholder={
              '# What and why\n\nWhat should be true when this is done, constraints, files to avoid…'
            }
          />
        </label>
        <ErrorBox error={create.error} />
        <div className="row">
          <button className="btn primary" type="submit" disabled={!title.trim() || create.isPending}>
            Create delivery
          </button>
          <span className="faint small">
            Starts a draft plan. Next you write the tasks, or let the coordinator propose them, and approve.
          </span>
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
          aria-label="GitHub login of the new member"
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

function RepositoryItem({
  projectId,
  repository: r,
  canEdit,
}: {
  projectId: string
  repository: Repository
  canEdit: boolean
}) {
  const [editing, setEditing] = useState(false)
  const names = (list: { name: string }[]) => list.map((c) => c.name).join(', ') || 'none'
  return (
    <div className="panel-body" style={{ borderBottom: '1px solid var(--border)' }}>
      <div className="spread">
        <strong>{r.name}</strong>
        <span className="row small">
          <span className="faint">{r.defaultBranch}</span>
          {canEdit && !editing && (
            <button type="button" className="btn small" onClick={() => setEditing(true)}>
              Edit
            </button>
          )}
        </span>
      </div>
      <div className="muted small mono-ellipsis">{r.cloneUrl}</div>
      <div className="small faint">
        setup: {names(r.validationProfile.bootstrap)} · checks: {names(r.validationProfile.checks)}
      </div>
      {editing && <RepositoryForm projectId={projectId} repository={r} onDone={() => setEditing(false)} />}
    </div>
  )
}

function AddRepository({ projectId, startOpen }: { projectId: string; startOpen: boolean }) {
  const [open, setOpen] = useState(startOpen)
  if (!open)
    return (
      <div className="panel-body">
        <button type="button" className="btn small" onClick={() => setOpen(true)}>
          Add a repository
        </button>
      </div>
    )
  return <RepositoryForm projectId={projectId} onDone={() => setOpen(false)} />
}

/** Registers a repository, or edits one's branch, setup commands and checks. */
function RepositoryForm({
  projectId,
  repository,
  onDone,
}: {
  projectId: string
  repository?: Repository
  onDone?: () => void
}) {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [cloneUrl, setCloneUrl] = useState('')
  const [defaultBranch, setDefaultBranch] = useState(repository?.defaultBranch ?? 'main')
  const [setup, setSetup] = useState(() =>
    repository ? formatCommandLines(repository.validationProfile.bootstrap) : '',
  )
  const [checks, setChecks] = useState(() =>
    repository ? formatCommandLines(repository.validationProfile.checks) : '',
  )
  // Editing keeps each command's stored timeout; the text form doesn't show it.
  const keepTimeouts = (parsed: CheckCommand[], before: CheckCommand[] = []) =>
    parsed.map((c) => ({
      ...c,
      timeoutSec: before.find((b) => b.name === c.name)?.timeoutSec ?? c.timeoutSec,
    }))
  const parsedSetup = parseCommandLines(setup)
  const parsedChecks = parseCommandLines(checks)
  const errors = [
    ...parsedSetup.errors.map((e) => `Setup ${e}`),
    ...parsedChecks.errors.map((e) => `Checks ${e}`),
  ]
  const save = useMutation({
    mutationFn: () => {
      const validationProfile = {
        bootstrap: keepTimeouts(parsedSetup.commands, repository?.validationProfile.bootstrap),
        checks: keepTimeouts(parsedChecks.commands, repository?.validationProfile.checks),
      }
      return repository
        ? api.patch(`/api/projects/${projectId}/repositories/${repository.id}`, {
            defaultBranch,
            validationProfile,
          })
        : api.post(`/api/projects/${projectId}/repositories`, {
            name,
            cloneUrl,
            defaultBranch,
            validationProfile,
          })
    },
    onSuccess: () => {
      if (!repository) {
        setName('')
        setCloneUrl('')
        setDefaultBranch('main')
        setSetup('')
        setChecks('')
      }
      qc.invalidateQueries({ queryKey: ['project', projectId] })
      onDone?.()
    },
  })
  return (
    <form
      className={repository ? 'form' : 'panel-body form'}
      style={repository ? { marginTop: 10 } : undefined}
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate()
      }}
    >
      {!repository && (
        <>
          <label className="field">
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="shop-api" />
          </label>
          <label className="field">
            Clone URL
            <input
              value={cloneUrl}
              onChange={(e) => setCloneUrl(e.target.value)}
              placeholder="https://github.com/org/repo.git"
            />
          </label>
        </>
      )}
      <label className="field">
        Default branch
        <input value={defaultBranch} onChange={(e) => setDefaultBranch(e.target.value)} />
      </label>
      <label className="field">
        Setup commands — run in each new worktree before the agent starts (optional)
        <textarea
          rows={2}
          value={setup}
          onChange={(e) => setSetup(e.target.value)}
          placeholder="install: pnpm install --frozen-lockfile"
        />
      </label>
      <label className="field">
        Checks — tasks name the ones that must pass
        <textarea
          rows={3}
          value={checks}
          onChange={(e) => setChecks(e.target.value)}
          placeholder={'test: pnpm test\nlint: pnpm lint'}
        />
      </label>
      <div className="small faint">
        One per line as <code>name: command</code>. Commands run directly, not through a shell; quote
        arguments that contain spaces.
      </div>
      {errors.length > 0 && (
        <div className="error-box">
          {errors.map((e) => (
            <div key={e}>{e}</div>
          ))}
        </div>
      )}
      <ErrorBox error={save.error} />
      <div className="row">
        <button
          className="btn small primary"
          type="submit"
          disabled={(!repository && (!name || !cloneUrl)) || errors.length > 0 || save.isPending}
        >
          {repository ? 'Save' : 'Register repository'}
        </button>
        {onDone && (
          <button type="button" className="btn small" onClick={onDone}>
            Cancel
          </button>
        )}
      </div>
    </form>
  )
}

function PauseButton({ projectId, paused }: { projectId: string; paused: boolean }) {
  const qc = useQueryClient()
  const toggle = useMutation({
    mutationFn: () => api.post(`/api/projects/${projectId}/pause`, { paused: !paused }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['project', projectId] })
      qc.invalidateQueries({ queryKey: ['projects'] })
    },
  })
  return (
    <button
      type="button"
      className="btn small"
      onClick={() => toggle.mutate()}
      disabled={toggle.isPending}
      title={
        paused ? 'Let the scheduler start attempts again' : 'No new attempts start; running ones carry on'
      }
    >
      {paused ? 'Resume dispatch' : 'Pause dispatch'}
      {toggle.isError && <span className="faint"> · failed: {errorMessage(toggle.error)}</span>}
    </button>
  )
}

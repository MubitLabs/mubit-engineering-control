import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { api } from '../../api/client'
import type { Project, Setup } from '../../api/types'
import { useTitle } from '../../components/Layout'
import { Empty, ErrorBox, Panel, Status, Time } from '../../components/ui'
import { useMe } from '../auth/useMe'

export function ProjectsPage() {
  useTitle('Projects')
  const me = useMe()
  const isAdmin = me.data?.user.isAdmin ?? false
  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.get<{ projects: Project[] }>('/api/projects'),
  })

  return (
    <div className="stack">
      <div className="page-head">
        <h1>Projects</h1>
      </div>
      <SetupChecklist isAdmin={isAdmin} />
      <Panel title="Your projects" flush>
        {projects.data?.projects.length === 0 ? (
          <Empty>
            {isAdmin
              ? 'No projects yet. Create one below.'
              : 'You are not a member of any project yet. Ask a project owner to add you.'}
          </Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Slug</th>
                <th>Role</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {projects.data?.projects.map((p) => (
                <tr key={p.id}>
                  <td>
                    <Link to={`/projects/${p.id}`}>{p.name}</Link> {p.pausedAt && <Status value="paused" />}
                  </td>
                  <td className="muted">{p.slug}</td>
                  <td>{p.role ?? <span className="faint">admin view</span>}</td>
                  <td>
                    <Time value={p.createdAt} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
      {isAdmin && <CreateProject />}
    </div>
  )
}

function SetupChecklist({ isAdmin }: { isAdmin: boolean }) {
  const setup = useQuery({ queryKey: ['setup'], queryFn: () => api.get<Setup>('/api/setup') })
  if (!setup.data) return null
  const { steps, projectId } = setup.data
  const project = projectId ? `/projects/${projectId}` : null
  const items: { done: boolean; title: string; detail: string; action: ReactNode }[] = [
    {
      done: steps.project,
      title: 'Create a project',
      detail: 'A project groups repositories, people and deliveries.',
      action: isAdmin ? (
        <button
          type="button"
          className="linklike"
          onClick={() => {
            const input = document.querySelector<HTMLInputElement>('#new-project input')
            input?.scrollIntoView({ behavior: 'smooth', block: 'center' })
            input?.focus({ preventScroll: true })
          }}
        >
          New project
        </button>
      ) : (
        'Ask a project owner to add you.'
      ),
    },
    {
      done: steps.repository,
      title: 'Register a repository with checks',
      detail: 'Checks are the commands that decide whether work passes, such as "test: pnpm test".',
      action: project && <Link to={project}>Open project</Link>,
    },
    {
      done: steps.runner,
      title: 'Connect a runner',
      detail: 'A runner is a machine with a signed-in agent CLI. It works in its own git worktrees.',
      action: isAdmin ? <Link to="/fleet">Invite a runner</Link> : 'Ask an admin for a runner invite.',
    },
    {
      done: steps.profile,
      title: 'Offer an agent account to the project',
      detail: "The runner's owner chooses which projects may use their agent login.",
      action: <Link to="/accounts">Accounts</Link>,
    },
    {
      done: steps.delivery,
      title: 'Start a delivery',
      detail: 'Paste a plan, check the proposed tasks and approve them.',
      action: project && <Link to={project}>New delivery</Link>,
    },
  ]
  if (items.every((i) => i.done) || (!isAdmin && !steps.project)) return null
  const next = items.findIndex((i) => !i.done)
  return (
    <Panel
      title="Getting started"
      actions={<span className="faint small">{items.filter((i) => i.done).length} of 5 done</span>}
    >
      <ol className="checklist">
        {items.map((item, i) => (
          <li key={item.title} className={item.done ? 'done' : i === next ? 'next' : undefined}>
            <span className="check-mark">{item.done ? '✓' : i + 1}</span>
            <div style={{ flex: 1 }}>
              <div>{item.title}</div>
              {!item.done && <div className="small muted">{item.detail}</div>}
            </div>
            {!item.done && <div className="small">{item.action}</div>}
          </li>
        ))}
      </ol>
    </Panel>
  )
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 40)
    .replace(/-+$/, '')
}

function CreateProject() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [customSlug, setCustomSlug] = useState<string | null>(null)
  const slug = customSlug ?? slugify(name)
  const slugOk = SLUG.test(slug)
  const create = useMutation({
    mutationFn: () => api.post<{ project: Project }>('/api/projects', { slug, name: name.trim() }),
    onSuccess: ({ project }) => {
      qc.invalidateQueries({ queryKey: ['projects'] })
      qc.invalidateQueries({ queryKey: ['setup'] })
      qc.invalidateQueries({ queryKey: ['me'] })
      navigate(`/projects/${project.id}`)
    },
  })
  return (
    <Panel title="New project">
      <form
        id="new-project"
        className="form"
        onSubmit={(e) => {
          e.preventDefault()
          create.mutate()
        }}
      >
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <label className="field" style={{ flex: 1 }}>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Mubit core" />
          </label>
          <label className="field" style={{ flex: 1 }}>
            Slug
            <input value={slug} onChange={(e) => setCustomSlug(e.target.value)} placeholder="mubit-core" />
          </label>
          <button
            className="btn primary"
            type="submit"
            disabled={create.isPending || !name.trim() || !slugOk}
          >
            Create
          </button>
        </div>
        {name.trim() && !slugOk && (
          <div className="error-box">
            The slug needs lowercase letters, digits and dashes, starting with a letter or digit.
          </div>
        )}
        <ErrorBox error={create.error} />
      </form>
    </Panel>
  )
}

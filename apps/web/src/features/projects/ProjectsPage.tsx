import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router'
import { api } from '../../api/client'
import type { Project } from '../../api/types'
import { Empty, ErrorBox, Panel, Status, Time } from '../../components/ui'
import { useMe } from '../auth/useMe'

export function ProjectsPage() {
  const me = useMe()
  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.get<{ projects: Project[] }>('/api/projects'),
  })

  return (
    <div className="stack">
      <div className="page-head">
        <h1>Projects</h1>
      </div>
      <Panel title="Your projects" flush>
        {projects.data?.projects.length === 0 ? (
          <Empty>
            {me.data?.user.isAdmin
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
      {me.data?.user.isAdmin && <CreateProject />}
    </div>
  )
}

function CreateProject() {
  const qc = useQueryClient()
  const [slug, setSlug] = useState('')
  const [name, setName] = useState('')
  const create = useMutation({
    mutationFn: () => api.post('/api/projects', { slug, name }),
    onSuccess: () => {
      setSlug('')
      setName('')
      qc.invalidateQueries({ queryKey: ['projects'] })
    },
  })
  return (
    <Panel title="New project">
      <form
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
            <input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="core" />
          </label>
          <button className="btn primary" type="submit" disabled={create.isPending || !slug || !name}>
            Create
          </button>
        </div>
        <ErrorBox error={create.error} />
      </form>
    </Panel>
  )
}

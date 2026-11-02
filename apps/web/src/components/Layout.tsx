import { useQuery, useQueryClient } from '@tanstack/react-query'
import { NavLink, Outlet, useNavigate, useParams } from 'react-router'
import { api } from '../api/client'
import type { Approval, Project } from '../api/types'
import { useMe } from '../features/auth/useMe'

export function Layout() {
  const me = useMe()
  const { projectId } = useParams()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.get<{ projects: Project[] }>('/api/projects'),
  })
  const inbox = useQuery({
    queryKey: ['approvals', 'mine'],
    queryFn: () => api.get<{ approvals: Approval[] }>('/api/approvals'),
    refetchInterval: 30_000,
  })
  const pending = inbox.data?.approvals.length ?? 0

  return (
    <div className="shell">
      <aside className="sidebar">
        <NavLink to="/" className="brand">
          <span className="brand-mark" /> MEC
        </NavLink>
        <nav className="nav">
          <NavLink to="/inbox">
            <span>Decision inbox</span>
            {pending > 0 && <span className="status warn">{pending}</span>}
          </NavLink>
          {me.data?.user.isAdmin && <NavLink to="/fleet">Fleet</NavLink>}
        </nav>
        <nav className="nav">
          <div className="nav-label">Projects</div>
          {projects.data?.projects.map((p) => (
            <NavLink
              key={p.id}
              to={`/projects/${p.id}`}
              className={p.id === projectId ? 'active' : undefined}
            >
              <span className="mono-ellipsis">{p.name}</span>
              {p.pausedAt && <span className="status warn">paused</span>}
            </NavLink>
          ))}
          <NavLink to="/" end>
            <span className="faint">all projects</span>
          </NavLink>
        </nav>
        <div className="sidebar-foot">
          <span>
            {me.data?.user.login}
            {me.data?.user.isAdmin && <span className="faint"> · admin</span>}
          </span>
          <button
            type="button"
            className="btn small"
            onClick={async () => {
              await api.post('/auth/logout')
              qc.clear()
              navigate('/login')
            }}
          >
            Sign out
          </button>
        </div>
      </aside>
      <main className="main">
        <Outlet />
      </main>
    </div>
  )
}

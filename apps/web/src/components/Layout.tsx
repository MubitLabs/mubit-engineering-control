import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate, useParams } from 'react-router'
import { api } from '../api/client'
import { useProjectEvents } from '../api/events'
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
  const { pathname } = useLocation()
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on every route change
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [pathname])

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
          <NavLink to="/accounts">Accounts</NavLink>
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
      {projects.data?.projects.map((p) => (
        <LiveProject key={p.id} projectId={p.id} />
      ))}
      <main className="main">
        <Outlet />
      </main>
    </div>
  )
}

/** Keeps every visible project's data fresh (inbox, badge, open pages) from its live event stream. */
function LiveProject({ projectId }: { projectId: string }) {
  useProjectEvents(projectId, undefined, { fromNow: true })
  return null
}

/** Breadcrumb link to a project by name, from the sidebar's cached project list. */
export function ProjectCrumb({ projectId }: { projectId: string | undefined }) {
  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.get<{ projects: Project[] }>('/api/projects'),
  })
  const name = projects.data?.projects.find((p) => p.id === projectId)?.name ?? 'project'
  return <Link to={`/projects/${projectId}`}>{name}</Link>
}

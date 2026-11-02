import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Fragment, useState } from 'react'
import { api } from '../../api/client'
import type { Project } from '../../api/types'
import { Empty, ErrorBox, Panel, Status } from '../../components/ui'
import { useMe } from '../auth/useMe'

export interface ProfileView {
  id: string
  ownerId: string
  ownerLogin: string
  runnerId: string
  runnerName: string
  runnerStatus: string
  agentKind: string
  label: string
  agentVersion: string | null
  capabilitySet: string[]
  authState: 'ok' | 'required' | 'unknown'
  allowedProjectIds: string[]
  delegateLogins: string[]
  maxActive: number
  active: number
}

interface RunnerView {
  id: string
  name: string
  ownerId: string
  status: string
  revokedAt: string | null
  agents: { kind: string; version: string | null; available: boolean; auth: string; notes: string[] }[]
}

/**
 * Employee-owned execution profiles (PDF §5): which of my machines and native agent accounts may
 * run work, for which projects, and which colleagues may use them. Credentials never leave the
 * runner; only the label and health are shown here.
 */
export function AccountsPage() {
  const me = useMe()
  const qc = useQueryClient()
  const profiles = useQuery({
    queryKey: ['profiles'],
    queryFn: () => api.get<{ profiles: ProfileView[] }>('/api/profiles'),
  })
  const runners = useQuery({
    queryKey: ['fleet'],
    queryFn: () => api.get<{ runners: RunnerView[] }>('/api/runners'),
  })
  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.get<{ projects: Project[] }>('/api/projects'),
  })
  const revoke = useMutation({
    mutationFn: (id: string) => api.post(`/api/profiles/${id}/revoke`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['profiles'] }),
  })
  const [editing, setEditing] = useState<string | null>(null)
  const mine = runners.data?.runners.filter((r) => r.ownerId === me.data?.user.id && !r.revokedAt) ?? []
  const projectName = (id: string) => projects.data?.projects.find((p) => p.id === id)?.name ?? id.slice(0, 8)

  return (
    <div className="stack">
      <div className="page-head">
        <h1>Accounts</h1>
      </div>
      <Panel title="Execution profiles" flush>
        {profiles.data?.profiles.length === 0 ? (
          <Empty>No profiles yet. Offer an agent account from one of your runners below.</Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Profile</th>
                <th>Owner</th>
                <th>Agent</th>
                <th>Sign-in</th>
                <th>Projects</th>
                <th>Delegates</th>
                <th>Active</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {profiles.data?.profiles.map((p) => (
                <Fragment key={p.id}>
                  <tr>
                    <td>
                      <div>{p.label}</div>
                      <div className="faint small">on {p.runnerName}</div>
                    </td>
                    <td className="muted">{p.ownerLogin}</td>
                    <td className="small">
                      {p.agentKind} {p.agentVersion}
                      <div className="faint">{p.capabilitySet.join(', ')}</div>
                    </td>
                    <td>
                      <Status
                        value={
                          p.authState === 'ok'
                            ? 'ok'
                            : p.authState === 'required'
                              ? 'auth_required'
                              : 'unknown'
                        }
                      />
                    </td>
                    <td className="small">
                      {p.allowedProjectIds.map(projectName).join(', ') || <span className="faint">none</span>}
                    </td>
                    <td className="small">
                      {p.delegateLogins.join(', ') || <span className="faint">only owner</span>}
                    </td>
                    <td>
                      {p.active}/{p.maxActive}
                    </td>
                    <td>
                      {p.ownerId === me.data?.user.id && (
                        <div className="row">
                          <button
                            type="button"
                            className="btn small"
                            onClick={() => setEditing(editing === p.id ? null : p.id)}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="btn small danger"
                            onClick={() => {
                              if (window.confirm(`Revoke ${p.label}? New work stops using it at once.`))
                                revoke.mutate(p.id)
                            }}
                          >
                            Revoke
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                  {editing === p.id && (
                    <tr>
                      <td colSpan={8}>
                        <EditProfile
                          profile={p}
                          projects={projects.data?.projects ?? []}
                          onDone={() => setEditing(null)}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
        <ErrorBox error={revoke.error} />
      </Panel>
      {mine.length > 0 ? (
        <CreateProfile runners={mine} projects={projects.data?.projects ?? []} />
      ) : (
        <Panel>
          <div className="muted">
            You own no runners yet. An admin can create an enrolment invitation for you.
          </div>
        </Panel>
      )}
    </div>
  )
}

function CreateProfile({ runners, projects }: { runners: RunnerView[]; projects: Project[] }) {
  const qc = useQueryClient()
  const [runnerId, setRunnerId] = useState(runners[0]?.id ?? '')
  const runner = runners.find((r) => r.id === runnerId)
  const agents = runner?.agents.filter((a) => a.available) ?? []
  const [agentKind, setAgentKind] = useState('')
  const [label, setLabel] = useState('')
  const [grants, setGrants] = useState<Grants>({ allowed: [], delegates: '', maxActive: 1 })
  const kind = agentKind || agents[0]?.kind || ''
  const agent = agents.find((a) => a.kind === kind)
  const create = useMutation({
    mutationFn: () =>
      api.post('/api/profiles', {
        runnerId,
        agentKind: kind,
        label,
        ...grantBody(grants),
      }),
    onSuccess: () => {
      setLabel('')
      setGrants({ allowed: [], delegates: '', maxActive: 1 })
      qc.invalidateQueries({ queryKey: ['setup'] })
      qc.invalidateQueries({ queryKey: ['profiles'] })
    },
  })
  return (
    <Panel title="Offer an agent account">
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault()
          create.mutate()
        }}
      >
        <div className="row">
          <label className="field" style={{ flex: 1 }}>
            Runner
            <select value={runnerId} onChange={(e) => setRunnerId(e.target.value)}>
              {runners.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} ({r.status})
                </option>
              ))}
            </select>
          </label>
          <label className="field" style={{ flex: 1 }}>
            Agent
            <select value={kind} onChange={(e) => setAgentKind(e.target.value)}>
              {agents.map((a) => (
                <option key={a.kind} value={a.kind}>
                  {a.kind} {a.version}
                </option>
              ))}
            </select>
          </label>
          <label className="field" style={{ flex: 1 }}>
            Label
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="my Claude subscription"
            />
          </label>
        </div>
        {agent && agent.auth !== 'ok' && (
          <div className="notice">
            This agent is not signed in on the runner. Sign in natively as the runner user (for Claude Code:
            run <code>claude</code>, then <code>/login</code>); the profile becomes usable once the probe sees
            it.
          </div>
        )}
        <GrantFields grants={grants} onChange={setGrants} projects={projects} />
        <ErrorBox error={create.error} />
        <div>
          <button type="submit" className="btn primary" disabled={!label || !kind || create.isPending}>
            Create profile
          </button>
        </div>
      </form>
    </Panel>
  )
}

interface Grants {
  allowed: string[]
  delegates: string
  maxActive: number
}

const grantBody = (g: Grants) => ({
  allowedProjectIds: g.allowed,
  delegateLogins: g.delegates
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean),
  maxActive: g.maxActive,
})

function GrantFields(props: { grants: Grants; onChange: (g: Grants) => void; projects: Project[] }) {
  const { grants: g, onChange, projects } = props
  return (
    <>
      <div className="field">
        Projects this account may work on
        <div className="row">
          {projects.map((p) => (
            <label key={p.id} className="row small">
              <input
                type="checkbox"
                style={{ width: 'auto' }}
                checked={g.allowed.includes(p.id)}
                onChange={(e) =>
                  onChange({
                    ...g,
                    allowed: e.target.checked ? [...g.allowed, p.id] : g.allowed.filter((x) => x !== p.id),
                  })
                }
              />
              {p.name}
            </label>
          ))}
          {projects.length === 0 && <span className="faint small">You are in no projects yet.</span>}
        </div>
      </div>
      <div className="row">
        <label className="field" style={{ flex: 3 }}>
          Delegates (GitHub logins, comma separated) — colleagues allowed to use this account. They must have
          signed in once.
          <input value={g.delegates} onChange={(e) => onChange({ ...g, delegates: e.target.value })} />
        </label>
        <label className="field" style={{ flex: 1 }}>
          Attempts at once
          <select value={g.maxActive} onChange={(e) => onChange({ ...g, maxActive: Number(e.target.value) })}>
            {[1, 2, 3, 4].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>
    </>
  )
}

function EditProfile(props: { profile: ProfileView; projects: Project[]; onDone: () => void }) {
  const { profile, projects, onDone } = props
  const qc = useQueryClient()
  const [grants, setGrants] = useState<Grants>({
    allowed: profile.allowedProjectIds,
    delegates: profile.delegateLogins.join(', '),
    maxActive: profile.maxActive,
  })
  const save = useMutation({
    mutationFn: () => api.patch(`/api/profiles/${profile.id}`, grantBody(grants)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['profiles'] })
      qc.invalidateQueries({ queryKey: ['setup'] })
      onDone()
    },
  })
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate()
      }}
    >
      <GrantFields grants={grants} onChange={setGrants} projects={projects} />
      <ErrorBox error={save.error} />
      <div className="row">
        <button type="submit" className="btn small primary" disabled={save.isPending}>
          Save
        </button>
        <button type="button" className="btn small" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  )
}

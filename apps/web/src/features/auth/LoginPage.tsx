import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { api } from '../../api/client'
import { ErrorBox } from '../../components/ui'

const ERRORS: Record<string, string> = {
  not_member: 'Your GitHub account is not an active member of the organisation.',
  not_configured: 'GitHub sign-in is not configured on this server yet.',
}

export function LoginPage() {
  const [params] = useSearchParams()
  const config = useQuery({
    queryKey: ['auth-config'],
    queryFn: () => api.get<{ authMode: 'github' | 'dev'; org: string }>('/api/auth/config'),
  })
  const error = params.get('error')

  return (
    <div className="login">
      <div className="panel login-card stack">
        <div className="brand">
          <span className="brand-mark" /> MUBIT ENGINEERING CONTROL
        </div>
        <p className="muted">
          Coordinate implementation plans across the team's coding agents. Sign in with your{' '}
          {config.data?.org ?? 'GitHub'} account.
        </p>
        {error && <div className="error-box">{ERRORS[error] ?? error}</div>}
        {!config.data ? null : config.data.authMode === 'dev' ? (
          <DevLogin />
        ) : (
          <a
            className="btn primary"
            href={`/auth/github/login?next=${encodeURIComponent(nextPath(`?${params}`))}`}
            style={{ textAlign: 'center' }}
          >
            Sign in with GitHub
          </a>
        )}
      </div>
    </div>
  )
}

function DevLogin() {
  const [login, setLogin] = useState('admin')
  const [error, setError] = useState<unknown>(null)
  const qc = useQueryClient()
  const navigate = useNavigate()
  return (
    <form
      className="form"
      onSubmit={async (e) => {
        e.preventDefault()
        try {
          await api.post('/auth/dev/login', { login })
          await qc.invalidateQueries({ queryKey: ['me'] })
          navigate(nextPath(location.search))
        } catch (err) {
          setError(err)
        }
      }}
    >
      <div className="notice">Development login (loopback only).</div>
      <label className="field">
        Login
        <input value={login} onChange={(e) => setLogin(e.target.value)} />
      </label>
      <ErrorBox error={error} />
      <button className="btn primary" type="submit">
        Sign in
      </button>
    </form>
  )
}

/** The page to return to after sign-in; only paths on this site. */
export function nextPath(search: string): string {
  const next = new URLSearchParams(search).get('next')
  return next && /^\/(?![/\\])/.test(next) ? next : '/'
}

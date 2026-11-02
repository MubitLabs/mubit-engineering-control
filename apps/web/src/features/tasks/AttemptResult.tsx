import { useQuery } from '@tanstack/react-query'
import { api } from '../../api/client'
import { Status } from '../../components/ui'

interface AttemptDetail {
  attempt: {
    branch: string | null
    baseSha: string | null
    headSha: string | null
    diff: {
      files: { path: string; insertions: number; deletions: number }[]
      fileCount: number
      insertions: number
      deletions: number
      truncated: boolean
      patchArtifactId: string | null
    } | null
  }
  checks: {
    id: string
    name: string
    status: string
    exitCode: number | null
    durationMs: number
    testedSha: string | null
    logArtifactId: string | null
    logTail: string | null
  }[]
}

/** Evidence for review (PDF §15): exact SHAs, the change, and each check against the tested commit. */
export function AttemptResult({ attemptId }: { attemptId: string }) {
  const q = useQuery({
    queryKey: ['attempt', attemptId, 'detail'],
    queryFn: () => api.get<AttemptDetail>(`/api/attempts/${attemptId}`),
  })
  const d = q.data
  if (!d || (!d.attempt.branch && d.checks.length === 0)) return null
  const { attempt, checks } = d
  return (
    <div className="panel-body stack small" style={{ borderBottom: '1px solid var(--border)' }}>
      {attempt.branch && (
        <div className="row muted">
          <code>{attempt.branch}</code>
          <span>
            base <code>{attempt.baseSha?.slice(0, 10)}</code>
          </span>
          {attempt.headSha && (
            <span>
              head <code>{attempt.headSha.slice(0, 10)}</code>
            </span>
          )}
        </div>
      )}
      {attempt.diff && (
        <div>
          <div className="spread">
            <span>
              {attempt.diff.fileCount} files{' '}
              <span style={{ color: 'var(--ok)' }}>+{attempt.diff.insertions}</span>{' '}
              <span style={{ color: 'var(--err)' }}>−{attempt.diff.deletions}</span>
            </span>
            {attempt.diff.patchArtifactId && (
              <a href={`/api/artifacts/${attempt.diff.patchArtifactId}`} target="_blank" rel="noreferrer">
                view patch
              </a>
            )}
          </div>
          {attempt.diff.files.slice(0, 20).map((f) => (
            <div key={f.path} className="muted">
              <code>{f.path}</code>{' '}
              <span className="faint">
                +{f.insertions} −{f.deletions}
              </span>
            </div>
          ))}
        </div>
      )}
      {checks.length > 0 && (
        <div className="stack" style={{ gap: 6 }}>
          {checks.map((c) => (
            <details key={c.id}>
              <summary className="row" style={{ cursor: 'pointer' }}>
                <Status value={c.status} /> <strong>{c.name}</strong>
                <span className="faint">
                  {(c.durationMs / 1000).toFixed(1)}s · exit {c.exitCode ?? '—'} · {c.testedSha?.slice(0, 10)}
                </span>
                {c.logArtifactId && (
                  <a href={`/api/artifacts/${c.logArtifactId}`} target="_blank" rel="noreferrer">
                    full log
                  </a>
                )}
              </summary>
              {c.logTail && <pre className="panel panel-body faint">{c.logTail}</pre>}
            </details>
          ))}
        </div>
      )}
    </div>
  )
}

import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useParams } from 'react-router'
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
  const { projectId } = useParams()
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
          {attempt.diff.patchArtifactId && (
            <Patch
              artifactId={attempt.diff.patchArtifactId}
              startOpen={
                attempt.diff.fileCount <= 20 && attempt.diff.insertions + attempt.diff.deletions <= 600
              }
            />
          )}
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
          {checks.some(misconfigured) && (
            <div className="notice small">
              {checks
                .filter(misconfigured)
                .map((c) => c.name)
                .join(', ')}{' '}
              failed before testing anything (the command or a file it needs was not found). That is usually
              the check command, not the change: fix it in the project's{' '}
              <Link to={`/projects/${projectId}`}>repository settings</Link>, then retry.
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const MAX_LINES = 3000

/** The attempt's patch inline, coloured by line kind; patches are immutable artifacts. */
function Patch({ artifactId, startOpen }: { artifactId: string; startOpen: boolean }) {
  const [open, setOpen] = useState(startOpen)
  const patch = useQuery({
    queryKey: ['artifact', artifactId],
    queryFn: async () => {
      const res = await fetch(`/api/artifacts/${artifactId}`)
      if (!res.ok) throw new Error(`patch unavailable (${res.status})`)
      return res.text()
    },
    enabled: open,
    staleTime: Number.POSITIVE_INFINITY,
  })
  const lines = patch.data?.split('\n') ?? []
  return (
    <div className="stack" style={{ gap: 4, marginTop: 6 }}>
      <div>
        <button type="button" className="btn small" onClick={() => setOpen(!open)}>
          {open ? 'Hide diff' : 'Show diff'}
        </button>
      </div>
      {open && patch.error && <div className="error-box">{(patch.error as Error).message}</div>}
      {open && patch.data !== undefined && (
        <pre className="diff">
          {lines.slice(0, MAX_LINES).map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: patch lines have no identity beyond position
            <div key={i} className={lineClass(line)}>
              {line || ' '}
            </div>
          ))}
          {lines.length > MAX_LINES && (
            <div className="faint">… {lines.length - MAX_LINES} more lines in the full patch</div>
          )}
        </pre>
      )}
    </div>
  )
}

function lineClass(line: string): string | undefined {
  if (line.startsWith('diff --git')) return 'file'
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('index ')) return 'meta'
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  return undefined
}

const NOT_STARTED =
  /command not found|ENOENT|Cannot find module|ERR_MODULE_NOT_FOUND|No such file or directory|Missing script|not recognized as an internal/i

/** A failed check whose log says the command itself could not run. */
function misconfigured(c: { status: string; logTail: string | null }): boolean {
  return c.status !== 'passed' && NOT_STARTED.test(c.logTail ?? '')
}

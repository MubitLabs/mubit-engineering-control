import { type RefObject, useId } from 'react'
import { multiline } from './format'
import { type InspectorTab, InspectorTabs } from './InspectorTabs'
import { Button, CloseIcon, IconButton } from './primitives'

export interface Fact {
  label: string
  value: string
  mono?: boolean
}

export interface InspectorAction {
  label: string
  onClick: () => void
}

/** A file an attempt left. The panel shows it as plain text, or says why it does not. */
export interface ArtifactLinkView {
  label: string
  open: boolean
  onToggle: () => void
  panel: { note: string; text: string | null; action?: InspectorAction } | null
}

export interface InspectorChecks {
  /** Only `passed` and `failed` may list results, and only for this scope's exact commit. */
  state: 'not-run' | 'passed' | 'failed' | 'unavailable'
  heading: string
  detail: string
  facts?: readonly Fact[]
  results?: readonly { label: string; detail: string; passed: boolean; artifact?: ArtifactLinkView }[]
}

/** Everything the inspector shows comes from one scope. It has no defaults to fall back on. */
export interface InspectorScope {
  /** A new id means a new subject: the tabs reset to Overview. */
  id: string
  kind: 'task' | 'approval'
  context: string
  title: string
  overview: {
    sections: readonly { heading: string; body: string }[]
    facts: readonly Fact[]
  }
  /** Internal identifiers, folded on the Overview (§18). */
  technical?: readonly Fact[]
  checks: InspectorChecks
  activity: {
    note: string
    entries: readonly {
      key?: string
      when: string
      text: string
      detail?: string | null
      artifacts?: readonly ArtifactLinkView[]
    }[]
    /** Offered when a task has more than one attempt; each reads its own activity. */
    attempts?: readonly { id: string; label: string; selected: boolean; onSelect: () => void }[]
    more?: InspectorAction
    retry?: InspectorAction
  }
  diff: { summary: string; files: readonly { path: string; lines: readonly string[] }[] }
}

function Facts({ facts }: { facts: readonly Fact[] }) {
  return (
    <dl className="facts">
      {facts.map((fact) => (
        <div key={fact.label}>
          <dt>{fact.label}</dt>
          <dd className={fact.value.includes('\n') ? 'fact-text' : fact.mono ? 'mono' : undefined}>
            {fact.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}

function ArtifactLink({ link }: { link: ArtifactLinkView }) {
  const { panel } = link
  return (
    <div className="artifact">
      <Button variant="quiet" aria-expanded={link.open} onClick={link.onToggle}>
        {link.label}
      </Button>
      {panel && (
        <div className="artifact-panel">
          <p>{panel.note}</p>
          {panel.text !== null && <pre>{panel.text}</pre>}
          {panel.action && <Button onClick={panel.action.onClick}>{panel.action.label}</Button>}
        </div>
      )}
    </div>
  )
}

function Evidence({ scope, tab, onAsk }: { scope: InspectorScope; tab: InspectorTab; onAsk?: () => void }) {
  if (tab === 'overview') {
    return (
      <>
        {scope.overview.sections.map((section) => (
          <section key={section.heading}>
            <h3>{section.heading}</h3>
            <p>{section.body}</p>
          </section>
        ))}
        <Facts facts={scope.overview.facts} />
        {scope.technical && scope.technical.length > 0 && (
          <details className="technical">
            <summary>Technical details</summary>
            <Facts facts={scope.technical} />
          </details>
        )}
        {onAsk && <Button onClick={onAsk}>Ask about this work</Button>}
      </>
    )
  }
  if (tab === 'checks') {
    const { heading, detail, facts, results } = scope.checks
    return (
      <>
        <h3>{heading}</h3>
        <p>{detail}</p>
        {facts && <Facts facts={facts} />}
        {results && (
          <ul className="check-list">
            {results.map((result) => (
              <li key={result.label}>
                <span className={result.passed ? 'tone-good' : 'tone-bad'}>
                  {result.passed ? 'Passed' : 'Failed'}
                </span>
                <span>
                  {result.label}
                  {multiline(result.detail) ? (
                    <pre className="check-output">{result.detail}</pre>
                  ) : (
                    <small>{result.detail}</small>
                  )}
                  {result.artifact && <ArtifactLink link={result.artifact} />}
                </span>
              </li>
            ))}
          </ul>
        )}
      </>
    )
  }
  if (tab === 'activity') {
    const { note, entries, attempts, more, retry } = scope.activity
    return (
      <>
        <h3>Recorded activity</h3>
        {attempts && (
          <div className="attempt-choice">
            {attempts.map((attempt) => (
              <Button
                key={attempt.id}
                variant="quiet"
                aria-pressed={attempt.selected}
                onClick={attempt.onSelect}
              >
                {attempt.label}
              </Button>
            ))}
          </div>
        )}
        <p>{note}</p>
        {retry && <Button onClick={retry.onClick}>{retry.label}</Button>}
        {entries.length > 0 && (
          <ol className="timeline">
            {entries.map((entry) => (
              <li key={entry.key ?? `${entry.when}:${entry.text}`}>
                <small>{entry.when}</small>
                {entry.text}
                {entry.detail && (
                  <details className="technical">
                    <summary>Details</summary>
                    <pre>{entry.detail}</pre>
                  </details>
                )}
                {entry.artifacts?.map((link) => (
                  <ArtifactLink key={link.label} link={link} />
                ))}
              </li>
            ))}
          </ol>
        )}
        {more && <Button onClick={more.onClick}>{more.label}</Button>}
      </>
    )
  }
  return (
    <>
      <h3>Changes</h3>
      <p>{scope.diff.summary}</p>
      {scope.diff.files.map((file) => (
        <pre key={file.path}>
          {file.path}
          {file.lines.map((line) => `\n${line}`).join('')}
        </pre>
      ))}
    </>
  )
}

interface InspectorProps {
  scope: InspectorScope
  initialTab?: InspectorTab
  onClose: () => void
  onAsk?: () => void
  titleRef?: RefObject<HTMLHeadingElement | null>
  titleId?: string
}

export function Inspector({ scope, initialTab, onClose, onAsk, titleRef, titleId }: InspectorProps) {
  const ownId = useId()
  return (
    <div className="inspector-content" data-kind={scope.kind}>
      <header className="inspector-head">
        <div>
          <small>{scope.context}</small>
          <h2 ref={titleRef} id={titleId ?? ownId} tabIndex={-1}>
            {scope.title}
          </h2>
        </div>
        <IconButton label="Close details" onClick={onClose}>
          <CloseIcon />
        </IconButton>
      </header>
      <InspectorTabs
        key={scope.id}
        initial={initialTab}
        render={(tab) => <Evidence scope={scope} tab={tab} onAsk={onAsk} />}
      />
    </div>
  )
}

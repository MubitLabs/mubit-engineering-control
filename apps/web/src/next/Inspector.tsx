import { type RefObject, useId } from 'react'
import { type InspectorTab, InspectorTabs } from './InspectorTabs'
import { Button, CloseIcon, IconButton } from './primitives'

export interface Fact {
  label: string
  value: string
  mono?: boolean
}

export interface InspectorChecks {
  /** Only `passed` and `failed` may list results, and only for this scope's exact commit. */
  state: 'not-run' | 'passed' | 'failed' | 'unavailable'
  heading: string
  detail: string
  facts?: readonly Fact[]
  results?: readonly { label: string; detail: string; passed: boolean }[]
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
  checks: InspectorChecks
  activity: { note: string; entries: readonly { when: string; text: string }[] }
  diff: { summary: string; files: readonly { path: string; lines: readonly string[] }[] }
}

function Facts({ facts }: { facts: readonly Fact[] }) {
  return (
    <dl className="facts">
      {facts.map((fact) => (
        <div key={fact.label}>
          <dt>{fact.label}</dt>
          <dd className={fact.mono ? 'mono' : undefined}>{fact.value}</dd>
        </div>
      ))}
    </dl>
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
                  <small>{result.detail}</small>
                </span>
              </li>
            ))}
          </ul>
        )}
      </>
    )
  }
  if (tab === 'activity') {
    return (
      <>
        <h3>Recorded activity</h3>
        <p>{scope.activity.note}</p>
        {scope.activity.entries.length > 0 && (
          <ol className="timeline">
            {scope.activity.entries.map((entry) => (
              <li key={`${entry.when}:${entry.text}`}>
                <small>{entry.when}</small>
                {entry.text}
              </li>
            ))}
          </ol>
        )}
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

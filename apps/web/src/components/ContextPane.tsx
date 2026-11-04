import { useEffect, useRef, useState } from 'react'
import {
  api,
  type DecisionDetail,
  type Question,
  type SlotEntry,
  type TaskDetail,
  type WorkItemDetail,
} from '../api'
import { type ContextDescriptor, useWorkbench } from '../workbench'
import { Btn } from './base'

/**
 * The context pane: the evidence for whatever is selected, one gesture away
 * (§2.2). Opens with focus on its Close button; closing returns focus to the
 * opener. A detail that is not served by the server says so.
 */

export function ContextPane() {
  const wb = useWorkbench()
  const open = wb.context !== null
  const ref = wb.context
  const closeRef = useRef<HTMLButtonElement | null>(null)

  // Opening the pane moves focus to its Close button; closing returns focus to the opener.
  useEffect(() => {
    if (ref !== null) closeRef.current?.focus({ preventScroll: true })
  }, [ref])

  return (
    <aside className="context" id="context" aria-label="Details" hidden={!open} aria-hidden={!open}>
      <header className="context-head">
        <h2 className="context-title" id="context-title">
          Details
        </h2>
        <Btn variant="quiet" className="context-close" ref={closeRef} onClick={() => wb.closeContext()}>
          Close
        </Btn>
      </header>
      <div className="context-body" id="context-body">
        {ref === null ? null : <ContextBody key={`${ref.kind}:${ref.id}`} descriptor={ref} />}
      </div>
    </aside>
  )
}

function ContextBody({ descriptor }: { descriptor: ContextDescriptor }) {
  switch (descriptor.kind) {
    case 'decision':
      return <DecisionBody id={descriptor.id} />
    case 'question':
      return <QuestionBody id={descriptor.id} />
    case 'work':
      return <WorkBody id={descriptor.id} />
    case 'task':
      return <TaskBody id={descriptor.id} />
    case 'slot':
      return <SlotBody id={descriptor.id} />
  }
}

export function Kv({ rows }: { rows: Array<{ label: string; value: string; mono?: boolean }> }) {
  return (
    <dl className="kv">
      {rows.map((row) => (
        <div key={row.label}>
          <dt>{row.label}</dt>
          <dd className={row.mono === true ? 'mono' : ''}>{row.value}</dd>
        </div>
      ))}
    </dl>
  )
}

function DemoNote({ demo }: { demo?: true }) {
  if (demo !== true) return null
  return (
    <p className="muted" style={{ fontSize: 'var(--t-meta)' }}>
      This detail is not served by the server yet — shown from the §23 worked example.
    </p>
  )
}

function DecisionBody({ id }: { id: string }) {
  const [detail, setDetail] = useState<DecisionDetail | null>(null)
  useEffect(() => {
    let alive = true
    api
      .decisionDetail(id)
      .then((d) => alive && setDetail(d))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [id])
  if (detail === null) return <p className="muted">Loading the evidence…</p>

  const head = detail.facts.find((fact) => fact.label === 'Head')?.value ?? 'this commit'
  return (
    <>
      <h3 style={{ fontSize: 'var(--t-lead)', fontWeight: 600, color: 'var(--ink)' }}>{detail.what}</h3>
      <Kv
        rows={[
          ...detail.facts.map((fact) => ({ ...fact })),
          { label: 'Operation', value: detail.operation, mono: true },
          { label: 'Requested by', value: detail.requestedBy },
          { label: 'If you approve', value: detail.consequences.approve },
          { label: 'If you deny', value: detail.consequences.deny },
        ]}
      />
      <h3>Checks on {head}</h3>
      {detail.checks.length === 0 ? (
        <p className="muted">No checks are served for this card yet.</p>
      ) : (
        <ul className="checks">
          {detail.checks.map((check) => (
            <li key={check.name}>
              <span>{check.name}</span>
              <span
                className={
                  check.state === 'passed'
                    ? 'state state-ok'
                    : check.state === 'failed'
                      ? 'state state-bad'
                      : 'state'
                }
              >
                {check.state === 'none'
                  ? (check.note ?? 'not configured')
                  : `${check.state}${check.note ? ` in ${check.note}` : ''}`}
              </span>
            </li>
          ))}
        </ul>
      )}
      <h3>Findings</h3>
      {detail.findings.length === 0 ? (
        <p className="muted">No findings are served for this card yet.</p>
      ) : (
        detail.findings.map((finding) => (
          <div className="finding" key={finding.title}>
            <b>{finding.title}</b>
            {finding.disposition}
          </div>
        ))
      )}
      <h3>Diff: {detail.diff.summary}</h3>
      <pre className="diff">
        {detail.diff.files.map((file) => (
          <span key={file.path}>
            <span className="add">+ {file.path}</span> +{file.added}{' '}
            <span className="del">−{file.removed}</span>
            {'\n'}
          </span>
        ))}
      </pre>
      <DemoNote demo={detail.demo} />
    </>
  )
}

function QuestionBody({ id }: { id: string }) {
  const [question, setQuestion] = useState<Question | null>(null)
  useEffect(() => {
    let alive = true
    api
      .questions()
      .then((all) => alive && setQuestion(all.find((q) => q.id === id) ?? null))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [id])
  if (question === null) return <p className="muted">Loading the question…</p>
  return (
    <>
      <h3 style={{ fontSize: 'var(--t-lead)', fontWeight: 600, color: 'var(--ink)' }}>{question.what}</h3>
      <Kv
        rows={[
          { label: 'Asked by', value: question.eyebrow },
          { label: 'Why', value: question.why },
          ...(question.sideNote === undefined ? [] : [{ label: 'What waits', value: question.sideNote }]),
        ]}
      />
      {question.evidence === undefined ? null : (
        <>
          <h3>Evidence</h3>
          <pre className="diff">{question.evidence.code}</pre>
          <p className="muted" style={{ fontSize: 'var(--t-meta)' }}>
            {question.evidence.note}
          </p>
        </>
      )}
      <DemoNote demo={question.demo} />
    </>
  )
}

function WorkBody({ id }: { id: string }) {
  const [detail, setDetail] = useState<WorkItemDetail | null>(null)
  useEffect(() => {
    let alive = true
    api
      .workItemDetail(id)
      .then((d) => alive && setDetail(d))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [id])
  if (detail === null) return <p className="muted">Loading the work item…</p>
  return (
    <>
      <h3 style={{ fontSize: 'var(--t-lead)', fontWeight: 600, color: 'var(--ink)' }}>{detail.title}</h3>
      <Kv rows={[{ label: 'Stage', value: detail.stage }, ...detail.kv]} />
      {detail.tasks.length > 0 ? (
        <>
          <h3>Tasks</h3>
          <ul className="checks">
            {detail.tasks.map((task) => (
              <li key={task.name}>
                <span>{task.name}</span>
                <span className={task.stateKind === undefined ? 'state' : `state state-${task.stateKind}`}>
                  {task.state}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {detail.handoffs.length > 0 ? (
        <>
          <h3>Handoffs</h3>
          {detail.handoffs.map((handoff) => (
            <div className="finding" key={handoff.title}>
              <b>{handoff.title}</b>
              {handoff.note}
            </div>
          ))}
        </>
      ) : null}
      {detail.soFar === undefined || detail.soFar.length === 0 ? null : (
        <>
          <h3>So far</h3>
          <Kv rows={detail.soFar} />
        </>
      )}
      <DemoNote demo={detail.demo} />
    </>
  )
}

function TaskBody({ id }: { id: string }) {
  const [detail, setDetail] = useState<TaskDetail | null>(null)
  useEffect(() => {
    let alive = true
    api
      .taskDetail(id)
      .then((d) => alive && setDetail(d))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [id])
  if (detail === null) return <p className="muted">Loading the task…</p>
  return (
    <>
      <h3 style={{ fontSize: 'var(--t-lead)', fontWeight: 600, color: 'var(--ink)' }}>{detail.name}</h3>
      <Kv rows={detail.kv} />
      {detail.report === undefined ? null : (
        <>
          <h3>Report</h3>
          <p style={{ fontSize: 'var(--t-meta)' }}>{detail.report}</p>
        </>
      )}
      {detail.note === undefined ? null : (
        <p className="muted" style={{ fontSize: 'var(--t-meta)' }}>
          {detail.note}
        </p>
      )}
      <DemoNote demo={detail.demo} />
    </>
  )
}

function SlotBody({ id }: { id: string }) {
  const wb = useWorkbench()
  const slot = wb.slots.find((entry: SlotEntry) => entry.id === id)
  if (slot === undefined) return <p className="muted">This slot is no longer listed.</p>
  return (
    <>
      <h3 style={{ fontSize: 'var(--t-lead)', fontWeight: 600, color: 'var(--ink)' }}>{slot.label}</h3>
      <Kv
        rows={[
          { label: 'Engine', value: slot.engine },
          { label: 'Provider', value: slot.provider },
          { label: 'State', value: slot.state },
          ...(slot.stateReason === undefined ? [] : [{ label: 'Reason', value: slot.stateReason }]),
          ...(slot.fingerprint === undefined
            ? []
            : [{ label: 'Key', value: `…${slot.fingerprint.last4} (fingerprint only)`, mono: true }]),
          ...(slot.usage === undefined
            ? [{ label: 'Usage', value: 'not served by the server yet' }]
            : slot.usage.kind === 'unknown'
              ? [{ label: 'Usage', value: `no reading yet — ${slot.usage.reason}` }]
              : (slot.usage.lines?.map((line) => ({ label: 'Usage', value: line })) ?? [])),
        ]}
      />
      <p className="muted" style={{ fontSize: 'var(--t-meta)' }}>
        Keys and logins stay on this machine; MEC keeps only a fingerprint.
      </p>
    </>
  )
}

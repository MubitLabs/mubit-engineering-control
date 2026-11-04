import { useEffect, useRef } from 'react'
import type { ChatMessage, ChatPlan, PlanTaskRow } from '../api'
import { parseHash } from '../router'
import { useWorkbench } from '../workbench'
import { formatClock } from './base'

/**
 * The conversation is the interface (§2.3): a user message carries the ink bar,
 * an agent answer is a larger sentence, status lines are quiet, notices are
 * tinted blocks, and a plan is a table. Nothing animates in; the list grows.
 */

export function Conversation({ messages, pending }: { messages: ChatMessage[]; pending: ChatMessage[] }) {
  const wb = useWorkbench()
  const endRef = useRef<HTMLDivElement | null>(null)
  const rowCount = messages.length + pending.length
  const hasPending = pending.length > 0

  // The prototype scrolls the newest message into view when the person sends one
  // (not on load — history renders from the top), and snaps the resting scroll
  // to a whole pixel so captures rasterize identically.
  useEffect(() => {
    if (!hasPending || rowCount === 0) return
    const scroll = () => {
      endRef.current?.scrollIntoView({ block: 'end' })
      const main = endRef.current?.closest('.main')
      if (main !== null && main !== undefined) main.scrollTop = Math.round(main.scrollTop)
    }
    scroll()
    document.fonts?.ready.then(() => requestAnimationFrame(scroll))
  }, [hasPending, rowCount])

  if (messages.length === 0 && pending.length === 0) {
    return (
      <div className="empty-hint">
        <p className="muted">
          Ask for something in this repository — the meta agent answers here, plans here, and brings you only
          what needs a person.
        </p>
        <button
          type="button"
          className="link"
          onClick={() =>
            wb.composerPrefillSet(
              'Add audit-log viewing to the console and expose it through the API. It should have tests.',
            )
          }
        >
          Try: “Add audit-log viewing to the console and expose it through the API. It should have tests.”
        </button>
      </div>
    )
  }

  return (
    <ol className="conversation" id="conversation" aria-label="Conversation">
      {messages.map((message) => (
        <MessageRow key={message.id} message={message} />
      ))}
      {pending.map((message) => (
        <MessageRow key={message.id} message={message} pending />
      ))}
      <div ref={endRef} />
    </ol>
  )
}

function MessageRow({ message, pending = false }: { message: ChatMessage; pending?: boolean }) {
  const wb = useWorkbench()
  if (message.plan !== undefined) return <PlanCard plan={message.plan} />

  const kind = message.kind ?? 'plain'
  // A message the server sent without a kind renders as a quiet line — never guessed.
  const cls = `msg msg-${kind === 'plain' ? 'status' : kind}`
  return (
    <li className={cls}>
      <p>{message.text}</p>
      <p className="msg-meta">
        {message.meta === undefined ? null : <span>{message.meta}</span>}
        <time>{pending ? 'sending…' : formatClock(message.createdAt)}</time>
        {message.noticeRoute === undefined ? null : (
          <button
            type="button"
            className="link"
            onClick={() => wb.navigate(parseHash(`#${message.noticeRoute?.route}`))}
          >
            {message.noticeRoute.label}
          </button>
        )}
      </p>
    </li>
  )
}

function PlanCard({ plan }: { plan: ChatPlan }) {
  return (
    <li className="msg msg-card">
      <article className="plan" aria-labelledby="plan-card-title">
        <header className="plan-head">
          <h3 id="plan-card-title">{plan.title}</h3>
          {plan.approvedNote === undefined ? null : <p className="muted">{plan.approvedNote}</p>}
        </header>
        <table className="plan-table">
          <thead>
            <tr>
              <th>Task</th>
              <th>Role</th>
              <th>Tier</th>
              <th>Slot</th>
              <th>State</th>
            </tr>
          </thead>
          <tbody>
            {plan.tasks.map((task) => (
              <PlanRow key={task.id} task={task} />
            ))}
          </tbody>
        </table>
        {plan.note === undefined ? null : <p className="plan-note">{plan.note}</p>}
      </article>
    </li>
  )
}

function PlanRow({ task }: { task: PlanTaskRow }) {
  const wb = useWorkbench()
  return (
    <tr
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          wb.openContext({ kind: 'task', id: task.id })
        }
      }}
      onClick={() => wb.openContext({ kind: 'task', id: task.id })}
    >
      <td>{task.task}</td>
      <td>{task.role}</td>
      <td>
        <span className="tier">{task.tier}</span>
      </td>
      <td>{task.slot}</td>
      <td>
        <span className={task.stateKind === undefined ? 'state' : `state state-${task.stateKind}`}>
          {task.state}
        </span>
      </td>
    </tr>
  )
}

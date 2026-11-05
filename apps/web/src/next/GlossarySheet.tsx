import { useState } from 'react'
import { IconButton } from './primitives'
import { Sheet } from './Sheet'

/** §1's concepts, in the words the shell uses. §18 asks for a (?) button that opens these. */
const CONCEPTS: readonly { term: string; meaning: string }[] = [
  { term: 'Engine', meaning: 'A coding agent MEC runs, such as Claude Code, Codex or OpenCode.' },
  { term: 'Provider', meaning: 'Whoever serves the model behind an engine.' },
  { term: 'Connection (slot)', meaning: 'One engine, one provider and one credential, in its own home.' },
  { term: 'Conversation', meaning: 'Your chat with the meta agent, one for each repository.' },
  { term: 'Delivery (work item)', meaning: 'One request, followed through to its outcome.' },
  { term: 'Mandate', meaning: 'What a delivery was authorised to do.' },
  { term: 'Plan', meaning: 'The tasks of a delivery and how they depend on each other.' },
  { term: 'Task', meaning: 'One piece of a plan, given to one specialist role.' },
  { term: 'Attempt', meaning: 'One run at a task, in its own isolated worktree.' },
  {
    term: 'Approval (confirmation)',
    meaning: 'The card that asks you before a push, a pull request or a merge.',
  },
  { term: 'Report', meaning: 'What a specialist says when it stops: ready, blocked, failed or waiting.' },
  { term: 'Question', meaning: 'One structured question that a delivery needs you to answer.' },
]

export function GlossaryButton() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <IconButton label="Open glossary" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <span aria-hidden="true">?</span>
      </IconButton>
      {open && (
        <Sheet variant="dialog" title="Glossary" onClose={() => setOpen(false)}>
          <dl className="facts glossary">
            {CONCEPTS.map((concept) => (
              <div key={concept.term}>
                <dt>{concept.term}</dt>
                <dd>{concept.meaning}</dd>
              </div>
            ))}
          </dl>
        </Sheet>
      )}
    </>
  )
}

import { type ReactNode, useState } from 'react'
import {
  type BackupsRecord,
  type Capabilities,
  capabilityGate,
  type DiffLine,
  type DraftView,
  type Editor,
  foldDiff,
  lineDiff,
  type ModelsText,
  type PolicyView,
  type PromptPartView,
  type RepositoryView,
  saveBar,
} from './config-model'
import { Button } from './primitives'
import { BOOTSTRAP_HINT, CHECKS_HINT } from './RepositoryForm'
import { SaveBar } from './SaveBar'

export const SETTINGS_SECTIONS = ['policy', 'prompts', 'models', 'repositories', 'backups'] as const
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]

const SECTION_LABELS: Record<SettingsSection, string> = {
  policy: 'Policy',
  prompts: 'Prompts',
  models: 'Models',
  repositories: 'Repositories',
  backups: 'Backups',
}

/** The five blocks and the list beside them. Everything here is reachable with a failed block. */
export function SettingsFrame({
  section,
  onSection,
  unsaved,
  children,
}: {
  section: SettingsSection
  onSection: (section: SettingsSection) => void
  /** Sections holding a draft: leaving one never loses it silently. */
  unsaved: ReadonlySet<SettingsSection>
  children: ReactNode
}) {
  return (
    <div className="page">
      <div className="page-header">
        <h1 tabIndex={-1}>Settings</h1>
      </div>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {SETTINGS_SECTIONS.map((entry) => (
            <button
              key={entry}
              type="button"
              className="nav-item"
              aria-current={entry === section ? 'page' : undefined}
              onClick={() => onSection(entry)}
            >
              {SECTION_LABELS[entry]}
              {unsaved.has(entry) && <span className="draft-mark">Unsaved</span>}
            </button>
          ))}
        </nav>
        <div className="settings-body">{children}</div>
      </div>
    </div>
  )
}

export function ReadError({ what, detail, onRetry }: { what: string; detail: string; onRetry: () => void }) {
  return (
    <div className="notice notice-error" role="alert">
      <h3>Could not load {what}</h3>
      <p>{detail}</p>
      <Button onClick={onRetry}>Try again</Button>
    </div>
  )
}

/** A chat suggestion changes nothing here until Apply, and Apply takes the manual save's path. */
export function Proposals({
  drafts,
  busyId,
  error,
  onApply,
  onDismiss,
}: {
  drafts: readonly DraftView[]
  busyId: string | null
  error: string | null
  onApply: (id: string) => void
  onDismiss: (id: string) => void
}) {
  if (drafts.length === 0) return null
  return (
    <section className="proposals" aria-label="Proposed changes">
      <h2>Proposed in setup chat</h2>
      {error !== null && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {drafts.map((draft) => (
        <article key={draft.id} className="proposal">
          <p>{draft.reason}</p>
          {draft.preview === undefined ? (
            <pre className="code-block">{draft.diff}</pre>
          ) : (
            draft.preview.changes.map((change) => (
              <div key={change.label}>
                <p className="field-note mono">{change.label}</p>
                <DiffView lines={lineDiff(change.before, change.after)} />
              </div>
            ))
          )}
          {draft.trustIgnored === true && (
            <p className="field-note">
              This proposal asks to set trust, and Apply will not. It starts untrusted. Trust it here under
              Repositories, in two steps.
            </p>
          )}
          <p className="field-note">Nothing has changed. Apply checks this the way a save does.</p>
          <div className="form-actions">
            <Button variant="quiet" disabled={busyId === draft.id} onClick={() => onDismiss(draft.id)}>
              Dismiss
            </Button>
            <Button variant="primary" disabled={busyId === draft.id} onClick={() => onApply(draft.id)}>
              {busyId === draft.id ? 'Applying…' : 'Apply'}
            </Button>
          </div>
        </article>
      ))}
    </section>
  )
}

interface EditorProps {
  editor: Editor
  onEdit: (text: string) => void
  onSave: () => void
  onDiscard: () => void
  onUseNewest: () => void
}

function TextBlock({ label, rows, ...props }: EditorProps & { label: string; rows: number }) {
  const { editor, onEdit, onSave, onDiscard, onUseNewest } = props
  return (
    <>
      <label className="field">
        {label}
        <textarea
          className="code-input"
          rows={rows}
          spellCheck={false}
          value={editor.draft ?? editor.base}
          onChange={(event) => onEdit(event.target.value)}
        />
      </label>
      {editor.save.kind === 'saved' && (
        <p className="muted" role="status">
          Saved.
        </p>
      )}
      <SaveBar view={saveBar(editor)} onSave={onSave} onDiscard={onDiscard} onUseNewest={onUseNewest} />
    </>
  )
}

const shortHash = (sha: string): string => sha.slice(0, 12)

export function PolicyBlock({
  policy,
  proposals,
  ...editor
}: EditorProps & { policy: PolicyView; proposals: ReactNode }) {
  return (
    <section className="config-block" aria-label="Policy">
      <h2>Policy</h2>
      <p className="muted">
        What MEC may do without asking. Push, PR and merge always ask, and no policy can change that.
      </p>
      <dl className="facts-grid">
        <div>
          <dt>Version</dt>
          <dd className="mono">{shortHash(policy.sha256)}</dd>
        </div>
        <div>
          <dt>Revision</dt>
          <dd>{policy.source === 'saved' ? policy.revision : 'Default, never saved'}</dd>
        </div>
      </dl>
      {policy.restartRequired ? (
        <div className="notice notice-blocked">
          <h3>Saved, not yet in force</h3>
          <p>
            MEC is running version {shortHash(policy.activeSha256)}. This version applies to new work after
            the next restart. Tasks still queued on work admitted under the old version are then blocked for
            review, not run.
          </p>
        </div>
      ) : (
        <p className="muted">A saved edit applies to new work after the next restart.</p>
      )}
      {proposals}
      <TextBlock label="Policy file" rows={12} {...editor} />
    </section>
  )
}

export function ModelsBlock({
  models,
  proposals,
  ...editor
}: EditorProps & { models: ModelsText; proposals: ReactNode }) {
  return (
    <section className="config-block" aria-label="Models">
      <h2>Models</h2>
      <p className="muted">
        {models.source === 'user' ? 'Your table' : 'The shipped table'}, version{' '}
        <span className="mono">{shortHash(models.sha256)}</span>.
      </p>
      {proposals}
      <TextBlock label="Capability table" rows={18} {...editor} />
    </section>
  )
}

function DiffText({ line }: { line: DiffLine }) {
  return (
    <span className={`diff-${line.kind}`}>
      {line.kind === 'added' ? '+ ' : line.kind === 'removed' ? '- ' : '  '}
      {line.text}
      {'\n'}
    </span>
  )
}

function DiffFold({ lines }: { lines: readonly DiffLine[] }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" className="diff-fold" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? 'Hide' : 'Show'} {lines.length} unchanged lines
      </button>
      {open &&
        lines.map((line, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a diff's lines repeat and never reorder.
          <DiffText key={index} line={line} />
        ))}
    </>
  )
}

function DiffView({ lines }: { lines: readonly DiffLine[] }) {
  return (
    <pre className="code-block diff">
      {foldDiff(lines).map((row, index) =>
        row.kind === 'fold' ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: a diff's rows repeat and never reorder.
          <DiffFold key={index} lines={row.lines} />
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: a diff's rows repeat and never reorder.
          <DiffText key={index} line={row} />
        ),
      )}
    </pre>
  )
}

export type PromptCompare =
  | { kind: 'none' }
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'diff'; title: string; before: string; after: string }
  | { kind: 'full'; title: string; text: string }

export function PromptsBlock({
  parts,
  selected,
  revision,
  unsavedParts,
  compare,
  proposals,
  onSelect,
  onCompareDefault,
  onCompareUpdate,
  onCompareRevision,
  onFullPrompt,
  ...editor
}: EditorProps & {
  parts: readonly PromptPartView[]
  selected: PromptPartView | null
  revision: number
  unsavedParts: ReadonlySet<string>
  compare: PromptCompare
  proposals: ReactNode
  onSelect: (path: string) => void
  onCompareDefault: () => void
  /** What the shipped default changed from, for a part marked Default updated (§16.3). */
  onCompareUpdate: () => void
  onCompareRevision: (n: number) => void
  onFullPrompt: () => void
}) {
  const layers = [...new Set(parts.map((part) => part.layer))]
  const [picked, setPicked] = useState('')
  const pickedRevision = picked === '' ? revision : Number(picked)
  return (
    <section className="config-block" aria-label="Prompts">
      <h2>Prompts</h2>
      <p className="muted">
        Revision {revision}. Your text stays when defaults change, and running attempts keep theirs.
      </p>
      {proposals}
      <div className="parts-layout">
        <ul className="part-list" aria-label="Prompt parts">
          {layers.map((layer) => (
            <li key={layer}>
              <h3>{layer}</h3>
              <ul>
                {parts
                  .filter((part) => part.layer === layer)
                  .map((part) => (
                    <li key={part.path}>
                      <button
                        type="button"
                        className="nav-item"
                        aria-current={part.path === selected?.path ? 'true' : undefined}
                        onClick={() => onSelect(part.path)}
                      >
                        {part.name}
                        {unsavedParts.has(part.path) ? (
                          <span className="draft-mark">Unsaved</span>
                        ) : part.defaultUpdated ? (
                          <span className="draft-mark">Default updated</span>
                        ) : part.edited ? (
                          <span className="draft-mark">Edited</span>
                        ) : null}
                      </button>
                    </li>
                  ))}
              </ul>
            </li>
          ))}
        </ul>
        {selected ? (
          <div className="part-editor">
            <p className="muted">
              {selected.path}, {selected.provenance}
            </p>
            <TextBlock label={`${selected.name} text`} rows={14} {...editor} />
            <div className="form-actions compare-actions">
              <Button onClick={onCompareDefault}>Compare with default</Button>
              {selected.defaultUpdated && (
                <Button onClick={onCompareUpdate}>What changed in the default</Button>
              )}
              {revision > 0 && (
                <>
                  <label className="field field-inline">
                    Revision
                    <input
                      type="number"
                      min={1}
                      max={revision}
                      value={pickedRevision}
                      onChange={(event) => setPicked(event.target.value)}
                    />
                  </label>
                  <Button onClick={() => onCompareRevision(pickedRevision)}>Compare with revision</Button>
                </>
              )}
              {selected.layer === 'role' && <Button onClick={onFullPrompt}>Full prompt</Button>}
            </div>
            {compare.kind === 'loading' && <p className="muted">Loading the comparison…</p>}
            {compare.kind === 'failed' && (
              <p className="field-error" role="alert">
                {compare.message}
              </p>
            )}
            {compare.kind === 'diff' && (
              <>
                <h3>{compare.title}</h3>
                <DiffView lines={lineDiff(compare.before, compare.after)} />
              </>
            )}
            {compare.kind === 'full' && (
              <>
                <h3>{compare.title}</h3>
                <pre className="code-block">{compare.text}</pre>
              </>
            )}
          </div>
        ) : (
          <p className="muted">Choose a part to edit it.</p>
        )}
      </div>
    </section>
  )
}

function TrustControl({
  repository,
  busy,
  onSetTrust,
}: {
  repository: RepositoryView
  busy: boolean
  onSetTrust: (trust: boolean) => void
}) {
  const [armed, setArmed] = useState(false)
  const next = !repository.trust
  return (
    <div className="trust">
      <p>
        {repository.trust
          ? 'Trusted: engines honour this repository’s own configuration.'
          : 'Untrusted: engines ignore this repository’s own configuration.'}
      </p>
      {armed ? (
        <form
          className="armed-panel armed-danger"
          onSubmit={(event) => {
            event.preventDefault()
            setArmed(false)
            onSetTrust(next)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation()
              setArmed(false)
            }
          }}
        >
          <p>
            {next
              ? 'Engines will honour its hooks, MCP servers, plugins and settings. Those can run commands on this machine.'
              : 'Engines will stop honouring its hooks, MCP servers, plugins and settings.'}
          </p>
          <div className="form-actions">
            <Button variant="quiet" onClick={() => setArmed(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={busy}>
              {next ? 'Trust this repository' : 'Stop trusting it'}
            </Button>
          </div>
        </form>
      ) : (
        <Button onClick={() => setArmed(true)}>{next ? 'Trust…' : 'Remove trust…'}</Button>
      )}
    </div>
  )
}

export interface RepositoryEditorProps {
  repository: RepositoryView
  bootstrap: EditorProps
  checks: EditorProps
  trustBusy: boolean
  trustError: string | null
  isolation: { editable: boolean; reason: string | null }
  onSetTrust: (trust: boolean) => void
}

export function RepositoryEditor({
  repository,
  bootstrap,
  checks,
  trustBusy,
  trustError,
  isolation,
  onSetTrust,
}: RepositoryEditorProps) {
  return (
    <article className="repository">
      <h3 className="mono">{repository.url}</h3>
      <p className="field-note">
        Edits apply to new work. Work admitted under the old commands is refused at its next launch.
      </p>
      <TextBlock label="Bootstrap commands" rows={2} {...bootstrap} />
      <small className="muted">{BOOTSTRAP_HINT}</small>
      <TextBlock label="Check profile" rows={3} {...checks} />
      <small className="muted">{CHECKS_HINT}</small>
      <h4>Trust</h4>
      <TrustControl repository={repository} busy={trustBusy} onSetTrust={onSetTrust} />
      {trustError !== null && (
        <p className="field-error" role="alert">
          {trustError}
        </p>
      )}
      <h4>Isolation profile</h4>
      <p className="muted">
        The default profile, the same for every repository. {isolation.editable ? null : isolation.reason}
      </p>
    </article>
  )
}

export function RepositoriesBlock({
  adding,
  onAdd,
  form,
  proposals,
  children,
}: {
  adding: boolean
  onAdd: () => void
  form: ReactNode
  proposals: ReactNode
  children: ReactNode
}) {
  return (
    <section className="config-block" aria-label="Repositories">
      <div className="block-head">
        <h2>Repositories</h2>
        {!adding && <Button onClick={onAdd}>Add repository</Button>}
      </div>
      {adding && form}
      {proposals}
      {children}
    </section>
  )
}

export function BackupsBlock({
  capabilities,
  record,
  busy,
  result,
  onBackup,
}: {
  capabilities: Capabilities | null
  record: BackupsRecord | null
  busy: boolean
  result: { ok: boolean; message: string } | null
  onBackup: () => void
}) {
  const gate = capabilityGate(capabilities, 'backups')
  return (
    <section className="config-block" aria-label="Backups">
      <h2>Backups</h2>
      <p className="muted">
        {record?.lastAt ? `Last backup ${record.lastAt}.` : 'No backup has been taken from here yet.'}
      </p>
      {record && (
        <>
          <p className="muted">{record.note}</p>
          <p className="muted">{record.excluded}</p>
        </>
      )}
      {!gate.enabled && <p className="field-note">{gate.reason}</p>}
      {result && (
        <p className={result.ok ? 'muted' : 'field-error'} role={result.ok ? 'status' : 'alert'}>
          {result.message}
        </p>
      )}
      <div className="form-actions">
        <Button disabled={!gate.enabled || busy} onClick={onBackup}>
          {busy ? 'Backing up…' : 'Back up now'}
        </Button>
      </div>
    </section>
  )
}

import { useEffect, useState } from 'react'
import { api, type ModelTiers, type PromptPart } from '../api'
import { Btn } from './base'

/** Settings: the nav, the prompt part list and editor with its save bar, the model tier table. */

export type SettingsSection = 'policy' | 'prompts' | 'models' | 'repos' | 'backups'

const SECTIONS: Array<{ key: SettingsSection; label: string }> = [
  { key: 'policy', label: 'Policy' },
  { key: 'prompts', label: 'Prompts' },
  { key: 'models', label: 'Models' },
  { key: 'repos', label: 'Repositories' },
  { key: 'backups', label: 'Backups' },
]

export function SettingsNav({
  active,
  onSelect,
}: {
  active: SettingsSection
  onSelect: (section: SettingsSection) => void
}) {
  return (
    <nav className="settings-nav" aria-label="Settings sections">
      {SECTIONS.map((section) => (
        <button
          key={section.key}
          type="button"
          className={`settings-link${active === section.key ? ' is-active' : ''}`}
          aria-current={active === section.key ? 'true' : undefined}
          onClick={() => onSelect(section.key)}
        >
          {section.label}
        </button>
      ))}
    </nav>
  )
}

export function PartList({
  parts,
  selectedId,
  onSelect,
}: {
  parts: PromptPart[]
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  const layers: Array<[string, PromptPart[]]> = []
  for (const part of parts) {
    const last = layers.at(-1)
    if (last !== undefined && last[0] === part.layer) last[1].push(part)
    else layers.push([part.layer, [part]])
  }
  return (
    <ul className="part-list" aria-label="Prompt parts">
      {layers.map(([layer, layerParts]) => (
        <li key={layer}>
          <span className="sr-only">{layer}</span>
          <ul>
            <li className="part-group" aria-hidden="true">
              {layer}
            </li>
            {layerParts.map((part) => (
              <li
                key={part.id}
                className={`part${selectedId === part.id ? ' is-active' : ''}`}
                // biome-ignore lint/a11y/noNoninteractiveTabindex: the part row is selectable from the keyboard (Enter) exactly like the list it replaces.
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    onSelect(part.id)
                  }
                }}
                onClick={() => onSelect(part.id)}
              >
                <span>{part.name}</span>
                {part.edited === true ? <span className="mark">edited</span> : null}
                {part.defaultUpdated === true ? (
                  <span className="mark mark-attn">Default updated</span>
                ) : null}
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  )
}

export function PartEditor({ part, onSaved }: { part: PromptPart; onSaved: (note: string) => void }) {
  const [draft, setDraft] = useState(part.text ?? '')
  const [savedNote, setSavedNote] = useState<string | null>(null)

  useEffect(() => {
    setDraft(part.text ?? '')
    setSavedNote(null)
  }, [part])

  const dirty = draft !== (part.text ?? '')

  return (
    <div className="editor">
      <header className="editor-head">
        <h3>
          {part.layer}: {part.name}
        </h3>
        {part.provenance === undefined ? null : <p className="muted">{part.provenance}</p>}
        <div className="editor-tools">
          <Btn
            variant="quiet"
            onClick={() => onSaved('Compare with new default is not served by the server yet.')}
          >
            Compare with new default
          </Btn>
          <Btn
            variant="quiet"
            onClick={() => onSaved('Use the new default is not served by the server yet.')}
          >
            Use the new default
          </Btn>
          <Btn
            variant="quiet"
            onClick={() => onSaved('The full prompt view is not served by the server yet.')}
          >
            Full prompt
          </Btn>
        </div>
      </header>
      <textarea
        className="editor-text"
        rows={12}
        aria-label={`${part.name} part`}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      <div className="savebar" hidden={!dirty}>
        <p>{savedNote ?? 'Unsaved changes'}</p>
        <div>
          <Btn variant="quiet" onClick={() => setDraft(part.text ?? '')}>
            Discard
          </Btn>
          <Btn
            variant="primary"
            onClick={() => {
              setSavedNote(
                'Saved in this session. Revisions are not served by the server yet — running attempts keep their revision.',
              )
              onSaved('Saved in this session (revisions are not served by the server yet).')
            }}
          >
            Save
          </Btn>
        </div>
      </div>
    </div>
  )
}

export function TierTable() {
  const [tiers, setTiers] = useState<ModelTiers | null>(null)

  useEffect(() => {
    let alive = true
    api
      .models()
      .then((t) => {
        if (alive) setTiers(t)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  if (tiers === null) return <p className="muted">Loading the tier ladder…</p>

  return (
    <>
      <table className="tiers">
        <thead>
          <tr>
            <th>Tier</th>
            {tiers.providers.map((provider) => (
              <th key={provider}>{provider}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {tiers.rows.map((row) => (
            <tr key={row.tier}>
              <th>{row.tier}</th>
              {row.cells.map((cell, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: the tier matrix is positional; repeated "—" placeholder cells make text keys collide.
                <td key={index}>
                  {cell === undefined ? (
                    <span className="muted">—</span>
                  ) : (
                    <>
                      {cell.text}
                      {cell.note === undefined ? null : <span className="muted"> {cell.note}</span>}
                    </>
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted">
        {tiers.note}
        {tiers.demo === true
          ? ' The tier table is not served by the server yet — shown from the §23 worked example.'
          : ''}
      </p>
    </>
  )
}

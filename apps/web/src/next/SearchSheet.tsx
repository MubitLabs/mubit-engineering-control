import { useRef } from 'react'
import { Sheet } from './Sheet'
import { StateNotice } from './states'
import type { SearchRowView, SurfaceState } from './work-model'

interface SearchSheetProps {
  query: string
  onQuery: (query: string) => void
  surface: SurfaceState
  rows: readonly SearchRowView[]
  /** Navigates and selects. It has no route to the composer's intent or send target. */
  onChoose: (row: SearchRowView) => void
  onRetry: () => void
  onClose: () => void
}

export function SearchSheet({ query, onQuery, surface, rows, onChoose, onRetry, onClose }: SearchSheetProps) {
  const input = useRef<HTMLInputElement>(null)
  const typed = query.trim() !== ''
  return (
    <Sheet variant="dialog" title="Search" onClose={onClose} initialFocus={input}>
      <input
        ref={input}
        className="palette-input"
        type="search"
        aria-label="Search messages, work, tasks and references"
        placeholder="Text, a title, #12, a URL or a commit"
        value={query}
        onChange={(event) => onQuery(event.target.value)}
      />
      {surface.state === 'failed' && (
        <StateNotice
          kind="error"
          title="Search could not run"
          body={surface.message ?? 'The search did not answer.'}
          action={{ label: 'Retry', onClick: onRetry }}
        />
      )}
      {surface.state === 'loading' && <p role="status">Searching.</p>}
      {typed && surface.state === 'empty' && <p role="status">No match for that search.</p>}
      {rows.length > 0 && (
        <ul className="search-results">
          {rows.map((row) => (
            <li key={row.key}>
              <button type="button" className="choice" onClick={() => onChoose(row)}>
                {row.title}
                <small>{row.detail}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  )
}

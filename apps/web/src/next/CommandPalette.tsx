import { type KeyboardEvent, useId, useRef, useState } from 'react'
import { commandMatches, searchOffer } from './command-search'
import { isSubmitEnter } from './keyboard'
import { Sheet } from './Sheet'

export interface Command {
  id: string
  label: string
  /** Shown beside the label, such as the current choice. */
  hint?: string
  run: () => void
}

/** A filter over routes and actions. Work is not a command: it hands those words to `onSearch`. */
export function CommandPalette({
  commands,
  onClose,
  onSearch,
}: {
  commands: readonly Command[]
  onClose: (after?: () => void) => void
  /** Present once something can answer a search. */
  onSearch?: (query: string) => void
}) {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const base = useId()

  const offer = searchOffer(query, onSearch !== undefined)
  const matches: readonly Command[] = [
    ...commandMatches(commands, query),
    ...(offer === null
      ? []
      : [{ id: 'search-work', label: offer.label, run: () => onSearch?.(offer.query) }]),
  ]
  const active = Math.min(index, Math.max(0, matches.length - 1))

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      if (matches.length > 0) setIndex((active + step + matches.length) % matches.length)
      return
    }
    if (!isSubmitEnter(event.nativeEvent)) return
    event.preventDefault()
    const command = matches[active]
    if (command) onClose(command.run)
  }

  const optionId = (position: number) => `${base}-option-${position}`
  return (
    <Sheet variant="palette" labelledBy={`${base}-title`} onClose={onClose} initialFocus={input} palette>
      <h2 id={`${base}-title`} className="sr-only">
        Commands
      </h2>
      <input
        ref={input}
        className="palette-input"
        type="text"
        role="combobox"
        aria-label="Search commands and work"
        aria-expanded="true"
        aria-controls={`${base}-list`}
        aria-autocomplete="list"
        aria-activedescendant={matches.length > 0 ? optionId(active) : undefined}
        placeholder="Search commands and work"
        autoComplete="off"
        spellCheck={false}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value)
          setIndex(0)
        }}
        onKeyDown={onKeyDown}
      />
      <div id={`${base}-list`} className="palette-list" role="listbox" aria-label="Commands">
        {matches.map((command, position) => (
          // Keyboard users stay in the input and drive these through aria-activedescendant.
          // biome-ignore lint/a11y/useKeyWithClickEvents: the input owns the keyboard
          <div
            key={command.id}
            id={optionId(position)}
            className="choice"
            role="option"
            tabIndex={-1}
            aria-selected={position === active}
            onClick={() => onClose(command.run)}
            onPointerMove={() => setIndex(position)}
          >
            {command.label}
            {command.hint && <small>{command.hint}</small>}
          </div>
        ))}
      </div>
      {matches.length === 0 && <p className="palette-empty">No matching commands</p>}
    </Sheet>
  )
}

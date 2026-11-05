import { useEffect, useMemo, useRef, useState } from 'react'
import { type Route, routeToHash } from '../router'
import { useWorkbench } from '../workbench'

/**
 * ⌘K — the command palette: routes, theme, the operator commands, and the open
 * work items. Arrow keys move, Enter runs, Esc closes (the global chain).
 */

type Command = {
  id: string
  label: string
  hint?: string
  run: () => void
}

export function Palette() {
  const wb = useWorkbench()
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (wb.paletteOpen) {
      setQuery('')
      setIndex(0)
      inputRef.current?.focus()
    }
  }, [wb.paletteOpen])

  const commands = useMemo<Command[]>(() => {
    const routes: Array<{ route: Route; label: string; hint?: string }> = [
      { route: 'chat', label: 'Open Chat', hint: 'G C' },
      { route: 'needs', label: 'Open Needs you', hint: 'G N' },
      { route: 'work', label: 'Open Work', hint: 'G W' },
      { route: 'slots', label: 'Open Slots', hint: 'G S' },
      { route: 'setup', label: 'Open Setup' },
      { route: 'settings', label: 'Open Settings' },
    ]
    const list: Command[] = routes.map((r) => ({
      id: `route-${r.route}`,
      label: r.label,
      hint: r.hint,
      run: () => wb.navigate(r.route),
    }))
    list.push({
      id: 'theme',
      label: wb.theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme',
      run: () => wb.setTheme(wb.theme === 'dark' ? 'light' : 'dark'),
    })
    list.push(
      wb.status?.runtime.state === 'paused'
        ? { id: 'resume', label: 'Resume processing', run: () => void wb.resumeProcessing() }
        : { id: 'pause', label: 'Pause all processing', run: () => void wb.pauseProcessing() },
    )
    list.push({ id: 'backup', label: 'Back up now', run: () => void wb.backupNow() })
    for (const item of wb.work) {
      if (item.state === 'done' || item.state === 'stopped') continue
      list.push({
        id: `work-${item.id}`,
        label: `${item.id} — work item`,
        run: () => {
          wb.navigate('work')
          wb.openContext({ kind: 'work', id: item.id })
        },
      })
    }
    return list
  }, [wb])

  const filtered = commands.filter((command) => command.label.toLowerCase().includes(query.toLowerCase()))
  const selected = filtered[Math.min(index, filtered.length - 1)]

  if (!wb.paletteOpen) return null

  return (
    <div className="palette" id="palette" role="dialog" aria-modal="true" aria-label="Commands">
      <input
        ref={inputRef}
        type="text"
        id="palette-input"
        placeholder="Type a command or a work item"
        autoComplete="off"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value)
          setIndex(0)
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            setIndex((i) => Math.min(filtered.length - 1, i + 1))
          } else if (event.key === 'ArrowUp') {
            event.preventDefault()
            setIndex((i) => Math.max(0, i - 1))
          } else if (event.key === 'Enter') {
            event.preventDefault()
            if (selected !== undefined) {
              selected.run()
              wb.closePalette()
            }
          }
        }}
      />
      <ul className="palette-list">
        {filtered.map((command, i) => (
          <li key={command.id}>
            <button
              type="button"
              className={i === index ? 'is-selected' : ''}
              onClick={() => {
                command.run()
                wb.closePalette()
              }}
              onMouseEnter={() => setIndex(i)}
            >
              {command.label}
              {command.hint === undefined ? null : <kbd>{command.hint}</kbd>}
            </button>
          </li>
        ))}
        {filtered.length === 0 ? (
          <li className="muted" style={{ padding: '10px 24px' }}>
            No command matches.
          </li>
        ) : null}
      </ul>
    </div>
  )
}

export function routeHref(route: Route): string {
  return routeToHash(route)
}

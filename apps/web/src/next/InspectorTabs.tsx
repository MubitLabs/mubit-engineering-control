import { type KeyboardEvent, type ReactNode, useId, useRef, useState } from 'react'

export const INSPECTOR_TABS = ['overview', 'checks', 'activity', 'diff'] as const
export type InspectorTab = (typeof INSPECTOR_TABS)[number]

const LABELS: Record<InspectorTab, string> = {
  overview: 'Overview',
  checks: 'Checks',
  activity: 'Activity',
  diff: 'Diff',
}

/** Key it by scope: a new task or approval starts on its own Overview, never a stale tab. */
export function InspectorTabs({
  initial = 'overview',
  render,
}: {
  initial?: InspectorTab
  render: (tab: InspectorTab) => ReactNode
}) {
  const [active, setActive] = useState<InspectorTab>(initial)
  const base = useId()
  const refs = useRef<Partial<Record<InspectorTab, HTMLButtonElement | null>>>({})

  const select = (tab: InspectorTab) => {
    setActive(tab)
    refs.current[tab]?.focus()
  }

  const onKeyDown = (event: KeyboardEvent) => {
    const index = INSPECTOR_TABS.indexOf(active)
    const last = INSPECTOR_TABS.length - 1
    const target =
      event.key === 'ArrowRight'
        ? INSPECTOR_TABS[index === last ? 0 : index + 1]
        : event.key === 'ArrowLeft'
          ? INSPECTOR_TABS[index === 0 ? last : index - 1]
          : event.key === 'Home'
            ? INSPECTOR_TABS[0]
            : event.key === 'End'
              ? INSPECTOR_TABS[last]
              : undefined
    if (!target) return
    event.preventDefault()
    select(target)
  }

  return (
    <>
      <div className="tabs" role="tablist" aria-label="Evidence" onKeyDown={onKeyDown}>
        {INSPECTOR_TABS.map((tab) => (
          <button
            key={tab}
            ref={(element) => {
              refs.current[tab] = element
            }}
            type="button"
            className="tab"
            role="tab"
            id={`${base}-tab-${tab}`}
            aria-selected={tab === active}
            aria-controls={`${base}-panel`}
            tabIndex={tab === active ? 0 : -1}
            onClick={() => setActive(tab)}
          >
            {LABELS[tab]}
          </button>
        ))}
      </div>
      <div
        className="inspector-body"
        id={`${base}-panel`}
        role="tabpanel"
        aria-labelledby={`${base}-tab-${active}`}
        // The evidence scrolls here, so the keyboard must be able to reach it.
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region
        tabIndex={0}
      >
        {render(active)}
      </div>
    </>
  )
}

import { useEffect, useRef } from 'react'
import { ContextPane } from './components/ContextPane'
import { Palette } from './components/Palette'
import { Rail, type RailCounts } from './components/Rail'
import { KeyForm, LoginSheet, SwitchSheet } from './components/Sheets'
import { Toast } from './components/Toast'
import { stateKindOf } from './components/Work'
import { type Route, routeToHash } from './router'
import { ChatView } from './views/ChatView'
import { NeedsView } from './views/NeedsView'
import { SettingsView } from './views/SettingsView'
import { SetupView } from './views/SetupView'
import { SlotsView } from './views/SlotsView'
import { WorkView } from './views/WorkView'
import { type SlotHealth, useWorkbench, WorkbenchProvider, type WorkbenchValue } from './workbench'

const VIEWS: Record<Route, () => React.JSX.Element> = {
  chat: ChatView,
  needs: NeedsView,
  work: WorkView,
  slots: SlotsView,
  setup: SetupView,
  settings: SettingsView,
}

export function App() {
  return (
    <WorkbenchProvider>
      <WorkbenchShell />
    </WorkbenchProvider>
  )
}

function WorkbenchShell() {
  const wb = useWorkbench()

  // The keyboard layer reads the workbench THROUGH A REF: one listener, installed
  // once, always seeing the latest state — no stale closures over counts or cards.
  const wbRef = useRef<WorkbenchValue>(wb)
  wbRef.current = wb

  useEffect(() => {
    let pendingG = false
    let gTimer: ReturnType<typeof setTimeout> | undefined

    const onKeydown = (event: KeyboardEvent) => {
      const current = wbRef.current
      const target = event.target
      const typing =
        target instanceof HTMLElement &&
        (target.matches('input, textarea, select') || target.isContentEditable)

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        if (current.paletteOpen) current.closePalette()
        else current.openPalette()
        return
      }

      if (event.key === 'Escape') {
        // The chain: palette → sheet → armed approval → context pane → composer blur.
        if (current.paletteOpen) return current.closePalette()
        if (current.sheet !== null) return current.closeSheet()
        if (current.armedId !== null) return current.disarm()
        if (current.context !== null) return current.closeContext()
        if (typing) target.blur()
        return
      }

      if (typing) return

      if (event.key === '/') {
        event.preventDefault()
        current.navigate('chat')
        window.setTimeout(() => document.getElementById('composer-input')?.focus(), 0)
        return
      }

      if (pendingG) {
        pendingG = false
        clearTimeout(gTimer)
        const map: Record<string, Route> = { n: 'needs', w: 'work', s: 'slots', c: 'chat' }
        const route = map[event.key.toLowerCase()]
        if (route !== undefined) current.navigate(route)
        return
      }
      if (event.key.toLowerCase() === 'g') {
        pendingG = true
        clearTimeout(gTimer)
        gTimer = setTimeout(() => {
          pendingG = false
        }, 800)
        return
      }

      // J/K move through the open cards; A/D act on the focused one.
      const cards = Array.from(document.querySelectorAll<HTMLElement>('.decision:not(.is-resolved)')).filter(
        (card) => card.offsetParent !== null,
      )
      if (cards.length === 0) return
      const focused = cards.indexOf(document.activeElement as HTMLElement)
      if (event.key.toLowerCase() === 'j') {
        event.preventDefault()
        cards[Math.min(cards.length - 1, focused + 1)]?.focus()
        return
      }
      if (event.key.toLowerCase() === 'k') {
        event.preventDefault()
        cards[Math.max(0, focused - 1)]?.focus()
        return
      }
      const activeCard =
        (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('.decision') ?? null
      if (activeCard === null) return
      const id = activeCard.dataset.decision
      if (id === undefined) return
      const inboxItem = current.inbox.find((item) => item.id === id)
      if (event.key.toLowerCase() === 'a' && inboxItem !== undefined) {
        event.preventDefault()
        void current.approveDecision(inboxItem)
      }
      if (event.key.toLowerCase() === 'd' && inboxItem !== undefined) {
        event.preventDefault()
        void current.denyDecision(inboxItem)
      }
    }

    document.addEventListener('keydown', onKeydown)
    return () => {
      document.removeEventListener('keydown', onKeydown)
      clearTimeout(gTimer)
    }
  }, [])

  const View = VIEWS[wb.route]
  const counts = countsOf(wb)
  const runtime = runtimeLineOf(wb)

  return (
    <div className="app">
      <a className="sr-only" href={`#${routeToHash(wb.route).slice(1)}`}>
        Skip to the screen
      </a>
      <Rail
        route={wb.route}
        counts={counts}
        slotHealth={slotHealthOf(wb)}
        runtimeLine={runtime.line}
        runtimeSub={runtime.sub}
        theme={wb.theme}
        onTheme={wb.setTheme}
      />
      <main className="main" id="main">
        <View />
      </main>
      <ContextPane />
      <Scrim />
      {wb.sheet?.kind === 'login' ? <LoginSheet engine={wb.sheet.engine} label={wb.sheet.label} /> : null}
      {wb.sheet?.kind === 'key' ? <KeyForm prefillLabel={wb.sheet.prefillLabel} /> : null}
      {wb.sheet?.kind === 'switch' ? <SwitchSheet itemId={wb.sheet.itemId} /> : null}
      <Palette />
      <Toast />
    </div>
  )
}

function Scrim() {
  const wb = useWorkbench()
  const visible = wb.sheet !== null || wb.paletteOpen
  if (!visible) return null
  return (
    <button
      type="button"
      className="scrim"
      aria-label="Close the overlay"
      onClick={() => {
        if (wb.sheet !== null) wb.closeSheet()
        if (wb.paletteOpen) wb.closePalette()
      }}
    />
  )
}

function countsOf(wb: WorkbenchValue): RailCounts {
  const openDecisions = wb.inbox.filter((item) => wb.resolutions[item.id] === undefined).length
  const openQuestions = wb.questions.filter((question) => wb.resolutions[question.id] === undefined).length
  const attention = wb.slots.some((slot) => slot.state !== 'retired' && stateKindOf(slot.state).kind !== 'ok')
  return {
    needs: openDecisions + openQuestions,
    work: wb.work.filter((item) => item.state !== 'done' && item.state !== 'stopped').length,
    slots: wb.slots.filter((slot) => slot.state !== 'retired').length,
    slotsAttention: attention,
  }
}

function slotHealthOf(wb: WorkbenchValue): SlotHealth[] {
  if (wb.slots.length > 0) {
    return wb.slots.map((slot) => {
      const kind = stateKindOf(slot.state).kind
      const health: SlotHealth['kind'] =
        kind === 'attn' ? 'attn' : kind === 'warn' || kind === 'bad' ? 'warn' : 'ok'
      return {
        label: slot.label,
        kind: health,
        note: slot.stateReason ?? slot.state,
      }
    })
  }
  return Object.entries(wb.status?.parts ?? {})
    .filter(([name]) => name.startsWith('slot:'))
    .map(([name, part]) => ({
      label: name.slice('slot:'.length),
      kind: (part.state === 'error'
        ? 'attn'
        : part.state === 'degraded'
          ? 'warn'
          : 'ok') as SlotHealth['kind'],
      note: part.detail ?? part.state,
    }))
}

function runtimeLineOf(wb: WorkbenchValue): { line: string; sub: string } {
  const runtime = wb.status?.runtime
  if (runtime === undefined) return { line: 'Runtime', sub: 'no reading yet' }
  const word = runtime.state === 'ready' ? 'Runtime ready' : `Runtime ${runtime.state}`
  const sub =
    runtime.instances === 0
      ? 'idle'
      : `${runtime.instances} attempt${runtime.instances === 1 ? '' : 's'} running`
  return { line: word, sub }
}

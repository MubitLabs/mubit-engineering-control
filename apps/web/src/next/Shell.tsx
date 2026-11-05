import {
  createContext,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type { Route } from '../router'
import { type Command, CommandPalette } from './CommandPalette'
import { ComposerFrame, type ComposerProps } from './ComposerFrame'
import { Inspector, type InspectorScope } from './Inspector'
import type { InspectorTab } from './InspectorTabs'
import { layers, useGlobalKeys } from './keyboard'
import { CONFIGURATION_ROUTES, ROUTE_LABELS } from './routes'
import { restoreFocus, Sheet } from './Sheet'
import { Sidebar, type SidebarProps } from './Sidebar'
import { Toolbar } from './Toolbar'
import type { ThemeChoice } from './theme'
import { THEME_LABELS } from './theme'

const DRAWER_QUERY = '(max-width: 760px)'
const OVERLAY_INSPECTOR_QUERY = '(max-width: 1149.98px)'

/** The one source of truth for layout mode, so CSS and script cannot disagree at a boundary. */
function useMedia(query: string): boolean {
  const subscribe = useCallback(
    (notify: () => void) => {
      const list = window.matchMedia(query)
      list.addEventListener('change', notify)
      return () => list.removeEventListener('change', notify)
    },
    [query],
  )
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches)
}

export interface ShellActions {
  /** Opens this route's inspector and remembers the control that asked. */
  openInspector: (tab?: InspectorTab) => void
}

const ShellActionsContext = createContext<ShellActions>({ openInspector: () => {} })
export const useShellActions = () => useContext(ShellActionsContext)

function WideInspector({
  scope,
  initialTab,
  onClose,
  onAsk,
  takeFocus,
}: {
  scope: InspectorScope
  initialTab?: InspectorTab
  onClose: () => void
  onAsk?: () => void
  /** False when it is simply there on load: nobody opened it, so focus stays put. */
  takeFocus: boolean
}) {
  const title = useRef<HTMLHeadingElement>(null)
  const takeFocusOnMount = useRef(takeFocus)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    if (takeFocusOnMount.current) title.current?.focus()
    return layers.push({ modal: false, onEscape: () => onCloseRef.current() })
  }, [])
  return (
    <aside className="inspector" aria-label="Details">
      <Inspector scope={scope} initialTab={initialTab} onClose={onClose} onAsk={onAsk} titleRef={title} />
    </aside>
  )
}

function InspectorSheet({
  scope,
  initialTab,
  onClose,
  onAsk,
  returnFocus,
}: {
  scope: InspectorScope
  initialTab?: InspectorTab
  onClose: () => void
  onAsk?: () => void
  returnFocus: RefObject<HTMLElement | null>
}) {
  const titleId = useId()
  const title = useRef<HTMLHeadingElement>(null)
  return (
    <Sheet
      variant="sheet"
      labelledBy={titleId}
      onClose={onClose}
      returnFocus={returnFocus}
      initialFocus={title}
    >
      <Inspector
        scope={scope}
        initialTab={initialTab}
        onClose={onClose}
        onAsk={onAsk}
        titleRef={title}
        titleId={titleId}
      />
    </Sheet>
  )
}

export interface ShellProps
  extends Omit<
    SidebarProps,
    'route' | 'onNavigate' | 'onClose' | 'theme' | 'onTheme' | 'onSwitchRepository'
  > {
  route: Route
  onNavigate: (route: Route) => void
  onSwitchRepository?: (id: string) => void
  theme: ThemeChoice
  onTheme: (choice: ThemeChoice) => void
  /** Conversation and Work. */
  taskInspector?: InspectorScope | null
  /** Needs you: bound to the card's exact tested commit, never to a running task. */
  approvalInspector?: InspectorScope | null
  initialInspectorOpen?: boolean
  composer?: Omit<ComposerProps, 'textareaRef'> | null
  commands?: readonly Command[]
  children: ReactNode
}

export function Shell({
  route,
  onNavigate,
  onSwitchRepository,
  theme,
  onTheme,
  taskInspector = null,
  approvalInspector = null,
  initialInspectorOpen = false,
  composer = null,
  commands = [],
  children,
  ...sidebar
}: ShellProps) {
  const drawerMode = useMedia(DRAWER_QUERY)
  const overlayInspector = useMedia(OVERLAY_INSPECTOR_QUERY)

  const [drawerOpen, setDrawerOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [paletteAfter, setPaletteAfter] = useState<(() => void) | null>(null)
  const [taskOpen, setTaskOpen] = useState(initialInspectorOpen)
  const [approvalOpen, setApprovalOpen] = useState(false)
  const [initialTab, setInitialTab] = useState<InspectorTab | undefined>()

  const scroller = useRef<HTMLDivElement>(null)
  const menuButton = useRef<HTMLButtonElement>(null)
  const paletteButton = useRef<HTMLButtonElement>(null)
  const detailsButton = useRef<HTMLButtonElement>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  /** Where focus goes when the inspector closes. */
  const inspectorOpener = useRef<HTMLElement | null>(null)
  const focusComposerNext = useRef(false)

  const scope =
    route === 'needs' ? approvalInspector : CONFIGURATION_ROUTES.includes(route) ? null : taskInspector
  const inspectorOpen = scope !== null && (route === 'needs' ? approvalOpen : taskOpen)
  const canCompose = route === 'chat' && composer !== null

  const setInspector = useCallback(
    (open: boolean) => {
      if (route === 'needs') setApprovalOpen(open)
      else setTaskOpen(open)
    },
    [route],
  )

  const openInspector = useCallback(
    (tab?: InspectorTab) => {
      inspectorOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      setInitialTab(tab)
      setInspector(true)
    },
    [setInspector],
  )

  const closeInspector = useCallback(() => {
    setInspector(false)
    setInitialTab(undefined)
    if (!overlayInspector) restoreFocus(inspectorOpener.current)
  }, [overlayInspector, setInspector])

  const focusComposer = useCallback(() => {
    textarea.current?.focus()
    return document.activeElement === textarea.current && textarea.current !== null
  }, [])

  /** Evidence hands the question to the composer: the sheet closes and the composer is live. */
  const askAboutWork = useCallback(() => {
    inspectorOpener.current = textarea.current
    if (overlayInspector) setInspector(false)
    focusComposerNext.current = true
    if (route !== 'chat') onNavigate('chat')
    else if (!overlayInspector) focusComposer()
  }, [focusComposer, onNavigate, overlayInspector, route, setInspector])

  const closePalette = useCallback((after?: () => void) => {
    setPaletteOpen(false)
    if (after) setPaletteAfter(() => after)
  }, [])

  // A chosen command runs after the palette has closed and handed focus back.
  useEffect(() => {
    if (paletteOpen || !paletteAfter) return
    paletteAfter()
    setPaletteAfter(null)
  }, [paletteAfter, paletteOpen])

  const keys = useMemo(
    () => ({
      onPalette: () => setPaletteOpen((open) => !open),
      onFocusComposer: () => void focusComposer(),
    }),
    [focusComposer],
  )
  useGlobalKeys(keys)

  // A route change moves focus to its heading, and only a real change: never on first load.
  const previousRoute = useRef(route)
  useEffect(() => {
    if (focusComposerNext.current && focusComposer()) {
      focusComposerNext.current = false
      previousRoute.current = route
      return
    }
    if (previousRoute.current === route) return
    previousRoute.current = route
    setDrawerOpen(false)
    scroller.current?.scrollTo?.({ top: 0 })
    if (layers.modalOpen()) return
    scroller.current?.querySelector<HTMLElement>('h1')?.focus({ preventScroll: true })
  }, [route, focusComposer])

  // Leaving Needs you drops its evidence: a later visit starts without a stale inspector.
  useEffect(() => {
    if (route !== 'needs') setApprovalOpen(false)
  }, [route])

  // The drawer has no meaning at rail width, and a closed drawer must not linger after a resize.
  useEffect(() => {
    if (!drawerMode) setDrawerOpen(false)
  }, [drawerMode])

  const navigate = useCallback(
    (target: Route) => {
      setDrawerOpen(false)
      onNavigate(target)
    },
    [onNavigate],
  )

  const switchRepository = useCallback(
    (id: string) => {
      setDrawerOpen(false)
      onSwitchRepository?.(id)
    },
    [onSwitchRepository],
  )

  const sidebarProps = {
    ...sidebar,
    route,
    onNavigate: navigate,
    onSwitchRepository: switchRepository,
    theme,
    onTheme,
  }

  const allCommands: readonly Command[] = [
    ...(['chat', 'work', 'needs', 'slots', 'setup', 'settings'] as const).map((target) => ({
      id: `route-${target}`,
      label: `Go to ${ROUTE_LABELS[target]}`,
      run: () => navigate(target),
    })),
    ...(['auto', 'light', 'dark'] as const).map((choice) => ({
      id: `theme-${choice}`,
      label: `Theme: ${THEME_LABELS[choice]}`,
      hint: choice === theme ? 'Current' : undefined,
      run: () => onTheme(choice),
    })),
    ...commands,
  ]

  const repository = sidebar.repositories.find((entry) => entry.id === sidebar.repositoryId)

  return (
    <ShellActionsContext.Provider value={useMemo(() => ({ openInspector }), [openInspector])}>
      <div className="shell">
        <button
          type="button"
          className="skip-link"
          onClick={() => scroller.current?.focus({ preventScroll: true })}
        >
          Skip to content
        </button>
        {!drawerMode && (
          <aside className="rail" aria-label="Navigation">
            <Sidebar {...sidebarProps} />
          </aside>
        )}
        <div className="workspace">
          <Toolbar
            repositoryName={repository?.name ?? 'No repository'}
            routeLabel={ROUTE_LABELS[route]}
            menu={
              drawerMode
                ? { open: drawerOpen, onOpen: () => setDrawerOpen(true), ref: menuButton }
                : undefined
            }
            details={
              scope
                ? {
                    open: inspectorOpen,
                    ref: detailsButton,
                    onToggle: () => (inspectorOpen ? closeInspector() : openInspector()),
                  }
                : undefined
            }
            paletteRef={paletteButton}
            onOpenPalette={() => setPaletteOpen(true)}
          />
          <div className="content">
            <main className="column">
              <section
                ref={scroller}
                className="scroller"
                data-focus-fallback
                aria-label={ROUTE_LABELS[route]}
                // Keyboard users must be able to scroll this region, so it takes focus.
                // biome-ignore lint/a11y/noNoninteractiveTabindex: the only scroller on the page
                tabIndex={0}
              >
                {children}
              </section>
              {canCompose && composer && <ComposerFrame {...composer} textareaRef={textarea} />}
            </main>
            {scope && inspectorOpen && !overlayInspector && (
              <WideInspector
                scope={scope}
                initialTab={initialTab}
                onClose={closeInspector}
                onAsk={composer ? askAboutWork : undefined}
                takeFocus={inspectorOpener.current !== null}
              />
            )}
          </div>
        </div>
      </div>

      {drawerMode && drawerOpen && (
        <Sheet
          variant="drawer"
          labelledBy="next-drawer-label"
          onClose={() => setDrawerOpen(false)}
          returnFocus={menuButton}
        >
          <span id="next-drawer-label" className="sr-only">
            Navigation
          </span>
          <Sidebar {...sidebarProps} onClose={() => setDrawerOpen(false)} />
        </Sheet>
      )}

      {scope && inspectorOpen && overlayInspector && (
        <InspectorSheet
          scope={scope}
          initialTab={initialTab}
          onClose={closeInspector}
          onAsk={composer ? askAboutWork : undefined}
          returnFocus={inspectorOpener}
        />
      )}

      {paletteOpen && <CommandPalette commands={allCommands} onClose={closePalette} />}
    </ShellActionsContext.Provider>
  )
}

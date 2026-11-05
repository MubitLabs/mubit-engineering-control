import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  api,
  type ChatMessage,
  HttpError,
  type InboxItem,
  isAlreadyHandled,
  isNotServed,
  newIdempotencyKey,
  type Question,
  type RepositoryEntry,
  type SlotEntry,
  type StatusSnapshot,
  subscribeMerged,
  type WorkItem,
} from './api'
import { describeApproval, liveStreams } from './release-cards'
import { type Route, useHashRoute } from './router'
import { workItemContext } from './state'

/**
 * The workbench: one store behind every view. Data arrives through the server's
 * SSE feed (one stream per work item and slot, plus `repositories` and `wizard`)
 * with a debounced refetch on every event, `/api/status` on a 10 s interval for
 * the runtime line, and a full catch-up refetch when the tab becomes visible or
 * the network returns. Card resolutions stay visible for the session.
 */

export type ContextDescriptor =
  | { kind: 'decision'; id: string }
  | { kind: 'question'; id: string }
  | { kind: 'work'; id: string }
  | { kind: 'task'; id: string }
  | { kind: 'slot'; id: string }

export type SheetState =
  | { kind: 'login'; engine: 'claude' | 'codex' | 'opencode'; label: string }
  | { kind: 'key'; prefillLabel?: string }
  | { kind: 'switch'; itemId: string }

export type Resolution = {
  kind: 'approved' | 'denied' | 'answered' | 'handled'
  note: string
  picked?: string
}

export type SlotHealth = { label: string; kind: 'ok' | 'warn' | 'attn'; note: string }

export type ThemeChoice = 'auto' | 'light' | 'dark'

export type WorkbenchValue = {
  route: Route
  navigate: (route: Route) => void
  theme: ThemeChoice
  setTheme: (theme: ThemeChoice) => void
  status: StatusSnapshot | null
  messages: ChatMessage[]
  pendingMessages: ChatMessage[]
  sendingChat: boolean
  inbox: InboxItem[]
  questions: Question[]
  work: WorkItem[]
  slots: SlotEntry[]
  repositories: RepositoryEntry[]
  resolutions: Record<string, Resolution>
  armedId: string | null
  busyAnswer: string | null
  actionErrors: Record<string, string>
  now: number
  context: ContextDescriptor | null
  sheet: SheetState | null
  paletteOpen: boolean
  toastText: string | null
  composerPrefill: { text: string; nonce: number } | undefined
  refresh: () => void
  sendChat: (text: string, referencesWorkItem?: string) => Promise<boolean>
  approveDecision: (item: InboxItem) => Promise<void>
  denyDecision: (item: InboxItem) => Promise<void>
  answerQuestion: (question: Question, option: string) => Promise<void>
  arm: (id: string) => void
  disarm: () => void
  openContext: (descriptor: ContextDescriptor) => void
  closeContext: () => void
  openSheet: (sheet: SheetState) => void
  closeSheet: () => void
  openPalette: () => void
  closePalette: () => void
  toast: (text: string) => void
  composerPrefillSet: (text: string) => void
  pauseProcessing: () => Promise<void>
  backupNow: () => Promise<void>
}

const WorkbenchContext = createContext<WorkbenchValue | null>(null)

export function useWorkbench(): WorkbenchValue {
  const value = useContext(WorkbenchContext)
  if (value === null) throw new Error('useWorkbench outside WorkbenchProvider')
  return value
}

function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  return (...args: A) => {
    clearTimeout(timer)
    timer = setTimeout(() => fn(...args), ms)
  }
}

const THEME_KEY = 'mec-theme'

function readTheme(): ThemeChoice {
  const current = document.documentElement.dataset.theme
  if (current === 'light' || current === 'dark') return current
  try {
    const stored = localStorage.getItem(THEME_KEY)
    if (stored === 'light' || stored === 'dark' || stored === 'auto') return stored
  } catch {
    // No storage: the auto theme stands.
  }
  return 'auto'
}

export function WorkbenchProvider({ children }: { children: ReactNode }) {
  const [route, navigate] = useHashRoute()
  const [theme, setThemeState] = useState<ThemeChoice>(readTheme)
  const [status, setStatus] = useState<StatusSnapshot | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [pendingMessages, setPendingMessages] = useState<ChatMessage[]>([])
  const [sendingChat, setSendingChat] = useState(false)
  const [inbox, setInbox] = useState<InboxItem[]>([])
  const [questions, setQuestions] = useState<Question[]>([])
  const [work, setWork] = useState<WorkItem[]>([])
  const [slots, setSlots] = useState<SlotEntry[]>([])
  const [repositories, setRepositories] = useState<RepositoryEntry[]>([])
  const [resolutions, setResolutions] = useState<Record<string, Resolution>>({})
  const [armedId, setArmedId] = useState<string | null>(null)
  const [busyAnswer, setBusyAnswer] = useState<string | null>(null)
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({})
  const [now, setNow] = useState(() => Date.now())
  const [context, setContext] = useState<ContextDescriptor | null>(null)
  const [sheet, setSheet] = useState<SheetState | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [toastText, setToastText] = useState<string | null>(null)
  const [prefill, setPrefill] = useState<{ text: string; nonce: number } | undefined>(undefined)

  const armTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const contextOpener = useRef<HTMLElement | null>(null)
  const sheetOpener = useRef<HTMLElement | null>(null)
  const paletteOpener = useRef<HTMLElement | null>(null)
  const idemKey = useRef(newIdempotencyKey())
  const prefillNonce = useRef(0)
  const cursors = useRef<Record<string, number>>({})

  useEffect(() => {
    if (theme === 'auto') delete document.documentElement.dataset.theme
    else document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem(THEME_KEY, theme)
    } catch {
      // The choice still holds for this session.
    }
  }, [theme])

  // ── Data ────────────────────────────────────────────────────────────────────

  const fetchAll = useCallback(async () => {
    const [
      statusResult,
      messagesResult,
      inboxResult,
      questionsResult,
      workResult,
      slotsResult,
      repositoriesResult,
    ] = await Promise.allSettled([
      api.status(),
      api.chat(),
      api.inbox(),
      api.questions(),
      api.work(),
      api.slots(),
      api.repositories(),
    ])
    if (statusResult.status === 'fulfilled') setStatus(statusResult.value)
    if (messagesResult.status === 'fulfilled') setMessages(messagesResult.value)
    if (inboxResult.status === 'fulfilled') setInbox(inboxResult.value)
    if (questionsResult.status === 'fulfilled') setQuestions(questionsResult.value)
    if (workResult.status === 'fulfilled') setWork(workResult.value)
    if (slotsResult.status === 'fulfilled') setSlots(slotsResult.value)
    if (repositoriesResult.status === 'fulfilled') setRepositories(repositoriesResult.value)
  }, [])

  const refresh = useMemo(() => debounce(() => void fetchAll(), 250), [fetchAll])

  useEffect(() => {
    void fetchAll()
  }, [fetchAll])

  // Catch-up: the streams replay from their cursors, and a visible tab refetches everything.
  useEffect(() => {
    const onBack = () => void fetchAll()
    window.addEventListener('online', onBack)
    document.addEventListener('visibilitychange', onBack)
    return () => {
      window.removeEventListener('online', onBack)
      document.removeEventListener('visibilitychange', onBack)
    }
  }, [fetchAll])

  const streamKeys = useMemo(() => liveStreams(work, slots), [work, slots])

  useEffect(() => {
    // ONE connection for every stream (the per-origin cap starved fetches otherwise).
    const dispose = subscribeMerged(
      streamKeys.map((stream) => ({ stream, after: cursors.current[stream] ?? 0 })),
      (event) => {
        if (typeof event.stream === 'string') cursors.current[event.stream] = event.seq
        refresh()
      },
    )
    return dispose
  }, [streamKeys, refresh])

  // The runtime line only: /api/status on a 10 s interval (§7).
  useEffect(() => {
    const tick = () => {
      api
        .status()
        .then(setStatus)
        .catch(() => {})
    }
    tick()
    const timer = setInterval(tick, 10_000)
    return () => clearInterval(timer)
  }, [])

  // The countdown ticker: runs only while something in the tray can expire.
  const anyExpiring = inbox.some((item) => resolutions[item.id] === undefined)
  useEffect(() => {
    if (!anyExpiring) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [anyExpiring])

  // ── Toast ───────────────────────────────────────────────────────────────────

  const toast = useCallback((text: string) => {
    setToastText(text)
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToastText(null), 3600)
  }, [])

  // ── Two-step approval ───────────────────────────────────────────────────────

  const disarm = useCallback(() => {
    clearTimeout(armTimer.current)
    setArmedId(null)
  }, [])

  const arm = useCallback((id: string) => {
    clearTimeout(armTimer.current)
    setArmedId(id)
    armTimer.current = setTimeout(() => setArmedId(null), 8000)
  }, [])

  // Any click outside the armed button disarms it (§2.7).
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const target = event.target
      if (armedId === null || !(target instanceof Element)) return
      if (target.closest('[data-approve]') !== null) return
      disarm()
    }
    document.addEventListener('click', onClick)
    return () => document.removeEventListener('click', onClick)
  }, [armedId, disarm])

  const resolve = useCallback(
    (id: string, resolution: Resolution, toastText: string) => {
      setResolutions((current) => ({ ...current, [id]: resolution }))
      disarm()
      toast(toastText)
    },
    [disarm, toast],
  )

  const approveDecision = useCallback(
    async (item: InboxItem) => {
      if (resolutions[item.id] !== undefined) return
      if (armedId !== item.id) {
        arm(item.id)
        return
      }
      setBusyAnswer(item.id)
      setActionErrors((current) => {
        const next = { ...current }
        delete next[item.id]
        return next
      })
      try {
        const shown = describeApproval(await api.resolve(item.id, 'approve'))
        if (shown.closes) {
          resolve(item.id, { kind: shown.kind, note: shown.note }, shown.toast)
        } else {
          disarm()
          setActionErrors((current) => ({ ...current, [item.id]: shown.note }))
          toast(shown.toast)
        }
      } catch (error) {
        if (isAlreadyHandled(error)) {
          resolve(
            item.id,
            { kind: 'handled', note: 'Already resolved by someone else' },
            'Already handled elsewhere.',
          )
        } else {
          disarm()
          setActionErrors((current) => ({
            ...current,
            [item.id]:
              error instanceof HttpError && error.reason !== undefined
                ? error.reason
                : 'could not reach the runtime — try again',
          }))
        }
      } finally {
        setBusyAnswer(null)
      }
    },
    [armedId, arm, disarm, resolve, resolutions, toast],
  )

  const denyDecision = useCallback(
    async (item: InboxItem) => {
      if (resolutions[item.id] !== undefined) return
      setBusyAnswer(item.id)
      try {
        await api.resolve(item.id, 'deny')
        resolve(
          item.id,
          { kind: 'denied', note: 'Denied' },
          'Denied. The agent was told it was not approved.',
        )
      } catch (error) {
        if (isAlreadyHandled(error)) {
          resolve(
            item.id,
            { kind: 'handled', note: 'Already resolved by someone else' },
            'Already handled elsewhere.',
          )
        } else {
          setActionErrors((current) => ({ ...current, [item.id]: 'could not reach the runtime — try again' }))
        }
      } finally {
        setBusyAnswer(null)
      }
    },
    [resolve, resolutions],
  )

  const answerQuestion = useCallback(
    async (question: Question, option: string) => {
      if (resolutions[question.id] !== undefined) return
      if (option.endsWith('…')) {
        navigate('chat')
        prefillNonce.current += 1
        setPrefill({ text: `About “${question.what}”: `, nonce: prefillNonce.current })
        return
      }
      try {
        await api.answerQuestion(question.id, option)
        resolve(
          question.id,
          { kind: 'answered', note: `Answered: ${option}`, picked: option },
          `Answered: ${option}. The asker continues.`,
        )
      } catch (error) {
        if (isNotServed(error)) {
          // The demo card resolves in this session only — honestly labelled on the card.
          resolve(
            question.id,
            { kind: 'answered', note: `Answered: ${option}`, picked: option },
            `Answered: ${option} (demo — question answering is not served by the server yet).`,
          )
        } else {
          setActionErrors((current) => ({
            ...current,
            [question.id]: 'could not reach the runtime — try again',
          }))
        }
      }
    },
    [navigate, resolve, resolutions],
  )

  // ── Chat ────────────────────────────────────────────────────────────────────

  const sendChat = useCallback(
    async (text: string, referencesWorkItem?: string) => {
      const optimistic: ChatMessage = {
        id: `pending:${idemKey.current}`,
        text,
        createdAt: new Date().toISOString(),
        kind: 'user',
        meta: 'You',
        ...(referencesWorkItem === undefined ? {} : { workItemId: referencesWorkItem }),
      }
      setSendingChat(true)
      setPendingMessages((rows) => [...rows, optimistic])
      try {
        await api.sendChat(text, referencesWorkItem, idemKey.current)
        idemKey.current = newIdempotencyKey()
        setPendingMessages((rows) => rows.filter((row) => row.id !== optimistic.id))
        await fetchAll()
        return false
      } catch {
        // Keep the draft; the key stays so a retry is idempotent.
        setPendingMessages((rows) => rows.filter((row) => row.id !== optimistic.id))
        return true
      } finally {
        setSendingChat(false)
      }
    },
    [fetchAll],
  )

  // ── Pane, sheets, palette ───────────────────────────────────────────────────

  const openContext = useCallback((descriptor: ContextDescriptor) => {
    contextOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setContext(descriptor)
  }, [])

  const closeContext = useCallback(() => {
    setContext(null)
    contextOpener.current?.focus({ preventScroll: true })
    contextOpener.current = null
  }, [])

  const openSheet = useCallback((next: SheetState) => {
    sheetOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setSheet(next)
  }, [])

  const closeSheet = useCallback(() => {
    setSheet(null)
    sheetOpener.current?.focus({ preventScroll: true })
    sheetOpener.current = null
  }, [])

  const openPalette = useCallback(() => {
    paletteOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setPaletteOpen(true)
  }, [])
  const closePalette = useCallback(() => {
    setPaletteOpen(false)
    paletteOpener.current?.focus({ preventScroll: true })
    paletteOpener.current = null
  }, [])

  const composerPrefillSet = useCallback(
    (text: string) => {
      navigate('chat')
      prefillNonce.current += 1
      setPrefill({ text, nonce: prefillNonce.current })
    },
    [navigate],
  )

  // ── Operator commands (honest about what is not served) ────────────────────

  const pauseProcessing = useCallback(async () => {
    try {
      await api.pauseProcessing()
      toast('Processing paused.')
    } catch (error) {
      toast(isNotServed(error) ? 'Pause is not served by the server yet.' : 'Pause failed — try again.')
    }
  }, [toast])

  const backupNow = useCallback(async () => {
    try {
      await api.backupNow()
      toast('Backup started.')
    } catch (error) {
      toast(isNotServed(error) ? 'Backups are not served by the server yet.' : 'Backup failed — try again.')
    }
  }, [toast])

  // Reply-to: a Work row or a chat chip can point the next message at a work item.
  useEffect(() => {
    if (route !== 'chat') return
    const live = work.find((item) => item.state !== 'done' && item.state !== 'stopped')
    if (live !== undefined && workItemContext.current === null) workItemContext.set(live.id)
  }, [route, work])

  const value = useMemo<WorkbenchValue>(
    () => ({
      route,
      navigate,
      theme,
      setTheme: setThemeState,
      status,
      messages,
      pendingMessages,
      sendingChat,
      inbox,
      questions,
      work,
      slots,
      repositories,
      resolutions,
      armedId,
      busyAnswer,
      actionErrors,
      now,
      context,
      sheet,
      paletteOpen,
      toastText,
      composerPrefill: prefill,
      refresh,
      sendChat,
      approveDecision,
      denyDecision,
      answerQuestion,
      arm,
      disarm,
      openContext,
      closeContext,
      openSheet,
      closeSheet,
      openPalette,
      closePalette,
      toast,
      composerPrefillSet,
      pauseProcessing,
      backupNow,
    }),
    [
      route,
      navigate,
      theme,
      status,
      messages,
      pendingMessages,
      sendingChat,
      inbox,
      questions,
      work,
      slots,
      repositories,
      resolutions,
      armedId,
      busyAnswer,
      actionErrors,
      now,
      context,
      sheet,
      paletteOpen,
      toastText,
      prefill,
      refresh,
      sendChat,
      approveDecision,
      denyDecision,
      answerQuestion,
      arm,
      disarm,
      openContext,
      closeContext,
      openSheet,
      closeSheet,
      openPalette,
      closePalette,
      toast,
      composerPrefillSet,
      pauseProcessing,
      backupNow,
    ],
  )

  return <WorkbenchContext.Provider value={value}>{children}</WorkbenchContext.Provider>
}

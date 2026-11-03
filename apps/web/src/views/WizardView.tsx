import { useCallback, useEffect, useRef, useState } from 'react'
import {
  api,
  type EngineStatus,
  type ExistingLogin,
  type ExistingLogins,
  HttpError,
  type LoginCardEvent,
  type RepositoryEntry,
  type SlotEntry,
  type StatusSnapshot,
  subscribeLoginCard,
} from '../api'
import { Badge, type BadgeState, Button, Card, EmptyState } from '../components/ui'
import { routeToHash } from '../router'
import { usePolling } from '../usePolling'
import { AddApiKeyCard } from './SlotsView'

/** §21.3: the four first-run steps; `done` is the summary screen after the last one. */
type WizardStep = 'engines' | 'slots' | 'repository' | 'meta-slot' | 'done'

const STEP_ORDER: ReadonlyArray<Exclude<WizardStep, 'done'>> = ['engines', 'slots', 'repository', 'meta-slot']

const STEP_TITLES: Record<WizardStep, string> = {
  engines: 'Detect engines',
  slots: 'Connect a slot',
  repository: 'Register a repository',
  'meta-slot': 'Choose the meta agent’s slot',
  done: 'Setup complete',
}

/** The inline failure note every step shares: the server's own reason when it sent one. */
function noteFor(error: unknown): string {
  if (error instanceof HttpError) return error.reason ?? `failed (HTTP ${error.status})`
  return 'could not reach the runtime — try again'
}

function badgeOf(ok: boolean): BadgeState {
  return ok ? 'ok' : 'degraded'
}

/** §21.3 step 1: the engines table — installed, version, and any default-home login. */
function EnginesStep() {
  const [engines, setEngines] = useState<EngineStatus[] | null>(null)
  const [logins, setLogins] = useState<ExistingLogins | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const refresh = useCallback(() => {
    api
      .wizardEngines()
      .then(setEngines)
      .catch((error: unknown) => setNote(noteFor(error)))
    api
      .wizardExistingLogins()
      .then(setLogins)
      .catch(() => {})
  }, [])
  useEffect(() => {
    refresh()
  }, [refresh])

  const loginLine = (login: ExistingLogin | null): string =>
    login === null
      ? '—'
      : login.loggedIn
        ? ['signed in', login.email, login.plan].filter((part) => part !== undefined).join(' · ')
        : 'signed out'

  return (
    <Card>
      <h3 className="card-title">{STEP_TITLES.engines}</h3>
      <p className="card-detail">
        Each probe is the engine’s own <span className="mono">--version</span> and status command, run
        locally. Nothing is installed for you.
      </p>
      {engines === null ? (
        <EmptyState>probing engines…</EmptyState>
      ) : (
        <div className="slot-grid">
          {engines.map((engine) => (
            <Card key={engine.engine}>
              <div className="slot-head">
                <span className="slot-label">{engine.engine}</span>
                <Badge label={engine.installed ? 'installed' : 'missing'} state={badgeOf(engine.installed)} />
              </div>
              <p className="mono slot-detail">{engine.version ?? 'not found on PATH'}</p>
              <p className="card-detail">existing login: {loginLine(logins?.[engine.engine] ?? null)}</p>
            </Card>
          ))}
        </div>
      )}
      {note === null ? null : <p className="error-note">{note}</p>}
    </Card>
  )
}

/**
 * §21.3 step 2, one engine at a time. Claude is fully wired in v0: link the existing
 * default-home login (§5.3 slot 0), open a dedicated-slot terminal card (§5.6), or paste
 * an API key (§5.7). The other engines show until their adapters land.
 */
function EngineSlotsStep({
  engine,
  login,
  onChanged,
}: {
  engine: EngineStatus
  login: ExistingLogin | null
  onChanged: () => void
}) {
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState<'link' | 'login' | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [loginLines, setLoginLines] = useState<string[]>([])
  const [loginLive, setLoginLive] = useState(false)
  const detachRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    // §5.6: the login stream is live-only — detach on unmount, replay nothing.
    return () => {
      detachRef.current?.()
      detachRef.current = null
    }
  }, [])

  const link = useCallback(async () => {
    const trimmed = label.trim()
    if (trimmed === '') return
    setBusy('link')
    setNote(null)
    try {
      const linked = await api.linkSlot('claude', trimmed)
      setNote(`linked ${linked.id} → ${linked.home} (CLAUDE_CONFIG_DIR stays unset)`)
      onChanged()
    } catch (error) {
      setNote(noteFor(error))
    } finally {
      setBusy(null)
    }
  }, [label, onChanged])

  const openLoginCard = useCallback(async () => {
    const trimmed = label.trim()
    if (trimmed === '') return
    setBusy('login')
    setNote(null)
    setLoginLines([])
    setLoginLive(true)
    try {
      const started = await api.startLogin('claude', trimmed)
      if (started.busy) setNote('a login card is already running — attached to it')
      detachRef.current = subscribeLoginCard((event: LoginCardEvent) => {
        if (event.kind === 'output') {
          setLoginLines((lines) => [...lines.slice(-49), event.data])
        } else if (event.kind === 'exit') {
          setLoginLive(false)
          setNote(`login card exited (${event.code}) — continue once you are signed in`)
        } else if (event.kind === 'timeout') {
          setLoginLive(false)
          setNote('login card timed out after ten minutes')
        } else {
          // §5.6: MEC opens the vendor's sign-in URL in the user's browser.
          window.open(event.url, '_blank', 'noopener')
        }
      })
    } catch (error) {
      setLoginLive(false)
      setNote(noteFor(error))
    } finally {
      setBusy(null)
    }
  }, [label])

  if (engine.engine !== 'claude') {
    return (
      <Card>
        <div className="slot-head">
          <span className="slot-label">{engine.engine}</span>
          <Badge label={engine.installed ? 'installed' : 'missing'} state={badgeOf(engine.installed)} />
        </div>
        <p className="card-detail">
          slot setup for {engine.engine} arrives with its adapter — v0 is Claude Code first
        </p>
      </Card>
    )
  }

  return (
    <Card>
      <div className="slot-head">
        <span className="slot-label">claude</span>
        <Badge
          label={login?.loggedIn ? 'login found' : 'no default-home login'}
          state={badgeOf(login?.loggedIn ?? false)}
        />
      </div>
      <p className="card-detail">
        Linking shares the login, history and quota of <span className="mono">~/.claude</span>; dedicated
        slots are the recommendation after a first try (§5.3).
      </p>
      <input
        aria-label="Slot label"
        onChange={(event) => setLabel(event.target.value)}
        placeholder="slot label, e.g. max-1"
        value={label}
      />
      <div className="card-actions">
        <Button
          disabled={busy !== null || label.trim() === '' || login?.loggedIn !== true}
          onClick={() => void link()}
        >
          {busy === 'link' ? 'Linking…' : 'Link existing login'}
        </Button>
        <Button disabled={busy !== null || label.trim() === ''} onClick={() => void openLoginCard()}>
          {busy === 'login' ? 'Opening…' : 'Add dedicated slot'}
        </Button>
      </div>
      {loginLive || loginLines.length > 0 ? (
        <pre className="mono slot-detail">{loginLines.join('') || 'waiting for the login card…'}</pre>
      ) : null}
      {note === null ? null : <p className="error-note">{note}</p>}
      <AddApiKeyCard onAdded={onChanged} />
    </Card>
  )
}

/** §21.3 step 2: the slot choices per engine, fed by the same probes as step 1. */
function SlotsStep() {
  const [engines, setEngines] = useState<EngineStatus[]>([])
  const [logins, setLogins] = useState<ExistingLogins | null>(null)

  const refresh = useCallback(() => {
    api
      .wizardEngines()
      .then(setEngines)
      .catch(() => {})
    api
      .wizardExistingLogins()
      .then(setLogins)
      .catch(() => {})
  }, [])
  useEffect(() => {
    refresh()
  }, [refresh])

  return (
    <div className="slot-grid">
      {engines.map((engine) => (
        <EngineSlotsStep
          engine={engine}
          key={engine.engine}
          login={logins?.[engine.engine] ?? null}
          onChanged={refresh}
        />
      ))}
      {engines.length === 0 ? <EmptyState>no engines probed yet — go back and retry</EmptyState> : null}
    </div>
  )
}

/** §21.3 step 3: one repository — where it lives, how it bootstraps, how it is checked. */
function RepositoryStep() {
  const [urlOrPath, setUrlOrPath] = useState('')
  const [bootstrap, setBootstrap] = useState('')
  const [checkName, setCheckName] = useState('')
  const [checkCmd, setCheckCmd] = useState('')
  const [trusted, setTrusted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [saved, setSaved] = useState<RepositoryEntry | null>(null)

  const save = useCallback(async () => {
    const trimmedUrl = urlOrPath.trim()
    if (trimmedUrl === '') return
    setBusy(true)
    setNote(null)
    try {
      const entry = await api.addRepository({
        urlOrPath: trimmedUrl,
        bootstrapCmds: bootstrap.trim() === '' ? [] : [bootstrap.trim()],
        checkCmds:
          checkCmd.trim() === ''
            ? []
            : [{ name: checkName.trim() === '' ? 'check' : checkName.trim(), cmd: checkCmd.trim() }],
        trusted,
      })
      setSaved(entry)
    } catch (error) {
      setNote(noteFor(error))
    } finally {
      setBusy(false)
    }
  }, [urlOrPath, bootstrap, checkName, checkCmd, trusted])

  return (
    <Card>
      <h3 className="card-title">{STEP_TITLES.repository}</h3>
      <p className="card-detail">
        A local path that exists, or an https URL without credentials. Commands run as argv — never through a
        shell, so shell syntax is rejected here.
      </p>
      <form
        className="key-form"
        onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}
      >
        <input
          aria-label="Repository path or https URL"
          onChange={(event) => setUrlOrPath(event.target.value)}
          placeholder="/path/to/repo or https://github.com/org/repo"
          value={urlOrPath}
        />
        <input
          aria-label="Bootstrap command"
          onChange={(event) => setBootstrap(event.target.value)}
          placeholder="bootstrap, e.g. pnpm install"
          value={bootstrap}
        />
        <input
          aria-label="Check name"
          onChange={(event) => setCheckName(event.target.value)}
          placeholder="check name, e.g. typecheck"
          value={checkName}
        />
        <input
          aria-label="Check command"
          onChange={(event) => setCheckCmd(event.target.value)}
          placeholder="check command, e.g. pnpm exec tsc --noEmit"
          value={checkCmd}
        />
        <label>
          <input checked={trusted} onChange={(event) => setTrusted(event.target.checked)} type="checkbox" />
          trust this repository’s resident configuration (hooks, MCP, plugins — §22)
        </label>
        <Button disabled={busy || urlOrPath.trim() === ''} type="submit" variant="primary">
          {busy ? 'Registering…' : 'Register'}
        </Button>
        {note === null ? null : <span className="error-note">{note}</span>}
      </form>
      {saved === null ? null : (
        <p className="mono slot-detail">
          registered {saved.id} — {saved.url} ({saved.checks.length} check
          {saved.checks.length === 1 ? '' : 's'}, trust {saved.trust ? 'on' : 'off'})
        </p>
      )}
    </Card>
  )
}

/** §21.3 step 4: pick the slot the meta agent (§6) runs on. */
function MetaSlotStep() {
  const [slots, setSlots] = useState<SlotEntry[]>([])
  const [current, setCurrent] = useState<string | null>(null)
  const [pick, setPick] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const refresh = useCallback(() => {
    api
      .slots()
      .then(setSlots)
      .catch(() => {})
    api
      .metaSlot()
      .then((meta) => setCurrent(meta.slotId))
      .catch(() => {})
  }, [])
  useEffect(() => {
    refresh()
  }, [refresh])

  const choose = useCallback(async () => {
    if (pick === null) return
    setBusy(true)
    setNote(null)
    try {
      await api.setMetaSlot(pick)
      setCurrent(pick)
    } catch (error) {
      setNote(noteFor(error))
    } finally {
      setBusy(false)
    }
  }, [pick])

  const candidates = slots.filter((slot) => slot.state !== 'retired')

  return (
    <Card>
      <h3 className="card-title">{STEP_TITLES['meta-slot']}</h3>
      {candidates.length === 0 ? (
        <EmptyState>no slots yet — go back and link, sign in or paste a key</EmptyState>
      ) : (
        <div className="slot-grid">
          {candidates.map((slot) => (
            <label key={slot.id}>
              <input
                checked={pick === slot.id || (pick === null && current === slot.id)}
                onChange={() => setPick(slot.id)}
                type="radio"
              />{' '}
              <span className="mono">{slot.label}</span> — {slot.kind} · {slot.state}
            </label>
          ))}
        </div>
      )}
      <div className="card-actions">
        <Button disabled={busy || (pick ?? current) === null} onClick={() => void choose()} variant="primary">
          {busy ? 'Saving…' : 'Use this slot'}
        </Button>
        {current === null ? null : <span className="mono slot-detail">currently: {current}</span>}
      </div>
      {note === null ? null : <p className="error-note">{note}</p>}
    </Card>
  )
}

/** §21.3 done: the §21.2 setup flags, live, so the finish line shows them flipping true. */
function DoneStep() {
  const [status, setStatus] = useState<StatusSnapshot | null>(null)

  const refresh = useCallback(() => {
    api
      .status()
      .then(setStatus)
      .catch(() => {})
  }, [])
  usePolling(refresh, 3000)

  const setup = status?.setup
  return (
    <Card>
      <h3 className="card-title">{STEP_TITLES.done}</h3>
      <div className="card-actions">
        <span className="slot-detail">
          slot{' '}
          <Badge label={setup?.has_slot ? 'ready' : 'missing'} state={badgeOf(setup?.has_slot ?? false)} />
        </span>
        <span className="slot-detail">
          repository{' '}
          <Badge
            label={setup?.has_repository ? 'ready' : 'missing'}
            state={badgeOf(setup?.has_repository ?? false)}
          />
        </span>
      </div>
      <p className="card-detail">
        Both flags green means <span className="mono">mec status</span> leaves exit 3 — the runtime takes
        work. Try it from Chat.
      </p>
      <div className="card-actions">
        <Button onClick={() => (window.location.hash = routeToHash('chat'))} variant="primary">
          Open Chat
        </Button>
        <Button onClick={() => (window.location.hash = routeToHash('slots'))}>Review slots</Button>
      </div>
    </Card>
  )
}

/**
 * The first-run wizard (plan §21.3) on one route: detect engines → existing logins →
 * link / dedicated slot / paste a key → register a repository → choose the meta agent’s
 * slot → done. Target: five minutes with one engine, ten with all four configurations.
 */
export function WizardView() {
  const [step, setStep] = useState<WizardStep>('engines')

  const index = STEP_ORDER.indexOf(step as Exclude<WizardStep, 'done'>)
  const back = () => {
    if (index > 0) setStep(STEP_ORDER[index - 1] as WizardStep)
    else setStep('engines')
  }
  const next = () => {
    if (index >= 0 && index < STEP_ORDER.length - 1) setStep(STEP_ORDER[index + 1] as WizardStep)
    else if (index === STEP_ORDER.length - 1) setStep('done')
  }

  return (
    <div className="view">
      <h2 className="view-title">Setup</h2>
      <p className="card-detail">
        Step {index >= 0 ? index + 1 : STEP_ORDER.length} of {STEP_ORDER.length} — {STEP_TITLES[step]}
      </p>
      {step === 'engines' ? <EnginesStep /> : null}
      {step === 'slots' ? <SlotsStep /> : null}
      {step === 'repository' ? <RepositoryStep /> : null}
      {step === 'meta-slot' ? <MetaSlotStep /> : null}
      {step === 'done' ? <DoneStep /> : null}
      <div className="card-actions">
        {step !== 'engines' && step !== 'done' ? <Button onClick={back}>Back</Button> : null}
        {step !== 'done' ? (
          <Button onClick={next} variant="primary">
            {step === 'meta-slot' ? 'Done' : 'Continue'}
          </Button>
        ) : null}
      </div>
    </div>
  )
}

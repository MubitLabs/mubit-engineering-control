import { useCallback, useEffect, useState } from 'react'
import {
  api,
  type EngineStatus,
  type ExistingLogin,
  type ExistingLogins,
  HttpError,
  type RepositoryEntry,
} from '../api'
import { Btn } from '../components/base'
import { Option, Step, StepActions, Steps } from '../components/Steps'
import { useWorkbench } from '../workbench'

/**
 * Setup: the first-run wizard's five steps in one column, the current step
 * expanded (§5 First run). The logic is the scaffold's: probe engines, connect
 * a slot (link the existing login, a dedicated slot through the terminal sheet,
 * or a pasted key), register the repository, choose the meta agent's slot, try
 * it.
 */
type WizardStep = 'engines' | 'slots' | 'repository' | 'meta-slot' | 'done'

const STEP_ORDER: ReadonlyArray<Exclude<WizardStep, 'done'>> = ['engines', 'slots', 'repository', 'meta-slot']

function noteFor(error: unknown): string {
  if (error instanceof HttpError) return error.reason ?? `failed (HTTP ${error.status})`
  return 'could not reach the runtime — try again'
}

export function SetupView() {
  const wb = useWorkbench()
  const [step, setStep] = useState<WizardStep>('engines')
  const index = STEP_ORDER.indexOf(step as Exclude<WizardStep, 'done'>)

  const stateOf = (target: Exclude<WizardStep, 'done'>): 'done' | 'current' | 'pending' =>
    step === target ? 'current' : index > STEP_ORDER.indexOf(target) || step === 'done' ? 'done' : 'pending'

  return (
    <section className="pane is-active" id="pane-setup" aria-labelledby="setup-title">
      <header className="pane-head">
        <h1 className="pane-title" id="setup-title">
          Set up MEC
        </h1>
        <p className="pane-sub">About two minutes. You can come back to any step later.</p>
      </header>
      <Steps>
        <EnginesStep state={stateOf('engines')} />
        <SlotsStep state={stateOf('slots')} />
        <RepositoryStep state={stateOf('repository')} />
        <MetaSlotStep state={stateOf('meta-slot')} />
        <TryStep state={step === 'done' ? 'current' : 'pending'} />
      </Steps>
      {step === 'done' ? null : (
        <StepActions>
          {step !== 'engines' ? (
            <Btn variant="quiet" onClick={() => setStep(STEP_ORDER[Math.max(0, index - 1)] ?? 'engines')}>
              Back
            </Btn>
          ) : null}
          <Btn
            variant="primary"
            onClick={() =>
              setStep(index >= STEP_ORDER.length - 1 ? 'done' : (STEP_ORDER[index + 1] ?? 'done'))
            }
          >
            {step === 'meta-slot' ? 'Finish' : 'Continue'}
          </Btn>
          <Btn
            variant="quiet"
            onClick={() =>
              setStep(index >= STEP_ORDER.length - 1 ? 'done' : (STEP_ORDER[index + 1] ?? 'done'))
            }
          >
            Skip for now
          </Btn>
        </StepActions>
      )}
      {wb.status !== null && (!wb.status.setup.has_slot || !wb.status.setup.has_repository) ? (
        <p className="muted" style={{ marginTop: 16 }}>
          The runtime takes work once a slot and a repository exist.
        </p>
      ) : null}
    </section>
  )
}

function EnginesStep({ state }: { state: 'done' | 'current' | 'pending' }) {
  const [engines, setEngines] = useState<EngineStatus[] | null>(null)
  const [logins, setLogins] = useState<ExistingLogins | null>(null)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    api
      .wizardEngines()
      .then(setEngines)
      .catch((error: unknown) => setNote(noteFor(error)))
    api
      .wizardExistingLogins()
      .then(setLogins)
      .catch(() => {})
  }, [])

  const loginLine = (login: ExistingLogin | null): string =>
    login === null
      ? 'not probed'
      : login.loggedIn
        ? ['signed in', login.email, login.plan].filter((part) => part !== undefined).join(' · ')
        : 'signed out'

  return (
    <Step
      state={state}
      title="Your coding agents"
      sub={
        engines === null
          ? 'Probing locally — each check is the engine’s own --version command.'
          : `Found ${engines
              .filter((engine) => engine.installed)
              .map((engine) => `${engine.engine} ${engine.version ?? ''}`.trim())
              .join(', ')}.`
      }
    >
      {state !== 'current' || engines === null ? null : (
        <ul className="rows" style={{ maxWidth: 480 }}>
          {engines.map((engine) => (
            <li className="row" key={engine.engine} style={{ cursor: 'default' }}>
              <div className="row-main">
                <p className="row-title">{engine.engine}</p>
                <p className="row-sub">
                  {engine.installed ? (engine.version ?? 'installed') : 'not found on PATH'} · existing login:{' '}
                  {loginLine(logins?.[engine.engine] ?? null)}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
      {note === null ? null : <p className="muted">{note}</p>}
    </Step>
  )
}

function SlotsStep({ state }: { state: 'done' | 'current' | 'pending' }) {
  const wb = useWorkbench()
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState<'link' | 'login' | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [logins, setLogins] = useState<ExistingLogins | null>(null)

  useEffect(() => {
    api
      .wizardExistingLogins()
      .then(setLogins)
      .catch(() => {})
  }, [])

  const link = useCallback(async () => {
    const trimmed = label.trim()
    if (trimmed === '') return
    setBusy('link')
    setNote(null)
    try {
      const linked = await api.linkSlot('claude', trimmed)
      setNote(`linked ${linked.id} → ${linked.home} (CLAUDE_CONFIG_DIR stays unset)`)
      void wb.refresh()
    } catch (error) {
      setNote(noteFor(error))
    } finally {
      setBusy(null)
    }
  }, [label, wb])

  const openLoginCard = useCallback(() => {
    const trimmed = label.trim()
    if (trimmed === '') return
    wb.openSheet({ kind: 'login', engine: 'claude', label: trimmed })
  }, [label, wb])

  return (
    <Step
      state={state}
      title="Connect a slot"
      sub="Pick how MEC should use each agent. You can add more slots later."
    >
      {state !== 'current' ? null : (
        <>
          <div className="options">
            <Option
              title="Use my existing Claude login"
              sub="Zero extra sign-in. MEC’s sessions will appear in your own history and share your quota."
              onClick={() => void link()}
            />
            <Option
              title="Sign in to a dedicated slot"
              sub="Recommended. Opens Anthropic’s own sign-in in a terminal card; MEC never sees the token."
              selected={busy === 'login'}
              onClick={openLoginCard}
            />
            <Option
              title="Paste an API key"
              sub="For GLM Coding Plan, Gemini, or Anthropic pay-as-you-go. Stored only in the slot’s keystore."
              onClick={() => wb.openSheet({ kind: 'key', prefillLabel: label.trim() || undefined })}
            />
          </div>
          <p className="muted" style={{ marginTop: 12 }}>
            Slot label for the dedicated or linked slot:{' '}
            <input
              type="text"
              aria-label="Slot label"
              placeholder="max-1"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              style={{
                padding: '4px 8px',
                border: '1px solid var(--line-strong)',
                borderRadius: 'var(--r-control)',
                background: 'var(--surface)',
              }}
            />
            {logins?.claude?.loggedIn === true
              ? ` (your default-home login: ${logins.claude.email ?? 'signed in'})`
              : ''}
          </p>
          <StepActions>
            <Btn
              variant="primary"
              disabled={busy !== null || label.trim() === '' || logins?.claude?.loggedIn !== true}
              onClick={() => void link()}
            >
              {busy === 'link' ? 'Linking…' : 'Link existing login'}
            </Btn>
            <Btn variant="quiet" disabled={label.trim() === ''} onClick={openLoginCard}>
              {busy === 'login' ? 'Opening…' : 'Open the sign-in card'}
            </Btn>
          </StepActions>
          {note === null ? null : <p className="muted">{note}</p>}
        </>
      )}
    </Step>
  )
}

function RepositoryStep({ state }: { state: 'done' | 'current' | 'pending' }) {
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
    <Step
      state={state}
      title="Add a repository"
      sub="A path or a URL. MEC reads its README and proposes the bootstrap and check commands for you to confirm."
    >
      {state !== 'current' ? null : (
        <form
          className="form"
          style={{ maxWidth: 520 }}
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <label>
            Repository path or https URL
            <input
              type="text"
              value={urlOrPath}
              onChange={(event) => setUrlOrPath(event.target.value)}
              placeholder="/path/to/repo"
            />
          </label>
          <label>
            Bootstrap command
            <input
              type="text"
              value={bootstrap}
              onChange={(event) => setBootstrap(event.target.value)}
              placeholder="pnpm install"
            />
          </label>
          <label>
            Check command
            <input
              type="text"
              value={checkCmd}
              onChange={(event) => setCheckCmd(event.target.value)}
              placeholder="pnpm exec tsc --noEmit"
            />
          </label>
          <label>
            Check name
            <input
              type="text"
              value={checkName}
              onChange={(event) => setCheckName(event.target.value)}
              placeholder="typecheck"
            />
          </label>
          <label style={{ flexDirection: 'row', alignItems: 'center' }}>
            <input type="checkbox" checked={trusted} onChange={(event) => setTrusted(event.target.checked)} />
            Trust this repository’s resident configuration (hooks, MCP, plugins)
          </label>
          <StepActions>
            <Btn type="submit" variant="primary" disabled={busy || urlOrPath.trim() === ''}>
              {busy ? 'Registering…' : 'Register'}
            </Btn>
          </StepActions>
          {note === null ? null : <p className="muted">{note}</p>}
          {saved === null ? null : (
            <p className="muted">
              Registered {saved.id} — {saved.url} ({saved.checks.length} check
              {saved.checks.length === 1 ? '' : 's'}).
            </p>
          )}
        </form>
      )}
    </Step>
  )
}

function MetaSlotStep({ state }: { state: 'done' | 'current' | 'pending' }) {
  const wb = useWorkbench()
  const [pick, setPick] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [current, setCurrent] = useState<string | null>(null)

  useEffect(() => {
    api
      .metaSlot()
      .then((meta) => setCurrent(meta.slotId))
      .catch(() => {})
  }, [])

  // The provider's slot list (SSE-fed) is the source here — no second local copy to go stale.
  const candidates = wb.slots.filter((slot) => slot.state !== 'retired')

  const choose = useCallback(async () => {
    if (pick === null) return
    setBusy(true)
    setNote(null)
    try {
      await api.setMetaSlot(pick)
      setCurrent(pick)
      setNote('Saved.')
    } catch (error) {
      setNote(noteFor(error))
    } finally {
      setBusy(false)
    }
  }, [pick])

  return (
    <Step
      state={state}
      title="Choose where the meta agent runs"
      sub="The healthiest subscription slot, unless you say otherwise."
    >
      {state !== 'current' ? null : candidates.length === 0 ? (
        <p className="muted">No slots yet — go back and link, sign in or paste a key.</p>
      ) : (
        <>
          <ul className="rows" style={{ maxWidth: 480 }}>
            {candidates.map((slot) => (
              <li className="row" key={slot.id} style={{ cursor: 'default' }}>
                <div className="row-main">
                  <p className="row-title">
                    <label>
                      <input
                        type="radio"
                        name="meta-slot"
                        checked={pick === slot.id || (pick === null && current === slot.id)}
                        onChange={() => setPick(slot.id)}
                      />{' '}
                      {slot.label}
                    </label>
                  </p>
                  <p className="row-sub">
                    {slot.kind} · {slot.state}
                  </p>
                </div>
              </li>
            ))}
          </ul>
          <StepActions>
            <Btn
              variant="primary"
              disabled={busy || (pick ?? current) === null}
              onClick={() => void choose()}
            >
              {busy ? 'Saving…' : 'Use this slot'}
            </Btn>
          </StepActions>
          {current === null ? null : <p className="muted">Currently: {current}</p>}
          {note === null ? null : <p className="muted">{note}</p>}
        </>
      )}
    </Step>
  )
}

function TryStep({ state }: { state: 'done' | 'current' | 'pending' }) {
  const wb = useWorkbench()

  const setup = wb.status?.setup
  return (
    <Step
      state={state}
      title="Try it"
      sub="A first request on your repository, with every push behind a card."
    >
      {state !== 'current' ? null : (
        <>
          <p className="muted">
            slot: {setup?.has_slot ? 'ready' : 'missing'} · repository:{' '}
            {setup?.has_repository ? 'ready' : 'missing'}
          </p>
          <StepActions>
            <Btn variant="primary" onClick={() => wb.navigate('chat')}>
              Open Chat
            </Btn>
            <Btn variant="quiet" onClick={() => wb.navigate('slots')}>
              Review slots
            </Btn>
          </StepActions>
        </>
      )}
    </Step>
  )
}

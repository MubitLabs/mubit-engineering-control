import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { HttpError, type LoginCardEvent, subscribeLoginCard } from '../api'
import { configApi, StaleError } from '../api-config'
import { ConnectionForm, type ConnectionRequest, SignInCard } from '../next/ConnectionForm'
import { type ConnectionCommands, ConnectionsView, type RetireArm } from '../next/ConnectionsView'
import { PageHeader } from '../next/Conversation'
import {
  type Capabilities,
  type ConnectionRow,
  type Connections,
  capabilityGate,
  checksText,
  type DraftView,
  draftsFor,
  type Editor,
  editDraft,
  impactLines,
  loadEditor,
  type PolicyView,
  type PromptsConfig,
  parseChecks,
  parseLines,
  proposalBase,
  type Readiness,
  type RepositoryView,
  rebaseDraft,
  roleOfPart,
  type StepRoute,
  saveFailed,
  saveStarted,
  saveSucceeded,
} from '../next/config-model'
import { RepositoryForm, type RepositoryRequest } from '../next/RepositoryForm'
import { ROUTE_LABELS } from '../next/routes'
import {
  BackupsBlock,
  ModelsBlock,
  PolicyBlock,
  type PromptCompare,
  PromptsBlock,
  Proposals,
  ReadError,
  RepositoriesBlock,
  RepositoryEditor,
  SettingsFrame,
  type SettingsSection,
} from '../next/SettingsView'
import { SetupView } from '../next/SetupView'
import type { Route } from '../router'
import type { ConfigStore } from './config-store'
import { Loading } from './surfaces'

/** Words for a failure: the server's own reason where it gave one. */
export function failureText(error: unknown): string {
  if (error instanceof HttpError) {
    const reason = error.reason ?? `The server answered ${error.status}.`
    return error.detail === undefined ? reason : `${reason}: ${error.detail}`
  }
  if (error instanceof Error && error.name === 'DecodeError') return error.message
  return 'Could not reach the workbench. Nothing was changed.'
}

function useConfigStore(store: ConfigStore): void {
  useSyncExternalStore(store.subscribe, store.version)
}

// ─── Reads ──────────────────────────────────────────────────────────────────────

type Read<T> =
  | { status: 'loading'; value: null }
  | { status: 'ready'; value: T }
  | { status: 'error'; value: T | null; message: string }

/** A failed re-read keeps what is on screen and says so; it never blanks a block. */
function useRead<T>(load: () => Promise<T>): [Read<T>, () => void] {
  const [read, setRead] = useState<Read<T>>({ status: 'loading', value: null })
  const loadRef = useRef(load)
  loadRef.current = load
  const generation = useRef(0)
  const refresh = useCallback(() => {
    generation.current += 1
    const mine = generation.current
    loadRef
      .current()
      .then((value) => {
        if (mine === generation.current) setRead({ status: 'ready', value })
      })
      .catch((error: unknown) => {
        if (mine !== generation.current) return
        setRead((current) => ({ status: 'error', value: current.value, message: failureText(error) }))
      })
  }, [])
  useEffect(() => {
    refresh()
    return () => {
      generation.current += 1
    }
  }, [refresh])
  return [read, refresh]
}

// ─── Connections ────────────────────────────────────────────────────────────────

interface SignIn {
  slotId: string
  label: string
  cardId: string
  lines: string[]
  url: string | null
  ended: boolean
  note: string | null
}

const LINE_LIMIT = 50

/** The shared add path for Setup and Connections, sign-in card included. */
function useConnectionFlow(onChanged: () => void) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [signIn, setSignIn] = useState<SignIn | null>(null)
  const detach = useRef<(() => void) | null>(null)

  useEffect(
    () => () => {
      detach.current?.()
    },
    [],
  )

  const begin = useCallback(async (slotId: string, label: string, engine: string) => {
    setError(null)
    let started: Awaited<ReturnType<typeof configApi.startLogin>>
    try {
      started = await configApi.startLogin(engine, label)
    } catch (failure) {
      setError(`The sign-in did not start, so ${label} is not signed in: ${failureText(failure)}`)
      return
    }
    // The card opens only once a command runs: it must never wait for one that failed to start.
    setSignIn({
      slotId,
      label,
      cardId: started.id,
      lines: [],
      url: null,
      ended: false,
      note: started.busy ? 'Another sign-in is running, so this card is attached to it.' : null,
    })
    detach.current?.()
    detach.current = subscribeLoginCard((event: LoginCardEvent) => {
      setSignIn((current) => {
        if (current === null) return current
        if (event.kind === 'output') {
          return { ...current, lines: [...current.lines.slice(1 - LINE_LIMIT), event.data] }
        }
        if (event.kind === 'url') return { ...current, url: event.url }
        if (event.kind === 'exit') {
          return { ...current, ended: true, note: `The sign-in command ended with code ${event.code}.` }
        }
        return { ...current, ended: true, note: 'The sign-in timed out after ten minutes.' }
      })
    })
  }, [])

  const submit = useCallback(
    async (request: ConnectionRequest) => {
      setBusy(true)
      setError(null)
      try {
        if (request.path === 'link') {
          const { id } = await configApi.link(request.engine, request.label)
          // A link is only usable once the engine's own status says so. A failed probe is a row, not an error.
          await configApi.probe(id).catch(() => {})
        }
        if (request.path === 'api_key') {
          await configApi.addKey(request.label, request.provider, request.key)
        }
        if (request.path === 'sign_in') {
          const { id } = await configApi.dedicated(request.engine, request.label)
          await begin(id, request.label, request.engine)
        }
        onChanged()
        return request.path !== 'sign_in'
      } catch (failure) {
        setError(failureText(failure))
        return false
      } finally {
        setBusy(false)
      }
    },
    [begin, onChanged],
  )

  const close = useCallback(() => {
    detach.current?.()
    detach.current = null
    setSignIn(null)
    onChanged()
  }, [onChanged])

  const finish = useCallback(async () => {
    if (signIn === null) return
    try {
      await configApi.probe(signIn.slotId)
    } catch (failure) {
      setError(failureText(failure))
    }
    close()
  }, [close, signIn])

  const cancel = useCallback(async () => {
    if (signIn) await configApi.cancelLogin(signIn.cardId).catch(() => {})
    close()
  }, [close, signIn])

  return { busy, error, signIn, submit, begin, finish, cancel }
}

function ConnectionPanel({
  connections,
  readiness,
  flow,
  onCancel,
  onAdded,
}: {
  connections: Connections
  readiness: Readiness | null
  flow: ReturnType<typeof useConnectionFlow>
  onCancel?: () => void
  onAdded?: () => void
}) {
  if (flow.signIn !== null) {
    return (
      <SignInCard
        label={flow.signIn.label}
        lines={flow.signIn.lines}
        url={flow.signIn.url}
        ended={flow.signIn.ended}
        note={flow.signIn.note}
        onCancel={() => void flow.cancel()}
        onDone={() => void flow.finish()}
      />
    )
  }
  return (
    <ConnectionForm
      options={connections.options}
      engines={readiness?.engines ?? []}
      busy={flow.busy}
      error={flow.error}
      {...(onCancel && { onCancel })}
      onSubmit={(request) => {
        void flow.submit(request).then((done) => {
          if (done) onAdded?.()
        })
      }}
    />
  )
}

function ConnectionsSurface({ capabilities }: { capabilities: Capabilities | null }) {
  const [read, refresh] = useRead(() => configApi.connections())
  const [readiness] = useRead(() => configApi.readiness())
  const flow = useConnectionFlow(refresh)
  const [adding, setAdding] = useState(false)
  const [arm, setArm] = useState<RetireArm | null>(null)
  const [notes, setNotes] = useState<Record<string, string>>({})
  const note = (id: string, text: string) => setNotes((current) => ({ ...current, [id]: text }))

  const commands: ConnectionCommands = {
    validate: (id) => {
      note(id, 'Checking the key with the provider…')
      configApi
        .validate(id)
        .then((result) =>
          note(
            id,
            result.ok
              ? 'The provider accepted the key.'
              : result.reason === 'key_rejected'
                ? 'The provider rejected the key. Replace it.'
                : 'The provider could not be reached. The state is unchanged.',
          ),
        )
        .catch((error: unknown) => note(id, failureText(error)))
        .finally(refresh)
    },
    probe: (id) => {
      note(id, 'Checking…')
      configApi
        .probe(id)
        .then((result) =>
          note(id, result.ok ? 'Signed in.' : `Not usable: ${result.reason ?? result.state}.`),
        )
        .catch((error: unknown) => note(id, failureText(error)))
        .finally(refresh)
    },
    signIn: (row: ConnectionRow) => {
      setAdding(true)
      void flow.begin(row.id, row.label, row.engine)
    },
    replaceKey: (id, key) => {
      note(id, 'Replacing the key…')
      configApi
        .replaceKey(id, key)
        .then((result) =>
          note(
            id,
            result.probe.ok
              ? `Key replaced, ending ${result.fingerprint.last4}. The provider accepted it.`
              : `Key replaced, ending ${result.fingerprint.last4}. Check: ${result.probe.reason ?? 'no verdict'}.`,
          ),
        )
        .catch((error: unknown) => note(id, failureText(error)))
        .finally(refresh)
    },
    armRetire: (id) => {
      setArm({ id, lines: null, error: null, busy: false })
      configApi
        .impact(id)
        .then((impact) =>
          setArm((current) => (current?.id === id ? { ...current, lines: impactLines(impact) } : current)),
        )
        .catch((error: unknown) =>
          setArm((current) => (current?.id === id ? { ...current, error: failureText(error) } : current)),
        )
    },
    disarmRetire: () => setArm(null),
    retire: (id, label) => {
      setArm((current) => current && { ...current, busy: true, error: null })
      configApi
        .retireSlot(id, label)
        .then(() => {
          setArm(null)
          refresh()
        })
        .catch((error: unknown) =>
          setArm((current) => current && { ...current, busy: false, error: failureText(error) }),
        )
    },
  }

  if (read.value === null) {
    return (
      <div className="page">
        <PageHeader title={ROUTE_LABELS.slots} />
        {read.status === 'error' ? (
          <ReadError what="connections" detail={read.message} onRetry={refresh} />
        ) : (
          <Loading title="Loading connections" />
        )}
      </div>
    )
  }
  return (
    <ConnectionsView
      rows={read.value.rows}
      capabilities={capabilities}
      commands={commands}
      arm={arm}
      notes={notes}
      adding={adding}
      onAdd={() => setAdding(true)}
      form={
        <ConnectionPanel
          connections={read.value}
          readiness={readiness.value}
          flow={flow}
          onCancel={() => setAdding(false)}
          onAdded={() => setAdding(false)}
        />
      }
    />
  )
}

// ─── Setup ──────────────────────────────────────────────────────────────────────

function SetupSurface({
  store,
  onNavigate,
  onRepositories,
}: {
  store: ConfigStore
  onNavigate: (route: Route) => void
  onRepositories: () => void
}) {
  const [readiness, refresh] = useRead(() => configApi.readiness())
  const [connections, refreshConnections] = useRead(() => configApi.connections())
  const changed = useCallback(() => {
    refresh()
    refreshConnections()
  }, [refresh, refreshConnections])
  const flow = useConnectionFlow(changed)
  const [repoBusy, setRepoBusy] = useState(false)
  const [repoError, setRepoError] = useState<string | null>(null)
  const [metaBusy, setMetaBusy] = useState(false)
  const [metaError, setMetaError] = useState<string | null>(null)

  const addRepository = (request: RepositoryRequest) => {
    setRepoBusy(true)
    setRepoError(null)
    configApi
      .addRepository(request)
      .then(() => {
        refresh()
        onRepositories()
      })
      .catch((error: unknown) => setRepoError(failureText(error)))
      .finally(() => setRepoBusy(false))
  }

  if (readiness.value === null) {
    return (
      <div className="page">
        <PageHeader title={ROUTE_LABELS.setup} />
        {readiness.status === 'error' ? (
          <ReadError what="readiness" detail={readiness.message} onRetry={refresh} />
        ) : (
          <Loading title="Reading what is ready" />
        )}
      </div>
    )
  }
  return (
    <SetupView
      readiness={readiness.value}
      connectionForm={
        connections.value && (
          <ConnectionPanel connections={connections.value} readiness={readiness.value} flow={flow} />
        )
      }
      repositoryForm={<RepositoryForm busy={repoBusy} error={repoError} onSubmit={addRepository} />}
      metaBusy={metaBusy}
      metaError={metaError}
      onChooseMeta={(slotId) => {
        setMetaBusy(true)
        setMetaError(null)
        configApi
          .chooseMetaSlot(slotId)
          .then(refresh)
          .catch((error: unknown) => setMetaError(failureText(error)))
          .finally(() => setMetaBusy(false))
      }}
      onSkip={(step) => {
        configApi
          .skipStep(step)
          .then(refresh)
          .catch(() => refresh())
      }}
      onNavigate={(route: StepRoute, step?: string) => {
        if (route === 'settings' && step === 'repository') store.section = 'repositories'
        onNavigate(route)
      }}
      onRecheck={refresh}
    />
  )
}

// ─── Settings ───────────────────────────────────────────────────────────────────

/** The one save flow: draft to server to base, with a refusal leaving the draft where it was. */
function saveEditor(
  store: ConfigStore,
  key: string,
  run: (text: string, version: string) => Promise<string>,
  after?: () => void,
): void {
  const editor = store.editor(key)
  if (editor?.draft === null || editor?.draft === undefined) return
  const text = editor.draft
  store.update(key, saveStarted(editor))
  run(text, editor.version)
    .then((version) => {
      const current = store.editor(key)
      if (current) store.update(key, saveSucceeded(current, text, version))
      after?.()
    })
    .catch((error: unknown) => {
      const current = store.editor(key)
      if (!current) return
      store.update(
        key,
        saveFailed(
          current,
          error instanceof StaleError
            ? { message: 'stale', stale: true }
            : { message: failureText(error), stale: false },
        ),
      )
    })
}

const NO_EDITOR: Editor = { base: '', version: '', draft: null, save: { kind: 'idle' } }

function useEditorProps(
  store: ConfigStore,
  key: string,
  save: () => void,
  newest: () => Promise<{ base: string; version: string }>,
) {
  const editor = store.editor(key) ?? NO_EDITOR
  return {
    editor,
    onEdit: (text: string) => store.update(key, editDraft(store.editor(key) ?? NO_EDITOR, text)),
    onSave: save,
    onDiscard: () => {
      const current = store.editor(key) ?? NO_EDITOR
      newest()
        .then(({ base, version }) =>
          store.update(key, { ...current, base, version, draft: null, save: { kind: 'idle' } }),
        )
        .catch(() => store.update(key, { ...current, draft: null, save: { kind: 'idle' } }))
    },
    onUseNewest: () => {
      newest()
        .then(({ base, version }) => {
          const current = store.editor(key)
          if (current) store.update(key, rebaseDraft(current, base, version))
        })
        .catch((error: unknown) => {
          const current = store.editor(key)
          if (current) {
            store.update(key, saveFailed(current, { message: failureText(error), stale: true }))
          }
        })
    },
  }
}

function useDrafts(target: string, baseOf: () => string | number | undefined, onApplied: () => void) {
  const [read, refresh] = useRead(() => configApi.drafts())
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const drafts: DraftView[] = draftsFor(read.value ?? [], target)
  // A save moves the base, which redraws every comparison against the new text.
  const newest = baseOf()
  useEffect(() => {
    if (newest !== undefined) refresh()
  }, [newest, refresh])
  const element = (
    <Proposals
      drafts={drafts}
      busyId={busyId}
      error={error}
      onApply={(id) => {
        const base = proposalBase(
          drafts.find((entry) => entry.id === id),
          baseOf(),
        )
        setBusyId(id)
        setError(null)
        configApi
          .applyDraft(id, base)
          .then(() => {
            refresh()
            onApplied()
          })
          .catch((failure: unknown) => {
            if (failure instanceof StaleError) {
              refresh()
              setError('This changed since you loaded it, so nothing was applied. Check the proposal again.')
            } else setError(failureText(failure))
          })
          .finally(() => setBusyId(null))
      }}
      onDismiss={(id) => {
        configApi
          .dismissDraft(id)
          .then(refresh)
          .catch((failure: unknown) => setError(failureText(failure)))
      }}
    />
  )
  return element
}

function PolicySection({ store }: { store: ConfigStore }) {
  const [read, refresh] = useRead(() => configApi.policy())
  useEffect(() => {
    if (read.value)
      store.update('policy', loadEditor(store.editor('policy'), read.value.text, read.value.sha256))
  }, [read.value, store])
  const save = () =>
    saveEditor(
      store,
      'policy',
      (text, base) => configApi.savePolicy(text, base).then((saved) => saved.sha256),
      refresh,
    )
  const editor = useEditorProps(store, 'policy', save, async () => {
    const policy: PolicyView = await configApi.policy()
    return { base: policy.text, version: policy.sha256 }
  })
  const proposals = useDrafts('policy', () => read.value?.sha256, refresh)
  if (read.value === null) {
    return read.status === 'error' ? (
      <ReadError what="the policy" detail={read.message} onRetry={refresh} />
    ) : (
      <Loading title="Loading the policy" />
    )
  }
  return <PolicyBlock policy={read.value} proposals={proposals} {...editor} />
}

function ModelsSection({ store }: { store: ConfigStore }) {
  const [read, refresh] = useRead(() => configApi.modelsText())
  useEffect(() => {
    if (read.value)
      store.update('models', loadEditor(store.editor('models'), read.value.yaml, read.value.sha256))
  }, [read.value, store])
  const save = () =>
    saveEditor(
      store,
      'models',
      (text, base) => configApi.saveModels(text, base).then((saved) => saved.provenance.sha256),
      refresh,
    )
  const editor = useEditorProps(store, 'models', save, async () => {
    const models = await configApi.modelsText()
    return { base: models.yaml, version: models.sha256 }
  })
  const proposals = useDrafts('models', () => read.value?.sha256, refresh)
  if (read.value === null) {
    return read.status === 'error' ? (
      <ReadError what="the models table" detail={read.message} onRetry={refresh} />
    ) : (
      <Loading title="Loading the models table" />
    )
  }
  return <ModelsBlock models={read.value} proposals={proposals} {...editor} />
}

const promptKey = (path: string): string => `prompt:${path}`

function PromptsSection({ store }: { store: ConfigStore }) {
  const [read, refresh] = useRead(async () => {
    const [config, defaults] = await Promise.all([configApi.prompts(), configApi.promptDefaults()])
    return { config, defaults }
  })
  const [compare, setCompare] = useState<PromptCompare>({ kind: 'none' })
  const config: PromptsConfig | undefined = read.value?.config
  const selected = config?.parts.find((part) => part.path === store.promptPath) ?? config?.parts[0] ?? null
  const key = selected ? promptKey(selected.path) : ''
  const textOf = useCallback(
    (path: string): string => read.value?.config.overrides[path] ?? read.value?.defaults[path] ?? '',
    [read.value],
  )
  useEffect(() => {
    if (read.value && selected) {
      store.update(
        key,
        loadEditor(store.editor(key), textOf(selected.path), String(read.value.config.revision)),
      )
    }
  }, [key, read.value, selected, store, textOf])

  const save = () => {
    if (!selected) return
    saveEditor(
      store,
      key,
      (text, base) =>
        configApi.savePromptPart(selected.path, text, Number(base)).then((saved) => String(saved.revision)),
      refresh,
    )
  }
  const editor = useEditorProps(store, key, save, async () => {
    const [latest, defaults] = await Promise.all([configApi.prompts(), configApi.promptDefaults()])
    const path = selected?.path ?? ''
    return { base: latest.overrides[path] ?? defaults[path] ?? '', version: String(latest.revision) }
  })
  const proposals = useDrafts('prompts', () => read.value?.config.revision, refresh)
  if (read.value === null || config === undefined) {
    return read.status === 'error' ? (
      <ReadError what="the prompt parts" detail={read.message} onRetry={refresh} />
    ) : (
      <Loading title="Loading the prompt parts" />
    )
  }
  const current = selected ? (store.editor(key)?.draft ?? textOf(selected.path)) : ''
  const compareWith = (title: string, load: () => Promise<string>) => {
    setCompare({ kind: 'loading' })
    load()
      .then((before) => setCompare({ kind: 'diff', title, before, after: current }))
      .catch((error: unknown) => setCompare({ kind: 'failed', message: failureText(error) }))
  }
  const dirty = new Set(
    store
      .dirtyKeys()
      .filter((entry) => entry.startsWith('prompt:'))
      .map((entry) => entry.slice('prompt:'.length)),
  )
  return (
    <PromptsBlock
      parts={config.parts}
      selected={selected}
      revision={config.revision}
      unsavedParts={dirty}
      compare={compare}
      proposals={proposals}
      onSelect={(path) => {
        store.promptPath = path
        setCompare({ kind: 'none' })
        store.notify()
      }}
      onCompareDefault={() =>
        compareWith('Default, then your text', async () => read.value?.defaults[selected?.path ?? ''] ?? '')
      }
      onCompareUpdate={() => {
        setCompare({ kind: 'loading' })
        configApi
          .promptChanges()
          .then((changes) => {
            const change = changes.find((entry) => entry.path === selected?.path)
            setCompare(
              change === undefined
                ? { kind: 'failed', message: 'The server lists no change for this part.' }
                : {
                    kind: 'diff',
                    title: 'The old default, then the new one',
                    before: change.oldDefault ?? '',
                    after: change.newDefault ?? '',
                  },
            )
          })
          .catch((error: unknown) => setCompare({ kind: 'failed', message: failureText(error) }))
      }}
      onCompareRevision={(n) =>
        compareWith(`Revision ${n}, then your text`, async () => {
          const parts = await configApi.promptRevision(n)
          return parts[selected?.path ?? ''] ?? read.value?.defaults[selected?.path ?? ''] ?? ''
        })
      }
      onFullPrompt={() => {
        const role = roleOfPart(selected?.path ?? '')
        if (role === null) return
        setCompare({ kind: 'loading' })
        configApi
          .promptPreview(role)
          .then((preview) =>
            setCompare({
              kind: 'full',
              title: `Full prompt, version ${preview.revision.slice(0, 12)}`,
              text: preview.text,
            }),
          )
          .catch((error: unknown) => setCompare({ kind: 'failed', message: failureText(error) }))
      }}
      {...editor}
    />
  )
}

function RepositoryItem({
  repository,
  store,
  capabilities,
  onChanged,
}: {
  repository: RepositoryView
  store: ConfigStore
  capabilities: Capabilities | null
  onChanged: () => void
}) {
  const bootstrapKey = `repo:${repository.id}:bootstrap`
  const checksKey = `repo:${repository.id}:checks`
  const bootstrapText = repository.bootstrap.join('\n')
  const checks = checksText(repository.checks)
  useEffect(() => {
    store.update(bootstrapKey, loadEditor(store.editor(bootstrapKey), bootstrapText, repository.revision))
    store.update(checksKey, loadEditor(store.editor(checksKey), checks, repository.revision))
  }, [bootstrapKey, bootstrapText, checks, checksKey, repository.revision, store])

  const newest = async () => {
    const latest = (await configApi.repositories()).find((entry) => entry.id === repository.id)
    if (latest === undefined) throw new Error('that repository is gone')
    return latest
  }
  const bootstrapProps = useEditorProps(
    store,
    bootstrapKey,
    () =>
      saveEditor(
        store,
        bootstrapKey,
        (text, base) =>
          configApi
            .editRepository(repository.id, base, { bootstrapCmds: parseLines(text) })
            .then((saved) => saved.revision),
        onChanged,
      ),
    async () => {
      const latest = await newest()
      return { base: latest.bootstrap.join('\n'), version: latest.revision }
    },
  )
  const checksProps = useEditorProps(
    store,
    checksKey,
    () =>
      saveEditor(
        store,
        checksKey,
        (text, base) =>
          configApi
            .editRepository(repository.id, base, { checkCmds: parseChecks(text) })
            .then((saved) => saved.revision),
        onChanged,
      ),
    async () => {
      const latest = await newest()
      return { base: checksText(latest.checks), version: latest.revision }
    },
  )
  const [trustBusy, setTrustBusy] = useState(false)
  const [trustError, setTrustError] = useState<string | null>(null)
  const isolation = capabilityGate(capabilities, 'isolationEdit')
  return (
    <RepositoryEditor
      repository={repository}
      bootstrap={bootstrapProps}
      checks={checksProps}
      trustBusy={trustBusy}
      trustError={trustError}
      isolation={{ editable: isolation.enabled, reason: isolation.enabled ? null : isolation.reason }}
      onSetTrust={(trust) => {
        setTrustBusy(true)
        setTrustError(null)
        configApi
          .editRepository(repository.id, repository.revision, { trusted: trust })
          .then(onChanged)
          .catch((error: unknown) =>
            setTrustError(
              error instanceof StaleError
                ? 'This repository changed elsewhere, so trust was not changed. Reload it and try again.'
                : failureText(error),
            ),
          )
          .finally(() => setTrustBusy(false))
      }}
    />
  )
}

function RepositoriesSection({
  store,
  capabilities,
  onRepositories,
}: {
  store: ConfigStore
  capabilities: Capabilities | null
  onRepositories: () => void
}) {
  const [read, refresh] = useRead(() => configApi.repositories())
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const changed = useCallback(() => {
    refresh()
    onRepositories()
  }, [onRepositories, refresh])
  const proposals = useDrafts('repository', () => undefined, changed)
  if (read.value === null) {
    return read.status === 'error' ? (
      <ReadError what="repositories" detail={read.message} onRetry={refresh} />
    ) : (
      <Loading title="Loading repositories" />
    )
  }
  return (
    <RepositoriesBlock
      adding={adding}
      onAdd={() => setAdding(true)}
      proposals={proposals}
      form={
        <RepositoryForm
          busy={busy}
          error={error}
          onCancel={() => setAdding(false)}
          onSubmit={(request) => {
            setBusy(true)
            setError(null)
            configApi
              .addRepository(request)
              .then(() => {
                setAdding(false)
                changed()
              })
              .catch((failure: unknown) => setError(failureText(failure)))
              .finally(() => setBusy(false))
          }}
        />
      }
    >
      {read.value.length === 0 && !adding ? (
        <p className="muted">No repositories yet.</p>
      ) : (
        read.value.map((repository) => (
          <RepositoryItem
            key={repository.id}
            repository={repository}
            store={store}
            capabilities={capabilities}
            onChanged={changed}
          />
        ))
      )}
    </RepositoriesBlock>
  )
}

function BackupsSection({ capabilities }: { capabilities: Capabilities | null }) {
  const enabled = capabilities?.backups === true
  const [record, setRecord] = useState<Awaited<ReturnType<typeof configApi.backups>> | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)
  const reload = useCallback(() => {
    if (enabled)
      configApi
        .backups()
        .then(setRecord)
        .catch(() => setRecord(null))
  }, [enabled])
  useEffect(reload, [reload])
  return (
    <BackupsBlock
      capabilities={capabilities}
      record={record}
      busy={busy}
      result={result}
      onBackup={() => {
        setBusy(true)
        setResult(null)
        configApi
          .takeBackup()
          .then((taken) => {
            setResult({ ok: true, message: `Backed up as ${taken.archive}.` })
            reload()
          })
          .catch((error: unknown) =>
            setResult({ ok: false, message: `Backup failed: ${failureText(error)}` }),
          )
          .finally(() => setBusy(false))
      }}
    />
  )
}

const SECTION_OF = (key: string): SettingsSection =>
  key.startsWith('prompt:') ? 'prompts' : key.startsWith('repo:') ? 'repositories' : (key as SettingsSection)

function SettingsSurface({
  store,
  capabilities,
  onRepositories,
}: {
  store: ConfigStore
  capabilities: Capabilities | null
  onRepositories: () => void
}) {
  const unsaved = new Set(store.dirtyKeys().map(SECTION_OF))
  const section = store.section
  let body: ReactNode
  if (section === 'policy') body = <PolicySection store={store} />
  else if (section === 'prompts') body = <PromptsSection store={store} />
  else if (section === 'models') body = <ModelsSection store={store} />
  else if (section === 'repositories') {
    body = <RepositoriesSection store={store} capabilities={capabilities} onRepositories={onRepositories} />
  } else body = <BackupsSection capabilities={capabilities} />
  return (
    <SettingsFrame
      section={section}
      unsaved={unsaved}
      onSection={(next) => {
        store.section = next
        store.notify()
      }}
    >
      {body}
    </SettingsFrame>
  )
}

// ─── The three routes ───────────────────────────────────────────────────────────

export function ConfigSurface({
  route,
  store,
  onNavigate,
  onRepositories,
}: {
  route: Route
  store: ConfigStore
  onNavigate: (route: Route) => void
  /** Tells the workspace a repository changed, so its list and selector follow. */
  onRepositories: () => void
}) {
  useConfigStore(store)
  const [capabilities] = useRead(() => configApi.capabilities())
  const flags = capabilities.value
  if (route === 'slots') return <ConnectionsSurface capabilities={flags} />
  if (route === 'setup') {
    return <SetupSurface store={store} onNavigate={onNavigate} onRepositories={onRepositories} />
  }
  return <SettingsSurface store={store} capabilities={flags} onRepositories={onRepositories} />
}

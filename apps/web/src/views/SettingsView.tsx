import { useEffect, useState } from 'react'
import { api, type BackupsStatus, isNotServed, type PromptPart } from '../api'
import { LoadFailed, useLoad } from '../components/LoadState'
import { PartEditor, PartList, SettingsNav, type SettingsSection, TierTable } from '../components/Settings'
import { useWorkbench } from '../workbench'

/** Settings: Policy, Prompts, Models, Repositories, Backups — each honest about what is served. */
export function SettingsView() {
  const _wb = useWorkbench()
  const [section, setSection] = useState<SettingsSection>('prompts')

  return (
    <section className="pane is-active" id="pane-settings" aria-labelledby="settings-title">
      <header className="pane-head">
        <h1 className="pane-title" id="settings-title">
          Settings
        </h1>
      </header>
      <div className="settings">
        <SettingsNav active={section} onSelect={setSection} />
        <div className="settings-body">
          {section === 'policy' ? <PolicySection /> : null}
          {section === 'prompts' ? <PromptsSection /> : null}
          {section === 'models' ? <ModelsSection /> : null}
          {section === 'repos' ? <ReposSection /> : null}
          {section === 'backups' ? <BackupsSection /> : null}
        </div>
      </div>
    </section>
  )
}

function SectionHead({ title, sub }: { title: string; sub: string }) {
  return (
    <header className="section-head">
      <h2 className="section-title">{title}</h2>
      <p className="muted">{sub}</p>
    </header>
  )
}

function PolicySection() {
  return (
    <section className="settings-section is-active" id="settings-policy">
      <SectionHead
        title="Policy"
        sub="Caps, confirmation classes, pairs and spend limits. Edited here with validation; agents can only propose."
      />
      <div className="empty">
        <p>Policy editor lands with the planner work.</p>
      </div>
    </section>
  )
}

function PromptsSection() {
  const [load, retry] = useLoad<PromptPart[]>(() => api.prompts(), [])
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const parts = load.status === 'ready' ? load.value : null
  useEffect(() => {
    if (parts === null) return
    setSelectedId(
      (current) => current ?? parts.find((part) => part.defaultUpdated === true)?.id ?? parts[0]?.id ?? null,
    )
  }, [parts])

  const selected = parts?.find((part) => part.id === selectedId) ?? null

  return (
    <section className="settings-section is-active" id="settings-prompts">
      <SectionHead
        title="Prompts"
        sub="What each agent reads. Edit any part; your text stays when defaults change, and you decide what to take."
      />
      {load.status === 'loading' ? <p className="muted">Loading the parts…</p> : null}
      {load.status === 'error' ? (
        <LoadFailed what="the prompt parts" message={load.message} onRetry={retry} />
      ) : null}
      {parts !== null ? (
        <div className="parts">
          <PartList parts={parts} selectedId={selectedId} onSelect={setSelectedId} />
          {selected === null ? (
            <div className="editor">
              <p className="muted" style={{ padding: 16 }}>
                Select a part.
              </p>
            </div>
          ) : (
            <PartEditor
              part={selected}
              onSaved={(note) => {
                void note
              }}
            />
          )}
        </div>
      ) : null}
      <p className="muted" style={{ marginTop: 12 }}>
        Edits here hold only for this session. Settings in the new workbench saves them (add ?ui=next).
      </p>
    </section>
  )
}

function ModelsSection() {
  return (
    <section className="settings-section is-active" id="settings-models">
      <SectionHead
        title="Models"
        sub="The ladder the meta agent plans with. Tiers are relative within a provider; the vendor’s own words are shown, not ours."
      />
      <TierTable />
    </section>
  )
}

function ReposSection() {
  const wb = useWorkbench()
  const repositories = wb.repositories
  return (
    <section className="settings-section is-active" id="settings-repos">
      <SectionHead
        title="Repositories"
        sub="Where work lands: each with its bootstrap and check commands, trust level and UI-evidence rule."
      />
      {repositories.length === 0 ? (
        <div className="empty">
          <p>No repositories registered yet — add one in Setup.</p>
        </div>
      ) : (
        <ul className="rows">
          {repositories.map((repo) => (
            <li className="row" key={repo.id} style={{ cursor: 'default' }}>
              <div className="row-main">
                <p className="row-title mono">{repo.url}</p>
                <p className="row-sub">
                  bootstrap: {repo.bootstrap.join(' && ') || '—'} · checks:{' '}
                  {repo.checks.map((check) => check.name).join(', ') || '—'}
                </p>
              </div>
              <div className="row-side">
                <span className="state state-ok">{repo.trust ? 'trusted' : 'untrusted'}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function BackupsSection() {
  const wb = useWorkbench()
  const [load, retry] = useLoad<BackupsStatus>(() => api.backups(), [])

  return (
    <section className="settings-section is-active" id="settings-backups">
      <SectionHead title="Backups" sub="The store, on a schedule, with credentials excluded by rule." />
      {load.status === 'loading' ? (
        <div className="empty">
          <p>Loading the backup record…</p>
        </div>
      ) : null}
      {load.status === 'error' ? (
        <LoadFailed what="the backup record" message={load.message} onRetry={retry} />
      ) : null}
      {load.status === 'ready' ? (
        <div className="empty">
          <p>
            Last backup {load.value.lastAt ?? 'never'} — {load.value.note}{' '}
            <button
              type="button"
              className="link"
              onClick={() =>
                void (async () => {
                  try {
                    await api.backupNow()
                    wb.toast('Backup started.')
                  } catch (error) {
                    wb.toast(
                      isNotServed(error)
                        ? 'Backups are not served by the server yet.'
                        : 'Backup failed — try again.',
                    )
                  }
                })()
              }
            >
              Back up now
            </button>
          </p>
        </div>
      ) : null}
    </section>
  )
}

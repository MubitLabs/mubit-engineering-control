import type { Editor } from '../next/config-model'
import type { SettingsSection } from '../next/SettingsView'

/** One per page, above the routes, so leaving a section keeps its drafts. */
export function createConfigStore() {
  const editors = new Map<string, Editor>()
  const watchers = new Set<() => void>()
  let version = 0
  const notify = () => {
    version += 1
    for (const watcher of watchers) watcher()
  }
  return {
    section: 'policy' as SettingsSection,
    promptPath: null as string | null,
    subscribe(watcher: () => void) {
      watchers.add(watcher)
      return () => {
        watchers.delete(watcher)
      }
    },
    version: () => version,
    notify,
    editor: (key: string): Editor | undefined => editors.get(key),
    update(key: string, editor: Editor) {
      editors.set(key, editor)
      notify()
    },
    dirtyKeys: (): string[] =>
      [...editors.entries()].filter(([, editor]) => editor.draft !== null).map(([key]) => key),
  }
}
export type ConfigStore = ReturnType<typeof createConfigStore>

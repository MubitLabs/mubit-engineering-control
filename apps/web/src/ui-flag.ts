/**
 * The shell flag. Everything that is not an explicit, durable `classic` is next: a local
 * presentation choice that grants no authority and asks no server. Classic stays reachable for
 * one verified install (decision #35).
 */
export type Shell = 'classic' | 'next'

export const UI_SHELL_KEY = 'mec-ui-shell'

type ShellStore = Pick<Storage, 'getItem' | 'setItem'>

export interface ShellChoice {
  shell: Shell
  /** The query string with a recognised `ui` param removed. */
  search: string
}

/** `storage` is a getter because `window.localStorage` itself can throw. */
export function resolveShell(search: string, storage: () => ShellStore): ShellChoice {
  const params = new URLSearchParams(search)
  const asked = params.get('ui')

  if (asked !== 'next' && asked !== 'classic') return { shell: readStored(storage), search }

  params.delete('ui')
  const rest = params.toString()
  return { shell: store(storage, asked), search: rest ? `?${rest}` : '' }
}

function readStored(storage: () => ShellStore): Shell {
  try {
    return storage().getItem(UI_SHELL_KEY) === 'classic' ? 'classic' : 'next'
  } catch {
    return 'next'
  }
}

/** A choice that cannot be kept would vanish on reload, so it never applies. */
function store(storage: () => ShellStore, shell: Shell): Shell {
  try {
    storage().setItem(UI_SHELL_KEY, shell)
    return shell
  } catch {
    return 'next'
  }
}

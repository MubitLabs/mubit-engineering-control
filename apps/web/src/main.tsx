import { resolveShell } from './ui-flag'

const container = document.getElementById('root')
if (!container) throw new Error('expected #root in index.html')

const { shell, search } = resolveShell(window.location.search, () => window.localStorage)
if (search !== window.location.search) {
  window.history.replaceState(null, '', `${window.location.pathname}${search}${window.location.hash}`)
}

// Each shell brings its own stylesheets: their tokens and class names collide by design.
// A table, never a conditional: the build folds `flag ? import(a) : import(b)`, or the same
// thing as an if, into one preload list and hands classic's CSS to both shells
// (test/shell-split.test.ts).
const SHELLS = {
  next: () => import('./live/entry'),
  classic: () => import('./classic-entry'),
}

SHELLS[shell]()
  .then(({ mount }) => mount(container))
  .catch(() => {
    container.textContent = 'The workbench could not load. Reload the page to try again.'
  })

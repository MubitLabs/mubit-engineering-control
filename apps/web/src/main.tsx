import { startApproval } from './approval'

const container = document.getElementById('root')
if (!container) throw new Error('expected #root in index.html')

// Before the shell reads the address: a link's code is in its fragment, and it is no route.
startApproval()
  .then(() => import('./live/entry'))
  .then(({ mount }) => mount(container))
  .catch(() => {
    container.textContent = 'The workbench could not load. Reload the page to try again.'
  })

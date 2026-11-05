import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './tokens.css'
import './workbench.css'

export function mount(container: HTMLElement): void {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

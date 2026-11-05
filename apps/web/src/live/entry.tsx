import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { LiveApp } from './LiveApp'
import '../next/styles'
import './live.css'

export function mount(container: HTMLElement): void {
  createRoot(container).render(
    <StrictMode>
      <LiveApp />
    </StrictMode>,
  )
}

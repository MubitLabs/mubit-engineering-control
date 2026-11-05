import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { NextApp } from './NextApp'
import './styles'

export function mount(container: HTMLElement): void {
  createRoot(container).render(
    <StrictMode>
      <NextApp />
    </StrictMode>,
  )
}

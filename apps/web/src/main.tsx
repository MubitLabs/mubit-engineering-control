import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './tokens.css'
import './workbench.css'

const container = document.getElementById('root')
if (!container) throw new Error('expected #root in index.html')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

import { useCallback, useEffect, useState } from 'react'

export type ThemeChoice = 'auto' | 'light' | 'dark'

/** Separate from classic's `mec-theme` so trying the new shell never touches the old one. */
const THEME_KEY = 'mec-next-theme'

function readTheme(): ThemeChoice {
  try {
    const stored = localStorage.getItem(THEME_KEY)
    if (stored === 'light' || stored === 'dark') return stored
  } catch {
    // No storage: Auto stands.
  }
  return 'auto'
}

export function useTheme(): [ThemeChoice, (choice: ThemeChoice) => void] {
  const [theme, setTheme] = useState<ThemeChoice>(readTheme)

  useEffect(() => {
    if (theme === 'auto') delete document.documentElement.dataset.theme
    else document.documentElement.dataset.theme = theme
  }, [theme])

  const choose = useCallback((choice: ThemeChoice) => {
    setTheme(choice)
    try {
      localStorage.setItem(THEME_KEY, choice)
    } catch {
      // The choice still holds for this session.
    }
  }, [])

  return [theme, choose]
}

export const THEME_LABELS: Record<ThemeChoice, string> = { auto: 'Auto', light: 'Light', dark: 'Dark' }

export function nextTheme(theme: ThemeChoice): ThemeChoice {
  if (theme === 'auto') return 'light'
  return theme === 'light' ? 'dark' : 'auto'
}

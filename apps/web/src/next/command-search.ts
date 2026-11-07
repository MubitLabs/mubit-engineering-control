/** Commands whose label holds what was typed. */
export function commandMatches<T extends { label: string }>(commands: readonly T[], query: string): T[] {
  const typed = query.trim().toLowerCase()
  return commands.filter((command) => command.label.toLowerCase().includes(typed))
}

/**
 * The palette filters commands, so what it cannot match may still be work: it offers the real
 * search for the words typed. Null with nothing typed, or with no search to answer it.
 */
export function searchOffer(query: string, available: boolean): { query: string; label: string } | null {
  const typed = query.trim()
  if (typed === '' || !available) return null
  return { query: typed, label: `Search work, tasks and messages for “${typed}”` }
}

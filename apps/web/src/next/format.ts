/** The time alone means today: any other day says which, or a date tomorrow reads as now. */
export function timeLabel(at: string): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return at
  const time = { hour: '2-digit', minute: '2-digit' } as const
  const now = new Date()
  if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString([], time)
  const year = date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' as const }
  return date.toLocaleString([], { month: 'short', day: 'numeric', ...year, ...time })
}

/** Tool output keeps its lines; a sentence stays a sentence. */
export const multiline = (text: string): boolean => text.trim().includes('\n')

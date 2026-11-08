/**
 * §11's utilisation ceiling, and what a person reads when work waits on it. The owner raised it
 * from 80% to 95% of a connection's limit on 8 November 2026. Running attempts are never stopped
 * by it: only new work waits, and the wait names the connection, how far it is, the ceiling and
 * when the window resets, from the last reading the slot doc holds.
 */
import type { StoreDoc } from '@mec/contracts'

/** Start no new attempt on a slot whose last reading is at or above this share of its limit. */
export const UTILISATION_CEILING = 0.95

/** Who the limit belongs to, by slot kind; an unknown kind is a connection. */
const OWNER: Readonly<Record<string, string>> = {
  'claude-sub': 'Claude account',
  'claude-api': 'Claude API key',
  'claude-glm': 'GLM connection',
  'codex-sub': 'ChatGPT account',
  'codex-api': 'OpenAI API key',
  'opencode-glm': 'GLM connection',
  'opencode-gemini': 'Gemini connection',
}

/** The provider's window in words; an unknown window names none. */
const WINDOW: Readonly<Record<string, string>> = {
  five_hour: 'five-hour',
  seven_day: 'weekly',
  seven_day_opus: 'weekly Opus',
  seven_day_sonnet: 'weekly Sonnet',
  weekly: 'weekly',
  per_minute: 'per-minute',
  per_day: 'daily',
  overage: 'overage',
}

const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

/** "Tue 10 Nov 07:00" in `timeZone`, the machine's own when absent; undefined for no real time. */
export function resetText(iso: string | undefined, timeZone?: string): string | undefined {
  const when = iso === undefined ? Number.NaN : Date.parse(iso)
  if (Number.isNaN(when)) return undefined
  const parts = new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    ...(timeZone !== undefined && { timeZone }),
  }).formatToParts(new Date(when))
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((row) => row.type === type)?.value ?? ''
  return `${part('weekday')} ${part('day')} ${part('month')} ${part('hour')}:${part('minute')}`
}

/**
 * "Claude account preflight-a is at 96% of its weekly limit; MEC stops at 95%. Resets Tue 10 Nov
 * 07:00". A reset no reading gave is said to be unknown, never guessed.
 */
export function ceilingWords(slot: StoreDoc | undefined, slotId: string, timeZone?: string): string {
  const owner = OWNER[text(slot?.kind) ?? ''] ?? 'Connection'
  const label = text(slot?.label) ?? slotId
  const share = typeof slot?.usageUtilization === 'number' ? slot.usageUtilization : UTILISATION_CEILING
  const window = WINDOW[text(slot?.usageWindow) ?? '']
  const resets = resetText(text(slot?.usageResetsAt) ?? text(slot?.resets_at), timeZone)
  return (
    `${owner} ${label} is at ${Math.round(share * 100)}% of its ${window === undefined ? '' : `${window} `}limit; ` +
    `MEC stops at ${Math.round(UTILISATION_CEILING * 100)}%. ` +
    (resets === undefined ? 'When it resets is not known.' : `Resets ${resets}`)
  )
}

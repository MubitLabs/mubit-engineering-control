/**
 * Slot lifecycle — plan §5.5.
 *
 * ```
 * draft ─home_created─► home_ready ─login_started─► login_pending ─probe_ok─► healthy
 * login_pending ─login_cancelled/probe_failed─► degraded
 * healthy ⇄ degraded (probe_failed / probe_ok, with a reason)
 * healthy/degraded ─retire─► retired   (home kept on disk until the user deletes it)
 * ```
 *
 * Anything not in the diagram is refused — no implicit self-loops, no silent
 * recovery. Every applied transition emits exactly one SlotEvent through the
 * constructor callback (the `slot.changed` shape of CONTRACTS §5): the event
 * carries the degraded reason whenever the slot enters `degraded`.
 */
import type { Degraded, SlotState } from '@mec/contracts'

export type SlotEvent = {
  slot: string
  from: SlotState
  to: SlotState
  reason?: Degraded
  at: string
}

export type SlotSignal =
  | 'home_created'
  | 'login_started'
  | 'probe_ok'
  | 'probe_failed'
  | 'login_cancelled'
  | 'retire'

/** A v0 probe failure means the login did not hold; the action that clears it is "sign in again". */
const DEFAULT_DEGRADED_REASON: Degraded = 'auth_expired'

const TRANSITIONS: Readonly<Record<string, SlotState>> = {
  'draft --home_created': 'home_ready',
  'home_ready --login_started': 'login_pending',
  'login_pending --probe_ok': 'healthy',
  'login_pending --probe_failed': 'degraded',
  'login_pending --login_cancelled': 'degraded',
  'healthy --probe_failed': 'degraded',
  'degraded --probe_ok': 'healthy',
  'healthy --retire': 'retired',
  'degraded --retire': 'retired',
}

export class SlotMachine {
  constructor(private readonly onEvent: (event: SlotEvent) => void) {}

  /**
   * Applies one §5.5 edge and returns the new state; the input slot object is
   * never mutated. `reason` is consulted only when the target state is
   * `degraded` and defaults to `auth_expired`; anything outside the diagram
   * throws `invalid transition <from> --<event>-->`.
   */
  apply(slot: { id: string; state: SlotState }, event: SlotSignal, reason?: Degraded): SlotState {
    const to = TRANSITIONS[`${slot.state} --${event}`]
    if (to === undefined) {
      throw new Error(`invalid transition ${slot.state} --${event}-->`)
    }
    const emitted: SlotEvent = { slot: slot.id, from: slot.state, to, at: new Date().toISOString() }
    if (to === 'degraded') emitted.reason = reason ?? DEFAULT_DEGRADED_REASON
    this.onEvent(emitted)
    return to
  }
}

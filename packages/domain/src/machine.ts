export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E }

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value })
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error })

export interface TransitionError {
  code: 'invalid_transition'
  machine: string
  from: string
  event: string
  message: string
}

export type TransitionTable<S extends string, E extends string> = Record<S, Partial<Record<E, S>>>

export interface Machine<S extends string, E extends string> {
  readonly name: string
  readonly states: readonly S[]
  readonly events: readonly E[]
  readonly terminal: readonly S[]
  transition(from: S, event: E): Result<S, TransitionError>
  allowedEvents(from: S): E[]
}

/**
 * A finite state machine defined by an explicit table. Anything not in the table is rejected,
 * so adding a state never silently permits a transition.
 */
export function defineMachine<S extends string, E extends string>(def: {
  name: string
  states: readonly S[]
  events: readonly E[]
  terminal: readonly S[]
  table: TransitionTable<S, E>
}): Machine<S, E> {
  return {
    name: def.name,
    states: def.states,
    events: def.events,
    terminal: def.terminal,
    transition(from, event) {
      const to = def.table[from]?.[event]
      if (to === undefined) {
        return err({
          code: 'invalid_transition',
          machine: def.name,
          from,
          event,
          message: `${def.name}: cannot apply '${event}' in state '${from}'`,
        })
      }
      return ok(to)
    },
    allowedEvents(from) {
      return Object.keys(def.table[from] ?? {}) as E[]
    },
  }
}

import type { RunnerEventEnvelope } from '@mec/contracts'
import type { Tx } from '../../db/sql'
import { enqueueCommand } from '../../outbox/commands'
import type { AttemptRow } from '../attempts/service'

export type ControlCallHandler = (
  tx: Tx,
  attempt: AttemptRow,
  params: Record<string, unknown>,
) => Promise<unknown>

/** Scoped tools an agent may call on control (the coordinator's propose_tasks arrives in M8). */
const handlers = new Map<string, ControlCallHandler>()

export function registerControlCall(method: string, handler: ControlCallHandler): void {
  handlers.set(method, handler)
}

/** Answers a `control.call` from the current generation through the decision channel. */
export async function handleControlCall(
  tx: Tx,
  attempt: AttemptRow,
  env: RunnerEventEnvelope,
): Promise<void> {
  const method = String(env.payload.method ?? '')
  const ref = String(env.payload.nativeRequestRef ?? '')
  const handler = handlers.get(method)
  let result: unknown
  try {
    result = handler
      ? await tx.savepoint((sp) =>
          handler(sp, attempt, (env.payload.params as Record<string, unknown>) ?? {}),
        )
      : { error: `unknown method ${method}` }
  } catch (e) {
    result = { error: (e as Error).message }
  }
  if (!attempt.runnerId) return
  await enqueueCommand(tx, attempt.runnerId, {
    commandId: `${attempt.id}:g${env.generation}:call:${ref}`,
    type: 'resolve_decision',
    attemptId: attempt.id,
    generation: env.generation,
    payload: { nativeRequestRef: ref, decision: { kind: 'closed', reason: 'control call', result } },
  })
}

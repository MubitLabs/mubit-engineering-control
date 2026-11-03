/**
 * The compare-and-set confirmation core, plan §13 — pure, like the domain state machines.
 * A record binds the operation hash, the input SHA (when repo-related), the mandate and an
 * expiry; resolution applies the rules in a fixed order so no answer can be replayed:
 * already-handled throws, expiry beats the answer (expiry is never consent), a changed
 * operation or input makes the earlier decision stale, and only then does the user's word
 * settle it. The first answer wins; there is no transition out of a settled record.
 */

import { ConfirmationId } from '@mec/contracts'
import { ALWAYS_CONFIRM, type ConfirmationClass, type PolicyDoc } from './policy'

export type ConfirmationRecord = {
  id: string
  cls: ConfirmationClass
  /** What the user saw and answered; a different operation is a different question. */
  operationHash: string
  /** The repo input the answer was bound to; changed input staleness applies only when set. */
  inputSha?: string
  mandateId?: string
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'stale'
  createdAt: string
  expiresAt: string
  resolvedAt?: string
  resolvedBy?: 'user' | 'policy'
  answer?: 'approve' | 'deny'
}

const codedError = (code: 'already_handled', detail: string): Error => new Error(`${code}: ${detail}`)

/**
 * Open a pending record. `createdAt` is the one wall-clock read in this package — the
 * record's creation moment; every later decision compares the caller-supplied `now`, so
 * resolution itself stays deterministic and testable.
 */
export function openConfirmation(
  input: Omit<ConfirmationRecord, 'status' | 'createdAt' | 'id'> & { id: string },
): ConfirmationRecord {
  if (!ConfirmationId.safeParse(input.id).success)
    throw new Error(`openConfirmation: id must be a conf_-prefixed id (got '${input.id}')`)
  if (input.operationHash === '')
    throw new Error(`openConfirmation: confirmation ${input.id} needs an operationHash`)
  if (input.expiresAt === '') throw new Error(`openConfirmation: confirmation ${input.id} needs an expiresAt`)
  return { ...input, status: 'pending', createdAt: new Date().toISOString() }
}

const settle = (
  record: ConfirmationRecord,
  status: ConfirmationRecord['status'],
  at: string,
  by: 'user' | 'policy',
  answer?: 'approve' | 'deny',
): ConfirmationRecord => ({ ...record, status, resolvedAt: at, resolvedBy: by, answer })

/**
 * Resolve a pending confirmation, rules in order (§13):
 *
 * 1. not pending → `already_handled` (the first answer won; there is no second).
 * 2. `now` past `expiresAt` → `expired` — an approve arriving after expiry still expires;
 *    expiry is a policy resolution and never consent, so the attempted answer is discarded.
 * 3. a different `operationHash` → `stale` (the question changed).
 * 4. a different `inputSha` (only when the record carries one) → `stale`.
 * 5. otherwise the user's answer settles it, `resolvedBy: 'user'`.
 *
 * Times are `IsoTime` strings (CONTRACTS common.ts), which compare correctly as text.
 */
export function resolveConfirmation(
  pending: ConfirmationRecord,
  input: {
    now: string
    answer: 'approve' | 'deny'
    expectedOperationHash: string
    expectedInputSha?: string
  },
): { outcome: ConfirmationRecord } {
  if (pending.status !== 'pending')
    throw codedError('already_handled', `confirmation ${pending.id} is ${pending.status}`)

  if (input.now > pending.expiresAt) return { outcome: settle(pending, 'expired', input.now, 'policy') }

  if (input.expectedOperationHash !== pending.operationHash)
    return { outcome: settle(pending, 'stale', input.now, 'policy') }

  if (pending.inputSha !== undefined && input.expectedInputSha !== pending.inputSha)
    return { outcome: settle(pending, 'stale', input.now, 'policy') }

  return {
    outcome: settle(
      pending,
      input.answer === 'approve' ? 'approved' : 'denied',
      input.now,
      'user',
      input.answer,
    ),
  }
}

/**
 * May policy answer this class without asking (§13 pre-authorised classes)? Never for an
 * always-confirm class — policy cannot pre-authorise those at all, whatever the document
 * claims (`loadPolicy` refuses to build such a document; this check stands on its own).
 * Otherwise an entry matches when its scope fits the context (`repo` entries must name the
 * very repo; a `work_item` entry that names a repo fits only that repo) and its `maxUsd`,
 * when set, bounds the spend — an unknown spend cannot be bounded, so it does not match.
 * Per-use recording of the pre-authorisation is the caller's duty (§13).
 */
export function policyPreAuthorises(
  policy: PolicyDoc,
  cls: ConfirmationClass,
  ctx: { repoId?: string; usd?: number },
): boolean {
  if (ALWAYS_CONFIRM.includes(cls)) return false
  const entries = policy.preAuthorised[cls]
  if (entries === undefined) return false
  return entries.some((entry) => {
    if (entry.scope === 'repo' && entry.repoId === undefined) return false
    if (entry.repoId !== undefined && entry.repoId !== ctx.repoId) return false
    if (entry.maxUsd !== undefined && (ctx.usd === undefined || ctx.usd > entry.maxUsd)) return false
    return true
  })
}

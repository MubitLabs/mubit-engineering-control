import { describe, expect, it } from 'vitest'
import type { ConfirmationRecord } from '../src'
import {
  loadPolicy,
  openConfirmation,
  type PolicyDoc,
  policyPreAuthorises,
  resolveConfirmation,
} from '../src'

const EXPIRES = '2026-11-03T12:00:00.000Z'
const BEFORE = '2026-11-03T11:59:00.000Z'
const AFTER = '2026-11-03T12:00:00.001Z'

const open = (overrides: Partial<ConfirmationRecord> = {}): ConfirmationRecord =>
  openConfirmation({
    id: 'conf_1',
    cls: 'pr_merge',
    operationHash: 'op-abc',
    inputSha: 'sha-111',
    mandateId: 'wi_1',
    expiresAt: EXPIRES,
    ...overrides,
  })

describe('openConfirmation', () => {
  it('opens a pending record stamped with creation time', () => {
    const record = open()
    expect(record.status).toBe('pending')
    expect(record.createdAt).not.toBe('')
    expect(Number.isNaN(Date.parse(record.createdAt))).toBe(false)
    expect(record).toMatchObject({
      id: 'conf_1',
      cls: 'pr_merge',
      operationHash: 'op-abc',
      inputSha: 'sha-111',
      mandateId: 'wi_1',
      expiresAt: EXPIRES,
    })
  })

  it('requires a contracts-shaped confirmation id and a bound operation', () => {
    expect(() => open({ id: '1' })).toThrowError(/conf_-prefixed/)
    expect(() => open({ id: 'conf_' })).toThrowError(/conf_-prefixed/)
    expect(() => open({ operationHash: '' })).toThrowError(/operationHash/)
  })
})

describe('resolveConfirmation', () => {
  it('approves a live confirmation: the user answers before expiry', () => {
    const { outcome } = resolveConfirmation(open(), {
      now: BEFORE,
      answer: 'approve',
      expectedOperationHash: 'op-abc',
      expectedInputSha: 'sha-111',
    })
    expect(outcome).toMatchObject({
      status: 'approved',
      resolvedAt: BEFORE,
      resolvedBy: 'user',
      answer: 'approve',
    })
  })

  it('approves at the exact expiry instant (expiry is strictly after)', () => {
    const { outcome } = resolveConfirmation(open(), {
      now: EXPIRES,
      answer: 'approve',
      expectedOperationHash: 'op-abc',
      expectedInputSha: 'sha-111',
    })
    expect(outcome.status).toBe('approved')
  })

  it('denies a live confirmation, still the user’s word', () => {
    const { outcome } = resolveConfirmation(open(), {
      now: BEFORE,
      answer: 'deny',
      expectedOperationHash: 'op-abc',
      expectedInputSha: 'sha-111',
    })
    expect(outcome).toMatchObject({ status: 'denied', resolvedBy: 'user', answer: 'deny' })
  })

  it('throws already_handled when anything is resolved twice (first answer wins)', () => {
    const { outcome } = resolveConfirmation(open(), {
      now: BEFORE,
      answer: 'approve',
      expectedOperationHash: 'op-abc',
      expectedInputSha: 'sha-111',
    })
    expect(() =>
      resolveConfirmation(outcome, {
        now: BEFORE,
        answer: 'deny',
        expectedOperationHash: 'op-abc',
        expectedInputSha: 'sha-111',
      }),
    ).toThrowError(/^already_handled: confirmation conf_1 is approved/)
  })

  it('expires an approve that arrives late — expiry is never consent (§13)', () => {
    const { outcome } = resolveConfirmation(open(), {
      now: AFTER,
      answer: 'approve',
      expectedOperationHash: 'op-abc',
      expectedInputSha: 'sha-111',
    })
    expect(outcome).toMatchObject({ status: 'expired', resolvedAt: AFTER, resolvedBy: 'policy' })
    expect(outcome.answer).toBeUndefined()
  })

  it('expires a late deny the same way, and the record stays terminal', () => {
    const { outcome } = resolveConfirmation(open(), {
      now: AFTER,
      answer: 'deny',
      expectedOperationHash: 'op-abc',
      expectedInputSha: 'sha-111',
    })
    expect(outcome.status).toBe('expired')
    expect(() =>
      resolveConfirmation(outcome, { now: AFTER, answer: 'approve', expectedOperationHash: 'op-abc' }),
    ).toThrowError(/already_handled/)
  })

  it('goes stale on an operation hash mismatch — the question changed', () => {
    const { outcome } = resolveConfirmation(open(), {
      now: BEFORE,
      answer: 'approve',
      expectedOperationHash: 'op-other',
      expectedInputSha: 'sha-111',
    })
    expect(outcome).toMatchObject({ status: 'stale', resolvedBy: 'policy' })
  })

  it('goes stale on an inputSha mismatch when the record carries one', () => {
    const { outcome } = resolveConfirmation(open(), {
      now: BEFORE,
      answer: 'approve',
      expectedOperationHash: 'op-abc',
      expectedInputSha: 'sha-222',
    })
    expect(outcome).toMatchObject({ status: 'stale', resolvedBy: 'policy' })
  })

  it('ignores expectedInputSha when the record never bound an input', () => {
    const { outcome } = resolveConfirmation(open({ inputSha: undefined }), {
      now: BEFORE,
      answer: 'approve',
      expectedOperationHash: 'op-abc',
      expectedInputSha: 'sha-whatever',
    })
    expect(outcome.status).toBe('approved')
  })
})

describe('policyPreAuthorises', () => {
  const policy: PolicyDoc = loadPolicy(
    JSON.stringify({
      preAuthorised: {
        install: [{ scope: 'repo', repoId: 'r1' }],
        spend: [{ scope: 'repo', repoId: 'r1', maxUsd: 5 }],
        migration: [{ scope: 'work_item', repoId: 'r2' }],
        slot_switch: [{ scope: 'work_item' }],
      },
    }),
  )

  it('never pre-authorises an always-confirm class, whatever the document claims', () => {
    for (const cls of ['push', 'pr_create', 'pr_edit', 'pr_merge', 'branch_delete', 'force_op'] as const)
      expect(policyPreAuthorises(policy, cls, {}), cls).toBe(false)
    const claiming: PolicyDoc = {
      versionHash: '0'.repeat(64),
      preAuthorised: { push: [{ scope: 'repo', repoId: 'r1' }] },
    }
    expect(policyPreAuthorises(claiming, 'push', { repoId: 'r1' })).toBe(false)
  })

  it('matches a repo-scoped entry only for that repo', () => {
    expect(policyPreAuthorises(policy, 'install', { repoId: 'r1' })).toBe(true)
    expect(policyPreAuthorises(policy, 'install', { repoId: 'r2' })).toBe(false)
    expect(policyPreAuthorises(policy, 'install', {})).toBe(false)
  })

  it('bounds the spend by maxUsd and refuses an unknown spend', () => {
    expect(policyPreAuthorises(policy, 'spend', { repoId: 'r1', usd: 5 })).toBe(true)
    expect(policyPreAuthorises(policy, 'spend', { repoId: 'r1', usd: 5.01 })).toBe(false)
    expect(policyPreAuthorises(policy, 'spend', { repoId: 'r1' })).toBe(false)
  })

  it('treats a work_item entry as per-use recorded, narrowed by repoId when set', () => {
    expect(policyPreAuthorises(policy, 'slot_switch', {})).toBe(true) // unbounded work_item entry
    expect(policyPreAuthorises(policy, 'migration', {})).toBe(false) // names r2, so only r2
    expect(policyPreAuthorises(policy, 'migration', { repoId: 'r2' })).toBe(true)
  })

  it('answers false for a class the policy never mentions', () => {
    expect(policyPreAuthorises(policy, 'unsandboxed', {})).toBe(false)
  })
})

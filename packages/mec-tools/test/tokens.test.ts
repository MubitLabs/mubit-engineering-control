import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { issueToken, verifyToken } from '../src/tokens'

const SECRET = 'bridge-secret'

describe('issueToken / verifyToken', () => {
  it('round-trips the attempt id, generation and role for both roles', () => {
    for (const role of ['meta_agent', 'specialist'] as const) {
      const token = issueToken({ attemptId: 'att_42', generation: 3, role, secret: SECRET })
      expect(verifyToken(token, SECRET)).toEqual({ attemptId: 'att_42', generation: 3, role })
    }
  })

  it('returns null for a tampered payload or a tampered signature', () => {
    const token = issueToken({ attemptId: 'att_1', generation: 0, role: 'specialist', secret: SECRET })
    const parts = token.split('.')
    expect(parts).toHaveLength(2)
    const payload = parts[0]!
    const signature = parts[1]!

    const flippedPayload = `${payload.startsWith('e') ? 'f' : 'e'}${payload.slice(1)}`
    expect(verifyToken(`${flippedPayload}.${signature}`, SECRET)).toBeNull()

    const flippedSignature = `${signature.startsWith('A') ? 'B' : 'A'}${signature.slice(1)}`
    expect(verifyToken(`${payload}.${flippedSignature}`, SECRET)).toBeNull()
  })

  it('returns null for a token signed with a different secret', () => {
    const token = issueToken({
      attemptId: 'att_1',
      generation: 0,
      role: 'meta_agent',
      secret: 'another-secret',
    })
    expect(verifyToken(token, SECRET)).toBeNull()
  })

  it('returns null for malformed tokens and wrong-shaped claims', () => {
    expect(verifyToken('', SECRET)).toBeNull()
    expect(verifyToken('nonsense', SECRET)).toBeNull()
    expect(verifyToken('a.b.c', SECRET)).toBeNull()
    expect(verifyToken('only-payload', SECRET)).toBeNull()

    // Correctly signed, but the claims do not have the right shape.
    const sign = (payload: string) =>
      Buffer.from(createHmac('sha256', SECRET).update(payload).digest()).toString('base64url')
    const badRole = Buffer.from(
      JSON.stringify({ attemptId: 'att_1', generation: 0, role: 'admin' }),
    ).toString('base64url')
    expect(verifyToken(`${badRole}.${sign(badRole)}`, SECRET)).toBeNull()

    expect(
      verifyToken(
        issueToken({ attemptId: 'att_1', generation: -1, role: 'specialist', secret: SECRET }),
        SECRET,
      ),
    ).toBeNull()
    expect(
      verifyToken(issueToken({ attemptId: '', generation: 0, role: 'specialist', secret: SECRET }), SECRET),
    ).toBeNull()
  })
})

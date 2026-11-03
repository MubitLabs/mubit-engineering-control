/**
 * Attempt-scoped bearer tokens — plan §6 "Transport: mec-tools".
 *
 * One HMAC-SHA256 format and no JWT library: `base64url(json payload) + '.' +
 * base64url(hmac-sha256(payload, secret))`. The payload carries exactly the
 * attempt, its generation and the role; the mec-tools server resolves the
 * token to that triple and exposes only the role's tools. Generation fencing
 * (plan §8.6) extends to tool calls: a token from an older generation of an
 * attempt is stale and sees an empty tool set. `attemptId` is opaque here —
 * contract-shaped ids (`att_…`) are the issuing host's business.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

export type AgentRole = 'meta_agent' | 'specialist'

/** The claims a token carries: what the server learns from a valid bearer. */
export interface TokenClaims {
  attemptId: string
  generation: number
  role: AgentRole
}

/** What `verifyToken` returns for a valid token. */
export type VerifiedToken = TokenClaims

export interface IssueTokenInput extends TokenClaims {
  secret: string
}

const b64url = (value: string | Buffer): string => Buffer.from(value).toString('base64url')

export function issueToken(input: IssueTokenInput): string {
  const payload = b64url(
    JSON.stringify({ attemptId: input.attemptId, generation: input.generation, role: input.role }),
  )
  const signature = b64url(createHmac('sha256', input.secret).update(payload).digest())
  return `${payload}.${signature}`
}

/**
 * Returns the token's claims, or null for anything that does not verify: a
 * malformed token, a signature made with another secret, a tampered payload,
 * or a payload whose claims do not have the right shape.
 */
export function verifyToken(token: string, secret: string): VerifiedToken | null {
  const dot = token.indexOf('.')
  if (dot === -1) return null
  const payload = token.slice(0, dot)
  const signature = token.slice(dot + 1)
  if (payload === '' || signature === '') return null

  const expected = createHmac('sha256', secret).update(payload).digest()
  const given = Buffer.from(signature, 'base64url')
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null

  let claims: unknown
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (typeof claims !== 'object' || claims === null) return null
  const { attemptId, generation, role } = claims as Record<string, unknown>
  if (typeof attemptId !== 'string' || attemptId === '') return null
  if (typeof generation !== 'number' || !Number.isInteger(generation) || generation < 0) return null
  if (role !== 'meta_agent' && role !== 'specialist') return null
  return { attemptId, generation, role }
}

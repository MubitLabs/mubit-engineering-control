import { z } from 'zod'
import { EngineId, IsoTime } from './common'
import { TerminalReason, Window } from './events'
import { ReportKind } from './report'

/** The `meta.json` beside every recording (CONTRACTS §9); a recording always ships redacted. */
export const FixtureMeta = z.strictObject({
  engine: EngineId,
  engine_version: z.string().min(1),
  scenario: z.string().min(1),
  recorded_at: IsoTime,
  recorded_by: z.enum(['real', 'fake']),
  /** A recording that still matches a §1 pattern fails `mec-devtools record`, so this is always true. */
  redacted: z.literal(true),
  /** What the conformance suite expects the replay to produce. */
  expected: z.strictObject({
    reports: z.array(ReportKind),
    permission_requests: z.int().min(0),
    rate_limits: z.array(Window),
    exit: TerminalReason,
  }),
  /** Free text on what the recording shows. */
  notes: z.string().optional(),
})

/** Scenarios every engine must record before its handshake (CONTRACTS §9). */
export const FIXTURE_SCENARIOS = [
  'smoke',
  'permission_request',
  'rate_limit_warning',
  'rate_limit_rejected',
  'auth_expired',
  'provider_down',
  'max_turns',
  'report_ready_with_question',
  'report_blocked',
  'report_dropped',
  'crash_mid_turn',
] as const

/** The fixture path shape `<engine>/<version>/<scenario>`, relative to `packages/testkit/fixtures`. */
export function fixtureDir(engine: EngineId, version: string, scenario: string): string {
  return `${engine}/${version}/${scenario}`
}

export type FixtureMeta = z.infer<typeof FixtureMeta>
export type FixtureScenario = (typeof FIXTURE_SCENARIOS)[number]

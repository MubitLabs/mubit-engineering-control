import { describe, expect, it } from 'vitest'
import { DEFAULT_RULES, eligibility, planRetention } from '../src/retention'

const now = new Date('2026-11-03T12:00:00.000Z')

function daysAgo(days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
}

describe('DEFAULT_RULES', () => {
  it('keeps the plan §20 retention: 30 days logs, 90 days evidence, decisions kept', () => {
    expect(DEFAULT_RULES).toEqual([
      { kind: 'operational_log', days: 30 },
      { kind: 'delivery_evidence', days: 90 },
      { kind: 'decision', days: Number.POSITIVE_INFINITY },
    ])
  })
})

describe('eligibility', () => {
  it('a 31-day-old operational log is eligible', () => {
    const verdict = eligibility({
      now,
      file: { path: 'journal/operational/2026-10-03.log', mtime: daysAgo(31), kind: 'operational_log' },
    })
    expect(verdict).toEqual({ delete: true })
  })

  it('a 31-day-old decision is kept — decisions have no expiry', () => {
    const verdict = eligibility({
      now,
      file: { path: 'decisions/merge-record.json', mtime: daysAgo(31), kind: 'decision' },
    })
    expect(verdict.delete).toBe(false)
    expect(verdict.reason).toContain('no expiry')
  })

  it('a 91-day-old delivery evidence file is eligible', () => {
    const verdict = eligibility({
      now,
      file: { path: 'evidence/attempt-7.diff', mtime: daysAgo(91), kind: 'delivery_evidence' },
    })
    expect(verdict).toEqual({ delete: true })
  })

  it('a file exactly at its window boundary is still kept', () => {
    const verdict = eligibility({
      now,
      file: { path: 'evidence/attempt-8.diff', mtime: daysAgo(90), kind: 'delivery_evidence' },
    })
    expect(verdict.delete).toBe(false)
  })

  it('anything under engines/ is always kept and the reason names it', () => {
    const verdict = eligibility({
      now,
      file: {
        path: 'engines/claude/s1/keys/anthropic.key',
        mtime: daysAgo(400),
        kind: 'operational_log',
      },
    })
    expect(verdict.delete).toBe(false)
    expect(verdict.reason).toContain('engines')
  })

  it('the db and the manifest are never eligible', () => {
    for (const path of ['db.sqlite', 'db.sqlite-wal', 'manifest.json']) {
      const verdict = eligibility({ now, file: { path, mtime: daysAgo(400), kind: 'operational_log' } })
      expect(verdict.delete, path).toBe(false)
    }
  })
})

describe('planRetention', () => {
  it('partitions files into deletions and keeps with reasons', () => {
    const files = [
      { path: 'journal/operational/old.log', mtime: daysAgo(31) },
      { path: 'journal/operational/new.log', mtime: daysAgo(3) },
      { path: 'evidence/old.diff', mtime: daysAgo(91) },
      { path: 'decisions/merge-record.json', mtime: daysAgo(400) },
      { path: 'engines/claude/s1/settings.json', mtime: daysAgo(400) },
      { path: 'db.sqlite', mtime: daysAgo(400) },
    ]
    const plan = planRetention({
      now,
      files,
      classify: (path) => {
        if (path.startsWith('journal/')) return 'operational_log'
        if (path.startsWith('evidence/')) return 'delivery_evidence'
        return 'decision'
      },
    })

    expect(plan.toDelete).toEqual(['journal/operational/old.log', 'evidence/old.diff'])
    expect(plan.kept.map((entry) => entry.path)).toEqual([
      'journal/operational/new.log',
      'decisions/merge-record.json',
      'engines/claude/s1/settings.json',
      'db.sqlite',
    ])
    for (const entry of plan.kept) {
      expect(typeof entry.reason).toBe('string')
      expect(entry.reason.length).toBeGreaterThan(0)
    }
    expect(plan.kept.find((entry) => entry.path.startsWith('engines/'))?.reason).toContain('engines')
  })

  it('is pure — the same inputs yield the same plan twice', () => {
    const input = {
      now,
      files: [{ path: 'journal/operational/old.log', mtime: daysAgo(31) }],
      classify: () => 'operational_log' as const,
    }
    expect(planRetention(input)).toEqual(planRetention(input))
  })
})

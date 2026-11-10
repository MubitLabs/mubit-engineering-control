/**
 * UI evidence, spec §14 and §15: a repository registers whether it is required. Where it is, a
 * change to what users see is `ready` only with before and after captures of the same scenario
 * from the real application, labelled with their revisions. After-only, mocked, or a capture of
 * another commit keeps the handoff explicitly incomplete. Pure: the captures are MEC's own records
 * (`ui-evidence/<attempt>`), taken by MEC's Chromium, never by an engine.
 *
 * **Which changes users see.** A change is user-visible when any file its commits changed matches
 * one of the repository's globs, or the defaults below when it registers none: markup, styles,
 * scripts, components and assets. A glob is matched against the whole repo-relative path: `*`
 * stays inside one path segment, `**` crosses them, `?` is one character.
 */

/** Markup, styles, scripts, components and assets: what a browser shows or runs. */
export const UI_PATTERNS: readonly string[] = [
  '**/*.html',
  '**/*.htm',
  '**/*.css',
  '**/*.scss',
  '**/*.sass',
  '**/*.less',
  '**/*.js',
  '**/*.mjs',
  '**/*.jsx',
  '**/*.tsx',
  '**/*.vue',
  '**/*.svelte',
  '**/*.svg',
  '**/*.png',
  '**/*.jpg',
  '**/*.jpeg',
  '**/*.gif',
  '**/*.webp',
  '**/*.ico',
  '**/*.woff',
  '**/*.woff2',
  '**/assets/**',
  '**/public/**',
  '**/static/**',
]

/** The scenario when none is registered: the application's front page. */
export const DEFAULT_PATHS: readonly string[] = ['/']
/** Each path is one capture per side, so the list is short. */
export const MAX_PATHS = 5
/** One viewport for both sides, recorded with every capture. */
export const UI_VIEWPORT = { width: 1280, height: 800 } as const

/** Pending reasons. The stage and the retry read the captures, not these words. */
export const UI_EVIDENCE_WAITING = 'ui_evidence_waiting'
export const UI_EVIDENCE_FAILED = 'ui_evidence_failed'

/** How to start the real application. Absent, MEC serves the revision's files itself. */
export type UiStart = { argv: string[]; url?: string; port?: number }

export type UiEvidenceSetting = {
  required: boolean
  start?: UiStart
  paths: readonly string[]
  patterns: readonly string[]
}

export type UiShot = { path: string; file: string; bytes: number; at: string; status: number | null }
export type UiSide =
  | { sha: string; status: 'captured'; shots: readonly UiShot[] }
  | { sha: string; status: 'could_not'; reason: string }

export type UiEvidenceInput = {
  userVisible: boolean
  /** The commit the change started from; the before capture must be of it. */
  base?: string
  captures: { before?: UiSide; after?: UiSide }
}

export type UiEvidenceVerdict =
  | { status: 'not_needed' }
  | { status: 'complete' }
  | { status: 'waiting' }
  | { status: 'could_not'; side: 'before' | 'after'; reason: string }

const escapeRegex = (text: string): string => text.replace(/[.+^${}()|[\]\\]/g, '\\$&')

function globRegex(glob: string): RegExp {
  let out = ''
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index] as string
    if (char === '*' && glob[index + 1] === '*') {
      const slash = glob[index + 2] === '/'
      out += slash ? '(?:.*/)?' : '.*'
      index += slash ? 2 : 1
    } else if (char === '*') out += '[^/]*'
    else if (char === '?') out += '[^/]'
    else out += escapeRegex(char)
  }
  return new RegExp(`^${out}$`)
}

/** Whether any changed file is one users see, by the repository's globs. */
export function userVisible(changed: readonly string[], patterns: readonly string[]): boolean {
  const tests = patterns.map(globRegex)
  return changed.some((file) => {
    const path = file.replace(/^\.\//, '')
    return tests.some((test) => test.test(path))
  })
}

const KEYS = new Set(['required', 'start', 'paths', 'patterns'])
const START_KEYS = new Set(['argv', 'url', 'port'])
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])

const strings = (value: unknown, what: string): string[] => {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry === '')) {
    throw new Error(`${what} must be a list of non-empty strings`)
  }
  return value as string[]
}

function parseStart(raw: unknown): UiStart {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('uiEvidence.start must be {argv, url?, port?}')
  }
  const record = raw as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!START_KEYS.has(key)) throw new Error(`uiEvidence.start.${key} is not a field`)
  }
  const argv = strings(record.argv, 'uiEvidence.start.argv')
  if (argv.length === 0) throw new Error('uiEvidence.start.argv needs the command to run')
  // Run as argv and never through a shell, as setup and checks are, so a shell's words are refused.
  const shell = argv.find((part) => /[;&|<>`$]/.test(part))
  if (shell !== undefined) throw new Error(`uiEvidence.start.argv carries shell metacharacters: ${shell}`)
  const start: UiStart = { argv }
  if (record.port !== undefined) {
    const { port } = record
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('uiEvidence.start.port must be a port number')
    }
    start.port = port
  }
  if (record.url !== undefined) {
    let url: URL
    try {
      url = new URL(String(record.url))
    } catch {
      throw new Error('uiEvidence.start.url must be a URL')
    }
    if (url.protocol !== 'http:' || !LOOPBACK.has(url.hostname)) {
      throw new Error('uiEvidence.start.url must be an http URL on loopback (127.0.0.1, localhost or [::1])')
    }
    start.url = url.toString()
  }
  return start
}

/** The setting as an edit may write it. Throws with what is wrong; never fills a gap with a guess. */
export function parseUiEvidence(raw: unknown): UiEvidenceSetting {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('uiEvidence must be {required, start?, paths?, patterns?}')
  }
  const record = raw as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!KEYS.has(key)) throw new Error(`uiEvidence.${key} is not a field`)
  }
  if (typeof record.required !== 'boolean') throw new Error('uiEvidence.required must be true or false')
  const paths = record.paths === undefined ? [...DEFAULT_PATHS] : strings(record.paths, 'uiEvidence.paths')
  if (paths.length === 0 || paths.length > MAX_PATHS) {
    throw new Error(`uiEvidence.paths takes 1 to at most ${MAX_PATHS} paths`)
  }
  for (const path of paths) {
    // `//host/` is another origin to a browser, so a scenario path stays on the app's own.
    if (!path.startsWith('/') || path.startsWith('//')) {
      throw new Error(`uiEvidence.paths entries must start with / (got ${path})`)
    }
  }
  const patterns =
    record.patterns === undefined ? [...UI_PATTERNS] : strings(record.patterns, 'uiEvidence.patterns')
  return {
    required: record.required,
    ...(record.start !== undefined && { start: parseStart(record.start) }),
    paths,
    patterns,
  }
}

/** The setting a stored repository record carries. Anything unreadable there is off. */
export function uiEvidenceSetting(raw: unknown): UiEvidenceSetting {
  try {
    return parseUiEvidence(raw)
  } catch {
    return { required: false, paths: [...DEFAULT_PATHS], patterns: [...UI_PATTERNS] }
  }
}

function sideVerdict(side: UiSide | undefined, sha: string): 'captured' | 'missing' | { reason: string } {
  if (side === undefined || side.sha !== sha) return 'missing'
  if (side.status === 'could_not') return { reason: side.reason }
  return side.shots.length > 0 ? 'captured' : 'missing'
}

/** What the captures say for `head`: complete only with both sides, each on its own commit. */
export function uiEvidenceVerdict(input: UiEvidenceInput, head: string): UiEvidenceVerdict {
  if (!input.userVisible) return { status: 'not_needed' }
  if (input.base === undefined) {
    return {
      status: 'could_not',
      side: 'before',
      reason: 'MEC has no record of the commit this change started from',
    }
  }
  const before = sideVerdict(input.captures.before, input.base)
  const after = sideVerdict(input.captures.after, head)
  if (typeof before === 'object') return { status: 'could_not', side: 'before', reason: before.reason }
  if (typeof after === 'object') return { status: 'could_not', side: 'after', reason: after.reason }
  return before === 'captured' && after === 'captured' ? { status: 'complete' } : { status: 'waiting' }
}

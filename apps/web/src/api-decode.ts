/**
 * Decoders from the shapes the workbench server really serves to the view types the UI renders.
 * Pure and dependency-free (the web package does not import @mec/*): the contract test in
 * test/web-contract.test.ts feeds them the REAL server's responses, so a drift on either side fails
 * there. A payload that does not fit throws DecodeError — the caller shows a finite error state; a
 * guess would put invented data on screen.
 */

import type { ModelTiers, PromptPart, Question } from './api'

/** The server answered, but not in a shape the client understands. */
export class DecodeError extends Error {
  readonly path: string

  constructor(path: string, problem: string) {
    super(`${path} returned an unexpected shape: ${problem}`)
    this.name = 'DecodeError'
    this.path = path
  }
}

type Obj = Record<string, unknown>

function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(path: string, owner: string, value: unknown, field: string): string {
  if (typeof value !== 'string') throw new DecodeError(path, `${owner}.${field} is not a string`)
  return value
}

function arr(path: string, value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new DecodeError(path, `${what} is not an array`)
  return value
}

/** GET /api/prompts → `{ revision, parts: [{id, layer, name, edited, defaultUpdated, provenance}], overrides: [{path, text}] }`. */
export function decodePrompts(raw: unknown): PromptPart[] {
  const path = '/api/prompts'
  if (!isObj(raw)) throw new DecodeError(path, 'the body is not an object')
  const parts = arr(path, raw.parts, 'parts')
  const overrideText = new Map<string, string>()
  if (Array.isArray(raw.overrides)) {
    for (const override of raw.overrides) {
      if (isObj(override) && typeof override.path === 'string' && typeof override.text === 'string') {
        overrideText.set(override.path, override.text)
      }
    }
  }
  return parts.map((entry, index) => {
    if (!isObj(entry)) throw new DecodeError(path, `parts[${index}] is not an object`)
    const id = str(path, `parts[${index}]`, entry.id, 'id')
    const part: PromptPart = {
      id,
      layer: str(path, `parts[${index}]`, entry.layer, 'layer'),
      name: str(path, `parts[${index}]`, entry.name, 'name'),
      edited: entry.edited === true,
      defaultUpdated: entry.defaultUpdated === true,
    }
    if (typeof entry.provenance === 'string') part.provenance = entry.provenance
    const text = overrideText.get(id)
    if (text !== undefined) part.text = text
    return part
  })
}

const PROVIDER_LABELS: Record<string, string> = { 'zai-coding-plan': 'GLM', google: 'Gemini' }

type Column = { label: string; models: Obj }

/** GET /api/models → `{ table: {tiers, engines, routing}, provenance, availability }` → the tier ladder, one column per provider. */
export function decodeModels(raw: unknown): ModelTiers {
  const path = '/api/models'
  if (!isObj(raw) || !isObj(raw.table)) throw new DecodeError(path, 'table is missing')
  const table = raw.table
  const tiers = arr(path, table.tiers, 'table.tiers').map((tier, index) =>
    str(path, 'table.tiers', tier, String(index)),
  )
  if (!isObj(table.engines)) throw new DecodeError(path, 'table.engines is not an object')
  const engines = table.engines

  const columns: Column[] = []
  const modelsOf = (value: unknown, where: string): Obj => {
    if (!isObj(value)) throw new DecodeError(path, `${where} is not an object`)
    for (const [id, model] of Object.entries(value)) {
      if (!isObj(model) || typeof model.tier !== 'string') {
        throw new DecodeError(path, `${where}.${id} has no tier`)
      }
    }
    return value
  }
  for (const [key, label] of [
    ['claude', 'Claude Code'],
    ['codex', 'Codex'],
  ] as const) {
    const engine = engines[key]
    if (isObj(engine) && engine.models !== undefined) {
      columns.push({ label, models: modelsOf(engine.models, `table.engines.${key}.models`) })
    }
  }
  const opencode = engines.opencode
  if (isObj(opencode) && isObj(opencode.providers)) {
    for (const [provider, block] of Object.entries(opencode.providers)) {
      if (!isObj(block))
        throw new DecodeError(path, `table.engines.opencode.providers.${provider} is not an object`)
      columns.push({
        label: `OpenCode on ${PROVIDER_LABELS[provider] ?? provider}`,
        models: modelsOf(block.models, `table.engines.opencode.providers.${provider}.models`),
      })
    }
  }
  if (columns.length === 0) throw new DecodeError(path, 'the table lists no models')

  const rows = tiers.map((tier) => ({
    tier,
    cells: columns.map((column) => {
      const hits = Object.entries(column.models).filter(([, model]) => (model as Obj).tier === tier)
      if (hits.length === 0) return undefined
      const text = hits.map(([id]) => id).join(', ')
      const notes = hits
        .map(([, model]) => {
          const m = model as Obj
          const level =
            typeof m.effort === 'string' ? m.effort : typeof m.variant === 'string' ? m.variant : ''
          const bills = typeof m.bills === 'string' ? m.bills : ''
          return [level, bills].filter((part) => part !== '').join(', ')
        })
        .filter((note) => note !== '')
      return notes.length === 0 ? { text } : { text, note: notes.join('; ') }
    }),
  }))

  const notes: string[] = []
  const routing = table.routing
  if (isObj(routing) && isObj(routing.frontier) && routing.frontier.requires === 'preauthorised') {
    notes.push('Frontier needs your pre-authorisation per repository.')
  }
  const provenance = raw.provenance
  if (isObj(provenance) && typeof provenance.source === 'string') {
    notes.push(`Table source: ${provenance.source}.`)
  }
  return { providers: columns.map((column) => column.label), rows, note: notes.join(' ') }
}

/**
 * GET /api/questions → `[{id, question, options, status, workItemId?, evidence: {why, …}}]`. Only open
 * questions are cards; an answered one is history. The UI's eyebrow/what/why map from what the record
 * actually holds (the record has no per-asker role, so the eyebrow says where it was asked).
 */
export function decodeQuestions(raw: unknown): Question[] {
  const path = '/api/questions'
  const list = arr(path, raw, 'the body')
  const questions: Question[] = []
  list.forEach((entry, index) => {
    if (!isObj(entry)) throw new DecodeError(path, `[${index}] is not an object`)
    const owner = `[${index}]`
    const id = str(path, owner, entry.id, 'id')
    const what = str(path, owner, entry.question, 'question')
    const options = arr(path, entry.options, `${owner}.options`).map((option, i) =>
      str(path, `${owner}.options`, option, String(i)),
    )
    if (entry.status !== undefined && typeof entry.status !== 'string') {
      throw new DecodeError(path, `${owner}.status is not a string`)
    }
    if ((entry.status ?? 'open') !== 'open') return
    const why = isObj(entry.evidence) && typeof entry.evidence.why === 'string' ? entry.evidence.why : ''
    const eyebrow =
      typeof entry.workItemId === 'string'
        ? `Asked on work item ${entry.workItemId}`
        : 'Asked by the meta agent'
    questions.push({ id, eyebrow, what, why, options })
  })
  return questions
}

/** The /api/backups record, once a route serves one; an unrecognisable body is an error, not a blank. */
export function decodeBackups(raw: unknown): { lastAt?: string; note: string; excluded: string } {
  const path = '/api/backups'
  if (!isObj(raw)) throw new DecodeError(path, 'the body is not an object')
  return {
    ...(typeof raw.lastAt === 'string' && { lastAt: raw.lastAt }),
    note: str(path, 'backups', raw.note, 'note'),
    excluded: str(path, 'backups', raw.excluded, 'excluded'),
  }
}

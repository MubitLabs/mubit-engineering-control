/**
 * The prompt store — plan §16.2/§16.3 and review 2026-11-04 §6.1/§6.2: the user's editable copy
 * of the prompt parts, rooted at `<keystoreRoot>/prompts` (≈ `~/.mec/prompts`).
 *
 * Layout on disk:
 *   <root>/<part path>        the override text, at the SAME path as the shipped default
 *   <root>/.bases.json        { path → defaultBaseHash }: the index of live overrides, each naming
 *                             the shipped default it was written against (§16.2)
 *   <root>/revisions/<n>.json immutable snapshots: the FULL config, its predecessor, the origin
 *                             (user | agent | panel) and the time; written 'wx', numbers never
 *                             reused. Each snapshot also records the default TEXT each override
 *                             was based on, so `changes()` can diff against a default that has
 *                             since been replaced by an app update.
 *
 * Saves are compare-and-set on the revision: a save naming a base revision that is no longer
 * current is refused with `StaleBaseError` (a 409 at the API) and nothing is written — the draft
 * is never discarded. An override saved identical to its current default is REMOVED so the part
 * follows future defaults (§16.2). Only `.md` parts are managed here; `models.yaml` and its kin
 * belong to their own loaders and are never read, written or dropped by this store.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  type AssembleOptions,
  assemble,
  type DefaultPart,
  layerOfPart,
  listDefaultParts,
  readDefaultPart,
} from './loader'

/** Where a save came from: the panel (Settings), an agent through the same API, or the user direct. */
export type PromptOrigin = 'user' | 'agent' | 'panel'

/** One live override as the config exposes it. */
export type PromptOverride = {
  path: string
  text: string
  /** The hash of the shipped default this override was written against (§16.2). */
  defaultBaseHash: string
  layer: string
}

/** One part inside a revision snapshot — the default text is recorded for the §16.3 diff. */
export type RevisionPart = {
  path: string
  text: string
  defaultBaseHash: string
  defaultText: string
}

/** The immutable snapshot: full config, predecessor, origin, time. Numbers are never reused. */
export type RevisionSnapshot = {
  n: number
  base: number
  origin: PromptOrigin
  time: string
  parts: RevisionPart[]
}

/** A save whose base revision is no longer current — a 409 at the API, never a lost draft. */
export class StaleBaseError extends Error {
  constructor(readonly currentRevision: number) {
    super(`stale base: the config moved to revision ${currentRevision} since your draft`)
    this.name = 'StaleBaseError'
  }
}

/** A save naming a part that is not a shipped default — a 400 at the API. */
export class UnknownPartError extends Error {
  constructor(readonly path: string) {
    super(`unknown prompt part '${path}' — only shipped defaults can be overridden`)
    this.name = 'UnknownPartError'
  }
}

export type SaveInput = {
  /** The revision this save was drafted against; must equal the store's current revision. */
  baseRevision: number
  origin: PromptOrigin
  /** The parts to override. A text identical to the current default REMOVES the override. */
  parts: Array<{ path: string; text: string }>
  now?: () => Date
}

/** One Default-updated entry: what the user has, what it was based on, what shipped now. */
export type PromptChange = {
  path: string
  /** The default the override was written against, recovered from revision history. */
  oldDefault: { text: string; hash: string } | undefined
  /** The default that ships now. Undefined when the part was removed from the defaults. */
  newDefault: { text: string; hash: string } | undefined
  userText: string
  userBaseHash: string
  removed: boolean
}

const BASES_FILE = '.bases.json'
const REVISIONS_DIR = 'revisions'

/** Only `.md` paths are this store's to manage (models.yaml and kin belong to their loaders). */
function isPromptPartPath(path: string): boolean {
  return path.endsWith('.md')
}

function readJson<T>(file: string): T | undefined {
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return undefined
  }
}

export class PromptStore {
  readonly #root: string

  constructor(root: string) {
    this.#root = root
  }

  /** The store's root directory (tests assert layout; nothing else should need it). */
  get root(): string {
    return this.#root
  }

  // ── Reading ────────────────────────────────────────────────────────────────────────────────

  /** The highest revision number that exists — the store's current revision, 0 when none. */
  revision(): number {
    const dir = join(this.#root, REVISIONS_DIR)
    if (!existsSync(dir)) return 0
    let max = 0
    for (const entry of readdirSync(dir)) {
      const n = Number.parseInt(entry.replace(/\.json$/, ''), 10)
      if (Number.isInteger(n) && n > max) max = n
    }
    return max
  }

  /**
   * The live config: every `.md` override from `.bases.json` plus its text at the same path, and
   * the revision it currently sits at. A missing or unreadable index is an empty config — the
   * honest state, never a throw.
   */
  config(): { revision: number; parts: PromptOverride[] } {
    const revision = this.revision()
    const bases = readJson<Record<string, string>>(join(this.#root, BASES_FILE)) ?? {}
    const parts: PromptOverride[] = []
    for (const [path, defaultBaseHash] of Object.entries(bases)) {
      if (!isPromptPartPath(path)) continue
      const file = join(this.#root, ...path.split('/'))
      if (!existsSync(file)) continue
      parts.push({
        path,
        text: readFileSync(file, 'utf8'),
        defaultBaseHash,
        layer: layerOfPart(path) ?? '',
      })
    }
    parts.sort((a, b) => a.path.localeCompare(b.path))
    return { revision, parts }
  }

  /** One immutable snapshot, or undefined when that number never existed. */
  getRevision(n: number): RevisionSnapshot | undefined {
    return readJson<RevisionSnapshot>(join(this.#root, REVISIONS_DIR, `${n}.json`))
  }

  /**
   * Parts whose shipped default changed since the override was written (§16.3): the old default
   * recovered from revision history, the new default, and the user's text. Overrides whose part
   * no longer ships are listed with `removed` — they are dropped on the next save.
   */
  changes(): PromptChange[] {
    const { parts } = this.config()
    const changes: PromptChange[] = []
    for (const part of parts) {
      const current = readDefaultPart(part.path)
      if (current === undefined) {
        changes.push({
          path: part.path,
          oldDefault: this.#recoverDefault(part.path, part.defaultBaseHash),
          newDefault: undefined,
          userText: part.text,
          userBaseHash: part.defaultBaseHash,
          removed: true,
        })
        continue
      }
      if (current.hash === part.defaultBaseHash) continue
      changes.push({
        path: part.path,
        oldDefault: this.#recoverDefault(part.path, part.defaultBaseHash),
        newDefault: { text: current.text, hash: current.hash },
        userText: part.text,
        userBaseHash: part.defaultBaseHash,
        removed: false,
      })
    }
    return changes
  }

  /**
   * Assembles a role's full bundle with the live overrides applied (§16.1 order) — the same
   * assembly `preview` serves and attempts pin. Saving never happens here.
   */
  assemble(role: string, engine?: string, opts: AssembleOptions = {}) {
    const overrides: Record<string, { text: string; defaultBaseHash?: string }> = {}
    for (const part of this.config().parts) {
      overrides[part.path] = { text: part.text, defaultBaseHash: part.defaultBaseHash }
    }
    return assemble(role, engine, { ...opts, overrides })
  }

  // ── Saving ─────────────────────────────────────────────────────────────────────────────────

  /**
   * One save = one immutable revision. Refuses a stale base without writing anything (§16.2);
   * removes overrides saved identical to their current default so the part follows future
   * defaults; drops overrides for parts that no longer ship (§16.3); records the default text
   * each remaining override stands on for the Default-updated diff.
   */
  save(input: SaveInput): { revision: number } {
    const { baseRevision, origin, parts } = input
    const current = this.revision()
    if (baseRevision !== current) {
      throw new StaleBaseError(current)
    }
    const known = new Set(listDefaultParts().filter(isPromptPartPath))
    for (const part of parts) {
      if (!known.has(part.path)) throw new UnknownPartError(part.path)
    }

    const bases = readJson<Record<string, string>>(join(this.#root, BASES_FILE)) ?? {}
    const overrides = new Map<string, string>()
    const texts = new Map<string, string>()
    for (const [path, hash] of Object.entries(bases)) {
      if (!isPromptPartPath(path)) continue
      overrides.set(path, hash)
      const file = join(this.#root, ...path.split('/'))
      if (existsSync(file)) texts.set(path, readFileSync(file, 'utf8'))
    }

    // Apply the save: identical-to-default removes (§16.2); anything else replaces/creates.
    for (const part of parts) {
      const def = readDefaultPart(part.path)
      if (def === undefined) throw new UnknownPartError(part.path)
      if (part.text === def.text) {
        overrides.delete(part.path)
        texts.delete(part.path)
      } else {
        overrides.set(part.path, def.hash)
        texts.set(part.path, part.text)
      }
    }
    // Overrides for parts that no longer ship are dropped on the next save (§16.3).
    for (const path of [...overrides.keys()]) {
      if (!known.has(path)) {
        overrides.delete(path)
        texts.delete(path)
      }
    }

    // The snapshot is written FIRST and carries the new texts itself — it is the record of
    // intent; the file side below catches up. Revision numbers are never reused, so a crash
    // between the two leaves recovery as a diff, not a guess.
    const snapshot: RevisionSnapshot = {
      n: current + 1,
      base: current,
      origin,
      time: (input.now ?? (() => new Date()))().toISOString(),
      parts: [...overrides.keys()].sort().map((path) => ({
        path,
        text: texts.get(path) ?? '',
        defaultBaseHash: overrides.get(path)!,
        defaultText: readDefaultPart(path)?.text ?? '',
      })),
    }
    this.#writeRevision(snapshot)

    for (const part of parts) {
      const file = join(this.#root, ...part.path.split('/'))
      const def = readDefaultPart(part.path) as DefaultPart
      if (part.text === def.text) {
        if (existsSync(file)) rmSync(file)
      } else {
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, part.text)
      }
    }
    // Overrides dropped by this save (removed parts, §16.3) leave no file behind either.
    for (const path of Object.keys(bases)) {
      if (!isPromptPartPath(path) || overrides.has(path)) continue
      const file = join(this.#root, ...path.split('/'))
      if (existsSync(file)) rmSync(file)
    }
    const nextBases: Record<string, string> = {}
    for (const [path, hash] of Object.entries(bases)) {
      if (!isPromptPartPath(path)) nextBases[path] = hash // other loaders' entries pass through
    }
    for (const [path, hash] of overrides) nextBases[path] = hash
    mkdirSync(this.#root, { recursive: true })
    writeFileSync(join(this.#root, BASES_FILE), `${JSON.stringify(nextBases, null, 2)}\n`)

    return { revision: snapshot.n }
  }

  /** Writes `revisions/<n>.json` with 'wx'; never reuses a number, even after a crash. */
  #writeRevision(snapshot: RevisionSnapshot): void {
    const dir = join(this.#root, REVISIONS_DIR)
    mkdirSync(dir, { recursive: true })
    let n = Math.max(snapshot.n, this.revision() + 1)
    for (;;) {
      try {
        writeFileSync(join(dir, `${n}.json`), `${JSON.stringify(snapshot, null, 2)}\n`, { flag: 'wx' })
        snapshot.n = n
        return
      } catch (error) {
        if (existsSync(join(dir, `${n}.json`))) {
          n += 1 // another writer took this number; numbers are never reused
          continue
        }
        throw error
      }
    }
  }

  /**
   * Recovers the default TEXT an override's base hash names, from revision history newest-first.
   * Each snapshot recorded the default text as it shipped at save time; the newest snapshot whose
   * recorded hash matches is the old default the UI diffs against (§16.3).
   */
  #recoverDefault(path: string, defaultBaseHash: string): { text: string; hash: string } | undefined {
    const numbers = this.#revisionNumbers()
    for (let i = numbers.length - 1; i >= 0; i--) {
      const snapshot = this.getRevision(numbers[i]!)
      const part = snapshot?.parts.find((entry) => entry.path === path)
      if (part !== undefined && part.defaultBaseHash === defaultBaseHash) {
        return { text: part.defaultText, hash: part.defaultBaseHash }
      }
    }
    return undefined
  }

  #revisionNumbers(): number[] {
    const dir = join(this.#root, REVISIONS_DIR)
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .map((entry) => Number.parseInt(entry.replace(/\.json$/, ''), 10))
      .filter((n) => Number.isInteger(n))
      .sort((a, b) => a - b)
  }
}

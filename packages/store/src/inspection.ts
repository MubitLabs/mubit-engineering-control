/**
 * Read-only, bounded inspection queries over the existing schema (plan §17, §18; no migration).
 *
 * Documents page by `rowid` keyset: `WHERE kind = ? AND rowid > ? ORDER BY rowid LIMIT ?`, which
 * the current `doc_kind_idx` serves as `SEARCH docs USING INDEX doc_kind_idx (kind=? AND rowid>?)`.
 * The rowid is a safe keyset because the docs upsert updates a row in place and nothing runs
 * `VACUUM`. Events page by `(stream, seq)`, the primary key. Nothing here writes, and nothing here
 * adds an index, a table or a column: an equality on a JSON field scans the kind, and if that is
 * ever too slow the answer is a separately approved migration, never a workaround.
 */

import type { Json, StoreDoc } from '@mec/contracts'
import type Database from 'better-sqlite3'

export const DEFAULT_PAGE_LIMIT = 50
export const MAX_PAGE_LIMIT = 100
/** One response is at most this many bytes of JSON; a page ends early rather than exceed it. */
export const MAX_PAGE_BYTES = 1024 * 1024

/** A cursor that is not the opaque base64url of `{v:1,r:<non-negative integer>[,p:'recent'][,t,n]}`. */
export class CursorError extends Error {}

/** Where a needs walk stands in the recent rows: the last settle time, and how many it has served. */
export type SettledCursor = { at: string; served: number }

/** `recent` marks a needs cursor past the open rows, where the keyset runs newest first. */
export function encodeCursor(position: number, recent = false, settled?: SettledCursor): string {
  const cursor = {
    v: 1,
    r: position,
    ...(recent && { p: 'recent' }),
    ...(settled !== undefined && { t: settled.at, n: settled.served }),
  }
  return Buffer.from(JSON.stringify(cursor)).toString('base64url')
}

/** Validates before any query runs; throws `CursorError` for anything but a well-formed v1 cursor. */
export function decodeCursorAt(cursor: string): { r: number; recent: boolean } & Partial<SettledCursor> {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new CursorError('cursor is not base64url')
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    throw new CursorError('cursor is not valid')
  }
  if (typeof parsed !== 'object' || parsed === null) throw new CursorError('cursor is not valid')
  const { v, r, p, t, n } = parsed as { v?: unknown; r?: unknown; p?: unknown; t?: unknown; n?: unknown }
  if (v !== 1) throw new CursorError('cursor version is not supported')
  if (typeof r !== 'number' || !Number.isSafeInteger(r) || r < 0)
    throw new CursorError('cursor position is not valid')
  if (p !== undefined && p !== 'recent') throw new CursorError('cursor phase is not valid')
  if (t === undefined && n === undefined) return { r, recent: p === 'recent' }
  if (typeof t !== 'string' || typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0)
    throw new CursorError('cursor position is not valid')
  return { r, recent: p === 'recent', at: t, served: n }
}

export function decodeCursor(cursor: string): number {
  return decodeCursorAt(cursor).r
}

function checkLimit(limit: number | undefined): number {
  const value = limit ?? DEFAULT_PAGE_LIMIT
  if (!Number.isInteger(value) || value < 1 || value > MAX_PAGE_LIMIT) {
    throw new RangeError(`limit must be an integer from 1 to ${MAX_PAGE_LIMIT}`)
  }
  return value
}

const FIELD = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/

function checkField(field: string): string {
  if (!FIELD.test(field)) throw new RangeError(`not a plain field name: ${field}`)
  return `$.${field}`
}

type Scalar = string | number | boolean | null

export type PageDocsOptions = {
  /** Opaque cursor from a previous page; absent starts at the beginning. */
  cursor?: string | null
  limit?: number
  /** Response byte cap; the page ends early with a valid cursor. At least one row is always served. */
  maxBytes?: number
  /** Top-level JSON fields that must equal the value; `null` matches a missing field. */
  equals?: Record<string, Scalar>
  /** `asc` (default) pages oldest first; `desc` pages newest first. The cursor belongs to its order. */
  order?: 'asc' | 'desc'
  /** Only ids that start with this text (served by the kind index, not a scan of other kinds). */
  idPrefix?: string
  /** Test seam: called once for every row the database hands back. */
  onRow?: () => void
}

export type DocRow = { rowid: number; doc: StoreDoc }
export type DocPage = { rows: DocRow[]; nextCursor: string | null }
export type EventRow = { stream: string; seq: number; at: string; type: string; body: Json | null }
export type EventPage = { rows: EventRow[]; nextCursor: string | null }

const likeEscape = (text: string): string => text.replace(/[\\%_]/g, (c) => `\\${c}`)

export class InspectionReads {
  readonly #db: Database.Database
  readonly #cache = new Map<string, Database.Statement>()

  constructor(db: Database.Database) {
    this.#db = db
  }

  #prepare(sql: string): Database.Statement {
    let statement = this.#cache.get(sql)
    if (statement === undefined) {
      statement = this.#db.prepare(sql)
      this.#cache.set(sql, statement)
    }
    return statement
  }

  /** Runs `fn` in one read transaction, so every read inside it sees the same committed state. */
  consistent<T>(fn: () => T): T {
    return this.#db.transaction(fn).deferred()
  }

  #pageQuery(
    kind: string,
    after: number,
    limit: number,
    options: PageDocsOptions,
  ): { sql: string; params: Scalar[] } {
    const desc = options.order === 'desc'
    const clauses = ['kind = ?', desc ? 'rowid < ?' : 'rowid > ?']
    const params: Scalar[] = [kind, after]
    for (const [field, value] of Object.entries(options.equals ?? {})) {
      const path = checkField(field)
      if (value === null) {
        clauses.push('json_extract(json, ?) IS NULL')
        params.push(path)
      } else {
        clauses.push('json_extract(json, ?) = ?')
        params.push(path, value)
      }
    }
    if (options.idPrefix !== undefined) {
      clauses.push("id LIKE ? ESCAPE '\\'")
      params.push(`${likeEscape(options.idPrefix)}%`)
    }
    params.push(limit + 1)
    return {
      sql: `SELECT rowid AS rowid, json FROM docs WHERE ${clauses.join(' AND ')} ORDER BY rowid ${desc ? 'DESC' : 'ASC'} LIMIT ?`,
      params,
    }
  }

  pageDocs(kind: string, options: PageDocsOptions = {}): DocPage {
    const limit = checkLimit(options.limit)
    const start = options.order === 'desc' ? Number.MAX_SAFE_INTEGER : 0
    const after =
      options.cursor === undefined || options.cursor === null ? start : decodeCursor(options.cursor)
    const maxBytes = options.maxBytes ?? MAX_PAGE_BYTES
    const { sql, params } = this.#pageQuery(kind, after, limit, options)
    const rows: DocRow[] = []
    let bytes = 0
    let more = false
    for (const row of this.#prepare(sql).iterate(...params) as Iterable<{ rowid: number; json: string }>) {
      options.onRow?.()
      if (rows.length === limit) {
        more = true
        break
      }
      const size = Buffer.byteLength(row.json)
      if (rows.length > 0 && bytes + size > maxBytes) {
        more = true
        break
      }
      bytes += size
      rows.push({ rowid: row.rowid, doc: JSON.parse(row.json) as StoreDoc })
    }
    const last = rows.at(-1)
    return { rows, nextCursor: more && last !== undefined ? encodeCursor(last.rowid) : null }
  }

  /** The query plan for a page read, so a test can prove the index is the one doing the work. */
  explainPageDocs(kind: string, options: PageDocsOptions = {}): string[] {
    const { sql, params } = this.#pageQuery(
      kind,
      options.order === 'desc' ? Number.MAX_SAFE_INTEGER : 0,
      DEFAULT_PAGE_LIMIT,
      options,
    )
    return (this.#db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]).map(
      (row) => row.detail,
    )
  }

  /** One doc by id, only when it is of this kind (`Repository.get` answers any kind's id). */
  getDoc(kind: string, id: string): StoreDoc | undefined {
    const row = this.#prepare('SELECT json FROM docs WHERE id = ? AND kind = ?').get(id, kind) as
      | { json: string }
      | undefined
    return row === undefined ? undefined : (JSON.parse(row.json) as StoreDoc)
  }

  /** Every doc of a kind whose field equals one of `values`, oldest first. One scan per 500 values. */
  docsByField(kind: string, field: string, values: readonly string[]): StoreDoc[] {
    const path = checkField(field)
    const found: { rowid: number; doc: StoreDoc }[] = []
    for (let i = 0; i < values.length; i += 500) {
      const chunk = values.slice(i, i + 500)
      const marks = chunk.map(() => '?').join(', ')
      const rows = this.#prepare(
        `SELECT rowid AS rowid, json FROM docs WHERE kind = ? AND json_extract(json, ?) IN (${marks}) ORDER BY rowid`,
      ).all(kind, path, ...chunk) as { rowid: number; json: string }[]
      for (const row of rows) found.push({ rowid: row.rowid, doc: JSON.parse(row.json) as StoreDoc })
    }
    return found.sort((a, b) => a.rowid - b.rowid).map((entry) => entry.doc)
  }

  /** `{ [groupValue]: { [valueField]: count } }` over the named group values, without loading the docs. */
  countByField(
    kind: string,
    groupField: string,
    valueField: string,
    groups: readonly string[],
    fallback = 'unknown',
  ): Record<string, Record<string, number>> {
    const groupPath = checkField(groupField)
    const valuePath = checkField(valueField)
    const out: Record<string, Record<string, number>> = {}
    for (let i = 0; i < groups.length; i += 500) {
      const chunk = groups.slice(i, i + 500)
      const marks = chunk.map(() => '?').join(', ')
      const rows = this.#prepare(
        `SELECT json_extract(json, ?) AS grp, COALESCE(json_extract(json, ?), ?) AS val, COUNT(*) AS n
         FROM docs WHERE kind = ? AND json_extract(json, ?) IN (${marks}) GROUP BY grp, val`,
      ).all(groupPath, valuePath, fallback, kind, groupPath, ...chunk) as {
        grp: string
        val: string
        n: number
      }[]
      for (const row of rows) {
        const group = out[row.grp] ?? {}
        group[String(row.val)] = row.n
        out[row.grp] = group
      }
    }
    return out
  }

  /** Docs of a kind whose named text fields contain `text`, case-insensitively, oldest first and capped. */
  searchDocs(
    kind: string,
    fields: readonly string[],
    text: string,
    options: { limit: number; equals?: Record<string, Scalar>; excludeIdPrefix?: string } = { limit: 20 },
  ): StoreDoc[] {
    const limit = checkLimit(options.limit)
    const paths = fields.map(checkField)
    const clauses = [
      'kind = ?',
      `(${paths.map(() => "json_extract(json, ?) LIKE ? ESCAPE '\\'").join(' OR ')})`,
    ]
    const params: Scalar[] = [kind]
    for (const path of paths) params.push(path, `%${likeEscape(text)}%`)
    for (const [field, value] of Object.entries(options.equals ?? {})) {
      const path = checkField(field)
      if (value === null) {
        clauses.push('json_extract(json, ?) IS NULL')
        params.push(path)
      } else {
        clauses.push('json_extract(json, ?) = ?')
        params.push(path, value)
      }
    }
    if (options.excludeIdPrefix !== undefined) {
      clauses.push("id NOT LIKE ? ESCAPE '\\'")
      params.push(`${likeEscape(options.excludeIdPrefix)}%`)
    }
    params.push(limit)
    const rows = this.#prepare(
      `SELECT json FROM docs WHERE ${clauses.join(' AND ')} ORDER BY rowid LIMIT ?`,
    ).all(...params) as { json: string }[]
    return rows.map((row) => JSON.parse(row.json) as StoreDoc)
  }

  /** One page of a stream after a sequence number (or an opaque cursor, which wins). */
  pageEvents(
    stream: string,
    options: { after?: number; cursor?: string | null; limit?: number; maxBytes?: number } = {},
  ): EventPage {
    const limit = checkLimit(options.limit)
    const after =
      options.cursor !== undefined && options.cursor !== null
        ? decodeCursor(options.cursor)
        : (options.after ?? 0)
    const maxBytes = options.maxBytes ?? MAX_PAGE_BYTES
    const rows: EventRow[] = []
    let bytes = 0
    let more = false
    const query = this.#prepare(
      'SELECT stream, seq, at, type, body FROM events WHERE stream = ? AND seq > ? ORDER BY seq LIMIT ?',
    )
    for (const row of query.iterate(stream, after, limit + 1) as Iterable<{
      stream: string
      seq: number
      at: string
      type: string
      body: string | null
    }>) {
      if (rows.length === limit) {
        more = true
        break
      }
      const size = Buffer.byteLength(row.body ?? '')
      if (rows.length > 0 && bytes + size > maxBytes) {
        more = true
        break
      }
      bytes += size
      rows.push({
        stream: row.stream,
        seq: row.seq,
        at: row.at,
        type: row.type,
        body: row.body === null ? null : (JSON.parse(row.body) as Json),
      })
    }
    const last = rows.at(-1)
    return { rows, nextCursor: more && last !== undefined ? encodeCursor(last.seq) : null }
  }

  /** A stream's events of one type, oldest first, for a caller that reads only that type. */
  eventsOfType(stream: string, type: string, limit: number): EventRow[] {
    const rows = this.#prepare(
      'SELECT stream, seq, at, type, body FROM events WHERE stream = ? AND type = ? ORDER BY seq LIMIT ?',
    ).all(stream, type, limit) as (Omit<EventRow, 'body'> & { body: string | null })[]
    return rows.map((row) => ({ ...row, body: row.body === null ? null : (JSON.parse(row.body) as Json) }))
  }

  /** The events of one type written at one instant on any of these streams, oldest first. */
  eventsAt(streams: readonly string[], type: string, at: string): EventRow[] {
    const out: EventRow[] = []
    for (let i = 0; i < streams.length; i += 500) {
      const chunk = streams.slice(i, i + 500)
      const marks = chunk.map(() => '?').join(', ')
      const rows = this.#prepare(
        `SELECT stream, seq, at, type, body FROM events WHERE stream IN (${marks}) AND type = ? AND at = ? ORDER BY stream, seq`,
      ).all(...chunk, type, at) as (Omit<EventRow, 'body'> & { body: string | null })[]
      for (const row of rows) {
        out.push({ ...row, body: row.body === null ? null : (JSON.parse(row.body) as Json) })
      }
    }
    return out
  }

  /** The highest seq of each stream; a stream with no events reads 0. */
  cursors(streams: readonly string[]): Record<string, number> {
    const out: Record<string, number> = Object.fromEntries(streams.map((stream) => [stream, 0]))
    for (let i = 0; i < streams.length; i += 500) {
      const chunk = streams.slice(i, i + 500)
      const marks = chunk.map(() => '?').join(', ')
      const rows = this.#prepare(
        `SELECT stream, MAX(seq) AS seq FROM events WHERE stream IN (${marks}) GROUP BY stream`,
      ).all(...chunk) as { stream: string; seq: number }[]
      for (const row of rows) out[row.stream] = row.seq
    }
    return out
  }

  /** The time of each stream's latest event; a stream with no events is absent. */
  lastEventAt(streams: readonly string[]): Record<string, string> {
    const out: Record<string, string> = {}
    for (let i = 0; i < streams.length; i += 500) {
      const chunk = streams.slice(i, i + 500)
      const marks = chunk.map(() => '?').join(', ')
      const rows = this.#prepare(
        `SELECT e.stream AS stream, e.at AS at FROM events e WHERE e.stream IN (${marks})
         AND e.seq = (SELECT MAX(seq) FROM events WHERE stream = e.stream)`,
      ).all(...chunk) as { stream: string; at: string }[]
      for (const row of rows) out[row.stream] = row.at
    }
    return out
  }
}

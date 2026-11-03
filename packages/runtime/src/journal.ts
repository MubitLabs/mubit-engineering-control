/**
 * The per-attempt durable journal (plan B1: fsync, ack cursor, replay).
 *
 * The journal is the durable record of an attempt's engine events and the source every replay
 * reads after a crash or restart. The protocol is strict about ordering:
 * - Every event is appended to `events.jsonl` and fsynced BEFORE it is handed to any store.
 * - Control's acknowledgement is a cursor: `ack` holds the highest seq the control side durably
 *   accepted, replaced atomically (write `ack.tmp`, fsync, rename).
 * - Replay resends exactly the unacknowledged tail — events past the cursor, in file order.
 * - A seq that goes backwards or repeats is refused; sequences are strictly increasing per
 *   attempt, and the check is seeded from the file so it survives a restart.
 *
 * A torn final line (a crash mid-write) never fails an open; everything that parsed replays.
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import type { EngineEvent } from '@mec/contracts'

const EVENTS_FILENAME = 'events.jsonl'
const ACK_FILENAME = 'ack'
const ACK_TMP_FILENAME = 'ack.tmp'

export type JournalOpenMode = 'create' | 'existing'

/** A seq (or ack) that goes backwards or repeats breaks the per-attempt monotonic order. */
export class SequenceError extends Error {}

export class AttemptJournal {
  private readonly eventsPath: string
  private readonly ackPath: string
  private readonly ackTmpPath: string
  /** The decode cache: every parsed event, in file order. */
  private readonly cache: EngineEvent[]
  private last: number | null = null
  private cursor: number | null = null

  private constructor(readonly dir: string) {
    this.eventsPath = join(dir, EVENTS_FILENAME)
    this.ackPath = join(dir, ACK_FILENAME)
    this.ackTmpPath = join(dir, ACK_TMP_FILENAME)
    this.cache = loadEvents(this.eventsPath)
    for (const event of this.cache) {
      if (this.last === null || event.seq > this.last) this.last = event.seq
    }
    this.cursor = loadAckCursor(this.ackPath)
  }

  static open(dir: string, mode: JournalOpenMode = 'create'): AttemptJournal {
    if (mode === 'existing' && !existsSync(dir)) {
      throw new Error(`journal directory does not exist: ${dir}`)
    }
    mkdirSync(dir, { recursive: true })
    return new AttemptJournal(dir)
  }

  /** Appends and fsyncs before returning; refuses a seq that does not strictly increase. */
  append(event: EngineEvent): void {
    if (this.last !== null && event.seq <= this.last) {
      throw new SequenceError(`event seq ${event.seq} does not follow ${this.last}`)
    }
    const fd = openSync(this.eventsPath, 'a')
    try {
      writeAll(fd, `${JSON.stringify(event)}\n`)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    this.cache.push(event)
    this.last = event.seq
  }

  /** Persists the cursor atomically; the in-memory cursor moves only after the rename lands. */
  ack(seq: number): void {
    if (this.cursor !== null && seq < this.cursor) {
      throw new SequenceError(`ack seq ${seq} is behind cursor ${this.cursor}`)
    }
    const fd = openSync(this.ackTmpPath, 'w')
    try {
      writeAll(fd, String(seq))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(this.ackTmpPath, this.ackPath)
    this.cursor = seq
  }

  ackedSeq(): number | null {
    return this.cursor
  }

  /** Every parsed event past `afterSeq` (all by default), in file order. */
  events(afterSeq?: number): EngineEvent[] {
    return afterSeq === undefined ? [...this.cache] : this.cache.filter((event) => event.seq > afterSeq)
  }

  /** The unacknowledged tail: everything past the cursor, or the whole journal before a first ack. */
  pending(): EngineEvent[] {
    return this.cursor === null ? [...this.cache] : this.events(this.cursor)
  }

  lastSeq(): number | null {
    return this.last
  }
}

/** One positioned write looped to completion, so a short write cannot tear the line. */
function writeAll(fd: number, text: string): void {
  const buffer = Buffer.from(text, 'utf8')
  let written = 0
  while (written < buffer.length) {
    written += writeSync(fd, buffer, written, buffer.length - written)
  }
}

function loadEvents(path: string): EngineEvent[] {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return [] // No file yet: nothing was ever appended.
  }
  const events: EngineEvent[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const parsed: unknown = JSON.parse(line)
      const seq =
        typeof parsed === 'object' && parsed !== null ? (parsed as { seq?: unknown }).seq : undefined
      if (typeof seq === 'number') events.push(parsed as EngineEvent)
    } catch {
      // Torn line from a crash mid-write; the intact prefix before it still replays.
    }
  }
  return events
}

function loadAckCursor(path: string): number | null {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return null // Never acked.
  }
  const seq = Number(text.trim())
  // The rename is atomic, so a partial cursor cannot happen; anything unreadable counts as
  // never acked, which replays everything — the safe direction.
  return text.trim() !== '' && Number.isInteger(seq) && seq >= 0 ? seq : null
}

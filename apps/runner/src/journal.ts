import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { type FileHandle, mkdir, open, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { RUNNER_PROTOCOL_VERSION, type RunnerEventEnvelope } from '@mec/contracts'

/**
 * Per-attempt durable journal (PDF §6, §25). Every event is appended and fsynced *before* it is
 * sent; control acknowledges after persisting; unacknowledged events are replayed on reconnect.
 *
 *   <home>/journal/<attemptId>/events.jsonl   one envelope per line
 *   <home>/journal/<attemptId>/meta.json      generation, phase, ack cursor, processed commands
 */

export type JournalPhase = 'active' | 'parked' | 'done'

export interface JournalMeta {
  attemptId: string
  generation: number
  phase: JournalPhase
  acked: number
  agentKind: string
  nativeSessionRef: string | null
  workdir: string | null
  /** The original start payload, kept for resume. */
  start: Record<string, unknown>
  baseSha?: string | null
  branch?: string | null
  port?: number | null
  commands: string[]
  updatedAt: string
}

export class AttemptJournal {
  private saving: Promise<void> = Promise.resolve()
  private appending: Promise<void> = Promise.resolve()
  private writes = 0

  private constructor(
    private readonly dir: string,
    readonly runnerId: string,
    private meta: JournalMeta,
    private nextSequence: number,
    private pendingEvents: RunnerEventEnvelope[],
    private readonly file: FileHandle,
  ) {}

  static async open(
    root: string,
    runnerId: string,
    attemptId: string,
    init?: Omit<JournalMeta, 'attemptId' | 'acked' | 'commands' | 'updatedAt'>,
  ): Promise<AttemptJournal> {
    const dir = path.join(root, attemptId)
    await mkdir(dir, { recursive: true })
    const metaPath = path.join(dir, 'meta.json')
    let meta: JournalMeta
    if (existsSync(metaPath)) {
      meta = JSON.parse(await readFile(metaPath, 'utf8')) as JournalMeta
    } else {
      if (!init) throw new Error(`no journal for attempt ${attemptId}`)
      meta = { attemptId, acked: -1, commands: [], updatedAt: new Date().toISOString(), ...init }
    }
    const eventsPath = path.join(dir, 'events.jsonl')
    const events: RunnerEventEnvelope[] = []
    if (existsSync(eventsPath)) {
      for (const line of (await readFile(eventsPath, 'utf8')).split('\n')) {
        if (!line.trim()) continue
        try {
          events.push(JSON.parse(line) as RunnerEventEnvelope)
        } catch {
          // A torn final line from a crash mid-write; everything before it is intact.
        }
      }
    }
    const last = events.at(-1)?.sequence ?? -1
    const file = await open(eventsPath, 'a')
    const journal = new AttemptJournal(
      dir,
      runnerId,
      meta,
      last + 1,
      events.filter((e) => e.sequence > meta.acked),
      file,
    )
    await journal.saveMeta()
    return journal
  }

  /** Attempt ids with a journal on disk. */
  static async list(root: string): Promise<string[]> {
    if (!existsSync(root)) return []
    return (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)
  }

  get attemptId(): string {
    return this.meta.attemptId
  }
  get generation(): number {
    return this.meta.generation
  }
  get phase(): JournalPhase {
    return this.meta.phase
  }
  get lastSequence(): number {
    return this.nextSequence - 1
  }
  get info(): Readonly<JournalMeta> {
    return this.meta
  }
  pending(): readonly RunnerEventEnvelope[] {
    return this.pendingEvents
  }

  /** Appends are serialised so file order, sequence order and the pending buffer always agree. */
  append(type: string, payload: Record<string, unknown>): Promise<RunnerEventEnvelope> {
    const result = this.appending.then(() => this.write(type, payload))
    this.appending = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private async write(type: string, payload: Record<string, unknown>): Promise<RunnerEventEnvelope> {
    const envelope: RunnerEventEnvelope = {
      schemaVersion: RUNNER_PROTOCOL_VERSION,
      eventId: randomUUID(),
      runnerId: this.runnerId,
      attemptId: this.meta.attemptId,
      generation: this.meta.generation,
      sequence: this.nextSequence++,
      type,
      occurredAt: new Date().toISOString(),
      payload,
    }
    await this.file.appendFile(`${JSON.stringify(envelope)}\n`)
    await this.file.datasync()
    this.pendingEvents.push(envelope)
    return envelope
  }

  /**
   * Control's record is behind ours (it was restored from a backup): reload the events after
   * `sequence` from the file so they are replayed. The journal file keeps every event.
   */
  async rewind(sequence: number): Promise<number> {
    if (sequence >= this.meta.acked) return 0
    const lines = (await readFile(path.join(this.dir, 'events.jsonl'), 'utf8')).split('\n')
    const events: RunnerEventEnvelope[] = []
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const e = JSON.parse(line) as RunnerEventEnvelope
        if (e.sequence > sequence) events.push(e)
      } catch {
        // torn line
      }
    }
    this.pendingEvents = events
    this.meta.acked = sequence
    await this.saveMeta()
    return events.length
  }

  /** Control persisted everything up to `sequence`; drop it from the replay buffer. */
  async ack(sequence: number): Promise<void> {
    if (sequence <= this.meta.acked) return
    this.pendingEvents = this.pendingEvents.filter((e) => e.sequence > sequence)
    this.meta.acked = sequence
    await this.saveMeta()
  }

  async update(patch: Partial<Omit<JournalMeta, 'attemptId'>>): Promise<void> {
    this.meta = { ...this.meta, ...patch }
    await this.saveMeta()
  }

  hasCommand(commandId: string): boolean {
    return this.meta.commands.includes(commandId)
  }

  async recordCommand(commandId: string): Promise<void> {
    this.meta.commands = [...this.meta.commands.slice(-199), commandId]
    await this.saveMeta()
  }

  async close(): Promise<void> {
    await this.file.close()
  }

  /** Meta writes are serialised (ack and command handling run concurrently) and atomic. */
  private saveMeta(): Promise<void> {
    this.saving = this.saving.then(async () => {
      this.meta.updatedAt = new Date().toISOString()
      const tmp = path.join(this.dir, `meta.json.${process.pid}.${++this.writes}.tmp`)
      await writeFile(tmp, JSON.stringify(this.meta, null, 2))
      await rename(tmp, path.join(this.dir, 'meta.json'))
    })
    return this.saving
  }
}

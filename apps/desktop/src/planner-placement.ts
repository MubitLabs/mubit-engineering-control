/**
 * What a planner turn validates tiers against and what dispatch places on (§3 rule 2, §11).
 *
 * Both see only the slots this build can launch, runner on or off, so a tier that passes validation
 * cannot land on a slot that refuses the launch: `opencode-gemini` has no row, so it takes no work.
 * `MEC_FAKE_ENGINE=1` places on its one fake slot and leaves the list alone.
 *
 * With the real runner on, the default: Claude publishes no model catalogue (`@mec/slots`' probe
 * answers `unlisted`), so a launchable slot's marks are the capability table's own entries for its
 * engine: declared, as an OpenCode slot's marks are declared by its config, not probed. A model the
 * account refuses fails that attempt with the engine's reason. With it off the marks are the
 * opencode config probe alone, as they have been since issue #14.
 *
 * A slot whose home a launch has listed (Codex `model/list`, kept by `attempt-launch.ts`) is marked
 * by that listing instead: a table row it named is available, any other row is unavailable.
 */

import { join } from 'node:path'
import { type ModelAvailability, markKeyFor, tableEntries } from '@mec/domain'
import type { ModelsTableSource } from '@mec/meta'
import { loadModelsTable, userModelsPath } from '@mec/prompts'
import { probeModelAvailabilitySync } from '@mec/slots'
import type { SqliteStore } from '@mec/store'
import { isLaunchableSlot, realRunnerOn } from './attempt-launch'
import { modelListingId } from './engine-registry'

type Marks = Record<string, Record<string, ModelAvailability>>

export type PlannerPlacement = {
  modelsTable: () => ModelsTableSource | undefined
  marks: () => Marks
  launchableSlots?: () => ReadonlySet<string>
  metaEngine: () => string | undefined
}

export function plannerPlacement(store: SqliteStore, dataDir: string): PlannerPlacement {
  const realRunner = realRunnerOn()
  // Issue #14: without this supplier the service falls back to an EMPTY table, every tier is
  // unplaceable, every plan rejected.
  const modelsTable = (): ModelsTableSource | undefined => {
    try {
      const loaded = loadModelsTable({ userPath: userModelsPath(dataDir) })
      return {
        table: loaded.table,
        provenance: { sha256: loaded.provenance.sha256, origin: loaded.provenance.source },
      }
    } catch {
      return undefined
    }
  }
  const declared = (engine: string): Record<string, ModelAvailability> => {
    const table = modelsTable()?.table
    if (table === undefined) return {}
    const entries = tableEntries(table).filter((entry) => entry.engine === engine)
    return Object.fromEntries(
      entries.map((entry) => [markKeyFor(entry.engine, entry.provider, entry.id), 'available' as const]),
    )
  }
  /** The table's rows for this slot's engine, by what its home last listed; undefined with none kept. */
  const listedMarks = (slot: {
    id?: unknown
    engine?: unknown
  }): Record<string, ModelAvailability> | undefined => {
    const kept = store.engines.get(modelListingId(String(slot.id)))
    if (kept === undefined || kept.engine !== slot.engine || !Array.isArray(kept.listed)) return undefined
    const listed = new Set(kept.listed.map(String))
    const marks = declared(String(slot.engine))
    return Object.fromEntries(
      Object.keys(marks).map((key) => [
        key,
        listed.has(key) ? ('available' as const) : ('unavailable' as const),
      ]),
    )
  }
  const marks = (): Marks => {
    const out: Marks = {}
    for (const slot of store.slots.list()) {
      if (realRunner && isLaunchableSlot(slot)) {
        out[String(slot.id)] = listedMarks(slot) ?? declared(String(slot.engine))
        continue
      }
      if (slot.engine !== 'opencode' || typeof slot.home !== 'string') continue
      try {
        const report = probeModelAvailabilitySync('opencode', { configDir: join(slot.home, 'config') })
        out[String(slot.id)] = report.availability
      } catch {
        // a slot whose config cannot be read is honestly unlisted (empty marks)
      }
    }
    return out
  }
  /** The engine of the slot chosen for the meta agent. A retired slot runs no meta agent. */
  const metaEngine = (): string | undefined => {
    const slotId = store.engines.get('settings/meta-slot')?.slotId
    const slot = typeof slotId === 'string' ? store.slots.get(slotId) : undefined
    return typeof slot?.engine === 'string' && slot.state !== 'retired' ? slot.engine : undefined
  }
  if (process.env.MEC_FAKE_ENGINE === '1') return { modelsTable, marks, metaEngine }
  const launchableSlots = (): ReadonlySet<string> =>
    new Set(
      store.slots
        .list()
        .filter(isLaunchableSlot)
        .map((slot) => String(slot.id)),
    )
  return { modelsTable, marks, launchableSlots, metaEngine }
}

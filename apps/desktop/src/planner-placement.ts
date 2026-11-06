/**
 * What a planner turn validates tiers against and what dispatch places on (§3 rule 2, §11).
 *
 * With `MEC_REAL_RUNNER=1` both see only the slots this build can launch, so a tier that passes
 * validation cannot land on a slot that refuses the launch. Claude publishes no model catalogue
 * (`@mec/slots`' probe answers `unlisted`), so a launchable slot's marks are the capability table's
 * own entries for its engine: declared, as an OpenCode slot's marks are declared by its config,
 * not probed. A model the account refuses fails that attempt with the engine's reason.
 *
 * With the flag off this is the opencode config probe alone, as it has been since issue #14.
 */

import { join } from 'node:path'
import { type ModelAvailability, markKeyFor, tableEntries } from '@mec/domain'
import type { ModelsTableSource } from '@mec/meta'
import { loadModelsTable, userModelsPath } from '@mec/prompts'
import { probeModelAvailabilitySync } from '@mec/slots'
import type { SqliteStore } from '@mec/store'
import { isLaunchableSlot } from './attempt-launch'

type Marks = Record<string, Record<string, ModelAvailability>>

export type PlannerPlacement = {
  modelsTable: () => ModelsTableSource | undefined
  marks: () => Marks
  launchableSlots?: () => ReadonlySet<string>
}

export function plannerPlacement(store: SqliteStore, dataDir: string): PlannerPlacement {
  const realRunner = process.env.MEC_REAL_RUNNER === '1' && process.env.MEC_FAKE_ENGINE !== '1'
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
  const marks = (): Marks => {
    const out: Marks = {}
    for (const slot of store.slots.list()) {
      if (realRunner && isLaunchableSlot(slot)) {
        out[String(slot.id)] = declared(String(slot.engine))
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
  if (!realRunner) return { modelsTable, marks }
  const launchableSlots = (): ReadonlySet<string> =>
    new Set(
      store.slots
        .list()
        .filter(isLaunchableSlot)
        .map((slot) => String(slot.id)),
    )
  return { modelsTable, marks, launchableSlots }
}

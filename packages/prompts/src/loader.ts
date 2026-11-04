/**
 * The defaults loader — plan §16 and review 2026-11-04 §6.1: every prompt part ships as a file in
 * `packages/prompts/defaults/` at the same path it occupies under `~/.mec/prompts/`. This module
 * is the one reader of that tree: it maps part paths to bundle layers, loads and validates parts,
 * and assembles a role's full bundle (shared → role → conventions → delivery → engine → skills →
 * generated) over whatever overrides the caller hands it.
 *
 * Only `.md` files are parts. Anything else in the tree (notably `models.yaml`, the capability
 * table of review §3) belongs to its own loader and never enters a bundle.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BundleComponent, BundleLayer, CompiledBundle } from './bundles'
import { compileBundle, componentHash } from './bundles'

/** The shipped defaults tree, resolved from this module so it works from any cwd or importer. */
export const DEFAULTS_ROOT: string = fileURLToPath(new URL('../defaults', import.meta.url))

/**
 * A part path → the layer it compiles into. `shared/delivery.md` is the one deliberate crossover:
 * the file lives under `shared/` beside its siblings but compiles as the delivery layer, exactly
 * as §16 names it (delivery requirements: PR evidence, commit identity, UI evidence, review
 * budget). Unknown trees answer undefined — such a path is not a bundle part.
 */
export function layerOfPart(path: string): BundleLayer | undefined {
  if (path === 'conventions.md') return 'conventions'
  if (path === 'shared/delivery.md') return 'delivery'
  if (path.startsWith('shared/')) return 'shared'
  if (path.startsWith('roles/')) return 'role'
  if (path.startsWith('engines/')) return 'engine'
  if (path.startsWith('skills/')) return 'skills'
  return undefined
}

/** A shipped default as the loader sees it: path, layer, name, text and its honest hash. */
export type DefaultPart = {
  path: string
  layer: BundleLayer
  name: string
  text: string
  hash: string
}

/** `roles/meta_agent/protocol.md` → `protocol`; `shared/communication.md` → `communication`. */
export function partName(path: string): string {
  const base = path.split('/').pop() ?? path
  return base.endsWith('.md') ? base.slice(0, -3) : base
}

/**
 * Every shipped default part, in canonical order: the tree walked depth-first, paths sorted.
 * `.md` only — the walk never lists `models.yaml` or any other non-part file.
 */
export function listDefaultParts(): string[] {
  const paths: string[] = []
  const walk = (dir: string, prefix: string): void => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        walk(full, prefix === '' ? entry : `${prefix}/${entry}`)
      } else if (entry.endsWith('.md')) {
        paths.push(prefix === '' ? entry : `${prefix}/${entry}`)
      }
    }
  }
  walk(DEFAULTS_ROOT, '')
  return paths.sort()
}

/** Reads one shipped default. Undefined when the tree or the part is missing — never a throw. */
export function readDefaultPart(path: string): DefaultPart | undefined {
  const layer = layerOfPart(path)
  if (layer === undefined) return undefined
  const file = join(DEFAULTS_ROOT, ...path.split('/'))
  if (!existsSync(file)) return undefined
  const text = readFileSync(file, 'utf8')
  return { path, layer, name: partName(path), text, hash: componentHash(text) }
}

/** Every shipped default, loaded and validated, in canonical order. */
export function defaultParts(): DefaultPart[] {
  const parts: DefaultPart[] = []
  for (const path of listDefaultParts()) {
    const part = readDefaultPart(path)
    if (part === undefined) {
      throw new Error(`default part '${path}' vanished between listing and reading`)
    }
    parts.push(part)
  }
  return parts
}

/**
 * The part paths one role is assembled from, joined into ONE role component:
 * `roles/<role>.md` (single file), `roles/<role>/*.md` (multi-file, joined in sorted order —
 * `meta_agent` = planning + protocol), or `roles/subagents/<role>.md` (the subagent catalogue).
 * Empty for a role the tree does not know.
 */
export function rolePartPaths(role: string): string[] {
  const single = `roles/${role}.md`
  if (existsSync(join(DEFAULTS_ROOT, single))) return [single]
  const dir = join(DEFAULTS_ROOT, 'roles', role)
  if (existsSync(dir) && statSync(dir).isDirectory()) {
    return readdirSync(dir)
      .filter((entry) => entry.endsWith('.md'))
      .sort()
      .map((entry) => `roles/${role}/${entry}`)
  }
  const subagent = `roles/subagents/${role}.md`
  if (existsSync(join(DEFAULTS_ROOT, subagent))) return [subagent]
  return []
}

/** Every role the defaults tree can assemble, in canonical order. */
export function listRoles(): string[] {
  const roles = new Set<string>()
  for (const path of listDefaultParts()) {
    if (!path.startsWith('roles/')) continue
    const rest = path.slice('roles/'.length)
    if (rest.startsWith('subagents/')) {
      roles.add(partName(rest))
    } else if (rest.includes('/')) {
      roles.add(rest.split('/')[0]!)
    } else {
      roles.add(partName(rest))
    }
  }
  return [...roles].sort()
}

// ── Assembly ────────────────────────────────────────────────────────────────────────────────

/** A caller-supplied section for the skills or generated layer. */
export type PartInput = { name: string; text: string }

/**
 * An override as assembly sees it: the replacement text and, when known, the `defaultBaseHash` of
 * the shipped default it was written against (§16.2). Without a base hash the component compiles
 * as delivery-specific — honest for a preview, never a durable save (the store always records one).
 */
export type OverrideInput = { text: string; defaultBaseHash?: string }

export type AssembleOptions = {
  /** Skill packs to append after the engine layer, in the order given. */
  skills?: readonly PartInput[]
  /** Per-attempt sections compiled by the core — last, so caches stay warm (§16.1). */
  generated?: readonly PartInput[]
  /** Path → override; applies to any default part, including single files of a multi-file role. */
  overrides?: Record<string, OverrideInput>
}

/**
 * Assembles one role's full bundle from the shipped defaults plus overrides, through
 * `compileBundle`'s validation. The engine layer is included when the engine names a shipped part;
 * an unknown engine is an error, a bundle without an engine layer is not.
 */
export function assemble(role: string, engine?: string, opts: AssembleOptions = {}): CompiledBundle {
  const overrides = opts.overrides ?? {}
  const component = (path: string): BundleComponent | undefined => {
    const override = overrides[path]
    if (override !== undefined) {
      return {
        layer: layerOfPart(path)!,
        name: partName(path),
        text: override.text,
        hash: componentHash(override.text),
        origin: 'user_override',
        ...(override.defaultBaseHash !== undefined && { defaultBaseHash: override.defaultBaseHash }),
      }
    }
    const part = readDefaultPart(path)
    return part === undefined
      ? undefined
      : { layer: part.layer, name: part.name, text: part.text, hash: part.hash, origin: 'default' }
  }

  const components: BundleComponent[] = []
  for (const path of listDefaultParts()) {
    const layer = layerOfPart(path)
    if (layer === 'shared') {
      const part = component(path)
      if (part !== undefined) components.push(part)
    }
  }

  const rolePaths = rolePartPaths(role)
  if (rolePaths.length === 0) {
    throw new Error(`unknown role '${role}' — known roles: ${listRoles().join(', ')}`)
  }
  const roleTexts: string[] = []
  let roleOverridden = false
  for (const path of rolePaths) {
    const override = overrides[path]
    if (override !== undefined) {
      roleTexts.push(override.text)
      roleOverridden = true
    } else {
      const part = readDefaultPart(path)
      if (part === undefined) throw new Error(`role part '${path}' missing from the defaults tree`)
      roleTexts.push(part.text)
    }
  }
  const roleText = roleTexts.join('\n\n')
  // A multi-file role joins into ONE component; its base is the joined DEFAULT text it was
  // written against (each file's own base hash lives in the store, not in the component). A
  // single-file role names its file's base hash when the override carried one.
  let roleBase: string | undefined
  if (roleOverridden) {
    roleBase =
      rolePaths.length === 1
        ? (overrides[rolePaths[0]!]?.defaultBaseHash ??
          componentHash(readDefaultPart(rolePaths[0]!)?.text ?? ''))
        : componentHash(rolePaths.map((path) => readDefaultPart(path)?.text ?? '').join('\n\n'))
  }
  components.push({
    layer: 'role',
    name: role,
    text: roleText,
    hash: componentHash(roleText),
    origin: roleOverridden ? 'user_override' : 'default',
    ...(roleBase !== undefined && { defaultBaseHash: roleBase }),
  })

  const conventions = component('conventions.md')
  if (conventions !== undefined) components.push(conventions)
  const delivery = component('shared/delivery.md')
  if (delivery !== undefined) components.push(delivery)

  if (engine !== undefined) {
    const notes = component(`engines/${engine}.md`)
    if (notes === undefined) {
      throw new Error(`unknown engine '${engine}' — the defaults tree ships no notes for it`)
    }
    components.push(notes)
  }

  for (const skill of opts.skills ?? []) {
    components.push({
      layer: 'skills',
      name: skill.name,
      text: skill.text,
      hash: componentHash(skill.text),
      origin: 'delivery_specific',
    })
  }
  for (const section of opts.generated ?? []) {
    components.push({
      layer: 'generated',
      name: section.name,
      text: section.text,
      hash: componentHash(section.text),
      origin: 'delivery_specific',
    })
  }

  return compileBundle(components)
}

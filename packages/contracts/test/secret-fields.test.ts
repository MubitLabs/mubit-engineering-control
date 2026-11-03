import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import * as contracts from '../src'

// CONTRACTS §0: no credential has a field. A field fails when one of its name segments is one of these.
const FORBIDDEN = new Set(['token', 'key', 'secret', 'password'])

// The only exemption: an attempt-scoped mec-tools token, minted at launch and never stored (plan §6, §17).
const EXEMPT = ['AttemptBrief.tools.token']

type LooseDef = {
  type: string
  shape?: Record<string, z.core.$ZodType>
  catchall?: z.core.$ZodType
  element?: z.core.$ZodType
  options?: z.core.$ZodType[]
  innerType?: z.core.$ZodType
  valueType?: z.core.$ZodType
  items?: z.core.$ZodType[]
  in?: z.core.$ZodType
  out?: z.core.$ZodType
  left?: z.core.$ZodType
  right?: z.core.$ZodType
  getter?: () => z.core.$ZodType
}

const segments = (field: string) =>
  field
    .split(/[_\-.]|(?=[A-Z])/)
    .filter(Boolean)
    .map((s) => s.toLowerCase())

function secretFields(root: z.core.$ZodType, rootPath: string): string[] {
  const found: string[] = []
  const seen = new Set<z.core.$ZodType>()
  const walk = (schema: z.core.$ZodType | undefined, path: string): void => {
    if (!schema || seen.has(schema)) return
    seen.add(schema)
    const def = schema._zod.def as unknown as LooseDef
    for (const [field, child] of Object.entries(def.shape ?? {})) {
      if (segments(field).some((s) => FORBIDDEN.has(s))) found.push(`${path}.${field}`)
      walk(child, `${path}.${field}`)
    }
    for (const child of [def.catchall, def.element, def.innerType, def.valueType, def.in, def.out]) {
      walk(child, path)
    }
    for (const child of [...(def.options ?? []), ...(def.items ?? []), def.left, def.right]) walk(child, path)
    if (def.type === 'lazy') walk(def.getter?.(), path)
  }
  walk(root, rootPath)
  return found
}

const allSecretFields = () =>
  Object.entries(contracts as Record<string, unknown>)
    .filter((entry): entry is [string, z.ZodType] => entry[1] instanceof z.ZodType)
    .flatMap(([name, schema]) => secretFields(schema, name))

describe('secret-field lint', () => {
  it('finds no credential-named field outside the exemption', () => {
    expect(allSecretFields().filter((path) => !EXEMPT.includes(path))).toEqual([])
  })

  it('still needs every exemption it lists', () => {
    expect(EXEMPT.filter((path) => !allSecretFields().includes(path))).toEqual([])
  })

  it('matches whole name segments, not substrings', () => {
    const probe = z.strictObject({
      input_tokens: z.number(),
      monkey: z.string(),
      nested: z.array(z.strictObject({ api_key: z.string(), clientSecret: z.string().optional() })),
      choice: z.union([z.strictObject({ password: z.string() }), z.string()]),
      map: z.record(z.string(), z.strictObject({ refresh_token: z.string() })),
    })
    expect(secretFields(probe, 'Probe').sort()).toEqual([
      'Probe.choice.password',
      'Probe.map.refresh_token',
      'Probe.nested.api_key',
      'Probe.nested.clientSecret',
    ])
  })
})

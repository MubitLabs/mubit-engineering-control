import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import * as contracts from '../src'
import { SAMPLES } from './samples'

const schemas = contracts as unknown as Record<string, z.ZodType>

describe.each(Object.entries(SAMPLES))('%s', (name, { valid, invalid }) => {
  const schema = schemas[name]!

  it.each(valid.map((sample, i) => [i, sample]))('accepts valid sample %i', (_, sample) => {
    const result = schema.safeParse(sample)
    expect(result.error?.issues).toBeUndefined()
  })

  it.each(invalid.map((sample, i) => [i, sample]))('rejects invalid sample %i', (_, sample) => {
    expect(schema.safeParse(sample).success).toBe(false)
  })
})

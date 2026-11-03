import { expect, it } from 'vitest'
import { z } from 'zod'
import * as contracts from '../src'
import { SAMPLES } from './samples'

const exportedSchemas = Object.entries(contracts)
  .filter(([, value]) => value instanceof z.ZodType)
  .map(([name]) => name)

it('has two valid and two invalid samples for every exported schema', () => {
  const lacking = exportedSchemas.filter(
    (name) => (SAMPLES[name]?.valid.length ?? 0) < 2 || (SAMPLES[name]?.invalid.length ?? 0) < 2,
  )
  expect(lacking).toEqual([])
})

it('has no samples for a schema that is not exported', () => {
  expect(Object.keys(SAMPLES).filter((name) => !exportedSchemas.includes(name))).toEqual([])
})

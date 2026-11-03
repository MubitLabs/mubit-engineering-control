import { z } from 'zod'

/** A reading that does not exist is this literal, never `null`, `0` or a guess (CONTRACTS §0). */
export const Unknown = z.literal('unknown')

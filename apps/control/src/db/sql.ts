import postgres from 'postgres'

type Types = { bigint: number }

/** Pool or transaction: anything that can run a query. */
export type Db = postgres.ISql<Types>
export type Sql = postgres.Sql<Types>
export type Tx = postgres.TransactionSql<Types>

/**
 * Columns come back camelCased (`created_at` -> `createdAt`) and int8 values as numbers, which is
 * safe for our identities and sequences (< 2^53).
 */
export function createSql(url: string, opts: { max?: number } = {}): Sql {
  return postgres(url, {
    max: opts.max ?? 10,
    onnotice: () => {},
    transform: postgres.camel,
    types: {
      bigint: {
        to: 20,
        from: [20],
        serialize: (value: number) => String(value),
        parse: (raw: string) => Number(raw),
      },
    },
  })
}

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  if (!(error instanceof postgres.PostgresError) || error.code !== '23505') return false
  return constraint === undefined || error.constraint_name === constraint
}

/** `.state` and `.tier` — words first, a marker dot only when the person is involved. */

export type StateKind = 'ok' | 'warn' | 'attn' | 'bad' | 'done' | 'none'

export function StateLabel({ kind = 'none', children }: { kind?: StateKind; children: React.ReactNode }) {
  return kind === 'none' ? (
    <span className="state">{children}</span>
  ) : (
    <span className={`state state-${kind}`}>{children}</span>
  )
}

export function Tier({ children }: { children: React.ReactNode }) {
  return <span className="tier">{children}</span>
}

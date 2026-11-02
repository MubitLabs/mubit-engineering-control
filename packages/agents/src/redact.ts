/**
 * Redaction before durable storage (PDF §16, §26): agent output can echo credentials it read from
 * the environment or the repository. Patterns cover common token formats; the key=value rule keeps
 * the key so the evidence stays readable.
 */
const PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, '[REDACTED GITHUB TOKEN]'],
  [/\bgithub_pat_[A-Za-z0-9_]{40,}\b/g, '[REDACTED GITHUB TOKEN]'],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/g, '[REDACTED ANTHROPIC KEY]'],
  [/\bsk-[A-Za-z0-9]{32,}\b/g, '[REDACTED API KEY]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED AWS KEY]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED SLACK TOKEN]'],
  [/\bmec_(?:rt|inv)_[A-Za-z0-9_-]{20,}/g, '[REDACTED MEC TOKEN]'],
  [
    /(\b(?:password|passwd|secret|token|api[_-]?key|access[_-]?key)\b["']?\s*[=:]\s*["']?)[^\s"',}]{8,}/gi,
    '$1[REDACTED]',
  ],
]

export function redact(text: string): string {
  let out = text
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement)
  return out
}

export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redact(value) as T
  if (Array.isArray(value)) return value.map(redactDeep) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactDeep(v)]),
    ) as T
  }
  return value
}

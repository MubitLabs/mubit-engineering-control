/**
 * Provider key formats, v0. The canonical list is Stream B's (`packages/slots`, redaction patterns);
 * this mirror lets the contracts lint and the event-stream check run in every package.
 * Patterns carry no `g` flag, so `test` is stateless.
 */
export const SECRET_PATTERNS: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: 'anthropic', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'openai-scoped', pattern: /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}/ },
  { name: 'openai-legacy', pattern: /\bsk-[A-Za-z0-9]{32,}\b/ },
  { name: 'google', pattern: /\bAIza[0-9A-Za-z_-]{35}/ },
  { name: 'zai', pattern: /\b[0-9a-f]{32}\.[A-Za-z0-9]{16}\b/ },
  { name: 'github', pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { name: 'github-pat', pattern: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/ },
]

export function matchesSecret(text: string): boolean {
  return SECRET_PATTERNS.some(({ pattern }) => pattern.test(text))
}

const SECRET_ENV_WORDS = ['KEY', 'PASSWORD', 'SECRET', 'TOKEN']

/** Plan §5.12: a variable whose name contains any of these words is scrubbed (substring, any case). */
export function isSecretEnvName(name: string): boolean {
  const upper = name.toUpperCase()
  return SECRET_ENV_WORDS.some((word) => upper.includes(word))
}

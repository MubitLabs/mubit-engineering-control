/**
 * A copy of `SECRET_PATTERNS` (packages/contracts/src/secrets.ts), because the web bundle does
 * not import `@mec/*`. `test/drafts.test.ts` fails the moment the two differ. The server still
 * redacts before any write; this keeps key-shaped text out of the browser's own storage.
 */
export const SECRET_SHAPES: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: 'anthropic', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'openai-scoped', pattern: /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}/ },
  { name: 'openai-legacy', pattern: /\bsk-[A-Za-z0-9]{32,}\b/ },
  { name: 'google', pattern: /\bAIza[0-9A-Za-z_-]{35}/ },
  { name: 'google-auth', pattern: /\bAQ\.Ab[A-Za-z0-9_-]{20,}/ },
  { name: 'zai', pattern: /\b[0-9a-f]{32}\.[A-Za-z0-9]{16}\b/ },
  { name: 'github', pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { name: 'github-pat', pattern: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/ },
]

export function looksLikeSecret(text: string): boolean {
  return SECRET_SHAPES.some(({ pattern }) => pattern.test(text))
}

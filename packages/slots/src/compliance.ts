/**
 * The compliance guard — plan §5.11/§22.
 *
 * A deliberately simple, line-based heuristic that greps MEC's own source for
 * READS of the stores §5.4/§5.7 put off-limits (`.credentials.json`, `auth.json`,
 * `opencode.db`, Keychain items, the slot keystores). A line is flagged when a
 * forbidden path pattern matches it AND a read marker (`readFile`, `cat `,
 * `security find-generic-password`, `dump-keychain`, …) appears on the same line
 * or an adjacent one. That is all it is: a tripwire that catches careless code in
 * review and CI. It is not a security boundary and not sound against deliberate
 * obfuscation — the custody rule itself is enforced structurally (§22: no code
 * path opens these stores); this scan keeps it that way.
 */
export const FORBIDDEN_PATH_PATTERNS: readonly RegExp[] = [
  /\.credentials\.json/, // Claude Code's Linux/macOS-fallback credential file (§5.3)
  /auth\.json$/, // Codex's token/key store (§5.3)
  /opencode\.db/, // OpenCode V2's credential + session SQLite (§5.3)
  /keychain/i, // macOS Keychain items — vendor-held OAuth lives there (§5.4)
  /\.mec\/engines\/[^/]+\/keys\//, // MEC's own slot keystores (§5.4)
]

/** A read context: filesystem reads, shell `cat`, and the two macOS Keychain reads. */
const READ_CONTEXT =
  /readFile|readFileSync|createReadStream|cat |security find-generic-password|dump-keychain/

/** Same line, or the line immediately before or after — enough to see multi-line calls. */
const ADJACENT = 1

export type SourceFile = { path: string; text: string }

export type Violation = { path: string; line: number; pattern: string }

export function scanSourceForViolations(files: readonly SourceFile[]): Violation[] {
  const violations: Violation[] = []
  for (const file of files) {
    const lines = file.text.split('\n')
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index] ?? ''
      for (const pattern of FORBIDDEN_PATH_PATTERNS) {
        if (!pattern.test(line)) continue
        // Patterns carry no `g` flag, so `test` is stateless (contracts convention).
        const nearRead =
          READ_CONTEXT.test(line) ||
          (index > 0 && READ_CONTEXT.test(lines[index - 1] ?? '')) ||
          (index + ADJACENT < lines.length && READ_CONTEXT.test(lines[index + 1] ?? ''))
        if (nearRead) violations.push({ path: file.path, line: index + 1, pattern: pattern.source })
      }
    }
  }
  return violations
}

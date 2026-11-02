import type { CheckCommand } from '@mec/contracts'

const NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/

/** Splits a command into arguments like a shell would for quoting, without running a shell. */
export function splitArgs(command: string): string[] {
  const args: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let started = false
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!
    if (quote) {
      if (ch === quote) quote = null
      else if (ch === '\\' && quote === '"' && i + 1 < command.length) current += command[++i]
      else current += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      started = true
    } else if (ch === '\\' && i + 1 < command.length) {
      current += command[++i]
      started = true
    } else if (/\s/.test(ch)) {
      if (started) args.push(current)
      current = ''
      started = false
    } else {
      current += ch
      started = true
    }
  }
  if (quote) throw new Error(`unclosed ${quote} quote`)
  if (started) args.push(current)
  return args
}

/**
 * Parses "name: command" lines (blank lines ignored). Only the first colon separates the name, so
 * commands may contain colons; arguments with spaces are quoted.
 */
export function parseCommandLines(text: string): { commands: CheckCommand[]; errors: string[] } {
  const commands: CheckCommand[] = []
  const errors: string[] = []
  const lines = text.split('\n')
  for (const [i, raw] of lines.entries()) {
    const line = raw.trim()
    if (!line) continue
    const where = `line ${i + 1}`
    const colon = line.indexOf(':')
    if (colon === -1) {
      errors.push(`${where}: write it as "name: command"`)
      continue
    }
    const name = line.slice(0, colon).trim()
    if (!NAME.test(name)) {
      errors.push(`${where}: "${name}" is not a valid name (lowercase letters, digits, - and _)`)
      continue
    }
    if (commands.some((c) => c.name === name)) {
      errors.push(`${where}: "${name}" is used twice`)
      continue
    }
    let argv: string[]
    try {
      argv = splitArgs(line.slice(colon + 1))
    } catch (e) {
      errors.push(`${where}: ${(e as Error).message}`)
      continue
    }
    if (argv.length === 0) {
      errors.push(`${where}: "${name}" has no command`)
      continue
    }
    commands.push({ name, argv, timeoutSec: 600 })
  }
  return { commands, errors }
}

/** The inverse of parseCommandLines, for editing a stored profile. */
export function formatCommandLines(commands: CheckCommand[]): string {
  const quote = (a: string) => (/^[A-Za-z0-9_./=:@%+,*-]+$/.test(a) ? a : `'${a.replaceAll("'", `'"'"'`)}'`)
  return commands.map((c) => `${c.name}: ${c.argv.map(quote).join(' ')}`).join('\n')
}

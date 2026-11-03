/**
 * `mec doctor` (plan §21.6): a plain-text diagnostics bundle safe to paste into a bug report.
 *
 * Redaction happens before the report exists: entries whose name looks like a secret are
 * skipped outright, the environment allowlist omits everything else, an allowlisted value that
 * itself looks like a credential is masked, and a health snapshot is only embedded verbatim
 * when it contains no secret-looking substring. No code path here may put a credential string
 * into the returned text.
 */
import { execFile } from 'node:child_process'
import { isSecretEnvName, matchesSecret } from '@mec/contracts'

export type DoctorIo = {
  env?: Record<string, string | undefined>
  run?: (cmd: string, args: string[]) => Promise<{ stdout: string } | null>
  /** Raw health-snapshot JSON; embedded only when it passes the redaction check. */
  snapshotText?: string | null
}

const ENGINES = ['claude', 'codex', 'opencode'] as const

const ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USER',
  'LANG',
  'LC_ALL',
  'TERM',
  'TMPDIR',
  'SHELL',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
] as const

export const defaultVersionRunner: (cmd: string, args: string[]) => Promise<{ stdout: string } | null> = (
  cmd,
  args,
) =>
  new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8' }, (error, stdout) => {
      resolve(error === null ? { stdout: stdout.trim() } : null)
    })
  })

export async function buildDoctorReport(io: DoctorIo = {}): Promise<string> {
  const run = io.run ?? defaultVersionRunner
  const env = io.env ?? process.env
  const lines: string[] = [`mec doctor report ${new Date().toISOString()}`]

  for (const engine of ENGINES) {
    const result = await run(engine, ['--version'])
    const firstLine = result?.stdout.split('\n')[0]?.trim() ?? ''
    lines.push(result ? `engine ${engine}: ${firstLine}` : `engine ${engine}: not installed`)
  }

  for (const name of ENV_ALLOWLIST) {
    if (isSecretEnvName(name)) continue
    const value = env[name]
    if (value === undefined) continue
    lines.push(`env ${name}=${matchesSecret(value) ? '[redacted]' : value}`)
  }

  const snapshotText = io.snapshotText
  if (typeof snapshotText === 'string' && snapshotText !== '') {
    lines.push(
      matchesSecret(snapshotText) ? 'snapshot: present (redacted)' : `snapshot: present ${snapshotText}`,
    )
  }

  return lines.join('\n')
}

import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'

const Env = z.object({
  MEC_CONTROL_URL: z.url(),
  MEC_RUNNER_ID: z.string().min(1),
  MEC_RUNNER_TOKEN: z.string().min(10),
  MEC_HOME: z.string().default(path.join(os.homedir(), 'mec')),
  MEC_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(16).default(2),
  MEC_HEARTBEAT_MS: z.coerce.number().int().min(500).default(10_000),
  MEC_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  MEC_GIT_TOKEN: z.string().optional(),
  MEC_GIT_AUTHOR_NAME: z.string().default('Mubit Engineering Control'),
  MEC_GIT_AUTHOR_EMAIL: z.string().default('mec@mubit.ai'),
  MEC_PUSH_BRANCHES: z.enum(['true', 'false']).optional(),
})

export interface RunnerConfig {
  controlUrl: string
  runnerId: string
  token: string
  home: string
  maxAttempts: number
  heartbeatMs: number
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  git?: { token: string | null; authorName: string; authorEmail: string; push: boolean }
}

export const DEFAULT_CONFIG_FILE = path.join(os.homedir(), '.config', 'mec', 'runner.env')

export class RunnerConfigError extends Error {}

/** KEY=VALUE lines from a runner.env file; variables already set in `env` win. */
export function withEnvFile(env: NodeJS.ProcessEnv, text: string): NodeJS.ProcessEnv {
  const merged = { ...env }
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line)
    if (!m || merged[m[1]!] !== undefined) continue
    merged[m[1]!] = m[2]!.trim().replace(/^(['"])(.*)\1$/, '$2')
  }
  return merged
}

export function loadRunnerConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  const parsed = Env.safeParse(env)
  if (!parsed.success) {
    const vars = [...new Set(parsed.error.issues.map((i) => String(i.path[0])))]
    const enrolment = ['MEC_CONTROL_URL', 'MEC_RUNNER_ID', 'MEC_RUNNER_TOKEN']
    const hint = vars.some((v) => enrolment.includes(v) && env[v] === undefined)
      ? 'This runner is not enrolled yet. Create an invitation on the Fleet page and run the enrol command it shows.'
      : 'Check these settings in the runner.env file or the environment.'
    throw new RunnerConfigError(`Missing or invalid settings: ${vars.join(', ')}.\n${hint}`)
  }
  const e = parsed.data
  return {
    controlUrl: e.MEC_CONTROL_URL.replace(/\/+$/, ''),
    runnerId: e.MEC_RUNNER_ID,
    token: e.MEC_RUNNER_TOKEN,
    home: e.MEC_HOME,
    maxAttempts: e.MEC_MAX_ATTEMPTS,
    heartbeatMs: e.MEC_HEARTBEAT_MS,
    logLevel: e.MEC_LOG_LEVEL,
    git: {
      token: e.MEC_GIT_TOKEN || null,
      authorName: e.MEC_GIT_AUTHOR_NAME,
      authorEmail: e.MEC_GIT_AUTHOR_EMAIL,
      // Attempt branches are pushed for review visibility once a token is configured.
      push: e.MEC_PUSH_BRANCHES ? e.MEC_PUSH_BRANCHES === 'true' : Boolean(e.MEC_GIT_TOKEN),
    },
  }
}

export const RUNNER_VERSION = '0.1.0'

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void
  info(msg: string, data?: Record<string, unknown>): void
  warn(msg: string, data?: Record<string, unknown>): void
  error(msg: string, data?: Record<string, unknown>): void
}

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const

export function createLogger(level: keyof typeof LEVELS = 'info'): Logger {
  const at = LEVELS[level]
  const log = (l: keyof typeof LEVELS) => (msg: string, data?: Record<string, unknown>) => {
    if (LEVELS[l] < at) return
    process.stdout.write(`${JSON.stringify({ level: l, time: new Date().toISOString(), msg, ...data })}\n`)
  }
  return { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') }
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} }

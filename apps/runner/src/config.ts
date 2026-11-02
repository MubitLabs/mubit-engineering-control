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
})

export interface RunnerConfig {
  controlUrl: string
  runnerId: string
  token: string
  home: string
  maxAttempts: number
  heartbeatMs: number
  logLevel: 'debug' | 'info' | 'warn' | 'error'
}

export function loadRunnerConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  const e = Env.parse(env)
  return {
    controlUrl: e.MEC_CONTROL_URL.replace(/\/+$/, ''),
    runnerId: e.MEC_RUNNER_ID,
    token: e.MEC_RUNNER_TOKEN,
    home: e.MEC_HOME,
    maxAttempts: e.MEC_MAX_ATTEMPTS,
    heartbeatMs: e.MEC_HEARTBEAT_MS,
    logLevel: e.MEC_LOG_LEVEL,
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

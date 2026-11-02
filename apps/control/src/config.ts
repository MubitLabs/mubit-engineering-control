import { z } from 'zod'

const bool = z.enum(['true', 'false']).transform((v) => v === 'true')

const Env = z.object({
  DATABASE_URL: z.string().min(1),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().default(4100),
  PUBLIC_URL: z.url().default('http://127.0.0.1:4100'),
  AUTH_MODE: z.enum(['github', 'dev']).default('github'),
  GITHUB_CLIENT_ID: z.string().default(''),
  GITHUB_CLIENT_SECRET: z.string().default(''),
  GITHUB_ORG: z.string().default('MubitLabs'),
  MEC_ADMIN_LOGINS: z.string().default(''),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(336),
  MIGRATE_ON_START: bool.default(true),
  ALLOW_FILE_REPOS: bool.default(false),
  ARTIFACTS_DIR: z.string().default('/var/lib/mec/artifacts'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
})

export interface Config {
  databaseUrl: string
  host: string
  port: number
  publicUrl: string
  authMode: 'github' | 'dev'
  github: { clientId: string; clientSecret: string; org: string }
  adminLogins: string[]
  sessionTtlHours: number
  migrateOnStart: boolean
  allowFileRepos: boolean
  artifactsDir: string
  logLevel: string
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const e = Env.parse(env)
  const config: Config = {
    databaseUrl: e.DATABASE_URL,
    host: e.HOST,
    port: e.PORT,
    publicUrl: e.PUBLIC_URL.replace(/\/+$/, ''),
    authMode: e.AUTH_MODE,
    github: { clientId: e.GITHUB_CLIENT_ID, clientSecret: e.GITHUB_CLIENT_SECRET, org: e.GITHUB_ORG },
    adminLogins: e.MEC_ADMIN_LOGINS.split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    sessionTtlHours: e.SESSION_TTL_HOURS,
    migrateOnStart: e.MIGRATE_ON_START,
    allowFileRepos: e.ALLOW_FILE_REPOS,
    artifactsDir: e.ARTIFACTS_DIR,
    logLevel: e.LOG_LEVEL,
  }
  assertSafe(config)
  return config
}

/** Refuses configurations that would expose an unauthenticated login. */
export function assertSafe(config: Config): void {
  if (config.authMode === 'dev') {
    if (!LOOPBACK.has(config.host)) {
      throw new Error('AUTH_MODE=dev is only allowed when HOST is a loopback address')
    }
    if (!LOOPBACK.has(new URL(config.publicUrl).hostname)) {
      throw new Error('AUTH_MODE=dev is only allowed when PUBLIC_URL is a loopback address')
    }
  }
  if (config.authMode === 'github' && (!config.github.clientId || !config.github.clientSecret)) {
    throw new Error('AUTH_MODE=github needs GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET')
  }
}

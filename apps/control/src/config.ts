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
  /** Logins that may sign in when org membership cannot be confirmed (e.g. the org restricts OAuth apps). */
  MEC_ALLOWED_LOGINS: z.string().default(''),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(336),
  MIGRATE_ON_START: bool.default(true),
  ALLOW_FILE_REPOS: bool.default(false),
  ARTIFACTS_DIR: z.string().default('/var/lib/mec/artifacts'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  MEC_LIMIT_GLOBAL: z.coerce.number().int().min(0).default(6),
  MEC_LIMIT_PER_EMPLOYEE: z.coerce.number().int().min(0).default(2),
  MEC_LIMIT_PER_DELIVERY: z.coerce.number().int().min(0).default(3),
  MEC_LIMIT_PER_PROFILE: z.coerce.number().int().min(0).default(1),
  MEC_LEASE_TTL_MS: z.coerce.number().int().min(1000).default(60_000),
  MEC_SCHEDULER_TICK_MS: z.coerce.number().int().min(50).default(1_000),
  MEC_RECONCILE_TICK_MS: z.coerce.number().int().min(50).default(5_000),
  MEC_STARTUP_GRACE_MS: z.coerce.number().int().min(0).default(30_000),
  MEC_DEFAULT_AGENT: z.enum(['fake', 'claude-code']).default('fake'),
  /** Fine-grained token for pull requests on delivery repositories (a GitHub App replaces it later). */
  GITHUB_TOKEN: z.string().default(''),
})

export interface Config {
  databaseUrl: string
  host: string
  port: number
  publicUrl: string
  authMode: 'github' | 'dev'
  github: { clientId: string; clientSecret: string; org: string; token: string }
  adminLogins: string[]
  allowedLogins: string[]
  sessionTtlHours: number
  migrateOnStart: boolean
  allowFileRepos: boolean
  artifactsDir: string
  logLevel: string
  scheduling: {
    limits: { global: number; perEmployee: number; perDelivery: number; perProfile: number }
    leaseTtlMs: number
    tickMs: number
    reconcileTickMs: number
    /** After a control restart, leases are not expired until runners had time to reconnect. */
    startupGraceMs: number
    defaultAgent: 'fake' | 'claude-code'
  }
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
    github: {
      clientId: e.GITHUB_CLIENT_ID,
      clientSecret: e.GITHUB_CLIENT_SECRET,
      org: e.GITHUB_ORG,
      token: e.GITHUB_TOKEN,
    },
    adminLogins: logins(e.MEC_ADMIN_LOGINS),
    allowedLogins: logins(e.MEC_ALLOWED_LOGINS),
    sessionTtlHours: e.SESSION_TTL_HOURS,
    migrateOnStart: e.MIGRATE_ON_START,
    allowFileRepos: e.ALLOW_FILE_REPOS,
    artifactsDir: e.ARTIFACTS_DIR,
    logLevel: e.LOG_LEVEL,
    scheduling: {
      limits: {
        global: e.MEC_LIMIT_GLOBAL,
        perEmployee: e.MEC_LIMIT_PER_EMPLOYEE,
        perDelivery: e.MEC_LIMIT_PER_DELIVERY,
        perProfile: e.MEC_LIMIT_PER_PROFILE,
      },
      leaseTtlMs: e.MEC_LEASE_TTL_MS,
      tickMs: e.MEC_SCHEDULER_TICK_MS,
      reconcileTickMs: e.MEC_RECONCILE_TICK_MS,
      startupGraceMs: e.MEC_STARTUP_GRACE_MS,
      defaultAgent: e.MEC_DEFAULT_AGENT,
    },
  }
  assertSafe(config)
  return config
}

/**
 * Refuses configurations that would expose an unauthenticated login. GitHub mode without client
 * credentials starts with sign-in disabled, so a fresh install is up before the OAuth app exists.
 */
export function assertSafe(config: Config): void {
  if (config.authMode === 'dev') {
    if (!LOOPBACK.has(config.host)) {
      throw new Error('AUTH_MODE=dev is only allowed when HOST is a loopback address')
    }
    if (!LOOPBACK.has(new URL(config.publicUrl).hostname)) {
      throw new Error('AUTH_MODE=dev is only allowed when PUBLIC_URL is a loopback address')
    }
  }
}

function logins(list: string): string[] {
  return list
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

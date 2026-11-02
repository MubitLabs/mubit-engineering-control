import { existsSync } from 'node:fs'
import cookie from '@fastify/cookie'
import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyInstance } from 'fastify'
import type { Config } from './config'
import type { Sql } from './db/sql'
import type { EventBus } from './events/bus'
import { registerApprovals } from './features/approvals/routes'
import type { ApprovalHookMap } from './features/approvals/service'
import { registerAttemptRoutes } from './features/attempts/routes'
import { createGithubOAuth, type GithubOAuth } from './features/auth/github'
import { registerAuth } from './features/auth/routes'
import { registerDeliveries } from './features/deliveries/routes'
import { registerEvents } from './features/events/routes'
import { planApprovalHooks } from './features/plans/service'
import { registerProjects } from './features/projects/routes'
import { registerRunnerGateway } from './features/runners/gateway'
import { RunnerRegistry } from './features/runners/registry'
import { registerRunnerRoutes } from './features/runners/routes'
import { Reconciler } from './features/scheduler/reconciler'
import { registerSchedulerRoutes } from './features/scheduler/routes'
import { Scheduler } from './features/scheduler/scheduler'
import { registerErrorHandler } from './http/errors'
import { CommandDispatcher } from './outbox/dispatcher'
import { WEB_DIST_DIR } from './paths'

export interface AppDeps {
  sql: Sql
  bus: EventBus
  config: Config
  /** Override the GitHub client (tests). Defaults to the real one when configured. */
  github?: GithubOAuth | null
  webDistDir?: string | null
  /** Run the scheduler and reconciler loops (tests drive them by hand when false). */
  background?: boolean
}

export interface Services {
  registry: RunnerRegistry
  dispatcher: CommandDispatcher
  scheduler: Scheduler
  reconciler: Reconciler
}

declare module 'fastify' {
  interface FastifyInstance {
    services: Services
  }
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { sql, bus, config } = deps
  const app = Fastify({
    logger: config.logLevel === 'silent' ? false : { level: config.logLevel },
    trustProxy: '127.0.0.1',
    bodyLimit: 2 * 1024 * 1024,
  })
  registerErrorHandler(app)
  await app.register(cookie)

  const github =
    deps.github !== undefined
      ? deps.github
      : config.authMode === 'github' && config.github.clientId && config.github.clientSecret
        ? createGithubOAuth(config.github.clientId, config.github.clientSecret)
        : null

  const hooks: ApprovalHookMap = { plan: planApprovalHooks }
  const registry = new RunnerRegistry()
  const dispatcher = new CommandDispatcher(sql, registry, app.log)
  const scheduler = new Scheduler(sql, registry, bus, config.scheduling, app.log)
  const reconciler = new Reconciler(sql, config.scheduling, app.log)
  app.decorate('services', { registry, dispatcher, scheduler, reconciler })
  app.addHook('onReady', async () => {
    await dispatcher.start()
    if (deps.background !== false) {
      scheduler.start()
      reconciler.start()
    }
  })
  app.addHook('onClose', async () => {
    scheduler.stop()
    reconciler.stop()
    await dispatcher.stop()
  })

  app.get('/healthz', async () => {
    await sql`select 1`
    return { ok: true }
  })

  registerAuth(app, { sql, config, github })
  registerProjects(app, { sql, config })
  registerDeliveries(app, { sql, hooks })
  registerApprovals(app, { sql, hooks })
  registerEvents(app, { sql, bus })
  registerRunnerRoutes(app, { sql, config, registry })
  registerAttemptRoutes(app, { sql, registry, config })
  registerSchedulerRoutes(app, { sql, registry, config })
  await registerRunnerGateway(app, { sql, registry, dispatcher, leaseTtlMs: config.scheduling.leaseTtlMs })

  const webDir = deps.webDistDir === undefined ? WEB_DIST_DIR : deps.webDistDir
  if (webDir && existsSync(webDir)) {
    await app.register(fastifyStatic, { root: webDir, wildcard: false })
    // Client-side routes fall back to the SPA shell; API and auth paths keep their 404s.
    app.setNotFoundHandler((req, reply) => {
      const path = req.url.split('?')[0] ?? ''
      if (req.method === 'GET' && !/^\/(api|auth|runner)\//.test(path) && path !== '/healthz') {
        return reply.sendFile('index.html')
      }
      return reply.status(404).send({ error: 'not_found', message: 'Not found', details: null })
    })
  }

  return app
}

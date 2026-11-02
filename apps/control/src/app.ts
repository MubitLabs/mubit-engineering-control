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
}

export interface Services {
  registry: RunnerRegistry
  dispatcher: CommandDispatcher
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
  app.decorate('services', { registry, dispatcher })
  app.addHook('onReady', () => dispatcher.start())
  app.addHook('onClose', () => dispatcher.stop())

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
  registerAttemptRoutes(app, { sql, registry })
  await registerRunnerGateway(app, { sql, registry, dispatcher })

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

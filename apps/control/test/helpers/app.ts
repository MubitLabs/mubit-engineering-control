import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { buildApp } from '../../src/app'
import type { Config } from '../../src/config'
import { EventBus } from '../../src/events/bus'
import type { GithubOAuth } from '../../src/features/auth/github'
import { createTestDb, type TestDb } from './db'

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    databaseUrl: '',
    host: '127.0.0.1',
    port: 0,
    publicUrl: 'http://127.0.0.1:4100',
    authMode: 'dev',
    github: { clientId: '', clientSecret: '', org: 'MubitLabs' },
    adminLogins: ['admin'],
    sessionTtlHours: 24,
    migrateOnStart: false,
    allowFileRepos: true,
    artifactsDir: '/tmp/mec-test-artifacts',
    logLevel: 'silent',
    ...overrides,
  }
}

export interface Client {
  cookie: string
  get(url: string): Promise<LightMyRequestResponse>
  post(url: string, body?: unknown): Promise<LightMyRequestResponse>
  patch(url: string, body?: unknown): Promise<LightMyRequestResponse>
}

export interface TestApp {
  app: FastifyInstance
  db: TestDb
  bus: EventBus
  /** Signs in through the dev login and returns a client carrying the session cookie. */
  login(login: string): Promise<Client>
  anonymous(): Client
  close(): Promise<void>
}

export async function createTestApp(
  opts: { github?: GithubOAuth; config?: Partial<Config> } = {},
): Promise<TestApp> {
  const db = await createTestDb()
  const bus = new EventBus(db.sql)
  await bus.start()
  const config = testConfig({ databaseUrl: db.url, authMode: opts.github ? 'github' : 'dev', ...opts.config })
  const app = await buildApp({ sql: db.sql, bus, config, github: opts.github ?? null, webDistDir: null })
  await app.ready()

  const client = (cookie: string): Client => {
    const headers = cookie ? { cookie } : {}
    return {
      cookie,
      get: (url) => app.inject({ method: 'GET', url, headers }),
      post: (url, body) => app.inject({ method: 'POST', url, headers, payload: (body ?? {}) as object }),
      patch: (url, body) => app.inject({ method: 'PATCH', url, headers, payload: (body ?? {}) as object }),
    }
  }

  return {
    app,
    db,
    bus,
    async login(login) {
      const res = await app.inject({ method: 'POST', url: '/auth/dev/login', payload: { login } })
      if (res.statusCode !== 200) throw new Error(`login failed: ${res.body}`)
      const set = res.cookies.find((c) => c.name === 'mec_session')
      return client(`mec_session=${set!.value}`)
    },
    anonymous: () => client(''),
    async close() {
      await app.close()
      await bus.stop()
      await db.drop()
    },
  }
}

/** A project with an owner (admin), a member and a viewer, plus one repository with two checks. */
export async function seedProject(t: TestApp) {
  const admin = await t.login('admin')
  const member = await t.login('mia')
  const viewer = await t.login('vic')
  const project = (await admin.post('/api/projects', { slug: 'core', name: 'Core' })).json().project
  await admin.post(`/api/projects/${project.id}/members`, { login: 'mia', role: 'member' })
  await admin.post(`/api/projects/${project.id}/members`, { login: 'vic', role: 'viewer' })
  const repo = (
    await admin.post(`/api/projects/${project.id}/repositories`, {
      name: 'sandbox',
      cloneUrl: 'https://github.com/MubitLabs/mec-sandbox.git',
      validationProfile: {
        checks: [
          { name: 'test', argv: ['pnpm', 'test'] },
          { name: 'lint', argv: ['pnpm', 'lint'] },
        ],
      },
    })
  ).json().repository
  return { admin, member, viewer, project, repo }
}

export const sampleTasks = [
  {
    key: 'T1',
    title: 'Contract',
    objective: 'Define the API contract',
    acceptanceChecks: ['test'],
    requirementIds: ['R1'],
  },
  {
    key: 'T2',
    title: 'Server',
    objective: 'Implement the endpoint',
    acceptanceChecks: ['test', 'lint'],
    requirementIds: ['R1'],
    dependsOn: ['T1'],
    ownedPaths: ['src/server'],
  },
  {
    key: 'T3',
    title: 'Client',
    objective: 'Call the endpoint',
    acceptanceChecks: ['test'],
    requirementIds: ['R2'],
    dependsOn: ['T1'],
    basePolicy: 'contract',
    ownedPaths: ['src/client'],
  },
]

export const sampleRequirements = [
  { id: 'R1', text: 'Expose GET /audit' },
  { id: 'R2', text: 'Show audit records in the console' },
]

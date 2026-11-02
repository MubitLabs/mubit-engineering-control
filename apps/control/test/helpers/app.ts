import { createFixtureRepo } from '@mec/testkit'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { buildApp } from '../../src/app'
import type { Config } from '../../src/config'
import { EventBus } from '../../src/events/bus'
import type { GithubOAuth } from '../../src/features/auth/github'
import type { GitHubApi } from '../../src/features/integration/github'
import { createTestDb, type TestDb } from './db'

export type ConfigOverrides = Omit<Partial<Config>, 'scheduling'> & {
  scheduling?: Partial<Config['scheduling']>
}

export function testConfig(overrides: ConfigOverrides = {}): Config {
  const { scheduling, ...rest } = overrides
  return {
    databaseUrl: '',
    host: '127.0.0.1',
    port: 0,
    publicUrl: 'http://127.0.0.1:4100',
    authMode: 'dev',
    github: { clientId: '', clientSecret: '', org: 'MubitLabs', token: '' },
    adminLogins: ['admin'],
    sessionTtlHours: 24,
    migrateOnStart: false,
    allowFileRepos: true,
    artifactsDir: '/tmp/mec-test-artifacts',
    logLevel: 'silent',
    ...rest,
    scheduling: { ...defaultsScheduling(), ...scheduling },
  }
}

function defaultsScheduling(): Config['scheduling'] {
  return {
    limits: { global: 6, perEmployee: 2, perDelivery: 3, perProfile: 1 },
    leaseTtlMs: 60_000,
    tickMs: 100,
    reconcileTickMs: 100,
    startupGraceMs: 0,
    defaultAgent: 'fake',
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
  opts: { github?: GithubOAuth; config?: ConfigOverrides; background?: boolean; githubApi?: GitHubApi } = {},
): Promise<TestApp> {
  const db = await createTestDb()
  const bus = new EventBus(db.sql)
  await bus.start()
  const config = testConfig({ databaseUrl: db.url, authMode: opts.github ? 'github' : 'dev', ...opts.config })
  const app = await buildApp({
    sql: db.sql,
    bus,
    config,
    github: opts.github ?? null,
    webDistDir: null,
    background: opts.background ?? false,
    githubApi: opts.githubApi ?? null,
  })
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
  const fixture = createFixtureRepo()
  const repo = (
    await admin.post(`/api/projects/${project.id}/repositories`, {
      name: 'sandbox',
      cloneUrl: fixture.url,
      validationProfile: {
        checks: [
          { name: 'test', argv: ['node', 'checks/require-files.mjs'], timeoutSec: 60 },
          { name: 'lint', argv: ['node', '-e', 'process.exit(0)'], timeoutSec: 60 },
        ],
      },
    })
  ).json().repository
  return { admin, member, viewer, project, repo, fixture }
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

/** Creates, submits and approves a delivery; returns its tasks keyed by task key. */
export async function approvedDelivery(
  s: Awaited<ReturnType<typeof seedProject>>,
  tasks: unknown[] = sampleTasks,
  key = `key-${Math.random().toString(36).slice(2)}`,
) {
  const { delivery } = (
    await s.admin.post('/api/deliveries', {
      projectId: s.project.id,
      repositoryId: s.repo.id,
      title: 'Audit log',
      planMarkdown: '# Audit log',
      requirements: sampleRequirements,
      tasks,
      idempotencyKey: key,
    })
  ).json()
  const rev = (await s.admin.get(`/api/deliveries/${delivery.id}`)).json().revisions[0]
  const submit = await s.admin.post(`/api/plans/${rev.id}/submit`, { expectedVersion: rev.version })
  if (submit.statusCode !== 200) throw new Error(`submit failed: ${submit.body}`)
  const approve = await s.admin.post(`/api/plans/${rev.id}/approve`, { expectedVersion: rev.version })
  if (approve.statusCode !== 200) throw new Error(`approve failed: ${approve.body}`)
  const detail = (await s.admin.get(`/api/deliveries/${delivery.id}`)).json()
  const byKey = Object.fromEntries(detail.tasks.map((x: { key: string }) => [x.key, x])) as Record<
    string,
    { id: string; key: string; state: string }
  >
  return { delivery, tasks: byKey }
}

/** Invites and enrols a runner through the public API. */
export async function enrolRunner(admin: Client, app: FastifyInstance, name = 'runner-1') {
  const invite = (await admin.post('/api/runners/invites', { label: name })).json()
  const res = await app.inject({
    method: 'POST',
    url: '/api/runners/enrol',
    payload: { inviteToken: invite.token, name, hostname: 'test', os: 'linux', arch: 'x64' },
  })
  if (res.statusCode !== 201) throw new Error(`enrol failed: ${res.body}`)
  return res.json() as { runnerId: string; token: string }
}

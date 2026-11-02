import { AddMember, CreateProject, CreateRepository, UpdateRepository } from '@mec/contracts'
import type { FastifyInstance } from 'fastify'
import type { Config } from '../../config'
import { isUniqueViolation, type Sql } from '../../db/sql'
import { appendEvent, projectStream } from '../../events/append'
import { authorize, requireActor } from '../../http/actor'
import { badRequest, conflict, forbidden, notFound, parse } from '../../http/errors'
import { audit } from '../audit'

export interface ProjectRow {
  id: string
  slug: string
  name: string
  createdAt: Date
  pausedAt: Date | null
}

export function registerProjects(app: FastifyInstance, deps: { sql: Sql; config: Config }) {
  const { sql, config } = deps

  app.get('/api/projects', async (req) => {
    const actor = await requireActor(sql, req)
    const projects = actor.isAdmin
      ? await sql<ProjectRow[]>`select id, slug, name, created_at, paused_at from projects order by name`
      : await sql<ProjectRow[]>`
          select p.id, p.slug, p.name, p.created_at, p.paused_at
          from projects p join memberships m on m.project_id = p.id and m.user_id = ${actor.userId}
          order by p.name
        `
    return { projects: projects.map((p) => ({ ...p, role: actor.projectRoles[p.id] ?? null })) }
  })

  app.post('/api/projects', async (req, reply) => {
    const actor = await requireActor(sql, req)
    if (!actor.isAdmin) throw forbidden('Only admins can create projects')
    const body = parse(CreateProject, req.body)
    try {
      const project = await sql.begin(async (tx) => {
        const [p] = await tx<ProjectRow[]>`
          insert into projects (slug, name, created_by) values (${body.slug}, ${body.name}, ${actor.userId})
          returning id, slug, name, created_at, paused_at
        `
        await tx`insert into memberships (project_id, user_id, role) values (${p!.id}, ${actor.userId}, 'owner')`
        await appendEvent(tx, {
          stream: projectStream(p!.id),
          type: 'project.created',
          projectId: p!.id,
          actor: { kind: 'user', id: actor.userId },
          payload: { slug: p!.slug, name: p!.name },
        })
        await audit(tx, actor.userId, 'project.create', 'project', p!.id, p!.id, { slug: body.slug })
        return p!
      })
      return reply.status(201).send({ project })
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('slug_taken', `Project slug '${body.slug}' is taken`)
      throw e
    }
  })

  app.get<{ Params: { projectId: string } }>('/api/projects/:projectId', async (req) => {
    const actor = await requireActor(sql, req)
    const project = await loadProject(sql, req.params.projectId)
    authorize(actor, 'observe', { kind: 'project', projectId: project.id })
    const members = await sql`
      select u.id, u.login, u.name, u.avatar_url, m.role
      from memberships m join users u on u.id = m.user_id
      where m.project_id = ${project.id} order by u.login
    `
    const repositories = await sql`
      select id, name, clone_url, default_branch, validation_profile, created_at
      from repositories where project_id = ${project.id} order by name
    `
    return { project, role: actor.projectRoles[project.id] ?? null, members, repositories }
  })

  app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/members', async (req, reply) => {
    const actor = await requireActor(sql, req)
    const project = await loadProject(sql, req.params.projectId)
    authorize(actor, 'manage_project', { kind: 'project', projectId: project.id })
    const body = parse(AddMember, req.body)
    const member = await sql.begin(async (tx) => {
      // A placeholder user is matched by login on their first GitHub sign-in.
      const [user] = await tx<{ id: string; login: string }[]>`
        insert into users (login) values (${body.login})
        on conflict (lower(login)) do update set login = users.login
        returning id, login
      `
      await tx`
        insert into memberships (project_id, user_id, role) values (${project.id}, ${user!.id}, ${body.role})
        on conflict (project_id, user_id) do update set role = excluded.role
      `
      await appendEvent(tx, {
        stream: projectStream(project.id),
        type: 'project.member_set',
        projectId: project.id,
        actor: { kind: 'user', id: actor.userId },
        payload: { login: user!.login, role: body.role },
      })
      await audit(tx, actor.userId, 'project.member_set', 'project', project.id, project.id, body)
      return { id: user!.id, login: user!.login, role: body.role }
    })
    return reply.status(201).send({ member })
  })

  app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/repositories', async (req, reply) => {
    const actor = await requireActor(sql, req)
    const project = await loadProject(sql, req.params.projectId)
    authorize(actor, 'manage_project', { kind: 'project', projectId: project.id })
    const body = parse(CreateRepository, req.body)
    assertCloneUrl(body.cloneUrl, config.allowFileRepos)
    try {
      const repository = await sql.begin(async (tx) => {
        const [r] = await tx`
          insert into repositories (project_id, name, clone_url, default_branch, validation_profile)
          values (${project.id}, ${body.name}, ${body.cloneUrl}, ${body.defaultBranch},
                  ${tx.json(body.validationProfile as never)})
          returning id, name, clone_url, default_branch, validation_profile, created_at
        `
        await appendEvent(tx, {
          stream: projectStream(project.id),
          type: 'repository.registered',
          projectId: project.id,
          actor: { kind: 'user', id: actor.userId },
          payload: { name: body.name, cloneUrl: body.cloneUrl },
        })
        await audit(tx, actor.userId, 'repository.create', 'repository', r!.id, project.id, {
          name: body.name,
        })
        return r!
      })
      return reply.status(201).send({ repository })
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('name_taken', `Repository '${body.name}' already exists`)
      throw e
    }
  })

  /** Changes apply to attempts started afterwards; running attempts keep the profile they started with. */
  app.patch<{ Params: { projectId: string; repositoryId: string } }>(
    '/api/projects/:projectId/repositories/:repositoryId',
    async (req) => {
      const actor = await requireActor(sql, req)
      const project = await loadProject(sql, req.params.projectId)
      authorize(actor, 'manage_project', { kind: 'project', projectId: project.id })
      const body = parse(UpdateRepository, req.body)
      if (!/^[0-9a-f-]{36}$/i.test(req.params.repositoryId)) throw notFound('Repository')
      const set: Record<string, unknown> = {}
      if (body.defaultBranch) set.defaultBranch = body.defaultBranch
      if (body.validationProfile) set.validationProfile = sql.json(body.validationProfile as never)
      const repository = await sql.begin(async (tx) => {
        const [r] = Object.keys(set).length
          ? await tx`
              update repositories set ${tx(set)}
              where id = ${req.params.repositoryId} and project_id = ${project.id}
              returning id, name, clone_url, default_branch, validation_profile, created_at
            `
          : await tx`
              select id, name, clone_url, default_branch, validation_profile, created_at from repositories
              where id = ${req.params.repositoryId} and project_id = ${project.id}
            `
        if (!r) throw notFound('Repository')
        await appendEvent(tx, {
          stream: projectStream(project.id),
          type: 'repository.updated',
          projectId: project.id,
          actor: { kind: 'user', id: actor.userId },
          payload: { name: r.name },
        })
        await audit(tx, actor.userId, 'repository.update', 'repository', r.id, project.id, body)
        return r
      })
      return { repository }
    },
  )
}

export async function loadProject(sql: Sql, projectId: string): Promise<ProjectRow> {
  if (!/^[0-9a-f-]{36}$/i.test(projectId)) throw notFound('Project')
  const [project] = await sql<ProjectRow[]>`
    select id, slug, name, created_at, paused_at from projects where id = ${projectId}
  `
  if (!project) throw notFound('Project')
  return project
}

/** Repository URLs are data handed to git as an argument; only plain https remotes are accepted. */
export function assertCloneUrl(url: string, allowFile: boolean): void {
  if (allowFile && url.startsWith('file:///')) return
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw badRequest('cloneUrl must be an https URL')
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw badRequest('cloneUrl must be a plain https URL without credentials')
  }
}

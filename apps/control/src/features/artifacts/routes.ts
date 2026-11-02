import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Config } from '../../config'
import type { Sql } from '../../db/sql'
import { authorize, requireActor } from '../../http/actor'
import { HttpError, notFound, parse } from '../../http/errors'
import { authenticateRunner } from '../runners/gateway'

const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024

const UploadHeaders = z.object({
  'x-mec-attempt-id': z.uuid(),
  'x-mec-kind': z.enum(['check_log', 'patch', 'log', 'other']),
  'x-mec-name': z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/),
})

/**
 * Artifacts (PDF §4): large logs and patches stay out of database rows. Runners upload with their
 * device token for attempts they own; people download by id only — never by filesystem path.
 */
export function registerArtifacts(app: FastifyInstance, deps: { sql: Sql; config: Config }) {
  const { sql, config } = deps

  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: MAX_ARTIFACT_BYTES },
    (_req, body, done) => done(null, body),
  )

  app.post('/runner/artifacts', { bodyLimit: MAX_ARTIFACT_BYTES }, async (req, reply) => {
    const runnerId = await authenticateRunner(sql, req)
    if (!runnerId) throw new HttpError(401, 'unauthorized', 'Invalid runner token')
    const h = parse(UploadHeaders, req.headers)
    const body = req.body
    if (!Buffer.isBuffer(body)) throw new HttpError(415, 'unsupported', 'Send application/octet-stream')
    const [attempt] = await sql<{ id: string; projectId: string; runnerId: string | null }[]>`
      select id, project_id, runner_id from attempts where id = ${h['x-mec-attempt-id']}
    `
    if (!attempt || attempt.runnerId !== runnerId)
      throw new HttpError(403, 'forbidden', 'Attempt is not assigned to this runner')

    const id = randomUUID()
    const dir = path.join(config.artifactsDir, attempt.projectId, attempt.id)
    await mkdir(dir, { recursive: true })
    const file = path.join(dir, id)
    await writeFile(file, body)
    await sql`
      insert into artifacts (id, project_id, attempt_id, kind, name, size_bytes, sha256, storage_path, created_by_runner)
      values (${id}, ${attempt.projectId}, ${attempt.id}, ${h['x-mec-kind']}, ${h['x-mec-name']}, ${body.length},
              ${createHash('sha256').update(body).digest('hex')}, ${file}, ${runnerId})
    `
    return reply.status(201).send({ artifactId: id })
  })

  app.get<{ Params: { artifactId: string } }>('/api/artifacts/:artifactId', async (req, reply) => {
    const actor = await requireActor(sql, req)
    if (!/^[0-9a-f-]{36}$/i.test(req.params.artifactId)) throw notFound('Artifact')
    const [artifact] = await sql<
      { projectId: string; name: string; contentType: string; storagePath: string }[]
    >`
      select project_id, name, content_type, storage_path from artifacts where id = ${req.params.artifactId}
    `
    if (!artifact) throw notFound('Artifact')
    authorize(actor, 'observe', { kind: 'project', projectId: artifact.projectId })
    reply
      .header('content-type', artifact.contentType)
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'")
      .header('content-disposition', `inline; filename="${artifact.name}"`)
    return reply.send(createReadStream(artifact.storagePath))
  })
}

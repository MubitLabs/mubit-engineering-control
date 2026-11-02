import type { FastifyInstance } from 'fastify'
import { ZodError, type z } from 'zod'

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new HttpError(400, 'bad_request', message, details)
export const unauthorized = () => new HttpError(401, 'unauthorized', 'Sign in required')
export const forbidden = (message = 'Not allowed') => new HttpError(403, 'forbidden', message)
export const notFound = (what = 'Resource') => new HttpError(404, 'not_found', `${what} not found`)
export const conflict = (code: string, message: string, details?: unknown) =>
  new HttpError(409, code, message, details)

export function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value)
  if (!result.success) {
    throw badRequest(
      'Invalid request',
      result.error.issues.map((i) => ({ path: i.path, message: i.message })),
    )
  }
  return result.data
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof HttpError) {
      return reply
        .status(error.status)
        .send({ error: error.code, message: error.message, details: error.details ?? null })
    }
    if (error instanceof ZodError) {
      return reply
        .status(400)
        .send({ error: 'bad_request', message: 'Invalid request', details: error.issues })
    }
    const status = (error as { statusCode?: number }).statusCode
    if (status && status < 500) {
      return reply
        .status(status)
        .send({ error: 'bad_request', message: (error as Error).message, details: null })
    }
    req.log.error({ err: error }, 'unhandled error')
    return reply.status(500).send({ error: 'internal', message: 'Internal error', details: null })
  })
}

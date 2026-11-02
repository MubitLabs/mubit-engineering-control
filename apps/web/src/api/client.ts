export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: unknown,
  ) {
    super(message)
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  const json = text ? JSON.parse(text) : null
  if (!res.ok) {
    throw new ApiError(
      res.status,
      json?.error ?? 'error',
      json?.message ?? res.statusText,
      json?.details ?? null,
    )
  }
  return json as T
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body: unknown = {}) => request<T>('POST', url, body),
  patch: <T>(url: string, body: unknown) => request<T>('PATCH', url, body),
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const details = error.details as { validation?: { errors?: { message: string }[] } } | null
    const validation = details?.validation?.errors?.map((e) => `• ${e.message}`).join('\n')
    return validation ? `${error.message}\n${validation}` : error.message
  }
  return error instanceof Error ? error.message : String(error)
}

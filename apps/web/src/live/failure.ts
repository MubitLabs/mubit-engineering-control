import { HttpError } from '../api'

/** Words for a failure: the server's own reason where it gave one. */
export function failureText(error: unknown): string {
  if (error instanceof HttpError) {
    const reason = error.reason ?? `The server answered ${error.status}.`
    return error.detail === undefined ? reason : `${reason}: ${error.detail}`
  }
  if (error instanceof Error && error.name === 'DecodeError') return error.message
  return 'Could not reach the workbench. Nothing was changed.'
}

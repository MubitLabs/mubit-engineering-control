import { HttpError } from '../api'
import { APPROVAL_REQUIRED, NOT_LINKED } from '../approval'

/** Words for a failure: the server's own reason where it gave one. */
export function failureText(error: unknown): string {
  if (error instanceof HttpError) {
    if (error.reason === APPROVAL_REQUIRED) return NOT_LINKED
    const reason = error.reason ?? `The server answered ${error.status}.`
    return error.detail === undefined ? reason : `${reason}: ${error.detail}`
  }
  if (error instanceof Error && error.name === 'DecodeError') return error.message
  return 'Could not reach the workbench. Nothing was changed.'
}

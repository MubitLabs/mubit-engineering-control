// An engine that refuses the model it was given (0.3.4: Codex on a ChatGPT sign-in, HTTP 400
// model_not_found) is a model refusal, said in words that name the model, not an "api error".
import type { EngineEvent } from '@mec/contracts'
import { describe, expect, it } from 'vitest'
import { modelRefusalOf } from '../src/attempt-runner'

const BODY =
  '{"error":{"message":"The \'gpt-6-luna\' model is not supported when using Codex with a ChatGPT account.","type":"invalid_request_error","param":"model","code":"model_not_found"}}'

const error = (detail: string, raw: unknown = {}): EngineEvent =>
  ({
    type: 'error',
    class: 'unknown',
    detail,
    raw,
    seq: 1,
    at: '2026-11-09T00:00:00.000Z',
    attempt_id: 'a',
    generation: 1,
  }) as EngineEvent

describe('modelRefusalOf', () => {
  it("reads the vendor's own sentence out of a 400 body", () => {
    expect(modelRefusalOf([error(`unexpected status 400 Bad Request: ${BODY}`)])).toBe(
      "The 'gpt-6-luna' model is not supported when using Codex with a ChatGPT account.",
    )
  })

  it('knows the code alone, when the words sit only in the raw event', () => {
    expect(modelRefusalOf([error('turn failed', { codexErrorInfo: 'model_not_found' })])).toBe('turn failed')
  })

  it('an error about anything else is not a model refusal', () => {
    expect(modelRefusalOf([error('stream disconnected before completion')])).toBeUndefined()
    expect(modelRefusalOf([error('You have hit your usage limit')])).toBeUndefined()
    expect(modelRefusalOf([])).toBeUndefined()
  })
})

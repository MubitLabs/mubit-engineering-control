import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clearStopMarker,
  readStopMarker,
  STOP_MARKER_FILENAME,
  stopMarkerPath,
  writeStopMarker,
} from '../src/stop-marker'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mec-stop-marker-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('stop marker', () => {
  it('stopMarkerPath joins the marker filename onto the directory', () => {
    expect(stopMarkerPath(dir)).toBe(join(dir, STOP_MARKER_FILENAME))
  })

  it('writing then reading reports the marker present with its reason', () => {
    writeStopMarker(dir, 'user pressed stop')
    const marker = readStopMarker(dir)
    expect(marker.present).toBe(true)
    expect(marker.reason).toBe('user pressed stop')
  })

  it('writing without a reason still leaves a present marker', () => {
    writeStopMarker(dir)
    expect(readStopMarker(dir).present).toBe(true)
  })

  it('reading an empty directory reports no marker', () => {
    expect(readStopMarker(dir).present).toBe(false)
  })

  it('clearing removes the marker', () => {
    writeStopMarker(dir, 'user pressed stop')
    clearStopMarker(dir)
    expect(readStopMarker(dir).present).toBe(false)
  })

  it('a corrupt marker file is still present, without a reason', () => {
    writeFileSync(stopMarkerPath(dir), 'this is not json')
    const marker = readStopMarker(dir)
    expect(marker.present).toBe(true)
    expect(marker.reason).toBeUndefined()
  })
})

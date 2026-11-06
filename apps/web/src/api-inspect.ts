/**
 * The next shell's reads and owner commands. Every read goes through inspection-decode.ts, so the
 * test harness and the live page share one path from JSON to the screen.
 */

import { api, type ResolveAnswer, type ResolveResult, request, requestResponse } from './api'
import {
  decodeActivityPage,
  decodeArtifact,
  decodeCardEvidence,
  decodeNeedsPage,
  decodeSearchPage,
  decodeSnapshot,
  decodeTaskDetail,
  decodeWorkDetail,
  decodeWorkPage,
} from './inspection-decode'
import type {
  ActivityItem,
  ArtifactPage,
  CardEvidence,
  NeedItem,
  Page,
  SearchHit,
  Snapshot,
  TaskDetail,
  WorkDetail,
  WorkRow,
} from './next/inspection-wire'

/** The most `/api/inspect/*` serves on one page. */
const PAGE_LIMIT = 100

const query = (fields: Record<string, string | null>): string => {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(fields)) if (value !== null) params.set(key, value)
  return params.toString()
}

const command = (path: string): Promise<{ id: string; status: string }> =>
  request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })

const encoded = encodeURIComponent

export const inspectApi = {
  async snapshot(signal?: AbortSignal): Promise<Snapshot> {
    return decodeSnapshot(await request<unknown>('/api/inspect/snapshot', { signal }))
  },

  async work(cursor: string | null, signal?: AbortSignal): Promise<Page<WorkRow>> {
    const path = `/api/inspect/work?${query({ limit: String(PAGE_LIMIT), cursor })}`
    return decodeWorkPage(await request<unknown>(path, { signal }))
  },

  /** Open first, then the recently settled and expired, so they stay visible. */
  async needs(cursor: string | null, signal?: AbortSignal): Promise<Page<NeedItem>> {
    const path = `/api/inspect/needs?${query({ recent: '1', limit: String(PAGE_LIMIT), cursor })}`
    return decodeNeedsPage(await request<unknown>(path, { signal }))
  },

  async workDetail(id: string, signal?: AbortSignal): Promise<WorkDetail> {
    return decodeWorkDetail(await request<unknown>(`/api/inspect/work/${encoded(id)}`, { signal }))
  },

  async taskDetail(id: string, signal?: AbortSignal): Promise<TaskDetail> {
    return decodeTaskDetail(await request<unknown>(`/api/inspect/tasks/${encoded(id)}`, { signal }))
  },

  async search(q: string, signal?: AbortSignal): Promise<Page<SearchHit>> {
    return decodeSearchPage(await request<unknown>(`/api/inspect/search?${query({ q })}`, { signal }))
  },

  async activity(id: string, cursor: string | null, signal?: AbortSignal): Promise<Page<ActivityItem>> {
    const fields = query({ limit: String(PAGE_LIMIT), cursor })
    const path = `/api/inspect/attempts/${encoded(id)}/activity?${fields}`
    return decodeActivityPage(await request<unknown>(path, { signal }))
  },

  async artifact(
    id: string,
    ref: string,
    cursor: string | null,
    signal?: AbortSignal,
  ): Promise<ArtifactPage> {
    const path = `/api/inspect/artifacts?${query({ attemptId: id, ref, cursor })}`
    const response = await requestResponse(path, { signal })
    return decodeArtifact(ref, {
      contentType: response.headers.get('content-type') ?? '',
      body: await response.text(),
      size: response.headers.get('x-mec-artifact-size'),
      next: response.headers.get('x-mec-next-cursor'),
    })
  },

  /** `api.decisionDetail` answers a 404 with its `absent` placeholder; the decoder keeps the mark. */
  async evidence(id: string): Promise<CardEvidence> {
    return decodeCardEvidence(await api.decisionDetail(id))
  },

  resolve(id: string, answer: ResolveAnswer): Promise<ResolveResult> {
    return api.resolve(id, answer)
  },

  async answer(id: string, answer: string): Promise<void> {
    await request(`/api/questions/${encoded(id)}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answer }),
    })
  },

  hold: (id: string) => command(`/api/work/${encoded(id)}/hold`),
  lift: (id: string) => command(`/api/work/${encoded(id)}/lift`),
  stop: (id: string) => command(`/api/work/${encoded(id)}/stop`),
}

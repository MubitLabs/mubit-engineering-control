#!/usr/bin/env node
// The Lighthouse accessibility gate. Not in CI, not in `pnpm check`: `pnpm --dir apps/web test:lighthouse`.
//
//   node scripts/lighthouse.mjs <baseUrl> <#route>...        drive Playwright's chromium, score each route
//   node scripts/lighthouse.mjs --from-report <file>...      judge Lighthouse JSON reports already on disk
//
// Accessibility category only. Every route must score at least THRESHOLD. Any miss, any unreadable
// or incomplete report, and any browser failure exits non-zero. Reports go to $TMPDIR, not the repo.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const THRESHOLD = 95

/** Judges one parsed report. Returns { ok, score, reason }: never throws, never defaults to a pass. */
export function judgeReport(report, threshold = THRESHOLD) {
  const raw = report?.categories?.accessibility?.score
  if (typeof raw !== 'number' || Number.isNaN(raw)) {
    return { ok: false, score: null, reason: 'no accessibility score in the report' }
  }
  const score = Math.round(raw * 100)
  if (score < threshold) return { ok: false, score, reason: `${score} is below ${threshold}` }
  return { ok: true, score, reason: '' }
}

/** Reads a report file and judges it. A missing, empty or malformed file is a failure. */
export function judgeFile(file, threshold = THRESHOLD) {
  let report
  try {
    report = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    return { ok: false, score: null, reason: `unreadable report: ${error.message}` }
  }
  return judgeReport(report, threshold)
}

function print(label, verdict) {
  const mark = verdict.ok ? 'PASS' : 'FAIL'
  console.log(
    `${mark} ${label} accessibility ${verdict.score ?? '-'}${verdict.reason ? ` (${verdict.reason})` : ''}`,
  )
}

async function scoreRoutes(baseUrl, routes) {
  const { chromium } = await import('@playwright/test')
  const { default: lighthouse } = await import('lighthouse')
  const dir = join(process.env.TMPDIR || tmpdir(), `mec-lighthouse-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  const port = 9222 + Math.floor(Math.random() * 500)
  // The bundled chromium follows the macOS system proxy for loopback unless told not to (a102313).
  const browser = await chromium.launch({ args: ['--no-proxy-server', `--remote-debugging-port=${port}`] })
  const verdicts = []
  try {
    for (const [index, route] of routes.entries()) {
      const url = baseUrl + route
      let verdict
      try {
        const result = await lighthouse(url, {
          port,
          output: 'json',
          logLevel: 'error',
          onlyCategories: ['accessibility'],
          disableStorageReset: true,
        })
        const file = join(dir, `route-${index}.json`)
        writeFileSync(file, result?.report ?? '')
        verdict = judgeFile(file)
      } catch (error) {
        verdict = { ok: false, score: null, reason: `lighthouse failed: ${error.message}` }
      }
      print(url, verdict)
      verdicts.push(verdict)
    }
  } finally {
    await browser.close()
  }
  console.log(`reports: ${dir}`)
  return verdicts
}

async function main(argv) {
  let verdicts
  if (argv[0] === '--from-report') {
    const files = argv.slice(1)
    if (files.length === 0) throw new Error('--from-report needs at least one file')
    verdicts = files.map((file) => {
      const verdict = judgeFile(file)
      print(file, verdict)
      return verdict
    })
  } else {
    const [baseUrl, ...routes] = argv
    if (!baseUrl || routes.length === 0) {
      throw new Error('usage: lighthouse.mjs <baseUrl> <#route>... | --from-report <file>...')
    }
    verdicts = await scoreRoutes(baseUrl, routes)
  }
  return verdicts.length > 0 && verdicts.every((verdict) => verdict.ok) ? 0 : 1
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`FAIL ${error.message}`)
      process.exit(1)
    },
  )
}

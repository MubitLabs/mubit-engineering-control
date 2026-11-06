#!/usr/bin/env node
/**
 * Proves a package, not the source tree: boots `bin/mec.js` from the directory it is given, on a
 * scratch HOME and MEC_DATA_DIR, and checks over HTTP what a first run needs. The prompt catalogue
 * must match packages/prompts/defaults part for part, the models table must be the shipped one
 * read from inside the package, the workbench must load, and a login card must start a process
 * through the real pty, with a stand-in `claude` so no engine runs.
 *
 *     node scripts/smoke-package.mjs <package directory>
 *
 * The package needs its native modules: scripts/pack-tarball links them, an install has them.
 * Exits non-zero and names the first thing wrong.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** A new process can take many seconds to start on a busy machine (see bundle-defaults.test.ts). */
const BOOT_MS = 40_000
const REQUEST_MS = 10_000
const LOGIN_MS = 10_000
const STOP_MS = 12_000

const shippedDefaults = fileURLToPath(new URL('../packages/prompts/defaults', import.meta.url))

function waitForAnnounce(child) {
  let output = ''
  return new Promise((resolve, reject) => {
    const read = (chunk) => {
      output += chunk
      const url = /listening on (\S+)/.exec(output)?.[1]
      if (url !== undefined) resolve(url)
    }
    child.stdout.on('data', read)
    child.stderr.on('data', read)
    child.once('exit', (code) => reject(new Error(`the server did not start (exit ${code}): ${output}`)))
    setTimeout(() => reject(new Error(`the server did not start in ${BOOT_MS}ms: ${output}`)), BOOT_MS).unref()
  })
}

async function readJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_MS) })
  if (res.status !== 200) throw new Error(`${url} answered ${res.status}: ${await res.text()}`)
  return res.json()
}

async function checkCatalogue(url) {
  const expected = readdirSync(shippedDefaults, { recursive: true })
    .filter((path) => path.endsWith('.md'))
    .sort()
  const served = (await readJson(`${url}/api/prompts`)).parts.map((part) => part.id).sort()
  const missing = expected.filter((path) => !served.includes(path))
  if (missing.length > 0) {
    throw new Error(`the prompt catalogue serves ${served.length} of ${expected.length} parts: ${missing.join(', ')} missing`)
  }
}

async function checkModels(url, packageDir) {
  const { provenance } = await readJson(`${url}/api/models`)
  const inside = join(packageDir, 'dist', 'prompts-defaults', 'models.yaml')
  if (provenance.path !== inside) {
    throw new Error(`the models table came from ${provenance.path}, not from inside the package`)
  }
  const shipped = createHash('sha256').update(readFileSync(join(shippedDefaults, 'models.yaml'))).digest('hex')
  if (provenance.sha256 !== shipped) throw new Error('the models table differs from the shipped one')
}

async function checkWorkbench(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_MS) })
  const type = res.headers.get('content-type') ?? ''
  if (res.status !== 200 || !type.startsWith('text/html')) {
    throw new Error(`the workbench page answered ${res.status} (${type})`)
  }
}

async function checkLogin(url, marker) {
  const res = await fetch(`${url}/api/slots/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ engine: 'claude', label: 'package-smoke' }),
    signal: AbortSignal.timeout(REQUEST_MS),
  })
  if (res.status !== 200) throw new Error(`a login card did not start (${res.status}): ${await res.text()}`)
  const deadline = Date.now() + LOGIN_MS
  while (!existsSync(marker)) {
    if (Date.now() > deadline) throw new Error('a login card started, but its process never ran')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise((resolve) => child.once('exit', resolve))
  child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), STOP_MS)
  await exited
  clearTimeout(timer)
}

async function smoke(packageDir) {
  const scratch = mkdtempSync(join(tmpdir(), 'mec-package-smoke-'))
  const home = join(scratch, 'home')
  const bin = join(scratch, 'bin')
  const marker = join(scratch, 'login-ran')
  mkdirSync(home)
  mkdirSync(bin)
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\n: > "$MEC_SMOKE_MARKER"\n')
  chmodSync(join(bin, 'claude'), 0o755)
  const child = spawn(process.execPath, [join(packageDir, 'bin', 'mec.js')], {
    cwd: home,
    env: {
      ...process.env,
      HOME: home,
      MEC_DATA_DIR: join(home, '.mec'),
      MEC_FAKE_ENGINE: '1',
      MEC_NO_OPEN: '1',
      MEC_SMOKE_MARKER: marker,
      PATH: `${bin}:${process.env.PATH}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  try {
    const url = await waitForAnnounce(child)
    await checkCatalogue(url)
    await checkModels(url, packageDir)
    await checkWorkbench(url)
    await checkLogin(url, marker)
  } finally {
    await stop(child)
    rmSync(scratch, { recursive: true, force: true })
  }
}

const target = process.argv[2]
if (target === undefined) {
  console.error('usage: node scripts/smoke-package.mjs <package directory>')
  process.exit(2)
}
try {
  await smoke(realpathSync(target))
  console.log(`package smoke passed: ${target}`)
} catch (error) {
  console.error(`package smoke failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

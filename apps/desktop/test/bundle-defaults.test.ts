/**
 * §16 and §21.1: a shipped build carries its prompts. The real entry is bundled by esbuild into
 * throwaway folders shaped like the two layouts that run outside the source tree, and the real
 * launcher boots it on a scratch `MEC_DATA_DIR`. `meta_agent` is what every planner turn runs on,
 * so a layout that finds no defaults has to refuse, never serve an empty catalogue or plan on the
 * short built-in text. Native modules resolve through a link to this repository's own install.
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type BuildOptions, build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = join(appDir, '..', '..')
const shippedDefaults = join(repoRoot, 'packages', 'prompts', 'defaults')

/**
 * A new process took over 12s to get past `_dyld_start` in a full `pnpm check` on macOS, while the
 * whole suite was spawning, so these limits cover that. BOOT_MS is well inside SPAWN_TEST_MS, so
 * a real hang reports what it saw instead of a bare timeout.
 */
const BOOT_MS = 40_000
const SPAWN_TEST_MS = 60_000

const NATIVE: BuildOptions = {
  format: 'esm',
  platform: 'node',
  target: 'node22',
  bundle: true,
  external: ['better-sqlite3', 'node-pty'],
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  logLevel: 'silent',
}

/** The launcher and bundle at `root`, as bin/ beside dist/ with the natives linked. */
async function placeBundle(root: string): Promise<void> {
  mkdirSync(join(root, 'dist'), { recursive: true })
  cpSync(join(appDir, 'bin'), join(root, 'bin'), { recursive: true })
  cpSync(join(appDir, 'package.json'), join(root, 'package.json'))
  symlinkSync(join(appDir, 'node_modules'), join(root, 'node_modules'))
  await build({
    ...NATIVE,
    entryPoints: [join(appDir, 'src', 'serve.ts')],
    outfile: join(root, 'dist/mec.mjs'),
  })
  await build({
    ...NATIVE,
    stdin: { contents: "export { readMetaProtocol } from '@mec/meta'", resolveDir: appDir, loader: 'ts' },
    outfile: join(root, 'dist/planner.mjs'),
  })
}

function plantStranger(root: string): void {
  const dir = join(root, 'roles', 'meta_agent')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'protocol.md'), '# Not the shipped protocol\n')
}

let scratch: string
let tarball: string
let devBundle: string
let bare: string
const children: ChildProcess[] = []

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'mec-bundle-defaults-'))
  // pnpm pack:internal: the tree beside the bundle, at dist/prompts-defaults.
  tarball = join(scratch, 'tarball', 'mec')
  await placeBundle(tarball)
  cpSync(shippedDefaults, join(tarball, 'dist', 'prompts-defaults'), { recursive: true })
  // Folders that happen to sit at the source tree's relative paths must never beat the shipped copy.
  plantStranger(join(tarball, 'defaults'))
  plantStranger(join(scratch, 'tarball', 'prompts', 'defaults'))
  // pnpm build:desktop: the bundle in apps/desktop/dist of a checkout.
  devBundle = join(scratch, 'checkout', 'apps', 'desktop')
  await placeBundle(devBundle)
  cpSync(shippedDefaults, join(scratch, 'checkout', 'packages', 'prompts', 'defaults'), { recursive: true })
  bare = join(scratch, 'bare', 'mec')
  await placeBundle(bare)
}, SPAWN_TEST_MS)

afterAll(() => {
  for (const child of children) child.kill('SIGKILL')
  rmSync(scratch, { recursive: true, force: true })
})

type Booted = { url?: string; code?: number | null; output: string }

/** Boots `bin/mec.js`; settles on the announce line or on the process ending, whichever comes first. */
function boot(root: string): Promise<Booted> {
  const child = spawn(process.execPath, [join(root, 'bin', 'mec.js')], {
    env: {
      ...process.env,
      MEC_DATA_DIR: mkdtempSync(join(scratch, 'data-')),
      MEC_NO_OPEN: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(child)
  let output = ''
  return new Promise((resolve) => {
    const read = (chunk: Buffer): void => {
      output += chunk
      const url = /listening on (\S+)/.exec(output)?.[1]
      if (url !== undefined) resolve({ url, output })
    }
    child.stdout.on('data', read)
    child.stderr.on('data', read)
    child.once('exit', (code) => resolve({ code, output }))
    setTimeout(() => resolve({ output: `no announce after ${BOOT_MS}ms: ${output}` }), BOOT_MS).unref()
  })
}

const readJson = async (url: string): Promise<{ status: number; body: Record<string, unknown> }> => {
  const res = await fetch(url, { signal: AbortSignal.timeout(BOOT_MS) })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

/** The meta agent's protocol as a bundle in `root` reads it: same directory, so the same lookup. */
function plannerText(root: string): string {
  const script = `
    const { readMetaProtocol } = await import(${JSON.stringify(join(root, 'dist/planner.mjs'))})
    process.stdout.write(readMetaProtocol({ promptsRoot: ${JSON.stringify(join(scratch, 'no-user-prompts'))} }))
  `
  return execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

describe.each([
  ['the extracted tarball', () => tarball],
  ['a bundle built in a checkout', () => devBundle],
])('%s loads the shipped defaults', (_name, rootOf) => {
  it(
    'serves the full prompt catalogue and the models table',
    async () => {
      const { url, output } = await boot(rootOf())
      expect(url, output).toBeDefined()
      const prompts = await readJson(`${url}/api/prompts`)
      expect(prompts.status).toBe(200)
      expect(prompts.body.parts).toHaveLength(21)
      expect((await readJson(`${url}/api/prompts/defaults`)).body.parts).toHaveLength(21)
      const models = await readJson(`${url}/api/models`)
      expect(models.status).toBe(200)
      expect(models.body.provenance).toMatchObject({ source: 'default' })
    },
    SPAWN_TEST_MS,
  )

  it(
    'gives the planner its real protocol and planning parts',
    () => {
      const shipped = (part: string): string =>
        readFileSync(join(shippedDefaults, 'roles', 'meta_agent', part), 'utf8').trim()
      expect(plannerText(rootOf())).toBe(`${shipped('protocol.md')}\n\n${shipped('planning.md')}`)
    },
    SPAWN_TEST_MS,
  )
})

describe('a build with no shipped defaults', () => {
  it(
    'refuses to start and names what is missing',
    async () => {
      const { url, code, output } = await boot(bare)
      expect(url, output).toBeUndefined()
      expect(code, output).not.toBe(0)
      expect(output).toContain('prompt defaults')
    },
    SPAWN_TEST_MS,
  )

  it(
    'never hands the planner an empty protocol',
    () => {
      expect(() => plannerText(bare)).toThrow(/prompt defaults/)
    },
    SPAWN_TEST_MS,
  )
})

describe('the tarball script', () => {
  it('ships the tree where the bundle looks for it', () => {
    const script = readFileSync(join(repoRoot, 'scripts', 'pack-tarball.mjs'), 'utf8')
    expect(script).toContain(
      "cpSync(join(root, 'packages/prompts/defaults'), join(staging, 'dist', 'prompts-defaults')",
    )
  })
})

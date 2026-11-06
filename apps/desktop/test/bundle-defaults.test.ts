/**
 * §16 and §21.1: a shipped build carries its prompts. The real entry is bundled by esbuild into
 * throwaway folders shaped like the two layouts that run outside the source tree, and the real
 * launcher boots it on a scratch `MEC_DATA_DIR`. `meta_agent` is what every planner turn runs on,
 * so a layout that finds no defaults has to refuse, never serve an empty catalogue or plan on the
 * short built-in text. Native modules resolve through a link to this repository's own install.
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
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
  mkdirSync(join(tarball, 'dist', 'web'))
  writeFileSync(join(tarball, 'dist', 'web', 'index.html'), '<!doctype html><title>workbench</title>\n')
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
  const script = readFileSync(join(repoRoot, 'scripts', 'pack-tarball.mjs'), 'utf8')

  it('ships the tree where the bundle looks for it', () => {
    expect(script).toContain(
      "cpSync(join(root, 'packages/prompts/defaults'), join(staging, 'dist', 'prompts-defaults')",
    )
  })

  it('smokes the staged package outside the checkout and refuses to tar a failure', () => {
    // Inside the checkout the bundle's source-tree fallback would answer for a missing tree.
    expect(script).toContain("const staging = mkdtempSync(join(tmpdir(), 'mec-staging-'))")
    expect(script).toContain("[join(root, 'scripts', 'smoke-package.mjs'), staging]")
    expect(script).toContain('if (smoked.status !== 0) {')
  })
})

/** Runs scripts/smoke-package.mjs on `root`. */
function smoke(root: string): Promise<{ code: number | null; output: string }> {
  const child = spawn(process.execPath, [join(repoRoot, 'scripts', 'smoke-package.mjs'), root], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(child)
  let output = ''
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk
  })
  child.stderr.on('data', (chunk: Buffer) => {
    output += chunk
  })
  return new Promise((resolve) => child.once('close', (code) => resolve({ code, output })))
}

/** A copy of the tarball layout, two levels down so `../../../packages` stays inside the variant. */
function variant(name: string, damage: (root: string) => void): string {
  const root = join(scratch, 'variants', name, 'inner', 'mec')
  cpSync(tarball, root, { recursive: true, verbatimSymlinks: true })
  damage(root)
  return root
}

/** Gives `root` its own node-pty, so damage to it never reaches this repository's install. */
function ownPty(root: string): string {
  const linked = join(root, 'node_modules')
  rmSync(linked)
  mkdirSync(linked)
  symlinkSync(join(appDir, 'node_modules', 'better-sqlite3'), join(linked, 'better-sqlite3'))
  const pty = join(linked, 'node-pty')
  cpSync(realpathSync(join(appDir, 'node_modules', 'node-pty')), pty, { recursive: true })
  return pty
}

describe('the package smoke', () => {
  it(
    'passes a complete package',
    async () => {
      const { code, output } = await smoke(tarball)
      expect(output).toContain('package smoke passed')
      expect(code, output).toBe(0)
    },
    SPAWN_TEST_MS,
  )

  it(
    'fails an empty catalogue: no shipped tree at all',
    async () => {
      const { code, output } = await smoke(bare)
      expect(code, output).toBe(1)
      expect(output).toContain('did not start')
    },
    SPAWN_TEST_MS,
  )

  it(
    'fails a catalogue that holds only the protocol the boot check looks for',
    async () => {
      const root = variant('thin', (dir) => {
        const tree = join(dir, 'dist', 'prompts-defaults')
        for (const entry of readdirSync(tree)) {
          if (entry !== 'roles' && entry !== 'models.yaml') rmSync(join(tree, entry), { recursive: true })
        }
        for (const entry of readdirSync(join(tree, 'roles'))) {
          if (entry !== 'meta_agent') rmSync(join(tree, 'roles', entry), { recursive: true })
        }
      })
      const { code, output } = await smoke(root)
      expect(code, output).toBe(1)
      expect(output).toMatch(/serves \d+ of 21 parts/)
    },
    SPAWN_TEST_MS,
  )

  it(
    'fails a package with no models table',
    async () => {
      const root = variant('no-models', (dir) => rmSync(join(dir, 'dist', 'prompts-defaults', 'models.yaml')))
      const { code, output } = await smoke(root)
      expect(code, output).toBe(1)
      expect(output).toContain('answered 500')
    },
    SPAWN_TEST_MS,
  )

  it(
    'fails a models table found outside the package, even with the right bytes',
    async () => {
      const root = variant('fallback', (dir) => {
        rmSync(join(dir, 'dist', 'prompts-defaults', 'models.yaml'))
        const outside = join(dir, '..', '..', 'packages', 'prompts', 'defaults')
        cpSync(shippedDefaults, outside, { recursive: true })
      })
      const { code, output } = await smoke(root)
      expect(code, output).toBe(1)
      expect(output).toContain('not from inside the package')
    },
    SPAWN_TEST_MS,
  )

  it(
    'fails a models table that is not the shipped one',
    async () => {
      const root = variant('other-models', (dir) => {
        const file = join(dir, 'dist', 'prompts-defaults', 'models.yaml')
        writeFileSync(file, `${readFileSync(file, 'utf8')}\n# changed\n`)
      })
      const { code, output } = await smoke(root)
      expect(code, output).toBe(1)
      expect(output).toContain('differs from the shipped one')
    },
    SPAWN_TEST_MS,
  )

  it(
    'passes a package whose pty helper arrived without its execute bit, as an install leaves it',
    async () => {
      const root = variant('helper-mode', (dir) => {
        const pty = ownPty(dir)
        const helper = join(pty, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper')
        if (existsSync(helper)) chmodSync(helper, 0o644)
      })
      const { code, output } = await smoke(root)
      expect(output).toContain('package smoke passed')
      expect(code, output).toBe(0)
    },
    SPAWN_TEST_MS,
  )

  it(
    'fails a package whose pty cannot load',
    async () => {
      const root = variant('broken-pty', (dir) => {
        writeFileSync(join(ownPty(dir), 'lib', 'index.js'), "throw new Error('no pty here')\n")
      })
      const { code, output } = await smoke(root)
      expect(code, output).toBe(1)
      expect(output).toContain('a login card did not start (500)')
    },
    SPAWN_TEST_MS,
  )

  it(
    'fails a login card that reports a start and runs nothing',
    async () => {
      const root = variant('idle-pty', (dir) => {
        writeFileSync(
          join(ownPty(dir), 'lib', 'index.js'),
          'exports.spawn = () => ({ onData() {}, onExit() {}, write() {}, kill() {} })\n',
        )
      })
      const { code, output } = await smoke(root)
      expect(code, output).toBe(1)
      expect(output).toContain('its process never ran')
    },
    SPAWN_TEST_MS,
  )

  it(
    'fails a package with no workbench',
    async () => {
      const root = variant('no-web', (dir) => rmSync(join(dir, 'dist', 'web'), { recursive: true }))
      const { code, output } = await smoke(root)
      expect(code, output).toBe(1)
      expect(output).toContain('the workbench page answered')
    },
    SPAWN_TEST_MS,
  )
})

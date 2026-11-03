/**
 * Bundles the `mec` desktop entry (plan §21.1/§21.7) into one ESM file a plain `node` process
 * runs, so the CLI can ship via `npx` without a TypeScript toolchain at runtime.
 *
 * Shape: entry apps/desktop/src/serve.ts (serveMain + the composition root), everything the
 * workspace packages provide inlined, native modules external because they must be installed
 * per-platform: better-sqlite3 (a real dependency) and node-pty (NOT a dependency yet — kept
 * external so a future addition needs no bundle change). The banner gives the ESM bundle a
 * `require` for those native CommonJS deps.
 *
 * The npm publish wrapper (packaging @mec/desktop under the public `mec` name, installing
 * native deps on the consumer side) is a later milestone step; this script only builds and
 * verifies the artifact.
 */
import { statSync } from 'node:fs'
import { relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('..', import.meta.url))
const entry = fileURLToPath(new URL('../apps/desktop/src/serve.ts', import.meta.url))
const outfile = fileURLToPath(new URL('../apps/desktop/dist/mec.mjs', import.meta.url))
const cliEntry = fileURLToPath(new URL('../apps/desktop/src/mec.ts', import.meta.url))
const cliOutfile = fileURLToPath(new URL('../apps/desktop/dist/mec-cli.mjs', import.meta.url))

const common = {
  format: 'esm',
  platform: 'node',
  target: 'node22',
  bundle: true,
  external: ['better-sqlite3', 'node-pty'],
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  minify: false,
  sourcemap: true,
}

await build({ ...common, entryPoints: [entry], outfile })
await build({ ...common, entryPoints: [cliEntry], outfile: cliOutfile })

const { size } = statSync(outfile)
console.log(`bundled ${relative(root, outfile)} (${size} bytes)`)
const cliSize = statSync(cliOutfile).size
console.log(`bundled ${relative(root, cliOutfile)} (${cliSize} bytes)`)

// Playwright is loaded at capture time only (§15): no bundle of the server pulls it in, whatever
// that bundle's external list says. CI's restart test bundles serve.ts with only the natives
// external, and inlining playwright-core there fails on chromium-bidi, which it loads lazily.
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { describe, expect, it } from 'vitest'

const appDir = fileURLToPath(new URL('..', import.meta.url))

describe('playwright-core stays out of the server bundle', () => {
  it('a bundle with only the natives external neither inlines nor resolves it', async () => {
    const result = await build({
      entryPoints: [join(appDir, 'src', 'serve.ts')],
      format: 'esm',
      platform: 'node',
      target: 'node22',
      bundle: true,
      write: false,
      external: ['better-sqlite3', 'node-pty'],
      logLevel: 'silent',
      metafile: true,
    })
    const inputs = Object.keys(result.metafile.inputs)
    expect(inputs.filter((path) => path.includes('playwright-core'))).toEqual([])
    const text = result.outputFiles.map((file) => file.text).join('\n')
    expect(text).not.toContain('chromium-bidi')
  })
})

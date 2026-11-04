#!/usr/bin/env node
/**
 * The INTERNAL install artifact (R2.4, amended by DECISIONS #4: no public npm).
 *
 * Runs scripts/bundle-desktop.mjs, then stages an npm-pack-shaped tree — package.json
 * (name mubit-engineering-control, bin mec), README, LICENSE, NOTICE, bin/, dist/ — and
 * tars it to dist-internal/mec-<version>.tgz. The artifact installs with plain npm
 * (`npm install --omit=dev --ignore-scripts=false` builds the two native modules); the
 * bundled dist has them external on purpose (see bundle-desktop.mjs).
 *
 * This script NEVER publishes: no registry is contacted, and the staged package.json is
 * marked private so an accidental `npm publish` from the staging dir is refused.
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const appDir = join(root, 'apps', 'desktop')
const outDir = join(root, 'dist-internal')
const version = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')).version
const staging = join(outDir, 'staging')
const tgz = join(outDir, `mec-${version}.tgz`)

// 1. Build the bundle first — the artifact ships the exact bytes `mec` runs.
const bundled = spawnSync(process.execPath, [join(root, 'scripts', 'bundle-desktop.mjs')], {
  stdio: 'inherit',
})
if (bundled.status !== 0) {
  console.error(`pack-tarball: bundle-desktop failed (exit ${bundled.status ?? '?'}) — no artifact written`)
  process.exit(bundled.status ?? 1)
}

// 2. Stage the npm-pack shape (entries at the archive root; no `package/` wrapper, so
//    `tar xzf mec-<version>.tgz -C mec` lands the files directly in the target dir).
//    The workbench UI ships INSIDE the artifact (review 2026-11-04 §2.1): build apps/web
//    fresh so the tarball never carries a stale UI, then place it at dist/web where the
//    bundled server resolves it.
rmSync(staging, { recursive: true, force: true })
mkdirSync(staging, { recursive: true })
const webBuild = spawnSync('pnpm', ['--dir', join(root, 'apps/web'), 'build'], { stdio: 'inherit' })
if (webBuild.status !== 0) {
  console.error('pack-tarball: apps/web build failed — the artifact must carry the workbench')
  process.exit(webBuild.status ?? 1)
}
cpSync(join(appDir, 'bin'), join(staging, 'bin'), { recursive: true })
cpSync(join(appDir, 'dist'), join(staging, 'dist'), { recursive: true })
cpSync(join(root, 'apps/web/dist'), join(staging, 'dist', 'web'), { recursive: true })
// Issue #16: the bundle resolves the shipped models table relative to itself — ship it
// beside the bundle at dist/prompts-defaults/.
cpSync(join(root, 'packages/prompts/defaults'), join(staging, 'dist', 'prompts-defaults'), {
  recursive: true,
})

const appPkg = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8'))
writeFileSync(
  join(staging, 'package.json'),
  `${JSON.stringify(
    {
      name: 'mubit-engineering-control',
      version,
      private: true,
      description: 'MEC — Mubit Engineering Control: local meta-agent orchestration (internal distribution)',
      type: 'module',
      bin: { mec: 'bin/mec.js' },
      files: ['bin', 'dist'],
      engines: appPkg.engines ?? { node: '>=22.12' },
      // Only the natives stay external to the bundle; everything else is inlined.
      dependencies: {
        'better-sqlite3': appPkg.dependencies['better-sqlite3'],
        'node-pty': appPkg.dependencies['node-pty'],
      },
    },
    null,
    2,
  )}\n`,
)

writeFileSync(
  join(staging, 'README.md'),
  `# MEC (internal install artifact)

Mubit Engineering Control — the \`mec\` CLI and workbench server. Internal distribution
(DECISIONS #4): this tarball comes from the repository, not from a public registry.

## Install

    mkdir mec && tar xzf mec-${version}.tgz -C mec && cd mec
    npm install --omit=dev --ignore-scripts=false   # builds better-sqlite3 + node-pty
    node bin/mec.js                                  # serves the workbench (prints its URL)

pnpm users: keep the postinstall allowlist in the target package.json —
\`"pnpm": { "onlyBuiltDependencies": ["better-sqlite3", "node-pty"] }\` — or the native
modules will not build (the launcher then exits 3 with a pointer to the fix).

## Commands

    node bin/mec.js        # the workbench server (prints its URL; MEC_DATA_DIR overrides ~/.mec)
    mec status | stop | restart | doctor | slot add|list|probe|retire | update
                          # the \`mec\` command dispatcher runs from a repository checkout:
                          #   node apps/desktop/src/mec.ts <command>
                          # (bin dispatch lands with the §21.1 launcher wiring)

See docs/known-limits.md in the repository for the native-module rule and v0 limits.
`,
)

// Apache-2.0 per DECISIONS #1. The repository root carries the full text (LICENSE) and
// NOTICE.md; the artifact copies both verbatim. The stub fallbacks remain for a tree
// that somehow lost them.
const repoLicense = [join(root, 'LICENSE'), join(root, 'LICENSE.txt'), join(root, 'LICENSE.md')].find((p) => {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
})
if (repoLicense) {
  copyFileSync(repoLicense, join(staging, 'LICENSE'))
} else {
  writeFileSync(
    join(staging, 'LICENSE'),
    `Apache License, Version 2.0 (SPDX: Apache-2.0)

Copyright 2026 Mubit Engineering

This distribution is licensed under the Apache License, Version 2.0. The full license
text is at https://www.apache.org/licenses/LICENSE-2.0.txt — fetch and attach it before
any redistribution outside the company; this stub is a pointer, not the license text.
`,
  )
}

const repoNotice = [join(root, 'NOTICE.md'), join(root, 'NOTICE')].find((p) => {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
})
if (repoNotice) {
  copyFileSync(repoNotice, join(staging, 'NOTICE.md'))
} else {
  writeFileSync(
    join(staging, 'NOTICE.md'),
    `mubit-engineering-control
Copyright 2026 Mubit Engineering. Licensed under the Apache License, Version 2.0.

Third-party packages this artifact depends on or bundles:

| Package | License | How it ships |
| --- | --- | --- |
| better-sqlite3 | MIT | installed at install time (native module, external to the bundle) |
| node-pty | MIT | installed at install time (native module, external to the bundle) |
| fastify | MIT | inlined into dist/mec.mjs by esbuild |
| react | MIT | the web workbench (apps/web), when bundled alongside |
| zod | MIT | inlined into dist/mec.mjs by esbuild |
| @biomejs/biome | MIT | development only — not distributed |
`,
  )
}

// 3. Tar the staged tree (entries at the archive root, no wrapper dir).
const entries = ['LICENSE', 'NOTICE.md', 'README.md', 'bin', 'dist', 'package.json']
const tarred = spawnSync('tar', ['-czf', tgz, '-C', staging, ...entries], { stdio: 'inherit' })
if (tarred.status !== 0) {
  console.error(`pack-tarball: tar failed (exit ${tarred.status ?? '?'}) — staging kept at ${staging}`)
  process.exit(tarred.status ?? 1)
}
rmSync(staging, { recursive: true, force: true })

const { size } = statSync(tgz)
console.log(`internal artifact: ${relative(root, resolve(tgz))} (${size} bytes)`)
console.log('')
console.log('install on a target machine:')
console.log(`  mkdir mec && tar xzf mec-${version}.tgz -C mec && cd mec`)
console.log('  npm install --omit=dev --ignore-scripts=false')
console.log('  node bin/mec.js   # serves the workbench, prints its URL')
console.log('')
console.log('pnpm allowlist note: add to the target package.json —')
console.log('  "pnpm": { "onlyBuiltDependencies": ["better-sqlite3", "node-pty"] }')
console.log('(this script does not publish anywhere; the staged package.json is private)')

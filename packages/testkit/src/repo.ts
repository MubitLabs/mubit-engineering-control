import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const run = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: process.env.HOME ?? '/tmp',
      GIT_AUTHOR_NAME: 'fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.com',
      GIT_COMMITTER_NAME: 'fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.com',
    },
  }).toString()

export interface FixtureRepo {
  dir: string
  url: string
  /** Commits files on main and returns the new SHA. */
  commit(files: Record<string, string>, message?: string): string
}

/**
 * A small local git repository usable as a remote (`file://`). The default content has a check
 * script so validation profiles can run without network access.
 */
export function createFixtureRepo(files: Record<string, string> = DEFAULT_FILES): FixtureRepo {
  const dir = mkdtempSync(path.join(tmpdir(), 'mec-fixture-'))
  run(dir, 'init', '--quiet', '--initial-branch=main')
  run(dir, 'config', 'receive.denyCurrentBranch', 'ignore')
  const repo: FixtureRepo = {
    dir,
    url: `file://${dir}`,
    commit(fs, message = 'fixture commit') {
      for (const [p, content] of Object.entries(fs)) {
        mkdirSync(path.dirname(path.join(dir, p)), { recursive: true })
        writeFileSync(path.join(dir, p), content)
      }
      run(dir, 'add', '--all')
      run(dir, 'commit', '--quiet', '-m', message)
      return run(dir, 'rev-parse', 'HEAD').trim()
    },
  }
  repo.commit(files, 'initial')
  return repo
}

export const DEFAULT_FILES: Record<string, string> = {
  'README.md': '# fixture\n',
  'src/greet.js': "export const greet = (name) => 'hello ' + name\n",
  // Passes when every file listed in REQUIRED_FILES exists; prints what it checked.
  'checks/require-files.mjs': `import { existsSync, readFileSync } from 'node:fs'
const wanted = existsSync('REQUIRED_FILES') ? readFileSync('REQUIRED_FILES', 'utf8').split('\\n').filter(Boolean) : []
for (const f of wanted) { if (!existsSync(f)) { console.error('missing ' + f); process.exit(1) } console.log('ok ' + f) }
console.log('checked ' + wanted.length + ' files')
`,
  'checks/fail.mjs': "console.error('this check always fails'); process.exit(3)\n",
}

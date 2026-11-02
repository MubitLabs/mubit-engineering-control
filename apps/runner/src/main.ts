import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ClaudeCodeAdapter, FakeAdapter } from '@mec/agents'
import { EnrolResponse } from '@mec/contracts'
import { createLogger, DEFAULT_CONFIG_FILE, loadRunnerConfig, RunnerConfigError, withEnvFile } from './config'
import { Runner } from './runner'

const USAGE = `Mubit Engineering Control runner

Usage:
  node apps/runner/dist/main.js enrol --url <control-url> --invite <token> [--name <runner-name>] [--config-file <path>]
      Exchanges a single-use invitation from the Fleet page for this machine's credentials and
      writes them to the config file (default ${DEFAULT_CONFIG_FILE}).
  node apps/runner/dist/main.js [--config-file <path>]
      Connects to the control plane and runs attempts. Settings come from the environment,
      then from the config file.

Optional settings (environment or config file):
  MEC_HOME            where repositories, worktrees and the journal live (default ~/mec)
  MEC_MAX_ATTEMPTS    attempts run at once on this machine (default 2)
  MEC_GIT_TOKEN       token used to push attempt branches
  MEC_CLAUDE_BIN      the Claude Code binary (default claude)
`

const args = process.argv.slice(2)
const opt = (name: string) => {
  const i = args.indexOf(name)
  return i === -1 ? undefined : args[i + 1]
}
const configFile = opt('--config-file') ?? DEFAULT_CONFIG_FILE
const command = args[0]?.startsWith('--') ? undefined : args[0]

if (args.includes('--help') || args.includes('-h') || command === 'help') {
  process.stdout.write(USAGE)
} else if (command === 'enrol') {
  await enrol()
} else if (command === undefined) {
  await run()
} else {
  process.stderr.write(`unknown command "${command}"\n\n${USAGE}`)
  process.exit(2)
}

async function enrol() {
  const url = opt('--url')
  const invite = opt('--invite')
  const name =
    opt('--name') ??
    os
      .hostname()
      .split('.')[0]!
      .replace(/[^A-Za-z0-9_.-]/g, '-')
  if (!url || !invite) {
    process.stderr.write(`enrol needs --url and --invite\n\n${USAGE}`)
    process.exit(2)
  }
  let res: Response
  try {
    res = await fetch(`${url.replace(/\/+$/, '')}/api/runners/enrol`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        inviteToken: invite,
        name,
        hostname: os.hostname(),
        os: os.platform(),
        arch: os.arch(),
      }),
    })
  } catch (e) {
    console.error(`could not reach ${url}: ${(e as Error).message}`)
    process.exit(1)
  }
  if (!res.ok) {
    const body = await res.text()
    let message = body
    try {
      message = (JSON.parse(body) as { message?: string }).message ?? body
    } catch {}
    console.error(`enrolment failed (${res.status}): ${message}`)
    process.exit(1)
  }
  const { runnerId, token } = EnrolResponse.parse(await res.json())
  await mkdir(path.dirname(configFile), { recursive: true, mode: 0o700 })
  let existing = ''
  try {
    existing = await readFile(configFile, 'utf8')
  } catch {}
  const keep = existing
    .split('\n')
    .filter((l) => l.trim() && !/^(MEC_CONTROL_URL|MEC_RUNNER_ID|MEC_RUNNER_TOKEN)=/.test(l))
  const lines = [...keep, `MEC_CONTROL_URL=${url}`, `MEC_RUNNER_ID=${runnerId}`, `MEC_RUNNER_TOKEN=${token}`]
  await writeFile(configFile, `${lines.join('\n')}\n`, { mode: 0o600 })
  await chmod(configFile, 0o600)
  const self = path.relative(process.cwd(), fileURLToPath(import.meta.url)) || 'main.js'
  const flag = configFile === DEFAULT_CONFIG_FILE ? '' : ` --config-file ${configFile}`
  console.log(`enrolled runner ${name} (${runnerId}); credentials written to ${configFile}

Next:
  1. Start the runner:  node ${self}${flag}
  2. Open Accounts in the web app and offer this runner's agent account to your projects.`)
}

async function readConfigFile(): Promise<string> {
  try {
    return await readFile(configFile, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw e
  }
}

async function run() {
  let config: ReturnType<typeof loadRunnerConfig>
  try {
    config = loadRunnerConfig(withEnvFile(process.env, await readConfigFile()))
  } catch (e) {
    if (!(e instanceof RunnerConfigError)) throw e
    process.stderr.write(`${e.message}\nConfig file: ${configFile}\n\nRun with --help for usage.\n`)
    process.exit(2)
  }
  const log = createLogger(config.logLevel)
  const here = path.dirname(fileURLToPath(import.meta.url))
  const runner = new Runner(config, log, [
    new FakeAdapter({
      binDir: path.join(config.home, 'bin'),
      stateDir: path.join(config.home, 'agent-state'),
    }),
    new ClaudeCodeAdapter({
      binary: process.env.MEC_CLAUDE_BIN ?? 'claude',
      mcpServer: { command: process.execPath, args: [path.join(here, 'mec-mcp.js')] },
      runtimeDir: path.join(config.home, 'run'),
      model: process.env.MEC_CLAUDE_MODEL || null,
    }),
  ])
  await runner.start()
  log.info('runner started', {
    runnerId: config.runnerId,
    home: config.home,
    maxAttempts: config.maxAttempts,
  })
  let stopping = false
  const stop = async (signal: string) => {
    if (stopping) return
    stopping = true
    log.info('stopping', { signal })
    await runner.stop()
    process.exit(0)
  }
  process.on('SIGTERM', () => void stop('SIGTERM'))
  process.on('SIGINT', () => void stop('SIGINT'))
}

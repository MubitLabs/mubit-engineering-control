import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EnrolResponse } from '@mec/contracts'
import { createLogger, loadRunnerConfig } from './config'
import { Runner } from './runner'

/**
 *   mec-runner enrol --url <control> --invite <token> --name <name> [--env-file <path>]
 *   mec-runner            (run; configuration from the environment)
 */
const args = process.argv.slice(2)
const opt = (name: string) => {
  const i = args.indexOf(name)
  return i === -1 ? undefined : args[i + 1]
}

if (args[0] === 'enrol') {
  await enrol()
} else {
  await run()
}

async function enrol() {
  const url = opt('--url')
  const invite = opt('--invite')
  const name = opt('--name')
  const envFile = opt('--env-file') ?? path.join(os.homedir(), '.config', 'mec', 'runner.env')
  if (!url || !invite || !name) {
    console.error('usage: mec-runner enrol --url <control-url> --invite <token> --name <runner-name>')
    process.exit(2)
  }
  const res = await fetch(`${url.replace(/\/+$/, '')}/api/runners/enrol`, {
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
  if (!res.ok) {
    console.error(`enrolment failed: ${res.status} ${await res.text()}`)
    process.exit(1)
  }
  const { runnerId, token } = EnrolResponse.parse(await res.json())
  await mkdir(path.dirname(envFile), { recursive: true, mode: 0o700 })
  let existing = ''
  try {
    existing = await readFile(envFile, 'utf8')
  } catch {}
  const keep = existing
    .split('\n')
    .filter((l) => l.trim() && !/^(MEC_CONTROL_URL|MEC_RUNNER_ID|MEC_RUNNER_TOKEN)=/.test(l))
  const lines = [...keep, `MEC_CONTROL_URL=${url}`, `MEC_RUNNER_ID=${runnerId}`, `MEC_RUNNER_TOKEN=${token}`]
  await writeFile(envFile, `${lines.join('\n')}\n`, { mode: 0o600 })
  await chmod(envFile, 0o600)
  console.log(`enrolled runner ${name} (${runnerId}); credentials written to ${envFile}`)
}

async function run() {
  const config = loadRunnerConfig()
  const log = createLogger(config.logLevel)
  const runner = new Runner(config, log)
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

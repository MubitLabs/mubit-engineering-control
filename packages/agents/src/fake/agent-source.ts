/**
 * The fake agent program. It runs as a real child process (so supervision, interruption and
 * runner restarts behave as they would for a vendor CLI) and speaks newline-delimited JSON:
 *
 *   stdout: {type:'session'|'message'|'tool_use'|'tool_result'|'question'|'approval'|'result', …}
 *   stdin:  {id, answer} | {id, decision: 'approve'|'reject', reason}
 *
 * Progress is checkpointed after each step, so `--resume` continues where it stopped.
 * It is kept as source text and written to disk by the adapter, which avoids path resolution
 * differences between tests, development and the bundled runner.
 */
export const FAKE_AGENT_SOURCE = String.raw`
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'

const args = process.argv.slice(2)
const opt = (name) => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1] }
const workdir = resolve(opt('--workdir'))
const script = JSON.parse(readFileSync(opt('--script'), 'utf8'))
const statePath = opt('--state')
const resumeRef = opt('--resume')

let state = { session: resumeRef ?? randomUUID(), done: 0 }
if (resumeRef && existsSync(statePath)) state = JSON.parse(readFileSync(statePath, 'utf8'))
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
const save = () => writeFileSync(statePath, JSON.stringify(state))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const waiting = new Map()
createInterface({ input: process.stdin }).on('line', (line) => {
  try {
    const m = JSON.parse(line)
    const resolveWait = waiting.get(m.id)
    if (resolveWait) { waiting.delete(m.id); resolveWait(m) }
  } catch {}
})
const waitFor = (id) => new Promise((r) => waiting.set(id, r))
process.on('SIGTERM', () => process.exit(143))

out({ type: 'session', id: state.session, resumed: Boolean(resumeRef) })
for (let i = state.done; i < script.length; i++) {
  const s = script[i]
  if ('say' in s) out({ type: 'message', text: s.say })
  else if ('sleepMs' in s) await sleep(s.sleepMs)
  else if ('write' in s) {
    const target = resolve(workdir, s.write.path)
    if (!target.startsWith(workdir + sep)) { out({ type: 'result', status: 'failed', detail: 'path escapes the workspace' }); process.exit(1) }
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, s.write.content)
    out({ type: 'tool_use', name: 'Write', input: { path: s.write.path } })
    out({ type: 'tool_result', name: 'Write', ok: true })
  } else if ('tool' in s) out({ type: 'tool_use', name: s.tool, input: s.input ?? {} })
  else if ('ask' in s) {
    const id = 'q' + i
    out({ type: 'question', id, question: s.ask, options: s.options })
    const m = await waitFor(id)
    out({ type: 'message', text: m.answer !== undefined ? 'Answer received: ' + m.answer : 'Question declined' })
  } else if ('requestApproval' in s) {
    const id = 'a' + i
    out({ type: 'approval', id, tool: s.requestApproval, command: s.command })
    const m = await waitFor(id)
    if (m.decision === 'approve') { out({ type: 'tool_use', name: s.requestApproval, input: { command: s.command } }); out({ type: 'tool_result', name: s.requestApproval, ok: true }) }
    else out({ type: 'message', text: 'Not approved: ' + (m.reason ?? m.decision) })
  } else if ('fail' in s) {
    state.done = i + 1; save()
    out({ type: 'result', status: 'failed', detail: s.fail })
    process.exit(1)
  } else if ('exit' in s) {
    state.done = i + 1; save()
    out({ type: 'result', status: s.exit, detail: 'simulated ' + s.exit })
    process.exit(2)
  }
  state.done = i + 1
  save()
}
out({ type: 'result', status: 'success', summary: 'script complete' })
process.exit(0)
`

/**
 * The key that answers a card (§13). Being on loopback is no authority: a repo's check runs as the
 * owner and can call any route, so a route that acts on the owner's say needs something that check
 * cannot get.
 *
 * - **Where it lives.** This process's memory and the owner's browser tab. It is never written to
 *   disk, the store, a log or the environment, and no route returns it. A restart mints another,
 *   because nothing on disk could prove who held the last one: a check can write there too.
 * - **How a browser gets it.** Only through a one-time code on a link this server opens in the
 *   default browser, in the URL's fragment, so the caller who asked for the link never sees it.
 *   Anyone may ask: the worst they get is a tab. The link's origin is ours, never the request's Host.
 * - **The deliberate path.** A starter that needs the key, such as a coordinator's script, chooses
 *   one and hands it in on an inherited descriptor (`--approval-key-fd=N`). It is a flag on the
 *   command line that started the server, so `mec restart` does not carry it and no environment
 *   gives it.
 *
 * This stops a process that reads the data dir and calls loopback. It does not stop a hostile
 * process running as the owner, which can stop this server, or act without it: see known-limits.
 */
import { spawn } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { closeSync, readFileSync } from 'node:fs'

export const APPROVAL_HEADER = 'x-mec-approval'

/** A browser opens a link at once; a code left lying about should not outlast the moment. */
export const CODE_LIFE_MS = 120_000
/** Anyone can ask for a link, so asking is rate-limited to what a person does. */
export const LINK_SPACING_MS = 5000

const MIN_KEY_CHARS = 32

const mint = (): string => randomBytes(32).toString('hex')

const same = (a: string, b: string): boolean => {
  const [left, right] = [Buffer.from(a), Buffer.from(b)]
  return left.length === right.length && timingSafeEqual(left, right)
}

export class ApprovalKey {
  readonly #key: string
  #code: { value: string; expires: number } | undefined
  #lastCodeAt = Number.NEGATIVE_INFINITY

  constructor(key: string = mint()) {
    this.#key = key
  }

  accepts(candidate: unknown): boolean {
    return typeof candidate === 'string' && same(candidate, this.#key)
  }

  /** One code at a time. Undefined means one was given a moment ago. */
  issueCode(now: number): string | undefined {
    if (now - this.#lastCodeAt < LINK_SPACING_MS) return undefined
    this.#lastCodeAt = now
    const value = mint()
    this.#code = { value, expires: now + CODE_LIFE_MS }
    return value
  }

  /** The key, once, for a live code. */
  redeem(code: unknown, now: number): string | undefined {
    const live = this.#code
    if (typeof code !== 'string' || live === undefined || now > live.expires) return undefined
    if (!same(code, live.value)) return undefined
    this.#code = undefined
    return this.#key
  }
}

const OPENER_MS = 5_000

/** On a mac the URL goes over stdin, because argv is what any process can read in `ps`. */
export function linkCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
): { cmd: string; args: string[]; stdin?: string } {
  return platform === 'darwin'
    ? { cmd: '/usr/bin/osascript', args: ['-'], stdin: `open location "${url}"\n` }
    : { cmd: 'xdg-open', args: [url] }
}

/** True once the opener says it worked. One that has not answered by the bound has not failed. */
export function openLink(url: string): Promise<boolean> {
  const { cmd, args, stdin } = linkCommand(url)
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: [stdin === undefined ? 'ignore' : 'pipe', 'ignore', 'ignore'] })
    const failed = (): void => {
      console.log('no browser could be opened for the approval link')
      resolve(false)
    }
    const bound = setTimeout(() => resolve(true), OPENER_MS)
    bound.unref()
    child.on('error', failed)
    child.on('close', (code) => {
      clearTimeout(bound)
      if (code === 0) resolve(true)
      else failed()
    })
    child.stdin?.on('error', () => {})
    child.stdin?.end(stdin)
  })
}

/** `--approval-key-fd=N`: the whole descriptor, once. Too short a key refuses the start. */
export function readApprovalKey(fd: number): string {
  try {
    const key = readFileSync(fd, 'utf8').trim()
    if (key.length < MIN_KEY_CHARS)
      throw new Error(`an approval key needs at least ${MIN_KEY_CHARS} characters`)
    return key
  } finally {
    closeSync(fd)
  }
}

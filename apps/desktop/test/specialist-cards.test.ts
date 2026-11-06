// M2.2's permission widening (§13): a specialist can obtain a permission by card, and nothing but
// a person's answer gives it. The tools run on the real server with real tokens over real HTTP.
import type { KeyFingerprint, Operation, StoreDoc } from '@mec/contracts'
import { issueToken, MecToolsServer } from '@mec/mec-tools'
import { FollowUps, settleSpecialistCard } from '@mec/meta'
import { loadPolicy, type PolicyDoc } from '@mec/policy'
import { redactEvent } from '@mec/runtime'
import { MemoryRepositories } from '@mec/testkit'
import { afterEach, describe, expect, it } from 'vitest'
import { type Cleaner, StoreFacts } from '../src/core-facts'
import { type CardDeps, decideOperation, specialistBridge, specialistTools } from '../src/specialist-tools'

const SECRET = 'specialist-cards-test-secret'
const NO_POLICY = loadPolicy('{"preAuthorised":{}}')
const KEY = `sk-ant-${'a1B2c3D4'.repeat(6)}`
const EVIDENCE = { raw: {}, worktree: '/tmp/w' }
/** A slot key of no known shape: only the last-four sweep can catch it. */
const UNPATTERNED_KEY = `zQ9-${'mK7xVt2w'.repeat(3)}-Rp4T`
const FINGERPRINT: KeyFingerprint = { provider: 'anthropic-api', last4: 'Rp4T', hash: 'c'.repeat(64) }

/** The cleaner composition.ts gives both the facts and the cards. */
const cleaner =
  (exacts: string[]): Cleaner =>
  <T>(_attemptId: string, value: T): T =>
    redactEvent(value as never, [FINGERPRINT], exacts) as T

const shell = (command: string): Operation => ({
  kind: 'shell',
  summary: `Bash: ${command}`,
  command: [command],
})

function rig(policy: PolicyDoc = NO_POLICY, extra: Partial<CardDeps> = {}) {
  const store = new MemoryRepositories()
  store.atomic(() => {
    store.workItems.save({ id: 'wi_1', state: 'executing', repoId: 'repo_a' })
    store.attempts.save({
      id: 'att_1',
      taskId: 'task_1',
      workItemId: 'wi_1',
      state: 'running',
      generation: 1,
      worktree: '/tmp/w',
      temp_dir: '/tmp/t',
      sandbox: 'required',
    })
  })
  const followups = new FollowUps({ store, effects: store.effects })
  const cards: CardDeps = { followups, policy, pollMs: 2, clean: cleaner([]), ...extra }
  const attempt = () => store.attempts.get('att_1') as StoreDoc
  const pending = () => store.confirmations.list({ status: 'pending' })
  const settle = (status: string) => {
    store.atomic(() => {
      const [card] = pending()
      store.confirmations.save({ ...(card as StoreDoc), status })
    })
  }
  return { store, cards, attempt, pending, settle }
}

const waitForCard = async (pending: () => StoreDoc[]): Promise<void> => {
  while (pending().length === 0) await new Promise((resolve) => setTimeout(resolve, 2))
}

describe('confirm with a card (§13)', () => {
  it('a confirm-by-default ask waits, and an approval allows it', async () => {
    const h = rig()
    const decision = decideOperation(h.store, h.cards, h.attempt(), shell('pnpm add left-pad'))
    await waitForCard(h.pending)
    expect(h.pending()[0]).toMatchObject({ cls: 'install', attemptId: 'att_1', workItemId: 'wi_1' })
    h.settle('approved')
    await expect(decision).resolves.toMatchObject({ allow: true })
  })

  it('a denial denies', async () => {
    const h = rig()
    const decision = decideOperation(h.store, h.cards, h.attempt(), shell('pip install x'))
    await waitForCard(h.pending)
    h.settle('denied')
    await expect(decision).resolves.toMatchObject({ allow: false })
  })

  it('expiry is never consent: the card ends expired and the ask is denied', async () => {
    const h = rig(NO_POLICY, { waitMs: 5 })
    const verdict = await decideOperation(h.store, h.cards, h.attempt(), shell('pnpm add x'))
    expect(verdict.allow).toBe(false)
    expect(h.store.confirmations.list({ status: 'expired' })).toHaveLength(1)
  })

  it('an always-confirm class opens no card and policy cannot change that', async () => {
    const h = rig()
    for (const command of [
      'git push origin main',
      'gh pr merge 1',
      'git branch -D x',
      'pnpm add x && git push',
    ]) {
      const verdict = await decideOperation(h.store, h.cards, h.attempt(), shell(command))
      expect(verdict.allow, command).toBe(false)
    }
    expect(h.store.confirmations.list()).toHaveLength(0)
  })

  it('an ordinary shell ask opens no card', async () => {
    const h = rig()
    const verdict = await decideOperation(h.store, h.cards, h.attempt(), shell('ls -la'))
    expect(verdict.allow).toBe(true)
    expect(h.store.confirmations.list()).toHaveLength(0)
  })

  it('a policy pre-authorisation answers without a card, for that repository only', async () => {
    const scoped = (repoId: string) =>
      loadPolicy(JSON.stringify({ preAuthorised: { install: [{ scope: 'repo', repoId }] } }))
    const here = rig(scoped('repo_a'))
    const verdict = await decideOperation(here.store, here.cards, here.attempt(), shell('pnpm add x'))
    expect(verdict.allow).toBe(true)
    expect(here.store.confirmations.list()).toHaveLength(0)

    const elsewhere = rig(scoped('repo_b'), { waitMs: 5 })
    const denied = await decideOperation(
      elsewhere.store,
      elsewhere.cards,
      elsewhere.attempt(),
      shell('pnpm add x'),
    )
    expect(denied.allow).toBe(false)
  })

  it('a re-ask of the same operation reuses the card, and a settled answer stands', async () => {
    const h = rig()
    const first = decideOperation(h.store, h.cards, h.attempt(), shell('pnpm add x'))
    const second = decideOperation(h.store, h.cards, h.attempt(), shell('pnpm add x'))
    await waitForCard(h.pending)
    expect(h.pending()).toHaveLength(1)
    h.settle('denied')
    await expect(first).resolves.toMatchObject({ allow: false })
    await expect(second).resolves.toMatchObject({ allow: false })
    const third = await decideOperation(h.store, h.cards, h.attempt(), shell('pnpm add x'))
    expect(third.allow).toBe(false)
    expect(h.store.confirmations.list()).toHaveLength(1)
  })

  it('an attempt that stops ends the wait, denied', async () => {
    const h = rig()
    const decision = decideOperation(h.store, h.cards, h.attempt(), shell('pnpm add x'))
    await waitForCard(h.pending)
    h.store.atomic(() => {
      h.store.attempts.save({ ...h.attempt(), state: 'interrupted' })
    })
    await expect(decision).resolves.toMatchObject({ allow: false })
  })

  it('a closing server ends the wait, denied', async () => {
    const closing = new AbortController()
    const h = rig(NO_POLICY, { signal: closing.signal })
    const decision = decideOperation(h.store, h.cards, h.attempt(), shell('pnpm add x'))
    await waitForCard(h.pending)
    closing.abort()
    await expect(decision).resolves.toMatchObject({ allow: false })
  })

  it('with no card path a confirm-by-default ask is denied, as it was', async () => {
    const h = rig()
    const verdict = await decideOperation(h.store, undefined, h.attempt(), shell('pnpm add x'))
    expect(verdict.allow).toBe(false)
    expect(h.store.confirmations.list()).toHaveLength(0)
  })

  it('the in-process bridge decides the same way', async () => {
    const h = rig()
    const bridge = specialistBridge(h.store, h.cards)
    const ref = { attempt_id: 'att_1', generation: 1 }
    const deadline = new Date(Date.now() + 5000).toISOString()
    await expect(bridge.request(ref, shell('git push'), EVIDENCE, deadline)).resolves.toBe('deny')
    const asked = bridge.request(ref, shell('pnpm add x'), EVIDENCE, deadline)
    await waitForCard(h.pending)
    h.settle('approved')
    await expect(asked).resolves.toBe('allow')
  })

  it('a key-shaped string on the card is redacted before the write', async () => {
    const h = rig(NO_POLICY, { waitMs: 5 })
    await decideOperation(h.store, h.cards, h.attempt(), shell(`pnpm add ${KEY}`))
    expect(JSON.stringify(h.store.confirmations.list())).not.toContain(KEY)
  })

  it('the attempt token on a card it was not meant for is redacted before the write', async () => {
    const token = issueToken({ attemptId: 'att_1', generation: 1, role: 'specialist', secret: SECRET })
    const h = rig(NO_POLICY, { waitMs: 5, clean: cleaner([token]) })
    await decideOperation(h.store, h.cards, h.attempt(), shell(`pnpm add ${token}`))
    expect(h.store.confirmations.list({ status: 'expired' })).toHaveLength(1)
    expect(JSON.stringify(h.store.snapshot())).not.toContain(token)
  })
})

describe('what a person’s answer does (§13)', () => {
  it('a planner card runs nothing, and says so', () => {
    const h = rig()
    const doc = { id: 'conf_1', status: 'approved' }
    expect(settleSpecialistCard(h.store, h.store.effects, doc)).toBe(false)
  })

  it('a card whose attempt has gone tells nobody to carry on', () => {
    const h = rig()
    h.store.atomic(() => {
      h.store.attempts.save({ ...h.attempt(), state: 'failed' })
    })
    const doc = { id: 'conf_1', status: 'approved', attemptId: 'att_1' }
    expect(settleSpecialistCard(h.store, h.store.effects, doc)).toBe(false)
  })

  it('a denial is no continuation, and a requested card delivers the outcome', () => {
    const h = rig()
    const doc = { id: 'conf_1', status: 'denied', attemptId: 'att_1', notify: true }
    const told = h.store.atomic(() => settleSpecialistCard(h.store, h.store.effects, doc))
    expect(told).toBe(false)
    expect(h.store.snapshot().effects.map((row) => row.kind)).toEqual(['deliver'])
  })
})

describe('the tools (§6)', () => {
  const servers: MecToolsServer[] = []
  afterEach(async () => {
    for (const server of servers.splice(0)) await server.stop()
  })

  async function tools(policy: PolicyDoc = NO_POLICY) {
    const token = issueToken({ attemptId: 'att_1', generation: 1, role: 'specialist', secret: SECRET })
    const h = rig(policy, { waitMs: 60_000, clean: cleaner([token]) })
    const followups = new FollowUps({ store: h.store, effects: h.store.effects })
    const facts = new StoreFacts(h.store, (_attemptId, value) => value, undefined, { followups })
    const server = new MecToolsServer({
      secret: SECRET,
      bridge: { request: async () => 'deny' },
      onCall: specialistTools({ store: h.store, facts, headOf: async () => 'a'.repeat(40), cards: h.cards }),
    })
    servers.push(server)
    const { url } = await server.start()
    const call = async (tool: string, args: unknown) => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: tool, arguments: args },
        }),
      })
      return (await response.json()) as {
        result?: { content: { text: string }[] }
        error?: { message: string }
      }
    }
    return {
      ...h,
      token,
      call,
      answer: (rpc: Awaited<ReturnType<typeof call>>) => JSON.parse(rpc.result?.content[0]?.text ?? 'null'),
    }
  }

  it('request_confirmation opens a pending card and never settles it', async () => {
    const h = await tools()
    const operation = { class: 'install', command: 'pnpm add x' }
    const rpc = await h.call('request_confirmation', { operation, evidence: { reason: 'needed' } })
    const body = h.answer(rpc)
    expect(body).toMatchObject({ ok: true, status: 'pending' })
    expect(h.store.confirmations.get(body.confirmation_id)).toMatchObject({
      cls: 'install',
      status: 'pending',
      notify: true,
      attemptId: 'att_1',
    })
  })

  it('a card holds neither the attempt token nor a key of no known shape (§22)', async () => {
    const h = await tools()
    const printenv = `MEC_TOOLS_TOKEN=${h.token}\nSLOT_KEY=${UNPATTERNED_KEY}\nHOME=/h`
    const body = h.answer(
      await h.call('request_confirmation', {
        operation: { class: 'install', command: `curl -H ${h.token}`, args: [UNPATTERNED_KEY] },
        evidence: {
          auth: h.token,
          key: UNPATTERNED_KEY,
          env: { printenv, [h.token]: 'under a key', [UNPATTERNED_KEY]: 'under a key' },
        },
      }),
    )
    const stored = JSON.stringify(h.store.snapshot())
    expect(stored).not.toContain(h.token)
    expect(stored).not.toContain(UNPATTERNED_KEY)
    // Field by field: what is not a secret still reads, and the card stays an object.
    expect(h.store.confirmations.get(body.confirmation_id)?.payload).toMatchObject({
      evidence: {
        auth: '[redacted:exact]',
        key: '[redacted:exact]',
        env: {
          // The sweep takes the whole run of non-space, name included: it errs toward hiding.
          printenv: 'MEC_TOOLS_TOKEN=[redacted:exact]\n[redacted:exact]\nHOME=/h',
          '[redacted:exact]': 'under a key',
        },
      },
    })
  })

  it('a class that carries a secret is stored without it', async () => {
    const h = await tools()
    const rpc = await h.call('request_confirmation', {
      operation: { class: h.token },
      evidence: { reason: 'r' },
    })
    expect(h.answer(rpc)).toMatchObject({ ok: true, status: 'pending' })
    expect(JSON.stringify(h.store.snapshot())).not.toContain(h.token)
  })

  it('a handback reason is redacted on the message and in the planner wake', async () => {
    const h = await tools()
    h.store.atomic(() => {
      h.store.messages.save({
        id: 'msg_1',
        ownerAttemptId: 'att_1',
        owned: true,
        workItemId: 'wi_1',
        text: 'please look',
      })
    })
    const reason = `not mine: ${h.token} ${UNPATTERNED_KEY}`
    expect(h.answer(await h.call('handback', { message_id: 'msg_1', reason }))).toEqual({ ok: true })
    expect(h.store.messages.get('msg_1')?.handback).toMatchObject({
      reason: 'not mine: [redacted:exact] [redacted:exact]',
    })
    const stored = JSON.stringify(h.store.snapshot())
    expect(stored).toContain('follow-up handed back')
    expect(stored).not.toContain(h.token)
    expect(stored).not.toContain(UNPATTERNED_KEY)
  })

  it('an always-confirm class is refused to a worker', async () => {
    const h = await tools()
    for (const cls of ['push', 'pr_merge', 'pr_create', 'branch_delete', 'force_op']) {
      const rpc = await h.call('request_confirmation', {
        operation: { class: cls },
        evidence: { reason: 'r' },
      })
      expect(rpc.result, cls).toBeUndefined()
      expect(rpc.error?.message).toContain('a worker cannot request it')
    }
    expect(h.store.confirmations.list()).toHaveLength(0)
  })

  it('a card with no evidence is refused', async () => {
    const h = await tools()
    const rpc = await h.call('request_confirmation', { operation: { class: 'install' }, evidence: {} })
    expect(rpc.error?.message).toContain('needs evidence')
  })

  it('a specialist has no tool that settles a card', async () => {
    const h = await tools()
    for (const tool of ['resolve_confirmation', 'approve', 'resolve']) {
      expect((await h.call(tool, { id: 'conf_1', answer: 'approve' })).result).toBeUndefined()
    }
  })

  it('ask_user opens one question, and the same text reuses it', async () => {
    const h = await tools()
    const first = h.answer(await h.call('ask_user', { question: 'Which table?' }))
    const again = h.answer(await h.call('ask_user', { question: 'Which table?' }))
    expect(first).toMatchObject({ ok: true, reused: false })
    expect(again).toMatchObject({ question_id: first.question_id, reused: true })
  })

  it('handback refuses a message this attempt does not own', async () => {
    const h = await tools()
    const rpc = await h.call('handback', { message_id: 'msg_x', reason: 'not mine' })
    expect(rpc.error?.message).toContain('not owned')
  })
})

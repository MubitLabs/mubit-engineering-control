import { TaskSpec, type TaskSpec as TaskSpecType } from '@mec/contracts'
import { ACTIVE_ATTEMPT_STATES, deliveryMachine } from '@mec/domain'
import type { FastifyBaseLogger } from 'fastify'
import type { Config } from '../../config'
import type { Sql, Tx } from '../../db/sql'
import { conflict } from '../../http/errors'
import { claimAttempt } from '../attempts/service'
import type { DeliveryRow } from '../plans/service'
import type { RunnerRegistry } from '../runners/registry'
import { transition } from '../state'
import type { GitHubApi } from './github'

interface WorkTask {
  id: string
  key: string
  title: string
  state: string
  spec: TaskSpecType
  acceptedSha: string | null
  updatedAt: Date
}

/** Why an integrated delivery has no pull request yet, in the order finalise() checks. */
export function pullRequestWait(
  delivery: { state: string; integrationSha: string | null; integrationPushedSha: string | null },
  opts: { hasPullRequest: boolean; github: GitHubApi | null; cloneUrl: string },
): string | null {
  if (delivery.state !== 'integrating' || !delivery.integrationSha || opts.hasPullRequest) return null
  if (delivery.integrationPushedSha !== delivery.integrationSha)
    return 'The integration branch was not pushed. Runners push only with MEC_GIT_TOKEN (or MEC_PUSH_BRANCHES=true) in runner.env; fix that or the network, restart the runner, then push again.'
  if (!opts.github) return 'The branch is pushed. Opening the pull request needs GITHUB_TOKEN in control.env.'
  if (!opts.github.supports(opts.cloneUrl))
    return 'The branch is pushed. Pull requests are opened only for github.com repositories.'
  return 'Opening the pull request.'
}

/**
 * The integration queue (PDF §14). For each executing delivery, under a single integration lease,
 * merge the next accepted task whose prerequisites are integrated into the delivery's integration
 * line and run the integration checks on the exact resulting SHA. One task per run keeps the
 * evidence and the blame clear. When everything is integrated and pushed, open the pull request,
 * then follow it until GitHub reports it merged or closed.
 */
export class Integrator {
  private timer: NodeJS.Timeout | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private running = false

  constructor(
    private readonly sql: Sql,
    private readonly registry: RunnerRegistry,
    private readonly config: Config,
    private readonly github: GitHubApi | null,
    private readonly log: FastifyBaseLogger,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), Math.max(this.config.scheduling.tickMs, 500))
    this.pollTimer = setInterval(() => void this.pollPulls(), 30_000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    if (this.pollTimer) clearInterval(this.pollTimer)
  }

  async tick(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      const deliveries = await this.sql<{ id: string }[]>`
        select id from deliveries where state in ('executing', 'integrating')
      `
      for (const d of deliveries) await this.sql.begin((tx) => this.advance(tx, d.id))
    } catch (err) {
      this.log.error({ err }, 'integration pass failed')
    } finally {
      this.running = false
    }
  }

  async advance(tx: Tx, deliveryId: string): Promise<void> {
    await tx`select pg_advisory_xact_lock(hashtext(${`mec.integration:${deliveryId}`}))`
    const [busy] = await tx`
      select 1 from attempts a join tasks t on t.id = a.task_id
      where t.delivery_id = ${deliveryId} and t.kind = 'integration'
        and a.state = any(${tx.array([...ACTIVE_ATTEMPT_STATES])})
    `
    if (busy) return
    const [delivery] = await tx<
      (DeliveryRow & { integrationSha: string | null; integrationPushedSha: string | null })[]
    >`
      select * from deliveries where id = ${deliveryId} for update
    `
    if (!delivery) return
    const tasks = await tx<WorkTask[]>`
      select id, key, title, state, spec, accepted_sha, updated_at from tasks
      where delivery_id = ${deliveryId} and kind = 'work' and state <> 'cancelled'
    `
    if (tasks.length > 0 && tasks.every((t) => t.state === 'integrated')) {
      await this.finalise(tx, delivery)
      return
    }
    const deps = await tx<{ taskId: string; dependsOnTaskId: string }[]>`
      select d.task_id, d.depends_on_task_id from task_dependencies d
      join tasks t on t.id = d.task_id where t.delivery_id = ${deliveryId}
    `
    const byId = new Map(tasks.map((t) => [t.id, t]))
    const next = tasks
      .filter((t) => t.state === 'accepted' && t.acceptedSha)
      .filter((t) =>
        deps
          .filter((d) => d.taskId === t.id)
          .every((d) => byId.get(d.dependsOnTaskId)?.state === 'integrated'),
      )
      .sort(
        (a, b) =>
          (a.spec.integrationOrder ?? 0) - (b.spec.integrationOrder ?? 0) ||
          a.updatedAt.getTime() - b.updatedAt.getTime() ||
          a.key.localeCompare(b.key),
      )[0]
    if (!next) return

    // The accepted commit lives on the runner that produced it (until branches are pushed).
    const [source] = await tx<{ runnerId: string; branch: string | null }[]>`
      select runner_id, branch from attempts where task_id = ${next.id} and head_sha = ${next.acceptedSha}
      order by number desc limit 1
    `
    const runnerId = source?.runnerId
    if (!runnerId || !this.registry.get(runnerId)) return
    await this.startRun(tx, delivery, runnerId, next.id, `Integrate ${next.key}`, [
      { taskId: next.id, taskKey: next.key, sha: next.acceptedSha!, branch: source.branch },
    ])
  }

  /**
   * Pushes an integration commit whose earlier push failed or was not configured: a run with
   * nothing to merge, on the runner that holds the commit, re-checks it and pushes it.
   */
  async retryPush(tx: Tx, deliveryId: string): Promise<void> {
    await tx`select pg_advisory_xact_lock(hashtext(${`mec.integration:${deliveryId}`}))`
    const [busy] = await tx`
      select 1 from attempts a join tasks t on t.id = a.task_id
      where t.delivery_id = ${deliveryId} and t.kind = 'integration'
        and a.state = any(${tx.array([...ACTIVE_ATTEMPT_STATES])})
    `
    if (busy) throw conflict('integration_busy', 'An integration run is already in progress')
    const [delivery] = await tx<
      (DeliveryRow & { integrationSha: string | null; integrationPushedSha: string | null })[]
    >`select * from deliveries where id = ${deliveryId} for update`
    if (
      !delivery?.integrationSha ||
      delivery.state !== 'integrating' ||
      delivery.integrationPushedSha === delivery.integrationSha
    )
      throw conflict('nothing_to_push', 'There is no unpushed integration commit')
    const [source] = await tx<{ runnerId: string }[]>`
      select a.runner_id from attempts a join tasks t on t.id = a.task_id
      where t.delivery_id = ${deliveryId} and t.kind = 'integration' and a.head_sha = ${delivery.integrationSha}
      order by a.created_at desc limit 1
    `
    if (!source || !this.registry.get(source.runnerId))
      throw conflict('runner_offline', 'The runner that holds the integration commit is not connected')
    const [latest] = await tx<{ id: string }[]>`
      select id from tasks where delivery_id = ${deliveryId} and kind = 'work' order by created_at desc limit 1
    `
    await this.startRun(tx, delivery, source.runnerId, latest!.id, 'Push integration branch', [])
  }

  private async startRun(
    tx: Tx,
    delivery: DeliveryRow,
    runnerId: string,
    revisionFrom: string,
    title: string,
    merges: { taskId: string; taskKey: string; sha: string; branch: string | null }[],
  ): Promise<void> {
    const [{ n }] = (await tx`
      select count(*)::int as n from tasks where delivery_id = ${delivery.id} and kind = 'integration'
    `) as unknown as [{ n: number }]
    const [task] = await tx<{ id: string }[]>`
      insert into tasks (delivery_id, plan_revision_id, key, title, spec, state, owner_id, kind)
      select ${delivery.id}, plan_revision_id, ${`mec-int-${n + 1}`}, ${title},
             ${tx.json(TaskSpec.parse({ key: 'integration', title: 'Integration', objective: title, maxAttempts: 1 }) as never)},
             'ready', ${delivery.ownerId}, 'integration'
      from tasks where id = ${revisionFrom}
      returning id
    `
    await claimAttempt(tx, {
      taskId: task!.id,
      runnerId,
      agentKind: 'none',
      kind: 'integration',
      inputs: { integration: { merges } },
      actor: { kind: 'system', id: 'integrator' },
      leaseMs: this.config.scheduling.leaseTtlMs,
    })
  }

  /** Everything is integrated: move to integrating and open the PR once the branch is on GitHub. */
  private async finalise(
    tx: Tx,
    delivery: DeliveryRow & { integrationSha: string | null; integrationPushedSha: string | null },
  ): Promise<void> {
    let state = delivery.state
    if (state === 'executing') {
      state = await transition(tx, {
        table: 'deliveries',
        machine: deliveryMachine,
        id: delivery.id,
        from: 'executing',
        event: 'integration_started',
        projectId: delivery.projectId,
        deliveryId: delivery.id,
        actor: { kind: 'system', id: 'integrator' },
        payload: { integrationSha: delivery.integrationSha },
      })
    }
    if (state !== 'integrating' || !delivery.integrationSha) return
    const [open] = await tx`select 1 from pull_requests where delivery_id = ${delivery.id} and state = 'open'`
    if (open || !this.github) return
    if (delivery.integrationPushedSha !== delivery.integrationSha) return
    const [repo] = await tx<
      { cloneUrl: string }[]
    >`select clone_url from repositories where id = ${delivery.repositoryId}`
    if (!this.github.supports(repo!.cloneUrl)) return

    const head = `mec/${delivery.id.slice(0, 8)}/integration`
    const pr = await this.github.createPull(repo!.cloneUrl, {
      head,
      base: delivery.baseRef,
      title: delivery.title,
      body: await pullRequestBody(tx, delivery, delivery.integrationSha, this.config.publicUrl),
    })
    await tx`
      insert into pull_requests (delivery_id, number, url, head_branch, head_sha, base_ref)
      values (${delivery.id}, ${pr.number}, ${pr.url}, ${head}, ${pr.headSha}, ${delivery.baseRef})
      on conflict (delivery_id, number) do nothing
    `
    await transition(tx, {
      table: 'deliveries',
      machine: deliveryMachine,
      id: delivery.id,
      from: 'integrating',
      event: 'pr_opened',
      projectId: delivery.projectId,
      deliveryId: delivery.id,
      actor: { kind: 'system', id: 'integrator' },
      payload: { number: pr.number, url: pr.url, headSha: pr.headSha },
    })
  }

  /** "Merged" is recorded only when GitHub says so (PDF §11, §14). */
  async pollPulls(): Promise<void> {
    if (!this.github) return
    const pulls = await this.sql<
      {
        id: string
        deliveryId: string
        number: number
        headSha: string
        cloneUrl: string
        projectId: string
        deliveryState: string
      }[]
    >`
      select p.id, p.delivery_id, p.number, p.head_sha, r.clone_url, d.project_id, d.state as delivery_state
      from pull_requests p join deliveries d on d.id = p.delivery_id join repositories r on r.id = d.repository_id
      where p.state = 'open'
    `
    for (const p of pulls) {
      if (!this.github.supports(p.cloneUrl)) continue
      try {
        const info = await this.github.getPull(p.cloneUrl, p.number)
        const checks = await this.github.checks(p.cloneUrl, info.headSha).catch(() => null)
        await this.sql.begin(async (tx) => {
          const state = info.merged ? 'merged' : info.state === 'closed' ? 'closed' : 'open'
          await tx`
            update pull_requests set state = ${state}, head_sha = ${info.headSha}, checks = ${tx.json((checks ?? null) as never)},
              merged_at = ${info.mergedAt ? new Date(info.mergedAt) : null}, last_polled_at = now(), updated_at = now()
            where id = ${p.id}
          `
          if (state === 'open' || p.deliveryState !== 'awaiting_merge') return
          await transition(tx, {
            table: 'deliveries',
            machine: deliveryMachine,
            id: p.deliveryId,
            from: 'awaiting_merge',
            event: state === 'merged' ? 'pr_merged' : 'pr_closed',
            projectId: p.projectId,
            deliveryId: p.deliveryId,
            actor: { kind: 'system', id: 'github' },
            payload: { number: p.number, mergedAt: info.mergedAt },
          })
        })
      } catch (err) {
        this.log.warn({ err, pull: p.number }, 'pull request poll failed')
      }
    }
  }
}

/** A clear change description: requirements, tasks, checks on the exact SHA, decisions (PDF §15). */
export async function pullRequestBody(
  tx: Tx,
  delivery: DeliveryRow,
  sha: string,
  publicUrl: string,
): Promise<string> {
  const [rev] = await tx<
    { number: number; requirements: { id: string; text: string }[]; tasks: TaskSpecType[] }[]
  >`
    select number, requirements, tasks from plan_revisions where delivery_id = ${delivery.id} and state = 'approved'
  `
  const tasks = await tx<{ key: string; title: string; acceptedSha: string | null }[]>`
    select key, title, accepted_sha from tasks where delivery_id = ${delivery.id} and kind = 'work' and state = 'integrated'
    order by key
  `
  const checks = await tx<{ name: string; status: string; durationMs: number }[]>`
    select name, status, duration_ms from check_results
    where delivery_id = ${delivery.id} and scope = 'integration' and tested_sha = ${sha}
    order by created_at
  `
  const decisions = await tx<
    {
      kind: string
      title: string
      status: string
      login: string | null
      answer: { answer?: string } | null
    }[]
  >`
    select a.kind, a.title, a.status, u.login, a.answer from approvals a left join users u on u.id = a.resolved_by
    where a.delivery_id = ${delivery.id} and a.kind in ('plan', 'question', 'result') and a.status <> 'stale'
    order by a.created_at
  `
  const covers = (id: string) =>
    rev?.tasks
      .filter((t) => t.requirementIds.includes(id))
      .map((t) => t.key)
      .join(', ') ?? ''
  return [
    `Delivery **${delivery.title}**, plan revision ${rev?.number ?? '?'}, integrated at \`${sha.slice(0, 12)}\`.`,
    '',
    `[Open the delivery in Mubit Engineering Control](${publicUrl}/projects/${delivery.projectId}/deliveries/${delivery.id}) for each task's diff, checks and transcript.`,
    '',
    '### Requirements',
    ...(rev?.requirements ?? []).map((r) => `- **${r.id}** ${r.text} — ${covers(r.id) || 'not covered'}`),
    '',
    '### Tasks',
    ...tasks.map((t) => `- **${t.key}** ${t.title} — accepted \`${t.acceptedSha?.slice(0, 10)}\``),
    '',
    `### Checks on \`${sha.slice(0, 12)}\``,
    ...(checks.length
      ? checks.map((c) => `- ${c.name}: **${c.status}** (${(c.durationMs / 1000).toFixed(1)}s)`)
      : ['- none configured']),
    '',
    '### Decisions',
    ...decisions.map(
      (d) =>
        `- ${d.kind}: ${d.title} — ${d.kind === 'result' ? (d.status === 'approved' ? 'accepted' : d.status === 'rejected' ? 'sent back' : d.status) : d.status}${d.login ? ` by ${d.login}` : ''}${d.answer?.answer ? ` (“${d.answer.answer.slice(0, 200)}”)` : ''}`,
    ),
    '',
    '_Prepared by Mubit Engineering Control. Repository branch protection and human review still apply._',
  ].join('\n')
}

import type { Tx } from '../db/sql'

export async function audit(
  tx: Tx,
  actorId: string | null,
  action: string,
  resourceKind: string,
  resourceId: string | null,
  projectId: string | null,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await tx`
    insert into audit_log (actor_id, action, resource_kind, resource_id, project_id, detail)
    values (${actorId}, ${action}, ${resourceKind}, ${resourceId}, ${projectId}, ${tx.json(detail as never)})
  `
}

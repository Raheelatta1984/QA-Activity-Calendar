import { all, run } from "./db";
import { uid } from "./ids";

export function recordAudit(input: {
  actorId?: string | null;
  actorName?: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  meta?: Record<string, unknown>;
}) {
  run(
    `INSERT INTO audit_events (id, actor_id, actor_name, action, entity, entity_id, before_json, after_json, meta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    uid("aud"),
    input.actorId ?? null,
    input.actorName ?? null,
    input.action,
    input.entity,
    input.entityId ?? null,
    input.before === undefined ? null : JSON.stringify(input.before),
    input.after === undefined ? null : JSON.stringify(input.after),
    input.meta ? JSON.stringify(input.meta) : null
  );
}

export function recentAudit(limit = 40) {
  return all(
    `SELECT * FROM audit_events ORDER BY at DESC LIMIT ?`,
    limit
  ) as Array<{
    id: string;
    actor_name: string | null;
    action: string;
    entity: string;
    entity_id: string | null;
    at: string;
    meta: string | null;
  }>;
}

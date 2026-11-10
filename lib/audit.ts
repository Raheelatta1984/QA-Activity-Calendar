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
  /** Explicit tenant for events whose actor belongs to a control-plane tenant. */
  companyId?: string | null;
}) {
  run(
    `INSERT INTO audit_events (id, actor_id, actor_name, action, entity, entity_id, before_json, after_json, meta, company_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, (SELECT d.company_id FROM people p JOIN departments d ON d.id = p.department_id WHERE p.id = ?)))`,
    uid("aud"),
    input.actorId ?? null,
    input.actorName ?? null,
    input.action,
    input.entity,
    input.entityId ?? null,
    input.before === undefined ? null : JSON.stringify(input.before),
    input.after === undefined ? null : JSON.stringify(input.after),
    input.meta ? JSON.stringify(input.meta) : null,
    input.companyId ?? null,
    input.actorId ?? null
  );
}

export function recentAudit(limit = 40, companyId?: string | null) {
  return all(
    `SELECT * FROM audit_events ${companyId ? "WHERE company_id = ?" : ""} ORDER BY at DESC LIMIT ?`,
    ...(companyId ? [companyId] : []),
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

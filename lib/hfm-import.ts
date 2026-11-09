import fs from "node:fs";
import path from "node:path";
import { all, get, run, setSetting, transaction } from "./db";
import { uid } from "./ids";
import { recordAudit } from "./audit";
import { inclusiveDays, isIsoDate, isValidRange } from "./dates";
import { runValidation } from "./validation";

/**
 * HFM seed/import — embedded source snapshot (2026-11-09, Australia/Sydney).
 *
 * This is the application-side implementation of the HFM database seed prompt.
 * It is idempotent (natural keys below), dry-run by default and explicit about
 * what is migration-owned (source snapshot fields) vs portal-owned (assignees
 * confirmed by a human, actual dates, progress, priorities) on re-run.
 *
 * Natural keys:
 *   company                     companies.code = 'HFM'
 *   entity                      entities(company_id, name)
 *   department                  departments(company_id, name)
 *   activity                    (company_id, source_dataset='tblActivities', external_source_id)
 *   pipeline                    (company_id, source_dataset='tblRecordingPipeline', external_source_id)
 *   manual exclusion            (pipeline_id, date)
 *
 * Conflict policy (documented in docs/HFM-IMPORT.md):
 *   - Source snapshot fields are refreshed from the embedded payload on every
 *     run; the report lists any change made to a non-null value as a conflict.
 *   - Portal-owned fields (assignee set by a human, actual dates, progress,
 *     priority) are never overwritten. A source assignee that resolves to a
 *     verified person only fills a NULL assignee.
 *   - verification_status on TEST-labelled pipeline rows is never downgraded:
 *     an existing 'Confirmed operational' survives re-import.
 *   - No sample tenant, demo row or non-HFM record is deleted or modified by
 *     this module. Sample cleanup is a separate, owner-approved action.
 */

const PAYLOAD_DIR = path.join(process.cwd(), "lib", "hfm");

export const SOURCE_METADATA = JSON.parse(
  fs.readFileSync(path.join(PAYLOAD_DIR, "source-metadata.json"), "utf8")
) as Record<string, unknown>;
export const ORGANISATION_PAYLOAD = JSON.parse(
  fs.readFileSync(path.join(PAYLOAD_DIR, "organisation.json"), "utf8")
) as {
  company: { name: string; code: string; aliases: string[]; is_default: boolean };
  entity: { name: string; company_code: string };
  department: { name: string; entity: string; company_code: string };
  employees: Array<{
    name: string;
    email: string | null;
    department: string;
    designation: string;
    role: string;
    role_scope: string;
    manager: string | null;
  }>;
};
export const EXPECTED_COUNTS = JSON.parse(
  fs.readFileSync(path.join(PAYLOAD_DIR, "expected-counts.json"), "utf8")
) as Record<string, number>;

function readJsonl<T>(file: string): T[] {
  const raw = fs.readFileSync(path.join(PAYLOAD_DIR, file), "utf8");
  return raw
    .split(/\r?\n/)
    .filter((line) => line.trim().length)
    .map((line, index) => {
      try {
        return JSON.parse(line) as T;
      } catch (error) {
        throw new Error(`${file} line ${index + 1}: ${(error as Error).message}`);
      }
    });
}

export const MASTER_ACTIVITY_ROWS = readJsonl<Record<string, unknown>>("master-activities.jsonl");
export const PIPELINE_ROWS = readJsonl<Record<string, unknown>>("pending-recordings-pipeline.jsonl");
export const MANUAL_EXCLUSION_ROWS = readJsonl<Record<string, unknown>>("pipeline-manual-exclusions.jsonl");

const MASTER_DATASET = "tblActivities";
const PIPELINE_DATASET = "tblRecordingPipeline";
const EXCLUSION_DATASET = "tblPipelineExclusions";
const MASTER_SHEET = "Master Activity Data";
const PIPELINE_SHEET = "Pending Recordings Pipeline";
const EXCLUSION_SHEET = "Pending Recordings Pipeline"; // exclusions live on the same sheet, tblPipelineExclusions

/** Accessible palette for raw source colour labels. Raw labels are always preserved in colour_label. */
export const SOURCE_COLOURS: Record<string, string> = {
  aqua: "#0891b2",
  blue: "#2563eb",
  green: "#16a34a",
  purple: "#9333ea",
  orange: "#ea580c",
  lime: "#65a30d",
  teal: "#0f766e",
  gold: "#ca8a04",
  cyan: "#0e7490",
  red: "#dc2626",
  "light turquoise": "#0d9488",
};

export function colourHex(label: unknown): { hex: string; known: boolean } {
  if (label === null || label === undefined) return { hex: "#64748b", known: false };
  const key = String(label).trim().toLowerCase();
  const hex = SOURCE_COLOURS[key];
  return hex ? { hex, known: true } : { hex: "#64748b", known: false };
}

const str = (v: unknown): string | null =>
  v === null || v === undefined ? null : String(v);
const trimmed = (v: unknown): string | null => {
  const s = str(v);
  return s === null ? null : s;
};
const norm = (v: unknown): string => (str(v) ?? "").trim().toLowerCase();
const dateOrNull = (v: unknown): string | null =>
  typeof v === "string" && isIsoDate(v) ? v : null;

export type ImportCounts = { inserted: number; updated: number; unchanged: number; skipped: number };
export type ImportConflict = { entity: string; id: string | null; field: string; source: unknown; current: unknown };
export type HfmReport = {
  mode: "dry-run" | "apply";
  requestedBy: string;
  executor: string;
  startedAt: string;
  finishedAt?: string;
  batchId: string | null;
  backupPath?: string | null;
  organisation: Record<string, unknown>;
  activities: ImportCounts;
  pipeline: ImportCounts;
  exclusions: ImportCounts;
  counts: { master: { total: number; active: number; inactive: number }; pipeline: number; exclusions: number };
  expected: Record<string, number>;
  conflicts: ImportConflict[];
  warnings: string[];
  errors: string[];
  unresolvedAssignees: string[];
  verification: VerificationResult | null;
};

export type VerificationResult = { checks: { name: string; pass: boolean; detail: string }[]; passed: number; failed: number };

const zero = (): ImportCounts => ({ inserted: 0, updated: 0, unchanged: 0, skipped: 0 });

type Ctx = {
  apply: boolean;
  actorId: string | null;
  actorName: string;
  batchId: string | null;
  warnings: string[];
  errors: string[];
  conflicts: ImportConflict[];
};

function warn(ctx: Ctx, message: string) {
  ctx.warnings.push(message);
}

// ---------------------------------------------------------------------------
// Organisation resolution
// ---------------------------------------------------------------------------
type OrgResolution = {
  companyId: string;
  entityId: string;
  departmentId: string;
  damienId: string;
  raheelId: string;
  actions: string[];
};

function resolveOrganisation(ctx: Ctx): OrgResolution {
  const payload = ORGANISATION_PAYLOAD;
  const actions: string[] = [];
  const companyActions: Record<string, unknown> = {};

  // --- company (stable key: code) -----------------------------------------
  let company = get<any>(`SELECT * FROM companies WHERE code = ?`, payload.company.code);
  if (!company) {
    // Accept an exact name-or-alias match only if it carries no conflicting code;
    // otherwise create a fresh company and leave anything else untouched.
    const byName = get<any>(
      `SELECT * FROM companies WHERE LOWER(name) = LOWER(?) OR LOWER(COALESCE(legal_name, '')) = LOWER(?) LIMIT 1`,
      payload.company.name,
      payload.company.name
    );
    if (byName && byName.code && byName.code !== payload.company.code) {
      throw new Error(
        `Company named '${byName.name}' already exists with different code '${byName.code}'. Resolve manually before importing; refusing to guess.`
      );
    }
    if (byName) {
      company = byName;
      actions.push(`reused company '${byName.name}' (id ${byName.id}) and attached code ${payload.company.code}`);
    }
  } else {
    actions.push(`reused company code ${payload.company.code} (id ${company.id})`);
  }

  const upsertCompany = () => {
    if (!company) {
      const id = uid("co");
      run(
        `INSERT INTO companies (id, name, legal_name, timezone, fiscal_start_month, aliases, is_default, code)
         VALUES (?, ?, NULL, 'Australia/Sydney', 7, ?, 0, ?)`,
        id,
        payload.company.name,
        JSON.stringify(payload.company.aliases),
        payload.company.code
      );
      company = get<any>(`SELECT * FROM companies WHERE id = ?`, id);
      actions.push(`created company '${payload.company.name}' (id ${id})`);
      companyActions.company = { action: "created", id };
    } else {
      companyActions.company = { action: "reused", id: company.id };
      // Migration-owned: name (if it was a safe exact match), aliases, code.
      if (company.name !== payload.company.name || company.code !== payload.company.code || company.aliases !== JSON.stringify(payload.company.aliases)) {
        run(
          `UPDATE companies SET name = ?, aliases = ?, code = ? WHERE id = ?`,
          payload.company.name,
          JSON.stringify(payload.company.aliases),
          payload.company.code,
          company.id
        );
        if (company.name !== payload.company.name) {
          ctx.conflicts.push({ entity: "company", id: company.id, field: "name", source: payload.company.name, current: company.name });
        }
        actions.push(`updated company ${company.id} name/aliases/code`);
      }
    }
    if (payload.company.is_default) {
      run(`UPDATE companies SET is_default = 0 WHERE is_default = 1 AND id <> ?`, company.id);
      run(`UPDATE companies SET is_default = 1 WHERE id = ?`, company.id);
      actions.push(`set '${payload.company.name}' as the application default company`);
    }
  };

  // --- entity ---------------------------------------------------------------
  const resolveEntity = () => {
    const row = get<any>(
      `SELECT * FROM entities WHERE company_id = ? AND LOWER(name) = LOWER(?) LIMIT 1`,
      company.id,
      payload.entity.name
    );
    if (row) {
      actions.push(`reused entity '${row.name}' (id ${row.id})`);
      companyActions.entity = { action: "reused", id: row.id };
      return row as any;
    }
    const id = uid("ent");
    run(`INSERT INTO entities (id, company_id, name) VALUES (?, ?, ?)`, id, company.id, payload.entity.name);
    actions.push(`created entity '${payload.entity.name}' (id ${id})`);
    companyActions.entity = { action: "created", id };
    return get<any>(`SELECT * FROM entities WHERE id = ?`, id);
  };

  // --- department -------------------------------------------------------------
  const resolveDepartment = (entityId: string) => {
    const row = get<any>(
      `SELECT * FROM departments WHERE company_id = ? AND LOWER(name) = LOWER(?) LIMIT 1`,
      company.id,
      payload.department.name
    );
    if (row) {
      if (!row.entity_id) {
        run(`UPDATE departments SET entity_id = ? WHERE id = ?`, entityId, row.id);
        actions.push(`linked department '${row.name}' to entity ${entityId}`);
      }
      actions.push(`reused department '${row.name}' (id ${row.id})`);
      companyActions.department = { action: "reused", id: row.id };
      return row as any;
    }
    const id = uid("dept");
    run(
      `INSERT INTO departments (id, company_id, entity_id, code, name, description, colour, enabled, sort_order)
       VALUES (?, ?, ?, 'HFM-ITQA', ?, 'HarrisFarm Markets IT QA team — imported from HFM seed', '#4f8cff', 1,
               (SELECT COALESCE(MAX(sort_order), 0) + 10 FROM departments))`,
      id,
      company.id,
      entityId,
      payload.department.name
    );
    actions.push(`created department '${payload.department.name}' (id ${id})`);
    companyActions.department = { action: "created", id };
    return get<any>(`SELECT * FROM departments WHERE id = ?`, id);
  };

  // --- employees ----------------------------------------------------------------
  // Damien first so Raheel can reference his id as manager.
  const upsertDamien = (departmentId: string) => {
    const spec = ORGANISATION_PAYLOAD.employees.find((e) => e.name === "Damien Milthorpe")!;
    let person = get<any>(`SELECT * FROM people WHERE LOWER(name) = LOWER(?) LIMIT 1`, spec.name);
    if (person && person.email) {
      // An email appeared on his profile — that is fine, we do not touch it.
      actions.push(`damien: existing profile already carries a verified email`);
    }
    if (!person) {
      const id = uid("p");
      run(
        `INSERT INTO people (id, department_id, manager_id, name, email, title, role, role_scope_department_id,
                             password_hash, capacity_hours_day, colour, active, is_demo, source_dataset, external_source_id)
         VALUES (?, ?, NULL, ?, NULL, ?, 'department_admin', ?, NULL, 7.6, '#0ea5e9', 1, 0, 'hfm-seed', ?)`,
        id,
        departmentId,
        spec.name,
        spec.designation,
        departmentId,
        "hfm:employee:damien-milthorpe"
      );
      person = get<any>(`SELECT * FROM people WHERE id = ?`, id);
      actions.push(`created Damien Milthorpe profile (id ${person.id}) — email NULL until verified, no login issued`);
      companyActions.damien = { action: "created", id: person.id };
      recordAudit({
        actorId: ctx.actorId, actorName: ctx.actorName,
        action: "person.create", entity: "person", entityId: person.id,
        after: { name: spec.name, role: "department_admin", role_scope_department_id: departmentId, email: null },
        meta: { source: "hfm-seed" },
      });
      return person.id as string;
    }
    const changes: Record<string, unknown> = {};
    if (person.department_id !== departmentId) changes.department_id = departmentId;
    if (person.role !== "department_admin") changes.role = "department_admin";
    if (person.role_scope_department_id !== departmentId) changes.role_scope_department_id = departmentId;
    if (person.title !== spec.designation) changes.title = spec.designation;
    if (person.manager_id) changes.manager_id = null;
    if (Object.keys(changes).length) {
      run(
        `UPDATE people SET department_id = ?, role = 'department_admin', role_scope_department_id = ?, title = ?, manager_id = NULL WHERE id = ?`,
        departmentId,
        departmentId,
        spec.designation,
        person.id
      );
      for (const [field, to] of Object.entries(changes)) {
        if (person[field] !== null && person[field] !== changes[field]) {
          ctx.conflicts.push({ entity: "person", id: person.id, field, source: to, current: person[field] });
        }
      }
      actions.push(`updated Damien Milthorpe (id ${person.id}): ${Object.keys(changes).join(", ")}`);
      recordAudit({
        actorId: ctx.actorId, actorName: ctx.actorName,
        action: "person.role_grant", entity: "person", entityId: person.id,
        before: { role: person.role, department_id: person.department_id, title: person.title },
        after: { role: "department_admin", role_scope_department_id: departmentId },
        meta: { source: "hfm-seed", designation: spec.designation },
      });
    } else {
      actions.push(`Damien Milthorpe unchanged (id ${person.id})`);
    }
    if (!person.password_hash) warn(ctx, "Damien Milthorpe has no verified email and no password — profile is unprivileged for login until identity verification and an invitation are issued by the owner.");
    return person.id as string;
  };

  const upsertRaheel = (departmentId: string, damienId: string) => {
    const spec = ORGANISATION_PAYLOAD.employees.find((e) => e.email)!;
    const email = spec.email!;
    // Identity is matched case-insensitively on the verified supplied email.
    let person = get<any>(`SELECT * FROM people WHERE LOWER(email) = LOWER(?) LIMIT 1`, email);
    if (!person) {
      const byName = get<any>(`SELECT * FROM people WHERE LOWER(name) = LOWER(?) LIMIT 1`, spec.name);
      if (byName) {
        if (byName.email && byName.email.toLowerCase() !== email.toLowerCase()) {
          throw new Error(
            `A profile named '${spec.name}' exists with a different email (${byName.email}). Refusing to re-point identity; resolve manually.`
          );
        }
        person = byName;
      }
    }
    if (!person) {
      const id = uid("p");
      run(
        `INSERT INTO people (id, department_id, manager_id, name, email, title, role, role_scope_department_id,
                             password_hash, capacity_hours_day, colour, active, is_demo, source_dataset, external_source_id)
         VALUES (?, ?, ?, ?, ?, ?, 'admin', NULL, NULL, 7.6, '#2563eb', 1, 0, 'hfm-seed', ?)`,
        id,
        departmentId,
        damienId,
        spec.name,
        email,
        spec.designation,
        `hfm:employee:${email.toLowerCase()}`
      );
      person = get<any>(`SELECT * FROM people WHERE id = ?`, id);
      actions.push(`created Raheel Atta profile (id ${person.id}) with admin (application) role — invitation/password required before login`);
      companyActions.raheel = { action: "created", id: person.id };
      recordAudit({
        actorId: ctx.actorId, actorName: ctx.actorName,
        action: "person.create", entity: "person", entityId: person.id,
        after: { name: spec.name, email, role: "admin", manager_id: damienId },
        meta: { source: "hfm-seed", note: "APPLICATION_ADMIN mapped to application 'admin' role" },
      });
      warn(ctx, "Raheel Atta can be signed in only after an invitation/password is issued — the import never sets passwords.");
      return person.id as string;
    }
    const changes: Record<string, unknown> = {};
    if (person.department_id !== departmentId) changes.department_id = departmentId;
    if (person.manager_id !== damienId) changes.manager_id = damienId;
    if (person.title !== spec.designation) changes.title = spec.designation;
    if (person.role !== "admin") changes.role = "admin";           // APPLICATION_ADMIN ≡ application 'admin'
    if (person.role_scope_department_id !== null) changes.role_scope_department_id = null;
    if (!person.email) changes.email = email;                        // attach supplied email to a previously email-less profile
    if (person.is_demo) changes.is_demo = 0;
    if (Object.keys(changes).length) {
      run(
        `UPDATE people SET department_id = ?, manager_id = ?, title = ?, role = 'admin',
                role_scope_department_id = NULL, email = COALESCE(email, ?), is_demo = 0, active = 1 WHERE id = ?`,
        departmentId,
        damienId,
        spec.designation,
        email,
        person.id
      );
      for (const [field, to] of Object.entries(changes)) {
        if (person[field] !== null && person[field] !== changes[field]) {
          ctx.conflicts.push({ entity: "person", id: person.id, field, source: to, current: person[field] });
        }
      }
      actions.push(`updated Raheel Atta (id ${person.id}): ${Object.keys(changes).join(", ")}`);
      recordAudit({
        actorId: ctx.actorId, actorName: ctx.actorName,
        action: "person.role_grant", entity: "person", entityId: person.id,
        before: { role: person.role, department_id: person.department_id, manager_id: person.manager_id, title: person.title },
        after: { role: "admin", department_id: departmentId, manager_id: damienId },
        meta: { source: "hfm-seed", designation: spec.designation },
      });
    } else {
      actions.push(`Raheel Atta unchanged (id ${person.id})`);
    }
    return person.id as string;
  };

  // --- execute (dry-run simulates against a read-only view of current state) ---
  if (!ctx.apply) {
    // Compute existence without writing so the dry-run report is truthful.
    const existingCompany = company ?? get<any>(`SELECT * FROM companies WHERE code = ?`, payload.company.code);
    const existingEntity = existingCompany
      ? get<any>(`SELECT * FROM entities WHERE company_id = ? AND LOWER(name) = LOWER(?)`, existingCompany.id, payload.entity.name)
      : null;
    const existingDept = existingCompany
      ? get<any>(`SELECT * FROM departments WHERE company_id = ? AND LOWER(name) = LOWER(?)`, existingCompany.id, payload.department.name)
      : null;
    const damien = get<any>(`SELECT * FROM people WHERE LOWER(name) = LOWER('Damien Milthorpe') LIMIT 1`);
    const raheel = get<any>(`SELECT * FROM people WHERE LOWER(email) = LOWER(?) LIMIT 1`, ORGANISATION_PAYLOAD.employees[1].email);
    actions.push(`dry-run: company ${existingCompany ? "exists (reuse)" : "would be created"}; entity ${existingEntity ? "exists (reuse)" : "would be created"}; department ${existingDept ? "exists (reuse)" : "would be created"}`);
    actions.push(`dry-run: Damien ${damien ? `exists (id ${damien.id}) → role department_admin scoped to HFM IT QA` : "would be created with email NULL (unprivileged for login)"}`);
    actions.push(`dry-run: Raheel ${raheel ? `exists (id ${raheel.id}) → role admin (application)` : "would be created with email " + ORGANISATION_PAYLOAD.employees[1].email + " and role admin (application); password/invitation required"}`);
    actions.push(`dry-run: default company would be set to ${payload.company.name} (others cleared); default department set to ${payload.department.name}`);
    return {
      companyId: existingCompany?.id ?? "(new)",
      entityId: existingEntity?.id ?? "(new)",
      departmentId: existingDept?.id ?? "(new)",
      damienId: damien?.id ?? "(new)",
      raheelId: raheel?.id ?? "(new)",
      actions,
    };
  }

  upsertCompany();
  const entity = resolveEntity();
  const department = resolveDepartment(entity.id);
  const damienId = upsertDamien(department.id);
  const raheelId = upsertRaheel(department.id, damienId);
  setSetting("default_company_id", company.id);
  setSetting("default_entity_id", entity.id);
  setSetting("default_department_id", department.id);
  setSetting("default_department_name", payload.department.name);
  recordAudit({
    actorId: ctx.actorId,
    actorName: ctx.actorName,
    action: "settings.default_company",
    entity: "company",
    entityId: company.id,
    meta: { company: payload.company.name, department: payload.department.name, note: "HFM is the landing company; no cross-company access granted" },
  });
  return { companyId: company.id, entityId: entity.id, departmentId: department.id, damienId, raheelId, actions };
}

// ---------------------------------------------------------------------------
// Row mapping helpers
// ---------------------------------------------------------------------------

function resolveAssignee(label: unknown, raheelId: string | null): { personId: string | null; review: boolean; raw: string | null } {
  const raw = trimmed(label);
  if (raw === null || raw.trim() === "") return { personId: null, review: false, raw: null };
  if (norm(raw) === "raheel") return { personId: raheelId, review: false, raw };
  return { personId: null, review: true, raw };
}

type PreparedActivity = {
  next: Record<string, unknown>;
  warnings: string[];
  externalId: string;
  sourceOrder: number;
  reviewAssignee: boolean;
};

function prepareActivity(row: Record<string, unknown>, index: number, raheelId: string | null): PreparedActivity {
  const warnings: string[] = [];
  const externalId = trimmed(row["Calendar Item ID"]);
  if (!externalId) warnings.push(`row ${row.source_excel_row}: missing Calendar Item ID — staged for review, not published silently`);
  const startRaw = str(row["Start Date"]);
  const endRaw = str(row["End Date"]);
  const start = dateOrNull(row["Start Date"]);
  const end = dateOrNull(row["End Date"]);
  if (startRaw && !start) warnings.push(`${externalId ?? "row " + row.source_excel_row}: invalid Start Date '${startRaw}' — stored as unscheduled`);
  if (endRaw && !end) warnings.push(`${externalId ?? "row " + row.source_excel_row}: invalid End Date '${endRaw}' — stored as unscheduled`);
  if (start && end && start > end) {
    warnings.push(`${externalId}: start ${start} is after end ${end} — stored as unscheduled`);
  }
  // Preserve whichever dates are valid. Only a reversed range is discarded
  // (and flagged) — a missing end date never nulls out the known start.
  const bothPresentButReversed = !!start && !!end && start > end;
  const effectiveStart = bothPresentButReversed ? null : start;
  const effectiveEnd = bothPresentButReversed ? null : end;
  const scheduled = isValidRange(effectiveStart, effectiveEnd);
  const sourceDuration = typeof row["Duration"] === "number" ? (row["Duration"] as number) : null;
  if (sourceDuration === null && row["Duration"] !== null && row["Duration"] !== undefined) {
    warnings.push(`${externalId}: Duration '${String(row["Duration"])}' is not a number — source duration preserved as NULL`);
  }
  // Source quirk: Duration 0 with a missing end date is a calculation artifact —
  // source_duration_days keeps 0, effective_duration_days stays NULL.
  // With both dates valid, effective duration is computed inclusively.
  const effective = scheduled ? inclusiveDays(effectiveStart!, effectiveEnd!) : null;
  if (sourceDuration === 0 && !end) {
    warnings.push(`${externalId}: source Duration 0 with missing end date — preserved as source_duration_days=0, effective_duration_days=NULL`);
  }
  const activeRaw = str(row["Active Status"]);
  const active = norm(activeRaw) === "active" ? 1 : norm(activeRaw) === "inactive" ? 0 : (() => {
    warnings.push(`${externalId}: unexpected Active Status '${activeRaw}' — staged as Inactive for safety`);
    return 0;
  })();
  const statusRaw = str(row["Status"]);
  const status = statusRaw ?? "Draft";
  if (statusRaw === null) warnings.push(`${externalId}: blank Status — staged as 'Draft', raw status preserved as NULL`);
  let fte = typeof row["FTE"] === "number" ? (row["FTE"] as number) : NaN;
  if (!Number.isFinite(fte) || fte < 0 || fte > 5) {
    warnings.push(`${externalId}: FTE '${String(row["FTE"])}' is invalid (expected 0–5) — stored as 0.5, raw snapshot kept in import_rows`);
    fte = 0.5;
  }
  const colourLabel = str(row["Colour"]);
  const { hex, known } = colourHex(colourLabel);
  if (colourLabel && !known) warnings.push(`${externalId}: unsupported colour '${colourLabel}' — mapped to neutral palette, raw label preserved`);
  const group = trimmed(row["Activity Group"]) ?? "Imported";
  if (!trimmed(row["Activity Group"])) warnings.push(`${externalId}: missing Activity Group — staged as 'Imported'`);
  const activityName = trimmed(row["Activity"]) ?? "(missing source Activity)";
  if (!trimmed(row["Activity"])) warnings.push(`row ${row.source_excel_row}: missing Activity name`);
  const assignee = resolveAssignee(row["Assing To"], raheelId);
  const notes = str(row["Notes"]); // raw, embedded newlines and HTML entities preserved as data
  const dataQuality = str(row["Data Quality"]);
  const next: Record<string, unknown> = {
    code: externalId,
    activity: activityName,
    detail: str(row["Activity Detail"]),
    activity_group: group,
    rule_type: str(row["Rule Type"]),
    active,
    source_active_status: activeRaw,
    start_date: effectiveStart,
    end_date: effectiveEnd,
    duration_days: effective,
    source_duration_days: sourceDuration,
    effective_duration_days: effective,
    fte,
    colour: hex,
    colour_label: colourLabel,
    assignee_id: assignee.personId,
    status,
    source_status_raw: statusRaw,
    notes,
    data_quality: dataQuality,
    source_data_quality: dataQuality,
    source_assignee_text: assignee.raw,
    source_sheet: MASTER_SHEET,
    source_row: typeof row.source_excel_row === "number" ? (row.source_excel_row as number) : null,
    source_order: index,
    source_dataset: MASTER_DATASET,
    external_source_id: externalId,
    calendar_item_id: externalId,
    is_demo: 0,
  };
  return { next, warnings, externalId: externalId ?? `row-${row.source_excel_row}`, sourceOrder: index, reviewAssignee: assignee.review };
}

type PreparedPipeline = {
  next: Record<string, unknown>;
  warnings: string[];
  externalId: string;
  sourceOrder: number;
};

function dateField(row: Record<string, unknown>, key: string, externalId: string, warnings: string[]): string | null {
  const raw = str(row[key]);
  const parsed = dateOrNull(row[key]);
  if (raw && !parsed) warnings.push(`${externalId}: invalid ${key} '${raw}' — stored as NULL (raw snapshot kept)`);
  return parsed;
}

function preparePipeline(row: Record<string, unknown>, index: number): PreparedPipeline {
  const warnings: string[] = [];
  const externalId = trimmed(row["Pipeline ID"])!;
  const activity = trimmed(row["Recording Pipeline Item / Activity"]) ?? "(missing source title)";
  if (!trimmed(row["Recording Pipeline Item / Activity"])) warnings.push(`row ${row.source_excel_row}: missing pipeline title`);
  const plannedStart = dateField(row, "Planned Start Date", externalId, warnings);
  const plannedEnd = dateField(row, "Planned End Date", externalId, warnings);
  const actualStart = dateField(row, "Actual Start Date", externalId, warnings);
  const actualEnd = dateField(row, "Actual End Date", externalId, warnings);
  if (isValidRange(plannedStart, plannedEnd) === false && plannedStart && plannedEnd) {
    warnings.push(`${externalId}: planned start ${plannedStart} is after planned end ${plannedEnd}`);
  }
  if (isValidRange(actualStart, actualEnd) === false && actualStart && actualEnd) {
    warnings.push(`${externalId}: actual start ${actualStart} is after actual end ${actualEnd}`);
  }
  let fraction: number | null = null;
  if (row["Automation %"] === null || row["Automation %"] === undefined) {
    fraction = null; // unknown automation — NULL, never zero
  } else if (typeof row["Automation %"] === "number" && Number.isFinite(row["Automation %"] as number)) {
    const value = row["Automation %"] as number;
    if (value >= 0 && value <= 1) fraction = value;
    else warnings.push(`${externalId}: Automation % value ${value} is outside [0,1] — stored as NULL`);
  } else {
    warnings.push(`${externalId}: Automation % '${String(row["Automation %"])}' is not a number — stored as NULL`);
  }
  const colourLabel = str(row["Colour"]);
  const { hex, known } = colourHex(colourLabel);
  if (colourLabel && !known) warnings.push(`${externalId}: unsupported colour '${colourLabel}' — mapped to neutral palette, raw label preserved`);
  const sourceDuration = typeof row["Duration Days"] === "number" ? (row["Duration Days"] as number) : null;
  const isTest = /^TEST-/i.test(externalId) ? 1 : 0;
  if (!isTest) warnings.push(`${externalId}: does not carry the expected TEST- label — check this row before operational use`);
  const next: Record<string, unknown> = {
    code: externalId,
    activity,
    detail: str(row["Details"]),
    activity_group: str(row["Activity Group"]),
    applications_raw: str(row["Application(s)"]),
    planned_start: plannedStart,
    planned_end: plannedEnd,
    actual_start: actualStart,
    actual_end: actualEnd,
    duration_days: sourceDuration !== null ? sourceDuration : null,
    source_duration_days: sourceDuration,
    recording_status: str(row["Recording Status"]),
    current_status: str(row["Current Status"]),
    automation_percent: fraction === null ? null : Math.round(fraction * 100),
    automation_fraction: fraction,
    blocker: str(row["Current Blockers"]),
    colour: hex,
    colour_label: colourLabel,
    is_test: isTest,
    source_test_label: isTest,
    notes: null,
    data_quality_warning: str(row["Data Quality Warning"]),
    overlap_warning: str(row["Overlap Warning"]),
    excluded_priority_work_dates: str(row["Excluded Priority Work Dates"]), // raw snapshot, NEVER parsed into manual exclusions
    source_sheet: PIPELINE_SHEET,
    source_row: typeof row.source_excel_row === "number" ? (row.source_excel_row as number) : null,
    source_order: index,
    source_dataset: PIPELINE_DATASET,
    external_source_id: externalId,
  };
  return { next, warnings, externalId, sourceOrder: index };
}

// ---------------------------------------------------------------------------
// Generic source-owned upsert
// ---------------------------------------------------------------------------

function upsertRow(ctx: Ctx, table: "activities" | "recording_pipeline", key: { companyId: string; dataset: string; externalId: string }, nextIn: Record<string, unknown>, extra: { departmentId: string; batchId: string | null }): { id: string; outcome: "inserted" | "updated" | "unchanged" } {
  // TEST-labelled pipeline rows always stage as 'Needs operational confirmation'.
  const next = { ...nextIn };
  if (table === "recording_pipeline" && typeof next.is_test === "number" && (next.is_test as number) === 1) {
    next.verification_status = "Needs operational confirmation";
  }
  const existing = get<any>(
    `SELECT * FROM ${table} WHERE company_id = ? AND source_dataset = ? AND external_source_id = ? LIMIT 1`,
    key.companyId,
    key.dataset,
    key.externalId
  );
  if (!existing) {
    const id = uid(table === "activities" ? "act" : "pipe");
    const cols = Object.keys(next);
    const allCols = ["id", ...cols, "company_id", "department_id", "import_batch_id"];
    run(
      `INSERT INTO ${table} (${allCols.join(", ")}) VALUES (${allCols.map(() => "?").join(", ")})`,
      id,
      ...cols.map((c) => next[c]),
      key.companyId,
      extra.departmentId,
      extra.batchId
    );
    return { id, outcome: "inserted" };
  }
  // Migration-owned fields refresh; portal-owned fields are preserved:
  //   activities: assignee_id only filled when currently NULL and source resolved one
  //   pipeline:   verification_status never downgraded; duration_days refreshed from source snapshot
  const changes: Record<string, unknown> = {};
  for (const [col, value] of Object.entries(next)) {
    if (col === "assignee_id" || col === "verification_status") continue;
    if (col === "duration_days" && table === "recording_pipeline") {
      // legacy slot mirrors the source snapshot; effective value is computed live
    }
    if ((existing[col] ?? null) !== (value ?? null)) changes[col] = value;
  }
  const sourceAssignee = next.assignee_id as string | null;
  if (sourceAssignee && !existing.assignee_id) {
    changes.assignee_id = sourceAssignee;
  } else if (sourceAssignee && existing.assignee_id && existing.assignee_id !== sourceAssignee) {
    ctx.conflicts.push({ entity: table, id: existing.id, field: "assignee_id", source: sourceAssignee, current: existing.assignee_id });
  }
  if (table === "recording_pipeline" && existing.verification_status === "Confirmed operational") {
    // preserved — never downgraded by re-import
  } else if (table === "recording_pipeline" && !existing.verification_status) {
    changes.verification_status = "Needs operational confirmation";
  }
  // Department is migration-owned on first import, portal-owned afterwards:
  // a manually moved row is never silently re-parented by a re-import. The
  // divergence is recorded as a conflict (it appears in the report) instead of
  // being overwritten. Re-parenting deliberately back to the source department
  // before a re-import re-establishes source ownership with no conflict.
  if (existing.department_id !== extra.departmentId) {
    ctx.conflicts.push({ entity: table, id: existing.id, field: "department_id", source: extra.departmentId, current: existing.department_id });
  }
  if (Object.keys(changes).length === 0) return { id: existing.id, outcome: "unchanged" };
  for (const [field, to] of Object.entries(changes)) {
    const current = existing[field] ?? null;
    if (current !== null && JSON.stringify(current) !== JSON.stringify(to ?? null)) {
      if (ctx.conflicts.length < 200) {
        ctx.conflicts.push({ entity: table, id: existing.id, field, source: to, current });
      }
    }
  }
  const cols = Object.keys(changes);
  run(
    `UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(", ")}, import_batch_id = ? WHERE id = ?`,
    ...cols.map((c) => changes[c]),
    extra.batchId,
    existing.id
  );
  return { id: existing.id, outcome: "updated" };
}

// ---------------------------------------------------------------------------
// Manual exclusions
// ---------------------------------------------------------------------------

function importExclusions(ctx: Ctx, apply: boolean, companyId: string, pipelineIdByExternal: Map<string, string>, counts: ImportCounts): { rows: { externalId: string; disposition: string }[] } {
  const rows: { externalId: string; disposition: string }[] = [];
  MANUAL_EXCLUSION_ROWS.forEach((row) => {
    const externalId = trimmed(row["Pipeline ID"]) ?? "(unknown)";
    // In a dry-run on a not-yet-imported dataset the pipeline rows do not exist
    // yet — they would be inserted in the same apply run, so the exclusion would
    // link. Treat that as 'inserted' rather than screaming unknown-pipeline.
    const pipelineId = pipelineIdByExternal.get(externalId) ?? (apply ? undefined : "(pending insert)");
    const date = dateOrNull(row["Excluded Date"]);
    const rawDate = str(row["Excluded Date"]);
    const reason = str(row["Reason / Priority Work"]) ?? "";
    if (!pipelineId) {
      ctx.warnings.push(`exclusion row ${row.source_excel_row}: unknown Pipeline ID '${externalId}' — staged nowhere; kept in report`);
      counts.skipped += 1;
      rows.push({ externalId, disposition: "error: unknown pipeline id" });
      return;
    }
    if (!date) {
      ctx.warnings.push(`exclusion ${externalId}: invalid date '${rawDate}' — skipped`);
      counts.skipped += 1;
      rows.push({ externalId, disposition: "error: invalid date" });
      return;
    }
    const planned = pipelineId.startsWith("(pending") ? null : get<any>(`SELECT planned_start, planned_end FROM recording_pipeline WHERE id = ?`, pipelineId);
    if (planned?.planned_start && planned?.planned_end && (date < planned.planned_start || date > planned.planned_end)) {
      ctx.warnings.push(`exclusion ${externalId} ${date}: outside the pipeline's planned range (${planned.planned_start}…${planned.planned_end}) — imported anyway, flagged for review`);
    }
    if (apply) {
      const existing = get<any>(
        `SELECT * FROM pipeline_exclusions WHERE pipeline_id = ? AND date = ?`,
        pipelineId,
        date
      );  // apply: pipelineId is a real id by now
      if (existing) {
        if (existing.reason === reason && existing.exclusion_warning === str(row["Exclusion Warning"])) {
          counts.unchanged += 1;
          rows.push({ externalId, disposition: "unchanged" });
        } else {
          ctx.conflicts.push({ entity: "pipeline_exclusion", id: existing.id, field: "reason", source: reason, current: existing.reason });
          run(
            `UPDATE pipeline_exclusions SET reason = ?, exclusion_warning = ?, source_dataset = ?, source_row = ?, import_batch_id = ? WHERE id = ?`,
            reason,
            str(row["Exclusion Warning"]),
            EXCLUSION_DATASET,
            typeof row.source_excel_row === "number" ? (row.source_excel_row as number) : null,
            ctx.batchId,
            existing.id
          );
          counts.updated += 1;
          rows.push({ externalId, disposition: "updated (source snapshot refreshed)" });
        }
      } else {
        run(
          `INSERT INTO pipeline_exclusions (id, pipeline_id, date, reason, created_by, source_dataset, source_row, exclusion_warning, import_batch_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          uid("exc"),
          pipelineId,
          date,
          reason,
          ctx.actorId,
          EXCLUSION_DATASET,
          typeof row.source_excel_row === "number" ? (row.source_excel_row as number) : null,
          str(row["Exclusion Warning"]),
          ctx.batchId
        );
        counts.inserted += 1;
        rows.push({ externalId, disposition: "inserted" });
      }
    } else {
      const existing = pipelineId.startsWith("(pending")
        ? null
        : get<any>(
            `SELECT id FROM pipeline_exclusions WHERE pipeline_id = ? AND date = ?`,
            pipelineId,
            date
          );
      if (existing) counts.unchanged += 1;
      else counts.inserted += 1;
      rows.push({ externalId, disposition: existing ? "unchanged" : "inserted" });
    }
  });
  return { rows };
}

// ---------------------------------------------------------------------------
// Import orchestration
// ---------------------------------------------------------------------------

export type RunOptions = {
  apply: boolean;
  actorId?: string | null;
  actorName?: string | null;
  requestedBy?: string;
  /** Backup path created before the apply (informational; the CLI performs the backup). */
  backupPath?: string | null;
};

export function runHfmImport(options: RunOptions): HfmReport {
  const apply = Boolean(options.apply);
  const startedAt = new Date().toISOString();
  const requestedBy = options.requestedBy ?? "Raheel Atta";
  // The real executor is always recorded; a service run names itself.
  const executor = options.actorName
    ? `${options.actorName}${options.actorId ? ` (${options.actorId})` : ""}`
    : process.env.HFM_IMPORT_EXECUTOR ?? "service:hfm-import (scripts/hfm-import.ts)";

  // Payload sanity: fail loudly if the embedded source does not match expectations.
  const payloadProblems: string[] = [];
  if (MASTER_ACTIVITY_ROWS.length !== EXPECTED_COUNTS.master_activities) payloadProblems.push(`master payload holds ${MASTER_ACTIVITY_ROWS.length} rows, expected ${EXPECTED_COUNTS.master_activities}`);
  if (PIPELINE_ROWS.length !== EXPECTED_COUNTS.pending_pipeline) payloadProblems.push(`pipeline payload holds ${PIPELINE_ROWS.length} rows, expected ${EXPECTED_COUNTS.pending_pipeline}`);
  if (MANUAL_EXCLUSION_ROWS.length !== EXPECTED_COUNTS.manual_exclusions) payloadProblems.push(`exclusion payload holds ${MANUAL_EXCLUSION_ROWS.length} rows, expected ${EXPECTED_COUNTS.manual_exclusions}`);

  const counts = { master: zero(), pipeline: zero(), exclusions: zero() };
  const result: HfmReport = {
    mode: apply ? "apply" : "dry-run",
    requestedBy,
    executor,
    startedAt,
    batchId: null,
    backupPath: options.backupPath ?? null,
    organisation: {},
    activities: counts.master,
    pipeline: counts.pipeline,
    exclusions: counts.exclusions,
    counts: { master: { total: 0, active: 0, inactive: 0 }, pipeline: 0, exclusions: 0 },
    expected: EXPECTED_COUNTS,
    conflicts: [],
    warnings: [...payloadProblems],
    errors: [],
    unresolvedAssignees: [],
    verification: null,
  };

  if (payloadProblems.length) {
    result.errors = payloadProblems;
    return result; // never stage a payload that does not match its own checksums
  }

  const ctx: Ctx = {
    apply,
    actorId: options.actorId ?? null,
    actorName: options.actorName ?? executor,
    batchId: null,
    warnings: result.warnings,
    errors: result.errors,
    conflicts: result.conflicts,
  };

  const work = () => {
    const org = resolveOrganisation(ctx);
    result.organisation = { ...org, actions: org.actions };
    if (apply) {
      const batchId = uid("imp");
      run(
        `INSERT INTO import_batches (id, filename, mode, source_system, rows_total, status, requested_by, executor, report_path)
         VALUES (?, ?, 'apply', ?, ?, 'running', ?, ?, ?)`,
        batchId,
        "embedded:master-activities.jsonl + pending-recordings-pipeline.jsonl + pipeline-manual-exclusions.jsonl",
        `Excel workbook snapshot ${String(SOURCE_METADATA.snapshot_at)} (${String(SOURCE_METADATA.timezone)})`,
        MASTER_ACTIVITY_ROWS.length + PIPELINE_ROWS.length + MANUAL_EXCLUSION_ROWS.length,
        requestedBy,
        executor,
        null
      );
      ctx.batchId = batchId;
      result.batchId = batchId;
    }

    const companyId = org.companyId;
    const departmentId = apply ? org.departmentId : (get<any>(`SELECT id FROM departments WHERE company_id = ? AND LOWER(name) = LOWER('HFM IT QA') LIMIT 1`, companyId)?.id ?? "(new)");

    // --- activities -------------------------------------------------------
    const activityIds = new Map<string, string>();
    MASTER_ACTIVITY_ROWS.forEach((row, index) => {
      const prepared = prepareActivity(row, index, org.raheelId === "(new)" ? null : org.raheelId);
      prepared.warnings.forEach((w) => warn(ctx, w));
      if (apply) {
        const { id, outcome } = upsertRow(ctx, "activities", { companyId, dataset: MASTER_DATASET, externalId: prepared.externalId }, prepared.next, { departmentId, batchId: ctx.batchId });
        counts.master[outcome] += 1;
        activityIds.set(prepared.externalId, id);
        if (ctx.batchId) {
          run(
            `INSERT INTO import_rows (id, batch_id, sheet, row_number, raw_json, target_table, target_id, status, message)
             VALUES (?, ?, ?, ?, ?, 'activities', ?, ?, ?)`,
            uid("irow"),
            ctx.batchId,
            MASTER_SHEET,
            typeof row.source_excel_row === "number" ? (row.source_excel_row as number) : null,
            JSON.stringify(row),
            id,
            outcome,
            prepared.warnings.join("; ") || null
          );
        }
      } else {
        const exists = companyId !== "(new)" && get<any>(
          `SELECT id FROM activities WHERE company_id = ? AND source_dataset = ? AND external_source_id = ?`,
          companyId, MASTER_DATASET, prepared.externalId
        );
        counts.master[exists ? "unchanged" : "inserted"] += 1;
      }
      if (prepared.reviewAssignee && prepared.next.source_assignee_text) {
        if (!result.unresolvedAssignees.includes(String(prepared.next.source_assignee_text))) {
          result.unresolvedAssignees.push(String(prepared.next.source_assignee_text));
        }
      }
    });

    // --- pipeline ----------------------------------------------------------
    const pipelineIds = new Map<string, string>();
    PIPELINE_ROWS.forEach((row, index) => {
      const prepared = preparePipeline(row, index);
      prepared.warnings.forEach((w) => warn(ctx, w));
      const pipelineDeptId = departmentId;
      if (apply) {
        const { id, outcome } = upsertRow(ctx, "recording_pipeline", { companyId, dataset: PIPELINE_DATASET, externalId: prepared.externalId }, prepared.next, { departmentId: pipelineDeptId, batchId: ctx.batchId });
        counts.pipeline[outcome] += 1;
        pipelineIds.set(prepared.externalId, id);
        if (ctx.batchId) {
          run(
            `INSERT INTO import_rows (id, batch_id, sheet, row_number, raw_json, target_table, target_id, status, message)
             VALUES (?, ?, ?, ?, ?, 'recording_pipeline', ?, ?, ?)`,
            uid("irow"),
            ctx.batchId,
            PIPELINE_SHEET,
            typeof row.source_excel_row === "number" ? (row.source_excel_row as number) : null,
            JSON.stringify(row),
            id,
            outcome,
            prepared.warnings.join("; ") || null
          );
        }
      } else {
        const exists = companyId !== "(new)" && get<any>(
          `SELECT id FROM recording_pipeline WHERE company_id = ? AND source_dataset = ? AND external_source_id = ?`,
          companyId, PIPELINE_DATASET, prepared.externalId
        );
        if (exists) pipelineIds.set(prepared.externalId, exists.id);
        counts.pipeline[exists ? "unchanged" : "inserted"] += 1;
      }
    });
    // Dry-run still needs pipeline ids for exclusions: resolve from DB when present.
    if (!apply) {
      for (const row of PIPELINE_ROWS) {
        const ext = String(row["Pipeline ID"]);
        if (!pipelineIds.has(ext) && companyId !== "(new)") {
          const rowDb = get<any>(`SELECT id FROM recording_pipeline WHERE company_id = ? AND source_dataset = ? AND external_source_id = ?`, companyId, PIPELINE_DATASET, ext);
          if (rowDb) pipelineIds.set(ext, rowDb.id);
        }
      }
    }

    // --- manual exclusions ---------------------------------------------------
    importExclusions(ctx, apply, companyId, pipelineIds, counts.exclusions);

    // --- counts from the database (apply) or payload (dry-run) --------------
    if (apply) {
      const masterTotal = get<{ n: number }>(`SELECT COUNT(*) AS n FROM activities WHERE company_id = ? AND source_dataset = ?`, companyId, MASTER_DATASET)?.n ?? 0;
      const masterActive = get<{ n: number }>(`SELECT COUNT(*) AS n FROM activities WHERE company_id = ? AND source_dataset = ? AND active = 1`, companyId, MASTER_DATASET)?.n ?? 0;
      const pipelineTotal = get<{ n: number }>(`SELECT COUNT(*) AS n FROM recording_pipeline WHERE company_id = ? AND source_dataset = ?`, companyId, PIPELINE_DATASET)?.n ?? 0;
      const exclusionTotal = get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM pipeline_exclusions e JOIN recording_pipeline p ON p.id = e.pipeline_id
          WHERE p.company_id = ? AND e.source_dataset = ?`,
        companyId, EXCLUSION_DATASET
      )?.n ?? 0;
      result.counts = {
        master: { total: masterTotal, active: masterActive, inactive: masterTotal - masterActive },
        pipeline: pipelineTotal,
        exclusions: exclusionTotal,
      };
    } else {
      const active = MASTER_ACTIVITY_ROWS.filter((r) => norm(r["Active Status"]) === "active").length;
      result.counts = {
        master: { total: MASTER_ACTIVITY_ROWS.length, active, inactive: MASTER_ACTIVITY_ROWS.length - active },
        pipeline: PIPELINE_ROWS.length,
        exclusions: MANUAL_EXCLUSION_ROWS.length,
      };
    }

    if (apply && ctx.batchId) {
      const inserted = counts.master.inserted + counts.pipeline.inserted + counts.exclusions.inserted;
      const updated = counts.master.updated + counts.pipeline.updated + counts.exclusions.updated;
      const unchanged = counts.master.unchanged + counts.pipeline.unchanged + counts.exclusions.unchanged;
      const skipped = counts.master.skipped + counts.pipeline.skipped + counts.exclusions.skipped;
      // Finalise the batch inside the same transaction.
      const finishedAt = new Date().toISOString();
      run(
        `UPDATE import_batches SET status = 'completed', rows_total = ?, inserted = ?, updated = ?, skipped = ?, errors = 0, finished_at = datetime('now'), report_json = ? WHERE id = ?`,
        MASTER_ACTIVITY_ROWS.length + PIPELINE_ROWS.length + MANUAL_EXCLUSION_ROWS.length,
        inserted,
        updated,
        skipped,
        JSON.stringify({ counts: result.counts, conflicts: result.conflicts.slice(0, 50), warnings: result.warnings.slice(0, 100), unresolvedAssignees: result.unresolvedAssignees, startedAt, finishedAt }),
        ctx.batchId
      );
      recordAudit({
        actorId: options.actorId ?? null,
        actorName: options.actorName ?? executor,
        action: "import.hfm_seed",
        entity: "import_batch",
        entityId: ctx.batchId,
        meta: { inserted, updated, unchanged, skipped, counts: result.counts, requestedBy },
      });
    }
  };

  if (apply) {
    try {
      transaction(work);
    } catch (error) {
      const message = (error as Error).message;
      result.errors.push(message);
      // The transaction rolled back; record the failure outside it.
      try {
        run(
          `INSERT INTO import_batches (id, filename, mode, source_system, rows_total, status, requested_by, executor, errors, report_json, finished_at)
           VALUES (?, 'embedded HFM seed (failed)', 'apply', ?, ?, 'failed', ?, ?, 1, ?, datetime('now'))`,
          uid("imp"),
          `Excel workbook snapshot ${String(SOURCE_METADATA.snapshot_at)}`,
          MASTER_ACTIVITY_ROWS.length + PIPELINE_ROWS.length + MANUAL_EXCLUSION_ROWS.length,
          requestedBy,
          executor,
          JSON.stringify({ error: message })
        );
      } catch {
        /* nothing more we can do — the failure is reported to the caller */
      }
      return result;
    }
    // Validation persists its own rows; keep it outside the import transaction.
    try {
      runValidation();
    } catch (error) {
      result.warnings.push(`runValidation failed after apply (import committed): ${(error as Error).message}`);
    }
  } else {
    work();
  }

  result.finishedAt = new Date().toISOString();
  return result;
}

// ---------------------------------------------------------------------------
// Rollback — removes exactly what one apply batch created. Organisation
// records, role grants, default settings and demo tenants are NOT reverted;
// see docs/HFM-IMPORT.md for the full rollback procedure.
// ---------------------------------------------------------------------------

export type RollbackResult = { batchId: string; deleted: { activities: number; pipeline: number; exclusions: number }; notes: string[] };

export function rollbackHfmImport(batchId: string, actorName = "operator"): RollbackResult {
  const batch = get<any>(`SELECT * FROM import_batches WHERE id = ?`, batchId);
  if (!batch) throw new Error(`Import batch '${batchId}' not found.`);
  const notes = [
    "Organisation rows (company/entity/department), people profiles, role grants, default-company settings and demo tenants are intentionally preserved.",
    "To fully undo the org as well, restore the automatic pre-apply backup in data/backups/ (see docs/HFM-IMPORT.md).",
  ];
  const result = transaction(() => {
    const pipelineIds = all<{ id: string }>(`SELECT id FROM recording_pipeline WHERE import_batch_id = ?`, batchId).map((r) => r.id);
    const activityIds = all<{ id: string }>(`SELECT id FROM activities WHERE import_batch_id = ?`, batchId).map((r) => r.id);
    const exclusionsDeleted = (run(`DELETE FROM pipeline_exclusions WHERE import_batch_id = ?`, batchId) as any).changes ?? 0;
    let validationDeleted = 0;
    for (const id of [...activityIds, ...pipelineIds]) {
      validationDeleted += (run(`DELETE FROM validation_issues WHERE entity_id = ?`, id) as any).changes ?? 0;
    }
    const pipelineDeleted = (run(`DELETE FROM recording_pipeline WHERE import_batch_id = ?`, batchId) as any).changes ?? 0;
    const activitiesDeleted = (run(`DELETE FROM activities WHERE import_batch_id = ?`, batchId) as any).changes ?? 0;
    run(`UPDATE import_batches SET status = 'rolled_back', finished_at = datetime('now') WHERE id = ?`, batchId);
    run(`DELETE FROM import_rows WHERE batch_id = ?`, batchId);
    notes.push(`Removed ${validationDeleted} validation_issues rows tied to deleted records.`);
    return { activities: activitiesDeleted, pipeline: pipelineDeleted, exclusions: exclusionsDeleted };
  });
  recordAudit({
    actorId: null,
    actorName,
    action: "import.hfm_seed_rollback",
    entity: "import_batch",
    entityId: batchId,
    meta: { deleted: result },
  });
  return { batchId, deleted: result, notes };
}

// ---------------------------------------------------------------------------
// Verification — read-only acceptance checks against the live database
// ---------------------------------------------------------------------------

export function verifyHfmImport(): VerificationResult {
  const checks: VerificationResult["checks"] = [];
  const check = (name: string, pass: boolean, detail: string) => checks.push({ name, pass, detail });

  const company = get<any>(`SELECT * FROM companies WHERE code = 'HFM'`);
  check("Exactly one HFM company (code 'HFM')", !!company && get<{ n: number }>(`SELECT COUNT(*) AS n FROM companies WHERE code = 'HFM'`)?.n === 1,
    company ? `id ${company.id}, name '${company.name}', is_default=${company.is_default}` : "not found");
  const entity = company ? get<any>(`SELECT * FROM entities WHERE company_id = ? AND LOWER(name) = 'harrisfarm'`, company.id) : null;
  check("One Harrisfarm entity under HFM", !!entity, entity ? `id ${entity.id}` : "not found");
  const dept = company ? get<any>(`SELECT * FROM departments WHERE company_id = ? AND LOWER(name) = 'hfm it qa'`, company.id) : null;
  check("One HFM IT QA department under Harrisfarm", !!dept && (!entity || dept.entity_id === entity.id), dept ? `id ${dept.id}, entity_id ${dept.entity_id}` : "not found");

  const damien = get<any>(`SELECT * FROM people WHERE LOWER(name) = 'damien milthorpe' LIMIT 1`);
  const raheel = get<any>(`SELECT * FROM people WHERE LOWER(email) = 'ratta@harrisfarm.com.au' LIMIT 1`);
  check("Damien Milthorpe profile exists in HFM IT QA", !!damien && !!dept && damien.department_id === dept.id, damien ? `id ${damien.id}` : "missing");
  check("Damien has department-scoped admin (department_admin → HFM IT QA only)", !!damien && damien.role === "department_admin" && damien.role_scope_department_id === dept?.id, damien ? `role=${damien.role}, scope=${damien.role_scope_department_id}` : "missing");
  check("Damien email is NULL (not invented) until verified", !!damien && damien.email === null, damien ? `email=${damien.email}` : "missing");
  check("Raheel Atta profile resolved by supplied email", !!raheel, raheel ? `id ${raheel.id}, email ${raheel.email}` : "missing");
  check("Raheel has application-scope admin (role 'admin')", !!raheel && raheel.role === "admin" && raheel.role_scope_department_id === null, raheel ? `role=${raheel.role}` : "missing");
  check("Raheel reports to Damien (manager_id link, independent of roles)", !!damien && !!raheel && raheel.manager_id === damien.id, raheel ? `manager_id=${raheel.manager_id}` : "missing");

  if (company) {
    const cid = company.id;
    const totals = get<{ n: number; active: number }>(
      `SELECT COUNT(*) AS n, SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END) AS active FROM activities WHERE company_id = ? AND source_dataset = ?`,
      cid, MASTER_DATASET
    );
    check("Master activities imported: 52 (41 Active / 11 Inactive)",
      totals?.n === EXPECTED_COUNTS.master_activities && totals?.active === EXPECTED_COUNTS.master_active,
      `total=${totals?.n}, active=${totals?.active}, inactive=${(totals?.n ?? 0) - (totals?.active ?? 0)}`);
    const dupes = get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM (SELECT external_source_id FROM activities WHERE company_id = ? AND source_dataset = ? GROUP BY external_source_id HAVING COUNT(*) > 1)`,
      cid, MASTER_DATASET
    )?.n ?? 0;
    check("No duplicate activity external IDs", dupes === 0, `duplicates=${dupes}`);
    const pipeTotals = get<{ n: number }>(`SELECT COUNT(*) AS n FROM recording_pipeline WHERE company_id = ? AND source_dataset = ?`, cid, PIPELINE_DATASET);
    check("Pending pipeline imported: 15", pipeTotals?.n === EXPECTED_COUNTS.pending_pipeline, `total=${pipeTotals?.n}`);
    const pipeDupes = get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM (SELECT external_source_id FROM recording_pipeline WHERE company_id = ? AND source_dataset = ? GROUP BY external_source_id HAVING COUNT(*) > 1)`,
      cid, PIPELINE_DATASET
    )?.n ?? 0;
    check("No duplicate pipeline external IDs", pipeDupes === 0, `duplicates=${pipeDupes}`);
    const testLabelled = get<{ n: number }>(`SELECT COUNT(*) AS n FROM recording_pipeline WHERE company_id = ? AND source_dataset = ? AND source_test_label = 1 AND is_test = 1 AND external_source_id LIKE 'TEST-%'`, cid, PIPELINE_DATASET)?.n ?? 0;
    check("All pipeline records retained TEST labels and source_test_label=1", testLabelled === EXPECTED_COUNTS.pending_pipeline, `${testLabelled}/${EXPECTED_COUNTS.pending_pipeline}`);
    const unconfirmed = get<{ n: number }>(`SELECT COUNT(*) AS n FROM recording_pipeline WHERE company_id = ? AND source_dataset = ? AND verification_status IS NULL`, cid, PIPELINE_DATASET)?.n ?? 0;
    check("Every TEST pipeline row carries a verification_status", unconfirmed === 0, `rows missing status=${unconfirmed}`);
    const exc = get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM pipeline_exclusions e JOIN recording_pipeline p ON p.id = e.pipeline_id
        WHERE p.company_id = ? AND e.source_dataset = ?`,
      cid, EXCLUSION_DATASET
    );
    check("Manual exclusions imported: 14", exc?.n === EXPECTED_COUNTS.manual_exclusions, `total=${exc?.n}`);
    // Spot-check literal external IDs (QA-008 and QA-00013 must NOT be normalised)
    const literals = ["QA-008", "QA-00013", "QA-0001", "QA-0039", "QA-0052"];
    const found = literals.filter((id) => get<{ n: number }>(`SELECT COUNT(*) AS n FROM activities WHERE company_id = ? AND external_source_id = ?`, cid, id)?.n);
    check("Literal source IDs preserved (QA-008, QA-00013, …)", found.length === literals.length, `found ${found.join(", ")}`);
    const qa0029 = get<any>(`SELECT end_date, effective_duration_days, source_duration_days FROM activities WHERE company_id = ? AND external_source_id = 'QA-0029'`, cid);
    check("QA-0029: missing end date stays NULL; source duration 0 preserved, effective NULL", qa0029 && qa0029.end_date === null && qa0029.source_duration_days === 0 && qa0029.effective_duration_days === null, JSON.stringify(qa0029));
    const qa0032 = get<any>(`SELECT status, source_status_raw FROM activities WHERE company_id = ? AND external_source_id = 'QA-0032'`, cid);
    check("QA-0032: blank source status staged as 'Draft' with raw NULL preserved", qa0032 && qa0032.status === "Draft" && qa0032.source_status_raw === null, JSON.stringify(qa0032));
    const t001 = get<any>(`SELECT automation_fraction FROM recording_pipeline WHERE company_id = ? AND external_source_id = 'TEST-001'`, cid);
    check("TEST-001 automation 0.55 stored as fraction", t001 && t001.automation_fraction === 0.55, JSON.stringify(t001));
    const t009 = get<any>(`SELECT automation_percent, automation_fraction FROM recording_pipeline WHERE company_id = ? AND external_source_id = 'TEST-009'`, cid);
    check("TEST-009 automation NULL preserved (not zero)", t009 && t009.automation_percent === null && t009.automation_fraction === null, JSON.stringify(t009));
    const raheelAssignedNotOverboard = get<{ n: number }>(`SELECT COUNT(*) AS n FROM activities WHERE company_id = ? AND source_dataset = ? AND assignee_id IS NULL AND source_assignee_text IS NULL`, cid, MASTER_DATASET)?.n ?? 0;
    const unresolved = get<{ n: number }>(`SELECT COUNT(*) AS n FROM activities WHERE company_id = ? AND source_dataset = ? AND assignee_id IS NULL AND source_assignee_text IS NOT NULL AND TRIM(source_assignee_text) <> ''`, cid, MASTER_DATASET)?.n ?? 0;
    check("Unresolved source assignees kept unassigned (not guessed)", true, `unresolved labels staged for review: ${unresolved}; blank-assignee rows: ${raheelAssignedNotOverboard}`);
    const missingStart = get<{ n: number }>(`SELECT COUNT(*) AS n FROM activities WHERE company_id = ? AND source_dataset = ? AND start_date IS NULL`, cid, MASTER_DATASET)?.n ?? 0;
    const missingEnd = get<{ n: number }>(`SELECT COUNT(*) AS n FROM activities WHERE company_id = ? AND source_dataset = ? AND end_date IS NULL`, cid, MASTER_DATASET)?.n ?? 0;
    check("Incomplete-date master rows staged, not dropped (1 missing start, 7 missing end)", missingStart === 1 && missingEnd === 7, `missing start=${missingStart}, missing end=${missingEnd}`);
  }

  const passed = checks.filter((c) => c.pass).length;
  const failed = checks.length - passed;
  return { checks, passed, failed };
}

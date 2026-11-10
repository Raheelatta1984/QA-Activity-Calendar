import { all, get, run, transaction } from "./db";
import { uid } from "./ids";
import { inclusiveDays, isIsoDate } from "./dates";
import { detectIssues, persistIssues } from "./validation";
import { resolveFte } from "./activities";

/**
 * Idempotent source-to-target import with a dry-run mode.
 *
 * - Never modifies the source workbook (the app only receives text).
 * - Preserves row provenance (source_sheet / source_row / import_batch_id).
 * - Natural keys: Calendar Item ID for activities, recording code for pipeline.
 * - Unknown data stays unknown: unparseable dates are recorded as null + issue.
 */

export type ImportTarget = "activities" | "pipeline";
export type ImportMode = "dry-run" | "apply";

export type RowReport = {
  row: number;
  key: string | null;
  status: "inserted" | "updated" | "skipped" | "error" | "conflict";
  message: string;
};

export type ImportReport = {
  batchId: string;
  target: ImportTarget;
  mode: ImportMode;
  total: number;
  inserted: number;
  updated: number;
  skipped: number;
  errors: number;
  rows: RowReport[];
  warnings: string[];
};

const HEADER_ALIASES: Record<string, string[]> = {
  project: ["project", "project name", "project title"],
  activity: ["activity", "name", "activity name"],
  detail: ["activity detail", "detail", "description"],
  group: ["activity group", "group", "category"],
  rule: ["rule type", "rule"],
  active: ["active status", "active", "is active"],
  start: ["start date", "start", "planned start"],
  end: ["end date", "end", "planned end"],
  fte: ["fte", "allocation"],
  colour: ["colour", "color"],
  assignee: ["assing to", "assign to", "assigned to", "assignee", "owner"],
  status: ["status"],
  notes: ["notes", "note", "comment"],
  quality: ["data quality", "quality"],
  calendarId: ["calendar item id", "calendar id", "item id", "id", "code"],
  duration: ["duration", "duration days"],
  plannedStart: ["planned start", "plan start"],
  plannedEnd: ["planned end", "plan end"],
  actualStart: ["actual start"],
  actualEnd: ["actual end"],
  recordingStatus: ["recording status"],
  currentStatus: ["current status"],
  automation: ["automation %", "automation", "automation percent"],
  blocker: ["blocker", "blockers", "reason"],
  test: ["test", "is test", "test record"],
};

function canonicalHeader(header: string): string | null {
  const normalised = header.trim().toLowerCase().replace(/\s+/g, " ");
  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    if (aliases.includes(normalised)) return key;
  }
  return null;
}

export function parseDelimited(text: string): { headers: string[]; rows: { row: number; values: Record<string, string> }[] } {
  const lines = text.replace(/\r\n/g, "\n").split("\n").filter((line) => line.trim().length);
  if (!lines.length) return { headers: [], rows: [] };
  const delimiter = (lines[0].match(/\t/g)?.length ?? 0) >= (lines[0].match(/,/g)?.length ?? 0) ? "\t" : ",";
  const split = (line: string) => {
    const out: string[] = [];
    let current = "";
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];
      if (char === '"') {
        if (quoted && line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else quoted = !quoted;
      } else if (char === delimiter && !quoted) {
        out.push(current);
        current = "";
      } else current += char;
    }
    out.push(current);
    return out.map((v) => v.trim());
  };
  const headers = split(lines[0]);
  const rows = lines.slice(1).map((line, index) => {
    const cells = split(line);
    const values: Record<string, string> = {};
    headers.forEach((header, i) => {
      values[header] = cells[i] ?? "";
    });
    return { row: index + 2, values };
  });
  return { headers, rows };
}

/** Excel serial (1900 date system) or textual date → ISO date, or null when unknown. */
export function parseSourceDate(raw: string): { value: string | null; note?: string } {
  const text = (raw ?? "").trim();
  if (!text) return { value: null };
  if (isIsoDate(text)) return { value: text };
  if (/^\d{5}$/.test(text)) {
    const serial = Number(text);
    if (serial > 20000 && serial < 80000) {
      const millis = Date.UTC(1899, 11, 30) + serial * 86400000;
      return { value: new Date(millis).toISOString().slice(0, 10), note: "Excel serial converted" };
    }
  }
  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/.exec(text);
  if (dmy) {
    const day = dmy[1].padStart(2, "0");
    const month = dmy[2].padStart(2, "0");
    const year = dmy[3].length === 2 ? `20${dmy[3]}` : dmy[3];
    const candidate = `${year}-${month}-${day}`;
    if (isIsoDate(candidate)) return { value: candidate, note: "Day/month/year text parsed" };
  }
  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) {
    return { value: parsed.toISOString().slice(0, 10), note: "Free-text date parsed" };
  }
  return { value: null, note: `Unparseable date "${text}" left unknown` };
}

function truthy(raw: string): boolean {
  return /^(y|yes|true|1|active)$/i.test((raw ?? "").trim());
}

function pick(values: Record<string, string>, canonical: string): string {
  for (const [header, value] of Object.entries(values)) {
    if (canonicalHeader(header) === canonical) return value;
  }
  return "";
}

export function runImport(input: {
  text: string;
  target: ImportTarget;
  mode: ImportMode;
  filename?: string;
  sheet?: string;
  actorId?: string | null;
  /** Selected tenant. Defaults to the configured default company for CLI use. */
  companyId?: string | null;
  /** Selected department (optional; NULL keeps the row department-less). */
  departmentId?: string | null;
}): ImportReport {
  const parsed = parseDelimited(input.text);
  const batchId = uid("imp");
  const warnings: string[] = [];
  const rows: RowReport[] = [];
  const companyId =
    input.companyId ??
    get<{ id: string }>(
      "SELECT id FROM companies ORDER BY is_default DESC, created_at, id LIMIT 1"
    )?.id ??
    null;
  const departmentId = input.departmentId ?? null;
  if (departmentId && companyId) {
    const dept = get<{ company_id: string }>("SELECT company_id FROM departments WHERE id = ?", departmentId);
    if (!dept || dept.company_id !== companyId) {
      throw new Error("The selected department does not belong to the selected company.");
    }
  }

  run(
    `INSERT INTO import_batches (id, filename, mode, source_system, rows_total, status, created_by, company_id, department_id)
     VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?)`,
    batchId,
    input.filename ?? "pasted-rows",
    input.mode,
    "workbook",
    parsed.rows.length,
    input.actorId ?? null,
    companyId,
    departmentId
  );

  if (!parsed.rows.length) warnings.push("No data rows found. Provide a header row plus at least one record.");

  const people = new Map<string, string>();
  for (const person of all<{ id: string; name: string; email: string | null }>(
    `SELECT p.id, p.name, p.email FROM people p
       JOIN departments d ON d.id = p.department_id
      WHERE d.company_id = ?`,
    companyId
  )) {
    people.set(person.name.toLowerCase(), person.id);
    if (person.email) people.set(person.email.toLowerCase(), person.id);
  }

  const apply = input.mode === "apply";
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let errors = 0;

  const writeRow = (report: RowReport, raw: Record<string, string>, targetTable: string, targetId: string | null) => {
    rows.push(report);
    run(
      `INSERT INTO import_rows (id, batch_id, sheet, row_number, raw_json, target_table, target_id, status, message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      uid("ir"),
      batchId,
      input.sheet ?? (input.target === "activities" ? "tblActivities" : "tblRecordingPipeline"),
      report.row,
      JSON.stringify(raw),
      targetTable,
      targetId,
      report.status,
      report.message
    );
  };

  for (const row of parsed.rows) {
    const activityName = pick(row.values, "activity");
    if (!activityName) {
      errors += 1;
      writeRow(
        { row: row.row, key: null, status: "error", message: "Missing activity name" },
        row.values,
        input.target,
        null
      );
      continue;
    }

    const startRaw = pick(row.values, "start") || pick(row.values, "plannedStart");
    const endRaw = pick(row.values, "end") || pick(row.values, "plannedEnd");
    const start = parseSourceDate(startRaw);
    const end = parseSourceDate(endRaw);
    if (start.note) warnings.push(`Row ${row.row}: ${start.note}`);
    if (end.note) warnings.push(`Row ${row.row}: ${end.note}`);
    if (start.value && end.value && start.value > end.value) {
      errors += 1;
      writeRow(
        {
          row: row.row,
          key: pick(row.values, "calendarId") || null,
          status: "error",
          message: `Start ${start.value} is after end ${end.value} — flagged, not corrected`,
        },
        row.values,
        input.target,
        null
      );
      continue;
    }

    const code = pick(row.values, "calendarId") || null;
    const assigneeRaw = pick(row.values, "assignee").toLowerCase();
    const assigneeId = assigneeRaw ? people.get(assigneeRaw) ?? null : null;
    if (assigneeRaw && !assigneeId) {
      warnings.push(`Row ${row.row}: assignee "${pick(row.values, "assignee")}" not found — imported as Unassigned`);
    }

    const notes = pick(row.values, "notes");
    if (notes && notes.length > 40) {
      // Narrative notes are archived verbatim instead of being turned into activity records.
      run(
        `INSERT INTO original_notes_archive (id, source_sheet, source_row, entity_type, entity_id, raw_text, note)
         VALUES (?, ?, ?, ?, NULL, ?, 'Preserved from import')`,
        uid("ona"),
        input.sheet ?? (input.target === "activities" ? "tblActivities" : "tblRecordingPipeline"),
        row.row,
        input.target,
        notes
      );
    }

    if (input.target === "activities") {
      const existing = code
        ? get<any>(`SELECT * FROM activities WHERE company_id = ? AND code = ?`, companyId, code)
        : get<any>(
            `SELECT * FROM activities WHERE company_id = ? AND activity = ? AND COALESCE(start_date,'') = ?`,
            companyId,
            activityName,
            start.value ?? ""
          );

      const payload = {
        project: pick(row.values, "project") || null,
        activity: activityName,
        detail: pick(row.values, "detail") || null,
        group: pick(row.values, "group") || "QA",
        rule: pick(row.values, "rule") || null,
        active: pick(row.values, "active") ? (truthy(pick(row.values, "active")) ? 1 : 0) : 1,
        start: start.value,
        end: end.value,
        duration: start.value && end.value ? inclusiveDays(start.value, end.value) : null,
        fteRaw: pick(row.values, "fte"),
        colour: pick(row.values, "colour") || "#4f8cff",
        assignee: assigneeId,
        status: pick(row.values, "status") || "Planned",
        notes: notes || null,
        quality: pick(row.values, "quality") || null,
        code: code ?? `IMP-${batchId.slice(-6).toUpperCase()}-${row.row}`,
      };

      const group = payload.group;
      const fteValue = payload.fteRaw ? Number(payload.fteRaw) : null;
      const fte = Number.isFinite(fteValue) && fteValue && fteValue > 0
        ? (fteValue as number)
        : resolveFte({ activity_group: group, fte: 0, fte_override: null });

      if (!start.value || !end.value) {
        warnings.push(`Row ${row.row}: missing dates — kept in the unscheduled queue`);
      }

      if (existing) {
        const changed =
          existing.activity !== payload.activity ||
          existing.start_date !== payload.start ||
          existing.end_date !== payload.end ||
          existing.assignee_id !== payload.assignee;
        if (!apply) {
          skipped += 1;
          writeRow(
            {
              row: row.row,
              key: payload.code,
              status: changed ? "conflict" : "skipped",
              message: changed ? "Would update existing record (dry run)" : "Identical record — no change needed",
            },
            row.values,
            "activities",
            existing.id
          );
        } else if (!changed) {
          skipped += 1;
          writeRow(
            { row: row.row, key: payload.code, status: "skipped", message: "Identical — idempotent no-op" },
            row.values,
            "activities",
            existing.id
          );
        } else {
          run(
            `UPDATE activities SET project_name = ?, activity = ?, detail = ?, activity_group = ?, rule_type = ?, active = ?, start_date = ?, end_date = ?,
               duration_days = ?, fte = ?, colour = ?, assignee_id = ?, status = ?, notes = ?, data_quality = ?,
               calendar_item_id = ?, planned_start = ?, planned_end = ?, source_sheet = ?, source_row = ?, import_batch_id = ?,
               company_id = ?, updated_at = datetime('now') WHERE id = ?`,
            payload.project,
            payload.activity,
            payload.detail,
            payload.group,
            payload.rule,
            payload.active,
            payload.start,
            payload.end,
            payload.duration,
            fte,
            payload.colour,
            payload.assignee,
            payload.status,
            payload.notes,
            payload.quality,
            payload.code,
            payload.start,
            payload.end,
            input.sheet ?? "tblActivities",
            row.row,
            batchId,
            companyId,
            existing.id
          );
          updated += 1;
          writeRow({ row: row.row, key: payload.code, status: "updated", message: "Updated existing record" }, row.values, "activities", existing.id);
        }
      } else if (!apply) {
        inserted += 1;
        writeRow({ row: row.row, key: payload.code, status: "inserted", message: "Would insert (dry run)" }, row.values, "activities", null);
      } else {
        const id = uid("act");
        run(
          `INSERT INTO activities (id, code, company_id, department_id, project_name, activity, detail, activity_group, rule_type, active, start_date, end_date, duration_days,
             fte, colour, assignee_id, status, notes, data_quality, calendar_item_id, planned_start, planned_end,
             source_sheet, source_row, import_batch_id, is_demo, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))`,
          id,
          payload.code,
          companyId,
          departmentId,
          payload.project,
          payload.activity,
          payload.detail,
          payload.group,
          payload.rule,
          payload.active,
          payload.start,
          payload.end,
          payload.duration,
          fte,
          payload.colour,
          payload.assignee,
          payload.status,
          payload.notes,
          payload.quality,
          payload.code,
          payload.start,
          payload.end,
          input.sheet ?? "tblActivities",
          row.row,
          batchId
        );
        inserted += 1;
        writeRow({ row: row.row, key: payload.code, status: "inserted", message: "Inserted from source row" }, row.values, "activities", id);
      }
    } else {
      const existing = code
        ? get<any>(`SELECT * FROM recording_pipeline WHERE company_id = ? AND code = ?`, companyId, code)
        : get<any>(
            `SELECT * FROM recording_pipeline WHERE company_id = ? AND activity = ?`,
            companyId,
            activityName
          );

      const payload = {
        code: code ?? `IMP-REC-${row.row}`,
        activity: activityName,
        detail: pick(row.values, "detail") || null,
        plannedStart: start.value,
        plannedEnd: end.value,
        actualStart: parseSourceDate(pick(row.values, "actualStart")).value,
        actualEnd: parseSourceDate(pick(row.values, "actualEnd")).value,
        recordingStatus: pick(row.values, "recordingStatus") || "Not started",
        currentStatus: pick(row.values, "currentStatus") || "Pending",
        automation: Number(pick(row.values, "automation").replace("%", "")) || 0,
        blocker: pick(row.values, "blocker") || null,
        assignee: assigneeId,
        isTest: truthy(pick(row.values, "test") ?? "") ? 1 : 0,
        notes: notes || null,
      };

      if (existing) {
        if (!apply) {
          skipped += 1;
          writeRow({ row: row.row, key: payload.code, status: "conflict", message: "Would update existing recording (dry run)" }, row.values, "recording_pipeline", existing.id);
        } else {
          run(
            `UPDATE recording_pipeline SET activity = ?, detail = ?, planned_start = ?, planned_end = ?, actual_start = ?, actual_end = ?,
               duration_days = ?, recording_status = ?, current_status = ?, automation_percent = ?, blocker = ?, assignee_id = ?,
               is_test = ?, notes = ?, source_sheet = ?, source_row = ?, import_batch_id = ?, company_id = ?, department_id = ? WHERE id = ?`,
            payload.activity,
            payload.detail,
            payload.plannedStart,
            payload.plannedEnd,
            payload.actualStart,
            payload.actualEnd,
            payload.plannedStart && payload.plannedEnd ? inclusiveDays(payload.plannedStart, payload.plannedEnd) : null,
            payload.recordingStatus,
            payload.currentStatus,
            payload.automation,
            payload.blocker,
            payload.assignee,
            payload.isTest,
            payload.notes,
            input.sheet ?? "tblRecordingPipeline",
            row.row,
            batchId,
            companyId,
            departmentId,
            existing.id
          );
          updated += 1;
          writeRow({ row: row.row, key: payload.code, status: "updated", message: "Updated existing recording" }, row.values, "recording_pipeline", existing.id);
        }
      } else if (!apply) {
        inserted += 1;
        writeRow({ row: row.row, key: payload.code, status: "inserted", message: "Would insert (dry run)" }, row.values, "recording_pipeline", null);
      } else {
        const id = uid("pipe");
        run(
          `INSERT INTO recording_pipeline (id, code, company_id, department_id, activity, detail, planned_start, planned_end, actual_start, actual_end, duration_days,
             recording_status, current_status, automation_percent, blocker, assignee_id, is_test, notes, source_sheet, source_row, import_batch_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          payload.code,
          companyId,
          departmentId,
          payload.activity,
          payload.detail,
          payload.plannedStart,
          payload.plannedEnd,
          payload.actualStart,
          payload.actualEnd,
          payload.plannedStart && payload.plannedEnd ? inclusiveDays(payload.plannedStart, payload.plannedEnd) : null,
          payload.recordingStatus,
          payload.currentStatus,
          payload.automation,
          payload.blocker,
          payload.assignee,
          payload.isTest,
          payload.notes,
          input.sheet ?? "tblRecordingPipeline",
          row.row,
          batchId
        );
        inserted += 1;
        writeRow({ row: row.row, key: payload.code, status: "inserted", message: "Inserted from source row" }, row.values, "recording_pipeline", id);
      }
    }
  }

  const report: ImportReport = {
    batchId,
    target: input.target,
    mode: input.mode,
    total: parsed.rows.length,
    inserted,
    updated,
    skipped,
    errors,
    rows: rows.slice(0, 100),
    warnings: [...new Set(warnings)].slice(0, 40),
  };

  run(
    `UPDATE import_batches SET inserted = ?, updated = ?, skipped = ?, errors = ?, status = ?, report_json = ?, finished_at = datetime('now')
     WHERE id = ?`,
    inserted,
    updated,
    skipped,
    errors,
    errors && !inserted && !updated ? "failed" : "complete",
    JSON.stringify({ warnings: report.warnings, mode: input.mode }),
    batchId
  );

  if (apply) {
    transaction(() => {
      persistIssues(detectIssues(input.companyId ?? null), input.companyId ?? null);
    });
  }

  return report;
}

export function listBatches(limit = 12, companyId?: string | null) {
  return all<any>(
    `SELECT b.*, p.name AS created_by_name FROM import_batches b
      LEFT JOIN people p ON p.id = b.created_by
      ${companyId ? "WHERE b.company_id = ?" : ""}
      ORDER BY b.created_at DESC LIMIT ?`,
    ...(companyId ? [companyId] : []),
    limit
  );
}

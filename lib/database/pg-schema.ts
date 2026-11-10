import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "../../db/migrations.generated";
import { toPostgres } from "./dialect";

/**
 * Postgres baseline schema, derived from the SQLite migrations.
 *
 * The migrations in `db/migrations` are a history that includes table rebuilds
 * (`DROP TABLE people; ALTER TABLE people_new RENAME TO people`). That history
 * cannot be replayed on Postgres because other tables hold foreign keys to the
 * dropped table. Instead, Postgres gets the *final* schema in one pass:
 *
 *   1. Apply every migration to a throwaway in-memory SQLite database.
 *   2. Read the resulting `sqlite_master` definitions (the canonical schema).
 *   3. Translate each definition to Postgres: types, `datetime('now')`
 *      defaults, foreign keys re-attached with ALTER TABLE (Postgres has no
 *      forward references in CREATE TABLE), then indexes.
 *
 * New migrations should therefore stay additive (ALTER TABLE ADD COLUMN /
 * CREATE TABLE IF NOT EXISTS) so both drivers can apply them directly.
 * `tests/postgres.test.mts` asserts that the generated Postgres schema and the
 * SQLite schema expose the same tables and columns.
 */

export type ForeignKey = {
  table: string;
  column: string;
  refTable: string;
  refColumn: string;
  onDelete: string | null;
};

export type PostgresSchema = {
  statements: string[];
  tables: string[];
  foreignKeys: ForeignKey[];
};

const CONSTRAINT_KEYWORDS = /^\s*(?:CONSTRAINT|PRIMARY\s+KEY|UNIQUE|CHECK|FOREIGN\s+KEY)\b/i;

function stripComments(sql: string) {
  return sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .filter((line) => line.trim() !== "")
    .join("\n");
}

function unquote(identifier: string) {
  return identifier.replace(/"/g, "").trim();
}

function parseTable(
  table: string,
  createSql: string
): { sql: string; foreignKeys: ForeignKey[] } {
  const cleaned = stripComments(createSql);
  const open = cleaned.indexOf("(");
  if (open === -1) return { sql: cleaned, foreignKeys: [] };

  // Walk to the matching close paren (defaults/checks contain nested parens).
  let depth = 0;
  let close = -1;
  for (let i = open; i < cleaned.length; i += 1) {
    const char = cleaned[i];
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1) return { sql: cleaned, foreignKeys: [] };

  const head = cleaned.slice(0, open + 1);
  const body = cleaned.slice(open + 1, close);
  const tail = cleaned.slice(close);

  const foreignKeys: ForeignKey[] = [];
  const kept: string[] = [];

  for (const chunk of splitTopLevel(body)) {
    const definition = chunk.trim().replace(/^[,\s]+/, "");
    if (!definition) continue;

    // Table-level constraint: FOREIGN KEY (col) REFERENCES other(col)
    const tableLevel = definition.match(
      /^FOREIGN\s+KEY\s*\(\s*"?([\w]+)"?\s*\)\s*REFERENCES\s+"?([\w]+)"?\s*\(\s*"?([\w]+)"?\s*\)(.*)$/is
    );
    if (tableLevel) {
      foreignKeys.push({
        table,
        column: tableLevel[1],
        refTable: tableLevel[2],
        refColumn: tableLevel[3],
        onDelete: matchOnDelete(tableLevel[4]),
      });
      continue;
    }
    if (CONSTRAINT_KEYWORDS.test(definition)) {
      kept.push(definition);
      continue;
    }

    // Column-level references. A SQLite table can carry several REFERENCES
    // clauses (including columns appended by ALTER TABLE on one line), so every
    // clause is extracted and removed before the column is kept.
    const column = definition.split(/\s+/)[0];
    let stripped = definition;
    const referencePattern = /\s*REFERENCES\s+"?([\w]+)"?\s*\(\s*"?([\w]+)"?\s*\)((?:\s+ON\s+(?:DELETE|UPDATE)\s+(?:CASCADE|SET\s+NULL|SET\s+DEFAULT|RESTRICT|NO\s+ACTION))*)/gi;
    let match: RegExpExecArray | null;
    let found = false;
    while ((match = referencePattern.exec(definition))) {
      found = true;
      foreignKeys.push({
        table,
        column: unquote(column),
        refTable: match[1],
        refColumn: match[2],
        onDelete: matchOnDelete(match[3] ?? ""),
      });
      stripped = stripped.replace(match[0], "");
    }
    kept.push(found ? stripped.trim() : definition);
  }

  return { sql: `${head}\n  ${kept.join(",\n  ")}\n${tail}`, foreignKeys };
}

/** Split a CREATE TABLE body on top-level commas (ignores nested parens/quotes). */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];
    if (quote) {
      current += char;
      if (char === quote) {
        if (body[i + 1] === quote) {
          current += body[i + 1];
          i += 1;
          continue;
        }
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (char === "(") {
      depth += 1;
      current += char;
      continue;
    }
    if (char === ")") {
      depth -= 1;
      current += char;
      continue;
    }
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

function matchOnDelete(fragment: string): string | null {
  const match = fragment.match(/ON\s+DELETE\s+(CASCADE|SET\s+NULL|SET\s+DEFAULT|RESTRICT|NO\s+ACTION)/i);
  return match ? match[1].replace(/\s+/g, " ").toUpperCase() : null;
}

function constraintName(table: string, column: string) {
  const name = `fk_${table}_${column}`;
  return name.length <= 63 ? name : name.slice(0, 63);
}

/**
 * Build the Postgres DDL for the application schema.
 *
 * `through` limits the baseline to migrations up to (and including) that file;
 * later migrations are applied individually by the Postgres migration runner.
 */
export function buildPostgresSchema(through?: string): PostgresSchema {
  const db = new DatabaseSync(":memory:");
  const statements: string[] = [];
  const tables: string[] = [];
  const foreignKeys: ForeignKey[] = [];
  try {
    db.exec("PRAGMA foreign_keys = OFF;");
    for (const migration of MIGRATIONS) {
      if (through && migration.name > through) continue;
      db.exec(migration.sql);
    }

    const objects = db
      .prepare(
        `SELECT type, name, sql FROM sqlite_master
          WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name <> '_migrations'
          ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, name`
      )
      .all() as { type: string; name: string; sql: string }[];

    const indexSql: string[] = [];
    for (const object of objects) {
      if (object.type === "table") {
        const parsed = parseTable(object.name, object.sql);
        tables.push(object.name);
        foreignKeys.push(...parsed.foreignKeys);
        statements.push(`${toPostgres(parsed.sql, { ddl: true }).trim()}`);
      } else if (object.type === "index") {
        indexSql.push(toPostgres(object.sql, { ddl: true }).trim());
      }
    }

    // Foreign keys are added after every table exists (Postgres has no forward
    // references in CREATE TABLE).
    for (const fk of foreignKeys) {
      const onDelete = fk.onDelete ? ` ON DELETE ${fk.onDelete}` : "";
      statements.push(
        `ALTER TABLE ${fk.table} ADD CONSTRAINT ${constraintName(fk.table, fk.column)} ` +
          `FOREIGN KEY (${fk.column}) REFERENCES ${fk.refTable}(${fk.refColumn})${onDelete}`
      );
    }

    statements.push(...indexSql);
  } finally {
    db.close();
  }
  return { statements, tables, foreignKeys };
}

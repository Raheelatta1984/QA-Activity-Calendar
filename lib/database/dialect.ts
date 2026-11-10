/**
 * SQLite → PostgreSQL statement translation.
 *
 * The application is written against one portable SQL style (SQLite is the
 * reference implementation). Everything the app actually emits is a small,
 * well-defined subset: `?` placeholders, `datetime('now')`, `INSERT OR IGNORE`,
 * case-insensitive `LIKE` and plain `CREATE TABLE` / `CREATE INDEX`. Rather than
 * rewrite ~900 call sites, the Postgres driver translates each statement as it
 * is sent. The translation is pure and unit-tested (tests/postgres.test.mts).
 *
 * Anything that cannot be translated faithfully throws instead of silently
 * doing the wrong thing — a wrong query is worse than a loud failure.
 */

const NOW_TEXT = `to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS')`;
const NOW_DATE = `to_char(now() at time zone 'utc', 'YYYY-MM-DD')`;

export class UnsupportedSqlError extends Error {
  constructor(message: string, sql: string) {
    super(`${message}\n\nSQL: ${sql.trim().slice(0, 400)}`);
    this.name = "UnsupportedSqlError";
  }
}

/**
 * Translate one SQLite statement (or several statements separated by `;`) to
 * Postgres. `ddl` switches on type mapping used by generated schema statements.
 */
export function toPostgres(sql: string, options: { ddl?: boolean } = {}): string {
  let out = sql;

  // PRAGMAs are SQLite runtime knobs (journal mode, foreign keys, busy
  // timeout). Postgres has no equivalent statement here; they are dropped.
  out = out.replace(/^\s*PRAGMA[^;]*;\s*$/gim, "");

  if (!out.trim()) return "";

  if (/\bsqlite_master\b|\bsqlite_schema\b/i.test(out)) {
    throw new UnsupportedSqlError(
      "sqlite_master is not available in Postgres — use the schema/tables helpers in lib/db.ts.",
      sql
    );
  }
  if (/\browid\b/i.test(out)) {
    throw new UnsupportedSqlError(
      "rowid does not exist in Postgres — order by an explicit column instead.",
      sql
    );
  }

  // `INSERT OR REPLACE` has no faithful single-statement equivalent without
  // knowing the conflict target; refuse rather than guess.
  if (/\bINSERT\s+OR\s+REPLACE\b/i.test(out)) {
    throw new UnsupportedSqlError(
      "INSERT OR REPLACE is ambiguous in Postgres — use INSERT ... ON CONFLICT (...) DO UPDATE.",
      sql
    );
  }

  const ignoreInsert = /\bINSERT\s+OR\s+IGNORE\s+INTO\b/i.test(out);
  if (ignoreInsert) {
    out = out.replace(/\bINSERT\s+OR\s+IGNORE\s+INTO\b/gi, "INSERT INTO");
  }

  // Time helpers. SQLite stores timestamps as 'YYYY-MM-DD HH:MM:SS' text, so
  // Postgres must produce the same text instead of a timestamptz value.
  out = out.replace(/\bdatetime\(\s*'now'\s*\)/gi, NOW_TEXT);
  out = out.replace(/\bdate\(\s*'now'\s*\)/gi, NOW_DATE);

  if (options.ddl) {
    // SQLite type affinity → concrete Postgres types.
    out = out.replace(/\bREAL\b/gi, "double precision");
    out = out.replace(/\bDATETIME\b/gi, "text");
  }

  // SQLite LIKE is case-insensitive for ASCII; Postgres ILIKE is the closest
  // equivalent (and a superset for our search boxes).
  out = out.replace(/\bNOT\s+LIKE\b/gi, "NOT ILIKE").replace(/(?<!I)\bLIKE\b/gi, "ILIKE");

  // SQLite's null-safe comparison (`col IS ?`) has no direct Postgres syntax;
  // `IS [NOT] DISTINCT FROM` is the exact equivalent (and works with NULLs).
  out = out.replace(/\bIS\s+NOT\s+\?/gi, "IS DISTINCT FROM ?");
  out = out.replace(/\bIS\s+\?/gi, "IS NOT DISTINCT FROM ?");

  if (ignoreInsert && !/\bON\s+CONFLICT\b/i.test(out)) {
    out = appendClause(out, "ON CONFLICT DO NOTHING");
  }

  out = replacePlaceholders(out);
  return out;
}

function appendClause(sql: string, clause: string): string {
  const trimmed = sql.trimEnd();
  const semicolon = trimmed.endsWith(";");
  const body = semicolon ? trimmed.slice(0, -1) : trimmed;
  return `${body.trimEnd()} ${clause}${semicolon ? ";" : ""}`;
}

/**
 * Replace positional `?` parameters with `$1..$n`, skipping quoted strings and
 * quoted identifiers so data can never be mistaken for a placeholder.
 */
export function replacePlaceholders(sql: string): string {
  let index = 0;
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const char = sql[i];
    if (char === "'" || char === '"') {
      const quote = char;
      out += char;
      i += 1;
      while (i < sql.length) {
        out += sql[i];
        if (sql[i] === quote) {
          // Doubled quote is an escaped quote, keep going.
          if (sql[i + 1] === quote) {
            out += sql[i + 1];
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (char === "?") {
      index += 1;
      out += `$${index}`;
      i += 1;
      continue;
    }
    out += char;
    i += 1;
  }
  return out;
}

/** Number of `?` placeholders in a statement (used for validation in tests). */
export function placeholderCount(sql: string): number {
  let count = 0;
  let i = 0;
  while (i < sql.length) {
    const char = sql[i];
    if (char === "'" || char === '"') {
      const quote = char;
      i += 1;
      while (i < sql.length) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (char === "?") count += 1;
    i += 1;
  }
  return count;
}

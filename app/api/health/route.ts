import { NextResponse } from "next/server";
import { all, dbInfo, get } from "@/lib/db";
import { bootstrapDone, bootstrapLastError, ensureBootstrapped } from "@/lib/bootstrap";
import { vaultInfo } from "@/lib/enhancements";

export const dynamic = "force-dynamic";

/**
 * Deployment health probe — no secrets, safe to expose.
 * Answers "did the database bootstrap on this instance?" when Vercel logs are
 * not immediately available.
 */
export async function GET() {
  try {
    ensureBootstrapped();
  } catch {
    /* reported below via bootstrapError */
  }
  const info = {
    ...dbInfo(),
    vault: vaultInfo(),
    bootstrapDone: bootstrapDone(),
    bootstrapError: bootstrapLastError(),
  };
  try {
    const tables =
      get<{ n: number }>(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'`)?.n ?? 0;
    const migrations = all<{ name: string }>(`SELECT name FROM _migrations ORDER BY name`).map(
      (row) => row.name
    );
    const people = get<{ n: number }>(`SELECT COUNT(*) AS n FROM people`)?.n ?? 0;
    const ok = tables > 10 && people > 0;
    return NextResponse.json(
      { ok, ...info, tables, migrations, people },
      { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    return NextResponse.json(
      { ok: false, ...info, error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: { "cache-control": "no-store" } }
    );
  }
}

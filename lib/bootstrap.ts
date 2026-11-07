import { bootstrapDatabase } from "./seed";
import { runValidation } from "./validation";
import { runDeploySync } from "./enhancement-docs";

export type DocumentSyncSnapshot = {
  status: string;
  reason?: string;
  scanned?: { active: number; archived: number };
  changes?: number;
  report?: string | null;
};

type SyncGlobal = { __qaDocSync?: DocumentSyncSnapshot | null };

/**
 * The last reconciliation snapshot, surfaced by /api/health. It is kept on
 * globalThis like the bootstrap flag: Next compiles route handlers and pages
 * separately, so a module-level variable would be invisible to the health probe.
 */
function syncSnapshot(value?: DocumentSyncSnapshot | null): DocumentSyncSnapshot | null {
  const g = globalThis as unknown as SyncGlobal;
  if (value !== undefined) g.__qaDocSync = value;
  return g.__qaDocSync ?? null;
}

export function bootstrapLastSync(): DocumentSyncSnapshot | null {
  return syncSnapshot();
}

/**
 * Idempotent first-run bootstrap: applies migrations, seeds reference config
 * (tabs, sections, holidays, colour dictionary, AI notes) and synthetic demo
 * data when SEED_DEMO_DATA is not false, then primes the validation queue.
 *
 * The flag is only set after a successful run so a transient failure (for
 * example a cold-start filesystem fallback) is retried on the next request
 * instead of leaving every page querying an empty database.
 *
 * After the data layer is ready, the enhancement documents committed in this
 * build are reconciled with the database: a handover that the completion
 * automation has archived (or marked Built) updates the request status, so the
 * Markdown move and the in-app status can never drift apart.
 */
export async function ensureBootstrapped(): Promise<void> {
  const g = globalThis as unknown as {
    __qaBootstrapped?: boolean;
    __qaBootstrapError?: string;
    __qaBootstrapping?: Promise<void>;
  };
  if (g.__qaBootstrapped) return;
  if (g.__qaBootstrapping) return g.__qaBootstrapping;
  g.__qaBootstrapping = (async () => {
    try {
      bootstrapDatabase();
      runValidation();
      // Never let a read-only vault or a slow filesystem break a page render:
      // runDeploySync already caps itself and reports "skipped".
      const sync = await runDeploySync();
      syncSnapshot({
        status: sync.status,
        reason: sync.reason,
        scanned: sync.scanned,
        changes: sync.changes?.length,
        report: sync.report,
      });
      g.__qaBootstrapped = true;
      g.__qaBootstrapError = undefined;
    } catch (error) {
      g.__qaBootstrapError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      console.error("[bootstrap] failed —", g.__qaBootstrapError, error);
      throw error;
    } finally {
      g.__qaBootstrapping = undefined;
    }
  })();
  return g.__qaBootstrapping;
}

/** Last bootstrap failure, surfaced by /api/health for deployment debugging. */
export function bootstrapLastError(): string | null {
  const g = globalThis as unknown as { __qaBootstrapError?: string };
  return g.__qaBootstrapError ?? null;
}

export function bootstrapDone(): boolean {
  const g = globalThis as unknown as { __qaBootstrapped?: boolean };
  return Boolean(g.__qaBootstrapped);
}

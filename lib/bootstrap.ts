import { bootstrapDatabase } from "./seed";
import { runValidation } from "./validation";

/**
 * Idempotent first-run bootstrap: applies migrations, seeds reference config
 * (tabs, sections, holidays, colour dictionary, AI notes) and synthetic demo
 * data when SEED_DEMO_DATA is not false, then primes the validation queue.
 *
 * The flag is only set after a successful run so a transient failure (for
 * example a cold-start filesystem fallback) is retried on the next request
 * instead of leaving every page querying an empty database.
 */
export function ensureBootstrapped() {
  const g = globalThis as unknown as { __qaBootstrapped?: boolean; __qaBootstrapError?: string };
  if (g.__qaBootstrapped) return;
  try {
    bootstrapDatabase();
    runValidation();
    g.__qaBootstrapped = true;
    g.__qaBootstrapError = undefined;
  } catch (error) {
    g.__qaBootstrapError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    console.error("[bootstrap] failed —", g.__qaBootstrapError, error);
    throw error;
  }
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

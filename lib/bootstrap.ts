import { bootstrapDatabase } from "./seed";
import { runValidation } from "./validation";

/**
 * Idempotent first-run bootstrap: applies migrations, seeds reference config
 * (tabs, sections, holidays, colour dictionary, AI notes) and synthetic demo
 * data when SEED_DEMO_DATA is not false, then primes the validation queue.
 */
export function ensureBootstrapped() {
  const g = globalThis as unknown as { __qaBootstrapped?: boolean };
  if (g.__qaBootstrapped) return;
  g.__qaBootstrapped = true;
  try {
    bootstrapDatabase();
    runValidation();
  } catch (error) {
    console.error("[bootstrap] failed", error);
  }
}

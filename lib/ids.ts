import { randomBytes, randomUUID } from "node:crypto";

export function uid(prefix = ""): string {
  const raw = randomUUID().replace(/-/g, "").slice(0, 20);
  return prefix ? `${prefix}_${raw}` : raw;
}

export function token(bytes = 32): string {
  return randomBytes(bytes).toString("hex");
}

/** Stable human reference, e.g. ACT-0007. */
export function nextRef(prefix: string, existing: number): string {
  return `${prefix}-${String(existing + 1).padStart(4, "0")}`;
}

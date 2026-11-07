import { randomUUID } from "node:crypto";

export function uid(prefix = ""): string {
  const raw = randomUUID().replace(/-/g, "").slice(0, 20);
  return prefix ? `${prefix}_${raw}` : raw;
}

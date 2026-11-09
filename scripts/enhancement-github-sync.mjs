/**
 * Unattended two-way sync for the deployed app.
 *
 * This does NOT talk to GitHub itself: the deployed app is the only place that
 * owns the enhancement database, and it already holds the GitHub token. The
 * script therefore calls `POST /api/enhancements/sync` on the app with the
 * shared secret, which runs pull-then-push and journals the result.
 *
 * Environment:
 *   APP_URL                     base URL of the deployment (required)
 *   ENHANCEMENT_SYNC_SECRET     shared secret (required)
 *   SYNC_DIRECTION              full | pull | push            (default full)
 *   REFS                        comma-separated ENH refs      (optional)
 *   GITHUB_EVENT_PATH           supplied by Actions; used to narrow a run to
 *                               the issue number in the event payload
 *
 * Exits non-zero when the app reports an error, so a failed run is visible in
 * the Actions summary instead of silently doing nothing.
 */
import fs from "node:fs";

export function refsFromEvent(env = process.env) {
  if (!env.GITHUB_EVENT_PATH || !fs.existsSync(env.GITHUB_EVENT_PATH)) return [];
  try {
    const event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
    // An issue/PR event carries the number; the app maps it back to a ref, so
    // the event only needs to trigger a full run. We keep the hook for future
    // narrowing but never send an issue number as a ref.
    return [];
  } catch {
    return [];
  }
}

export async function runSync(env = process.env, { fetchImpl = globalThis.fetch } = {}) {
  const base = String(env.APP_URL || "").trim().replace(/\/+$/, "");
  const secret = String(env.ENHANCEMENT_SYNC_SECRET || "").trim();
  if (!base) throw new Error("APP_URL is not configured.");
  if (!secret) throw new Error("ENHANCEMENT_SYNC_SECRET is not configured.");
  if (!/^https?:\/\//i.test(base)) throw new Error("APP_URL must start with http:// or https://.");

  const directionRaw = String(env.SYNC_DIRECTION || "full").toLowerCase();
  const direction = ["pull", "push"].includes(directionRaw) ? directionRaw : "full";
  const refs = String(env.REFS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 50);

  const response = await fetchImpl(`${base}/api/enhancements/sync`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ direction, ...(refs.length ? { refs } : {}) }),
  });
  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  return { status: response.status, ok: response.ok && Boolean(data?.ok), data };
}

function summary(result) {
  const report = result.data?.report;
  if (!report) return [`HTTP ${result.status}`, result.data?.error ?? "no report returned"];
  return [
    `HTTP ${result.status} · ${report.direction} · ${report.repo}`,
    `${report.created} created, ${report.updated} updated, ${report.skipped} unchanged, ${report.errors.length} error(s)`,
    ...report.items
      .filter((item) => item.action !== "unchanged")
      .slice(0, 25)
      .map((item) => `${item.action}: ${item.ref} — ${item.message}`),
  ];
}

async function main() {
  const result = await runSync();
  for (const line of summary(result)) console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Enhancement GitHub sync\n\n${summary(result).map((line) => `- ${line}`).join("\n")}\n\n`);
  }
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

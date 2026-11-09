import { NextResponse, type NextRequest } from "next/server";
import { setting } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { pipelineStages } from "@/lib/enhancement-status";
import {
  bridgeBlockers,
  createGithubClient,
  pullFromGithub,
  pushToGithub,
  recordSyncReport,
  resolveBridgeConfig,
  syncBothWays,
} from "@/lib/enhancement-bridge";
import { bridgeStore } from "@/lib/enhancement-bridge-store";

export const dynamic = "force-dynamic";

/**
 * Unattended two-way sync.
 *
 * Two callers are supported, and both must prove they are allowed to run it:
 *
 *   * `POST` with `Authorization: Bearer $ENHANCEMENT_SYNC_SECRET` — a cron job,
 *     a Vercel Cron, a GitHub Action or an external scheduler.
 *   * `POST` from a GitHub webhook carrying `x-hub-signature-256` computed with
 *     the same secret over the raw body.
 *
 * `direction` may be `full` (default), `pull` or `push`. With `both` unset the
 * run is a pull-then-push, which is the only order that cannot clobber an edit
 * made on the other side.
 *
 * When `ENHANCEMENT_SYNC_SECRET` is not configured the endpoint is disabled
 * rather than open: an unauthenticated write path into GitHub is not a default.
 */
function authorised(request: NextRequest, raw: string): boolean {
  const secret = String(process.env.ENHANCEMENT_SYNC_SECRET ?? "").trim();
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  if (header.startsWith("Bearer ") && header.slice(7).trim() === secret) return true;
  const signature = request.headers.get("x-hub-signature-256") ?? "";
  if (signature.startsWith("sha256=")) {
    // Constant-time compare via node:crypto to avoid a timing oracle.
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { createHmac, timingSafeEqual } = require("node:crypto") as typeof import("node:crypto");
      const expected = `sha256=${createHmac("sha256", secret).update(raw, "utf8").digest("hex")}`;
      const a = Buffer.from(expected);
      const b = Buffer.from(signature);
      return a.length === b.length && timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }
  return false;
}

export async function POST(request: NextRequest) {
  const raw = await request.text();
  if (!authorised(request, raw)) {
    return NextResponse.json(
      {
        ok: false,
        error: process.env.ENHANCEMENT_SYNC_SECRET
          ? "Provide the sync secret as a bearer token or a valid GitHub webhook signature."
          : "ENHANCEMENT_SYNC_SECRET is not configured, so the unattended sync endpoint is disabled.",
      },
      { status: 401, headers: { "cache-control": "no-store" } }
    );
  }

  let body: Record<string, unknown> = {};
  if (raw.trim()) {
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      body = {};
    }
  }
  const directionInput = String(body.direction ?? "full").toLowerCase();
  const direction = directionInput === "pull" || directionInput === "push" ? directionInput : "full";

  const config = resolveBridgeConfig((key, fallback) => setting(key, fallback));
  const blockers = bridgeBlockers(config);
  if (blockers.length) {
    return NextResponse.json({ ok: false, errors: blockers }, { status: 409, headers: { "cache-control": "no-store" } });
  }

  const client = createGithubClient({
    repo: config.repo,
    token: String(process.env.GITHUB_TOKEN ?? ""),
    apiBase: process.env.GITHUB_API_URL,
  });
  const store = bridgeStore();
  const shared = {
    client,
    store,
    config,
    stages: pipelineStages(),
    actorName: "scheduled sync",
    refs: Array.isArray(body.refs) ? body.refs.map(String).slice(0, 50) : undefined,
  };

  try {
    const report =
      direction === "pull" ? await pullFromGithub(shared) : direction === "push" ? await pushToGithub(shared) : await syncBothWays(shared);
    recordSyncReport(store, report, "scheduled sync");
    recordAudit({
      actorId: null,
      actorName: "scheduled sync",
      action: `enhancement.github_${direction}`,
      entity: "enhancement",
      entityId: null,
      after: { repo: report.repo, created: report.created, updated: report.updated, errors: report.errors.length },
    });
    return NextResponse.json({ ok: report.errors.length === 0, report }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 502, headers: { "cache-control": "no-store" } }
    );
  }
}

export async function GET() {
  const config = resolveBridgeConfig((key, fallback) => setting(key, fallback));
  // Read-only status for a dashboard or smoke test. No token, no repository data.
  return NextResponse.json(
    {
      ok: true,
      endpoint: "/api/enhancements/sync",
      method: "POST",
      auth: "Bearer ENHANCEMENT_SYNC_SECRET or x-hub-signature-256",
      enabled: Boolean(process.env.ENHANCEMENT_SYNC_SECRET),
      bridge: {
        enabled: config.enabled,
        repo: config.repo,
        label: config.label,
        state: config.state,
        statusLabelPrefix: config.statusLabelPrefix,
        hasToken: config.hasToken,
      },
      blockers: bridgeBlockers(config),
    },
    { headers: { "cache-control": "no-store" } }
  );
}

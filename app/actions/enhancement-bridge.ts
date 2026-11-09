"use server";

/**
 * Server actions for the Future Enhancements ↔ GitHub bridge (v2).
 *
 * These are thin: validate the viewer, build the client + store, run the engine,
 * then revalidate and audit. The engine itself (`lib/enhancement-bridge.ts`) has
 * no Next.js dependency so it can be moved between projects.
 */

import { revalidatePath } from "next/cache";
import { setSetting, setting } from "@/lib/db";
import { canAdmin, canEdit, getViewer } from "@/lib/access";
import { recordAudit } from "@/lib/audit";
import { pipelineStages } from "@/lib/enhancement-status";
import {
  BRIDGE_SETTING_KEYS,
  bridgeBlockers,
  createGithubClient,
  normaliseRepo,
  pullFromGithub,
  pushToGithub,
  recordSyncReport,
  resolveBridgeConfig,
  syncBothWays,
  type SyncReport,
} from "@/lib/enhancement-bridge";
import { bridgeStore } from "@/lib/enhancement-bridge-store";

export type BridgeResult = {
  ok?: boolean;
  error?: string;
  report?: SyncReport;
  summary?: string;
};

export type BridgeConfigResult = { ok?: boolean; error?: string };

function revalidate() {
  revalidatePath("/enhancements");
  revalidatePath("/", "layout");
  revalidatePath("/setup");
}

function describe(report: SyncReport): string {
  const parts: string[] = [];
  if (report.created) parts.push(`${report.created} created`);
  if (report.updated) parts.push(`${report.updated} updated`);
  if (report.errors.length) parts.push(`${report.errors.length} error${report.errors.length === 1 ? "" : "s"}`);
  if (!parts.length) parts.push("everything was already in sync");
  return `${report.direction === "full" ? "Two-way sync" : report.direction === "pull" ? "Pull from GitHub" : "Push to GitHub"}: ${parts.join(" · ")} — ${report.repo || "no repository"}`;
}

function config() {
  return resolveBridgeConfig((key, fallback) => setting(key, fallback));
}

async function run(
  direction: "pull" | "push" | "full",
  options: { refs?: string[]; actorName: string | null; actorId: string | null }
): Promise<BridgeResult> {
  const cfg = config();
  const blockers = bridgeBlockers(cfg);
  if (blockers.length) return { error: blockers.join(" ") };

  const env = process.env;
  const client = createGithubClient({
    repo: cfg.repo,
    token: String(env.GITHUB_TOKEN ?? ""),
    apiBase: env.GITHUB_API_URL,
  });
  const store = bridgeStore();
  const stages = pipelineStages();
  const shared = {
    client,
    store,
    config: cfg,
    stages,
    actorName: options.actorName,
    refs: options.refs?.length ? options.refs : undefined,
  };

  const report =
    direction === "pull"
      ? await pullFromGithub(shared)
      : direction === "push"
        ? await pushToGithub(shared)
        : await syncBothWays(shared);

  recordSyncReport(store, report, options.actorName);
  recordAudit({
    actorId: options.actorId,
    actorName: options.actorName,
    action: `enhancement.github_${direction}`,
    entity: "enhancement",
    entityId: null,
    after: {
      repo: report.repo,
      created: report.created,
      updated: report.updated,
      skipped: report.skipped,
      errors: report.errors.length,
    },
  });
  revalidate();
  const summary = describe(report);
  if (report.errors.length && !report.created && !report.updated) {
    return { error: `${summary}. ${report.errors[0]?.message ?? ""}`.trim(), report };
  }
  return { ok: true, report, summary };
}

/** GitHub → app. Creates proposals for new issues, refreshes linked ones. */
export async function pullEnhancementsAction(_prev: BridgeResult = {}, formData?: FormData): Promise<BridgeResult> {
  const viewer = await getViewer();
  if (!canEdit(viewer)) return { error: "Read-only access." };
  const raw = formData ? String(formData.get("refs") ?? "") : "";
  const refs = raw.split(",").map((value) => value.trim()).filter(Boolean);
  return run("pull", { refs, actorName: viewer.person.name, actorId: viewer.person.id });
}

/** App → GitHub. Opens issues for unlinked proposals and updates linked ones. */
export async function pushEnhancementsAction(_prev: BridgeResult = {}, formData?: FormData): Promise<BridgeResult> {
  const viewer = await getViewer();
  if (!canEdit(viewer)) return { error: "Read-only access." };
  const raw = formData ? String(formData.get("refs") ?? "") : "";
  const refs = raw.split(",").map((value) => value.trim()).filter(Boolean);
  return run("push", { refs, actorName: viewer.person.name, actorId: viewer.person.id });
}

/**
 * Pull then push. This is the button the tab offers by default: it is the only
 * order that cannot lose an edit made on GitHub, because the local side has
 * already seen the remote change before it writes back.
 */
export async function syncEnhancementsBothWaysAction(
  _prev: BridgeResult = {},
  formData?: FormData
): Promise<BridgeResult> {
  const viewer = await getViewer();
  if (!canEdit(viewer)) return { error: "Read-only access." };
  const raw = formData ? String(formData.get("refs") ?? "") : "";
  const refs = raw.split(",").map((value) => value.trim()).filter(Boolean);
  return run("full", { refs, actorName: viewer.person.name, actorId: viewer.person.id });
}

/** Save the bridge configuration. Administrator only: it can point at any repo. */
export async function saveBridgeConfigAction(
  _prev: BridgeConfigResult,
  formData: FormData
): Promise<BridgeConfigResult> {
  const viewer = await getViewer();
  if (!canAdmin(viewer)) return { error: "Only an administrator can configure the GitHub bridge." };

  const rawRepo = String(formData.get("repo") ?? "").trim();
  const repo = rawRepo ? normaliseRepo(rawRepo) : "";
  if (rawRepo && !repo) return { error: "Repository must look like owner/name, or a github.com URL." };

  const label = String(formData.get("label") ?? "").trim();
  const state = String(formData.get("state") ?? "all");
  const prefix = String(formData.get("status_label_prefix") ?? "").trim() || "status:";
  const enabled = String(formData.get("enabled") ?? "") === "on";

  setSetting(BRIDGE_SETTING_KEYS.repo, repo);
  setSetting(BRIDGE_SETTING_KEYS.label, label);
  setSetting(BRIDGE_SETTING_KEYS.state, ["open", "closed", "all"].includes(state) ? state : "all");
  setSetting(BRIDGE_SETTING_KEYS.statusLabelPrefix, prefix);
  setSetting(BRIDGE_SETTING_KEYS.enabled, enabled ? "true" : "false");

  recordAudit({
    actorId: viewer.person.id,
    actorName: viewer.person.name,
    action: "enhancement.github_config",
    entity: "settings",
    entityId: BRIDGE_SETTING_KEYS.repo,
    after: { repo, label, state, enabled, statusLabelPrefix: prefix },
  });
  revalidate();
  return { ok: true };
}

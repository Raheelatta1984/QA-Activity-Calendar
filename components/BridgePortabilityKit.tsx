"use client";

import { useState } from "react";
import { Icon } from "./icons";

/**
 * The "reuse this in another repository" panel.
 *
 * The bridge is deliberately a closed module: two server-side files, one client
 * panel, one migration and one settings block. Showing the exact list — and a
 * copyable install prompt — is what makes it reusable in a *different* GitHub
 * project without the reader reverse-engineering this repository.
 */

const FILES: Array<{ path: string; role: string; portable: boolean }> = [
  { path: "lib/enhancement-bridge.ts", role: "GitHub client, config resolution, issue↔proposal mapping, push/pull engine. No React, no Next.js, no domain tables.", portable: true },
  { path: "lib/enhancement-bridge-store.ts", role: "The only file that knows your data layer. Re-implement `BridgeStore` for the target app.", portable: false },
  { path: "app/actions/enhancement-bridge.ts", role: "Four server actions: pull, push, sync both ways, save configuration.", portable: true },
  { path: "components/GithubBridgePanel.tsx", role: "The panel: live run report, linked issues, recent runs, configuration form.", portable: true },
  { path: "db/migrations/004_enhancement_bridge.sql", role: "Columns on the proposal table, the link table and the sync journal.", portable: true },
  { path: "app/api/enhancements/sync/route.ts", role: "Optional cron/webhook endpoint so a scheduled job can run the two-way sync unattended.", portable: true },
];

const STEPS: Array<{ title: string; detail: string }> = [
  {
    title: "1 · Point it at the other repository",
    detail:
      "Set GITHUB_ENHANCEMENTS_REPO on the deployment (or save it in Master Setup → GitHub bridge) and give the server token `issues: write` on that repository. Nothing else changes: the same tab now manages that project's enhancements.",
  },
  {
    title: "2 · Install the module",
    detail:
      "Copy the five portable files, run the migration, add `ensureBridgeSettings()` to the bootstrap. The bridge only needs a table of proposals and a settings store.",
  },
  {
    title: "3 · Choose the import label",
    detail:
      "Issues carrying the configured label (default `future-enhancement`) are pulled in; every pushed proposal gets it. Add `status:*` labels only through the app — they mirror the pipeline stage.",
  },
  {
    title: "4 · Work from either end",
    detail:
      "Open issues in GitHub, open proposals in the app, or both. Pull before push; a conflict is reported item by item, progress never moves backwards and a Rejected decision is never undone.",
  },
];

export function BridgePortabilityKit({ repo }: { repo: string }) {
  const [copied, setCopied] = useState(false);
  const prompt = [
    "Add the Future Enhancements GitHub bridge (v2) to this repository.",
    `Source implementation: ${repo || "owner/QA-Activity-Calendar"}.`,
    "Copy lib/enhancement-bridge.ts, app/actions/enhancement-bridge.ts, components/GithubBridgePanel.tsx and the 004 migration.",
    "Implement lib/enhancement-bridge-store.ts against this project's data layer (BridgeStore interface).",
    "Register a section `sec.enhancements.github` and expose the panel; add GITHUB_ENHANCEMENTS_REPO and GITHUB_TOKEN to the server environment.",
    "Two-way is mandatory: pulling imports issues, pushing opens/updates them, and the default run pulls first.",
  ].join("\n");

  async function copy() {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="card-pad stack">
      <div className="grid-2">
        <div>
          <div className="label">What the module contains</div>
          <div className="stack-sm">
            {FILES.map((file) => (
              <div className="row" key={file.path} style={{ gap: 8, alignItems: "flex-start" }}>
                <span className={`badge ${file.portable ? "badge-green" : "badge-amber"}`} style={{ flexShrink: 0 }}>
                  {file.portable ? "portable" : "adapt"}
                </span>
                <div style={{ minWidth: 0 }}>
                  <div className="mono" style={{ fontSize: "0.76rem" }}>{file.path}</div>
                  <div className="card-sub">{file.role}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div>
          <div className="label">Adding it to another GitHub project</div>
          <div className="stack-sm">
            {STEPS.map((step) => (
              <div key={step.title}>
                <div style={{ fontSize: "0.84rem", fontWeight: 600 }}>{step.title}</div>
                <div className="card-sub">{step.detail}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="banner info">
        <Icon name="sparkles" size={15} />
        <span>
          The bridge is opt-in per deployment and per repository, so one installation can manage several projects by running
          with a different <code className="mono">GITHUB_ENHANCEMENTS_REPO</code>. The full porting guide — including the store
          contract and the API endpoint — is{" "}
          <code className="mono">docs/ENHANCEMENTS-GITHUB-BRIDGE.md</code>.
        </span>
      </div>

      <div className="row" style={{ gap: 8 }}>
        <button className="btn btn-sm" type="button" onClick={copy}>
          <Icon name={copied ? "check" : "upload"} size={13} /> {copied ? "Copied install prompt" : "Copy install prompt"}
        </button>
        <span className="card-sub">Paste it into a new Agent Mode session in the target repository.</span>
      </div>
    </div>
  );
}

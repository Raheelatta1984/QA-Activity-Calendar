# Workflows — install into TARGET repositories

The hub publishes a handover document into a connected repository when a
request reaches **Building**. These two workflows make that repository finish
the loop (the same automation the source QA-Calendar project runs), adapted to
any repo layout:

| File | Role |
| --- | --- |
| `enhancement-intake.yml` | A new `future-enhancements/ENH-*.md` on `main` opens one idempotent `arena-handover` issue with a ready-to-paste Arena Agent Mode prompt. |
| `enhancement-archive.yml` | When the implementation PR merges, the handover moves to `future-enhancements/archived/` with status `Archived`, linked issues close, and `POST /api/v1/sync` on the hub reconciles the database. |

## Install (per target repository)

1. Copy `enhancement-intake.yml` and `enhancement-archive.yml` into
   `.github/workflows/`.
2. Copy the two helper scripts (see below) and commit.
3. Repository **variables** (Settings → Secrets and variables → Actions):
   - `HANDOVER_DIR` — where handovers live (default `future-enhancements`;
     must match the application's `handoverDir` in the hub).
   - `HUB_SYNC_URL` *(optional)* — e.g. `https://hub.example.com/api/v1/sync`
     and `HUB_SYNC_KEY` secret, so archive completion notifies the hub directly.
4. Nothing else. The intake workflow is free-plan compatible (no paid agent,
   no GitHub Models, no external LLM key); development is user-initiated in
   Arena Agent Mode, exactly as in the source project.

## Helper scripts referenced by the workflows

The archive workflow calls `scripts/enhancement-archive.mjs` in the target
repository — that is this project's `scripts/archive-handovers.mjs` (copy it
into the target repo under that path, or point the workflow at this project).
The intake workflow calls `.github/scripts/enhancement-intake.mjs`; a minimal
implementation:

```js
#!/usr/bin/env node
// Detect which active handovers the current event introduced.
import fs from "node:fs";
import { execSync } from "node:child_process";

const dir = process.env.HANDOVER_DIR || "future-enhancements";
const mode = process.env.MODE || "new";
const all = fs.existsSync(dir)
  ? fs.readdirSync(dir).filter((f) => /^ENH-[0-9]+-[a-z0-9-]+\.md$/i.test(f))
  : [];
let names = all;
if (mode === "new" && process.env.BEFORE_SHA && process.env.BEFORE_SHA !== "0000000000000000000000000000000000000000") {
  const changed = execSync(`git diff --name-only ${process.env.BEFORE_SHA} ${process.env.GITHUB_SHA} -- ${dir}`, { encoding: "utf8" })
    .split("\n").map((l) => l.split("/").pop()).filter(Boolean);
  names = all.filter((f) => changed.includes(f));
}
// Only still-active (Building/Built) handovers raise requests.
const active = names.filter((f) => {
  const status = fs.readFileSync(`${dir}/${f}`, "utf8").match(/^status:\s*"([^"]+)"/m)?.[1];
  return status === "Building" || status === "Built";
});
core = { setOutput: (k, v) => process.stdout.write(`::set-output name=${k}::${v}\n`) };
core.setOutput("names", active.join("\n"));
console.log(`Active handovers: ${active.join(", ") || "none"}`);
```

Then run `workflow_dispatch → all_active` once after installing to backfill
handovers that were published before the workflow existed.

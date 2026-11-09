# Future Enhancements ↔ GitHub bridge (v2)

The **Future Enhancements** tab (`tab.enhancements`) and a GitHub repository can
now run the *same* enhancement backlog in both directions. Neither side is a
copy of the other: both are live, and either one can be the place where work
starts.

| Where you are | What you do | What happens |
| --- | --- | --- |
| In the app | Submit a proposal, then **Push to GitHub** | One issue is created (or updated) in the configured repository, labelled `future-enhancement` and `status:<stage>` |
| In GitHub | Open an issue with the import label, then **Pull from GitHub** | A proposal appears in the vault, with the issue's title, body and status |
| Both | **Sync both ways** (default) | Pull runs first, then push — so an edit made on GitHub is never overwritten by an older local copy |
| GitHub | Open a PR that mentions the issue | The PR is linked to the proposal and shown on its card |
| Either | Close the issue / archive the proposal | The other side follows: a closed issue becomes `Archived`, an `Archived` proposal closes its issue |

The **GitHub bridge (v2)** section is `sec.enhancements.github`; the reuse kit is
`sec.enhancements.portability`.

---

## 1. What "two way" actually means

The bridge has three verbs, each available as a button and as an action:

| Verb | Direction | Behaviour |
| --- | --- | --- |
| `pull` | GitHub → app | Refreshes every linked issue, imports issues carrying the import label, refuses to move a proposal backwards, and never overwrites a `Rejected` decision |
| `push` | app → GitHub | Creates an issue for an unlinked proposal, updates title/body/labels/state for a linked one, and closes the issue when the proposal is `Archived` or `Rejected` |
| `full` | both | `pull` then `push`. This is what the button and the schedule run |

### Field ownership

There is no "master" side, so the rules have to be explicit. They are:

| Field | Wins |
| --- | --- |
| `title`, `brief`, `requirements`, `impacts`, `expected_outcome`, `success_criteria` | the side whose `updated_at` is newer (a remote change older than the last sync is ignored) |
| `status` | the furthest-along of the two, using `pipelineStages()` — **except** `Rejected`, which is terminal and is never undone by a state change upstream |
| issue state | derived: `Archived`/`Rejected` ⇒ closed, everything else ⇒ open |
| labels | owned by the bridge; any non-`status:` label a person adds on GitHub is preserved |
| a PR named in the issue | read-only, linked to the proposal, never created by the bridge |

A conflict is **reported**, not silently resolved. The run report lists every
item with the reason it was or was not changed (`local-is-further-along`,
`remote-is-newer`, `rejection-is-terminal`, …).

### Why pull runs first

`push` writes the app's version. If the app had not yet seen a newer edit made
on GitHub, that write would destroy it. Running `pull` first guarantees the local
copy is at least as new as the remote before anything is written back. That is
the whole reason `full` exists, and why it is the default.

---

## 2. Status ← → label mapping

Statuses are mirrored as labels so GitHub's own filters, boards and automation
can use them:

```
Submitted  → status:submitted
Reviewing  → status:reviewing
Accepted   → status:accepted
Building   → status:building
Built      → status:built
Archived   → status:archived
Rejected   → status:rejected
```

The prefix is configurable (`status:` by default). Labels are created on demand,
so a fresh repository needs no manual setup.

Labels are written lower case and matched case-insensitively, then normalised
back to the canonical stage (`status:built` → `Built`) before ranking and before
being stored — so every status the bridge writes is one the app accepts, and a
stage moved on GitHub is always applied.

**Do not** add a `status:*` label by hand and expect it to be authoritative: the
next pull treats it as a remote status and the furthest-along rule applies. That
is usually what you want, but it is worth knowing.

The issue body carries a metadata block so the round-trip is lossless:

```markdown
<!-- future-enhancements-bridge
ref: ENH-0007
status: Building
submitted_by: Amara Okafor
department: HFM IT QA
-->

The human-written brief…

### Requirements

…

### Success criteria

…
```

A body a person wrote by hand (no metadata block) is imported verbatim — nothing
is invented from it.

---

## 3. Configuration

Two sources, with a deliberate precedence: **environment first, then settings**.

| Setting | Env override | Default | Purpose |
| --- | --- | --- | --- |
| Repository | `GITHUB_ENHANCEMENTS_REPO` (falls back to `GITHUB_REPO`) | unset | `owner/name` of the repository holding the issues |
| Token | `GITHUB_TOKEN` | unset | Must be able to read and write issues on that repository |
| Import label | `GITHUB_ENHANCEMENTS_LABEL` | `future-enhancement` | Only issues with this label are pulled in |
| Import state | — | `all` | `open`, `closed` or `all` |
| Status prefix | — | `status:` | Prefix for the mirrored status labels |
| Enabled | `GITHUB_BRIDGE_ENABLED=false` | on | Switches the whole bridge off |

The environment wins because a deployment that pins its repository should not be
re-pointed by whichever administrator opens Master Setup. When
`GITHUB_ENHANCEMENTS_REPO` is set the repository field is disabled in the UI and
says so.

Everything is also editable in **Master Setup → GitHub bridge** (the
configuration block inside `sec.enhancements.github`, administrators only). No
value is a secret: the token only ever lives in the server environment and is
never returned to the browser, logged or written to the audit trail.

> **Reusing the module across projects.** Point `GITHUB_ENHANCEMENTS_REPO` at a
> *different* repository and this deployment manages that project's
> enhancements. Run a second instance with a different value and one app serves
> both backlogs. That is the portability design: the repository is configuration,
> not code.

### Required token permissions

Fine-grained token: **Issues: read and write**, **Metadata: read**, on the target
repository. Classic token: `repo` (private) or `public_repo` (public).

---

## 4. Unattended sync

Two mechanisms, both optional, both disabled until configured:

### `POST /api/enhancements/sync`

| Header | Value |
| --- | --- |
| `Authorization` | `Bearer $ENHANCEMENT_SYNC_SECRET` |
| *or* `x-hub-signature-256` | HMAC-SHA256 of the raw body with the same secret (GitHub webhook format) |

Body: `{ "direction": "full" | "pull" | "push", "refs": ["ENH-0007"] }`, both
optional. `GET` on the same path returns the bridge's configuration state with
no repository data — useful as a smoke test.

Without `ENHANCEMENT_SYNC_SECRET` the endpoint returns `401` and does nothing.
An unauthenticated write path into GitHub is not a default.

### `.github/workflows/enhancement-github-sync.yml`

Runs every 30 minutes, on every `issues` event in this repository, and on demand.

It does **not** talk to GitHub itself: the deployed app owns the enhancement
database and the token, so the workflow calls the endpoint above with
`APP_URL` + `ENHANCEMENT_SYNC_SECRET`. When either is missing it emits a
`::notice` and exits green — a repository that has not opted in is never left
with a red run.

```bash
# manual run, same code path
npm run enhancement:github-sync        # needs APP_URL + ENHANCEMENT_SYNC_SECRET
```

---

## 5. Porting the module to another repository

The bridge is **five portable files and one adapter**. It has no knowledge of
QA activities, capacity, releases or this app's domain.

| File | Portable? | Why |
| --- | --- | --- |
| `lib/enhancement-bridge.ts` | ✅ yes | GitHub client, config, mapping, engine. No React, no Next.js, no SQL |
| `app/actions/enhancement-bridge.ts` | ✅ yes | Four server actions (pull, push, sync, save config) |
| `components/GithubBridgePanel.tsx` | ✅ yes | The panel: report, links, runs, configuration |
| `db/migrations/004_enhancement_bridge.sql` | ✅ yes | Columns, `enhancement_links`, `enhancement_sync_events` |
| `app/api/enhancements/sync/route.ts` | ✅ yes | Authenticated cron/webhook endpoint |
| `lib/enhancement-bridge-store.ts` | ⚠️ adapt | The **only** file that knows the data layer |
| `tests/enhancement-bridge.test.ts` | ✅ yes | 18 tests against a fake GitHub; reuse as the conformance suite |

### The store contract

Implement this against the target app's data layer and the engine works
unchanged:

```ts
export type BridgeStore = {
  list: () => BridgeRecord[];
  findByRef: (ref: string) => BridgeRecord | undefined;
  create: (input: { ref; title; brief; status; repo; issue; labels; actorName }) => BridgeRecord;
  update: (id: string, patch: Record<string, unknown>) => void;
  nextRef: () => string;
  replaceLinks: (id, repo, links: Array<{ kind: "issue" | "pull"; number; url?; title?; state?; merged? }>) => void;
  recordEvent: (event: { direction; actorName?; repo; pulled; pushed; created; updated; skipped; errors; detail? }) => void;
};
```

The minimum shape of a proposal is `BridgeRecord`:

```ts
type BridgeRecord = {
  id: string; ref: string; title: string; brief: string | null; status: string;
  requirements?: string | null; impacts?: string | null;
  expected_outcome?: string | null; success_criteria?: string | null;
  github_repo?: string | null; github_issue_number?: number | null;
  github_issue_url?: string | null; github_state?: string | null;
  github_labels?: string | null; github_updated_at?: string | null;
  github_synced_at?: string | null; github_direction?: string | null;
  submitted_by_name?: string | null; department_name?: string | null;
};
```

### Install steps

1. Copy the five portable files plus the migration.
2. Implement `BridgeStore` for the target data layer.
3. Register a section (e.g. `sec.enhancements.github`) and render
   `<GithubBridgePanel />` with the configuration, links and events it expects.
4. Add `ensureBridgeSettings()` to the bootstrap so the setting keys exist.
5. Set `GITHUB_TOKEN` and `GITHUB_ENHANCEMENTS_REPO` on the server.
6. Run the conformance suite: `npm test` (the bridge suite runs with the rest).
7. Optionally copy the workflow and set `APP_URL` + `ENHANCEMENT_SYNC_SECRET`.

### Conformance checklist

A port is correct when all of these hold — each is covered by a test in
`tests/enhancement-bridge.test.ts`:

- [ ] `owner/name` and `github.com` URLs are accepted; anything else is rejected
- [ ] an unconfigured bridge refuses to run and says exactly what is missing
- [ ] an issue body round-trips byte-identically (so a no-op push sends no write)
- [ ] every `status:*` label round-trips to the canonical stage, in any casing
- [ ] a second push sends zero writes
- [ ] a human-written body is imported verbatim
- [ ] an unlabelled issue is ignored
- [ ] a closed issue archives the proposal; `Rejected` survives it
- [ ] an older remote edit does not overwrite a newer local one
- [ ] one failing proposal does not abort the run
- [ ] `Archived` closes the issue and reopening the proposal reopens it

---

## 6. Operational notes

- **Idempotent by construction.** Every write is compared against the remote
  payload first, so a scheduled run that finds nothing to do issues no writes.
- **Journalled.** Every run is recorded in `enhancement_sync_events` and shown in
  the panel (direction, actor, counts, errors), and audited
  (`enhancement.github_pull|push|full|config`).
- **Bounded.** A pull inspects at most `limit` issues per run (default 300) and
  reports when it stopped early; the next run continues.
- **Failures are per item.** A single unreadable issue is reported and skipped;
  it never aborts the run.
- **Never archives a handover.** The bridge and the handover archive automation
  are separate: the bridge moves the *issue*, the archive workflow moves the
  *Markdown*. They meet at the `Archived` status, which both understand.

## 7. Known limits

- GitHub Projects (v2) needs a user-level token with `project` scope; the bridge
  does not touch Projects yet. Issues and PRs are supported.
- The import label defaults to `future-enhancement`; a repository that already
  uses another label must either add this one or change the setting.
- A pull cannot page past `limit` issues in a single serverless invocation — run
  it again (the schedule does this every 30 minutes).
- PR discovery uses the search API, which is rate limited more aggressively than
  the rest of the bridge. A missing PR link never fails a sync; it is retried on
  the next run.

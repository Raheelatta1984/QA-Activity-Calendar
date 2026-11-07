# Architecture

## Why a hub

The source project (QA Activity Calendar) proved the *model*: an in-app
enhancement studio whose requests harden into Markdown handover documents,
published to a repository, turned into development requests, and archived
automatically when the implementation merges. But the model was welded to one
application: one tenant (the org), one repository (its own), one auth model.

The hub extracts that model and generalises it along three axes:

1. **Tenancy** — many organisations, each with isolated request sets.
2. **Applications** — each tenant registers any number of projects/products,
   each with its own GitHub repository connector and handover directory.
3. **Surface** — REST + MCP + embedded library + web console, attachable to any
   host stack (the "works with any git project, like MCP" requirement).

## Module map

```
enhancements-hub/
├── server/
│   ├── index.ts        standalone shell (node:http) — the "resumable project" mode
│   ├── app.ts          createHubHandler(): ONE Web-Request handler every host mounts
│   ├── router.ts       REST v1 route table (pure handlers)
│   ├── auth.ts         AuthAdapter interface + HeaderAuthAdapter default
│   ├── http.ts         json/error/CORS helpers
│   ├── db.ts           node:sqlite layer (the only file to swap for Postgres)
│   ├── schema.ts       embedded, idempotent schema + forward-only upgrades
│   └── core/           ── the portable domain ──
│       ├── status.ts   lifecycle vocabulary + transition guards   (pure)
│       ├── markdown.ts deterministic rendering/frontmatter/filenames (pure)
│       ├── draft.ts    local drafting engine                      (pure)
│       ├── vault.ts    markdown vault + handover scan/match/sync  (fs only)
│       ├── github.ts   per-application Contents-API connector     (fetch only)
│       └── service.ts  business rules over db + vault + github
├── server/adapters/
│   ├── next.ts         App Router mount (one file, any path prefix)
│   ├── express.ts      Express/Connect mount
│   └── mcp.ts          JSON-RPC 2.0 tools endpoint
├── web/                zero-build console (pipeline · studio · registry · vault · audit)
├── scripts/            archive + sync CLIs (directory-parameterised)
├── workflows/          GitHub Actions templates to install in TARGET repos
└── tests/              lifecycle · vault · REST e2e · MCP
```

Dependency direction is strictly inward: `adapters → app/router → service →
core → db/schema`. Nothing in `core/` imports a framework. That is what makes
the module attachable: a host brings identity (via `AuthAdapter`) and, if it
wants, an alternative `db.ts`.

## Data model

```
tenants(id, slug†, name)
applications(id, tenant_id→tenants, slug, name, github_repo, github_branch,
             handover_dir, token_env, enabled)        UNIQUE(tenant_id, slug)
enhancements(id, tenant_id→tenants, application_id→applications, ref,
             title, brief, requirements, impacts, expected_outcome,
             success_criteria, sections, markdown, status, github_path,
             submitted_by, ai_fields, votes, archived_at, …)
                                            UNIQUE(application_id, ref)
audit_events(id, tenant_id, actor, action, entity, entity_id,
             before_json, after_json, meta, at)
```

† slug unique per table; `ref` (ENH-0001…) unique **per application**, so every
connected repository gets its own ENH sequence, matching what the target repo's
automation and contributors see locally.

Deliberate differences from the source model:

- **No people/departments tables.** Identity is the `Actor` the host adapter
  supplies; a hub that imposed a user model on every host would not be
  attachable.
- **`token_env` stores a variable NAME, never a token.** Secrets stay in the
  server environment; the registry is safe to export, log and share.
- **`sections` is free text** (source: in-app tab/section catalogue IDs) — the
  catalogue belongs to the host, not the hub.

## Lifecycle contract

```
Submitted → Reviewing → Accepted → Building → Built → Archived
       \_______________________________________▲_______/
                 Rejected (reopenable to Reviewing)
```

- **Building** re-renders the record with `status: "Building"`, writes it to the
  local vault (`<tenant>/<app>/ENH-xxxx.md`) and — when the application has a
  connector — commits it to the target repo via the GitHub Contents API
  (create-or-update with sha conflict detection).
- **Built** re-publishes (frontmatter truthfully says `Built`); the target repo's
  completion workflow moves the file into `<handover_dir>/archived/`.
- **Archived** relocates the local vault copy into `archived/` and stamps
  `archived_at`. Terminal statuses (`Archived`, `Rejected`) only reopen
  deliberately; `statusAfterArchive` never overwrites a Rejected decision.
- **Reconciliation** (`syncScopeDocs`, exposed at `POST /api/v1/sync` and
  `scripts/sync-docs.ts`) makes the file the source of truth: an archived
  document archives its record; a `Built` document promotes any earlier record;
  a moved document re-points `github_path`. This is the same contract the source
  project ran — records follow documents, not the other way round.

## Automation loop (per target repository)

```
hub: status→Building ──publish──▶ repo: handover_dir/ENH-xxxx.md
                                   │  intake workflow
                                   ▼
                            arena-handover issue (ready-to-paste Arena prompt)
                                   │  developer starts Arena Agent Mode session
                                   ▼
                            PR ("Closes #n", Enhancement-Archive: <file>)
                                   │  CI gate → squash merge
                                   ▼
repo: archive workflow ──▶ handover moved to archived/, issue closed
                                   │
hub: POST /api/v1/sync ◀───────────┘   record follows to Archived
```

`workflows/` ships both templates, parameterised by the repository's
`HANDOVER_DIR` variable so any repo layout works. Free-plan compatible —
development is user-initiated in Arena Agent Mode (one session per PR), exactly
as in the source project.

## Security notes

- Bearer keys never appear in URLs; CORS is permissive on headers but write
  access still requires the key (or a host-supplied adapter identity).
- Vault paths are sanitised (`path.basename`, slug validation) — handover
  filenames matching `ENH-[0-9]+-[a-z0-9-]+.md` only, no traversal.
- GitHub tokens: environment-only, resolved per connector at call time.
- Audit events capture actor, action, before/after for every write — the
  provenance trail the source app kept, including which fields the drafting
  engine suggested (`ai_fields`).

## Extension points

| Want to… | Do this |
| --- | --- |
| Use Postgres | reimplement `server/db.ts` (same 4 primitives: all/get/run/useDatabaseFile) |
| Host a real auth model | implement `AuthAdapter`, pass to `createHubHandler` |
| Hosted drafting model | set `AI_PROVIDER`, replace `core/draft.ts` internals (shapes unchanged) |
| New MCP tool | append to `MCP_TOOLS` in `server/adapters/mcp.ts` |
| Different vault layout | `core/vault.ts` `scopeDir()` is the only place scopes become paths |

# Enhancements Hub

A **centralised, multi-tenant Future Enhancements module** — extracted end-to-end
from the QA Activity Calendar project (model → lifecycle → handover publishing →
completion automation) and rebuilt so it can run **by itself** or be **attached
to any other project**, for any stack.

```
tenant ──▶ application ──▶ GitHub repo connector
                │
                ▼
   enhancement request (Submitted → Reviewing → Accepted → Building → Built → Archived)
                │                     ▲
                │ Building            │ reconciled by docs sync
                ▼                     │
   Markdown handover published ──────┘
   into the target repo + local vault → arena-handover issue → PR → auto-archive
```

**Zero runtime dependencies.** Node 22's built-in SQLite, the standard Web
`Request`/`Response`, and `fetch`. Attach it to Next.js, Express, Fastify, a
FastAPI proxy behind it, a Cloudflare Worker, or drive it purely over MCP.

## Run it standalone (resumable project)

```bash
cd enhancements-hub
npm install          # dev tooling only (tsx + typescript)
npm run dev          # → http://localhost:4310
```

| Surface | Where |
| --- | --- |
| Web console (pipeline, studio, registry, vault, audit) | `http://localhost:4310/` |
| REST API | `/api/v1/*` — see below |
| MCP endpoint | `POST /mcp` (JSON-RPC 2.0: `initialize`, `tools/list`, `tools/call`) |
| Tests | `npm test` · Typecheck: `npm run typecheck` |

Data lives in `data/enhancements-hub.db` (SQLite, WAL) and the Markdown vault in
`vault/<tenant>/<application>/ENH-*.md`. Both paths are configurable — see
`.env.example`.

## The API (v1)

```
GET    /api/v1/health                          service + storage status
GET    /api/v1/meta                            statuses, labels, hints
GET    /api/v1/tenants                         list tenants
POST   /api/v1/tenants                         {slug, name}
GET    /api/v1/applications?tenant=            registry + connector summary
POST   /api/v1/applications                    register tenant/application/repo
POST   /api/v1/applications/:id/test           verify the GitHub connector
GET    /api/v1/enhancements?tenant=&application=&status=&q=&includeArchived=
POST   /api/v1/enhancements                    raise a request
GET    /api/v1/enhancements/:id                fetch one (id or ENH-ref)
PATCH  /api/v1/enhancements/:id                edit fields (re-renders markdown)
DELETE /api/v1/enhancements/:id
GET    /api/v1/enhancements/:id/markdown       download the handover document
POST   /api/v1/enhancements/:id/status         {status} — Building/Built publish to GitHub
POST   /api/v1/enhancements/:id/archive
POST   /api/v1/draft                           local drafting engine
POST   /api/v1/suggest                         per-field suggestions
POST   /api/v1/preview-handover                markdown preview
GET    /api/v1/vault?tenant=&application=      handover documents
POST   /api/v1/sync                            reconcile statuses with the vault
GET    /api/v1/audit?limit=                    audit trail
```

**Auth** (default adapter, swap for your own — see `INTEGRATION.md`):

- `Authorization: Bearer $HUB_API_KEY` (or `X-Api-Key:`) → **admin**
- `Authorization: Bearer $HUB_READ_KEY` → read-only
- nothing, with no keys configured → key-less dev mode (**admin** — local demo only)
- nothing, with keys configured → read-only anonymous (viewer)
- `HUB_AUTH_MODE=strict` → reject any request without a key (401)
- `X-Actor: name` and `X-Tenant: slug` attribute the request

## MCP — "works with any git project"

`POST /mcp` speaks Model Context Protocol, so any MCP client can drive the
pipeline across all connected repositories:

```bash
curl -s localhost:4310/mcp -X POST -H 'content-type: application/json' -d '{
  "jsonrpc":"2.0","id":1,"method":"tools/list"
}'
# → list_enhancements, create_enhancement, draft_enhancement, set_status,
#   get_markdown, list_applications, list_vault, sync_vault, recent_audit
```

## What was extracted from QA Activity Calendar

| Source | In the hub |
| --- | --- |
| `lib/enhancement-status.ts` | `server/core/status.ts` (lifecycle + transition guards) |
| `lib/enhancements.ts` | `server/core/markdown.ts` + `server/core/vault.ts` |
| `lib/enhancement-docs.ts` | `server/core/vault.ts` (scan/match/sync, per-scope) |
| `lib/ai.ts` (enhancement slice) | `server/core/draft.ts` (host-agnostic drafting engine) |
| `lib/github-enhancements.ts` | `server/core/github.ts` (per-application connector) |
| `app/actions/enhancements.ts` | `server/core/service.ts` (framework-free) |
| `app/api/enhancements/[id]` | `GET /api/v1/enhancements/:id/markdown` |
| `app/(app)/enhancements/page.tsx`, `EnhancementStudio.tsx` | `web/` console + REST/MCP |
| `.github/workflows/*` | `workflows/` templates for **target** repositories |
| `scripts/archive-enhancements.mjs`, `sync-docs-cli.ts` | `scripts/` (directory-parameterised) |

New in the hub (not in the source app): **tenants**, the **application registry**
(one GitHub connector per project/product), **MCP endpoint**, **REST API**,
header-based **auth adapter**, and a standalone shell.

## Docs

- [`INTEGRATION.md`](./INTEGRATION.md) — attach to Next.js / Express / any stack
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — tenancy model, lifecycle, automation contract
- [`workflows/README.md`](./workflows/README.md) — installing the automation into target repos
- [`../docs/ENHANCEMENT-AUTOMATION.md`](../docs/ENHANCEMENT-AUTOMATION.md) — the source project's automation guide (background)

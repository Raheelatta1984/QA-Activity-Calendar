# Deployment, security & recovery

## 1. Requirements

- Node.js **22.5+** (uses the built-in `node:sqlite`; tested on 22.22).
- npm 10+.
- A database. **Postgres is the production store** and is supported in-app: set
  `DATABASE_URL` and the same code, schema, migrations and queries run against
  it. With no `DATABASE_URL` the app uses a local SQLite file, which is right for
  a laptop and wrong for a deployment (§3). See
  [ERD → Postgres](./ERD.md#postgres--neon).

## 2. Local / staging runbook

```bash
git clone <repo>
cd QA-Activity-Calendar
npm ci
cp .env.example .env

# 32-byte random secret
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # paste into SESSION_SECRET

npm run db:migrate        # apply db/migrations/*.sql in order
npm run db:seed           # reference config + demo data (set SEED_DEMO_DATA=false to skip demo rows)
npm run typecheck
npm test
npm run build
npm start                 # 0.0.0.0:3000
```

First boot also bootstraps idempotently: migrations → reference configuration → demo data (unless disabled) → validation scan. Running the app twice never duplicates records.

## 3. Serverless deployment (Vercel)

Vercel gives a function a **read-only bundle** and a **writable `/tmp`**, and each instance has its own disk. The app detects this runtime and adapts:

| Concern | Behaviour on Vercel |
| --- | --- |
| Database | `DATABASE_URL` → Postgres (durable). Without it, SQLite at `DATABASE_FILE`, otherwise `/tmp/qa-calendar.db`; if the configured path is not writable the app logs a warning and falls back to `/tmp`. |
| Enhancement vault | `ENHANCEMENT_VAULT_DIR` if set, otherwise `/tmp/enhancements` on serverless (and falls back to `/tmp/enhancements` whenever the repository `enhancements/` directory returns `EROFS`/`EACCES`). Proposals remain downloadable as frontmatter Markdown via `/api/enhancements/:id`. |
| Schema | Migrations are embedded into `db/migrations.generated.ts` at build time (`prebuild`), so a cold start never depends on `.sql` files that were not traced into the bundle. Also applied read from disk in dev. |
| Seeding | Idempotent bootstrap runs on the first request per instance: migrations → reference config → demo rows (unless `SEED_DEMO_DATA=false`) → validation scan. A failed run is retried on the next request and its error is exposed by `/api/health`. |
| Sessions | Cookies are signed, self-contained tokens (`<base64url payload>.<hmac>`), so a login survives a cold start or a hop to another instance. The `sessions` row is still written and honoured when present (revocation/audit). |
| Persistence | With `DATABASE_URL` (Postgres) data is durable and shared by every instance. Without it, storage is **per instance only**: data resets when the function restarts, two instances can diverge, and the UI shows a "Serverless demo instance" banner. |

Required project settings:

```
Framework preset   Next.js
Build command      npm run build        (prebuild embeds migrations)
Install command    npm install
Node.js version    22.x                 (node:sqlite requires 22.5+)
Env                SESSION_SECRET=<32+ random chars>   (recommended; a dev secret is used otherwise)
                   DATABASE_URL=postgres://…          (required for durable data)
                   DATABASE_REQUIRE_POSTGRES=true     (refuse to run on a local file)
```

Do **not** set `DATABASE_FILE` to a path inside the deployment bundle — it is read-only. Leave it unset to use `/tmp`, or point it at a mounted writable volume if your platform provides one.

On Vercel, `pg` is kept out of the bundle by `serverExternalPackages` and traced
into the server output explicitly, because the Postgres bridge resolves it with
`require()` at runtime rather than through a static import.

### Health probe

`GET /api/health` returns JSON and no secrets — use it when a deployment shows "Application error … Digest":

```json
{
  "ok": true,
  "driver": "postgres",
  "durable": true,
  "target": "postgres://qa@db.example/qa",
  "baseline": "005_release_planning.sql",
  "fallbackReason": null,
  "ephemeral": false,
  "serverless": true,
  "bootstrapDone": true,
  "bootstrapError": null,
  "tables": 40,
  "migrations": ["pg-baseline@005_release_planning.sql"],
  "people": 12
}
```

`200` means the schema and seed are present on that instance; `503`/`500` include the bootstrap error message.

### Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Application error … Digest` on every page | Bootstrap failed (schema missing) or `node:sqlite` unavailable | Open `/api/health`; check `bootstrapError`; confirm Node 22.x |
| Health shows `people: 0` | Seeding skipped (`SEED_DEMO_DATA=false`) or not yet run | Hit any page once, or call `/api/health` (it bootstraps) |
| `no such table: …` | Migration SQL missing from the bundle | Ensure `prebuild` ran / `db/migrations.generated.ts` is committed, then redeploy |
| `EROFS` / `EACCES` in logs | Writable path configured inside the bundle | Unset `DATABASE_FILE` / `ENHANCEMENT_VAULT_DIR` to use `/tmp` |
| Login bounces back to `/login` | `SESSION_SECRET` changed between deployments, or cookie blocked | Set a stable `SESSION_SECRET`; sign in again |
| Data resets after a while | No `DATABASE_URL`, so the app used per-instance SQLite | Configure Postgres (§3.1) |
| Health shows `driver: "sqlite"` in production | `DATABASE_URL` missing/unreachable and the driver fell back | Read `driverError`/`fallbackReason`, fix the URL, set `DATABASE_REQUIRE_POSTGRES=true` so this cannot happen silently |
| `Postgres: password authentication failed` | Wrong credentials, or a pooler URL with the wrong user format | Use the pooled connection string from the provider; rotate the password in the secret store |
| `Postgres: relation "…" does not exist` | Migrations did not run on this database | Call `/api/health` once (it bootstraps), or run `npm run db:migrate` with `DATABASE_URL` set |

### 3.1 Durable storage (Postgres)

Postgres is a supported driver, not a migration project. Point the app at a
database and it stores everything there — accounts, sessions, activities,
pipeline, releases and their QA windows, validation, audit, enhancements.

```bash
# Any managed or self-hosted Postgres works (Neon, RDS, Supabase, Azure…).
# Add ?sslmode=require for a hosted server that terminates TLS.
export DATABASE_URL='postgres://qa:secret@db.example.com:5432/qa'
export DATABASE_REQUIRE_POSTGRES=true   # refuse to fall back to a local file
export PG_POOL_MAX=5                    # 2–5 per serverless instance

npm run db:migrate     # creates the schema, records the baseline
npm run db:seed        # reference config (+ demo rows unless SEED_DEMO_DATA=false)
npm run build && npm start
```

How the schema gets there: the app ships one set of migrations. On a Postgres
database the first boot replays `db/migrations/*.sql` into an in-memory SQLite
engine, converts the resulting schema to Postgres DDL and applies it as a single
transaction, recording `pg-baseline@005_release_planning.sql` in
`_migrations`. Only migrations written *after* that baseline are translated
statement by statement, so the shape of the schema is identical on both drivers
by construction rather than by two hand-maintained copies.

Operational notes:

- **Backups**: use the provider's point-in-time recovery; take a snapshot before
  any migration. `npm run db:backup` is SQLite-only.
- **Restore**: restore the snapshot, point `DATABASE_URL` at it, and open
  `/api/health` and `/validation` to confirm schema and data.
- **Connection limits**: serverless platforms scale out per request; keep
  `PG_POOL_MAX` small and use a pooled endpoint if the provider offers one.
- **Sessions**: cookies are self-contained signed tokens, so a login survives
  restarts and instance hops on either driver.
- **Verification**: `tests/postgres-driver.test.mts` boots PGlite (Postgres in
  WASM) behind the wire protocol in a child process and runs the real driver
  end to end — migration, queries, constraints, transactions and the
  release/FTE reads — so the Postgres path is covered in CI without a server.

## 4. Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | **prod** | Postgres connection string (`postgres://…`). When set, the Postgres driver is used and SQLite is ignored. |
| `DATABASE_DRIVER` | no | `postgres` \| `sqlite` — pins the driver; default is postgres when `DATABASE_URL` is set |
| `DATABASE_REQUIRE_POSTGRES` | prod | Refuse to start on the SQLite fallback so a connection problem is loud, never silent |
| `PG_POOL_MAX` | no | Postgres pool size per process (default 5; keep 2–5 on serverless) |
| `DATABASE_FILE` | dev | SQLite path (default `./data/qa-calendar.db`), ignored when Postgres is active |
| `SESSION_SECRET` | **yes** | Signs session cookies. Rotating it signs everyone out. |
| `APP_TIMEZONE` | no | Display timezone, default `Australia/Sydney` |
| `SEED_DEMO_DATA` | no | `false` for a clean production instance |
| `AI_PROVIDER` | no | `local` (default) or `openai` after approval |
| `AI_API_KEY` | no | Only with an approved hosted provider; keep in the secret store |
| `ENHANCEMENT_VAULT_DIR` | no | Override path for enhancement Markdown files (defaults to `./enhancements` locally, `/tmp/enhancements` on serverless) |
| `GITHUB_REPO`, `GITHUB_TOKEN` | no | Optional enhancement-vault automation; never expose to the browser |
| `GITHUB_ENHANCEMENTS_REPO`, `GITHUB_ENHANCEMENTS_LABEL`, `GITHUB_BRIDGE_ENABLED` | no | Two-way enhancement bridge target; the environment wins over the saved setting and needs a token with **Issues: read and write** on that repository |
| `ENHANCEMENT_SYNC_SECRET` | no | Enables `POST /api/enhancements/sync`; when unset the endpoint returns 401. Pair with the `APP_URL` Actions variable |

Secrets live in the platform secret store. `.env` is gitignored; `.env.example` contains **no** secrets. The app never renders environment values.

## 5. Production checklist

- [ ] `SESSION_SECRET` set to 32+ random characters, stored outside git.
- [ ] `DATABASE_URL` points at Postgres, `DATABASE_REQUIRE_POSTGRES=true`, and `/api/health` reports `driver: "postgres"`, `durable: true`.
- [ ] `SEED_DEMO_DATA=false` and demo rows removed (`npm run db:reset` is local-only; in Postgres delete `is_demo = 1` rows deliberately).
- [ ] Authentication replaced with the approved IdP (see [DECISIONS #1](./DECISIONS.md)); local password login disabled.
- [ ] HTTPS enforced; cookies already `httpOnly`, `sameSite=lax`, `secure` in production.
- [ ] Role assignment reviewed: at least one `admin`, execs limited to `exec` (holistic read).
- [ ] Database backups scheduled (Postgres PITR, see §7) and restore rehearsed.
- [ ] NSW holidays verified for the current and next fiscal year.
- [ ] Import dry-run run against the real workbook; row counts reconciled and exception report signed off.
- [ ] Audit retention agreed.
- [ ] Security headers added at the edge (HSTS, CSP, frame-ancestors) — the Next app sends no `X-Powered-By`.

## 6. Importing the workbook

There is no Excel parser dependency in this build: export the sheets to CSV/TSV (UTF-8) and import. This keeps the workbook untouched and makes the reconciliation auditable.

```bash
# Dry run (default) — writes a batch + per-row dispositions, changes no activities
npm run import -- data/sample-activities.csv --target activities

# Apply — idempotent on Calendar Item ID
npm run import -- data/sample-activities.csv --target activities --apply

# Pipeline rows
npm run import -- recordings.csv --target pipeline --apply --sheet tblRecordingPipeline
```

The Import Centre (`/imports`) provides the same flow with a paste box, file upload and batch history. Free-text narrative notes are archived verbatim; unknown dates remain `NULL` and appear in Data Quality.

## 7. Backup & recovery

```bash
npm run db:backup -- ./data/backups     # online SQLite backup + SHA-256 file
```

- The backup uses SQLite's online backup API, so it is safe while the app is serving.
- Keep at least 7 daily and 4 weekly copies off-host (object storage with versioning).
- Restore: stop the app, copy the chosen `.db` over `DATABASE_FILE`, verify the checksum, start the app, then open `/validation` and re-run checks.
- Postgres: use managed point-in-time recovery; before any migration take a snapshot.

## 8. Future enhancements vault (GitHub)

Submitted proposals are written to `enhancements/ENH-####-slug.md` with YAML frontmatter and are ordinary repository files:

```bash
git add enhancements
git commit -m "docs(enhancements): capture latest proposals"
git push
```

Archiving a proposal (stage → `Archived`) moves the file into `enhancements/archive/` so it is no longer reviewed. With `GITHUB_REPO`/`GITHUB_TOKEN` configured you can automate the commit from CI; the app itself always writes the file first, so no proposal is lost if the push fails.

## 9. Operational monitoring

- `/validation` is the health page: errors block reporting, warnings need a decision.
- `/changelog` → Build information lists schema migrations, table count, AI provider and demo-row count.
- `/api/health` → JSON probe of database mode, migrations, seed counts and the last bootstrap error (no authentication needed, no secrets).
- `/setup` → recent configuration audit shows who changed what.
- Application logs include bootstrap failures; the AI engine never makes outbound calls, so a network outage does not affect core features.

## 10. Scale notes

- The legacy 1,281-column grid is replaced by date-window queries; no cell materialisation.
- Add indexes before large imports (`activities(start_date, end_date)` and `resource_day_capacity(date)` already exist).
- For >100k activities move to Postgres and keep the same natural keys; the UI is virtualisation-friendly but currently renders a single month at a time.

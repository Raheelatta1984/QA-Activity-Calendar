# Deployment, security & recovery

## 1. Requirements

- Node.js **22.5+** (uses the built-in `node:sqlite`; tested on 22.22).
- npm 10+.
- No external database required for the reference build. Neon/Postgres is the recommended production store (see [ERD → migration path](./ERD.md#postgres--neon-migration-path)).

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
| Database location | `DATABASE_FILE` if set, otherwise `/tmp/qa-calendar.db`. If the configured path is not writable the app logs a warning and falls back to `/tmp`. |
| Enhancement vault | `ENHANCEMENT_VAULT_DIR` if set, otherwise `/tmp/enhancements` on serverless (and falls back to `/tmp/enhancements` whenever the repository `enhancements/` directory returns `EROFS`/`EACCES`). Proposals remain downloadable as frontmatter Markdown via `/api/enhancements/:id`. |
| Schema | Migrations are embedded into `db/migrations.generated.ts` at build time (`prebuild`), so a cold start never depends on `.sql` files that were not traced into the bundle. Also applied read from disk in dev. |
| Seeding | Idempotent bootstrap runs on the first request per instance: migrations → reference config → demo rows (unless `SEED_DEMO_DATA=false`) → validation scan. A failed run is retried on the next request and its error is exposed by `/api/health`. |
| Sessions | Cookies are signed, self-contained tokens (`<base64url payload>.<hmac>`), so a login survives a cold start or a hop to another instance. The `sessions` row is still written and honoured when present (revocation/audit). |
| Persistence | **Per instance only.** Data resets when the function restarts and two instances can diverge. The UI shows a "Serverless demo instance" banner whenever ephemeral storage is in use. |

Required project settings:

```
Framework preset   Next.js
Build command      npm run build        (prebuild embeds migrations)
Install command    npm install
Node.js version    22.x                 (node:sqlite requires 22.5+)
Env                SESSION_SECRET=<32+ random chars>   (recommended; a dev secret is used otherwise)
```

Do **not** set `DATABASE_FILE` to a path inside the deployment bundle — it is read-only. Leave it unset to use `/tmp`, or point it at a mounted writable volume if your platform provides one.

### Health probe

`GET /api/health` returns JSON and no secrets — use it when a deployment shows "Application error … Digest":

```json
{
  "ok": true,
  "file": "/tmp/qa-calendar.db",
  "ephemeral": true,
  "serverless": true,
  "bootstrapDone": true,
  "bootstrapError": null,
  "tables": 35,
  "migrations": ["001_init.sql"],
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
| Data resets after a while | Expected on ephemeral storage | Configure Postgres for durable storage (see ERD) |

### Durable storage

For a real deployment put Postgres/Neon in front of the data layer (keeps the same natural keys and import idempotency). Until then, treat the Vercel deployment as a **demo environment**: it is fully functional, but it is not a system of record. Back up `/tmp` data only if you accept it may disappear.

## 4. Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_FILE` | dev | SQLite path (default `./data/qa-calendar.db`) |
| `DATABASE_URL` | prod (Postgres) | Neon/Postgres connection string once the adapter is swapped |
| `SESSION_SECRET` | **yes** | Signs session cookies. Rotating it signs everyone out. |
| `APP_TIMEZONE` | no | Display timezone, default `Australia/Sydney` |
| `SEED_DEMO_DATA` | no | `false` for a clean production instance |
| `AI_PROVIDER` | no | `local` (default) or `openai` after approval |
| `AI_API_KEY` | no | Only with an approved hosted provider; keep in the secret store |
| `ENHANCEMENT_VAULT_DIR` | no | Override path for enhancement Markdown files (defaults to `./enhancements` locally, `/tmp/enhancements` on serverless) |
| `GITHUB_REPO`, `GITHUB_TOKEN` | no | Optional enhancement-vault automation; never expose to the browser |

Secrets live in the platform secret store. `.env` is gitignored; `.env.example` contains **no** secrets. The app never renders environment values.

## 5. Production checklist

- [ ] `SESSION_SECRET` set to 32+ random characters, stored outside git.
- [ ] `SEED_DEMO_DATA=false` and demo rows removed (`npm run db:reset` is local-only; in Postgres delete `is_demo = 1` rows deliberately).
- [ ] Authentication replaced with the approved IdP (see [DECISIONS #1](./DECISIONS.md)); local password login disabled.
- [ ] HTTPS enforced; cookies already `httpOnly`, `sameSite=lax`, `secure` in production.
- [ ] Role assignment reviewed: at least one `admin`, execs limited to `exec` (holistic read).
- [ ] Database backups scheduled (see §6) and restore rehearsed.
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

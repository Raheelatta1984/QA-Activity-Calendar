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

## 3. Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_FILE` | dev | SQLite path (default `./data/qa-calendar.db`) |
| `DATABASE_URL` | prod (Postgres) | Neon/Postgres connection string once the adapter is swapped |
| `SESSION_SECRET` | **yes** | Signs session cookies. Rotating it signs everyone out. |
| `APP_TIMEZONE` | no | Display timezone, default `Australia/Sydney` |
| `SEED_DEMO_DATA` | no | `false` for a clean production instance |
| `AI_PROVIDER` | no | `local` (default) or `openai` after approval |
| `AI_API_KEY` | no | Only with an approved hosted provider; keep in the secret store |
| `GITHUB_REPO`, `GITHUB_TOKEN` | no | Optional enhancement-vault automation; never expose to the browser |

Secrets live in the platform secret store. `.env` is gitignored; `.env.example` contains **no** secrets. The app never renders environment values.

## 4. Production checklist

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

## 5. Importing the workbook

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

## 6. Backup & recovery

```bash
npm run db:backup -- ./data/backups     # online SQLite backup + SHA-256 file
```

- The backup uses SQLite's online backup API, so it is safe while the app is serving.
- Keep at least 7 daily and 4 weekly copies off-host (object storage with versioning).
- Restore: stop the app, copy the chosen `.db` over `DATABASE_FILE`, verify the checksum, start the app, then open `/validation` and re-run checks.
- Postgres: use managed point-in-time recovery; before any migration take a snapshot.

## 7. Future enhancements vault (GitHub)

Submitted proposals are written to `enhancements/ENH-####-slug.md` with YAML frontmatter and are ordinary repository files:

```bash
git add enhancements
git commit -m "docs(enhancements): capture latest proposals"
git push
```

Archiving a proposal (stage → `Archived`) moves the file into `enhancements/archive/` so it is no longer reviewed. With `GITHUB_REPO`/`GITHUB_TOKEN` configured you can automate the commit from CI; the app itself always writes the file first, so no proposal is lost if the push fails.

## 8. Operational monitoring

- `/validation` is the health page: errors block reporting, warnings need a decision.
- `/changelog` → Build information lists schema migrations, table count, AI provider and demo-row count.
- `/setup` → recent configuration audit shows who changed what.
- Application logs include bootstrap failures; the AI engine never makes outbound calls, so a network outage does not affect core features.

## 9. Scale notes

- The legacy 1,281-column grid is replaced by date-window queries; no cell materialisation.
- Add indexes before large imports (`activities(start_date, end_date)` and `resource_day_capacity(date)` already exist).
- For >100k activities move to Postgres and keep the same natural keys; the UI is virtualisation-friendly but currently renders a single month at a time.

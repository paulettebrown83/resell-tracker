# Resale Tracker

Paulette's existing Next.js/Supabase inventory, sales and expense app. This branch prepares approved-account login and a coordinated database access repair, with retained item links, atomic sale updates, correction history, source duplicate prevention and portable exports.

**Not deployed. Read [the rollout and recovery runbook](docs/ROLLOUT.md) before applying the migration.** Production still uses the old access model until the coordinated cutover. Separate genealogy/garment clients must be included in that cutover.

## Local development

Install the pinned lockfile with `npm ci`. Copy `.env.example` to `.env.local` and enter the staging Supabase URL and public publishable key. Never put a secret/service key into `NEXT_PUBLIC_*` variables. Run `npm run dev`.

Approved permanent Supabase Auth users need an administrator-created `private.memberships` entry for `resale`. There is no public signup UI. Account administration/password reset stays in the existing Supabase administration workflow.

## Checks

```sh
npm test
npm run typecheck
npm run lint
npm run build
npm audit
```

`npm test` runs a fresh local PostgreSQL engine through PGlite with synthetic Auth claims. It covers role/area restrictions, view access, membership revocation, atomic linked sales, exact retries, rejected payload reuse, source uniqueness, version conflicts, corrections/voids and rollback after an injected late failure. It does not contact production.

To verify a protected application snapshot in a fresh local database:

```sh
node scripts/verify-backup.mjs /absolute/private/path/snapshot.json
```

The snapshot must remain outside Git. The full project restoration and hosted Auth/REST/concurrent-session acceptance checks remain rollout gates. `tests/baseline.sql` is a dated, structure-only test fixture; never execute it over an existing database.

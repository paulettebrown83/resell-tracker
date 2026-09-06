# Resale Tracker

Paulette's resale control center, built with Next.js, Supabase and private R2 photos. One physical item can have a separate listing on each shop, with shared facts and platform-specific preparation. Google sign-in protects resale and the separate genealogy workspace.

**The redesigned workbench, private photo service, historical marketplace staging, manual item matching and draft database are deployed. This branch adds guided draft preparation and a shared operations interface; its operations migration and interface are pending coordinated release. Continuous shop synchronization is not active yet.** Read [the rollout and recovery runbook](docs/ROLLOUT.md) and [the resale data contract](docs/RESALE_DATA.md) before changing production. The protected genealogy interface is available at `/genealogy`. See [draft preparation](docs/RESALE_DRAFTS.md) and [the shared operation contract](docs/RESALE_OPERATIONS.md) for exact implementation boundaries. A queued request or checked source record is not proof that a shop listing changed.

## Local development

Install the pinned lockfile with `npm ci`. Copy `.env.example` to `.env.local` and enter the staging Supabase URL and public publishable key. Never put a secret/service key into `NEXT_PUBLIC_*` variables. Run `npm run dev`.

Approved permanent Supabase Auth users need an administrator-created `private.memberships` entry for `resale`. There is no public signup UI. Google account administration stays in the existing Supabase administration workflow; new signup is closed.

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

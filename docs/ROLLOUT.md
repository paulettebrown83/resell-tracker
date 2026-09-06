# Secure resale foundation rollout

Status: draft PR and automatic Vercel preview prepared; database migration **not applied to production**. The preview displays login but cannot grant resale access until the coordinated database/account setup exists. It inherits the existing project public database configuration; do not use it for staging writes after production cutover. Existing production exposure remains until the coordinated cutover. The migration is deliberately incompatible with the old unauthenticated clients.

## What is owned here

This extends the existing `paulettebrown83/resell-tracker` app. Existing inventory UUIDs become stable item links. Historical sales and garment rows stay unmatched until reviewed. A shared, explicitly approved resale membership grants business access; a separate genealogy membership grants research access. This is one household/business workspace, not a multi-tenant SaaS.

The browser has only a public Supabase URL and publishable key (legacy anon key remains supported). There is no service key, Vault reader, new SaaS, or new paid branch. Login passwords belong in Supabase Auth, never Vault. The Cloudflare task owns its credentials separately.

## Required gates before production

1. Deployment access was restored through the native Vercel CLI login for team `paulette-browns-projects` (`team_MnM0ZFiJj2ZQKKyEMQUP7hXP`). The connector still returned 403, but the CLI works. Verified existing project `prj_073e04V3bbiGqxAKortNkzFMYKNs`, production alias `resell-tracker-beta.vercel.app`, deployment `dpl_EPxqCy9oRaY4roFTWQQos1aB9cZ4`. Although project defaults are Node 24, actual deployed functions are `nodejs20.x`; historical build logs confirm package.json overrode the default. This branch now declares Node 24 and is tested locally on Node 24.4.0. Verify new deployment functions use Node 24. Environment metadata also shows an existing, unused `SUPABASE_SERVICE_ROLE_KEY` in Production/Preview/Development; its value was not read. Remove unused privileged environment exposure as part of the deployment configuration review; this app has no consumer for it.
2. Obtain the exact approved email addresses from Paulette. Fresh `auth.users` count was zero. Create permanent email/password accounts through Supabase Auth's supported administration path; passwords must be entered securely, not in SQL, chat, Git, or logs. No invitation emails are authorized by this task. Verify successful login in a non-production environment first. Disable public signup and anonymous sign-ins for this private app when configuring Auth; membership rules still deny any account not explicitly approved.
3. Coordinate all existing consumers of `book_of_snippets` and `resell_clothes`, which also lose anonymous access. The resale app in this repository gains login; the separate genealogy/garment clients have **not** been modified here. Prepare their compatible login rollout, or explicitly decide their intended maintenance window. Do not apply this migration and call a locked-out legacy app a successful fix.
4. Obtain a fresh full managed/`pg_dump` database backup with a tested restoration path and a protected copy of application rows immediately before cutover. A local application snapshot from September 6 was restored successfully, but it excludes Auth, Storage objects, Vault secrets, managed configuration and extension state. It is not a full Supabase project backup. Keep the original protected copy outside this public repository and preserve new writes after its timestamp.
5. Run an isolated full Supabase staging test with actual password login, signed-out denial, unrelated-account denial, approved-account allow, permission revocation, REST/GraphQL/view denial, and two simultaneous sale requests from independent connections. Local PGlite PostgreSQL tests simulate Auth claims and validate SQL permissions/transactions; they are not an end-to-end Supabase Auth/PostgREST test or a multi-connection concurrency test. No paid staging project was created.

## Cutover sequence

Prepare and verify the compatible app deployment first. Configure `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` in the consuming Vercel environment; public configuration needs no Vault copy. Review production environment inheritance for previews: a preview must not accidentally write production records.

During a coordinated write pause, take and verify the fresh backup, recheck schema drift and migration history, apply the single reviewed SQL migration, and add only approved Auth UUID memberships using `scripts/grant-member.sql`. Migrations already existed in the hosted project before this repository tracked SQL; do not blindly run `supabase db push`, reset the database, or replay `tests/baseline.sql`. Use the migration API/SQL administration with the reviewed migration and record its version once. Do not import the test fixture into production.

Keep a connected administrator session open. Verify approved login and data counts before moving the production alias to the compatible app. Verify all affected clients, anonymous denials, current inventory (sold and archived excluded), sale/correction/void, exports and source duplicate rejection. Run Supabase security advisors again. Remove any temporary staging/test accounts and fixtures through the agreed recovery process. Record deployed commit, migration version, checks and backup timestamp.

## Recovery without reopening public access

The migration runs in a transaction: an error before commit restores the previous schema automatically. After commit, preserve the added columns, links, history and request ledger. Do not drop them or overwrite newer records with the pre-cutover snapshot.

If a defect appears, pause sale mutations using `scripts/pause-sale-writes.sql` and keep signed-out access denied. Deploy a corrected, authentication-compatible build; rolling back to the original unauthenticated app is unsafe. Restore sale execution with `scripts/resume-sale-writes.sql` after verification. Keep other writes paused operationally if a full restore is required.

For actual record recovery, restore the latest full backup into an isolated database first, compare identifiers and transaction history, and reconcile writes since the snapshot before replacing anything. Never automatically restore the old permissive policies. A rollback decision must state the expected recovery point and preserve the post-snapshot event/request history.

## Data and behavior details

- `private.memberships` uses Auth UUIDs, not editable user metadata or email strings. Only administrators/service role can grant membership. Revocation takes effect on the next statement, including through `sales_summary`.
- Direct browser sale writes/deletes and inventory status changes are denied. Public `save_sale` is an invoker wrapper over a narrowly authorized private definer function, needed to enforce atomic writes without direct table grants. Both have fixed search paths; anonymous execute is revoked. `auth.uid()` and resale membership are checked inside the private function.
- Sale requests lock by request UUID; inventory rows are locked before sale creation. A unique active-sale index prevents two active linked sales for one item. A late failure rolls back the sale, inventory, request and history together. Exact retries return the current version of the same sale; changed reuse is rejected.
- The browser keeps an unconfirmed request in tab-scoped session storage, separated by account, until it can retry the exact request. Do not clear storage or open a new tab to bypass an uncertain save. Closing the tab loses this retry aid; source IDs and linked-item constraints remain. Standalone manual sales without source IDs still require human reconciliation after tab loss.
- Correction requires the expected version and reason. Before/after history is append-only to clients. Voiding retains the sale and restores linked inventory's previous availability; a later genuine resale can use the same item. This is not a full refund/bundle accounting model.
- Source uniqueness is `(source_system, source_record_id)`; use a marketplace/account namespace and stable order-line identity. It prevents exact known-source duplicates; it does not prove two titles are the same item or reconcile cross-system copies. No imports were performed.
- New entries require actual fee and shipping values. Net payout is optional and must be after marketplace deductions; shipping deducted in that payout must not be entered again as separately paid shipping. Existing historical values remain `legacy_unverified`; null cost stays unknown. Profit is calculated in the database. Fee schedules are no longer silently estimated.
- Archive replaces inventory/expense deletion. Voided/archived records remain in the full JSON record export. CSV is a filtered report with IDs and formula-escape protection. JSON is a portable record export, not a schema/permissions backup or a transaction-consistent point-in-time backup; pagination can span concurrent writes.
- Legacy sold inventory stays sold without speculative historical sale links. Garment links are nullable pending reconciliation. No unrelated app files, source records, credentials or source imports were changed.

## References checked

[Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), [password login](https://supabase.com/docs/reference/javascript/auth-signinwithpassword), [Supabase changelog](https://supabase.com/changelog.md), [Vault](https://supabase.com/docs/guides/database/vault), [Next.js August security release](https://nextjs.org/blog/august-2026-security-release), [PGlite API](https://pglite.dev/docs/api).

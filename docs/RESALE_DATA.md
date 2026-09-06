# Resale workbench data and operations

Status: locally prepared additive migration, not applied or deployed. Migration created with Supabase CLI; production cutover requires coordinator review, current backup/schema drift check and hosted acceptance. This module does not enable any marketplace integration or make an outbound marketplace request.

## Identity and ownership

`public.inventory.id` remains the physical item identity. No old item, sale, garment or genealogy row is deleted, renamed or matched automatically. `resale_item_details` extends each item; a missing detail row means legacy/unreviewed and edit version0. Unknown acquisition cost is NULL; zero remains known zero. Existing atomic `save_sale` still requires actual amounts and retains its source identity, request deduplication, inventory locks, corrections and history. Unknown-cost intake must be completed before a sale can be entered through that accounting operation.

Public additions are consistently `resale_*`; private request/credential functions are similarly scoped. Current approved resale membership protects all business reads; genealogy membership alone grants no resale access. Existing genealogy rules are untouched. This is a shared resale workspace, not a general multi-tenant product or a new global authorization system.

Accounts use marketplace plus stable account alias and immutable internal UUID. External account, listing, order and line IDs are account scoped. `external_identifiers` preserves platform-specific identities (for example Vinted marketplace ID, VPI UUID and item_reference); internal listing UUID survives a reviewed external ID change. Retain old identities in immutable observations before changing the current external ID. A bundle's order ID is not an item ID. Events carry external event ID, type and occurrence time; reusing an order ID across event types does not collapse events.

Credential references live only in `private.resale_account_credentials`; they store Vault name, environment, consumer and verification time, never values. Public account metadata stores username/login method and verified capabilities. It does not imply that an account is connected or that every platform capability exists.

## Evidence and reconciliation

Every snapshot has account, source type, source reference, actual observation time, scope, pagination coverage and count. Complete means the explicitly named scope only. Observations carry listing availability separately from raw activity labels: Poshmark Inactive can remain purchasable and must not be mapped to removed. Missing rows and partial snapshots never prove a sale or deletion. An older observation cannot replace a newer listing state. Conflicting statuses at equal timestamps clear current state to unknown and create a review case; neither can be used as proof of delisting.

Listings remain unmatched or proposed until an explicit review confirms inventory UUID with nonempty evidence and match time. Never link by title alone. Browser clients cannot write evidence, match confirmations, orders or jobs directly. Import adapters must use trusted operations, retain provenance and route ambiguous identities to `resale_review_cases`. No generic import adapter or automated confirmation is implemented in this migration.

Preparation workflow (`draft`, `needs_details`, `ready`, `archived`) is distinct from actual stock status and marketplace observations. Marking preparation ready does not publish a listing. Listing `desired_fields` keeps each platform's category/required-field draft separate from observed truth. This schema permits expansion without inventing required fields before marketplace discovery.

## Intake contract

`lib/resale-contract.ts` contains shared TypeScript shapes. `lib/resale-data.ts` exports `getResaleWorkbench()` and `saveResaleItem(input, requestId)`.

Intake requires a name and explicit known cost or NULL. New items receive a UUID and detail version1 in one transaction. Edit requests pass item UUID and expected detail version (zero for legacy items without details). Unspecified detail fields are preserved. A changed version rejects the save. Keep the exact payload and request UUID until the outcome is known; exact retries return the same item without duplicating it. Preview application writes are blocked.

Workbench reads page all rows in stable ID order; details use inventory_id. They are UI reads, not a transaction-consistent backup and not absence evidence. Preserve stale/unknown badges based on actual observation times.

## Private original photos

`resale_reserve_media(p_request_id,p_inventory_id,p_mime_type,p_byte_size)` returns a pending `resale_media` row. Request UUID is the media UUID; repeat that UUID with exact same actor/item/type/size to retry. The immutable object key is `resale/items/{inventory_id}/{media_id}/original` in `paulette-resale-originals-prod`. JPEG, PNG, WebP and GIF originals up to20MiB are supported; other formats must get an explicit unsupported message rather than silent conversion or loss of the original.

The authorized R2 Worker uploads and verifies bytes, then returns the exact UTF8 receipt string and lowercase hexadecimal HMAC-SHA256 signature. `finalize_resale_media(p_receipt,p_signature)` checks current resale membership, the signature, version1, expiry within15minutes, and exact reservation item/bucket/key/MIME/size. The receipt includes media_id, inventory_id, bucket, object_key, sha256, byte_size, mime_type and expires_at(epoch seconds). Ready state requires the verified checksum; a retry cannot replace a finalized original with different bytes. The Worker key is a raw32byte key represented as64lowercase hex characters in Vault record `resale_media_production_receipt_signing_key`. It is accessed only inside the narrow private verifier and never returned. Root provisions the key and Worker binding separately; migration contains no secret.

Ordered media rows preserve originals and derived images separately; derived media must reference an original belonging to the same inventory item. Authorized runtime GET responses supply images; do not persist public URLs or long-lived signed access in the database. Browser clients cannot mark an upload ready or alter its storage key. Worker tests and live authenticated upload/read checks are separate release gates.

## Sale and delist lifecycle

The existing sale transaction now creates blocked delist intent for exactly confirmed linked listings with known external IDs that are not already observed sold/ended/removed. The job is unique per sale/listing/action. A failed sale transaction rolls back the outbox too. Unlinked sales and historical matches are never inferred. A listing linked after an old sale needs explicit reconciliation before creating any missing intent.

Every job initially stays blocked. Private service-only `resale_release_delist` requires explicit supported account capability, connected state, exact current confirmed target, active linked sale and a recent observed purchasable listing. No marketplace has those claims seeded. `resale_claim_delist` uses a lock and lease so workers cannot claim the same job concurrently. Expired leases become uncertain, never blindly runnable. `resale_finish_delist` requires the lease token; accepted/202 becomes uncertain, rejected becomes failed, and success requires a new observation of an actually non-purchasable listing. Activity labels are not proof of delisting. An uncertain/failed retry must be preceded by a fresh verification after the prior attempt.

These private functions are trusted adapter groundwork only; no runtime service key is provisioned here. Each real adapter must still validate account ownership, exact remote listing identity, current order/sale state and capability immediately before calling the platform, then record evidence. External marketplaces cannot share a database transaction; expose races/failures and do not promise instantaneous cross-site removal.

Voiding a sale cancels unsent intents, marks in-flight requests uncertain and creates a review case for already completed/uncertain removals. It never automatically republishes. External purchased/completed/cancelled/returned order observations remain distinct from settled accounting; this groundwork does not invent fee values or automatically convert an email notification into a sale. Operational reservations for independently verified orders require a reviewed follow-up implementation before sale-detection automation runs.

## Verification and rollout

Run `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, `npm audit` and `npm run test:concurrency`. Local tests use synthetic claims and fixture-only Vault metadata. HMAC tests run real pgcrypto and compare Node signatures; no live secrets are read. Native concurrency checks use separate PostgreSQL17 connections. Neither proves hosted authentication or platform behavior; coordinator must perform live role/media checks after a reviewed migration.

Never replay the baseline fixture into production. Keep original field/count backup verification, current migration ledger and actual applied version in the shared rollout notes. If an issue occurs, disable new workbench mutations/dispatch and fix forward; preserve legacy inventory/sales/history and never restore public access. Root owns final deploy, media runtime, platform integration and the Paulette's Sales Surfaces skill.

Current primary guidance checked: [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), [Supabase changelog](https://supabase.com/changelog), and marketplace-specific reports in the private resale-system workspace. No new extension versions are pinned because current Supabase ignores explicit extension versions.

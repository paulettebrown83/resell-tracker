# Prepared marketplace drafts and sourced guidance

Status: staged implementation, not a production migration or completed UI. Root reviews and coordinates application/schema integration. Based on reviewed matching commit6876806; migration generated with Supabase CLI as `20260906034445_resale_prepared_listing_drafts.sql`. This adds no publisher, credential lookup, scheduling or marketplace network requests.

## User flow and contract

Choose a known physical item and destination account. Prepare buyer-facing fields from known item facts, select writing preferences, and add destination-specific overrides. `resolveDraftFields(fields, overrides)` uses shallow field replacement: explicit null clears nullable fields; omitted/undefined fields retain the base value. Save incomplete work without pretending it is publish-ready.

`lib/listing-guidance.ts` exports `PLATFORM_GUIDANCE`, `LISTING_RULES_VERSION`, `validateListingDraft`, and `resolveDraftFields`. `validateListingDraft(marketplace, resolvedFields, {channel,market,today}, preferences)` returns source-linked warnings/unknowns, `draft_save_allowed` and **always `publish_ready:false`**. Structural invalid price/currency can block saving; marketplace character/photo guidance warns rather than discarding incomplete work. This is deliberately not a complete category, regulatory, prohibited-item, account-access or shipping eligibility validator.

`lib/resale-drafts.ts` exports `saveListingDraft(input,requestId)` and `isPreparedDraftCurrent(listing)`. Input:

```ts
{
  listing_id?: string,
  account_id: string,
  inventory_id: string,
  expected_version: number, // 0 for a new local draft, current draft_version otherwise
  channel: 'consumer' | 'bulk' | 'api',
  rules_version: string,
  fields: DraftFields,
  preferences?: WritingPreferences,
  overrides?: Partial<DraftFields>
}
```

The helper calls `resale_save_listing_draft(p_request_id,p_payload)` after writable-environment and membership checks. Keep the UUID **and exact input** until a save response is confirmed. An exact retry returns its original saved response even if a later edit exists; reload current workbench rows after success. SQLSTATE40001 means a stale version: preserve the edit, reload, and let the operator reconcile it before submitting a new request. Do not silently replace the expected version or regenerate an uncertain request ID.

`desired_fields` stores resolved prepared fields only. `draft_context` separately preserves base fields, selected preferences, overrides, rule version, channel and the account/item IDs used for preparation. `draft_version` starts at0 and increments with each confirmed edit; `draft_updated_at` records the save. The shared base `ResaleListing` type is unchanged to avoid forcing unrelated UI edits; `PreparedListing` extends it for the new panel.

An existing imported listing **must already have the exact confirmed physical-item link**. The draft function cannot silently link or relink it. For a brand-new local draft, explicitly choosing the known item/account establishes that local association, records the actor in match evidence, and leaves `external_listing_id=null`, observed status unknown and no marketplace observation. One local draft per item/account is enforced at creation under the inventory row lock; if one exists, edit it. No title-based matching occurs.

A later manual re-match may change a listing's item. Old prepared copy/photos are not automatically true for the new item: `isPreparedDraftCurrent` checks the saved context item/account against the current link. UI must flag a mismatch and require review before reusing the draft. New saves validate current item and ready media ownership. No publication executor exists to consume stale drafts automatically.

## Rules, preferences and overrides are distinct

Rules have a version, retrieved date, source reference, provenance kind, US applicability and channel. Official eBay title guidance was refreshed directly; Depop API limits were checked against its current reference. Mercari, Poshmark bulk, Depop photos and Vinted photos come from the validated dated account artifacts, with no account credentials/customer data copied into source. Unknown consumer/category constraints remain unknown. Poshmark bulk limits do not apply automatically to its consumer editor; Depop API limits are not enforced as consumer-editor limits; Vinted US character limits are not guessed from Pro API.

The 30-day source review window in the helper is an **internal freshness policy**, not a platform rule or proven shelf life. Old/invalid/future-dated evidence becomes a request to reverify rather than an enforced limit. Current rules remain advisory even within that window. Character counts use Unicode code points; check the actual editor's counter before publication because destination counting semantics can differ.

Imported no-emoji writing defaults are explicitly labeled `imported_claude_context` and not independently verified direct instructions. They are not automatically applied or saved by the RPC. Preferences cannot override platform provenance or mutate the rule set. Item-specific overrides can change copy/price/category choices but do not make unknown age, condition, authenticity, shipping promises or platform eligibility true. No fixed pricing ladder, exact-five-hashtag requirement, free shipping or dispatch promise is seeded.

## Data access and history

The migration adds only draft columns, a member-readable immutable draft history, and a private exact-request ledger. No direct authenticated write grants are added. The narrow private definer function has a fixed empty search path, locks live membership until commit, and its public invoker wrapper denies anon access. Genealogy membership does not grant resale draft access. Neither history nor the request ledger can be rewritten through client permissions.

The function bounds total JSON to32KiB, rejects unknown top-level fields, applies technical storage shape/size limits, and requires ready selected media to belong to the chosen item. These bounds are application storage safeguards—not marketplace publication rules. It excludes URL-based image fetching; private media IDs do not become public listing image URLs. The prepared field map is buyer-facing only; keep passwords, internal cost/location, customer data and arbitrary credentials out of fields and attributes.

Existing observed title, price, status, timestamps, external IDs and evidence are unchanged on edit. History preserves prior desired fields/context/version. Saving a draft never changes stock, records a sale, emits a marketplace action, or publishes/reprices a live listing. Sold/archived physical items cannot receive a new draft edit. A local draft's initial display title comes from the explicitly prepared title only, without guessing from another listing.

## Verification and rollout

`npm run test:drafts` covers source scope, freshness, unknown limits, preference separation, explicit-null overrides, auth/area denial/revocation, exact actor retries, payload bounds, stale versions, media ownership, immutable history and no sale/stock/observation/action changes. `npm run test:drafts:concurrency` runs independent native PostgreSQL17 connections for exact retry serialization, competing edit rejection, and membership revocation winning before a waiting save. The native fixture changes only the unrelated thoughts vector type; PGlite uses the real vector extension. Neither test claims hosted Auth/PostgREST acceptance.

Before applying: review the migration, refresh backup/schema drift evidence, preserve current desired fields and canonical records, then apply once through root's normal migration coordination. Integrate the panel against the exact helper contract; show guidance sources/unknowns, save/retry state, current version, and stale-item association warning. Verify the hosted account can save/reload a labeled synthetic draft, an outsider cannot read/write it, preview writes are blocked, retries do not duplicate, and no live listing/action changes result. Clean up only explicit synthetic fixtures afterward. Do not mark publication support complete.

Official sources checked September6,2026:
- https://developer.ebay.com/api-docs/user-guides/static/trading-user-guide/listing-title.html
- https://partnerapi.depop.com/api-docs/reference/
- https://supabase.com/docs/guides/database/functions
- https://supabase.com/changelog (markdown endpoint failed; HTML fallback reviewed)

## Workbench entry and retry behavior

Open a physical item, then Prepare marketplace draft. Choose a saved marketplace account and either an existing confirmed listing or a new local draft. Shared facts seed the form; edits persist separately as manual overrides and writing preferences. Unknown price, currency, shipping and category remain unknown. Guidance is scoped by marketplace, preparation format, US market, source date and rule version. Saving does not assert publish readiness or enqueue a remote action.

The browser retains an account-scoped request UUID and exact input until confirmed. Retry pending marketplace draft remains available in Record tools & recovery after a dialog closes. Stale versions or item bindings require refreshed review. Imported listing counts exclude local records with no observation, and changed item bindings visibly mark prior prepared copy/photos as stale.


## Hosted release record

The reviewed draft migration was applied once as hosted ledger version `20260906035946` on September 6, 2026. Its SQL SHA256 is `dcf15add90d820fb7069b8156c80147271957def987aab9e24e1cc094e90cd71`; do not replay it because the local preparation timestamp differs. Hosted role-based acceptance checked creation, editing, exact/historical retries, stale and changed payload denial, history protections, anonymous/outsider denial and unchanged canonical data. All synthetic writes rolled back; draft/history/request counts returned to zero and all eight existing-table fingerprints matched. Guided UI independent review includes recovery fix `00cf0c1b20092712052716213e2a0f464bb2bb6c`, preserving current edits when retrying an earlier request. This does not establish remote publication or a live marketplace executor.

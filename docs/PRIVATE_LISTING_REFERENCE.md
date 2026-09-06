# Private listing reference

The tracker can save a supervised request to append its listing UUID to Poshmark's seller-only **Other Info** field. This establishes listing traceability without claiming a physical item match. Inventory, sales, pricing settings and public listing fields remain unchanged. A persistent request is not an installed background consumer: Shop activity says **Awaiting an agent** until an authorized agent claims it.

This release adds the request and guarded service protocol. Actual native submission and reopened-editor verification must be recorded separately; browser access was locked during implementation. The previously inspected editor exposes Other Info as a private textarea with a 500-character limit. Its Update button exists; the save confirmation path still needs native acceptance.

## Exact supervised consumer

Use the existing Comet ownership coordination. Preserve original tabs and pending item/sale retry state. The agent runs narrow service-role RPCs through the authorized Supabase administrative connector, while native browser actions use computer control. No browser service key, cookie extraction, generic secret reader, or background-worker claim is introduced.

1. Paulette's authenticated tracker request calls `resale_request_listing_reference(request_id,payload)`. The server freezes account, external account and listing IDs, current observation, nullable inventory link and match status. The note is fixed: `Resale tracker listing: <listing UUID>`. No arbitrary text is accepted from this request.
2. The agent calls `resale_claim_listing_reference(action_id,false)`. Record the exact attempt, lease token and expiry. Recheck current membership, target, authenticated seller identity and native editor URL. A claim does not authorize a save until preflight succeeds.
3. Read every visible editable non-note control, ordered photo identity, and the entire existing Other Info value. Capture Original Price separately from Listing Price, numeric quantity separately from Single/Multi Item mode, and any variant controls. Explicitly record absent controls as `{present:false,value:null}`. Stop if the actual form has an unrepresented editable control.
4. Call `resale_preflight_listing_reference(action_id,lease_token,facts)` with a fresh native read. It preserves existing note bytes, appends one newline and the exact marker, and rejects overflow. Use `referenceReadbackDecision` immediately before writing; both the current note and all protected controls must still match. Do not write near lease expiry. Change only Other Info, never SKU or another control. Follow only the observed native save route.
5. Reopen the exact seller editor. Capture a fresh full readback and call `resale_finish_listing_reference`. Only the exact expected note and unchanged protected controls can complete this attempt. Existing marker recovery performs no extra save. The database retains immutable before/after source evidence and an exact verification proof; it does not promote stock, sale or listing availability.

`facts` has fixed keys: `v:1`, `observed_at`, `external_listing_id`, `account_handle`, `external_account_id`, `editor_url`, `owner_controls_verified:true`, `other_info`, `protected_fields`. Protected fields are title, description, ordered photos, category, quantity_mode, size, condition, brand, ordered colors, ordered style_tags, price, smart_sell, discounted_shipping, availability, sku, cost_price, currency, original_price, quantity_value and variant_controls. Browser facts are trusted agent attestations, not assertions accepted from the ordinary UI. Do not include buyer information or secrets.

## Uncertain results and interrupted consumers

Call `resale_pause_listing_reference` with `browser_unavailable`, `save_outcome_unknown`, `readback_mismatch` or `lease_expired`. A later claim must use `verify_only:true`; it cannot authorize another write. Inspect the exact marker first. If present with the expected note and unchanged controls, verify completion. If anything differs, retain the unresolved result.

When fresh readback proves the note was not changed, `resale_retire_unapplied_listing_reference` may retire the old request without deleting it. Confirm the original write-authorized consumer is stopped, supply its exact attempt ID, and wait until that write lease expired plus 30 seconds. The original note and protected controls must match its baseline. Multiple read-only recovery attempts do not replace that writer binding. If the browser failed before any preflight, no write was authorized; bind the stopped prior nonwriter instead. Only then may a new supervised request be created. Exact retirement retries return the same evidence ID. This is not a promise of provider-side idempotency: a possibly active or in-flight writer keeps the request unresolved.

Physical confirmation continues to gate stock changes, sales and cross-shop item linkage. It does not block an independently verified listing-only private note or read-only listing refresh.

## Validation and release

Run `npm run test:listing-reference`, `npm run test:listing-reference-concurrency`, typecheck, lint and the production build. Tests cover exact actor retries, exclusive claims, revocation, ordinary-update proof isolation, changed notes and original/quantity/variant controls, uncertain recovery, prior-writer retirement and zero physical-state effects. Apply the migration before deploying the UI, preserve existing table fingerprints including pricing/package tables, and run hosted checks inside rollback. Native acceptance must retain the exact request, before/after evidence and cleanup receipt; SQL fixtures are not marketplace proof.

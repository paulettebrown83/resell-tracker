# Exact listing availability and pricing refresh

The tracker saves a read-only supervised request for one exact Poshmark or Mercari seller listing. It refreshes observed availability and price settings, while retaining saved listing copy and local drafts. Newly read descriptive fields are preserved in source evidence, not silently copied into desired listing fields. Inventory links, physical quantity, sales, shipping, orders and remote fields do not change.

A saved request is not a background integration. Until an agent claims it, it says **Awaiting an agent**. This release's hosted/app verification is separate from actual native read acceptance; an unavailable or locked browser leaves the native check pending.

## Consumer and evidence contract

The authenticated button uses `resale_request_listing_refresh(request_id,payload)` with action `import` and fixed requested scope `exact_listing_refresh`. The server freezes the account, external seller/listing IDs, current observation and nullable physical link in the existing outbox. It rejects arbitrary requested fields and keeps actor-bound exact retries. One open refresh per listing avoids duplicate work.

An authorized agent claims through `resale_claim_listing_refresh(action_id)` using the narrow administrative connector. The reply has an exact attempt, lease, authenticated target and allowlisted editor destination. Claiming never authorizes any marketplace write. Coordinate Comet ownership, open an agent-owned tab, and read the exact seller editor without clicking Update, Deactivate, Smart Pricing or other mutation controls. Recheck seller identity and owner controls; do not infer ownership from title/photo similarity.

Finish through `resale_finish_listing_refresh(action_id,lease_token,facts)` only after a fresh complete read of the requested controls. Facts contain `v:1`, `observed_at`, `external_listing_id`, `external_account_id`, `account_handle`, `editor_url`, `owner_controls_verified:true`, `raw_availability`, independent `activity`, `listing_fields`, and `pricing`. Absent values are explicit nulls; do not fill them from old records or desired drafts.

Listing fields allow title, description, category, brand, size, condition, quantity_control, ordered photos, colors and measurements. The first seven are strings or null; the last three are bounded string arrays. Photo references remain source evidence, not preserved original-media claims. Never include private notes, buyer information, cookies or credentials. The receipt is limited to64KiB.

Pricing contains currency, asking_minor, mechanism, enabled and minimum_minor. Currency and money may be null. Mechanism is `poshmark_smart_sell`, `mercari_smart_pricing` or `unknown`; enabled is boolean or null. Unknown automation is not off. Independent verified floor/automation facts can survive a missing asking amount within this new observation; old values are never substituted. The current view marks incomplete pricing unknown and does not invent a currency.

Mappings are deliberately narrow. Poshmark exact **For Sale** means active; **Not For Sale** means ended. Activity **Inactive** remains independent and does not negate For Sale. Mercari's inspected **Deactivate** control indicates the listing is currently active; send the exact normalized evidence string `Deactivate control visible`. An unverified Activate control or another label remains unknown until its native semantics are inspected and this contract is reviewed. A blocked or missing editor is a failed read, not evidence of a sold, removed or ended listing.

Finish atomically appends immutable source/snapshot evidence, a listing observation, a pricing observation and exact operation proof. Existing newer/equal-time conflict rules determine the visible current projection. Exact receipt/lease retries return the same proof without duplicate evidence. Generic evidence completion cannot complete this scope. No notification, stock, order, sale or delist job is created.

## Recovery

Use `resale_fail_listing_refresh(action_id,lease_token,reason)` for browser_unavailable, account_unverified, listing_unavailable, unsupported_editor, read_failed or target_changed. Ordinary read failure retains prior evidence and can be claimed again. Every resumed read receives a new fenced lease; an old consumer cannot commit a late result. A target_changed result retires the obsolete request while preserving its history, allowing a new member request against the current exact binding. No blind negative inference follows failure.

Before finishing, current requesting membership, account, exact listing ID and physical link must still match. A concurrent observation change requires a fresh request. After completion, retry remains tied to the exact receipt and physical/account binding. Close only the agent-owned tab and retain compact evidence/verification IDs.

## Release checks

Run `npm run test:listing-refresh`, `npm run test:listing-refresh-concurrency`, full tests, typecheck, lint and production build. Hosted acceptance runs transaction-only fixtures and verifies existing table fingerprints before/after. It proves permission and state behavior, not a live marketplace read. Native acceptance must show a real tracker request, exact seller-editor read, source/proof binding, fresh observed status/pricing timestamp and unchanged remote/physical fields. The private-reference request remains a separate supervised action.

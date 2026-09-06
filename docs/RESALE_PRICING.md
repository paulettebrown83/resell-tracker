# Marketplace price settings

Observed settings belong to one exact seller account, marketplace listing, and current inventory link. They are separate from desired draft fields, item cost, sale proceeds, quantity, and physical stock.

`resale_pricing_observations` is append-only. Only the service-only `resale_record_pricing_observation(member_id, request_id, listing_id, source_record_id)` can promote pricing facts. The RPC checks current resale membership, source/account/listing identifiers, accepted source status and permitted source kinds, then derives settings from `normalized.pricing`. It accepts no price values from its caller. The request UUID is actor bound; exact retries preserve one record. Corrected observations require new immutable source evidence.

A source must contain `external_identifiers.listing_id` and `.account_id`, an actual `source_observed_at`, and normalized pricing `{currency, asking_minor, mechanism, enabled, minimum_minor}`. Monetary values are minor units. `enabled:null` means unknown. `minimum_minor:null` means no verified floor, never zero. `mercari_smart_pricing` changes asking prices; `poshmark_smart_sell` sends automatic offers. Confirmed off is different from an absent setting.

The member-readable `resale_listing_pricing` view returns one row per listing, current draft version, current exact target, observation ID, observed time, amounts, and `pricing_status`. Same-time facts that disagree return `conflict` with no authoritative observation ID or amounts. Changed listing/account identity or inventory link returns `target_changed`. Observations older than 24 hours return `stale`; this is a conservative preparation limit, not a live-sync guarantee. Every remote execution will require a fresh preflight even inside that limit.

The tracker displays these settings in Shop activity's listing cards. Missing settings are visible. A prepared price request captures `requested.pricing_expectation`: `{pricing_observation_id,draft_version,account_id,listing_id,external_listing_id,inventory_id,policy:'preserve_platform',intent:'set_asking_price'}`. Its immutable request payload and existing desired SHA bind that expectation to the requested draft. The SQL request trigger adds pricing blockers for unknown/stale/conflicting facts, changed capture, or enabled/unverified automation.

**Remote price execution is unavailable.** Existing listing price-bearing publish/update actions cannot enter `running` or `succeeded`. No toggle, floor mutation, or fixed-price executor was added. A future adapter must explicitly handle provider-controlled changes, compare the captured exact source/target/draft again, and verify the same mechanism/settings and expected result after writing. The policy text is not proof of preservation. New unlisted local drafts are still preparation; package creation is not publishing.

## Rollout and acceptance

Apply migration `20260906072245_resale_platform_pricing.sql` before deploying the UI read. Capture existing table fingerprints before migration and source promotion, then compare afterward. Promote only reviewed exact source IDs with the current approved member ID, using deterministic request UUIDs. Read back the resulting view; never derive source IDs by title. No migration embeds business observations or secrets.

The two-shop pilot's authenticated editor evidence is retained privately in `resale-system/shared/pilot-preflight/`. Poshmark Smart Sell was off at $22; Mercari Smart Pricing was on at $20 with a $17 minimum. Both listings remain unmatched. These are time-stamped observations, not a physical-unit confirmation or live order guarantee. Promotion into this table does not change either marketplace or canonical inventory/sales.

Validation: `npm run test:pricing`, affected workbench/operation tests, typecheck, lint, and production build. Hosted acceptance must show member-only reads, service-only promotion, exact retry, source identity rejection, preserved prior rows, and the actual production price panel. Close owned tabs/processes and remove disposable worktrees after verified merge.

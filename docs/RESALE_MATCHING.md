# Manual listing matches

Implemented locally; apply the migration and integrate the helper before showing a live confirmation button. No production migration or marketplace write is part of this change.

`confirmResaleListingMatch(input, requestId): Promise<ResaleListing>` lives in `lib/resale-matching.ts` and calls `resale_confirm_listing_match(p_request_id uuid, p_payload jsonb)`.

The input has exactly these camelCase fields:

```ts
{
  listingId: string,
  inventoryId: string,
  expectedObservationId: string | null,
  expectedInventoryId: string | null,
  expectedMatchStatus: 'unmatched' | 'proposed' | 'confirmed' | 'rejected',
  reason: string
}
```

Show the selected physical item and listing evidence together. Title similarity may suggest candidates; it never confirms identity. Preserve sizes, colors, duplicate units and bundles. Require an explicit reason (1–2000 trimmed characters). Never put credentials in the reason. Generate one UUID request ID when Paulette confirms and keep that exact input and ID through an uncertain network failure.

The server locks the current resale membership, target item and listing, then compares the expected observation, previous inventory link and match status. A committed membership revocation denies calls and retries. The target must exist and be unarchived in both inventory and item details. Sold inventory or a linked non-void sale rejects with `22023`: review that sale first; stock was not changed. A sold marketplace listing can be linked to unsold inventory for investigation; this does not mark the item sold.

`40001` means the observation or prior match changed. Refresh, show the new evidence and obtain a new decision with a new request ID. Do not automatically replace expected values and retry. Reusing an ID with a different actor or payload rejects with `22023`. Exact successful retries return the original decision snapshot, even if a later correction exists; refresh the workbench after success and do not treat the returned snapshot as the current listing forever. Missing listing/item returns `P0002`.

A confirmation updates only the listing's inventory link, match status, actor, time and a namespaced `match_evidence.manual_confirmation` object. Existing evidence keys remain. Every decision also appends immutable `resale_listing_match_history`, retaining the complete prior match evidence and the observation/snapshot/account/external ID at confirmation. Only current resale members can read history; browser writes are denied. The private retry ledger has no browser or service-role table grants.

Accounts, external IDs, prices, stock status, immutable source records, sales and outbox actions are untouched. Linking across marketplaces is allowed because physical inventory is shared across Paulette's resale accounts; identical external IDs in another account are separate listing rows. A match with a null external listing ID is valid but does not supply the missing identity needed for delisting. Matching does not retroactively create sale actions, resolve review cases, or authorize any marketplace operation.

Run the focused tests explicitly (package scripts are intentionally untouched for parallel integration):

```sh
node tests/resale-matching.test.mjs
node tests/resale-matching-concurrency.test.mjs
npm run typecheck
npx eslint lib/resale-matching.ts tests/resale-matching*.test.mjs
```

The first test runs all migrations in disposable PGlite; the second uses real PostgreSQL with independent connections, verifying identical retry serialization, competing corrections, observation arrival and membership revocation. Native fixtures replace only the unrelated vector type, as in the repository's existing concurrency suite. Both close databases; the native suite removes its temporary directory in `finally`. Tests use synthetic records and no hosted credentials.

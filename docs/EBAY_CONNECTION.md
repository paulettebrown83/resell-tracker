# eBay connection/read foundation

This foundation is intentionally unactivated. No production developer key, registered RuName, seller OAuth grant, API read, or deletion subscription has been verified. Existing Seller Hub reports remain historical evidence. The connection page is discoverable under Marketplaces; it never infers API access from a browser login.

## Runtime and permissions

Next routes forward to `resale-ebay-connect` in Supabase Edge. Edge validates the caller with the real Auth `/user` endpoint; narrowly granted service RPCs validate live resale membership, exact account ownership and the saved `paulbr-89` handle. The callback uses a random one-use state, hashed member/account/generation binding and a secure HttpOnly SameSite=Lax browser cookie. It exchanges the authorization code using the registered **RuName**, not the literal callback URL. PKCE parameters are deliberately absent: they are not established by the reviewed eBay flow.

Only `GetUser`, `GetMyeBaySelling`, and `GetOrders` are allowed by the provider adapter. These read existing Trading listings; the implementation does not assume Inventory API offer ownership or migrate listings. eBay's base OAuth permission is provider-broad even though this runtime is read-only. `GetUser` has no supplied UserID/ItemID, so it verifies the token's own seller. A different seller, missing handle or changed immutable EIAS hash fails. Raw EIAS identifiers remain transient; private hashes bind the connection. Account deletion or changed configuration fences pending work. No access token, refresh token, cookie or provider body is logged or sent to the browser.

Trading requests use fixed HTTPS hosts, OAuth `X-EBAY-API-IAF-TOKEN`, US site0 and an explicitly configured compatibility version. No remote URL, arbitrary call name or caller SQL is exposed. One account read runs at a time; each call reads one page of at most50 listings/orders (2MiB XML bound,12-second network timeout,90-second lease). The UI reads active listings through a resumable run or reads the first page of a fixed seven-day order creation window ending three minutes ago. Page ranges are limited locally to1–100. This is an authenticated open-page reader, not an unattended sync or historical backfill.

Saved UUID requests bind owner, account, kind, page and exact window. A lost response replays the completed result; changed retries fail. Every refresh verifies the same seller again. Orders additionally verify the seller-specific fields, never the order's buyer EIAS field. Line IDs survive changed unpaid/paid order IDs; original and extended order IDs are retained as evidence. Checkout completion is not payment proof. No order read changes inventory, sales, shipping or delisting actions. Active-listing runs append exact-ID marketplace observations as described below; they never infer physical stock.

## Deletion states

The endpoint performs the documented challenge and verifies ECDSA/SHA1 signatures against fixed-host public keys cached for up to one hour (maximum16 keys). The verifier is regression-tested against eBay's actual SDK test vector at commit `feaf3378ca263a81432cf5b8c8a6fd8cb3d3e2f3`; the Apache license accompanies that fixture. No signature-header algorithm or URL can select a different verification route.

Verified receipts retain event identity/time and private subject hashes. The active-store consumer deletes the new integration's matching API-read pages for buyer notices. For its seller, it also pauses/fences the connection and deletes the exact scoped refresh secret. Buyer contact/address fields are discarded before persistence; buyer identity hashes live only in a private index supporting deletion. A missing buyer EIASToken blocks the whole order page as unresolvable coverage. BuyerUserID is not a fallback: current eBay documentation says it may contain a username or immutable ID depending on developer mode, and that mode has not been verified for this account. Mutable handles cannot ensure deletion matching after a rename. A shared transaction lock and retained subject tombstone stop concurrent reads from reintroducing deleted subjects.

Receipt acknowledgement and `connection_purged_at` are **not completed erasure**. Historical CSV/source records, backups and any demonstrable retention requirement still need a reviewed scope and completion receipt. `activation_ready`, `deletion_receipts_ready` and a nonempty reviewed coverage reference are all required before connection/read activity. No configuration is seeded in the migration. The receipt-only setup stage can be tested before activation. Do not subscribe or activate while historical coverage remains unresolved; do not erase existing reports merely to enable setup.

## Setup, owned by agents

1. Recover the existing developer account, verify its production keyset and assigned base scope, and register the actual callback under a RuName. Preserve existing Google sign-in. Callback: `https://resell-tracker-beta.vercel.app/api/integrations/ebay/callback`. Deletion endpoint: `https://resell-tracker-beta.vercel.app/api/integrations/ebay/deletion`.
2. Move the client secret directly to Vault `resale_ebay_production_oauth_client_secret` and a fresh32–80-character deletion token to `resale_ebay_production_deletion_verification_token`. No values belong in docs/tool output/Git. Verified OAuth creates `resale_ebay_production_account_{account_uuid}_refresh_token`; only this connection's Edge RPC consumes it. Public client ID/RuName/version belong in private configuration, not Vault.
3. Independently review code/SQL and affected-scope backup/restore before deployment. Resolve the private deletion coverage map, validate the actual public challenge/signature path and provider subscription. Then enable reviewed configuration, complete real seller consent and verify real bounded reads against Seller Hub. Test wrong seller/member/replay/revocation and deletion with isolated synthetic data. Never label fixtures as live success.

Agents close their own test tabs/processes and remove disposable fixture resources. Paulette uses the connection/read controls, not terminal scripts. Owner-only developer recovery/CAPTCHA remains a separate step.

## Primary sources reviewed 2026-09-06

- [eBay authorization](https://developer.ebay.com/develop/guides/sell/authorization): auth-code grant, RuName and scope handling.
- [Trading XML authentication](https://www.developer.ebay.com/api-docs/user-guides/static/make-a-call/using-xml.html).
- [GetUser](https://developer.ebay.com/devzone/XML/docs/Reference/ebay/GetUser.html) and [stable EIAS identity](https://www.developer.ebay.com/api-docs/user-guides/static/trading-user-guide/user-mgmt-user-info.html).
- [GetMyeBaySelling](https://developer.ebay.com/devzone/xml/docs/Reference/ebay/GetMyeBaySelling.html): self-only lists and page controls.
- [GetOrders](https://developer.ebay.com/devzone/xml/docs/Reference/ebay/GetOrders.html): seller fields, changing order identity, payment caveats,30-day modification windows/90-day availability. This initial reader uses creation windows capped locally at30days and does not promise all history.
- [Order buyer identity](https://developer.ebay.com/devzone/xml/docs/Reference/ebay/types/OrderType.html#BuyerUserID): developer-dependent BuyerUserID mode; this adapter requires explicit EIAS instead.
- [Account deletion](https://www.developer.ebay.com/develop/guides/sell/marketplace-user-account-deletion): receipt, verification and erasure requirements. Its30-day figure concerns repairing a failed callback; it is not a general deletion deadline.
- [Official verifier/test fixture](https://github.com/eBay/event-notification-nodejs-sdk/tree/feaf3378ca263a81432cf5b8c8a6fd8cb3d3e2f3).

REST Identity/Fulfillment overviews are current, but their old method URLs redirected to overviews and direct official spec/Markdown downloads returned403 during this pass. No restrictions on app eligibility were inferred from those transport failures. The documented Trading path was selected instead of inventing REST schemas.

## Local verification

`npm run test:ebay` covers provider/proxy and SQL-role fixtures. `npm run test:ebay-concurrency` starts a disposable native PostgreSQL server and verifies buyer deletion against an in-flight finalization. The provider suite also passed in Deno2.9.6 with the committed import map/lock. This is local compatibility evidence; it does not replace actual hosted Edge, OAuth or Seller Hub acceptance. Full application tests, typecheck, lint and a build with public configuration passed before rollout.

## Disabled rollout checkpoint (2026-09-06)

Reviewed migration source `20260906083147_resale_ebay_connection.sql` was applied under hosted ledger `20260906090716`, SHA256 `cbba0ba9f3409d5238d36573549a69e119d2009b7aeab4914cc84476d7c1676e`. All33 pre-existing table fingerprints remained unchanged. The fresh prerequisite snapshot restored all7 captured rows across memberships/accounts before and after the migration; it is explicitly a partial snapshot, not Auth/Vault/Storage or full project recovery.

Supabase Edge `resale-ebay-connect` version1 is deployed with custom authentication. Eight hosted SQL-role checks passed with every synthetic write rolled back; connections, reads, configuration and token rows remain zero. Actual Edge HTTP checks rejected signed-out requests401, invalid bearer403, unconfigured deletion409 and unknown operation400. No provider request or live credential was involved.

The app release supplies the connection/setup page; native signed-in acceptance remains pending the locked Mac. Real seller consent, listing/order readback, deletion registration and full coverage validation remain activation checks. The previously released Poshmark package feature also retains its separate actual private-byte/download/discard/native acceptance checklist; these eBay checks do not replace it.

## Resumable active-listing reads

`resale_ebay_listing_runs` freezes actor/account, connection generation and config revision. Each authenticated step uses a server-selected immutable page request. The open UI advances automatically; interruption offers Resume with the exact saved receipt, including a read that succeeded before its checkpoint response was lost. Stop this run permits an explicit fresh run. Local limits are100 pages/5000 reported records and one hour; these are application bounds, not claims about provider limits.

Completion means every returned page was read during the captured interval, not an atomic shop snapshot. Duplicate listing IDs, changed page/entry totals or a final count gap stop with visible incomplete coverage. A provider collection can also change without changing totals. Absence never produces sold/ended observations. Per-page snapshots stay partial; run-level coverage explains the interval.

Checkpoint reads only the exact completed API receipt. It creates an official_api snapshot, immutable source record and positive active observation for each exact account/listing ID. Existing inventory links, draft fields/versions, match decisions, listing title and asking-price projection remain unchanged; newly discovered listings stay unmatched. The API fields and prices remain in source evidence, distinct from an instruction to change a price. The existing observation reducer updates marketplace availability only when the new observation is newer.

A verified seller deletion follows private page/source/observation mappings, removes new API source records through a narrowly indexed trigger exception and restores the newest retained availability observation. Imported-only title/URL/external-ID metadata is cleared when no observation remains. Independent item and draft records are retained. General source immutability and historical evidence remain protected. Downstream references or historical copies still require the separately reviewed deletion coverage; this consumer does not assert full erasure.

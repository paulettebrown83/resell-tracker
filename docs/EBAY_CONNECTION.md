# eBay connection/read foundation

This is unactivated code. No production developer key, registered RuName, seller OAuth grant, API read, or deletion subscription has been verified. Existing Seller Hub reports remain historical evidence. The connection page is discoverable under Marketplaces; it never infers API access from a browser login.

## Runtime and permissions

Next routes forward to `resale-ebay-connect` in Supabase Edge. Edge validates the caller with the real Auth `/user` endpoint; narrowly granted service RPCs validate live resale membership, exact account ownership and the saved `paulbr-89` handle. The callback uses a random one-use state, hashed member/account/generation binding and a secure HttpOnly SameSite=Lax browser cookie. It exchanges the authorization code using the registered **RuName**, not the literal callback URL. PKCE parameters are deliberately absent: they are not established by the reviewed eBay flow.

Only `GetUser`, `GetMyeBaySelling`, and `GetOrders` are allowed by the provider adapter. These read existing Trading listings; the implementation does not assume Inventory API offer ownership or migrate listings. eBay's base OAuth permission is provider-broad even though this runtime is read-only. `GetUser` has no supplied UserID/ItemID, so it verifies the token's own seller. A different seller, missing handle or changed immutable EIAS hash fails. Raw EIAS identifiers remain transient; private hashes bind the connection. Account deletion or changed configuration fences pending work. No access token, refresh token, cookie or provider body is logged or sent to the browser.

Trading requests use fixed HTTPS hosts, OAuth `X-EBAY-API-IAF-TOKEN`, US site0 and an explicitly configured compatibility version. No remote URL, arbitrary call name or caller SQL is exposed. One account read runs at a time; each call reads one page of at most50 listings/orders (2MiB XML bound,12-second network timeout,90-second lease). The UI initially reads active listings or a fixed seven-day order creation window ending three minutes ago. Further pages use the same verified read contract; page ranges are limited locally to1–100. This is a bounded page reader, not an unattended sync or a historical backfill.

Saved UUID requests bind owner, account, kind, page and exact window. A lost response replays the completed result; changed retries fail. Every refresh verifies the same seller again. Orders additionally verify the seller-specific fields, never the order's buyer EIAS field. Line IDs survive changed unpaid/paid order IDs; original and extended order IDs are retained as evidence. Checkout completion is not payment proof. No row changes inventory, sales, listings, shipping or delisting actions.

## Deletion states

The endpoint performs the documented challenge and verifies ECDSA/SHA1 signatures against fixed-host public keys cached for up to one hour (maximum16 keys). The verifier is regression-tested against eBay's actual SDK test vector at commit `feaf3378ca263a81432cf5b8c8a6fd8cb3d3e2f3`; the Apache license accompanies that fixture. No signature-header algorithm or URL can select a different verification route.

Verified receipts retain event identity/time and private subject hashes. The active-store consumer deletes the new integration's matching API-read pages for buyer notices. For its seller, it also pauses/fences the connection and deletes the exact scoped refresh secret. Buyer contact/address fields are discarded before persistence; buyer identity hashes live only in a private index supporting deletion. Missing buyer identity blocks that order page as unresolvable coverage. A shared transaction lock and retained subject tombstone stop concurrent reads from reintroducing deleted subjects.

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
- [Account deletion](https://www.developer.ebay.com/develop/guides/sell/marketplace-user-account-deletion): receipt, verification and erasure requirements. Its30-day figure concerns repairing a failed callback; it is not a general deletion deadline.
- [Official verifier/test fixture](https://github.com/eBay/event-notification-nodejs-sdk/tree/feaf3378ca263a81432cf5b8c8a6fd8cb3d3e2f3).

REST Identity/Fulfillment overviews are current, but their old method URLs redirected to overviews and direct official spec/Markdown downloads returned403 during this pass. No restrictions on app eligibility were inferred from those transport failures. The documented Trading path was selected instead of inventing REST schemas.

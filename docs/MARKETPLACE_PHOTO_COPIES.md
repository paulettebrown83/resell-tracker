# Saved marketplace photos

Marketplaces → Listing photos opens the exact listing’s recorded photo sources. Save private copy preserves the downloaded bytes in private R2. Ready images can be viewed and downloaded for preparation. The label remains “marketplace copy”: these files may already have been resized or compressed by the shop and are never relabeled camera originals. A retained cover proves one cover, not the complete gallery. Source-seen time and byte-save time stay separate.

Unmatched listings are supported. Saving a photo does not establish physical stock, match an item, change a desired draft, publish a listing, or change prices. The existing Poshmark package builder still requires its own eligible original-media inputs; downloading a marketplace copy does not silently add it to that package.

## Boundaries

- Service-only `resale_register_listing_photos(member,listing,source)` derives URLs from accepted immutable source evidence and checks exact current account/listing identity. Browser callers cannot register arbitrary URLs.
- The initial URL policy accepts the inspected Poshmark CDN path with the same external listing ID. No redirects, query parameters, private hosts, guessed Mercari URLs, enlargement variants, or eBay sources are accepted.
- `resale_prepare_listing_photo(request,ref)` requires a current authenticated resale member. The existing private Worker verifies Auth and membership, claims the exact request, fetches only the registered URL, bounds size at20MiB, verifies MIME, and stores unchanged bytes under their SHA256.
- Identical content shares one immutable object. Each source/position retains its own provenance and fetch record. A conditional per-request/nonce capture manifest fixes the first bytes for uncertain-response recovery. If source bytes change during a retry, the old capture is not overwritten.
- Read access always uses the photo reference and current member authorization. Hash knowledge alone is not a download capability. The browser uses temporary private blob URLs and revokes them on close/unmount.
- Ordinary originals keep their separate schema/path and existing signed finalization. Marketplace dispatch/receipt HMAC domains are explicit and cannot substitute for each other or original receipts.

## Request recovery

Same-lease retries can overlap. A reader failure records a visible last error but cannot retire another in-flight successful capture. Manifest or finalization uncertainty leaves the lease retryable. Retry the same saved request. After the server confirms expiry/failure, the client retires that request ID; the next deliberate attempt gets a new ID. Old jobs/manifests remain audit evidence. Ready rows and content cannot be overwritten. Membership revocation and target changes stop preparation/finalization.

## Trusted server administration

The service-only admin preparation must commit before a separate signed Worker dispatch. The dispatcher carries an exact member/ref/source/account/listing/URL/nonce/expiry ticket; no fake user bearer or broad runtime service key exists. Keys stay in the existing named Vault consumer. The fixed temporary SQL HTTP helper uses the installed1.6 option setter/readback and disables its legacy timeout override. Its external HTTP effect can finish after a caller timeout: inspect committed job/ref/R2 proof before retrying. Temporary extension cleanup is required.

## Release status

Implementation and fixture acceptance are under review. Production migration, Worker deployment, actual retained Posh cover capture, and authenticated viewer acceptance have not yet been recorded. Mercari exact source URLs remain pending native capture. No background marketplace photo scraper or full-gallery claim is installed.

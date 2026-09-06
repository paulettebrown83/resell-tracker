# Private resale original photos

Status: implementation prepared for review; no bucket, runtime secret, production Worker, or app deployment is created by this change. This component belongs to the resale project only. It does not grant access to other projects sharing Supabase.

## Flow and contract

1. Browser creates one `MediaUploadIntent` per selected original. Keep that intent and File through failures. Call `resale_reserve_media(p_request_id, p_inventory_id, p_mime_type, p_byte_size)`; ID is the request UUID. The database allocates immutable `resale/items/{inventory_id}/{media_id}/original` in `paulette-resale-originals-prod`. Row is `pending`, kind `original`, exact intended size/type. No filename becomes an object path.
2. `PUT /v1/media/{media_id}` sends the File bytes and Supabase bearer access token. Worker calls real Auth `/auth/v1/user`, membership RPC `resale_access`, then reads `resale_media` with that caller's row restrictions. No privileged database key exists in the Worker. Reservation must agree with the fixed bucket/path/IDs.
3. Stream is bounded to reservation size and 20 MiB maximum, rejecting extra/truncated bytes. Supported MIME signatures: JPEG, PNG, WebP, GIF. SVG, HTML, HEIC and camera RAW are not supported by this version. Originals are never recompressed or stripped. Header detection is a format gate, **not a full decoder or malware scan**; image dimensions and thumbnails require later decoding in a constrained image-processing service. Do not claim those fields are populated here.
4. Worker computes SHA-256 over bytes, uses R2 conditional `If-None-Match: *` plus the native SHA-256 integrity check, then HEAD verifies size, checksum and identity metadata. Existing objects are never overwritten. Identical retry is allowed; different bytes conflict. The Worker never deletes objects.
5. Worker returns `{receipt_payload, receipt_signature}`. Payload is exact UTF-8 JSON text with `{v:1,media_id,inventory_id,bucket,object_key,sha256,byte_size,mime_type,expires_at}`; expiry is epoch seconds 10 minutes from signing. Signature is lowercase hex HMAC-SHA256 using raw bytes decoded from a 64-character lowercase hex key. Browser forwards the string unchanged to `finalize_resale_media(p_receipt,p_signature)`. Database verifies signature, expiry, reservation and current membership before setting `ready`. A receipt is not a bearer download URL.
6. `GET /v1/media/{media_id}` rechecks Auth, current membership and ready media row, then verifies object metadata/checksum before streaming with no-store, nosniff and sandbox headers. The browser helper returns a local blob URL for `<img>` and an explicit `revoke()` cleanup function. URLs and tokens are not persisted in the database.

A retry after an unconfirmed database finalization repeats reserve and PUT against the same ID and File, obtaining a fresh receipt. Do not create a new request ID because a network response was lost. An R2 success followed by failed finalization leaves a pending row and retained bytes for this recovery path. Pending objects have no automatic cleanup: an operator must reconcile row/object state before any eventual retention policy. Ready objects missing from R2 are not silently recreated.

## Runtime configuration and deployment ownership

Coordinator provisions the private bucket and deploys `worker.mjs` as an ES module with no dependencies or build step. Runtime name `paulette-resale-media-prod`; binding `RESALE_ORIGINALS` to `paulette-resale-originals-prod`. Keep bucket `r2.dev` and custom public domains disabled. Do not enable bucket CORS/public reads; browsers use the authenticated Worker gateway.

| Configuration | Destination / meaning |
| --- | --- |
| `SUPABASE_URL` | Worker plain variable; approved project HTTPS URL |
| `SUPABASE_PUBLISHABLE_KEY` | Worker plain variable; public key only |
| `ALLOWED_ORIGINS` | Worker plain variable; exact comma-separated origin list; production `https://resell-tracker-beta.vercel.app` |
| `MAX_UPLOAD_BYTES` | Worker plain variable; default `20971520`, may lower but not raise above 20 MiB |
| `MEDIA_RECEIPT_KEY` | Worker secret, securely copied from Vault `resale_media_production_receipt_signing_key`; 32 random bytes represented by 64 lowercase hex characters |
| `NEXT_PUBLIC_RESALE_MEDIA_URL` | Vercel public app variable; deployed Worker HTTPS origin, no path/query |

The provided Wrangler config contains placeholders only. It is a deployment manifest, not evidence that deployment exists. Coordinator can use REST multipart module upload with identical bindings instead of installing Wrangler. No Cloudflare management token, R2 S3 key, Supabase service key or Vault read capability belongs in this runtime. Paulette owns credentials; the deployment coordinator maintains Vault/runtime synchronization. Rotate by coordinating database verifier and Worker key together; a mismatch temporarily blocks finalization but preserves originals for retry. Do not rotate or delete old values independently.

Production allows only the exact tracker origin. For a coordinated local test, temporarily add one explicit localhost origin and remove it afterward; never use `*`, broad preview patterns or reflect arbitrary origins. CORS does not replace bearer authorization. Requests without Origin still require the same Auth checks. Supabase auth is not cached. Membership revocation blocks the next network request; bytes already delivered to a browser or downloaded cannot be revoked. UI must abort pending loads and revoke its blob URLs on sign-out, account change and unmount. Do not store bearer tokens in media URLs.

No remote-URL fetch/import endpoint exists; images must be explicitly uploaded as bytes. No telemetry logs are emitted by the code. Deployment must keep request headers/body out of logs and traces. No browser caching is allowed. Since originals may contain GPS/EXIF, preserve them privately and introduce explicit sanitized marketplace derivatives before publishing images externally.

The 20 MiB bound uses one bounded body allocation plus hashing buffers. Run uploads sequentially in the UI to reduce Worker isolate and browser memory use. This component does not generate thumbnails; loading many full-size originals simultaneously is unsuitable for a large inventory grid. Show a restrained preview for the selected item until thumbnail processing is implemented.

## Verification and rollout

Run `node --test tests/media-worker.test.mjs tests/media-client.test.mjs` from the repo root. Unit tests exercise the real Worker entrypoint with a deterministic R2 model and Auth/REST test boundary. They verify exact byte/hash preservation, HMAC receipt bytes, failed auth/outsider/revoked membership, private delivery, MIME/size limits, no overwrite and concurrent conditional-write collisions. They do not prove the actual deployed binding or hosted database verifier.

Before marking storage connected: deploy reviewed schema + Worker secret/binding; configure app origin; test signed-out and unrelated-account denial in the hosted stack; upload one synthetic nonpersonal raster through an approved browser; verify R2 checksum and ready row via administrative metadata; retry same reservation without a second object; reject a different original under that ID; verify authorized download and access after membership revocation in a controlled test. Keep real account memberships intact after testing. Test receipt tampering, expiry and altered reservation fields against database finalize RPC. Confirm no public bucket access. Record deployment version, migration version, object ID, verification outcomes and cleanup decision without secret values.

## Official references checked September 6, 2026

- [R2 Workers API and conditional writes](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
- [Workers Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)
- [Supabase server-verified getUser](https://supabase.com/docs/reference/javascript/auth-getuser)
- [Supabase changelog](https://supabase.com/changelog) (markdown endpoint failed; HTML index reviewed)

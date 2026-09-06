# Gmail feed RPC contract v1

Database source: `supabase/migrations/20260906064000_resale_gmail_feed.sql`. Deployment remains pending independent review; see `GMAIL_FEED.md`.

Initial scope is one mailbox (`paulettebrown83@gmail.com`), Vinted, parser `vinted-gmail-v1`. Every credential/state/poll RPC below is granted only to the service role used inside the Supabase Edge Function; its HTTP handlers must validate bearer user or tick signature before use. No browser or anonymous Vault read is exposed. Member ownership is checked in SQL without synthesizing a user JWT.

## Member call

`resale_enroll_gmail_feed(p_request_id uuid, p_payload jsonb) -> uuid` requires a real authenticated resale member. Payload is `{mailbox_email, account_id, parser_version}`. Exact actor-bound retries return the same feed ID. The only accepted mailbox/parser are the initial values above, and account_id must reference Vinted. The owner cannot be changed by an enrollment retry. `resale_gmail_feeds` exposes nonsecret status/last-success/error metadata under resale RLS; only the enrolled owner can change enrollment.

## OAuth calls (service only)

- `resale_gmail_oauth_start(p_member_id uuid,p_feed_id uuid,p_state_sha256 text,p_browser_binding_sha256 text,p_code_verifier text)` returns `{state_id,client_id,redirect_uri,expected_mailbox,expires_at}`. Runtime creates unpredictable state/cookie values and PKCE verifier; only hashes of state/cookie enter the DB. Expires in 600 seconds, exact live ownership checked. Client/redirect come from private coordinator configuration.
- `resale_gmail_oauth_consume(p_state_sha256 text,p_browser_binding_sha256 text)` atomically consumes it once and returns `{state_id,member_id,feed_id,client_id,redirect_uri,code_verifier,client_secret,expected_mailbox}` to Edge only after checking live membership. Callback never returns this object to the browser.
- `resale_gmail_oauth_complete(p_state_id uuid,p_mailbox text,p_scopes text[],p_refresh_token text)` verifies the consumed state/current member, exact mailbox and readonly scope, stores/retains the named refresh token, fences prior leases and returns nonsecret `{feed_id,status}`. NULL token retains an existing token only if its stored OAuth client association still matches; it cannot activate a tokenless feed. Production consent configuration must be recorded; testing/unknown stays paused rather than advertised as durable.

Coordinator config: `private.resale_gmail_config` singleton containing OAuth client ID, exact callback URI and publishing status (`unknown|testing|production`). No credential values in that row. Changing the client, callback or publishing status fences previous OAuth states and leases immediately and requires reconnection. Fixed Vault names use the `resale_gmail_paulettebrown83_production_` prefix and suffixes `oauth_client_secret`, `oauth_refresh_token`, `tick_signing_key`, `ingress_signing_key`. Keys are independently generated 32-byte hex secrets. Do not reuse the media key or pass either signing key into browser code.

## Tick, lease and progress (service only)

`resale_gmail_verify_tick_and_claim(p_tick text,p_signature text)` verifies lowercase hex HMAC-SHA256 of exact UTF8 `gmail_tick_v1\n` plus p_tick. Tick JSON is `{v:1,nonce:<uuid>,expires_at:<epoch seconds>}` with at most 600 seconds remaining. One active feed, current membership, minimum run interval and a single fenced lease are enforced. Returns JSON null when nothing can run; otherwise `{feed_id,member_id,account_id,account_handle,mailbox_email,parser_version,lease_token,lease_expires_at,cursor,client_id,client_secret,refresh_token,ingress_signing_key}` to Edge only. Replaying a tick cannot issue another lease.

`resale_gmail_checkpoint_run(p_feed_id uuid,p_lease_token uuid,p_cursor jsonb)` saves bounded pagination progress under a live fenced lease. `resale_gmail_finish_run(p_feed_id uuid,p_lease_token uuid,p_outcome text,p_cursor jsonb,p_error_code text)` accepts `complete|partial|retry|reconnect_required|paused`; only complete advances last_success. Runtime error codes are bounded names, not raw provider bodies or secrets. Expired/previous-generation tokens cannot checkpoint or finish.

Cursor v1: `{window_start_ms:number,window_end_ms:number,page_token:string|null,window_complete:boolean,pending_message_ids?:string[]|null,next_page_token?:string|null}`. Pending IDs contain at most 25 hex Gmail IDs; the optional next token is bounded to 2048 characters. Empty pending array means fetched and fully processed; null/missing means not fetched. Checkpoint the page before reading messages, then remove one ID only after confirmed ingestion and checkpoint again. The fixed window cannot change while incomplete; a later window cannot skip or move its end backward. Paused runs preserve pending IDs and fence the lease; reauthorization preserves this cursor. A deleted or unreadable message requires explicit gap recovery, never a silent skip. Runtime must finish every page before advancing a completed window. No arbitrary source query, credential, executable instruction or raw response belongs in a cursor.

## One-message signed ingress (service only)

`resale_ingest_gmail_message(p_receipt text,p_signature text)` verifies lowercase hex HMAC-SHA256 of exact UTF8 `gmail_ingest_v1\n` plus p_receipt. It returns `{source_record_id,operation_id,duplicate,legacy_source_reused}`.

```ts
interface GmailReceipt {
  v: 1; nonce: string; feed_id: string; lease_token: string;
  parser_version: 'vinted-gmail-v1'; account_id: string;
  message_id: string; thread_id: string;
  received_at: number; captured_at: number; // epoch milliseconds; received time is not sale time
  kind: 'sale_notification' | 'shipping_notification' | 'cancellation_notification' | 'unknown';
  source_sha256: string; expires_at: number; // expiry epoch seconds, <=600 seconds
  normalized: {
    subject: string; account_handle: string | null; product_titles: string[];
    money_mentions: Array<{raw:string;amount_minor:number|null;currency_symbol:string|null;currency_code:null;meaning:'unallocated'}>;
    conversation_ids: string[]; transaction_id: string | null;
    order_id: null; listing_id: null;
    parser_status: 'recognized' | 'quarantined'; quarantine_reason: string | null;
    authentication_pass: boolean;
  };
}
```

Source checksum covers the runtime's deterministic original Gmail payload projection. Normalized fields are strictly bounded/allowlisted; no raw body, buyer/address/tracking/photo data or secrets. Signature, nonce, current member/enrollment, lease, account, parser and receipt validity are checked before writes, including received time inside the checkpointed window. Each source produces one blocked `reconcile_sale`, `reconcile_shipping`, `reconcile_cancellation`, or `import` task; notifications cannot mutate stock, orders, sales, matches or remote actions. Unknown/quarantined cases remain explicitly blocked.

Message dedupe uses mailbox plus Gmail message ID and a stored semantic payload hash that excludes delivery nonce/lease/capture time. An exact retry returns existing IDs; changed evidence cannot overwrite the first record. Legacy sources with the same exact account-scoped Gmail message ID are preserved and reused only with an explicit linked review of new parser facts. Their old normalized values are never silently replaced.

# Common marketplace work queue

Implemented in the operations branch; deployment and real adapter activation are separate. This migration extends `resale_actions` and `resale_action_attempts`. There is no second task queue, scheduled polling service or marketplace publishing integration hidden behind these tables.

## Browser contract

`lib/resale-operations.ts` exports the common types and three helpers:

- `getResaleOperations(accountId?)`: current member-only view, including blocked reasons, mode, next step, checkpoint, attempts, proof references and evidence-proposal count.
- `requestResaleOperation(input, requestId)`: saves one blocked request and returns its action UUID. Keep the UUID and exact payload on network errors. The same actor/request/payload gets the same action; changed payload or actor is rejected. An existing request is never silently re-executed.
- `submitResaleOperationEvidence(operationId, input, requestId)`: appends an account-checked proposal for review. This cannot complete the action, verify an event, change inventory, or record a sale. Proposals retain exact actor-bound retries.

The common operation names are `publish`, `update`, `delist`, `import`, `reconcile_sale`, `reconcile_cancellation`, and `reconcile_shipping`. The last four process evidence; they do not execute cancellations, refunds, shipping purchases or physical-stock changes. A reconciliation decision that still needs identity/quantity review stays **blocked**, retains its checked proof and adds a review case. It cannot be blindly reclaimed; resolve the evidence and deliberately request a new checked decision.

The states remain `blocked`, `queued`, `running`, `uncertain`, `succeeded`, `failed`, and `cancelled`. Attempt outcomes remain `accepted`, `verified`, `rejected`, and `uncertain`. An accepted response is uncertain until verified. Show the next-step explanation rather than labeling a blocked task as broken. `human_required` needs a concrete human step; `unavailable` means no supported executor. Temporary loss of browser control belongs in a runtime error/checkpoint, not a permanent marketplace capability downgrade.

New evidence tasks can have NULL listing IDs. Existing consumers of `ResaleWorkbench.actions` must handle that; `ResaleAction` has been widened accordingly. Use the common operation view for task UI rather than assuming every action joins a listing. Its deep link is derived from the stored listing URL and restricted to exact known HTTPS marketplace domains, without credentials, query strings or fragments. Never fall back to an unvalidated source URL when the link is NULL.

Listing requests require exact account/listing/item binding, confirmed match, expected observation and item version. Publish/update reject sold or archived items. The requested fields receive a stored SHA256 fingerprint; typed target metadata preserves opaque external identity kinds. Every new outbound request has a quantity-review blocker. The current one-unit inventory model does not establish pooled quantity/variant allocation. Do not remove that blocker merely because the browser submitted quantity1.

## Trusted dispatch boundary

`private.resale_operation_adapters` stores account/action capability, adapter/version, mode, readiness, required fields and an actual reason. It has no credentials and no browser grants. The migration inserts **no adapter rows**. A trusted coordinator may register a tested actual consumer; an account being logged in or a source report existing does not prove executor readiness. No broad service key or public privileged dispatcher is introduced.

The new private dispatcher accepts **evidence operations only**:

1. `resale_claim_evidence_operation(operation_id)` requires live requesting-member access and a ready registered adapter, validates required fields and the request hash, locks the action, and issues exactly one attempt/lease. Expired running work becomes uncertain; it is not retried automatically.
2. `resale_checkpoint_evidence_operation(operation_id, lease_token, step_key, source_record_ids, snapshot_ids)` stores only bounded step identifiers and same-account evidence references. It validates current membership and unexpired lease. Never save sessions, cookies, credentials, raw browser state or executable instructions here.
3. `resale_finish_evidence_operation(operation_id, lease_token, outcome, source_record_ids, snapshot_ids, decision, note)` validates current membership, attempt, account/snapshot ownership and operation-specific decision. `verified_source_event` requires real order and line IDs from accepted records; unknown identity stays `needs_review`. Import success means its trusted adapter checked and stored the referenced evidence. It does not mean a canonical sale was entered. Proof is append-only, and unchanged completion retries return the same result.

These functions are executable by the trusted service role only; they have no public wrappers. The service role is a privileged runtime identity, not an approval mechanism for browser claims. The actual adapter must check the original source, file hashes, coverage, event meaning, and exact request before invoking verified completion. The generic database layer proves reference/account/lease integrity; it does not independently reparse a CSV, verify an API signature or establish a financial transaction from arbitrary JSON. No real import runtime or scheduler is installed by this migration; the approved five-market historical import remains separately recorded in the coordinator's private import receipts.

`resale_operation_proposals` and `resale_operation_verifications` are separate append-only tables. Members can only read both, and can append proposals through the narrow member RPC. Browser access cannot insert a verified proof, edit an action, register an adapter, claim a lease or call a private finish routine.

Original sale-generated delist actions retain protocol0 and their reviewed exact current-target, confirmed-sale, fresh-observation and non-purchasable postcondition checks. The original release/claim/finish routines explicitly exclude protocol1 packets. Their expiration sweep is scoped to original delist work. No new publish/update/delist executor is enabled here; enabling one requires its own preflight/execution/readback tests and unit/variant rules.

## Validation and deployment

The local SQL tests exercise changed/actor retries, wrong accounts, stale target versions, sold items, malicious deep links, untrusted success claims, readiness and missing fields, checkpoints, uncertain readback, unchanged completion retries, missing order identity/quantity review, unchanged canonical inventory/orders/sales, dispatcher isolation and immediate revocation. Native PostgreSQL tests use independent connections for same-request serialization, competing leases and revocation while a request waits.

Run `npm test`, `npm run test:operations-concurrency`, `npm run typecheck`, and `npm run lint`. Native test processes and temporary database directories are stopped/removed in `finally`. Root reviews and integrates the migration together with nullable-listing UI handling. No production migration or marketplace mutation is authorized by this document alone.

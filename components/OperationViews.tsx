"use client";
import { capturePricingExpectation } from "@/lib/resale-pricing";
import { useEffect, useState } from "react";
import Link from "next/link";
import { supabase, requireAccess } from "@/lib/supabase";
import Dialog from "./WorkbenchDialog";
import {
  isPreparedDraftCurrent,
  type PreparedListing,
} from "@/lib/resale-drafts";
import { safeMarketplaceUrl } from "./MarketplaceViews";
import {
  evidenceLabel,
  eventLabel,
  EvidenceFields,
} from "./SourceReportBrowser";
import type {
  ResaleOperation,
  OperationKind,
  OperationEvidenceProposal,
} from "@/lib/resale-operations";
import type { ResaleWorkbench } from "@/lib/resale-data";
import type { ResaleListing, ResaleSourceRecord } from "@/lib/resale-contract";
import {
  operationRecoveryMatches,
  type OperationIntent,
  type OperationRecovery,
} from "@/lib/resale-operation-retry";
import { OPERATION_LABELS } from "@/lib/workbench";
import { gmailOperationContext, groupGmailActivity } from "@/lib/gmail-operation-context";
const stateLabels = {
  blocked: "Needs a next step",
  queued: "Waiting to run",
  running: "In progress",
  uncertain: "Result not confirmed",
  succeeded: "Verified result",
  failed: "Needs another look",
  cancelled: "Request cancelled",
};
const modeLabels = {
  api_automatic: "Connected API workflow",
  file_automatic: "File processing workflow",
  supervised_agent_browser: "Supervised browser workflow",
  human_required: "A person must do this step",
  unavailable: "Execution route not enabled",
};
function GmailFeedSummary() {
  const [state, setState] = useState<{ rows: Array<{id:string;status:string;last_success_at:string|null;last_error_code:string|null}>; error: boolean } | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        await requireAccess();
        const {data,error}=await supabase.from('resale_gmail_feeds').select('id,status,last_success_at,last_error_code');
        if(error)throw error;
        if(alive)setState({rows:data,error:false});
      } catch { if(alive)setState({rows:[],error:true}); }
    })();
    return () => { alive=false; };
  }, []);
  return <section className="wb-note"><div><strong>Vinted email notifications</strong>
    {!state?<p>Checking feed status…</p>:state.error?<p>Feed status could not be checked. Open its connection settings to review setup.</p>:state.rows.length?state.rows.map(feed=><p key={feed.id}>{feed.status.replace(/_/g,' ')} · Last complete check: {feed.last_success_at?new Date(feed.last_success_at).toLocaleString():'not yet completed'}{feed.last_error_code?` · ${feed.last_error_code.replace(/_/g,' ')}`:''}</p>):<p>Gmail is not connected for background notification checks yet.</p>}
    <p>Notifications create source-review tasks; they do not mark items sold or remove listings.</p><Link href="/integrations/gmail">Connect or check Gmail</Link>
  </div></section>;
}
export function OperationCards({
  sources = [],
  operations,
  data,
  onEvidence,
  onItem,
}: {
  operations: ResaleOperation[];
  sources?: ResaleSourceRecord[];
  data: ResaleWorkbench;
  onEvidence: (operation: ResaleOperation) => void;
  onItem?: (id: string) => void;
}) {
  return (
    <div className="wb-operation-list">
      {operations.map((operation) => {
        const listing = data.listings.find(
            (row) => row.id === operation.listing_id,
          ),
          item = data.inventory.find(
            (row) => row.id === operation.inventory_id,
          ),
          url = safeMarketplaceUrl(operation.deep_link, operation.marketplace);
        const mail = gmailOperationContext(operation, sources, data.attention);
        const verified = Boolean(
          operation.verification_id || operation.verification_observation_id,
        );
        return (
          <article className="wb-panel wb-operation-card" key={operation.id}>
            <div className="wb-operation-heading">
              <div>
                <p className="wb-eyebrow">
                  {operation.marketplace} ·{" "}
                  {data.accounts.find((row) => row.id === operation.account_id)
                    ?.username ||
                    data.accounts.find((row) => row.id === operation.account_id)
                      ?.account_alias ||
                    "Saved account"}
                </p>
                <h3>
                  {mail?.heading || (operation.adapter_key === "poshmark_private_reference_v1" ? "Add private tracker reference" : OPERATION_LABELS[operation.action]) || "Marketplace step"}
                </h3>
              </div>
              <span
                className={`wb-badge ${operation.state === "succeeded" && verified ? "wb-badge-green" : "wb-badge-amber"}`}
              >
                {operation.state === "succeeded" && !verified
                  ? "Completion needs proof review"
                  : stateLabels[operation.state]}
              </span>
            </div>
            {mail ? <section aria-label="Saved email context">
              <p><strong>{mail.titles.length ? 'Item named in email:' : 'Item not identified from this email.'}</strong>{mail.titles.length ? ` ${mail.titles.join('; ')}` : ''}{mail.additionalTitles > 0 ? `; ${mail.additionalTitles} more item names in the saved evidence` : ''}</p>
              <p className="wb-help">{mail.receivedAt ? <>Email received: <time dateTime={mail.receivedAt}>{new Date(mail.receivedAt).toLocaleString()}</time>. This is the email receipt time, not the sale time.</> : 'Email received time was not saved. No sale date is inferred.'}</p>
              <p><strong>Why review is needed:</strong> {mail.reason}</p>
              {mail.legacyComparison && <p className="wb-help">New parser details also need comparison with the retained historical source.</p>}
              {(item || listing) && <p className="wb-help">Current linked record: {item?.item_name || listing?.title}. The item name in the email is separate evidence.</p>}
            </section> : <p>
              {item?.item_name || listing?.title || 'Account-level evidence review'}
            </p>}
            <p className="wb-help">
              {modeLabels[operation.execution_mode]}. The saved mode describes
              the route; the next step and blockers show whether it can run.
            </p>
            {operation.next_step && (
              <div className="wb-operation-next">
                <h4>{operation.next_step.label}</h4>
                <p>{operation.next_step.explanation}</p>
              </div>
            )}
            {operation.blockers.length > 0 && (
              <ul className="wb-operation-blockers">
                {operation.blockers.map((blocker, index) => (
                  <li key={`${blocker.code}-${index}`}>{blocker.message}</li>
                ))}
              </ul>
            )}
            {operation.missing_fields.length > 0 && (
              <p>
                <strong>Details still needed:</strong>{" "}
                {operation.missing_fields.map(evidenceLabel).join(", ")}
              </p>
            )}
            {operation.state === "uncertain" && (
              <p className="wb-operation-warning">
                Check the original request’s result before starting another
                attempt. An unconfirmed response does not prove the marketplace
                did nothing.
              </p>
            )}
            {operation.last_error && (
              <p className="wb-operation-warning">{operation.last_error}</p>
            )}
            <div className="wb-operation-actions">
              {url && (
                <a
                  className="wb-button wb-button-secondary"
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open saved marketplace page ↗
                </a>
              )}
              {!["succeeded", "cancelled"].includes(operation.state) && (
                <button
                  className="wb-button wb-button-secondary"
                  onClick={() => onEvidence(operation)}
                >
                  Add evidence for checking
                </button>
              )}
              {operation.inventory_id && onItem && (
                <button
                  className="wb-text-button"
                  onClick={() => onItem(operation.inventory_id!)}
                >
                  Review physical item
                </button>
              )}
            </div>
            <details className="wb-operation-detail">
              <summary>Saved request, checkpoint and proof</summary>
              <p className="wb-help">
                Current listing details may differ from the target captured in
                this saved request.
              </p>
              <dl className="wb-definition-grid">
                <div className="wb-full">
                  <dt>Request</dt>
                  <dd>{operation.id}</dd>
                </div>
                <div>
                  <dt>Current linked listing ID</dt>
                  <dd>{listing?.external_listing_id || "Not supplied"}</dd>
                </div>
                <div>
                  <dt>Physical item</dt>
                  <dd>{operation.inventory_id || "Not matched"}</dd>
                </div>
                <div>
                  <dt>Checkpoint</dt>
                  <dd>
                    {operation.checkpoint?.step_key
                      ? evidenceLabel(operation.checkpoint.step_key)
                      : "No completed step saved"}
                  </dd>
                </div>
                <div>
                  <dt>Evidence submitted</dt>
                  <dd>
                    {operation.proposal_count} proposals · submission is not
                    proof
                  </dd>
                </div>
                <div className="wb-full">
                  <dt>Trusted verification</dt>
                  <dd>
                    {operation.verification_id ||
                      operation.verification_observation_id ||
                      "No verification recorded"}
                  </dd>
                </div>
              </dl>
            </details>
          </article>
        );
      })}
    </div>
  );
}
export function OperationEvidenceDialog({
  operation,
  sources,
  save,
  retry,
  onSaved,
  onClose,
}: {
  operation: ResaleOperation;
  sources: ResaleSourceRecord[];
  save: (id: string, input: OperationEvidenceProposal) => Promise<unknown>;
  retry: () => Promise<OperationRecovery>;
  onSaved: () => Promise<void>;
  onClose: () => void;
}) {
  const [query, setQuery] = useState(""),
    [selected, setSelected] = useState<string[]>([]),
    [note, setNote] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [recoveryNotice, setRecoveryNotice] = useState("");
  const rows = sources.filter(
    (row) =>
      row.account_id === operation.account_id &&
      (!query.trim() ||
        JSON.stringify([row.normalized, row.external_identifiers, row.id])
          .toLowerCase()
          .includes(query.trim().toLowerCase())),
  );
  const preview = process.env.NEXT_PUBLIC_APP_DEPLOYMENT_ENV === "preview";
  async function submit(isRetry: boolean) {
    if (busy || preview) return;
    setBusy(true);
    setError("");
    try {
      const input = { source_record_ids: selected, note: note.trim() };
      if (isRetry) {
        const recovered = await retry();
        await onSaved();
        if (
          operationRecoveryMatches(recovered, {
            kind: "evidence",
            operationId: operation.id,
            input,
          })
        )
          onClose();
        else
          setRecoveryNotice(
            "The earlier request was verified. Your current evidence selection and notes are still here.",
          );
        return;
      }
      await save(operation.id, input);
      await onSaved();
      onClose();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Evidence submission was not confirmed. Retry the pending request.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title="Add evidence for checking"
      onClose={onClose}
      busy={busy}
      wide
    >
      <div className="wb-note">
        <div>
          <strong>
            {operation.marketplace} · {operation.adapter_key === "poshmark_private_reference_v1" ? "Private tracker reference" : OPERATION_LABELS[operation.action]}
          </strong>
          <p>
            Attach saved source rows or explain what needs checking. This
            submits a proposal; it cannot complete the task, record a sale, or
            mark a listing removed.
          </p>
        </div>
      </div>
      {recoveryNotice && (
        <p className="wb-note" role="status">
          {recoveryNotice}
        </p>
      )}
      {error && (
        <div className="wb-alert" role="alert">
          <div>
            <p>{error}</p>
            <button
              className="wb-text-button"
              disabled={busy || preview}
              onClick={() => submit(true)}
            >
              Retry pending request
            </button>
          </div>
        </div>
      )}
      <form
        className="wb-operation-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit(false);
        }}
      >
        <fieldset disabled={busy}>
          <label className="wb-field">
            Find this shop’s source evidence
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Item name, order ID, source record…"
            />
          </label>
          <p>
            {selected.length} source rows selected · {rows.length} match this
            search
          </p>
          <div className="wb-evidence-options">
            {rows.slice(0, 20).map((row) => (
              <label key={row.id} className="wb-evidence-option">
                <input
                  type="checkbox"
                  checked={selected.includes(row.id)}
                  disabled={
                    !selected.includes(row.id) && selected.length >= 100
                  }
                  onChange={(event) =>
                    setSelected(
                      event.target.checked
                        ? [...selected, row.id]
                        : selected.filter((id) => id !== row.id),
                    )
                  }
                />
                <span>
                  <strong>
                    {String(
                      row.normalized.title ||
                        row.raw_business.Title ||
                        `Report row ${row.row_index ?? "unnumbered"}`,
                    )}
                  </strong>
                  <small>
                    {eventLabel(row)} · {row.record_status.replace(/_/g, " ")}
                  </small>
                  <small>Source ID: {row.id}</small>
                </span>
              </label>
            ))}
          </div>
          {rows.length > 20 && (
            <p className="wb-help">
              Showing the first 20 matches. Narrow the search to select a
              specific row.
            </p>
          )}
          <label className="wb-field">
            What should be checked?
            <textarea
              rows={4}
              maxLength={2000}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Describe the result or missing information. Do not include passwords or sign-in codes."
            />
          </label>
          <button
            className="wb-button wb-button-primary"
            disabled={preview || (!selected.length && !note.trim())}
          >
            {busy ? "Submitting…" : "Submit for verification"}
          </button>
        </fieldset>
      </form>
    </Dialog>
  );
}
export function OperationRequestDialog({
  context,
  data,
  save,
  retry,
  onSaved,
  onClose,
}: {
  context: { listing?: ResaleListing; source?: ResaleSourceRecord };
  data: ResaleWorkbench;
  save: (input: OperationIntent) => Promise<unknown>;
  retry: () => Promise<OperationRecovery>;
  onSaved: () => Promise<void>;
  onClose: () => void;
}) {
  const [action, setAction] = useState<OperationKind | "">(""),
    [note, setNote] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [recoveryNotice, setRecoveryNotice] = useState("");
  const accountId = context.listing?.account_id || context.source?.account_id,
    account = data.accounts.find((row) => row.id === accountId);
  const listing = context.listing,
    source = context.source,
    preview = process.env.NEXT_PUBLIC_APP_DEPLOYMENT_ENV === "preview";
  const choices: OperationKind[] = source
    ? ["reconcile_sale", "reconcile_cancellation", "reconcile_shipping"]
    : [
        "publish",
        "update",
        "delist",
        "reconcile_sale",
        "reconcile_cancellation",
        "reconcile_shipping",
      ];
  const item = data.inventory.find((row) => row.id === listing?.inventory_id);
  const outbound = (kind: OperationKind) =>
    ["publish", "update", "delist"].includes(kind);
  const allowed = (kind: OperationKind) =>
    !outbound(kind) ||
    (listing?.match_status === "confirmed" &&
      Boolean(item) &&
      (kind !== "delist" || Boolean(listing.external_listing_id)) &&
      (kind === "delist" ||
        (!item?.archived_at &&
          item?.status?.toLowerCase() !== "sold" &&
          isPreparedDraftCurrent(listing as PreparedListing))));
  async function submit(isRetry: boolean) {
    if (
      busy ||
      preview ||
      !account ||
      (!isRetry && (!action || !allowed(action)))
    )
      return;
    setBusy(true);
    setError("");
    try {
      const input: OperationIntent = {
        account_id: account.id,
        action: action as OperationKind,
        listing_id: listing?.id || null,
        inventory_id: listing?.inventory_id || null,
        expected_observation_id: listing?.observation_id || null,
        expected_item_version: listing?.inventory_id
          ? data.details.find(
              (row) => row.inventory_id === listing.inventory_id,
            )?.version || 0
          : null,
        ...(source
          ? { trigger: { kind: "source_record" as const, id: source.id } }
          : {}),
        requested: {
          note: note.trim(),
          ...(source
            ? {
                source_record_ids: [source.id],
                snapshot_ids: [source.snapshot_id],
              }
            : {}),
          ...(listing && outbound(action as OperationKind)
            ? { prepared_fields: listing.desired_fields, pricing_expectation: (() => { const pricing = data.pricing?.find((p) => p.listing_id === listing.id); return pricing ? capturePricingExpectation(pricing) : null; })() }
            : {}),
        },
      };
      if (isRetry) {
        const recovered = await retry();
        await onSaved();
        if (operationRecoveryMatches(recovered, { kind: "request", input }))
          onClose();
        else
          setRecoveryNotice(
            "The earlier request was verified. Your current step and notes are still here.",
          );
        return;
      }
      await save(input);
      await onSaved();
      onClose();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Request was not confirmed. Retry the pending request.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title="Request a shop step" onClose={onClose} busy={busy} wide>
      <div className="wb-note">
        <div>
          <strong>
            {account?.marketplace} ·{" "}
            {listing?.title ||
              String(source?.normalized.title || "Source evidence")}
          </strong>
          <p>
            {listing
              ? `Listing record: ${listing.id}`
              : `Source record: ${source?.id}`}
          </p>
          <p>
            This saves an exact request and shows what can happen next.
            Execution and proof depend on the connected workflow.
          </p>
        </div>
      </div>
      {recoveryNotice && (
        <p className="wb-note" role="status">
          {recoveryNotice}
        </p>
      )}
      {error && (
        <div className="wb-alert" role="alert">
          <div>
            <p>{error}</p>
            <button
              className="wb-text-button"
              disabled={busy || preview}
              onClick={() => submit(true)}
            >
              Retry pending request
            </button>
          </div>
        </div>
      )}
      <form
        className="wb-operation-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit(false);
        }}
      >
        <fieldset disabled={busy}>
          <label className="wb-field">
            Requested step
            <select
              aria-label="Requested step"
              value={action}
              onChange={(event) =>
                setAction(event.target.value as OperationKind)
              }
            >
              <option value="">Choose a step</option>
              {choices.map((kind) => (
                <option key={kind} value={kind} disabled={!allowed(kind)}>
                  {OPERATION_LABELS[kind]}
                  {!allowed(kind)
                    ? " · prepare current draft or review exact identity"
                    : ""}
                </option>
              ))}
            </select>
          </label>
          {action === "reconcile_cancellation" && (
            <p className="wb-help">
              This checks cancellation/refund evidence. It does not cancel an
              order, issue a refund or return physical stock automatically.
            </p>
          )}
          {action === "reconcile_shipping" && (
            <p className="wb-help">
              This checks shipping evidence. It does not buy or print a label.
            </p>
          )}
          {action === "reconcile_sale" && (
            <p className="wb-help">
              This checks an incoming sale. It does not add a second sale or
              assume which physical item was sold.
            </p>
          )}
          {(action === "publish" || action === "update") && listing && (
            <details className="wb-operation-detail" open>
              <summary>Prepared fields this request will use</summary>
              <EvidenceFields fields={listing.desired_fields} />
            </details>
          )}
          <label className="wb-field">
            Context for this request
            <textarea
              rows={4}
              maxLength={2000}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
          <button
            className="wb-button wb-button-primary"
            disabled={!action || !account || preview}
          >
            {busy ? "Saving request…" : "Save request & review next step"}
          </button>
        </fieldset>
      </form>
    </Dialog>
  );
}

export function OperationActivity({
  sources = [],
  operations,
  error,
  data,
  itemId,
  onClearItem,
  onEvidence,
  onItem,
}: {
  operations: ResaleOperation[];
  sources?: ResaleSourceRecord[];
  error: string;
  data: ResaleWorkbench;
  itemId: string;
  onClearItem: () => void;
  onEvidence: (operation: ResaleOperation) => void;
  onItem: (id: string) => void;
}) {
  const [marketplace, setMarketplace] = useState("all"),
    [includeFinished, setIncludeFinished] = useState(false),
    [limit, setLimit] = useState(20);
  const rows = operations.filter(
    (row) =>
      (!itemId || row.inventory_id === itemId) &&
      (marketplace === "all" ||
        row.marketplace.toLowerCase() === marketplace) &&
      (includeFinished || !["succeeded", "cancelled"].includes(row.state)),
  );
  const entries = groupGmailActivity(rows, sources, data.attention);
  if (error)
    return (
      <div className="wb-alert" role="alert">
        {error}
      </div>
    );
  return (
    <>
      <div className="wb-note">
        <div>
          <strong>Every shop step keeps its request and checked result</strong>
          <p>
            Requests stay visible while details, access or an executor are
            missing. Evidence submissions ask for a check; they do not mark work
            complete.
          </p>
        </div>
      </div>
      <GmailFeedSummary />
      <div className="wb-operation-filters">
        <label className="wb-field">
          Activity marketplace
          <select
            aria-label="Activity marketplace"
            value={marketplace}
            onChange={(event) => {
              setMarketplace(event.target.value);
              setLimit(20);
            }}
          >
            <option value="all">All shops</option>
            {Array.from(
              new Set(
                data.accounts.map((row) => row.marketplace.toLowerCase()),
              ),
            ).map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className="wb-checkbox">
          <input
            type="checkbox"
            checked={includeFinished}
            onChange={(event) => {
              setIncludeFinished(event.target.checked);
              setLimit(20);
            }}
          />
          Include finished requests
        </label>
      </div>
      {itemId && (
        <div className="wb-note">
          <span>
            Showing this item:{" "}
            {data.inventory.find((row) => row.id === itemId)?.item_name ||
              itemId}{" "}
            <button className="wb-text-button" onClick={onClearItem}>
              Show all items
            </button>
          </span>
        </div>
      )}
      <p className="wb-help" role="status">
        {rows.length} saved requests match these filters.
      </p>
      {entries.slice(0, limit).map(entry => entry.feedId ? (
        <section className="wb-panel wb-operation-card" key={entry.key} aria-label="Grouped Vinted notices">
          <p className="wb-eyebrow">Vinted · {data.accounts.find(account => account.id === entry.accountId)?.username || 'Saved account'}</p>
          <h3>Review unrecognized Vinted notices</h3>
          <p><strong>{entry.operations.length} saved notices</strong> need a supported format/account check.</p>
          <p className="wb-help">An unconfirmed greeting does not prove a different account. Each message remains saved and unresolved; this group does not confirm a sale or shipment.</p>
          <details className="wb-operation-detail">
            <summary>Show all {entry.operations.length} saved notices</summary>
            <OperationCards operations={entry.operations} sources={sources} data={data} onEvidence={onEvidence} onItem={onItem} />
          </details>
        </section>
      ) : <OperationCards key={entry.key} operations={entry.operations} sources={sources} data={data} onEvidence={onEvidence} onItem={onItem} />)}
      {!rows.length && (
        <section className="wb-panel wb-empty">
          <h2>No requests in this view.</h2>
          <p>
            Open a marketplace listing or source report row to request its next
            step. An empty queue does not establish that your shops are
            synchronized.
          </p>
        </section>
      )}
      {entries.length > limit && (
        <button
          className="wb-button wb-button-secondary"
          onClick={() => setLimit(limit + 20)}
        >
          Show more requests
        </button>
      )}
    </>
  );
}

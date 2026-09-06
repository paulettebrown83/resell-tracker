"use client";
import { useState } from "react";
import type { ResaleSourceRecord } from "@/lib/resale-contract";
import type { ResaleWorkbench } from "@/lib/resale-data";
import { dateLabel } from "@/lib/workbench";
import {
  isPreparedDraftCurrent,
  type PreparedListing,
} from "@/lib/resale-drafts";

export function eventLabel(
  row: Pick<
    ResaleSourceRecord,
    "event_precision" | "event_time" | "event_date" | "event_timezone"
  >,
) {
  if (row.event_precision === "instant" && row.event_time) {
    const instant = new Date(row.event_time);
    if (Number.isFinite(instant.getTime()))
      return `Event ${instant.toISOString().replace("T", " ").replace(".000Z", " UTC").replace(/Z$/, " UTC")}${row.event_timezone ? ` · source timezone: ${row.event_timezone}` : ""}`;
  }
  return row.event_date
    ? `Event ${dateLabel(row.event_date)} (time unknown)`
    : "Event date unknown";
}

export function evidenceLabel(key: string) {
  return key
    .replace(/^_/, "")
    .replace(/_/g, " ")
    .replace(/\b(id|sku|csv)\b/gi, (word) => word.toUpperCase())
    .replace(/^./, (letter) => letter.toUpperCase());
}
function EvidenceValue({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === "")
    return <span className="wb-unknown">Unknown / not supplied</span>;
  if (typeof value === "boolean") return <>{value ? "Yes" : "No"}</>;
  if (Array.isArray(value))
    return value.length ? (
      <ul>
        {value.map((entry, index) => (
          <li key={index}>
            <EvidenceValue value={entry} />
          </li>
        ))}
      </ul>
    ) : (
      <>None recorded</>
    );
  if (typeof value === "object")
    return <EvidenceFields fields={value as Record<string, unknown>} />;
  return <>{String(value)}</>;
}
export function EvidenceFields({
  fields,
}: {
  fields: Record<string, unknown>;
}) {
  return (
    <dl className="wb-evidence-fields">
      {Object.entries(fields).map(([key, value]) => (
        <div key={key}>
          <dt>{evidenceLabel(key)}</dt>
          <dd>
            <EvidenceValue value={value} />
          </dd>
        </div>
      ))}
    </dl>
  );
}
function rowTitle(row: ResaleSourceRecord) {
  for (const fields of [row.normalized, row.raw_business]) {
    for (const [key, value] of Object.entries(fields)) {
      if (
        /^(title|item[ _]?(title|name)|listing[ _]?(title|name))$/i.test(key) &&
        typeof value === "string" &&
        value.trim()
      )
        return value;
    }
  }
  return `${evidenceLabel(String(row.normalized.record_type || row.normalized.kind || row.source_kind))} · report row ${row.row_index ?? "unnumbered"}`;
}
function businessStatus(row: ResaleSourceRecord) {
  const fields = row.normalized;
  return [
    fields.status,
    fields.raw_status,
    fields.cancellation_status,
    fields.bundle_order === true ? "Bundle order" : null,
  ]
    .filter((value) => typeof value === "string" && value)
    .join(" · ");
}
export default function SourceReportBrowser({
  data,
  sources,
  onRequestCheck,
}: {
  data: ResaleWorkbench;
  sources: ResaleSourceRecord[];
  onRequestCheck?: (source: ResaleSourceRecord) => void;
}) {
  const [account, setAccount] = useState("all"),
    [report, setReport] = useState("all"),
    [query, setQuery] = useState(""),
    [review, setReview] = useState(false),
    [limit, setLimit] = useState(20);
  const reports = data.snapshots.filter(
    (snapshot) =>
      (account === "all" || snapshot.account_id === account) &&
      sources.some((row) => row.snapshot_id === snapshot.id),
  );
  const selected = data.snapshots.find((snapshot) => snapshot.id === report);
  const rows = sources.filter(
    (row) =>
      (account === "all" || row.account_id === account) &&
      (report === "all" || row.snapshot_id === report) &&
      (!review || row.record_status !== "accepted") &&
      (!query.trim() ||
        JSON.stringify([
          row.normalized,
          row.raw_business,
          row.external_identifiers,
          row.review_reason,
        ])
          .toLowerCase()
          .includes(query.trim().toLowerCase())),
  );
  return (
    <section
      className="wb-panel wb-listing-panel"
      aria-label="Imported report evidence"
    >
      <div className="wb-section-heading">
        <div>
          <h2>
            Imported report evidence{" "}
            <span className="wb-count">{sources.length}</span>
          </h2>
          <p>
            Report rows are evidence. They are not additional inventory or
            confirmed sales.
          </p>
        </div>
      </div>
      <div className="wb-report-filters">
        <label className="wb-field">
          Report marketplace
          <select
            value={account}
            onChange={(event) => {
              setAccount(event.target.value);
              setReport("all");
              setLimit(20);
            }}
          >
            <option value="all">All marketplaces</option>
            {data.accounts.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.marketplace} · {entry.username || entry.account_alias}
              </option>
            ))}
          </select>
        </label>
        <label className="wb-field">
          Report or capture
          <select
            value={report}
            onChange={(event) => {
              setReport(event.target.value);
              setLimit(20);
            }}
          >
            <option value="all">All reports · may overlap</option>
            {reports.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {
                  data.accounts.find((a) => a.id === entry.account_id)
                    ?.marketplace
                }{" "}
                · {dateLabel(entry.observed_at)} · {entry.scope}
              </option>
            ))}
          </select>
        </label>
        <label className="wb-field">
          Search report rows
          <input
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setLimit(20);
            }}
            placeholder="Item, order ID, bundle, cancelled…"
          />
        </label>
        <label className="wb-checkbox">
          <input
            type="checkbox"
            checked={review}
            onChange={(event) => {
              setReview(event.target.checked);
              setLimit(20);
            }}
          />
          Only rows needing review
        </label>
      </div>
      <div className="wb-note wb-report-context">
        <div>
          {selected ? (
            <>
              <strong>
                {selected.coverage === "complete"
                  ? "Complete within this capture’s scope"
                  : `${evidenceLabel(selected.coverage)} coverage`}
              </strong>
              <p>{selected.scope}</p>
              <p>
                Captured {dateLabel(selected.captured_at)} · observed{" "}
                {dateLabel(selected.observed_at)}
              </p>
            </>
          ) : (
            <>
              <strong>Keep each report’s limits in view</strong>
              <p>
                Reports can overlap. A complete file covers its stated period or
                filter; it does not establish full account history. Asking
                prices are not sale proceeds. Bundle amounts may apply to the
                whole order.
              </p>
            </>
          )}
        </div>
      </div>
      <p className="wb-report-result" role="status">
        {rows.length} report rows shown by these filters
      </p>
      {rows.slice(0, limit).map((row) => {
        const snapshot = data.snapshots.find(
          (entry) => entry.id === row.snapshot_id,
        );
        return (
          <article className="wb-report-row" key={row.id}>
            <div className="wb-report-row-heading">
              <h3>{rowTitle(row)}</h3>
              <span
                className={`wb-badge ${row.record_status === "accepted" ? "" : "wb-badge-amber"}`}
              >
                {row.record_status === "accepted"
                  ? "Parsed evidence"
                  : evidenceLabel(row.record_status)}
              </span>
            </div>
            <p>
              {data.accounts.find((entry) => entry.id === row.account_id)
                ?.marketplace || "Unknown marketplace"}{" "}
              · {evidenceLabel(row.source_kind)} · {eventLabel(row)}
            </p>
            {onRequestCheck && (
              <button
                className="wb-text-button"
                disabled={
                  process.env.NEXT_PUBLIC_APP_DEPLOYMENT_ENV === "preview"
                }
                onClick={() => onRequestCheck(row)}
              >
                Request an evidence check
              </button>
            )}
            {businessStatus(row) && (
              <p className="wb-report-status">{businessStatus(row)}</p>
            )}
            {row.review_reason && (
              <p className="wb-report-status">Review: {row.review_reason}</p>
            )}
            <details className="wb-report-details">
              <summary>Inspect report row and coverage</summary>
              <div className="wb-report-scope">
                <strong>
                  Source coverage: {snapshot?.coverage || "unknown"}
                </strong>
                <p>{snapshot?.scope || "Scope not recorded"}</p>
                <p>
                  Observed {dateLabel(row.source_observed_at)} · captured{" "}
                  {dateLabel(row.captured_at)}
                </p>
              </div>
              <h4>Recorded fields</h4>
              <p className="wb-help">
                Unknown values stay unknown. Fields labelled “cents” or “minor”
                use the currency’s smallest unit. Financial groups keep their
                original scope; do not add repeated order totals.
              </p>
              {Object.keys(row.normalized).length ? (
                <EvidenceFields fields={row.normalized} />
              ) : (
                <p>
                  No fields could be safely parsed. Review the original row
                  below.
                </p>
              )}
              <h4>Source identifiers</h4>
              {Object.keys(row.external_identifiers).length ? (
                <EvidenceFields fields={row.external_identifiers} />
              ) : (
                <p>No source identifiers supplied.</p>
              )}
              <details>
                <summary>Original report fields</summary>
                <EvidenceFields fields={row.raw_business} />
              </details>
              <p className="wb-help">Source record: {row.id}</p>
            </details>
          </article>
        );
      })}
      {!rows.length && (
        <div className="wb-empty">
          <h3>
            {sources.length
              ? "No report rows match these filters."
              : "No report evidence imported yet."}
          </h3>
          <p>
            Rows without listing IDs can still appear here when their source
            report is imported.
          </p>
        </div>
      )}
      {rows.length > limit && (
        <div className="wb-load-more">
          <button
            className="wb-button wb-button-secondary"
            onClick={() => setLimit(limit + 20)}
          >
            Show more report rows
          </button>
        </div>
      )}
    </section>
  );
}
export function LinkedItemListings({
  itemId,
  data,
  onReview,
}: {
  itemId: string;
  data: ResaleWorkbench | null;
  onReview: () => void;
}) {
  const listings =
    data?.listings.filter((listing) => listing.inventory_id === itemId) || [];
  return (
    <section className="wb-linked-listings">
      <h4>Marketplace listings for this item</h4>
      <p className="wb-help">
        One physical item can have several listings. Item facts and original
        photos are shared; each marketplace has its own price, status, and
        prepared copy.
      </p>
      {listings.map((listing) => (
        <article key={listing.id} className="wb-report-row">
          <h3>
            {data?.accounts.find((account) => account.id === listing.account_id)
              ?.marketplace || "Marketplace"}
          </h3>
          <p>{listing.title || "Title not recorded"}</p>
          <p>
            Asking price:{" "}
            {listing.asking_price == null
              ? "Unknown"
              : `${listing.asking_price.toFixed(2)} ${listing.currency || "(currency unknown)"}`}{" "}
            · observed {listing.observed_status}
          </p>
          <p>
            Checked {dateLabel(listing.observed_at)} · item match{" "}
            {listing.match_status}
          </p>
          {(listing as PreparedListing).draft_version > 0 &&
            !isPreparedDraftCurrent(listing as PreparedListing) && (
              <p className="wb-alert">
                This preparation belongs to an earlier item link. Do not reuse
                its copy or photos without review.
              </p>
            )}
          {Object.keys(listing.desired_fields).length > 0 && (
            <details>
              <summary>
                Saved marketplace preparation · not proof of publishing
              </summary>
              <EvidenceFields fields={listing.desired_fields} />
            </details>
          )}
        </article>
      ))}
      {!listings.length && (
        <p>
          No listing has been linked to this physical item yet. Historical tags
          alone do not confirm a match.
        </p>
      )}
      <button className="wb-button wb-button-secondary" onClick={onReview}>
        Review marketplace records & matches
      </button>
    </section>
  );
}

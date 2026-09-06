"use client";
import { useState } from "react";
import ListingPricingState from "./ListingPricingState";
import Icon from "./WorkbenchIcon";
import ListingMatchDialog from "./ListingMatchDialog";
import SourceReportBrowser, { EvidenceFields } from "./SourceReportBrowser";
import {
  saveMatchWithRetry,
  retryPendingMatch,
  type ConfirmMatch,
} from "@/lib/resale-match-retry";
import type { ResaleListing } from "@/lib/resale-contract";
import type { ResaleSourceRecord } from "@/lib/resale-contract";
import type { ResaleWorkbench } from "@/lib/resale-data";
import type { InventoryItem, Sale } from "@/lib/supabase";
import {
  MARKETPLACES,
  dateLabel,
  needsSaleReview,
  OPERATION_LABELS,
} from "@/lib/workbench";
export function safeMarketplaceUrl(raw: string | null, marketplace: string) {
  if (!raw) return null;
  const hosts: Record<string, string[]> = {
    poshmark: ["poshmark.com", "poshmark.ca"],
    mercari: ["mercari.com"],
    depop: ["depop.com"],
    vinted: ["vinted.com", "vinted.co.uk"],
    ebay: ["ebay.com"],
  };
  try {
    const url = new URL(raw);
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      hosts[marketplace.toLowerCase()]?.some(
        (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
      )
      ? url.href
      : null;
  } catch {
    return null;
  }
}
export function MarketplaceViews({
  data,
  sources,
  onInventory,
  confirmMatch,
  onChanged,
  onRequestListing,
  onRequestSource,
  requestsUnavailable,
}: {
  data: ResaleWorkbench;
  sources: ResaleSourceRecord[];
  onInventory: (platform: string) => void;
  confirmMatch?: ConfirmMatch;
  onChanged: () => Promise<void>;
  onRequestListing?: (listing: ResaleListing) => void;
  onRequestSource?: (source: ResaleSourceRecord) => void;
  requestsUnavailable?: boolean;
}) {
  const [matching, setMatching] = useState<ResaleListing | null>(null);
  const [platform, setPlatform] = useState("all"),
    [limit, setLimit] = useState(20);
  const listings = data.listings.filter(
    (listing) =>
      platform === "all" ||
      data.accounts
        .find((account) => account.id === listing.account_id)
        ?.marketplace.toLowerCase() === platform.toLowerCase(),
  );
  const platforms = Array.from(
    new Set([
      ...MARKETPLACES,
      ...data.accounts
        .map((a) => a.marketplace)
        .filter(
          (p) =>
            !MARKETPLACES.some(
              (known) => known.toLowerCase() === p.toLowerCase(),
            ),
        ),
    ]),
  );
  return (
    <>
      {requestsUnavailable && (
        <div className="wb-alert" role="alert">
          Shop request status is unavailable. Refresh records before creating
          another request.
        </div>
      )}
      <div className="wb-note wb-market-notice">
        <Icon name="attention" size={22} />
        <div>
          <strong>Observed status, with the date it was checked</strong>
          <p>
            Inventory tags are historical claims. Observations are evidence from
            a specific check, not a live feed. An inactive Poshmark listing may
            still be purchasable.
          </p>
        </div>
      </div>
      <div className="wb-marketplace-grid">
        {platforms.map((name) => {
          const accounts = data.accounts.filter(
            (a) => a.marketplace.toLowerCase() === name.toLowerCase(),
          );
          const ids = new Set(accounts.map((a) => a.id)),
            stored = data.listings.filter((l) => ids.has(l.account_id));
          const snapshots = data.snapshots
            .filter((s) => ids.has(s.account_id))
            .sort((a, b) => b.observed_at.localeCompare(a.observed_at));
          return (
            <section className="wb-panel wb-marketplace-card" key={name}>
              <div className="wb-marketplace-card-heading">
                <span
                  className={`wb-market-logo wb-logo-${name.toLowerCase()}`}
                >
                  {name.slice(0, 1)}
                </span>
                <span className="wb-badge">
                  {accounts.length
                    ? Array.from(
                        new Set(
                          accounts.map(
                            (a) =>
                              ({
                                connected: "Connection recorded",
                                manual: "Manual access",
                                unverified: "Access unverified",
                                expired: "Access expired",
                                blocked: "Access blocked",
                              })[a.connection_status],
                          ),
                        ),
                      ).join(" · ")
                    : "No account linked"}
                </span>
              </div>
              <h2>{name}</h2>
              <div className="wb-marketplace-count">
                <strong>
                  {
                    stored.filter((listing) => listing.observed_at !== null)
                      .length
                  }
                </strong>
                <span>observed imported listings · not a live total</span>
              </div>
              {!stored.length &&
                sources.some((row) => ids.has(row.account_id)) && (
                  <p className="wb-help">
                    Report rows are available below. No stable listing
                    identities have been imported.
                  </p>
                )}
              {stored.some((listing) => listing.observed_at === null) && (
                <p className="wb-help">
                  {
                    stored.filter((listing) => listing.observed_at === null)
                      .length
                  }{" "}
                  local listing records · not yet observed
                </p>
              )}
              <p className="wb-source-count">
                <strong>
                  {sources.filter((row) => ids.has(row.account_id)).length}
                </strong>{" "}
                imported report rows
              </p>
              <dl>
                <div>
                  <dt>Account</dt>
                  <dd>
                    {accounts
                      .map((a) => a.username || a.account_alias)
                      .join(", ") || "Not linked"}
                  </dd>
                </div>
                <div>
                  <dt>Last capture</dt>
                  <dd>
                    {snapshots[0]
                      ? dateLabel(snapshots[0].observed_at)
                      : "Not checked"}
                  </dd>
                </div>
                <div>
                  <dt>Capture coverage</dt>
                  <dd>{snapshots[0]?.coverage || "Unknown"}</dd>
                </div>
                {snapshots[0] && (
                  <div>
                    <dt>Capture scope</dt>
                    <dd>{snapshots[0].scope}</dd>
                  </div>
                )}
              </dl>
              <button
                className="wb-button wb-button-secondary"
                onClick={() => {
                  setPlatform(name);
                  setLimit(20);
                }}
              >
                Review listing records <Icon name="arrow" size={16} />
              </button>
              <button
                className="wb-text-button"
                onClick={() => onInventory(name)}
              >
                View historical item tags
              </button>
            </section>
          );
        })}
      </div>
      <SourceReportBrowser
        data={data}
        sources={sources}
        onRequestCheck={requestsUnavailable ? undefined : onRequestSource}
      />
      <section className="wb-panel wb-listing-panel">
        <div className="wb-section-heading">
          <div>
            <h2>
              Listings & local drafts{" "}
              <span className="wb-count">{listings.length}</span>
            </h2>
            <p>
              Unmatched records remain separate until the item is confirmed.
            </p>
          </div>
          <label className="wb-filter">
            <span className="wb-sr-only">Listing marketplace</span>
            <select
              value={platform}
              onChange={(event) => {
                setPlatform(event.target.value);
                setLimit(20);
              }}
            >
              <option value="all">All marketplaces</option>
              {platforms.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </label>
        </div>
        {listings.length ? (
          listings.slice(0, limit).map((listing) => {
            const account = data.accounts.find(
                (a) => a.id === listing.account_id,
              ),
              url = safeMarketplaceUrl(
                listing.listing_url,
                account?.marketplace || "",
              );
            return (
              <article className="wb-listing-row" key={listing.id}>
                <div>
                  <h3>{listing.title || "Untitled listing record"}</h3>
                  <ListingPricingState pricing={data.pricing?.find((p) => p.listing_id === listing.id)} externalListingId={listing.external_listing_id} />
                  <p>
                    {account?.marketplace || "Unknown marketplace"} ·{" "}
                    {account?.username ||
                      account?.account_alias ||
                      "Account not recorded"}
                  </p>
                  <div className="wb-detail-platforms">
                    <span className="wb-badge">
                      {listing.observed_at
                        ? `Observed: ${listing.observed_status}`
                        : "Not observed on marketplace"}
                    </span>
                    <span
                      className={`wb-badge ${listing.match_status === "confirmed" ? "wb-badge-green" : "wb-badge-amber"}`}
                    >
                      {listing.match_status === "confirmed"
                        ? "Item match confirmed"
                        : `Item match ${listing.match_status}`}
                    </span>
                  </div>
                  <p>
                    Checked{" "}
                    {listing.observed_at
                      ? new Date(listing.observed_at).toLocaleString()
                      : "at an unknown time"}
                  </p>
                </div>
                <div>
                  {url && (
                    <a
                      className="wb-button wb-button-secondary"
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Open marketplace ↗
                    </a>
                  )}
                  {onRequestListing && (
                    <button
                      className="wb-button wb-button-secondary"
                      disabled={
                        requestsUnavailable ||
                        process.env.NEXT_PUBLIC_APP_DEPLOYMENT_ENV === "preview"
                      }
                      onClick={() => onRequestListing(listing)}
                    >
                      Request a shop step
                    </button>
                  )}
                  {confirmMatch && (
                    <button
                      className="wb-button wb-button-secondary"
                      disabled={
                        process.env.NEXT_PUBLIC_APP_DEPLOYMENT_ENV === "preview"
                      }
                      onClick={() => setMatching(listing)}
                    >
                      {listing.match_status === "confirmed"
                        ? "Review item match"
                        : "Match to inventory"}
                    </button>
                  )}
                  {Object.keys(listing.external_identifiers).length > 0 && (
                    <details className="wb-listing-identifiers">
                      <summary>Other source identifiers</summary>
                      <EvidenceFields fields={listing.external_identifiers} />
                    </details>
                  )}
                  <span className="wb-input-help">
                    Listing ID: {listing.external_listing_id || "Not recorded"}
                  </span>
                </div>
              </article>
            );
          })
        ) : (
          <div className="wb-empty">
            <span className="wb-empty-icon">
              <Icon name="store" size={30} />
            </span>
            <h3>No listing observations here yet.</h3>
            <p>
              Verified marketplace evidence will appear here. Nothing is
              inferred from an item’s title or old platform tags.
            </p>
          </div>
        )}
        {listings.length > limit && (
          <div className="wb-load-more">
            <button
              className="wb-button wb-button-secondary"
              onClick={() => setLimit(limit + 20)}
            >
              Show more listing records
            </button>
          </div>
        )}
      </section>
      {matching && confirmMatch && (
        <ListingMatchDialog
          listing={matching}
          marketplace={
            data.accounts.find((account) => account.id === matching.account_id)
              ?.marketplace || "Marketplace"
          }
          inventory={data.inventory.map((item) => ({
            ...item,
            platforms: item.platforms || [],
          }))}
          save={(input) => saveMatchWithRetry(input, confirmMatch)}
          retry={() => retryPendingMatch(confirmMatch)}
          onSaved={onChanged}
          onClose={() => setMatching(null)}
        />
      )}
    </>
  );
}
export function AttentionView({
  data,
  sources,
  inventory,
  sales,
  onInventory,
  onSales,
  onItem,
}: {
  data: ResaleWorkbench;
  sources: ResaleSourceRecord[];
  inventory: InventoryItem[];
  sales: Sale[];
  onInventory: () => void;
  onSales: () => void;
  onItem: (item: InventoryItem) => void;
}) {
  const [limit, setLimit] = useState(20);
  const sourceReview = sources.filter(
    (row) => row.record_status !== "accepted",
  );
  const review = data.attention.filter((row) => row.state === "open"),
    actions = data.actions.filter((row) =>
      ["blocked", "failed", "uncertain"].includes(row.state),
    );
  const incomplete = inventory.filter((item) => {
    const detail = data.details.find((d) => d.inventory_id === item.id);
    return (
      !detail ||
      detail.workflow === "draft" ||
      detail.workflow === "needs_details" ||
      item.item_cost == null
    );
  });
  return (
    <>
      <div className="wb-attention-grid">
        <section className="wb-panel wb-attention-card">
          <span className="wb-attention-icon">
            <Icon name="tag" size={25} />
          </span>
          <span className="wb-attention-total">{incomplete.length}</span>
          <h2>Finish item details</h2>
          <p>
            Drafts, missing details, and unknown costs. Review the original item
            before preparing listings.
          </p>
          <button
            className="wb-button wb-button-secondary"
            onClick={onInventory}
          >
            Review inventory <Icon name="arrow" size={16} />
          </button>
        </section>
        <section className="wb-panel wb-attention-card">
          <span className="wb-attention-icon">
            <Icon name="receipt" size={25} />
          </span>
          <span className="wb-attention-total">
            {sales.filter(needsSaleReview).length}
          </span>
          <h2>Verify sale amounts</h2>
          <p>
            Historical or missing amounts need a check against the marketplace
            statement.
          </p>
          <button className="wb-button wb-button-secondary" onClick={onSales}>
            Review sales <Icon name="arrow" size={16} />
          </button>
        </section>
      </div>
      <section className="wb-panel wb-listing-panel">
        <div className="wb-section-heading">
          <div>
            <h2>
              Review queue{" "}
              <span className="wb-count">
                {review.length + actions.length + sourceReview.length}
              </span>
            </h2>
            <p>
              Evidence conflicts and marketplace actions that need a person.
            </p>
          </div>
        </div>
        {review.slice(0, limit).map((row) => (
          <article className="wb-listing-row" key={row.id}>
            <div>
              <span className="wb-badge wb-badge-amber">Needs review</span>
              <h3>{row.reason}</h3>
              <p>Recorded {dateLabel(row.created_at)}</p>
              <details className="wb-evidence">
                <summary>Evidence details</summary>
                <pre>{JSON.stringify(row.evidence, null, 2)}</pre>
              </details>
            </div>
            {inventory.some((item) => item.id === row.inventory_id) && (
              <button
                className="wb-button wb-button-secondary"
                onClick={() =>
                  onItem(
                    inventory.find((item) => item.id === row.inventory_id)!,
                  )
                }
              >
                Review item
              </button>
            )}
          </article>
        ))}
        {actions.slice(0, limit).map((row) => (
          <article className="wb-listing-row" key={row.id}>
            <div>
              <span className="wb-badge wb-badge-amber">{row.state}</span>
              <h3>{OPERATION_LABELS[row.action] || "Marketplace step"}</h3>
              <p>{row.reason}</p>
              <p>
                {row.last_error ||
                  "The marketplace result has not been confirmed."}
              </p>
              <small>Action ID: {row.id}</small>
            </div>
          </article>
        ))}
        {sourceReview.slice(0, limit).map((row) => (
          <article className="wb-listing-row" key={row.id}>
            <div>
              <span className="wb-badge wb-badge-amber">
                {row.record_status === "quarantined"
                  ? "Report row quarantined"
                  : "Report row needs review"}
              </span>
              <h3>
                {row.review_reason || "Imported evidence needs a closer look"}
              </h3>
              <p>
                {data.accounts.find((account) => account.id === row.account_id)
                  ?.marketplace || "Marketplace report"}{" "}
                · Row {row.row_index ?? "unknown"}
              </p>
              <small>Source record ID: {row.id}</small>
            </div>
          </article>
        ))}
        {!review.length && !actions.length && !sourceReview.length && (
          <div className="wb-empty">
            <span className="wb-empty-icon">
              <Icon name="check" size={28} />
            </span>
            <h3>No open review cases.</h3>
            <p>
              This does not prove marketplace listings are current. It means
              there are no open cases in the saved review queue.
            </p>
          </div>
        )}
        {(review.length > limit ||
          actions.length > limit ||
          sourceReview.length > limit) && (
          <div className="wb-load-more">
            <button
              className="wb-button wb-button-secondary"
              onClick={() => setLimit(limit + 20)}
            >
              Show more cases
            </button>
          </div>
        )}
      </section>
    </>
  );
}

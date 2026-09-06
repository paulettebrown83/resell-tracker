"use client";
import { useState } from "react";
import Dialog from "./WorkbenchDialog";
import type { InventoryItem } from "@/lib/supabase";
import type { ResaleListing } from "@/lib/resale-contract";
import { money } from "@/lib/workbench";
import type { MatchConfirmation as MatchInput } from "@/lib/resale-match-retry";
export default function ListingMatchDialog({
  listing,
  marketplace,
  inventory,
  save,
  retry,
  onSaved,
  onClose,
}: {
  listing: ResaleListing;
  marketplace: string;
  inventory: InventoryItem[];
  save: (input: MatchInput) => Promise<unknown>;
  retry: () => Promise<unknown>;
  onSaved: () => Promise<void>;
  onClose: () => void;
}) {
  const [search, setSearch] = useState(""),
    [selected, setSelected] = useState(""),
    [reason, setReason] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const choices = inventory.filter(
    (item) =>
      !item.archived_at &&
      item.status?.toLowerCase() !== "sold" &&
      `${item.item_name} ${item.id}`
        .toLowerCase()
        .includes(search.trim().toLowerCase()),
  );
  const item = inventory.find((row) => row.id === selected);
  const preview = process.env.NEXT_PUBLIC_APP_DEPLOYMENT_ENV === "preview";
  async function commit(isRetry: boolean) {
    if (busy || preview) return;
    setBusy(true);
    setError("");
    try {
      if (isRetry) await retry();
      else
        await save({
          listingId: listing.id,
          inventoryId: selected,
          expectedObservationId: listing.observation_id,
          expectedInventoryId: listing.inventory_id,
          expectedMatchStatus: listing.match_status,
          reason: reason.trim(),
        });
      await onSaved();
      onClose();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The match was not confirmed. Retry the pending match before choosing another item.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title="Match listing to inventory"
      onClose={onClose}
      busy={busy}
      wide
    >
      <div className="wb-note">
        <div>
          <strong>{listing.title || "Untitled listing record"}</strong>
          <p>
            {marketplace} · Listing ID:{" "}
            {listing.external_listing_id || "Not recorded"}
          </p>
          <p>
            This links two saved records. It does not publish or remove anything
            on the marketplace.
          </p>
        </div>
      </div>
      {error && (
        <div className="wb-alert" role="alert">
          <div>
            <p>{error}</p>
            <button
              className="wb-text-button"
              onClick={() => commit(true)}
              disabled={busy || preview}
            >
              Retry pending match
            </button>
          </div>
        </div>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void commit(false);
        }}
      >
        <fieldset className="wb-fieldset" disabled={busy || preview}>
          <label className="wb-field">
            Find the inventory item
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search by item name or ID"
            />
          </label>
          <fieldset className="wb-match-options">
            <legend>Choose the item you have confirmed is the same</legend>
            {choices.slice(0, 20).map((row) => (
              <label
                key={row.id}
                className={selected === row.id ? "is-selected" : ""}
              >
                <input
                  type="radio"
                  name="matched-inventory"
                  value={row.id}
                  checked={selected === row.id}
                  onChange={() => setSelected(row.id)}
                />
                <span>
                  <strong>{row.item_name}</strong>
                  <small>
                    {row.id} · Cost: {money(row.item_cost)}
                  </small>
                </span>
              </label>
            ))}
            {!choices.length && <p>No available items match this search.</p>}
            {choices.length > 20 && (
              <p>
                {choices.length} matches. Narrow your search to see the right
                item.
              </p>
            )}
          </fieldset>
          {item && (
            <div className="wb-note">
              <p>
                Selected: <strong>{item.item_name}</strong>
                <br />
                Item ID: {item.id}
              </p>
            </div>
          )}
          <label className="wb-field">
            How did you confirm the match?
            <textarea
              required
              rows={3}
              maxLength={2000}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="e.g., I checked the item reference and photos against this listing."
            />
            <small>
              A matching title by itself is not enough. This reason stays with
              the match history.
            </small>
          </label>
          <div className="wb-form-actions">
            <button
              className="wb-button wb-button-primary"
              disabled={!selected || !reason.trim()}
            >
              {busy ? "Saving match…" : "Confirm this item match"}
            </button>
            <button
              className="wb-button wb-button-secondary"
              type="button"
              onClick={onClose}
            >
              Cancel
            </button>
          </div>
        </fieldset>
      </form>
    </Dialog>
  );
}

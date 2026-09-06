"use client";
import { useRef, useState } from "react";
import Dialog from "./WorkbenchDialog";
import PoshmarkPackage from "./PoshmarkPackage";
import type { InventoryItem } from "@/lib/supabase";
import type { ResaleWorkbench } from "@/lib/resale-data";
import {
  isPreparedDraftCurrent,
  type ListingDraftInput,
  type PreparedListing,
} from "@/lib/resale-drafts";
import {
  PLATFORM_GUIDANCE,
  LISTING_RULES_VERSION,
  validateListingDraft,
  resolveDraftFields,
  type DraftFields,
  type DraftChannel,
  type Marketplace,
  type WritingPreferences,
} from "@/lib/listing-guidance";
import { money, localDate } from "@/lib/workbench";

type DraftSession = {
  base: DraftFields;
  fields: DraftFields;
  preferences: WritingPreferences;
  channel: DraftChannel;
  listing?: PreparedListing;
};
export function manualDraftOverrides(
  base: DraftFields,
  fields: DraftFields,
): Partial<DraftFields> {
  return Object.fromEntries(
    Object.entries(fields).filter(
      ([key, value]) =>
        JSON.stringify(value) !==
        JSON.stringify(base[key as keyof DraftFields]),
    ),
  ) as Partial<DraftFields>;
}
export default function ListingDraftDialog({
  item,
  data,
  save,
  retry,
  onSaved,
  onClose,
}: {
  item: InventoryItem;
  data: ResaleWorkbench;
  save: (input: ListingDraftInput) => Promise<unknown>;
  retry: () => Promise<PreparedListing>;
  onSaved: () => Promise<void>;
  onClose: () => void;
}) {
  const [accountId, setAccountId] = useState(""),
    [listingId, setListingId] = useState(""),
    [session, setSession] = useState<DraftSession | null>(null),
    [error, setError] = useState(""),
    [recoveryNotice, setRecoveryNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const account = data.accounts.find((row) => row.id === accountId);
  const marketplace = account?.marketplace.toLowerCase() as
    | Marketplace
    | undefined;
  const guidance = marketplace ? PLATFORM_GUIDANCE[marketplace] : undefined;
  const existing = data.listings.filter(
    (row) =>
      row.account_id === accountId &&
      row.inventory_id === item.id &&
      row.match_status === "confirmed",
  ) as PreparedListing[];
  const selected = existing.find((row) => row.id === listingId);
  const stale =
    selected && selected.draft_version > 0 && !isPreparedDraftCurrent(selected);
  const detail = data.details.find((row) => row.inventory_id === item.id);
  const originals = data.media.filter(
    (row) =>
      row.inventory_id === item.id &&
      row.kind === "original" &&
      row.state === "ready",
  );
  const preview = process.env.NEXT_PUBLIC_APP_DEPLOYMENT_ENV === "preview";
  const validation =
    session && marketplace
      ? validateListingDraft(
          marketplace,
          session.fields,
          { channel: session.channel, market: "US", today: localDate() },
          session.preferences,
        )
      : null;
  function begin() {
    if (!account || !guidance || !listingId || stale) return;
    const base: DraftFields = selected?.draft_context?.fields ||
      (selected && Object.keys(selected.desired_fields).length
        ? (selected.desired_fields as DraftFields)
        : undefined) || {
        title: marketplace === "depop" ? null : item.item_name,
        description: detail?.description || null,
        price: null,
        currency: null,
        category_id: null,
        category_label: detail?.category || null,
        condition: detail?.condition || null,
        size: detail?.size || null,
        media_ids: [],
        attributes: Object.fromEntries(
          ["brand", "color", "material", "sku"].flatMap((key) => {
            const value =
              detail?.[key as "brand" | "color" | "material" | "sku"];
            return value ? [[key, value]] : [];
          }),
        ),
        shipping: {},
      };
    setSession({
      base,
      fields: resolveDraftFields(
        base,
        selected?.draft_context?.overrides || {},
      ),
      preferences: selected?.draft_context?.preferences || {},
      channel: selected?.draft_context?.channel || "consumer",
      listing: selected,
    });
    setError("");
  }
  function change<K extends keyof DraftFields>(key: K, value: DraftFields[K]) {
    setSession((current) =>
      current
        ? { ...current, fields: { ...current.fields, [key]: value } }
        : null,
    );
  }
  async function commit(isRetry: boolean) {
    if (
      lock.current ||
      preview ||
      !session ||
      !account ||
      (!isRetry && !validation?.draft_save_allowed)
    )
      return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      if (isRetry) {
        const recovered = await retry();
        // Recovery belongs to the account, and may concern another open draft.
        // Never close or replace current copy just because that older save succeeded.
        setSession((current) => {
          if (
            !current ||
            recovered.account_id !== account.id ||
            recovered.inventory_id !== item.id
          )
            return current;
          const sameRecord = current.listing
            ? current.listing.id === recovered.id
            : recovered.external_listing_id === null;
          return sameRecord ? { ...current, listing: recovered } : current;
        });
        setRecoveryNotice(
          "The pending save was verified. Your open draft and current edits are still here; review them before saving.",
        );
        await onSaved();
        return;
      }
      await save({
        ...(session.listing ? { listing_id: session.listing.id } : {}),
        account_id: account.id,
        inventory_id: item.id,
        expected_version: session.listing?.draft_version || 0,
        channel: session.channel,
        rules_version: LISTING_RULES_VERSION,
        fields: session.base,
        preferences: session.preferences,
        overrides: manualDraftOverrides(session.base, session.fields),
      });
      await onSaved();
      onClose();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The draft save was not confirmed. Retry the pending draft.",
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <Dialog
      title="Prepare a marketplace draft"
      onClose={onClose}
      busy={busy}
      wide
    >
      <div className="wb-note">
        <div>
          <strong>{item.item_name}</strong>
          <p>One physical item · {item.id}</p>
          <p>
            Shared cost: {money(item.item_cost)}. This cost is separate from
            each shop’s asking price.
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
              onClick={() => commit(true)}
            >
              Retry pending draft save
            </button>
          </div>
        </div>
      )}
      {!session ? (
        <div className="wb-draft-setup">
          <p>
            Choose the shop and the listing record this preparation belongs to.
          </p>
          <label className="wb-field">
            Marketplace account
            <select
              aria-label="Marketplace account"
              value={accountId}
              onChange={(event) => {
                setAccountId(event.target.value);
                setListingId("");
              }}
            >
              <option value="">Choose a shop</option>
              {data.accounts.map((row) => (
                <option value={row.id} key={row.id}>
                  {row.marketplace} · {row.username || row.account_alias}
                </option>
              ))}
            </select>
          </label>
          <label className="wb-field">
            Listing record
            <select
              aria-label="Listing record"
              value={listingId}
              disabled={!guidance}
              onChange={(event) => setListingId(event.target.value)}
            >
              <option value="">Choose a record</option>
              <option
                value="new"
                disabled={existing.some((row) => !row.external_listing_id)}
              >
                Create a new local draft
                {existing.some((row) => !row.external_listing_id)
                  ? " (one already exists)"
                  : ""}
              </option>
              {existing.map((row) => (
                <option value={row.id} key={row.id}>
                  {row.title || "Untitled record"} ·{" "}
                  {row.external_listing_id || "local draft"} · version{" "}
                  {row.draft_version || 0}
                </option>
              ))}
            </select>
          </label>
          {account && !guidance && (
            <p>Guidance for this marketplace has not been prepared yet.</p>
          )}
          {!data.accounts.length && (
            <p>
              No marketplace account is recorded yet. Add or verify the account
              before preparing its listing.
            </p>
          )}
          {stale && (
            <div className="wb-alert" role="alert">
              This draft was prepared for a different item link. Review the
              match and original copy before preparing a replacement for this
              item.
            </div>
          )}
          <p className="wb-help">
            Only confirmed item links appear here. Unmatched imports must be
            reviewed in Marketplaces first. A new local draft is not a new
            published listing.
          </p>
          {marketplace === "poshmark" && selected && selected.draft_version > 0 && !selected.external_listing_id && !stale && (
            <PoshmarkPackage key={selected.id} listing={selected} disabled={preview} />
          )}
          <button
            className="wb-button wb-button-primary"
            disabled={!listingId || !guidance || Boolean(stale)}
            onClick={begin}
          >
            Prepare for this shop
          </button>
        </div>
      ) : (
        <form
          className="wb-draft-form"
          onSubmit={(event) => {
            event.preventDefault();
            void commit(false);
          }}
        >
          <fieldset disabled={busy}>
            <legend>
              {account?.marketplace} ·{" "}
              {session.listing ? "Edit saved preparation" : "New local draft"}
            </legend>
            <p className="wb-help">
              Save incomplete work here. Publishing and marketplace verification
              are separate steps.
            </p>
            <details className="wb-draft-guidance">
              <summary>Shop guidance and facts still to verify</summary>
              <p>{guidance?.preparation.join(" ")}</p>
              <p>Guidance version {LISTING_RULES_VERSION} · US account scope</p>
              {guidance?.rules
                .filter((rule) => rule.channels.includes(session.channel))
                .map((rule) => (
                  <p key={rule.id}>
                    {rule.field.replace(/_/g, " ")}: recorded maximum{" "}
                    {rule.maximum} · {rule.confidence}{" "}
                    {rule.source.retrieved_at}. {rule.note}
                  </p>
                ))}
              <ul>
                {guidance?.unknowns.map((text) => (
                  <li key={text}>{text}</li>
                ))}
              </ul>
            </details>
            <label className="wb-field">
              Preparation format
              <select
                aria-label="Preparation format"
                value={session.channel}
                onChange={(event) =>
                  setSession({
                    ...session,
                    channel: event.target.value as DraftChannel,
                  })
                }
              >
                <option value="consumer">Marketplace editor</option>
                <option value="bulk">Bulk file</option>
                <option value="api">API fields</option>
              </select>
              <span className="wb-input-help">
                Rules can differ by format. This choice does not confirm account
                access to that format.
              </span>
            </label>
            {marketplace !== "depop" && (
              <label className="wb-field">
                Prepared title
                <input
                  value={session.fields.title || ""}
                  onChange={(event) =>
                    change("title", event.target.value || null)
                  }
                />
              </label>
            )}
            <label className="wb-field">
              Prepared description
              <textarea
                rows={6}
                value={session.fields.description || ""}
                onChange={(event) =>
                  change("description", event.target.value || null)
                }
              />
              <span className="wb-input-help">
                Use known facts. Measurements, flaws and materials should come
                from the item, not guesses.
              </span>
            </label>
            <div className="wb-field-grid">
              <label className="wb-field">
                Proposed asking price
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={session.fields.price ?? ""}
                  onChange={(event) =>
                    change(
                      "price",
                      event.target.value === ""
                        ? null
                        : Number(event.target.value),
                    )
                  }
                />
              </label>
              <label className="wb-field">
                Currency
                <input
                  placeholder="USD, or leave unknown"
                  maxLength={3}
                  value={session.fields.currency || ""}
                  onChange={(event) =>
                    change("currency", event.target.value.toUpperCase() || null)
                  }
                />
              </label>
            </div>
            <div className="wb-field-grid">
              <label className="wb-field">
                Marketplace condition
                <input
                  value={session.fields.condition || ""}
                  onChange={(event) =>
                    change("condition", event.target.value || null)
                  }
                />
              </label>
              <label className="wb-field">
                Marketplace size
                <input
                  value={session.fields.size || ""}
                  onChange={(event) =>
                    change("size", event.target.value || null)
                  }
                />
              </label>
              <label className="wb-field">
                Category label
                <input
                  value={session.fields.category_label || ""}
                  onChange={(event) =>
                    change("category_label", event.target.value || null)
                  }
                />
              </label>
              <label className="wb-field">
                Verified category ID
                <input
                  value={session.fields.category_id || ""}
                  onChange={(event) =>
                    change("category_id", event.target.value || null)
                  }
                />
                <span className="wb-input-help">
                  Leave unknown unless checked in this marketplace’s category
                  system.
                </span>
              </label>
            </div>
            <div className="wb-field-grid">
              <label className="wb-field">
                Shipping method
                <input
                  value={session.fields.shipping?.method || ""}
                  onChange={(event) =>
                    change("shipping", {
                      ...session.fields.shipping,
                      method: event.target.value,
                    })
                  }
                  placeholder="Leave blank until verified"
                />
              </label>
              <label className="wb-field">
                Packed weight (grams)
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={session.fields.shipping?.packed_weight_grams ?? ""}
                  onChange={(event) =>
                    change("shipping", {
                      ...session.fields.shipping,
                      packed_weight_grams:
                        event.target.value === ""
                          ? null
                          : Number(event.target.value),
                    })
                  }
                />
              </label>
            </div>
            <label className="wb-field">
              Shipping notes
              <textarea
                rows={2}
                value={session.fields.shipping?.notes || ""}
                onChange={(event) =>
                  change("shipping", {
                    ...session.fields.shipping,
                    notes: event.target.value,
                  })
                }
              />
            </label>
            <div className="wb-draft-photos">
              <h3>Originals selected for this shop</h3>
              <p className="wb-help">
                The originals stay attached to the physical item. These
                selections are not public upload URLs.
              </p>
              {originals.map((photo, index) => (
                <label className="wb-checkbox" key={photo.id}>
                  <input
                    type="checkbox"
                    checked={
                      session.fields.media_ids?.includes(photo.id) || false
                    }
                    onChange={(event) =>
                      change(
                        "media_ids",
                        event.target.checked
                          ? [...(session.fields.media_ids || []), photo.id]
                          : (session.fields.media_ids || []).filter(
                              (id) => id !== photo.id,
                            ),
                      )
                    }
                  />
                  Original {index + 1} · {photo.mime_type} · {photo.id}
                </label>
              ))}
              {!originals.length && (
                <p>
                  No ready originals yet. Add them in Photos; this draft can be
                  saved without them.
                </p>
              )}
            </div>
            <details className="wb-draft-guidance">
              <summary>
                Writing preferences · your choices, not platform rules
              </summary>
              <label className="wb-checkbox">
                <input
                  type="checkbox"
                  checked={session.preferences.avoid_emojis || false}
                  onChange={(event) =>
                    setSession({
                      ...session,
                      preferences: {
                        ...session.preferences,
                        avoid_emojis: event.target.checked,
                      },
                    })
                  }
                />
                Avoid emojis
              </label>
              <label className="wb-field">
                Writing style
                <select
                  aria-label="Writing style"
                  value={session.preferences.style || ""}
                  onChange={(event) =>
                    setSession({
                      ...session,
                      preferences: {
                        ...session.preferences,
                        style: (event.target.value ||
                          undefined) as WritingPreferences["style"],
                      },
                    })
                  }
                >
                  <option value="">No preference selected</option>
                  <option value="plain">Plain factual prose</option>
                  <option value="factual_bullets">Factual bullet points</option>
                  <option value="style_led">Lead with style</option>
                </select>
              </label>
            </details>
            <div className="wb-draft-validation">
              <h3>{validation?.issues.length} checks still visible</h3>
              <p>Saving this draft does not certify it is ready to publish.</p>
              <ul>
                {validation?.issues.map((issue, index) => (
                  <li key={`${issue.code}-${index}`}>
                    <strong>
                      {issue.severity === "error"
                        ? "Fix before saving"
                        : issue.severity === "warning"
                          ? "Review"
                          : "Verify"}
                      :
                    </strong>{" "}
                    {issue.message}
                  </li>
                ))}
              </ul>
            </div>
            <p className="wb-help">
              Your edits are saved as manual overrides of the starting facts.
              Shared inventory facts are preserved.
            </p>
            <button
              className="wb-button wb-button-primary"
              disabled={preview || busy || !validation?.draft_save_allowed}
            >
              {busy ? "Saving draft…" : "Save marketplace draft"}
            </button>
          </fieldset>
        </form>
      )}
    </Dialog>
  );
}

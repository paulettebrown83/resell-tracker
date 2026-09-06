"use client";
import { useRef, useState } from "react";
import Icon from "./WorkbenchIcon";
import { localDate } from "@/lib/workbench";
import type { InventoryItem } from "@/lib/supabase";
import type { ResaleItemDetails, ResaleItemInput } from "@/lib/resale-contract";
import { saveItemWithRetry } from "@/lib/resale-intake";

export type IntakeDraft = ReturnType<typeof createIntakeDraft>;
export function createIntakeDraft(
  item?: InventoryItem,
  details?: ResaleItemDetails,
) {
  return {
    id: item?.id,
    version: item ? details?.version || 0 : undefined,
    item_name: item?.item_name || "",
    cost: item?.item_cost == null ? "" : String(item.item_cost),
    unknownCost: item?.item_cost == null,
    date_added: item ? item.date_added || "" : localDate(),
    brand: details?.brand || "",
    size: details?.size || "",
    color: details?.color || "",
    category: details?.category || "",
    condition: details?.condition || "",
    description: details?.description || "",
    material: details?.material || "",
    sku: details?.sku || "",
    workflow: details?.workflow || ("draft" as ResaleItemDetails["workflow"]),
  };
}
export default function ItemIntake({
  draft,
  setDraft,
  onSaved,
  onBusyChange,
  save = saveItemWithRetry,
}: {
  draft: IntakeDraft;
  setDraft: (draft: IntakeDraft) => void;
  onSaved: (id: string) => Promise<void>;
  onBusyChange?: (busy: boolean) => void;
  save?: (input: ResaleItemInput) => Promise<string>;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    lock = useRef(false);
  const preview = process.env.NEXT_PUBLIC_APP_DEPLOYMENT_ENV === "preview";
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (lock.current || preview) return;
    lock.current = true;
    setBusy(true);
    onBusyChange?.(true);
    setError("");
    try {
      const { id, version, item_name, cost, unknownCost, ...details } = draft;
      const saved = await save({
        ...(id ? { id, version } : {}),
        item_name: item_name.trim(),
        item_cost: unknownCost ? null : Number(cost),
        ...details,
        date_added: details.date_added || null,
      });
      await onSaved(saved);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Item save was not confirmed. Use Retry pending item save before trying again.",
      );
    } finally {
      lock.current = false;
      setBusy(false);
      onBusyChange?.(false);
    }
  }
  function field(
    key:
      | "item_name"
      | "brand"
      | "size"
      | "color"
      | "category"
      | "condition"
      | "material"
      | "sku",
    label: string,
    placeholder?: string,
  ) {
    return (
      <label className="wb-field">
        {label}
        <input
          required={key === "item_name"}
          maxLength={key === "item_name" ? 300 : 200}
          value={draft[key]}
          onChange={(event) =>
            setDraft({ ...draft, [key]: event.target.value })
          }
          placeholder={placeholder}
        />
      </label>
    );
  }
  return (
    <div className="wb-form-layout">
      <section className="wb-panel wb-form-panel">
        <div className="wb-section-heading">
          <div>
            <p className="wb-eyebrow">01 / THE ESSENTIALS</p>
            <h2>
              {draft.id ? "Keep the details together" : "Give this item a home"}
            </h2>
          </div>
          <Icon name="tag" size={26} />
        </div>
        {error && (
          <p role="alert" className="wb-alert">
            {error}
          </p>
        )}
        <form onSubmit={submit}>
          <fieldset disabled={busy || preview} className="wb-fieldset">
            {field("item_name", "Item name", "Brand, item, color, size")}
            <div className="wb-field-grid">
              <div>
                <label className="wb-field">
                  Item cost ($)
                  <input
                    required={!draft.unknownCost}
                    disabled={draft.unknownCost}
                    min="0"
                    step="0.01"
                    type="number"
                    inputMode="decimal"
                    value={draft.cost}
                    onChange={(event) =>
                      setDraft({ ...draft, cost: event.target.value })
                    }
                    placeholder={draft.unknownCost ? "Unknown" : "0.00"}
                  />
                </label>
                <label className="wb-checkbox">
                  <input
                    type="checkbox"
                    checked={draft.unknownCost}
                    onChange={(event) =>
                      setDraft({ ...draft, unknownCost: event.target.checked })
                    }
                  />
                  Cost is unknown
                </label>
                <p className="wb-input-help">
                  Enter 0 only if you know it cost nothing.
                </p>
              </div>
              <label className="wb-field">
                Date added
                <input
                  required={!draft.id}
                  type="date"
                  value={draft.date_added}
                  onChange={(event) =>
                    setDraft({ ...draft, date_added: event.target.value })
                  }
                />
              </label>
            </div>
            <div className="wb-form-divider" />
            <p className="wb-eyebrow">02 / WHAT MAKES IT THIS ITEM</p>
            <div className="wb-field-grid">
              {field("brand", "Brand", "Optional")}
              {field("category", "Category", "e.g., Jackets")}
              {field("size", "Size", "As shown on the label")}
              {field("color", "Color")}
              {field("condition", "Condition", "Include wear or flaws")}
              {field("material", "Material")}
              {field("sku", "Your item reference / SKU", "Optional")}
              <label className="wb-field">
                Preparation stage
                <select
                  value={draft.workflow}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      workflow: event.target.value as IntakeDraft["workflow"],
                    })
                  }
                >
                  <option value="draft">Draft</option>
                  <option value="needs_details">Needs details</option>
                  <option value="ready">Ready to prepare listings</option>
                  {draft.workflow === "archived" && (
                    <option value="archived">Archived preparation</option>
                  )}
                </select>
                <small>This does not publish a listing.</small>
              </label>
            </div>
            <label className="wb-field">
              Description
              <textarea
                rows={5}
                value={draft.description}
                maxLength={10000}
                onChange={(event) =>
                  setDraft({ ...draft, description: event.target.value })
                }
                placeholder="Measurements, fit, condition, and anything a buyer should know."
              />
              <small>
                Saved with this item. Marketplace-specific fields come from each
                listing.
              </small>
            </label>
            <div className="wb-form-actions">
              <button
                type="submit"
                disabled={!draft.item_name.trim()}
                className="wb-button wb-button-primary"
              >
                <Icon name={draft.id ? "check" : "plus"} size={18} />
                {busy
                  ? "Saving item…"
                  : draft.id
                    ? "Save item details"
                    : "Add to inventory"}
              </button>
              <span>
                {draft.id
                  ? "The original item ID stays the same."
                  : "Photos come next, once the item is saved."}
              </span>
            </div>
          </fieldset>
        </form>
      </section>
      <aside className="wb-intake-aside">
        <div className="wb-illustration" aria-hidden="true">
          <Icon name="box" size={80} />
          <span className="wb-illustration-tag">
            <Icon name="tag" size={25} />
          </span>
        </div>
        <h2>
          Start simple.
          <br />
          Keep it connected.
        </h2>
        <p>
          Your item keeps the same ID when you record its sale. That means less
          hunting, and a history you can trust.
        </p>
        <div className="wb-note">
          <Icon name="photo" size={21} />
          <div>
            <strong>Save the item, then add photos</strong>
            <p>
              Open the saved item to attach its original photos. Photos stay
              private and linked to that item.
            </p>
          </div>
        </div>
        <div className="wb-note">
          <Icon name="store" size={21} />
          <div>
            <strong>Ready isn’t the same as listed</strong>
            <p>
              Preparation stages describe your work. A listing’s observed status
              shows what was checked on its marketplace.
            </p>
          </div>
        </div>
      </aside>
    </div>
  );
}

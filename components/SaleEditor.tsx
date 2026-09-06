"use client";
import { useRef, useState } from "react";
import { saveSale, type InventoryItem, type Sale } from "@/lib/supabase";

export default function SaleEditor({
  item,
  sale,
  onSaved,
  onCancel,
  onBusyChange,
  save = saveSale,
}: {
  item: InventoryItem | null;
  sale: Sale | null;
  onSaved: () => Promise<void>;
  onCancel: () => void;
  onBusyChange?: (busy: boolean) => void;
  save?: typeof saveSale;
}) {
  const [busy, setBusy] = useState(false),
    lock = useRef(false),
    [error, setError] = useState("");
  const [form, setForm] = useState({
    item_name: sale?.item_name || item?.item_name || "",
    platform: sale?.platform || "",
    sale_date: sale?.sale_date || new Date().toLocaleDateString("en-CA"),
    sale_price: sale ? String(sale.sale_price) : "",
    platform_fee: sale ? String(sale.platform_fee) : "",
    item_cost: sale
      ? sale.item_cost == null
        ? ""
        : String(sale.item_cost)
      : item?.item_cost == null
        ? ""
        : String(item.item_cost),
    shipping_cost:
      sale?.shipping_cost == null ? "" : String(sale.shipping_cost),
    actual_received:
      sale?.actual_received == null ? "" : String(sale.actual_received),
    gross_total: sale?.gross_total == null ? "" : String(sale.gross_total),
    source_system: sale?.source_system || "",
    source_record_id: sale?.source_record_id || "",
    reason: "",
  });
  const preview = process.env.NEXT_PUBLIC_APP_DEPLOYMENT_ENV === "preview";
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (lock.current || preview) return;
    if (item && item.item_cost == null) {
      setError(
        "Save the actual cost on this inventory item before recording its sale.",
      );
      return;
    }
    lock.current = true;
    setBusy(true);
    onBusyChange?.(true);
    setError("");
    try {
      await save({
        ...(sale
          ? { id: sale.id, version: sale.version, reason: form.reason.trim() }
          : {}),
        ...(item ? { inventory_id: item.id } : {}),
        item_name: form.item_name.trim(),
        platform: form.platform,
        sale_date: form.sale_date,
        sale_price: Number(form.sale_price),
        platform_fee: Number(form.platform_fee),
        item_cost: Number(form.item_cost),
        shipping_cost: Number(form.shipping_cost),
        ...(form.actual_received !== ""
          ? { actual_received: Number(form.actual_received) }
          : {}),
        ...(form.gross_total !== ""
          ? { gross_total: Number(form.gross_total) }
          : {}),
        ...(form.source_system.trim()
          ? {
              source_system: form.source_system.trim(),
              source_record_id: form.source_record_id.trim(),
            }
          : {}),
      });
      await onSaved();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Save was not confirmed. Close this form and use Retry pending sale save before adding another sale.",
      );
    } finally {
      lock.current = false;
      setBusy(false);
      onBusyChange?.(false);
    }
  }
  function field(
    key: keyof typeof form,
    label: string,
    type = "text",
    optional = false,
    help?: string,
  ) {
    return (
      <label className="wb-field">
        {label}
        <input
          type={type}
          min={type === "number" ? "0" : undefined}
          step={type === "number" ? "0.01" : undefined}
          inputMode={type === "number" ? "decimal" : undefined}
          required={!optional}
          readOnly={!!item && (key === "item_name" || key === "item_cost")}
          value={form[key]}
          onChange={(event) => setForm({ ...form, [key]: event.target.value })}
        />
        {help && <small>{help}</small>}
      </label>
    );
  }
  return (
    <section className="wb-sale-editor">
      <div className="wb-note">
        <p>
          Use your marketplace statement. Enter actual fees and shipping costs;
          enter 0 only when you know there were none.
        </p>
      </div>
      {(item || sale?.inventory_id) && (
        <p className="wb-help">
          Linked item ID: {item?.id || sale?.inventory_id}
        </p>
      )}
      {item?.item_cost === null && (
        <p className="wb-alert" role="alert">
          This item’s cost is unknown. Edit its inventory details and save the
          actual cost first.
        </p>
      )}
      {error && (
        <p role="alert" className="wb-alert">
          {error}
        </p>
      )}
      <form onSubmit={submit}>
        <fieldset className="wb-fieldset" disabled={busy || preview}>
          {field("item_name", "Item name")}
          <div className="wb-field-grid">
            <label className="wb-field">
              Marketplace
              <select
                required
                value={form.platform}
                onChange={(event) =>
                  setForm({ ...form, platform: event.target.value })
                }
              >
                <option value="">Choose marketplace</option>
                {Array.from(
                  new Set([
                    "Vinted",
                    "Depop",
                    "Poshmark",
                    "Mercari",
                    "eBay",
                    ...(sale ? [sale.platform] : []),
                  ]),
                ).map((platform) => (
                  <option key={platform}>{platform}</option>
                ))}
              </select>
            </label>
            {field("sale_date", "Sale date", "date")}
          </div>
          <div className="wb-field-grid">
            {field("sale_price", "Sale price ($)", "number")}
            {field("platform_fee", "Actual platform fee ($)", "number")}
            {field("item_cost", "Item cost ($)", "number")}
            {field(
              "shipping_cost",
              "Shipping paid separately ($)",
              "number",
              false,
              "Exclude shipping already taken out of your payout.",
            )}
          </div>
          <details>
            <summary>Statement totals & source details (optional)</summary>
            <div className="wb-field-grid">
              {field(
                "actual_received",
                "Net payout after marketplace deductions ($)",
                "number",
                true,
                "When entered, profit uses this payout minus item cost and separately paid shipping.",
              )}
              {field(
                "gross_total",
                "Gross total from statement ($)",
                "number",
                true,
              )}
              {!sale && (
                <>
                  {field(
                    "source_system",
                    "Source and account",
                    "text",
                    true,
                    "Example format: marketplace:account",
                  )}
                  <label className="wb-field">
                    Source record ID
                    <input
                      required={!!form.source_system.trim()}
                      disabled={!form.source_system.trim()}
                      value={form.source_record_id}
                      onChange={(event) =>
                        setForm({
                          ...form,
                          source_record_id: event.target.value,
                        })
                      }
                    />
                    <small>Use the order and line ID for bundles.</small>
                  </label>
                </>
              )}
            </div>
          </details>
          {sale &&
            field(
              "reason",
              "Reason for correction",
              "text",
              false,
              "This note stays with the sale’s history.",
            )}
          <div className="wb-form-actions">
            <button
              disabled={
                item?.item_cost === null ||
                !form.item_name.trim() ||
                (!!sale && !form.reason.trim())
              }
              className="wb-button wb-button-primary"
            >
              {busy ? "Saving…" : sale ? "Save correction" : "Record sale"}
            </button>
            <button
              type="button"
              className="wb-button wb-button-secondary"
              onClick={onCancel}
            >
              Cancel
            </button>
          </div>
        </fieldset>
      </form>
    </section>
  );
}

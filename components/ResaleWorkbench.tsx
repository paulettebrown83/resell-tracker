"use client";
import Link from "next/link";
import type { ResaleSourceRecord } from "@/lib/resale-contract";
import { useEffect, useMemo, useRef, useState } from "react";
import SaleEditor from "./SaleEditor";
import ListingDraftDialog from "./ListingDraftDialog";
import {
  saveDraftWithRetry,
  retryPendingDraft,
} from "@/lib/resale-draft-retry";
import ItemIntake, { createIntakeDraft } from "./ItemIntake";
import PhotoLibrary, { type MediaClient } from "./PhotoLibrary";
import { MarketplaceViews, AttentionView } from "./MarketplaceViews";
import { retryPendingMatch, type ConfirmMatch } from "@/lib/resale-match-retry";
import { confirmResaleListingMatch } from "@/lib/resale-matching";
import { LinkedItemListings } from "./SourceReportBrowser";
import {
  getResaleWorkbench,
  getResaleSourceRecords,
  type ResaleWorkbench as WorkbenchData,
} from "@/lib/resale-data";
import { saveItemWithRetry, retryPendingItemSave } from "@/lib/resale-intake";
import Dialog from "./WorkbenchDialog";
import Icon, { type IconName } from "./WorkbenchIcon";
import * as records from "@/lib/supabase";
import type { InventoryItem, Sale, Expense } from "@/lib/supabase";
import {
  MARKETPLACES,
  money,
  dateLabel,
  localDate,
  needsSaleReview,
  initialFilters,
  filterInventory,
  filterSales,
  filterExpenses,
  makeCSV,
  type Filters,
} from "@/lib/workbench";

type View =
  | "overview"
  | "intake"
  | "inventory"
  | "photos"
  | "marketplaces"
  | "sales"
  | "attention"
  | "expenses";
type Editor =
  | { kind: "sale"; item: InventoryItem | null; sale: Sale | null }
  | { kind: "expense" }
  | { kind: "item"; item: InventoryItem }
  | {
      kind: "confirm";
      record: InventoryItem | Sale | Expense;
      action: "inventory" | "expense" | "void";
    }
  | null;
type DataSource = Pick<
  typeof records,
  | "requireAccess"
  | "getSales"
  | "getInventory"
  | "getExpenses"
  | "addExpense"
  | "archiveInventoryItem"
  | "archiveExpense"
  | "saveSale"
  | "exportRecords"
  | "retryPendingSale"
> & {
  getResaleWorkbench: typeof getResaleWorkbench;
  getResaleSourceRecords: typeof getResaleSourceRecords;
  saveItemWithRetry: typeof saveItemWithRetry;
  retryPendingItemSave: typeof retryPendingItemSave;
};
const NAV: { id: View; label: string; icon: IconName }[] = [
  { id: "overview", label: "Workbench", icon: "grid" },
  { id: "inventory", label: "Inventory", icon: "box" },
  { id: "intake", label: "Add an item", icon: "plus" },
  { id: "photos", label: "Photos", icon: "photo" },
  { id: "marketplaces", label: "Marketplaces", icon: "store" },
  { id: "sales", label: "Sales", icon: "sale" },
  { id: "attention", label: "Needs attention", icon: "attention" },
  { id: "expenses", label: "Expenses", icon: "receipt" },
];
const COPY: Record<View, [string, string, string]> = {
  overview: [
    "Your workbench",
    "A clear view of your stock, sales, and next steps.",
    "A LITTLE MORE ORGANIZED",
  ],
  inventory: [
    "Inventory",
    "Recorded inventory, from the first entry to the final sale.",
    "EVERY ITEM HAS A STORY",
  ],
  intake: [
    "Add an item",
    "Start with the essentials. Keep one record for each item.",
    "MAKE ROOM FOR SOMETHING NEW",
  ],
  photos: [
    "Photos",
    "A home for the details that help your items sell.",
    "THE BIG PICTURE",
  ],
  marketplaces: [
    "Marketplaces",
    "Where your items are recorded, and what still needs checking.",
    "YOUR SELLING SURFACES",
  ],
  sales: [
    "Sales",
    "What sold, what came back to you, and what needs a closer look.",
    "THE PAYOFF",
  ],
  attention: [
    "Needs attention",
    "A practical list of gaps in your current records.",
    "ONE THING AT A TIME",
  ],
  expenses: [
    "Business expenses",
    "Mailers, supplies, and the costs of keeping things moving.",
    "KEEP THE FULL PICTURE",
  ],
};
const liveData = {
  ...records,
  getResaleWorkbench,
  getResaleSourceRecords,
  saveItemWithRetry,
  retryPendingItemSave,
};
const PAGE_SIZE = 20;
function download(name: string, contents: string, type: string) {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}
function Empty({
  icon = "box",
  title,
  children,
}: {
  icon?: IconName;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="wb-empty">
      <span className="wb-empty-icon">
        <Icon name={icon} size={28} />
      </span>
      <h3>{title}</h3>
      {children && <div>{children}</div>}
    </div>
  );
}
function Platform({ name }: { name: string }) {
  return (
    <span className="wb-platform">
      <span
        aria-hidden="true"
        className={`wb-platform-dot wb-${name.toLowerCase()}`}
      />
      {name}
    </span>
  );
}
function Metric({
  label,
  value,
  note,
  accent,
}: {
  label: string;
  value: string | number;
  note: string;
  accent?: boolean;
}) {
  return (
    <div className={`wb-metric${accent ? " wb-metric-accent" : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{note}</small>
    </div>
  );
}

export default function ResaleWorkbench({
  dataSource = liveData,
  mediaClient,
  mediaConnected,
  confirmMatch = confirmResaleListingMatch,
}: {
  dataSource?: DataSource;
  mediaClient?: MediaClient;
  mediaConnected?: boolean;
  confirmMatch?: ConfirmMatch;
}) {
  const [view, setView] = useState<View>("overview");
  const [sales, setSales] = useState<Sale[]>([]),
    [inventory, setInventory] = useState<InventoryItem[]>([]),
    [expenses, setExpenses] = useState<Expense[]>([]);
  const [loading, setLoading] = useState(true),
    [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const lock = useRef(false),
    loadVersion = useRef(0),
    heading = useRef<HTMLHeadingElement>(null);
  const [filters, setFilters] = useState<Filters>(initialFilters),
    [page, setPage] = useState(0);
  const [reviewOnly, setReviewOnly] = useState(false),
    [stockScope, setStockScope] = useState<"all" | "unassigned" | "incomplete">(
      "all",
    );
  const [editor, setEditor] = useState<Editor>(null),
    [reason, setReason] = useState("");
  const [draft, setDraft] = useState(createIntakeDraft());
  const [workbench, setWorkbench] = useState<WorkbenchData | null>(null);
  const [photoItem, setPhotoItem] = useState("");
  const [listingDraftItem, setListingDraftItem] =
    useState<InventoryItem | null>(null);
  const [sourceRecords, setSourceRecords] = useState<ResaleSourceRecord[]>([]);
  const [expenseForm, setExpenseForm] = useState({
    name: "",
    amount: "",
    date_added: localDate(),
  });
  const preview = process.env.NEXT_PUBLIC_APP_DEPLOYMENT_ENV === "preview";
  async function loadData() {
    const version = ++loadVersion.current;
    setLoading(true);
    setLoadError("");
    try {
      await dataSource.requireAccess();
      const [nextSales, nextWorkbench, nextExpenses, nextSources] =
        await Promise.all([
          dataSource.getSales(),
          dataSource.getResaleWorkbench(),
          dataSource.getExpenses(),
          dataSource.getResaleSourceRecords(),
        ]);
      if (version !== loadVersion.current) return;
      setSales(nextSales);
      setSourceRecords(nextSources);
      setWorkbench(nextWorkbench);
      setInventory(
        nextWorkbench.inventory
          .filter(
            (item) =>
              !item.archived_at && item.status?.toLowerCase() !== "sold",
          )
          .map((item) => ({ ...item, platforms: item.platforms || [] })),
      );
      setExpenses(nextExpenses);
    } catch {
      if (version !== loadVersion.current) return;
      setSales([]);
      setInventory([]);
      setExpenses([]);
      setWorkbench(null);
      setSourceRecords([]);
      setLoadError(
        "Your records could not be loaded. Check your connection and account access, then try again.",
      );
    } finally {
      if (version === loadVersion.current) setLoading(false);
    }
  }
  useEffect(() => {
    void loadData();
    return () => {
      // Invalidate in-flight reads on unmount, not a DOM ref cleanup.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      loadVersion.current++;
    };
    // Account changes remount this component through AuthGate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataSource]);
  function navigate(next: View) {
    setView(next);
    setFilters(initialFilters);
    setPage(0);
    setReviewOnly(false);
    setStockScope("all");
    requestAnimationFrame(() => heading.current?.focus());
  }
  function beginIntake() {
    if (draft.id) setDraft(createIntakeDraft());
    navigate("intake");
  }
  function updateFilters(next: Partial<Filters>) {
    setFilters((current) => ({ ...current, ...next }));
    setPage(0);
  }
  function openEditor(next: Editor) {
    setEditor(next);
    setReason("");
    setError("");
  }
  async function mutate(
    action: () => Promise<unknown>,
    success: string,
    after?: () => void,
  ) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      setNotice(success);
      after?.();
      await loadData();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The save was not confirmed. Refresh records and check before trying again.",
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function addExpense(event: React.FormEvent) {
    event.preventDefault();
    await mutate(
      async () => {
        try {
          await dataSource.addExpense({
            ...expenseForm,
            name: expenseForm.name.trim(),
            amount: Number(expenseForm.amount),
          });
        } catch {
          throw new Error(
            "This expense’s save was not confirmed. Refresh expenses and check for it before submitting again.",
          );
        }
      },
      "Expense recorded.",
      () => {
        setEditor(null);
        setExpenseForm({ name: "", amount: "", date_added: localDate() });
      },
    );
  }
  async function confirmAction(event: React.FormEvent) {
    event.preventDefault();
    if (editor?.kind !== "confirm") return;
    const { record, action } = editor;
    await mutate(
      () =>
        action === "void"
          ? dataSource.saveSale({
              id: record.id,
              version: (record as Sale).version,
              void: true,
              reason: reason.trim(),
            })
          : action === "inventory"
            ? dataSource.archiveInventoryItem(record.id)
            : dataSource.archiveExpense(record.id),
      action === "void"
        ? "Sale voided. Its history is preserved."
        : "Record archived. It is preserved in the full export.",
      () => setEditor(null),
    );
  }
  async function exportAll() {
    const generation = loadVersion.current;
    setError("");
    try {
      const exported = await dataSource.exportRecords();
      // AuthGate unmounts on sign-out/account change; never download the prior account’s result.
      if (generation !== loadVersion.current) return;
      download(
        `resale-records-${localDate()}.json`,
        JSON.stringify(exported, null, 2),
        "application/json",
      );
    } catch {
      if (generation !== loadVersion.current) return;
      setError(
        "The export could not finish. No complete export was downloaded. Please try again.",
      );
    }
  }
  const visibleInventory = useMemo(
    () =>
      filterInventory(inventory, filters).filter((item) =>
        stockScope === "unassigned"
          ? item.platforms.length === 0
          : stockScope === "incomplete"
            ? item.item_cost == null ||
              !workbench?.details.some(
                (d) => d.inventory_id === item.id && d.workflow === "ready",
              )
            : true,
      ),
    [inventory, filters, stockScope, workbench],
  );
  const visibleSales = useMemo(
    () =>
      filterSales(sales, filters).filter(
        (sale) => !reviewOnly || needsSaleReview(sale),
      ),
    [sales, filters, reviewOnly],
  );
  const visibleExpenses = useMemo(
    () => filterExpenses(expenses, filters),
    [expenses, filters],
  );
  const unassigned = inventory.filter((item) => !item.platforms.length),
    reviewSales = sales.filter(needsSaleReview);
  const incomplete = inventory.filter((item) => {
    const detail = workbench?.details.find((d) => d.inventory_id === item.id);
    return (
      !detail ||
      ["draft", "needs_details"].includes(detail.workflow) ||
      item.item_cost == null
    );
  });
  const attentionCount =
    sourceRecords.filter((row) => row.record_status !== "accepted").length +
    incomplete.length +
    reviewSales.length +
    (workbench?.attention.filter((row) => row.state === "open").length || 0) +
    (workbench?.actions.filter((row) =>
      ["blocked", "failed", "uncertain"].includes(row.state),
    ).length || 0);
  const inventoryCost = inventory.reduce(
    (sum, item) => sum + (item.item_cost ?? 0),
    0,
  );
  const unknownStockCosts = inventory.filter(
    (item) => item.item_cost == null,
  ).length;
  const allRevenue = sales.reduce((sum, sale) => sum + sale.sale_price, 0);
  const currentRows =
    view === "sales"
      ? visibleSales
      : view === "expenses"
        ? visibleExpenses
        : visibleInventory;
  const pages = Math.max(1, Math.ceil(currentRows.length / PAGE_SIZE)),
    currentPage = Math.min(page, pages - 1),
    from = currentPage * PAGE_SIZE;
  const years = Array.from(
    new Set([
      ...sales.map((s) => s.sale_date.slice(0, 4)),
      ...expenses.map((e) => e.date_added.slice(0, 4)),
    ]),
  )
    .sort()
    .reverse();
  const hasFilters =
    filters.search ||
    filters.platform !== "all" ||
    filters.start ||
    filters.end ||
    filters.year !== "all" ||
    stockScope !== "all" ||
    reviewOnly;
  function exportCSV() {
    const amount = (value: number | null) =>
      value == null ? "" : String(value);
    if (view === "sales")
      download(
        "sales.csv",
        makeCSV(
          [
            "Sale ID",
            "Inventory ID",
            "Source",
            "Source Record ID",
            "Settlement",
            "Item",
            "Platform",
            "Date",
            "Sale Price",
            "Fee",
            "Cost",
            "Shipping",
            "Profit",
          ],
          visibleSales.map((s) => [
            s.id,
            s.inventory_id || "",
            s.source_system || "",
            s.source_record_id || "",
            s.settlement_status,
            s.item_name,
            s.platform,
            s.sale_date,
            amount(s.sale_price),
            amount(s.platform_fee),
            amount(s.item_cost),
            amount(s.shipping_cost),
            amount(s.profit),
          ]),
        ),
        "text/csv;charset=utf-8",
      );
    else if (view === "expenses")
      download(
        "expenses.csv",
        makeCSV(
          ["Expense ID", "Name", "Amount", "Date"],
          visibleExpenses.map((e) => [
            e.id,
            e.name,
            amount(e.amount),
            e.date_added,
          ]),
        ),
        "text/csv;charset=utf-8",
      );
    else
      download(
        "inventory.csv",
        makeCSV(
          ["Item ID", "Status", "Item", "Cost", "Platforms", "Date Added"],
          visibleInventory.map((i) => [
            i.id,
            i.status || "",
            i.item_name,
            amount(i.item_cost),
            i.platforms.join("; "),
            i.date_added || "",
          ]),
        ),
        "text/csv;charset=utf-8",
      );
  }
  function showUnassigned() {
    navigate("inventory");
    setStockScope("incomplete");
  }
  function showReviewSales() {
    navigate("sales");
    setReviewOnly(true);
  }
  const readDisabled = loading || !!loadError,
    writeDisabled = readDisabled || busy || preview;
  function inventoryList(items: InventoryItem[], compact = false) {
    return items.length ? (
      <div className="wb-inventory-list">
        {items.map((item) => (
          <article key={item.id} className="wb-inventory-row">
            <button
              className="wb-item-open"
              onClick={() => openEditor({ kind: "item", item })}
              aria-label={`View ${item.item_name}`}
            >
              <span className="wb-item-placeholder">
                <Icon name="tag" size={compact ? 22 : 26} />
              </span>
              <span className="wb-item-title">
                <strong>{item.item_name}</strong>
                <small>{dateLabel(item.date_added)}</small>
              </span>
            </button>
            {!compact && (
              <div className="wb-item-platforms">
                {item.platforms.length ? (
                  item.platforms.map((p) => <Platform key={p} name={p} />)
                ) : (
                  <span className="wb-badge wb-badge-amber">
                    No marketplace tags
                  </span>
                )}
              </div>
            )}
            <span className="wb-item-cost">
              <small>Item cost</small>
              <strong>{money(item.item_cost)}</strong>
            </span>
            <button
              className="wb-icon-button"
              aria-label={`Open details for ${item.item_name}`}
              onClick={() => openEditor({ kind: "item", item })}
            >
              <Icon name="chevron" size={18} />
            </button>
          </article>
        ))}
      </div>
    ) : (
      <Empty
        title={
          hasFilters
            ? "No items match these filters"
            : "A fresh start for your inventory"
        }
      >
        <p>
          {hasFilters
            ? "Try another search or clear your filters."
            : "Add your first item to start keeping everything in one place."}
        </p>
        <button
          className="wb-button wb-button-secondary"
          onClick={
            hasFilters
              ? () => {
                  setFilters(initialFilters);
                  setStockScope("all");
                }
              : () => navigate("intake")
          }
        >
          {hasFilters ? "Clear filters" : "Add an item"}
        </button>
      </Empty>
    );
  }
  return (
    <div className="wb-shell">
      <a href="#workbench-main" className="wb-skip-link">
        Skip to content
      </a>
      <aside className="wb-sidebar">
        <Link className="wb-brand" href="/" aria-label="Resale Tracker home">
          <span className="wb-brand-mark">
            r<span>.</span>
          </span>
          <span>
            resale<span>PAULETTE’S WORKSPACE</span>
          </span>
        </Link>
        <span className="wb-nav-caption">YOUR STUDIO</span>
        <nav aria-label="Workspace">
          {NAV.map(({ id, label, icon }) => (
            <button
              key={id}
              className={`wb-nav-item${view === id ? " is-active" : ""}`}
              disabled={busy}
              aria-current={view === id ? "page" : undefined}
              onClick={() => (id === "intake" ? beginIntake() : navigate(id))}
            >
              <Icon name={icon} />
              <span>{label}</span>
              {id === "attention" && !readDisabled && attentionCount > 0 && (
                <span className="wb-nav-count">{attentionCount}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="wb-sidebar-bottom">
          <span className="wb-small-label">YOUR RECORDS, TO KEEP</span>
          <p>Take your inventory and history with you.</p>
          <button
            className="wb-text-button"
            onClick={exportAll}
            disabled={readDisabled}
          >
            <Icon name="download" size={16} />
            Export all records
          </button>
          <button
            className="wb-text-button"
            onClick={() =>
              mutate(
                () => dataSource.retryPendingSale(),
                "Pending sale verified.",
                () => setEditor(null),
              )
            }
            disabled={writeDisabled}
          >
            <Icon name="refresh" size={16} />
            Retry pending sale save
          </button>
          <button
            className="wb-text-button"
            disabled={writeDisabled}
            onClick={() =>
              mutate(
                () => dataSource.retryPendingItemSave(),
                "Pending item save verified.",
                () => {
                  setDraft(createIntakeDraft());
                  navigate("inventory");
                },
              )
            }
          >
            <Icon name="refresh" size={16} />
            Retry pending item save
          </button>
        </div>
      </aside>
      <main className="wb-main" id="workbench-main" tabIndex={-1}>
        <div className="wb-topline">
          <span>
            Resale studio <span aria-hidden="true">/</span>{" "}
            {NAV.find((n) => n.id === view)?.label}
          </span>
          <button
            className="wb-text-button"
            onClick={loadData}
            disabled={loading || busy}
          >
            <Icon name="refresh" size={15} />
            {loading ? "Refreshing…" : "Refresh records"}
          </button>
        </div>
        <header className="wb-page-header">
          <div>
            <p className="wb-eyebrow">{COPY[view][2]}</p>
            <h1 ref={heading} tabIndex={-1}>
              {view === "intake" && draft.id ? "Edit item" : COPY[view][0]}
            </h1>
            <p className="wb-description">{COPY[view][1]}</p>
          </div>
          {view !== "intake" && (
            <button
              className="wb-button wb-button-primary"
              onClick={() =>
                view === "sales"
                  ? openEditor({ kind: "sale", item: null, sale: null })
                  : view === "expenses"
                    ? openEditor({ kind: "expense" })
                    : beginIntake()
              }
              disabled={writeDisabled}
            >
              <Icon name="plus" size={18} />
              {view === "sales"
                ? "Record a sale"
                : view === "expenses"
                  ? "Add expense"
                  : "Add an item"}
            </button>
          )}
        </header>
        {notice && (
          <div role="status" className="wb-notice">
            <Icon name="check" size={18} />
            <p>{notice}</p>
            <button
              className="wb-icon-button"
              aria-label="Dismiss notification"
              onClick={() => setNotice("")}
            >
              <Icon name="close" size={16} />
            </button>
          </div>
        )}
        {error && !editor && (
          <div role="alert" className="wb-alert">
            <p>{error}</p>
            <button className="wb-text-button" onClick={() => setError("")}>
              Dismiss
            </button>
          </div>
        )}
        {loadError ? (
          <section className="wb-panel">
            <Empty icon="attention" title="Let’s reconnect to your records">
              <p role="alert">{loadError}</p>
              <button
                className="wb-button wb-button-primary"
                onClick={loadData}
              >
                Try again
              </button>
            </Empty>
          </section>
        ) : loading ? (
          <div className="wb-loading" role="status">
            <span className="wb-spinner" />
            <p>Gathering your records…</p>
          </div>
        ) : (
          <>
            {view === "overview" && (
              <>
                <div className="wb-metrics">
                  <Metric
                    label="Not marked sold"
                    value={inventory.length}
                    note="Sold and archived items excluded"
                  />
                  <Metric
                    label="Inventory cost"
                    value={money(inventoryCost)}
                    note={
                      unknownStockCosts
                        ? `${unknownStockCosts} unknown costs excluded`
                        : "Recorded cost of current inventory"
                    }
                  />
                  <Metric
                    label="Recorded sales"
                    value={money(allRevenue)}
                    note={`${sales.length} sales · all time · before deductions`}
                  />
                  <Metric
                    label="Needs a closer look"
                    value={attentionCount}
                    note="Details, amounts & open review cases"
                    accent
                  />
                </div>
                <div className="wb-overview-grid">
                  <section className="wb-panel">
                    <div className="wb-section-heading">
                      <div>
                        <p className="wb-eyebrow">ON YOUR SHELF</p>
                        <h2>Recently added</h2>
                      </div>
                      <button
                        className="wb-text-button"
                        onClick={() => navigate("inventory")}
                      >
                        View inventory <Icon name="arrow" size={17} />
                      </button>
                    </div>
                    {inventoryList(
                      filterInventory(inventory, initialFilters).slice(0, 5),
                      true,
                    )}
                    <div className="wb-panel-footer">
                      <Icon name="box" size={16} />
                      <span>
                        One item. One record. Across your marketplaces.
                      </span>
                    </div>
                  </section>
                  <aside className="wb-next-panel">
                    <span className="wb-small-label">YOUR NEXT STEPS</span>
                    <h2>
                      A little attention
                      <br />
                      goes a long way.
                    </h2>
                    <p>Start with the details that make the rest easier.</p>
                    <button className="wb-next-action" onClick={showUnassigned}>
                      <span className="wb-step-number">01</span>
                      <span>
                        <strong>Finish item details</strong>
                        <small>
                          {incomplete.length} items have details to complete
                        </small>
                      </span>
                      <Icon name="arrow" size={18} />
                    </button>
                    <button
                      className="wb-next-action"
                      onClick={showReviewSales}
                    >
                      <span className="wb-step-number">02</span>
                      <span>
                        <strong>Check sale amounts</strong>
                        <small>
                          {reviewSales.length} sales need verification
                        </small>
                      </span>
                      <Icon name="arrow" size={18} />
                    </button>
                    <button
                      className="wb-next-action"
                      onClick={() => navigate("marketplaces")}
                    >
                      <span className="wb-step-number">03</span>
                      <span>
                        <strong>Review selling surfaces</strong>
                        <small>Check the latest recorded observations</small>
                      </span>
                      <Icon name="arrow" size={18} />
                    </button>
                  </aside>
                </div>
                <section className="wb-market-strip">
                  <div>
                    <Icon name="store" size={23} />
                    <span>
                      <strong>Across your marketplaces</strong>
                      <small>Saved item tags · live listings not checked</small>
                    </span>
                  </div>
                  <div>
                    {MARKETPLACES.map((platform) => (
                      <button
                        className="wb-market-summary"
                        key={platform}
                        onClick={() => {
                          navigate("inventory");
                          updateFilters({ platform });
                        }}
                      >
                        <Platform name={platform} />
                        <strong>
                          {
                            inventory.filter((item) =>
                              item.platforms.includes(platform),
                            ).length
                          }
                        </strong>
                      </button>
                    ))}
                  </div>
                </section>
              </>
            )}
            {view === "intake" && (
              <ItemIntake
                onBusyChange={setBusy}
                draft={draft}
                setDraft={setDraft}
                save={dataSource.saveItemWithRetry}
                onSaved={async () => {
                  setNotice(
                    draft.id
                      ? "Item details saved."
                      : "Item added to inventory.",
                  );
                  setDraft(createIntakeDraft());
                  navigate("inventory");
                  await loadData();
                }}
              />
            )}

            {(view === "inventory" ||
              view === "sales" ||
              view === "expenses") && (
              <>
                {view === "sales" && (
                  <div className="wb-metrics">
                    <Metric
                      label="Sale price total"
                      value={money(
                        visibleSales.reduce((sum, s) => sum + s.sale_price, 0),
                      )}
                      note={`${visibleSales.length} matching sales · before deductions`}
                    />
                    <Metric
                      label="Recorded platform fees"
                      value={money(
                        visibleSales.reduce(
                          (sum, s) => sum + s.platform_fee,
                          0,
                        ),
                      )}
                      note="Amounts saved on matching sales"
                    />
                    <Metric
                      label="Verified sale profit"
                      value={money(
                        visibleSales
                          .filter((s) => !needsSaleReview(s))
                          .reduce((sum, s) => sum + s.profit, 0),
                      )}
                      note="Before business expenses · unverified excluded"
                    />
                    <Metric
                      label="Amounts to review"
                      value={visibleSales.filter(needsSaleReview).length}
                      note="Historical or incomplete amounts"
                      accent
                    />
                  </div>
                )}
                <section className="wb-panel">
                  <div className="wb-section-heading">
                    <div>
                      <h2>
                        {view === "inventory"
                          ? "Current inventory"
                          : view === "sales"
                            ? "Sales ledger"
                            : "Expense ledger"}{" "}
                        <span className="wb-count">{currentRows.length}</span>
                      </h2>
                      <p>
                        {view === "inventory"
                          ? "All years · marketplace tags are not live listing status"
                          : view === "sales"
                            ? "Corrections keep the original record and its history."
                            : `Matching expenses total ${money(visibleExpenses.reduce((sum, e) => sum + e.amount, 0))}`}
                      </p>
                    </div>
                    <button
                      className="wb-button wb-button-secondary"
                      onClick={exportCSV}
                    >
                      <Icon name="download" size={16} />
                      Export CSV
                    </button>
                  </div>
                  {view === "inventory" && (
                    <div className="wb-segmented" aria-label="Inventory scope">
                      <button
                        className={stockScope === "all" ? "is-selected" : ""}
                        aria-pressed={stockScope === "all"}
                        onClick={() => {
                          setStockScope("all");
                          setPage(0);
                        }}
                      >
                        All items <span>{inventory.length}</span>
                      </button>
                      <button
                        className={
                          stockScope === "incomplete" ? "is-selected" : ""
                        }
                        aria-pressed={stockScope === "incomplete"}
                        onClick={() => {
                          setStockScope("incomplete");
                          setPage(0);
                        }}
                      >
                        Needs details <span>{incomplete.length}</span>
                      </button>
                      <button
                        className={
                          stockScope === "unassigned" ? "is-selected" : ""
                        }
                        aria-pressed={stockScope === "unassigned"}
                        onClick={() => {
                          setStockScope("unassigned");
                          setPage(0);
                        }}
                      >
                        No marketplace tags <span>{unassigned.length}</span>
                      </button>
                    </div>
                  )}
                  {view === "sales" && (
                    <div
                      className="wb-segmented"
                      aria-label="Sale verification"
                    >
                      <button
                        className={!reviewOnly ? "is-selected" : ""}
                        aria-pressed={!reviewOnly}
                        onClick={() => {
                          setReviewOnly(false);
                          setPage(0);
                        }}
                      >
                        All sales
                      </button>
                      <button
                        className={reviewOnly ? "is-selected" : ""}
                        aria-pressed={reviewOnly}
                        onClick={() => {
                          setReviewOnly(true);
                          setPage(0);
                        }}
                      >
                        Needs verification <span>{reviewSales.length}</span>
                      </button>
                    </div>
                  )}
                  <div className="wb-filters">
                    <label className="wb-search">
                      <Icon name="search" size={18} />
                      <span className="wb-sr-only">Search {view}</span>
                      <input
                        type="search"
                        placeholder={`Search ${view === "expenses" ? "expenses" : "items"} or record IDs…`}
                        value={filters.search}
                        onChange={(event) =>
                          updateFilters({ search: event.target.value })
                        }
                      />
                    </label>
                    {view !== "expenses" && (
                      <label className="wb-filter">
                        <span className="wb-sr-only">
                          Filter by marketplace
                        </span>
                        <select
                          value={filters.platform}
                          onChange={(event) =>
                            updateFilters({ platform: event.target.value })
                          }
                        >
                          <option value="all">All marketplaces</option>
                          {Array.from(
                            new Set([
                              ...MARKETPLACES,
                              ...sales.map((s) => s.platform),
                              ...inventory.flatMap((i) => i.platforms),
                            ]),
                          ).map((p) => (
                            <option key={p}>{p}</option>
                          ))}
                        </select>
                      </label>
                    )}
                    <label className="wb-filter">
                      <span className="wb-sr-only">Sort records</span>
                      <select
                        value={filters.sort}
                        onChange={(event) =>
                          updateFilters({ sort: event.target.value })
                        }
                      >
                        <option value="newest">Newest first</option>
                        <option value="name">Name A–Z</option>
                      </select>
                    </label>
                    <details className="wb-date-filters">
                      <summary>
                        Dates
                        {filters.start || filters.end || filters.year !== "all"
                          ? " · filtered"
                          : ""}
                      </summary>
                      <div>
                        {view !== "inventory" && (
                          <label className="wb-field">
                            Year
                            <select
                              value={filters.year}
                              onChange={(event) =>
                                updateFilters({ year: event.target.value })
                              }
                            >
                              <option value="all">All years</option>
                              {years.map((year) => (
                                <option key={year}>{year}</option>
                              ))}
                            </select>
                          </label>
                        )}
                        <label className="wb-field">
                          From
                          <input
                            type="date"
                            value={filters.start}
                            onChange={(event) =>
                              updateFilters({ start: event.target.value })
                            }
                          />
                        </label>
                        <label className="wb-field">
                          Through
                          <input
                            type="date"
                            min={filters.start || undefined}
                            value={filters.end}
                            onChange={(event) =>
                              updateFilters({ end: event.target.value })
                            }
                          />
                        </label>
                      </div>
                    </details>
                    {hasFilters && (
                      <button
                        className="wb-text-button"
                        onClick={() => {
                          setFilters(initialFilters);
                          setReviewOnly(false);
                          setStockScope("all");
                          setPage(0);
                        }}
                      >
                        Clear filters
                      </button>
                    )}
                  </div>
                  {view === "inventory" &&
                    inventoryList(
                      visibleInventory.slice(from, from + PAGE_SIZE),
                    )}
                  {view === "sales" &&
                    (visibleSales.length ? (
                      <div className="wb-sales-list">
                        {visibleSales
                          .slice(from, from + PAGE_SIZE)
                          .map((sale) => (
                            <article className="wb-sale-row" key={sale.id}>
                              <span className="wb-sale-symbol">
                                <Icon name="sale" size={22} />
                              </span>
                              <div className="wb-sale-title">
                                <h3>{sale.item_name}</h3>
                                <div>
                                  <Platform name={sale.platform} />
                                  <span>{dateLabel(sale.sale_date)}</span>
                                </div>
                                <span
                                  className={`wb-badge ${needsSaleReview(sale) ? "wb-badge-amber" : "wb-badge-green"}`}
                                >
                                  {needsSaleReview(sale)
                                    ? "Amounts need verification"
                                    : "Actual amounts recorded"}
                                </span>
                              </div>
                              <div className="wb-sale-amount">
                                <small>Sale price</small>
                                <strong>{money(sale.sale_price)}</strong>
                              </div>
                              <div className="wb-sale-amount">
                                <small>
                                  {needsSaleReview(sale)
                                    ? "Recorded profit · unverified"
                                    : "Sale profit"}
                                </small>
                                <strong>{money(sale.profit)}</strong>
                              </div>
                              <div className="wb-row-actions">
                                <button
                                  className="wb-button wb-button-secondary"
                                  disabled={writeDisabled}
                                  onClick={() =>
                                    openEditor({
                                      kind: "sale",
                                      item: null,
                                      sale,
                                    })
                                  }
                                >
                                  Review / correct
                                </button>
                                <button
                                  className="wb-text-button wb-danger"
                                  disabled={writeDisabled}
                                  onClick={() =>
                                    openEditor({
                                      kind: "confirm",
                                      record: sale,
                                      action: "void",
                                    })
                                  }
                                  aria-label={`Void sale for ${sale.item_name}`}
                                >
                                  Void sale
                                </button>
                              </div>
                              <details className="wb-sale-details">
                                <summary>Record details</summary>
                                <dl className="wb-definition-grid">
                                  <div>
                                    <dt>Sale ID</dt>
                                    <dd>{sale.id}</dd>
                                  </div>
                                  <div>
                                    <dt>Inventory ID</dt>
                                    <dd>{sale.inventory_id || "Not linked"}</dd>
                                  </div>
                                  <div>
                                    <dt>Source</dt>
                                    <dd>
                                      {sale.source_system || "Not recorded"}
                                    </dd>
                                  </div>
                                  <div>
                                    <dt>Source record ID</dt>
                                    <dd>
                                      {sale.source_record_id || "Not recorded"}
                                    </dd>
                                  </div>
                                  <div>
                                    <dt>Shared item cost</dt>
                                    <dd>{money(sale.item_cost)}</dd>
                                  </div>
                                  <div>
                                    <dt>Shipping paid separately</dt>
                                    <dd>{money(sale.shipping_cost)}</dd>
                                  </div>
                                  <div>
                                    <dt>Platform fee</dt>
                                    <dd>{money(sale.platform_fee)}</dd>
                                  </div>
                                  <div>
                                    <dt>Net payout</dt>
                                    <dd>{money(sale.actual_received)}</dd>
                                  </div>
                                </dl>
                              </details>
                            </article>
                          ))}
                      </div>
                    ) : (
                      <Empty icon="sale" title="No sales in this view">
                        <p>
                          {hasFilters
                            ? "Try clearing the filters to see more records."
                            : "Record a sale from inventory to keep it linked to the original item."}
                        </p>
                      </Empty>
                    ))}
                  {view === "expenses" &&
                    (visibleExpenses.length ? (
                      <div>
                        {visibleExpenses
                          .slice(from, from + PAGE_SIZE)
                          .map((expense) => (
                            <article
                              key={expense.id}
                              className="wb-expense-row"
                            >
                              <span className="wb-sale-symbol">
                                <Icon name="receipt" size={22} />
                              </span>
                              <div>
                                <h3>{expense.name}</h3>
                                <p>{dateLabel(expense.date_added)}</p>
                              </div>
                              <strong>{money(expense.amount)}</strong>
                              <button
                                className="wb-text-button wb-danger"
                                disabled={writeDisabled}
                                onClick={() =>
                                  openEditor({
                                    kind: "confirm",
                                    record: expense,
                                    action: "expense",
                                  })
                                }
                                aria-label={`Archive ${expense.name}`}
                              >
                                Archive
                              </button>
                            </article>
                          ))}
                      </div>
                    ) : (
                      <Empty icon="receipt" title="No expenses in this view">
                        <p>
                          {hasFilters
                            ? "Try clearing the filters."
                            : "Add supplies and other business costs as they come up."}
                        </p>
                      </Empty>
                    ))}
                  {!!currentRows.length && (
                    <div className="wb-pagination">
                      <span>
                        Showing {from + 1}–
                        {Math.min(from + PAGE_SIZE, currentRows.length)} of{" "}
                        {currentRows.length}
                      </span>
                      <div>
                        <button
                          className="wb-button wb-button-secondary"
                          disabled={currentPage === 0}
                          onClick={() => setPage(currentPage - 1)}
                        >
                          Previous
                        </button>
                        <span>
                          Page {currentPage + 1} of {pages}
                        </span>
                        <button
                          className="wb-button wb-button-secondary"
                          disabled={currentPage + 1 === pages}
                          onClick={() => setPage(currentPage + 1)}
                        >
                          Next
                        </button>
                      </div>
                    </div>
                  )}
                </section>
              </>
            )}
            {view === "attention" && workbench && (
              <AttentionView
                sources={sourceRecords}
                data={workbench}
                inventory={inventory}
                sales={sales}
                onInventory={showUnassigned}
                onSales={showReviewSales}
                onItem={(item) => openEditor({ kind: "item", item })}
              />
            )}
            {view === "marketplaces" && workbench && (
              <MarketplaceViews
                confirmMatch={confirmMatch}
                onChanged={loadData}
                sources={sourceRecords}
                data={workbench}
                onInventory={(platform) => {
                  navigate("inventory");
                  updateFilters({ platform });
                }}
              />
            )}
          </>
        )}
        <div hidden={view !== "photos" || loading || !!loadError}>
          <PhotoLibrary
            inventory={
              workbench?.inventory.map((item) => ({
                ...item,
                platforms: item.platforms || [],
              })) || []
            }
            media={workbench?.media || []}
            selectedId={photoItem}
            onSelect={setPhotoItem}
            onSaved={loadData}
            api={mediaClient}
            connected={mediaConnected}
          />
        </div>
        <details className="wb-record-tools">
          <summary>Record tools & recovery</summary>
          <div>
            <button
              className="wb-text-button"
              onClick={exportAll}
              disabled={readDisabled}
            >
              <Icon name="download" size={16} />
              Export all records (JSON)
            </button>
            <button
              className="wb-text-button"
              disabled={writeDisabled}
              onClick={() =>
                mutate(
                  () => dataSource.retryPendingSale(),
                  "Pending sale verified.",
                  () => setEditor(null),
                )
              }
            >
              Retry pending sale save
            </button>
            <button
              className="wb-text-button"
              disabled={writeDisabled}
              onClick={() =>
                mutate(
                  () => dataSource.retryPendingItemSave(),
                  "Pending item save verified.",
                  () => {
                    setDraft(createIntakeDraft());
                    navigate("inventory");
                  },
                )
              }
            >
              Retry pending item save
            </button>
            <button
              className="wb-text-button"
              disabled={writeDisabled}
              onClick={() =>
                mutate(
                  () => retryPendingMatch(confirmMatch),
                  "Pending match verified. Records refreshed.",
                )
              }
            >
              Retry pending listing match
            </button>
            <button
              className="wb-text-button"
              disabled={writeDisabled}
              onClick={() =>
                mutate(
                  () => retryPendingDraft(),
                  "Pending marketplace draft verified.",
                )
              }
            >
              Retry pending marketplace draft
            </button>
          </div>
        </details>
        <footer className="wb-footer">
          <span>Made for your next chapter.</span>
          <span>Private inventory · Preserved history</span>
        </footer>
      </main>
      {listingDraftItem && workbench && (
        <ListingDraftDialog
          item={listingDraftItem}
          data={workbench}
          save={saveDraftWithRetry}
          retry={retryPendingDraft}
          onSaved={loadData}
          onClose={() => setListingDraftItem(null)}
        />
      )}
      {editor && (
        <Dialog
          key={editor.kind}
          title={
            editor.kind === "sale"
              ? editor.sale
                ? "Review & correct sale"
                : "Record a sale"
              : editor.kind === "expense"
                ? "Add an expense"
                : editor.kind === "item"
                  ? "Item details"
                  : editor.action === "void"
                    ? "Void this sale?"
                    : "Archive this record?"
          }
          onClose={() => {
            if (!busy) setEditor(null);
          }}
          busy={busy}
          wide={editor.kind === "sale"}
        >
          {error && (
            <p className="wb-alert" role="alert">
              {error}
            </p>
          )}
          {editor.kind === "sale" && (
            <SaleEditor
              item={editor.item}
              sale={editor.sale}
              onSaved={async () => {
                setNotice(
                  editor.sale
                    ? "Sale correction saved. History preserved."
                    : "Sale recorded.",
                );
                setEditor(null);
                await loadData();
              }}
              onCancel={() => setEditor(null)}
              onBusyChange={setBusy}
              save={dataSource.saveSale}
            />
          )}
          {editor.kind === "expense" && (
            <form onSubmit={addExpense}>
              <p className="wb-dialog-description">
                Record a business cost, such as shipping supplies or mailers.
              </p>
              <fieldset className="wb-fieldset" disabled={busy || preview}>
                <label className="wb-field">
                  Expense name
                  <input
                    required
                    maxLength={300}
                    value={expenseForm.name}
                    onChange={(event) =>
                      setExpenseForm({
                        ...expenseForm,
                        name: event.target.value,
                      })
                    }
                    placeholder="What was it for?"
                  />
                </label>
                <div className="wb-field-grid">
                  <label className="wb-field">
                    Amount ($)
                    <input
                      required
                      type="number"
                      min="0"
                      step="0.01"
                      inputMode="decimal"
                      value={expenseForm.amount}
                      onChange={(event) =>
                        setExpenseForm({
                          ...expenseForm,
                          amount: event.target.value,
                        })
                      }
                    />
                  </label>
                  <label className="wb-field">
                    Date
                    <input
                      required
                      type="date"
                      value={expenseForm.date_added}
                      onChange={(event) =>
                        setExpenseForm({
                          ...expenseForm,
                          date_added: event.target.value,
                        })
                      }
                    />
                  </label>
                </div>
                <button
                  className="wb-button wb-button-primary"
                  disabled={!expenseForm.name.trim()}
                >
                  {busy ? "Saving…" : "Save expense"}
                </button>
              </fieldset>
            </form>
          )}
          {editor.kind === "item" && (
            <div className="wb-item-detail">
              <div className="wb-detail-hero">
                <span className="wb-item-placeholder">
                  <Icon name="tag" size={38} />
                </span>
                <div>
                  <p className="wb-eyebrow">CURRENT INVENTORY</p>
                  <h3>{editor.item.item_name}</h3>
                  <span className="wb-badge wb-badge-green">
                    Not marked sold
                  </span>
                </div>
              </div>
              <dl className="wb-definition-grid">
                <div>
                  <dt>Shared item cost</dt>
                  <dd>{money(editor.item.item_cost)}</dd>
                </div>
                <div>
                  <dt>Date added</dt>
                  <dd>{dateLabel(editor.item.date_added)}</dd>
                </div>
                <div className="wb-full">
                  <dt>Item ID</dt>
                  <dd>{editor.item.id}</dd>
                </div>
              </dl>
              <dl className="wb-definition-grid">
                {(
                  [
                    "brand",
                    "category",
                    "size",
                    "color",
                    "condition",
                    "material",
                    "sku",
                  ] as const
                ).map((field) => {
                  const value = workbench?.details.find(
                    (details) => details.inventory_id === editor.item.id,
                  )?.[field];
                  return value ? (
                    <div key={field}>
                      <dt>
                        {field === "sku"
                          ? "Item reference / SKU"
                          : field.charAt(0).toUpperCase() + field.slice(1)}
                      </dt>
                      <dd>{value}</dd>
                    </div>
                  ) : null;
                })}
              </dl>
              {workbench?.details.find(
                (details) => details.inventory_id === editor.item.id,
              )?.description && (
                <div className="wb-item-description">
                  <h4>Description</h4>
                  <p>
                    {
                      workbench.details.find(
                        (details) => details.inventory_id === editor.item.id,
                      )?.description
                    }
                  </p>
                </div>
              )}
              <div className="wb-detail-actions">
                <button
                  className="wb-button wb-button-secondary"
                  onClick={() => {
                    setDraft(
                      createIntakeDraft(
                        editor.item,
                        workbench?.details.find(
                          (d) => d.inventory_id === editor.item.id,
                        ),
                      ),
                    );
                    setEditor(null);
                    navigate("intake");
                  }}
                >
                  Edit item details
                </button>
                <button
                  className="wb-button wb-button-secondary"
                  onClick={() => {
                    setPhotoItem(editor.item.id);
                    setEditor(null);
                    navigate("photos");
                  }}
                >
                  <Icon name="photo" size={17} />
                  Photos (
                  {workbench?.media.filter(
                    (photo) =>
                      photo.inventory_id === editor.item.id &&
                      photo.kind === "original",
                  ).length || 0}
                  )
                </button>
              </div>
              <button
                className="wb-button wb-button-primary"
                disabled={writeDisabled}
                onClick={() => {
                  setListingDraftItem(editor.item);
                  setEditor(null);
                }}
              >
                Prepare marketplace draft
              </button>
              <LinkedItemListings
                itemId={editor.item.id}
                data={workbench}
                onReview={() => {
                  setEditor(null);
                  navigate("marketplaces");
                }}
              />
              <h4>Historical marketplace tags</h4>
              <div className="wb-detail-platforms">
                {editor.item.platforms.length ? (
                  editor.item.platforms.map((platform) => (
                    <Platform key={platform} name={platform} />
                  ))
                ) : (
                  <p>No marketplace tags recorded.</p>
                )}
              </div>
              <p className="wb-help">
                These historical tags do not confirm that a listing is live.
                Open Marketplaces to review recorded observations.
              </p>
              <p className="wb-help">
                {editor.item.item_cost == null
                  ? "Save the actual item cost in Edit item details before recording its sale."
                  : ""}
              </p>
              <div className="wb-form-actions">
                <button
                  className="wb-button wb-button-primary"
                  disabled={writeDisabled || editor.item.item_cost == null}
                  onClick={() =>
                    openEditor({ kind: "sale", item: editor.item, sale: null })
                  }
                >
                  Record sale <Icon name="arrow" size={17} />
                </button>
                <button
                  className="wb-text-button wb-danger"
                  disabled={writeDisabled}
                  onClick={() =>
                    openEditor({
                      kind: "confirm",
                      record: editor.item,
                      action: "inventory",
                    })
                  }
                >
                  Archive item
                </button>
              </div>
            </div>
          )}
          {editor.kind === "confirm" && (
            <form onSubmit={confirmAction}>
              <p className="wb-dialog-description">
                <strong>
                  {"item_name" in editor.record
                    ? editor.record.item_name
                    : editor.record.name}
                </strong>
              </p>
              <p className="wb-help">
                {editor.action === "void"
                  ? "This keeps the sale and its history. Any linked inventory becomes available again. It does not change a marketplace listing."
                  : "This removes the record from the current view. The original record stays in your full export."}
              </p>
              {editor.action === "void" && (
                <label className="wb-field">
                  Reason for voiding
                  <textarea
                    required
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    rows={3}
                    disabled={busy}
                  />
                </label>
              )}
              <div className="wb-form-actions">
                <button
                  className="wb-button wb-button-danger"
                  disabled={
                    busy ||
                    preview ||
                    (editor.action === "void" && !reason.trim())
                  }
                >
                  {busy
                    ? "Saving…"
                    : editor.action === "void"
                      ? "Void sale & keep history"
                      : "Archive record"}
                </button>
                <button
                  className="wb-button wb-button-secondary"
                  type="button"
                  disabled={busy}
                  onClick={() => setEditor(null)}
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </Dialog>
      )}
    </div>
  );
}

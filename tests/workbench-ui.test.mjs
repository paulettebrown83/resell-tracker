import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";
import { JSDOM } from "jsdom";
import React, { act } from "react";
const dom = new JSDOM('<!doctype html><div id="root"></div>', {
  url: "http://localhost",
});
Object.assign(globalThis, {
  window: dom.window,
  self: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (callback) => callback(),
});
dom.window.HTMLDialogElement.prototype.showModal = function () {
  this.open = true;
};
dom.window.HTMLDialogElement.prototype.close = function () {
  this.open = false;
};
const { createRoot } = await import("react-dom/client"),
  require = createRequire(import.meta.url);
const project = path.resolve(import.meta.dirname, ".."),
  modules = new Map();
const stub = {};
function load(file) {
  const absolute = path.resolve(project, file);
  if (modules.has(absolute)) return modules.get(absolute).exports;
  const compiled = { exports: {} };
  modules.set(absolute, compiled);
  const code = ts.transpileModule(fs.readFileSync(absolute, "utf8"), {
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  new Function("require", "module", "exports", code)(
    (name) => {
      if (
        [
          "@/lib/supabase",
          "@/lib/resale-data",
          "@/lib/resale-intake",
          "@/lib/resale-media",
          "./supabase",
        ].includes(name)
      )
        return stub;
      if (name.startsWith("@/"))
        return load(
          name.slice(2) + (name.includes("components/") ? ".tsx" : ".ts"),
        );
      if (name.startsWith(".")) {
        const base = path.resolve(path.dirname(absolute), name);
        return load(
          fs.existsSync(base + ".tsx") ? base + ".tsx" : base + ".ts",
        );
      }
      return require(name);
    },
    compiled,
    compiled.exports,
  );
  return compiled.exports;
}
const Workbench = load("components/ResaleWorkbench.tsx").default;
const PhotoLibrary = load("components/PhotoLibrary.tsx").default;
const ListingMatchDialog = load("components/ListingMatchDialog.tsx").default;
const helpers = load("lib/workbench.ts");
const { safeMarketplaceUrl } = load("components/MarketplaceViews.tsx");
const base = {
  id: "item-known",
  item_name: "Synthetic camera controller",
  item_cost: 12,
  platforms: ["Mercari"],
  date_added: "2021-03-02",
  created_at: "2021-03-02",
  status: "available",
  archived_at: null,
};
let inventory = [
  base,
  {
    ...base,
    id: "item-unknown",
    item_name: "Synthetic unknown cost",
    item_cost: null,
    platforms: [],
  },
];
let sales = [],
  expenses = [];
const savedItems = [],
  savedSales = [];
const data = {
  details: [],
  accounts: [],
  listings: [],
  snapshots: [],
  media: [],
  attention: [],
  actions: [],
};
const source = {
  requireAccess: async () => {},
  getSales: async () => sales,
  getExpenses: async () => expenses,
  getResaleWorkbench: async () => ({ ...data, inventory }),
  getResaleSourceRecords: async () => [],
  getResaleOperations: async () => [],
  saveItemWithRetry: async (input) => {
    savedItems.push(input);
    inventory.push({ ...base, ...input, id: "new-item" });
    return "new-item";
  },
  saveSale: async (input) => {
    savedSales.push(input);
    inventory = inventory.filter((item) => item.id !== input.inventory_id);
    return { ...input, id: "new-sale" };
  },
  archiveInventoryItem: async (id) => {
    inventory = inventory.filter((item) => item.id !== id);
  },
  archiveExpense: async () => {},
  addExpense: async () => {},
  exportRecords: async () => ({}),
  retryPendingItemSave: async () => {},
  retryPendingSale: async () => {},
};
const root = createRoot(document.getElementById("root"));
const buttons = () => [...document.querySelectorAll("button")];
const button = (text) =>
  buttons().find(
    (node) =>
      node.textContent.trim() === text ||
      node.getAttribute("aria-label") === text,
  );
const click = async (node) => {
  assert.ok(node, "Target button exists");
  await act(async () => node.click());
};
const label = (text) =>
  [...document.querySelectorAll("label")].find((node) =>
    node.textContent.trim().startsWith(text),
  );
async function fill(node, value) {
  await act(() => {
    Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(node),
      "value",
    ).set.call(node, value);
    node.dispatchEvent(
      new dom.window.Event(node.tagName === "SELECT" ? "change" : "input", {
        bubbles: true,
      }),
    );
  });
}
try {
  await act(async () =>
    root.render(
      React.createElement(Workbench, {
        dataSource: source,
        mediaConnected: false,
      }),
    ),
  );
  assert.match(document.body.textContent, /Unknown/);
  await click(button("Inventory"));
  assert.match(
    document.body.textContent,
    /Synthetic camera controller/,
    "Current inventory includes older years by default",
  );
  await fill(document.querySelector('input[type="search"]'), "item-unknown");
  assert.equal(document.querySelectorAll(".wb-inventory-row").length, 1);
  await click(document.querySelector(".wb-item-open"));
  assert.equal(
    button("Record sale").disabled,
    true,
    "Unknown cost cannot silently create zero-cost sale",
  );
  await click(button("Close dialog"));
  await click(button("Add an item"));
  await fill(label("Item name").querySelector("input"), "Synthetic intake");
  await click(button("Inventory"));
  await click(button("Add an item"));
  assert.equal(
    label("Item name").querySelector("input").value,
    "Synthetic intake",
    "Draft survives navigation",
  );
  await act(async () =>
    document
      .querySelector(".wb-form-panel form")
      .dispatchEvent(
        new dom.window.Event("submit", { bubbles: true, cancelable: true }),
      ),
  );
  assert.equal(
    savedItems[0].item_cost,
    null,
    "Unchecked knowledge is saved as unknown, not zero",
  );
  assert.equal(savedItems[0].item_name, "Synthetic intake");
  console.log(
    "PASS actual workbench retains intake draft, searches IDs, includes older current stock, and preserves unknown cost",
  );
  await fill(document.querySelector('input[type="search"]'), "item-known");
  await click(document.querySelector(".wb-item-open"));
  await click(button("Record sale"));
  await fill(label("Marketplace").querySelector("select"), "Mercari");
  await fill(label("Sale price").querySelector("input"), "38");
  await fill(label("Actual platform fee").querySelector("input"), "2");
  await fill(label("Shipping paid separately").querySelector("input"), "0");
  await act(async () =>
    document
      .querySelector(".wb-sale-editor form")
      .dispatchEvent(
        new dom.window.Event("submit", { bubbles: true, cancelable: true }),
      ),
  );
  assert.equal(savedSales[0].inventory_id, "item-known");
  assert.equal(savedSales[0].item_cost, 12);
  assert.equal(savedSales[0].platform_fee, 2);
  assert.equal(savedSales[0].shipping_cost, 0);
  assert.equal(
    inventory.some((item) => item.id === "item-known"),
    false,
  );
  console.log(
    "PASS actual linked sale UI passes original ID and actual costs through the existing save boundary",
  );
  const filters = { ...helpers.initialFilters, year: "2026" };
  assert.equal(helpers.filterInventory([base], filters).length, 1);
  assert.equal(
    helpers.filterInventory([{ ...base, date_added: null }], {
      ...filters,
      start: "2026-01-01",
    }).length,
    0,
  );
  assert.equal(
    helpers.makeCSV(["Name"], [["=SUM(1,2)"]]),
    '"Name"\n"\'=SUM(1,2)"',
  );
  assert.equal(safeMarketplaceUrl("javascript:alert(1)", "Mercari"), null);
  assert.equal(
    safeMarketplaceUrl("https://mercari.com.evil.example/test", "Mercari"),
    null,
  );
  assert.equal(
    safeMarketplaceUrl("https://www.mercari.com/us/item/example", "Mercari"),
    "https://www.mercari.com/us/item/example",
  );
  console.log(
    "PASS reporting filters preserve unknown dates, CSV escapes formulas, and marketplace links reject unsafe or mismatched domains",
  );
  const matches = [];
  await act(async () =>
    root.render(
      React.createElement(ListingMatchDialog, {
        listing: {
          id: "listing-test",
          title: "Synthetic source listing",
          external_listing_id: "source-123",
          observation_id: "observation-before",
          inventory_id: null,
          match_status: "unmatched",
        },
        marketplace: "Mercari",
        inventory: [base],
        save: async (input) => matches.push(input),
        retry: async () => {},
        onSaved: async () => {},
        onClose: () => {},
      }),
    ),
  );
  assert.equal(button("Confirm this item match").disabled, true);
  await click(document.querySelector('input[type="radio"]'));
  await fill(
    document.querySelector("textarea"),
    "Confirmed original item reference and condition.",
  );
  await act(async () =>
    document
      .querySelector("dialog form")
      .dispatchEvent(
        new dom.window.Event("submit", { bubbles: true, cancelable: true }),
      ),
  );
  assert.equal(matches[0].inventoryId, "item-known");
  assert.equal(matches[0].expectedObservationId, "observation-before");
  assert.equal(matches[0].expectedInventoryId, null);
  assert.equal(matches[0].expectedMatchStatus, "unmatched");
  assert.equal(
    matches[0].reason,
    "Confirmed original item reference and condition.",
  );
  console.log(
    "PASS matching requires explicit item and reason and preserves expected observation/prior link",
  );
  let attempts = 0;
  const calls = [],
    revoked = [];
  const api = {
    createMediaUploadIntent: (inventoryId, file) => ({
      requestId: `request-${file.name}`,
      inventoryId,
      file,
    }),
    uploadOriginal: async (intent) => {
      calls.push(intent);
      if (attempts++ === 0) throw new Error("Lost response");
      return { id: intent.requestId, state: "ready" };
    },
    loadOriginalPreview: async () => ({
      url: "blob:synthetic-original",
      revoke: () => revoked.push("revoked"),
    }),
  };
  await act(async () =>
    root.render(
      React.createElement(PhotoLibrary, {
        inventory: [base],
        media: [],
        selectedId: base.id,
        onSelect: () => {},
        onSaved: async () => {},
        api,
        connected: true,
      }),
    ),
  );
  const first = new dom.window.File(["a"], "a.png", { type: "image/png" }),
    second = new dom.window.File(["b"], "b.png", { type: "image/png" });
  const fileInput = document.querySelector('input[type="file"]');
  Object.defineProperty(fileInput, "files", {
    configurable: true,
    value: [first, second],
  });
  await act(async () =>
    fileInput.dispatchEvent(new dom.window.Event("change", { bubbles: true })),
  );
  assert.equal(calls.length, 1, "Queue stops after uncertainty");
  await click(button("Retry unconfirmed uploads"));
  assert.equal(calls.length, 3);
  assert.equal(
    calls[0],
    calls[1],
    "Retry keeps exact original intent and File",
  );
  assert.equal(calls[2].file, second);
  assert.match(document.body.textContent, /Originals saved/);
  console.log(
    "PASS photo queue stops on uncertainty, retries exact File/ID, and continues sequentially",
  );
  await act(async () =>
    root.render(
      React.createElement(PhotoLibrary, {
        inventory: [base],
        media: [
          {
            id: "photo-1",
            inventory_id: base.id,
            kind: "original",
            state: "ready",
            position: 0,
            byte_size: 1,
          },
        ],
        selectedId: base.id,
        onSelect: () => {},
        onSaved: async () => {},
        api,
        connected: true,
      }),
    ),
  );
  await click(button("View original"));
  assert.match(
    document.querySelector("img").alt,
    /Synthetic camera controller/,
  );
  await act(() => root.unmount());
  assert.equal(
    revoked.length,
    1,
    "Private blob URL is revoked on unmount/account switch",
  );
  console.log(
    "PASS original preview has meaningful alt text and releases its local URL on unmount",
  );
  const Reports = load("components/SourceReportBrowser.tsx").default;
  const reportData = {
    accounts: [
      {
        id: "posh",
        marketplace: "Poshmark",
        account_alias: "Synthetic account",
      },
    ],
    snapshots: [
      {
        id: "report-a",
        account_id: "posh",
        scope: "Completed sales in a bounded report period",
        coverage: "complete",
        observed_at: "2026-08-01",
        captured_at: "2026-08-02",
      },
    ],
    listings: [],
  };
  const reportRows = [
    {
      id: "row-bundle",
      account_id: "posh",
      snapshot_id: "report-a",
      row_index: 1,
      source_kind: "csv",
      normalized: {
        title: "Synthetic bundle row",
        bundle_order: true,
        cost_price: null,
        order_price_scope: "whole order",
        reported_money: { "Order Price": "25.00" },
      },
      raw_business: {},
      external_identifiers: {},
      event_precision: "date",
      event_date: "2026-07-30",
      record_status: "accepted",
      captured_at: "2026-08-02",
      source_observed_at: null,
    },
    {
      id: "quarantine",
      account_id: "posh",
      snapshot_id: "report-a",
      row_index: 2,
      source_kind: "csv",
      normalized: {},
      raw_business: { title: "Synthetic malformed row" },
      external_identifiers: {},
      record_status: "quarantined",
      review_reason: "Column count differs",
      captured_at: "2026-08-02",
    },
  ];
  await act(async () =>
    createRoot(document.getElementById("root")).render(
      React.createElement(Reports, { data: reportData, sources: reportRows }),
    ),
  );
  assert.match(document.body.textContent, /Synthetic bundle row/);
  assert.match(document.body.textContent, /Bundle order/);
  assert.match(document.body.textContent, /Unknown \/ not supplied/);
  assert.match(document.body.textContent, /No source identifiers supplied/);
  assert.match(document.body.textContent, /Column count differs/);
  await fill(label("Report or capture").querySelector("select"), "report-a");
  assert.match(
    document.body.textContent,
    /Complete within this capture’s scope/,
  );
  await fill(label("Search report rows").querySelector("input"), "malformed");
  assert.equal(document.querySelectorAll(".wb-report-row").length, 1);
  assert.match(document.body.textContent, /No fields could be safely parsed/);
  console.log(
    "PASS report-only records remain browsable without listing IDs; bundle scope, missing costs, bounded coverage, quarantine and search preserved",
  );
  const { eventLabel } = load("components/SourceReportBrowser.tsx");
  assert.match(
    eventLabel({
      event_precision: "instant",
      event_time: "2026-09-01T10:15:00-04:00",
      event_date: null,
      event_timezone: null,
    }),
    /2026-09-01 14:15:00 UTC/,
  );
  assert.match(
    eventLabel({
      event_precision: "date",
      event_time: null,
      event_date: "2026-09-01",
      event_timezone: null,
    }),
    /time unknown/,
  );
  console.log(
    "PASS known event instants render with explicit UTC when date-only field is null; date-only evidence retains unknown time",
  );
  const exportHost = document.createElement("div");
  document.body.append(exportHost);
  const exportRoot = createRoot(exportHost);
  let finishExport,
    downloads = 0;
  const delayedSource = {
    ...source,
    exportRecords: () =>
      new Promise((resolve) => {
        finishExport = resolve;
      }),
  };
  const oldCreate = URL.createObjectURL,
    oldRevoke = URL.revokeObjectURL;
  URL.createObjectURL = () => {
    downloads++;
    return "blob:private-export";
  };
  URL.revokeObjectURL = () => {};
  await act(async () =>
    exportRoot.render(
      React.createElement(Workbench, {
        dataSource: delayedSource,
        mediaConnected: false,
      }),
    ),
  );
  await act(async () =>
    Array.from(exportHost.querySelectorAll("button"))
      .find((node) => node.textContent.trim() === "Export all records")
      .click(),
  );
  await act(() => exportRoot.unmount());
  await act(async () =>
    finishExport({ tables: { inventory: [{ id: "previous-account" }] } }),
  );
  assert.equal(
    downloads,
    0,
    "Export resolving after sign-out/account-change unmount must not download private records",
  );
  URL.createObjectURL = oldCreate;
  URL.revokeObjectURL = oldRevoke;
  exportHost.remove();
  console.log(
    "PASS late account-scoped export is discarded after AuthGate unmount",
  );
  const DraftDialog = load("components/ListingDraftDialog.tsx").default;
  const { manualDraftOverrides } = load("components/ListingDraftDialog.tsx");
  const draftHost = document.createElement("div");
  document.body.append(draftHost);
  const draftRoot = createRoot(draftHost);
  const draftAccount = {
    id: "synthetic-shop",
    marketplace: "ebay",
    account_alias: "Synthetic shop",
  };
  const draftData = {
    inventory: [base],
    accounts: [draftAccount],
    details: [],
    listings: [],
    media: [],
    snapshots: [],
    actions: [],
    attention: [],
  };
  const draftSaves = [];
  let draftRefresh = 0,
    draftClosed = 0;
  const draftProps = {
    item: base,
    data: draftData,
    save: async (input) => draftSaves.push(input),
    retry: async () => {},
    onSaved: async () => {
      draftRefresh++;
    },
    onClose: () => {
      draftClosed++;
    },
  };
  await act(async () =>
    draftRoot.render(React.createElement(DraftDialog, draftProps)),
  );
  const draftLabel = (text) =>
    Array.from(draftHost.querySelectorAll("label")).find((n) =>
      n.textContent.trim().startsWith(text),
    );
  assert.equal(
    draftLabel("Marketplace account").querySelector("select").value,
    "",
  );
  await fill(
    draftLabel("Marketplace account").querySelector("select"),
    "synthetic-shop",
  );
  await fill(draftLabel("Listing record").querySelector("select"), "new");
  await act(() =>
    Array.from(draftHost.querySelectorAll("button"))
      .find((n) => n.textContent === "Prepare for this shop")
      .click(),
  );
  assert.equal(
    draftLabel("Proposed asking price").querySelector("input").value,
    "",
  );
  assert.equal(draftLabel("Shipping method").querySelector("input").value, "");
  await fill(draftLabel("Proposed asking price").querySelector("input"), "33");
  await fill(draftLabel("Currency").querySelector("input"), "USD");
  await fill(
    draftLabel("Prepared description").querySelector("textarea"),
    "Synthetic factual description",
  );
  await act(async () =>
    draftHost
      .querySelector("form")
      .dispatchEvent(
        new dom.window.Event("submit", { bubbles: true, cancelable: true }),
      ),
  );
  assert.equal(draftSaves.length, 1);
  assert.equal(draftSaves[0].inventory_id, base.id);
  assert.equal(draftSaves[0].account_id, draftAccount.id);
  assert.equal(draftSaves[0].expected_version, 0);
  assert.equal(draftSaves[0].fields.price, null);
  assert.equal(draftSaves[0].overrides.price, 33);
  assert.equal(
    draftSaves[0].overrides.description,
    "Synthetic factual description",
  );
  assert.equal(base.item_cost, 12);
  assert.equal(draftRefresh, 1);
  assert.equal(draftClosed, 1);
  assert.deepEqual(
    manualDraftOverrides(
      { title: "base", price: 20 },
      { title: null, price: 20 },
    ),
    { title: null },
  );
  const staleDraft = {
    id: "stale-listing",
    account_id: draftAccount.id,
    inventory_id: base.id,
    external_listing_id: "synthetic-remote",
    match_status: "confirmed",
    title: "Older preparation",
    draft_version: 2,
    draft_context: {
      inventory_id: "different-item",
      account_id: draftAccount.id,
      fields: { title: "Different physical item" },
    },
    desired_fields: { title: "Different physical item" },
    external_identifiers: {},
    observed_at: null,
  };
  await act(async () =>
    draftRoot.render(
      React.createElement(DraftDialog, {
        ...draftProps,
        key: "stale-context",
        data: { ...draftData, listings: [staleDraft] },
      }),
    ),
  );
  await fill(
    draftLabel("Marketplace account").querySelector("select"),
    "synthetic-shop",
  );
  await fill(
    draftLabel("Listing record").querySelector("select"),
    "stale-listing",
  );
  assert.match(draftHost.textContent, /prepared for a different item link/);
  assert.equal(
    Array.from(draftHost.querySelectorAll("button")).find(
      (n) => n.textContent === "Prepare for this shop",
    ).disabled,
    true,
  );
  assert.equal(
    draftSaves.length,
    1,
    "Stale item copy cannot silently seed a new save",
  );
  console.log(
    "PASS guided draft blocks stale physical-item context after a manual relink",
  );
  for (const scenario of ["different-draft", "newer-edits"]) {
    let recoveredCloses = 0,
      failDraft = true;
    const retrySaves = [];
    const recovered = {
      id: "recovered-listing",
      account_id: draftAccount.id,
      inventory_id:
        scenario === "different-draft" ? "other-physical-item" : base.id,
      external_listing_id: null,
      draft_version: 1,
      draft_context: { inventory_id: base.id, account_id: draftAccount.id },
      desired_fields: { description: "Earlier copy" },
    };
    await act(async () =>
      draftRoot.render(
        React.createElement(DraftDialog, {
          ...draftProps,
          key: scenario,
          save: async (input) => {
            retrySaves.push(input);
            if (failDraft) throw new Error("An earlier draft needs recovery");
          },
          retry: async () => recovered,
          onClose: () => {
            recoveredCloses++;
          },
        }),
      ),
    );
    await fill(
      draftLabel("Marketplace account").querySelector("select"),
      "synthetic-shop",
    );
    await fill(draftLabel("Listing record").querySelector("select"), "new");
    await act(() =>
      Array.from(draftHost.querySelectorAll("button"))
        .find((n) => n.textContent === "Prepare for this shop")
        .click(),
    );
    await fill(
      draftLabel("Prepared description").querySelector("textarea"),
      "Earlier submitted copy",
    );
    await act(async () =>
      draftHost
        .querySelector("form")
        .dispatchEvent(
          new dom.window.Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    await fill(
      draftLabel("Prepared description").querySelector("textarea"),
      "Current edits must survive recovery",
    );
    await act(async () =>
      Array.from(draftHost.querySelectorAll("button"))
        .find((n) => n.textContent === "Retry pending draft save")
        .click(),
    );
    assert.equal(
      recoveredCloses,
      0,
      "Recovery must never close the current draft form",
    );
    assert.equal(
      draftLabel("Prepared description").querySelector("textarea").value,
      "Current edits must survive recovery",
    );
    assert.match(draftHost.textContent, /current edits are still here/);
    failDraft = false;
    await act(async () =>
      draftHost
        .querySelector("form")
        .dispatchEvent(
          new dom.window.Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    assert.equal(
      retrySaves.at(-1).overrides.description,
      "Current edits must survive recovery",
    );
    assert.equal(retrySaves.at(-1).inventory_id, base.id);
    assert.equal(
      retrySaves.at(-1).listing_id,
      scenario === "different-draft" ? undefined : "recovered-listing",
    );
    assert.equal(
      retrySaves.at(-1).expected_version,
      scenario === "different-draft" ? 0 : 1,
    );
    assert.equal(
      recoveredCloses,
      1,
      "Only the explicit current-form save closes it",
    );
  }
  console.log(
    "PASS recovering draft A preserves open draft B; recovering an older payload preserves newer edits until explicitly saved",
  );
  await act(() => draftRoot.unmount());
  draftHost.remove();
  console.log(
    "PASS guided draft requires explicit shop/record, leaves price/shipping unknown, separates shared facts and overrides, preserves item cost and refreshes after save",
  );
  const {
    OperationCards,
    OperationRequestDialog,
    OperationEvidenceDialog,
    OperationActivity,
  } = load("components/OperationViews.tsx");
  const operationHost = document.createElement("div");
  document.body.append(operationHost);
  const operationRoot = createRoot(operationHost);
  const operation = {
    id: "synthetic-operation",
    account_id: draftAccount.id,
    marketplace: "ebay",
    action: "reconcile_shipping",
    state: "blocked",
    execution_mode: "supervised_agent_browser",
    listing_id: null,
    inventory_id: null,
    blockers: [
      { code: "missing_data", message: "Check the exact shipment receipt" },
    ],
    missing_fields: ["source_record_ids"],
    required_fields: ["source_record_ids"],
    deep_link: "https://unrelated.example/unsafe",
    next_step: {
      key: "receipt",
      label: "Review shipping receipt",
      explanation: "Compare the saved carrier evidence with this order.",
    },
    checkpoint: { step_key: "await_receipt" },
    proposal_count: 0,
    verification_id: null,
    verification_observation_id: null,
    created_at: "2026-09-06",
  };
  const opSource = {
    id: "source-same-account",
    account_id: draftAccount.id,
    snapshot_id: "source-snapshot",
    row_index: 1,
    normalized: { title: "Synthetic shipping receipt" },
    raw_business: {},
    external_identifiers: {},
    record_status: "accepted",
    event_precision: "unknown",
    event_date: null,
    event_time: null,
  };
  const opSources = [
    opSource,
    {
      ...opSource,
      id: "source-other-account",
      account_id: "different-shop",
      normalized: { title: "Other shop private row" },
    },
  ];
  await act(async () =>
    operationRoot.render(
      React.createElement(OperationCards, {
        operations: [operation],
        data: draftData,
        onEvidence: () => {},
      }),
    ),
  );
  assert.match(operationHost.textContent, /Check shipping evidence/);
  assert.match(operationHost.textContent, /Review shipping receipt/);
  assert.match(operationHost.textContent, /Account-level evidence review/);
  assert.match(operationHost.textContent, /No verification recorded/);
  assert.equal(
    operationHost.querySelectorAll("a").length,
    0,
    "Unsafe deep link is omitted",
  );
  assert.ok(
    !Array.from(operationHost.querySelectorAll("button")).some((n) =>
      /run|resume|mark.*(done|complete)/i.test(n.textContent),
    ),
  );
  const gmailOperation = {
    ...operation, id: "gmail-review", marketplace: "vinted", adapter_key: "vinted-gmail",
    action: "reconcile_sale", trigger: {kind: "source_record", id: "gmail-source"},
  };
  const gmailSource = {
    ...opSource, id: "gmail-source", source_kind: "email", source_observed_at: "2026-09-04T12:30:00Z",
    raw_business: {received_at: "2026-09-04T12:30:00Z", buyer: "PRIVATE BUYER", body: "PRIVATE BODY"},
    normalized: {parser_version: "vinted-gmail-v1", notification_kind: "sale_notification", parser_status: "recognized", authentication_pass: true, product_titles: ["Synthetic linen jacket"], subject: "PRIVATE SUBJECT"},
  };
  let mailEvidenceClicks = 0;
  const renderMail = async (sources, attention = [], currentOperation = gmailOperation) => act(async () =>
    operationRoot.render(React.createElement(OperationCards, {
      operations: [currentOperation], sources, data: {...draftData, attention},
      onEvidence: () => { mailEvidenceClicks += 1; },
    })),
  );
  await renderMail([gmailSource]);
  const mailContext = () => operationHost.querySelector('[aria-label="Saved email context"]');
  assert.match(operationHost.querySelector('h3').textContent, /Review sale notice/);
  assert.match(mailContext().textContent, /Item named in email: Synthetic linen jacket/);
  assert.equal(mailContext().querySelector('time').dateTime, '2026-09-04T12:30:00.000Z');
  assert.match(mailContext().textContent, /not the sale time/);
  assert.match(mailContext().textContent, /Check the exact shop transaction and physical item/);
  assert.doesNotMatch(mailContext().textContent, /PRIVATE BUYER|PRIVATE BODY|PRIVATE SUBJECT/);
  await renderMail([{...gmailSource, normalized: {...gmailSource.normalized, parser_status: 'quarantined', quarantine_reason: 'mailbox_account_mismatch', product_titles: ['UNTRUSTED TITLE']}}]);
  assert.match(operationHost.querySelector('h3').textContent, /Review unrecognized Vinted email/);
  assert.match(mailContext().textContent, /Item not identified/);
  assert.match(mailContext().textContent, /could not be tied to this Vinted account/);
  assert.doesNotMatch(mailContext().textContent, /UNTRUSTED TITLE/);
  const legacySource = {...gmailSource, normalized: {title: 'OLDER TITLE'}, raw_business: {}, source_observed_at: '2026-09-06T18:00:00Z'};
  const parserReview = {id: 'review-exact', evidence: {operation_id: gmailOperation.id, source_record_id: gmailSource.id, parser_version: 'vinted-gmail-v1', new_parser_facts: gmailSource.normalized, legacy_source_reused: true}};
  await renderMail([legacySource], [parserReview]);
  assert.match(mailContext().textContent, /Synthetic linen jacket/);
  assert.match(mailContext().textContent, /comparison with the retained historical source/);
  assert.match(mailContext().textContent, /Email received time was not saved/);
  assert.equal(mailContext().querySelector('time'), null, 'Legacy capture time cannot become email receipt time');
  await renderMail([legacySource], [{...parserReview, evidence: {...parserReview.evidence, operation_id: 'another-operation'}}]);
  assert.doesNotMatch(mailContext().textContent, /Synthetic linen jacket/);
  await renderMail([{...gmailSource, account_id: 'another-account'}], [parserReview]);
  assert.match(mailContext().textContent, /saved email details are unavailable/);
  assert.doesNotMatch(mailContext().textContent, /Synthetic linen jacket/);
  await renderMail([]);
  assert.match(mailContext().textContent, /Refresh the source records/);
  await renderMail([{...gmailSource, normalized: {...gmailSource.normalized, notification_kind: 'shipping_notification', product_titles: ['Synthetic parcel item', 'person@example.invalid', '<script>bad</script>']}}]);
  assert.match(operationHost.querySelector('h3').textContent, /Review shipping-label notice/);
  assert.match(mailContext().textContent, /Synthetic parcel item/);
  assert.doesNotMatch(mailContext().textContent, /example.invalid|script/);
  assert.equal(mailEvidenceClicks, 0, 'Reading card context never acknowledges evidence or invokes a save');
  assert.equal(operationHost.querySelectorAll('[aria-label="Saved email context"] button').length, 0);
  console.log('PASS Gmail cards expose exact-source item/notice/receipt-time and quarantine reason, honor linked legacy review, hide raw mail and cross-account facts, and remain read-only');
  const capturedOperation = {
    ...operation,
    listing_id: "replacement-record",
    inventory_id: base.id,
    deep_link: "https://www.ebay.com/itm/111111111111",
    verification_id: "original-proof",
  };
  const originalLinkedListing = {
    id: "replacement-record",
    account_id: draftAccount.id,
    inventory_id: base.id,
    external_listing_id: "111111111111",
    title: "Synthetic original listing",
    listing_url: capturedOperation.deep_link,
  };
  const renderTarget = async (listing) =>
    act(async () =>
      operationRoot.render(
        React.createElement(OperationCards, {
          operations: [capturedOperation],
          data: { ...draftData, listings: [listing] },
          onEvidence: () => {},
        }),
      ),
    );
  await renderTarget(originalLinkedListing);
  const currentLinkedId = () =>
    Array.from(operationHost.querySelectorAll("dt")).find(
      (n) => n.textContent === "Current linked listing ID",
    )?.nextElementSibling?.textContent;
  assert.equal(currentLinkedId(), "111111111111");
  await renderTarget({
    ...originalLinkedListing,
    external_listing_id: "222222222222",
    inventory_id: "replacement-item",
    listing_url: "https://www.ebay.com/itm/222222222222",
  });
  assert.equal(
    currentLinkedId(),
    "222222222222",
    "Changed external ID is explicitly labelled as the current linked listing",
  );
  assert.ok(
    !Array.from(operationHost.querySelectorAll("dt")).some(
      (n) => n.textContent === "Listing ID",
    ),
    "Current linked ID must not be presented as an unqualified saved target",
  );
  assert.match(
    operationHost.textContent,
    /Current listing details may differ from the target captured/,
  );
  assert.equal(
    operationHost.querySelector("a").getAttribute("href"),
    capturedOperation.deep_link,
    "Saved request link remains anchored to its captured page",
  );
  assert.match(
    operationHost.querySelector("a").textContent,
    /Open saved marketplace page/,
  );
  assert.match(operationHost.textContent, /original-proof/);
  console.log(
    "PASS changed current listing identity is distinguished from the saved request page and original proof",
  );
  const opLabel = (text) =>
    Array.from(operationHost.querySelectorAll("label")).find((n) =>
      n.textContent.trim().startsWith(text),
    );
  const submitted = [];
  let closedOperation = 0;
  await act(async () =>
    operationRoot.render(
      React.createElement(OperationRequestDialog, {
        context: { source: opSource },
        data: draftData,
        save: async (input) => submitted.push(input),
        retry: async () => {},
        onSaved: async () => {},
        onClose: () => {
          closedOperation++;
        },
      }),
    ),
  );
  await fill(
    opLabel("Requested step").querySelector("select"),
    "reconcile_shipping",
  );
  assert.match(operationHost.textContent, /does not buy or print a label/);
  await fill(
    opLabel("Context for this request").querySelector("textarea"),
    "Check the carrier receipt",
  );
  await act(async () =>
    operationHost
      .querySelector("form")
      .dispatchEvent(
        new dom.window.Event("submit", { bubbles: true, cancelable: true }),
      ),
  );
  assert.equal(submitted[0].listing_id, null);
  assert.equal(submitted[0].inventory_id, null);
  assert.deepEqual(submitted[0].trigger, {
    kind: "source_record",
    id: opSource.id,
  });
  assert.deepEqual(submitted[0].requested.source_record_ids, [opSource.id]);
  assert.equal(submitted[0].action, "reconcile_shipping");
  assert.equal(closedOperation, 1);
  let evidenceArgs;
  await act(async () =>
    operationRoot.render(
      React.createElement(OperationEvidenceDialog, {
        operation,
        sources: opSources,
        save: async (id, input) => {
          evidenceArgs = { id, input };
        },
        retry: async () => {},
        onSaved: async () => {},
        onClose: () => {},
      }),
    ),
  );
  assert.doesNotMatch(operationHost.textContent, /Other shop private row/);
  await act(() =>
    operationHost.querySelector('input[type="checkbox"]').click(),
  );
  await act(async () =>
    operationHost
      .querySelector("form")
      .dispatchEvent(
        new dom.window.Event("submit", { bubbles: true, cancelable: true }),
      ),
  );
  assert.equal(evidenceArgs.id, operation.id);
  assert.deepEqual(evidenceArgs.input.source_record_ids, [opSource.id]);
  assert.equal(operation.state, "blocked");
  let recoveryClose = 0;
  await act(async () =>
    operationRoot.render(
      React.createElement(OperationEvidenceDialog, {
        key: "evidence-recovery",
        operation,
        sources: opSources,
        save: async () => {
          throw new Error("Previous evidence pending");
        },
        retry: async () => ({
          resultId: "previous-proposal",
          command: {
            kind: "evidence",
            operationId: "a-different-operation",
            input: { source_record_ids: [], note: "Earlier note" },
          },
        }),
        onSaved: async () => {},
        onClose: () => {
          recoveryClose++;
        },
      }),
    ),
  );
  await fill(
    opLabel("What should be checked?").querySelector("textarea"),
    "New evidence note",
  );
  await act(async () =>
    operationHost
      .querySelector("form")
      .dispatchEvent(
        new dom.window.Event("submit", { bubbles: true, cancelable: true }),
      ),
  );
  await act(async () =>
    Array.from(operationHost.querySelectorAll("button"))
      .find((n) => n.textContent === "Retry pending request")
      .click(),
  );
  assert.equal(recoveryClose, 0);
  assert.equal(
    opLabel("What should be checked?").querySelector("textarea").value,
    "New evidence note",
  );
  await act(async () =>
    operationRoot.render(
      React.createElement(OperationActivity, {
        operations: [],
        error: "Activity unavailable; refresh before another request",
        data: draftData,
        itemId: "",
        onClearItem: () => {},
        onEvidence: () => {},
        onItem: () => {},
      }),
    ),
  );
  assert.match(
    operationHost.querySelector('[role="alert"]').textContent,
    /Activity unavailable/,
  );
  assert.doesNotMatch(operationHost.textContent, /No requests/);
  await act(() => operationRoot.unmount());
  operationHost.remove();
  console.log(
    "PASS nullable-listing activity, exact source request, same-account evidence, untrusted proof boundary, safe deep links, recoverable notes and explicit activity read errors",
  );
  const soldHost = document.createElement("div");
  document.body.append(soldHost);
  const soldRoot = createRoot(soldHost);
  const soldItem = { ...base, status: "sold" };
  const soldSource = {
    ...source,
    getResaleWorkbench: async () => ({ ...draftData, inventory: [soldItem] }),
    getResaleOperations: async () => [{ ...operation, inventory_id: base.id }],
  };
  await act(async () =>
    soldRoot.render(
      React.createElement(Workbench, {
        dataSource: soldSource,
        mediaConnected: false,
      }),
    ),
  );
  await act(() =>
    Array.from(soldHost.querySelectorAll("button"))
      .find((n) => n.textContent.trim() === "Shop activity")
      .click(),
  );
  await act(() =>
    Array.from(soldHost.querySelectorAll("button"))
      .find((n) => n.textContent.trim() === "Review physical item")
      .click(),
  );
  assert.ok(
    Array.from(soldHost.querySelectorAll(".wb-badge")).some(
      (n) => n.textContent === "Sold",
    ),
  );
  for (const name of [
    "Edit item details",
    "Prepare marketplace draft",
    "Record sale",
  ])
    assert.equal(
      Array.from(soldHost.querySelectorAll("button")).find(
        (n) => n.textContent.trim() === name,
      ).disabled,
      true,
      `${name} is disabled for sold physical item opened from activity`,
    );
  await act(() => soldRoot.unmount());
  soldHost.remove();
  console.log(
    "PASS activity can inspect sold physical history without enabling fresh sale/draft/item writes",
  );
} finally {
  dom.window.close();
}

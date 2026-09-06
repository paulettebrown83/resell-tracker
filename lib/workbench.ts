import type { Expense, InventoryItem, Sale } from "./supabase";

export const MARKETPLACES = [
  "Poshmark",
  "Mercari",
  "Depop",
  "Vinted",
  "eBay",
] as const;
export const money = (amount: number | null | undefined) =>
  amount == null
    ? "Unknown"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
      }).format(amount);
export const dateLabel = (date: string | null) =>
  date
    ? new Date(`${date.slice(0, 10)}T12:00:00`).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "Date not recorded";
export const localDate = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
};
export const needsSaleReview = (sale: Sale) =>
  sale.settlement_status === "legacy_unverified" ||
  sale.item_cost == null ||
  sale.shipping_cost == null;
export type Filters = {
  search: string;
  platform: string;
  start: string;
  end: string;
  year: string;
  sort: string;
};
export const initialFilters: Filters = {
  search: "",
  platform: "all",
  start: "",
  end: "",
  year: "all",
  sort: "newest",
};
const matches = (name: string, id: string, query: string) =>
  `${name} ${id}`.toLowerCase().includes(query.trim().toLowerCase());
const inDates = (date: string | null, filters: Filters, useYear: boolean) => {
  if (
    (filters.start || filters.end || (useYear && filters.year !== "all")) &&
    !date
  )
    return false;
  return (
    (!filters.start || date! >= filters.start) &&
    (!filters.end || date!.slice(0, 10) <= filters.end) &&
    (!useYear || filters.year === "all" || date!.startsWith(filters.year))
  );
};
export function filterInventory(items: InventoryItem[], filters: Filters) {
  return items
    .filter(
      (item) =>
        matches(item.item_name, item.id, filters.search) &&
        (filters.platform === "all" ||
          item.platforms.includes(filters.platform)) &&
        inDates(item.date_added, filters, false),
    )
    .sort((a, b) =>
      filters.sort === "name"
        ? a.item_name.localeCompare(b.item_name)
        : (b.date_added || "").localeCompare(a.date_added || "") ||
          a.id.localeCompare(b.id),
    );
}
export function filterSales(sales: Sale[], filters: Filters) {
  return sales
    .filter(
      (sale) =>
        matches(
          sale.item_name,
          `${sale.id} ${sale.source_record_id || ""}`,
          filters.search,
        ) &&
        (filters.platform === "all" || sale.platform === filters.platform) &&
        inDates(sale.sale_date, filters, true),
    )
    .sort((a, b) =>
      filters.sort === "name"
        ? a.item_name.localeCompare(b.item_name)
        : b.sale_date.localeCompare(a.sale_date) || a.id.localeCompare(b.id),
    );
}
export function filterExpenses(expenses: Expense[], filters: Filters) {
  return expenses
    .filter(
      (expense) =>
        matches(expense.name, expense.id, filters.search) &&
        inDates(expense.date_added, filters, true),
    )
    .sort((a, b) =>
      filters.sort === "name"
        ? a.name.localeCompare(b.name)
        : b.date_added.localeCompare(a.date_added) || a.id.localeCompare(b.id),
    );
}
// Spreadsheet programs may execute a cell as a formula. Keep IDs and escape formula prefixes.
export function makeCSV(headers: string[], rows: string[][]) {
  const escape = (cell: string) =>
    `"${(/^[=+@\-\t\r]/.test(cell) ? `'${cell}` : cell).replace(/"/g, '""')}"`;
  return [
    headers.map(escape).join(","),
    ...rows.map((row) => row.map(escape).join(",")),
  ].join("\n");
}

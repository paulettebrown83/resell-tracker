import { supabase, requireWritableDeployment } from "./supabase";
import { saveResaleItem } from "./resale-data";
import type { ResaleItemInput } from "./resale-contract";

type PendingItem = { requestId: string; input: ResaleItemInput };
async function storageKey() {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) throw new Error("Sign in before saving an item.");
  return `resale-item-pending:${session.user.id}`;
}
async function send(key: string, request: PendingItem, retry: boolean) {
  try {
    const id = await saveResaleItem(request.input, request.requestId);
    sessionStorage.removeItem(key);
    return id;
  } catch (failure) {
    const code =
      failure && typeof failure === "object" && "code" in failure
        ? String(failure.code)
        : "";
    if (/^(22|23|P0|40001)/.test(code) || (!retry && code === "42501")) {
      sessionStorage.removeItem(key);
      throw new Error(
        code === "40001"
          ? "This item changed elsewhere. Refresh records and reopen it before editing."
          : "The item was not saved. Check the entered details and your account access.",
      );
    }
    throw new Error(
      "The item save could not be confirmed. Use Retry pending item save before saving another item. Keep this browser tab open.",
    );
  }
}
export async function saveItemWithRetry(input: ResaleItemInput) {
  requireWritableDeployment();
  const key = await storageKey();
  if (sessionStorage.getItem(key))
    throw new Error(
      "A previous item save needs verification. Use Retry pending item save first.",
    );
  const request = { requestId: crypto.randomUUID(), input };
  sessionStorage.setItem(key, JSON.stringify(request));
  return send(key, request, false);
}
export async function retryPendingItemSave() {
  requireWritableDeployment();
  const key = await storageKey(),
    raw = sessionStorage.getItem(key);
  if (!raw)
    throw new Error("There is no pending item save in this browser tab.");
  return send(key, JSON.parse(raw), true);
}

import { supabase, requireWritableDeployment } from "./supabase";
import {
  saveListingDraft,
  type ListingDraftInput,
  type PreparedListing,
} from "./resale-drafts";
export type SaveDraft = (
  input: ListingDraftInput,
  requestId: string,
) => Promise<PreparedListing>;
type Pending = { requestId: string; input: ListingDraftInput };
async function accountKey() {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) throw new Error("Sign in before saving a marketplace draft.");
  return `resale-draft-pending:${session.user.id}`;
}
async function send(
  key: string,
  request: Pending,
  save: SaveDraft,
  retry: boolean,
) {
  try {
    const result = await save(request.input, request.requestId);
    sessionStorage.removeItem(key);
    return result;
  } catch (failure) {
    const code =
      failure && typeof failure === "object" && "code" in failure
        ? String(failure.code)
        : "";
    if (/^(22|23|P0|40001)/.test(code) || (!retry && code === "42501")) {
      sessionStorage.removeItem(key);
      throw new Error(
        code === "23505"
          ? "A local draft already exists for this item and shop. Refresh records and choose that draft."
          : code === "40001"
            ? "The saved draft or item link changed. Close this form, refresh records, and review the latest draft."
            : "This draft was not saved. Check the item, account, and entered fields.",
      );
    }
    throw new Error(
      "The draft save was not confirmed. Retry the pending draft before saving another version.",
    );
  }
}
export async function saveDraftWithRetry(
  input: ListingDraftInput,
  save: SaveDraft = saveListingDraft,
) {
  requireWritableDeployment();
  const key = await accountKey();
  if (sessionStorage.getItem(key))
    throw new Error(
      "A previous draft save needs verification. Retry the pending draft first.",
    );
  const request = { requestId: crypto.randomUUID(), input };
  sessionStorage.setItem(key, JSON.stringify(request));
  return send(key, request, save, false);
}
export async function retryPendingDraft(save: SaveDraft = saveListingDraft) {
  requireWritableDeployment();
  const key = await accountKey(),
    raw = sessionStorage.getItem(key);
  if (!raw)
    throw new Error("There is no pending draft save in this browser tab.");
  return send(key, JSON.parse(raw), save, true);
}

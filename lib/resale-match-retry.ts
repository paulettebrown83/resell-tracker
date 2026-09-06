import { supabase, requireWritableDeployment } from "./supabase";
import type { ResaleListing } from "./resale-contract";
export type MatchConfirmation = {
  listingId: string;
  inventoryId: string;
  expectedObservationId: string | null;
  expectedInventoryId: string | null;
  expectedMatchStatus: ResaleListing["match_status"];
  reason: string;
};
export type ConfirmMatch = (
  input: MatchConfirmation,
  requestId: string,
) => Promise<ResaleListing>;
type Request = { requestId: string; input: MatchConfirmation };
async function keyForAccount() {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) throw new Error("Sign in before matching a listing.");
  return `resale-match-pending:${session.user.id}`;
}
async function send(
  key: string,
  request: Request,
  confirm: ConfirmMatch,
  retry: boolean,
) {
  try {
    const result = await confirm(request.input, request.requestId);
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
        code === "40001"
          ? "This listing changed. Close this dialog, refresh records, and review the match again."
          : "The match was not saved. Check that the item is available and review the selected records.",
      );
    }
    throw new Error(
      "The match was not confirmed. Retry the pending match before making another match decision.",
    );
  }
}
export async function saveMatchWithRetry(
  input: MatchConfirmation,
  confirm: ConfirmMatch,
) {
  requireWritableDeployment();
  const key = await keyForAccount();
  if (sessionStorage.getItem(key))
    throw new Error(
      "A previous match needs verification. Retry the pending match first.",
    );
  const request = { requestId: crypto.randomUUID(), input };
  sessionStorage.setItem(key, JSON.stringify(request));
  return send(key, request, confirm, false);
}
export async function retryPendingMatch(confirm: ConfirmMatch) {
  requireWritableDeployment();
  const key = await keyForAccount(),
    raw = sessionStorage.getItem(key);
  if (!raw) throw new Error("There is no pending match in this browser tab.");
  return send(key, JSON.parse(raw), confirm, true);
}

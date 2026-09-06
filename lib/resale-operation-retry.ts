import { supabase, requireWritableDeployment } from "./supabase";
import {
  requestResaleOperation,
  submitResaleOperationEvidence,
  type OperationRequest,
  type OperationEvidenceProposal,
} from "./resale-operations";
export type OperationIntent = Omit<OperationRequest, "trigger"> & {
  trigger?: OperationRequest["trigger"];
};
export type OperationAPI = {
  request: typeof requestResaleOperation;
  evidence: typeof submitResaleOperationEvidence;
};
const live: OperationAPI = {
  request: requestResaleOperation,
  evidence: submitResaleOperationEvidence,
};
type Command =
  | { kind: "request"; input: OperationRequest }
  | { kind: "evidence"; operationId: string; input: OperationEvidenceProposal };
type Pending = { requestId: string; command: Command };
export type OperationRecovery = { resultId: string; command: Command };
export function operationRecoveryMatches(
  recovery: OperationRecovery,
  expected:
    | { kind: "request"; input: OperationIntent }
    | Extract<Command, { kind: "evidence" }>,
) {
  function normalize(command: typeof expected | Command) {
    if (command.kind === "evidence") return command;
    const input = { ...command.input };
    if (input.trigger?.kind === "member_request") delete input.trigger;
    return { ...command, input };
  }
  function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, entry]) => [key, canonical(entry)]),
      );
    return value;
  }
  return (
    JSON.stringify(canonical(normalize(recovery.command))) ===
    JSON.stringify(canonical(normalize(expected)))
  );
}
async function accountKey() {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) throw new Error("Sign in before saving a shop request.");
  return `resale-operation-pending:${session.user.id}`;
}
async function send(
  key: string,
  pending: Pending,
  api: OperationAPI,
  retry: boolean,
) {
  try {
    const { command, requestId } = pending;
    const result =
      command.kind === "request"
        ? await api.request(command.input, requestId)
        : await api.evidence(command.operationId, command.input, requestId);
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
          ? "The item or listing changed. Refresh records and review the request again."
          : "This request was not saved. Review the account, exact records and required details.",
      );
    }
    throw new Error(
      "The request was not confirmed. Retry the pending request before creating another one.",
    );
  }
}
async function reserve(build: (id: string) => Command, api: OperationAPI) {
  requireWritableDeployment();
  const key = await accountKey();
  if (sessionStorage.getItem(key))
    throw new Error(
      "A previous shop request needs verification. Retry it before starting another request.",
    );
  const requestId = crypto.randomUUID(),
    pending = { requestId, command: build(requestId) };
  const serialized = JSON.stringify(pending);
  sessionStorage.setItem(key, serialized);
  return send(key, JSON.parse(serialized), api, false);
}
export function requestOperationWithRetry(
  input: OperationIntent,
  api: OperationAPI = live,
) {
  return reserve(
    (requestId) => ({
      kind: "request",
      input: {
        ...input,
        trigger: input.trigger || { kind: "member_request", id: requestId },
      },
    }),
    api,
  );
}
export function submitOperationEvidenceWithRetry(
  operationId: string,
  input: OperationEvidenceProposal,
  api: OperationAPI = live,
) {
  return reserve(() => ({ kind: "evidence", operationId, input }), api);
}
export async function retryPendingOperation(api: OperationAPI = live) {
  requireWritableDeployment();
  const key = await accountKey(),
    raw = sessionStorage.getItem(key);
  if (!raw)
    throw new Error("There is no pending shop request in this browser tab.");
  const pending: Pending = JSON.parse(raw);
  const resultId = await send(key, pending, api, true);
  return { resultId, command: pending.command } satisfies OperationRecovery;
}

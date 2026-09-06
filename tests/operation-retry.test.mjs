import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
const require = createRequire(new URL("../package.json", import.meta.url));
const ts = require("typescript");
const source = ts.transpileModule(
  fs.readFileSync(
    new URL("../lib/resale-operation-retry.ts", import.meta.url),
    "utf8",
  ),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  },
).outputText;
let account = "synthetic-one",
  failure = { message: "Lost response" },
  preview = false;
const storage = new Map(),
  calls = [];
const context = {
  exports: {},
  crypto,
  sessionStorage: {
    getItem: (key) => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  },
  require: () => ({
    supabase: {
      auth: {
        getSession: async () => ({
          data: { session: { user: { id: account } } },
        }),
      },
    },
    requireWritableDeployment: () => {
      if (preview) throw new Error("Read only");
    },
  }),
};
vm.runInNewContext(source, context);
const api = context.exports;
const network = {
  request: async (input, id) => {
    calls.push({ kind: "request", input, id });
    if (failure) throw failure;
    return "operation-id";
  },
  evidence: async (operationId, input, id) => {
    calls.push({ kind: "evidence", operationId, input, id });
    if (failure) throw failure;
    return "proposal-id";
  },
};
const input = {
  account_id: "shop",
  action: "update",
  listing_id: "listing",
  inventory_id: "item",
  expected_observation_id: "observation",
  expected_item_version: 2,
  requested: { fields: { price: 33 }, note: "Synthetic" },
};
await assert.rejects(() => api.requestOperationWithRetry(input, network));
assert.equal(calls[0].input.trigger.kind, "member_request");
assert.equal(calls[0].input.trigger.id, calls[0].id);
input.requested.fields.price = 99;
assert.equal(
  calls[0].input.requested.fields.price,
  33,
  "Original request is a captured snapshot, not a mutable caller reference",
);
await assert.rejects(
  () =>
    api.submitOperationEvidenceWithRetry(
      "other",
      { source_record_ids: [], note: "Attempt another" },
      network,
    ),
  /previous shop request/,
);
account = "synthetic-two";
await assert.rejects(() => api.retryPendingOperation(network), /no pending/);
account = "synthetic-one";
failure = { code: "42501" };
await assert.rejects(() => api.retryPendingOperation(network));
assert.equal(storage.size, 1);
failure = null;
await api.retryPendingOperation(network);
assert.equal(storage.size, 0);
assert.equal(JSON.stringify(calls[0]), JSON.stringify(calls[2]));
failure = { message: "Unconfirmed evidence response" };
await assert.rejects(() =>
  api.submitOperationEvidenceWithRetry(
    "operation-id",
    { source_record_ids: ["source-1"], note: "Check the recorded result" },
    network,
  ),
);
const evidence = calls.at(-1);
failure = null;
await api.retryPendingOperation(network);
assert.equal(JSON.stringify(evidence), JSON.stringify(calls.at(-1)));
failure = { code: "40001" };
await assert.rejects(
  () => api.requestOperationWithRetry(input, network),
  /listing changed/,
);
assert.equal(storage.size, 0);
preview = true;
await assert.rejects(
  () => api.requestOperationWithRetry(input, network),
  /Read only/,
);
console.log(
  "PASS exact member trigger/request identity, immutable desired snapshot, account isolation, uncertain request/evidence retry, stale rollback and preview denial",
);

const receipt = {
  resultId: "operation",
  command: {
    kind: "request",
    input: {
      account_id: "shop",
      action: "update",
      trigger: { kind: "member_request", id: "request" },
      requested: { note: "Current" },
    },
  },
};
assert.equal(
  api.operationRecoveryMatches(receipt, {
    kind: "request",
    input: {
      action: "update",
      account_id: "shop",
      requested: { note: "Current" },
    },
  }),
  true,
);
assert.equal(
  api.operationRecoveryMatches(receipt, {
    kind: "request",
    input: {
      action: "update",
      account_id: "shop",
      requested: { note: "Newer edits" },
    },
  }),
  false,
);
assert.equal(
  api.operationRecoveryMatches(receipt, {
    kind: "request",
    input: {
      action: "update",
      account_id: "other-shop",
      requested: { note: "Current" },
    },
  }),
  false,
);
console.log(
  "PASS recovery closes a form only for the exact current command and target; member trigger IDs do not fabricate a match across edits or accounts",
);

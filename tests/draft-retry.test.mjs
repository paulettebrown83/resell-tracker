import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
const source = ts.transpileModule(
  fs.readFileSync(
    new URL("../lib/resale-draft-retry.ts", import.meta.url),
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
  fail = { message: "Lost response" },
  preview = false;
const store = new Map(),
  calls = [];
const context = {
  exports: {},
  crypto,
  sessionStorage: {
    getItem: (key) => store.get(key) || null,
    setItem: (key, value) => store.set(key, value),
    removeItem: (key) => store.delete(key),
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
      if (preview) throw Error("Read only");
    },
  }),
};
vm.runInNewContext(source, context);
const api = context.exports,
  input = {
    listing_id: "listing",
    inventory_id: "inventory",
    account_id: "shop",
    expected_version: 2,
    channel: "consumer",
    rules_version: "synthetic",
    fields: { title: "Starting facts", price: null },
    overrides: { price: 33 },
    preferences: { avoid_emojis: true },
  };
const confirm = async (input, requestId) => {
  calls.push({ input, requestId });
  if (fail) throw fail;
  return { id: input.listing_id };
};
await assert.rejects(() => api.saveDraftWithRetry(input, confirm));
await assert.rejects(
  () => api.saveDraftWithRetry(input, confirm),
  /previous draft/,
);
assert.equal(calls.length, 1);
account = "synthetic-two";
await assert.rejects(() => api.retryPendingDraft(confirm), /no pending/);
account = "synthetic-one";
fail = { code: "42501" };
await assert.rejects(() => api.retryPendingDraft(confirm));
assert.equal(store.size, 1);
fail = null;
await api.retryPendingDraft(confirm);
assert.equal(store.size, 0);
assert.equal(JSON.stringify(calls[0]), JSON.stringify(calls[2]));
fail = { code: "40001" };
await assert.rejects(
  () => api.saveDraftWithRetry(input, confirm),
  /draft or item link changed/,
);
assert.equal(store.size, 0);
preview = true;
await assert.rejects(() => api.saveDraftWithRetry(input, confirm), /Read only/);
console.log(
  "PASS draft retry keeps exact draft fields, overrides, version and UUID, isolates accounts, retains uncertain revocations, and clears stale-version rollback",
);

import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
const source = ts.transpileModule(
  fs.readFileSync(new URL("../lib/resale-intake.ts", import.meta.url), "utf8"),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  },
).outputText;
const storage = new Map(),
  calls = [];
let account = "one",
  failure = { message: "Network lost" },
  preview = false;
const context = {
  exports: {},
  crypto,
  sessionStorage: {
    getItem: (key) => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  },
  require(name) {
    return name === "./supabase"
      ? {
          supabase: {
            auth: {
              getSession: async () => ({
                data: { session: { user: { id: account } } },
              }),
            },
          },
          requireWritableDeployment() {
            if (preview) throw Error("Read only");
          },
        }
      : {
          saveResaleItem: async (input, id) => {
            calls.push({ input, id });
            if (failure) throw failure;
            return "item-id";
          },
        };
  },
};
vm.runInNewContext(source, context);
const api = context.exports;
await assert.rejects(() =>
  api.saveItemWithRetry({ item_name: "Synthetic intake", item_cost: null }),
);
assert.equal(storage.size, 1);
await assert.rejects(
  () => api.saveItemWithRetry({ item_name: "Duplicate risk", item_cost: 0 }),
  /previous item save/,
);
assert.equal(calls.length, 1);
account = "two";
await assert.rejects(() => api.retryPendingItemSave(), /no pending/);
account = "one";
failure = { code: "42501" };
await assert.rejects(() => api.retryPendingItemSave());
assert.equal(
  storage.size,
  1,
  "Revocation must not discard an uncertain committed request",
);
failure = null;
await api.retryPendingItemSave();
assert.equal(storage.size, 0);
assert.equal(JSON.stringify(calls[0]), JSON.stringify(calls[2]));
assert.equal(calls[2].input.item_cost, null);
failure = { code: "40001" };
await assert.rejects(
  () =>
    api.saveItemWithRetry({
      id: "same",
      version: 1,
      item_name: "Correction",
      item_cost: 12,
    }),
  /changed elsewhere/,
);
assert.equal(storage.size, 0);
preview = true;
await assert.rejects(
  () => api.saveItemWithRetry({ item_name: "No write", item_cost: 0 }),
  /Read only/,
);
assert.equal(storage.size, 0);
console.log(
  "PASS item retry preserves exact payload/UUID across lost responses, isolates accounts, retains denied retries, clears confirmed rollback, and blocks previews",
);

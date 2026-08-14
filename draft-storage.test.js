const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");

function loadDraftStorage(sessionValues = {}, localValues = {}) {
  const events = [];
  const makeArea = (name, initialValues) => {
    const values = { ...initialValues };
    return {
      values,
      get: async () => ({ ...values }),
      set: async (updates) => {
        events.push({ name, type: "set", updates });
        Object.assign(values, updates);
      },
      remove: async (keys) => {
        events.push({ name, type: "remove", keys: [...keys] });
        keys.forEach((key) => delete values[key]);
      }
    };
  };
  const session = makeArea("session", sessionValues);
  const local = makeArea("local", localValues);
  const context = {
    chrome: { storage: { session, local } },
    console,
    Date,
    Math
  };

  vm.runInNewContext(readFileSync("draft-storage.js", "utf8"), context, {
    filename: "draft-storage.js"
  });
  return { api: context.SfdgDraftStorage, events, local, session };
}

test("draft listing merges storage fallbacks and keeps the newest value", async () => {
  const { api } = loadDraftStorage(
    {
      "sfdg:draft:one": { value: "new", updatedAt: 20 },
      unrelated: true
    },
    {
      "sfdg:draft:one": { value: "old", updatedAt: 10 },
      "sfdg:draft:two": { value: "second", updatedAt: 15 }
    }
  );

  const drafts = await api.listDrafts();

  assert.deepEqual(
    JSON.parse(JSON.stringify(drafts.map((draft) => [draft.key, draft.value]))),
    [
      ["sfdg:draft:one", "new"],
      ["sfdg:draft:two", "second"]
    ]
  );
});

test("clear all signals live frames before removing every draft and preserves settings", async () => {
  const { api, events, local, session } = loadDraftStorage(
    { "sfdg:draft:one": { value: "one" } },
    { "sfdg:draft:two": { value: "two" }, showToasts: false }
  );

  const clearedCount = await api.clearAllDrafts();

  assert.equal(clearedCount, 2);
  assert.equal(events[0].type, "set");
  assert.equal(events[0].name, "local");
  assert.equal(events[0].updates["sfdg:draft-clear-signal"].all, true);
  assert.equal(session.values["sfdg:draft:one"], undefined);
  assert.equal(local.values["sfdg:draft:two"], undefined);
  assert.equal(local.values.showToasts, false);
});

test("clear all still signals pending caches when storage has no drafts", async () => {
  const { api, events } = loadDraftStorage({}, { showToasts: true });

  assert.equal(await api.clearAllDrafts(), 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].updates["sfdg:draft-clear-signal"].all, true);
});

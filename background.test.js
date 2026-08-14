const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");

function loadBackground(sessionValues = {}, localValues = {}) {
  const removed = { session: [], local: [] };
  const written = { session: [], local: [] };
  const makeArea = (name, values, withAccessLevel = false) => ({
    get: async () => ({ ...values }),
    remove: async (keys) => removed[name].push(...keys),
    set: async (value) => written[name].push(value),
    ...(withAccessLevel ? { setAccessLevel: async () => {} } : {})
  });
  const listeners = {};
  const context = {
    chrome: {
      runtime: {
        onInstalled: { addListener: (listener) => { listeners.installed = listener; } },
        onStartup: { addListener: (listener) => { listeners.startup = listener; } },
        onMessage: { addListener: (listener) => { listeners.message = listener; } }
      },
      storage: {
        session: makeArea("session", sessionValues, true),
        local: makeArea("local", localValues)
      }
    },
    console
  };

  vm.runInNewContext(readFileSync("background.js", "utf8"), context, { filename: "background.js" });
  return { context, listeners, removed, written };
}

test("every frame in a Chrome tab receives the same tab context", () => {
  const { listeners } = loadBackground();
  const responses = [];

  listeners.message(
    { type: "sfdg:get-tab-context" },
    { tab: { id: 42 }, frameId: 0 },
    (response) => responses.push(response.tabContext)
  );
  listeners.message(
    { type: "sfdg:get-tab-context" },
    { tab: { id: 42 }, frameId: 7 },
    (response) => responses.push(response.tabContext)
  );

  assert.deepEqual(responses, ["tab-42", "tab-42"]);
});

test("different Chrome tabs receive different draft contexts", () => {
  const { listeners } = loadBackground();
  const responses = [];

  listeners.message(
    { type: "sfdg:get-tab-context" },
    { tab: { id: 42 } },
    (response) => responses.push(response.tabContext)
  );
  listeners.message(
    { type: "sfdg:get-tab-context" },
    { tab: { id: 43 } },
    (response) => responses.push(response.tabContext)
  );

  assert.deepEqual(responses, ["tab-42", "tab-43"]);
});

test("a missing draft schema removes only unsafe legacy drafts", async () => {
  const { listeners, removed, written } = loadBackground(
    { "sfdg:draft:session": { value: "old" }, unrelated: true },
    { "sfdg:draft:local": { value: "old" }, showToasts: false }
  );

  await listeners.installed({ reason: "update", previousVersion: "0.6.0" });

  assert.deepEqual(removed.session, ["sfdg:draft:session"]);
  assert.deepEqual(removed.local, ["sfdg:draft:local"]);
  assert.equal(written.local.length, 1);
  assert.equal(written.local[0]["sfdg:draft-schema"], 3);
});

test("current-schema reloads do not purge drafts", async () => {
  const { listeners, removed } = loadBackground(
    { "sfdg:draft:session": { value: "current" } },
    { "sfdg:draft:local": { value: "current" }, "sfdg:draft-schema": 3 }
  );

  await listeners.installed({ reason: "update", previousVersion: "0.6.0" });

  assert.deepEqual(removed.session, []);
  assert.deepEqual(removed.local, []);
});

test("the 0.6.3 schema upgrade purges drafts that lack verified record ownership", async () => {
  const { listeners, removed, written } = loadBackground(
    { "sfdg:draft:session": { value: "unsafe Email chain" } },
    { "sfdg:draft:local": { value: "unsafe Post" }, "sfdg:draft-schema": 2 }
  );

  await listeners.installed({ reason: "update", previousVersion: "0.6.2" });

  assert.deepEqual(removed.session, ["sfdg:draft:session"]);
  assert.deepEqual(removed.local, ["sfdg:draft:local"]);
  assert.equal(written.local[0]["sfdg:draft-schema"], 3);
});

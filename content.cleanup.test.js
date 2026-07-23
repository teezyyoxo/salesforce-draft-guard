const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");

function loadDraftGuardFunctions() {
  const source = readFileSync("content.js", "utf8").replace("\nbootstrap();\n", "\n");
  const storageArea = {
    get: async () => ({}),
    set: async () => {},
    remove: async () => {}
  };
  const context = {
    URL,
    console,
    setTimeout,
    clearTimeout,
    chrome: {
      storage: {
        session: storageArea,
        local: storageArea,
        sync: storageArea,
        onChanged: { addListener: () => {} }
      }
    },
    document: { readyState: "complete" },
    location: { href: "https://example.lightning.force.com/lightning/r/Case/500000000000001/view" },
    window: {
      location: { href: "https://example.lightning.force.com/lightning/r/Case/500000000000001/view" },
      addEventListener: () => {},
      setTimeout,
      clearTimeout
    }
  };

  context.window.top = context.window;
  vm.runInNewContext(source, context, { filename: "content.js" });
  return context;
}

test("a record Details Save cannot target Email or Post drafts", () => {
  const { draftMetadataMatchesAction } = loadDraftGuardFunctions();
  const detailsScope = "details-scope";
  const emailScope = "email-scope";

  assert.equal(
    draftMetadataMatchesAction(
      { actionType: "email", scope: emailScope },
      detailsScope,
      "activity",
      "save",
      emailScope
    ),
    false
  );
  assert.equal(
    draftMetadataMatchesAction(
      { actionType: "post", scope: detailsScope },
      detailsScope,
      "activity",
      "save",
      emailScope
    ),
    false
  );
});

test("only matching Email and Post submission responses consume their pending actions", () => {
  const { networkResultMatchesPendingAction } = loadDraftGuardFunctions();

  assert.equal(
    networkResultMatchesPendingAction(
      { url: "/services/data/v66.0/connect/records/500000000000001" },
      { actionLabel: "send" }
    ),
    false
  );
  assert.equal(
    networkResultMatchesPendingAction(
      { url: "/services/data/v66.0/connect/records/500000000000001" },
      { actionLabel: "post" }
    ),
    false
  );
  assert.equal(
    networkResultMatchesPendingAction(
      { url: "/services/data/v66.0/sobjects/EmailMessages" },
      { actionLabel: "send" }
    ),
    true
  );
  assert.equal(
    networkResultMatchesPendingAction(
      { url: "/services/data/v66.0/connect/communities/internal/chatter/feed-elements" },
      { actionLabel: "post" }
    ),
    true
  );
});

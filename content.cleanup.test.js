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
  assert.equal(
    networkResultMatchesPendingAction(
      { url: "/aura?r=3628&ui-chatter-components-aura-components-forceChatter-chatter.FeedItemAction.create=1" },
      { actionLabel: "share" }
    ),
    true
  );
  assert.equal(
    networkResultMatchesPendingAction(
      { url: "/aura?r=3869&ui-support-components-aura-components-emailquickaction.EmailQuickAction.logSuccessfulSending=1" },
      { actionLabel: "send" }
    ),
    true
  );
  assert.equal(
    networkResultMatchesPendingAction(
      { url: "/aura?r=3866&ui-force-components-controllers-recordGlobalValueProvider.RecordGvp.saveQuickActionRecords=1" },
      { actionLabel: "send" }
    ),
    false
  );
});

test("a Post submission cannot target a simultaneous Email draft", () => {
  const { draftMetadataMatchesAction } = loadDraftGuardFunctions();
  const postScope = "post-scope";
  const emailScope = "email-scope";

  assert.equal(
    draftMetadataMatchesAction(
      { actionType: "email", scope: emailScope },
      postScope,
      "post",
      "post",
      emailScope
    ),
    false
  );
  assert.equal(
    draftMetadataMatchesAction(
      { actionType: "post", scope: postScope },
      postScope,
      "post",
      "post",
      emailScope
    ),
    true
  );
});

test("only a user edit may clear an empty draft", () => {
  const { shouldClearDraftForEmptyEvent } = loadDraftGuardFunctions();

  assert.equal(shouldClearDraftForEmptyEvent("input", true), true);
  assert.equal(shouldClearDraftForEmptyEvent("keyup", true), false);
  assert.equal(shouldClearDraftForEmptyEvent("mutation", false), false);
  assert.equal(shouldClearDraftForEmptyEvent("input", false), false);
  assert.equal(shouldClearDraftForEmptyEvent("blur", true), false);
});

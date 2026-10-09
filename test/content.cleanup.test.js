const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadDraftGuardFunctions() {
  const source = readFileSync(path.join(__dirname, "..", "content.js"), "utf8").replace("\nbootstrap();\n", "\n") + `
    globalThis.__draftGuardState = {
      clearedDraftKeys,
      clearedEditorReadyKeys,
      draftCache,
      draftGenerations,
      draftStorageQueues,
      trackedEditors
    };
  `;
  const storageWrites = [];
  const storageArea = {
    get: async () => ({}),
    set: async (value) => storageWrites.push(value),
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
  context.__storageWrites = storageWrites;
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

test("Aura action signals clear only their matching submitted composer", () => {
  const { networkResultMatchesPendingAction } = loadDraftGuardFunctions();

  assert.equal(
    networkResultMatchesPendingAction(
      { url: "/aura", signals: ["email-send"] },
      { actionLabel: "send", actionType: "email" }
    ),
    true
  );
  assert.equal(
    networkResultMatchesPendingAction(
      { url: "/aura", signals: ["post-submit"] },
      { actionLabel: "share", actionType: "post" }
    ),
    true
  );
  assert.equal(
    networkResultMatchesPendingAction(
      { url: "/aura", signals: ["activity-save"] },
      { actionLabel: "save", actionType: "note" }
    ),
    true
  );
  assert.equal(
    networkResultMatchesPendingAction(
      { url: "/aura", signals: ["activity-save"] },
      { actionLabel: "save", actionType: "activity" }
    ),
    false
  );
});

test("email draft scope is derived from the top-level record id", () => {
  const context = loadDraftGuardFunctions();
  const emailBody = {
    nodeType: 1,
    closest: () => null,
    getAttribute: () => null,
    matches: () => false,
    classList: { contains: () => true },
    ownerDocument: { body: { nodeType: 1, querySelector: () => ({ getAttribute: () => "500000000000001" }) } }
  };

  context.document.body = {
    nodeType: 1,
    querySelector: () => ({ getAttribute: () => "500000000000001" })
  };

  const expectedScope = context.hashKey("unresolved-tab::500000000000001::email");
  assert.equal(context.getEmailDraftScope(emailBody), expectedScope);
});

test("only a user edit may clear an empty draft", () => {
  const { shouldClearDraftForEmptyEvent } = loadDraftGuardFunctions();

  assert.equal(shouldClearDraftForEmptyEvent("input", true), true);
  assert.equal(shouldClearDraftForEmptyEvent("keyup", true), false);
  assert.equal(shouldClearDraftForEmptyEvent("mutation", false), false);
  assert.equal(shouldClearDraftForEmptyEvent("input", false), false);
  assert.equal(shouldClearDraftForEmptyEvent("blur", true), false);
});

test("a manual clear invalidates live draft caches and readies the next user edit", () => {
  const context = loadDraftGuardFunctions();
  const key = "sfdg:draft:tab-42:case-1:post";
  const editor = {};
  const state = context.__draftGuardState;

  state.draftCache.set(key, { value: "pending text" });
  state.trackedEditors.set(editor, { storageKey: key });

  context.handleManualDraftClear({ all: true });

  assert.equal(state.draftCache.has(key), false);
  assert.equal(state.clearedDraftKeys.has(key), true);
  assert.equal(state.draftGenerations.get(key), 1);
  assert.equal(state.clearedEditorReadyKeys.get(editor), key);
});

test("a targeted manual clear ignores non-draft keys", () => {
  const context = loadDraftGuardFunctions();
  const state = context.__draftGuardState;

  context.handleManualDraftClear({ keys: ["showToasts", "sfdg:draft:one"] });

  assert.deepEqual(Array.from(state.clearedDraftKeys), ["sfdg:draft:one"]);
});

test("a manual clear invalidates a draft write already waiting in its storage queue", async () => {
  const context = loadDraftGuardFunctions();
  const key = "sfdg:draft:queued";
  const state = context.__draftGuardState;
  let releaseQueue;
  state.draftStorageQueues.set(key, new Promise((resolve) => {
    releaseQueue = resolve;
  }));

  const persist = context.persistDraft(
    {},
    {
      storageKey: key,
      scope: "scope",
      fieldKey: "field",
      actionType: "post",
      label: "Post"
    },
    {
      value: "queued text",
      html: "",
      url: "https://example.lightning.force.com",
      title: "Case"
    }
  );

  await Promise.resolve();
  context.handleManualDraftClear({ all: true });
  releaseQueue();
  await persist;

  assert.deepEqual(context.__storageWrites, []);
  assert.equal(state.clearedDraftKeys.has(key), true);
});

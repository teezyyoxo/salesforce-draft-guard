const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadContentScript(extraCode = "") {
  const source = fs
    .readFileSync(path.join(__dirname, "..", "content.js"), "utf8")
    .replace("bootstrap();", "// bootstrap disabled for unit tests");

  const storageArea = {
    get: async () => ({}),
    set: async () => {},
    remove: async () => {}
  };

  const sandbox = {
    chrome: {
      runtime: {
        getURL: (resource) => resource
      },
      storage: {
        session: storageArea,
        local: storageArea,
        sync: storageArea,
        onChanged: {
          addListener: () => {}
        }
      }
    },
    assert,
    console,
    document: {
      nodeType: 9,
      title: "Test Page",
      body: null,
      documentElement: {
        dataset: {},
        appendChild: () => {}
      },
      createElement: (tagName) => ({
        tagName: tagName.toUpperCase(),
        nodeType: 1,
        dataset: {},
        appendChild: () => {},
        addEventListener: () => {},
        remove: () => {}
      }),
      createTextNode: (text) => ({
        nodeType: 3,
        text
      }),
      querySelector: () => null
    },
    location: {
      href: "https://example.lightning.force.com/lightning/r/Case/500ABCDEF123456/view?nonce=abc&c__id=42",
      origin: "https://example.lightning.force.com",
      pathname: "/lightning/r/Case/500ABCDEF123456/view"
    },
    window: {
      top: null,
      location: {
        href: "https://example.lightning.force.com/lightning/r/Case/500ABCDEF123456/view?nonce=abc&c__id=42"
      },
      addEventListener: () => {},
      clearTimeout: () => {},
      setTimeout: () => 1
    },
    MutationObserver: class {
      observe() {}
    },
    Event: class {
      constructor(type, options) {
        this.type = type;
        this.options = options;
      }
    },
    CSS: {
      escape: (value) => value
    },
    URL,
    Map,
    Set,
    WeakMap,
    WeakSet
  };
  sandbox.window.top = sandbox.window;
  sandbox.document.body = {
    nodeType: 1,
    tagName: "BODY",
    textContent: "",
    querySelector: () => null,
    querySelectorAll: () => [],
    getAttribute: () => "",
    matches: () => false,
    closest: () => null
  };

  return vm.runInNewContext(`${source}\n${extraCode}`, sandbox);
}

test("stable page context ignores volatile params and uses the top URL", () => {
  loadContentScript(`
    window.top.location.href = "https://example.lightning.force.com/lightning/r/Case/500ABCDEF123456/view?nonce=abc&ts=1&c__id=42";
    const key = getStablePageContextKey();
    assert.equal(key, "https://example.lightning.force.com/lightning/r/Case/500ABCDEF123456/view?c__id=42");
  `);
});

test("page exit flushes only unsent filled editors, including tracked iframe editors", () => {
  loadContentScript(`
    const visibleEditor = { id: "visible" };
    const iframeEditor = { id: "iframe" };
    const emptyEditor = { id: "empty" };
    const submittedEditor = { id: "submitted" };
    const clearedEditor = { id: "cleared" };
    const cancelled = [];
    const persisted = [];

    collectDraftEditors = () => [visibleEditor, emptyEditor, submittedEditor, clearedEditor];
    hasUserValue = (editor) => editor !== emptyEditor;
    cancelScheduledSave = (editor) => cancelled.push(editor.id);
    persistDraft = (editor) => {
      persisted.push(editor.id);
      return Promise.resolve();
    };
    trackedEditors.set(iframeEditor, { storageKey: "sfdg:draft:email" });
    trackedEditors.set(clearedEditor, { storageKey: "sfdg:draft:sent-email" });
    submittedEditors.add(submittedEditor);
    clearedDraftKeys.add("sfdg:draft:sent-email");

    flushPendingDrafts();

    assert.deepEqual(cancelled, ["visible", "empty", "submitted", "cleared", "iframe"]);
    assert.deepEqual(persisted, ["visible", "iframe"]);
  `);
});

test("scanAndRestore attaches an Email iframe when the iframe is the mutation root", () => {
  loadContentScript(`
    let attached = 0;
    attachEmailFrameObserver = () => {
      attached += 1;
    };

    const iframe = {
      nodeType: 1,
      tagName: "IFRAME",
      matches: (selector) => selector === "iframe.cke_wysiwyg_frame[title='Email Body']",
      querySelectorAll: () => [],
      closest: () => null
    };

    scanAndRestore(iframe);
    assert.equal(attached, 1);
  `);
});

test("insertViaPaste focuses without scrolling when supported", () => {
  loadContentScript(`
    let focusArgument = null;
    const fakeElement = {
      focus: (arg) => { focusArgument = arg; },
      dispatchEvent: () => {},
      innerHTML: "",
      ownerDocument: document
    };
    document.createRange = () => ({
      selectNodeContents: () => {},
      collapse: () => {}
    });
    document.getSelection = () => ({
      removeAllRanges: () => {},
      addRange: () => {}
    });
    window.DataTransfer = class {
      constructor() { this.data = {}; }
      setData(type, value) { this.data[type] = value; }
    };
    window.ClipboardEvent = class {
      constructor(type, options) { this.clipboardData = options.dataTransfer; }
    };

    insertViaPaste(fakeElement, fakeElement.ownerDocument, { text: "hello" });
    assert.deepEqual(focusArgument, { preventScroll: true });
  `);
});

test("background rich-text restore releases editor focus so later keys cannot snap the page back", () => {
  loadContentScript(`
    let blurred = 0;
    let removedRanges = 0;
    document.activeElement = document.body;
    document.body.isConnected = true;
    document.getSelection = () => ({
      removeAllRanges: () => { removedRanges += 1; },
      addRange: () => {}
    });
    const editor = {
      blur: () => { blurred += 1; }
    };

    restoreFocusAfterDraftRestore(editor, document, document.activeElement);
    assert.equal(blurred, 1);
    assert.equal(removedRanges, 1);
  `);
});

test("rich-text restore returns focus to the prior control without scrolling", () => {
  loadContentScript(`
    let focusArgument = null;
    const previous = {
      isConnected: true,
      focus: (argument) => { focusArgument = argument; }
    };
    const editor = {
      blur: () => { throw new Error("editor should not blur when prior focus is restorable"); }
    };

    restoreFocusAfterDraftRestore(editor, document, previous);
    assert.deepEqual(focusArgument, { preventScroll: true });
  `);
});

test("rich-text restore preserves the selection that existed before its synthetic paste", () => {
  loadContentScript(`
    const originalRange = { id: "original" };
    const restoredRanges = [];
    document.getSelection = () => ({
      removeAllRanges: () => {},
      addRange: (range) => { restoredRanges.push(range); }
    });
    const editor = { blur: () => {} };

    restoreFocusAfterDraftRestore(editor, document, document.body, [originalRange]);
    assert.deepEqual(restoredRanges, [originalRange]);
  `);
});

test("editable value normalization removes editor-added trailing line breaks", () => {
  loadContentScript(`
    assert.equal(normalizeEditableValue("First line\\r\\nSecond line\\n\\n"), "First line\\nSecond line");
  `);
});

test("submit clearing includes tracked Email editor keys for the same page scope", () => {
  loadContentScript(`
    const container = {
      nodeType: 1,
      tagName: "DIV",
      textContent: "Email Send",
      querySelector: () => null,
      querySelectorAll: () => [],
      getAttribute: () => "",
      matches: () => false,
      closest: () => null
    };

    const scope = getEmailDraftScope(container);
    trackedEditors.set({ nodeType: 1 }, {
      scope,
      actionType: "email",
      storageKey: "sfdg:draft:test"
    });

    const canonical = STORAGE_PREFIX + getEmailDraftScope(container) + ":" + hashKey("email-body");
    assert.deepEqual(getDraftKeysForContainer(container, "send"), [canonical, "sfdg:draft:test"]);
  `);
});

test("Send clears the canonical Email key even when CKEditor is in another frame", () => {
  loadContentScript(`
    const container = {
      nodeType: 1,
      tagName: "DIV",
      dataset: {},
      textContent: "Send Email",
      querySelector: () => null,
      querySelectorAll: () => [],
      getAttribute: () => "",
      matches: () => false,
      closest: () => null
    };

    const expected = STORAGE_PREFIX + getEmailDraftScope(container) + ":" + hashKey("email-body");
    assert.deepEqual(getDraftKeysForContainer(container, "send"), [expected]);
  `);
});

test("action type and scope derive structurally and stay stable when text content changes", () => {
  loadContentScript(`
    function makeEmailContainer(text) {
      return {
        nodeType: 1,
        tagName: "DIV",
        dataset: {},
        textContent: text,
        getAttribute: (name) => (name === "aria-label" ? "Email Body" : ""),
        matches: () => false,
        querySelector: () => null,
        querySelectorAll: () => [],
        closest: () => null
      };
    }

    const a = makeEmailContainer("Email Body");
    // Text content that the old, text-driven classifier would have read as "post".
    const b = makeEmailContainer("Share an update post");

    assert.equal(getContainerActionType(a), "email");
    assert.equal(getContainerActionType(b), "email");
    assert.equal(getContainerScope(a), getContainerScope(b));
  `);
});

test("Post ownership prefers the Salesforce publisher over an inner Quill container", () => {
  loadContentScript(`
    const publisher = {
      nodeType: 1,
      matches: (selector) => selector === ".publisherInputContainer",
      querySelector: () => null,
      getAttribute: () => ""
    };
    const quill = { nodeType: 1 };
    const editor = {
      closest: (selector) => selector.includes("publisherInputContainer") ? publisher : quill
    };

    assert.equal(getContainer(editor), publisher);
    assert.equal(getContainerActionType(getContainer(editor)), "post");
  `);
});

test("headings and authored draft text cannot change a composer scope", () => {
  loadContentScript(`
    let heading = "New Note";
    const headingNode = { textContent: heading };
    const container = {
      nodeType: 1,
      tagName: "DIV",
      textContent: "Draft mentioning email and post",
      getAttribute: () => "",
      matches: () => false,
      querySelector: (selector) => selector.includes("h1") ? headingNode : null,
      querySelectorAll: () => [],
      closest: () => null
    };

    const first = getContainerScope(container);
    headingNode.textContent = "Edited Note";
    container.textContent = "Completely different authored text";
    const second = getContainerScope(container);

    assert.equal(getContainerActionType(container), "note");
    assert.equal(first, second);
  `);
});

test("submit actions tolerate Salesforce supplementary button text", () => {
  loadContentScript(`
    const button = (text, ariaLabel = "") => ({
      textContent: text,
      getAttribute: (name) => (name === "aria-label" ? ariaLabel : "")
    });

    assert.equal(getSubmitActionLabel(button("Send Email")), "send");
    assert.equal(getSubmitActionLabel(button("", "Save Note")), "save");
    assert.equal(getSubmitActionLabel(button("Cancel")), "");
  `);
});

test("a reused Lightning composer gets a new scope after record navigation", () => {
  loadContentScript(`
    const container = {
      nodeType: 1,
      tagName: "DIV",
      dataset: { sfdgScope: "stale-ticket-scope" },
      textContent: "",
      getAttribute: () => "",
      matches: (selector) => selector === ".publisherInputContainer",
      querySelector: () => null,
      querySelectorAll: () => [],
      closest: () => null
    };

    window.top.location.href = "https://example.lightning.force.com/lightning/r/Case/500ABCDEF123456/view";
    const first = getContainerScope(container);
    window.top.location.href = "https://example.lightning.force.com/lightning/r/Case/500ZZZZZZ987654/view";
    const second = getContainerScope(container);

    assert.notEqual(first, "stale-ticket-scope");
    assert.notEqual(first, second);
  `);
});

test("the same Case and composer are isolated between Chrome tabs", () => {
  loadContentScript(`
    const container = {
      nodeType: 1,
      tagName: "DIV",
      textContent: "",
      getAttribute: () => "",
      matches: (selector) => selector === ".publisherInputContainer",
      querySelector: () => null,
      querySelectorAll: () => [],
      closest: () => null
    };

    tabContextKey = "tab-42";
    const firstTabScope = getContainerScope(container);
    tabContextKey = "tab-43";
    const secondTabScope = getContainerScope(container);

    assert.notEqual(firstTabScope, secondTabScope);
  `);
});

test("Post and Email scope share the same tab and current record identity", () => {
  loadContentScript(`
    tabContextKey = "tab-42";
    const recordId = getRecordIdForScope(document.body);
    const emailScope = getEmailDraftScope(document.body);

    assert.equal(emailScope, hashKey("tab-42::" + recordId + "::email"));
  `);
});

test("record lookup ignores generic Lightning data-id attributes", () => {
  loadContentScript(`
    const root = {
      nodeType: 1,
      querySelectorAll: (selector) => {
        assert.equal(selector, "[data-recordid], [data-record-id], [record-id]");
        return [{
          getAttribute: (name) => name === "data-recordid" ? "500REALCASE1234" : ""
        }];
      }
    };
    location.pathname = "/lightning/page/home";
    window.top.location.href = "https://example.lightning.force.com/lightning/page/home";

    assert.equal(findRecordId(root), "500REALCASE1234");
  `);
});

test("record lookup does not treat unrelated URL identifiers as Case context", () => {
  loadContentScript(`
    location.pathname = "/lightning/setup/00DORGIDENT12345/home";
    window.top.location.href = "https://example.lightning.force.com/lightning/setup/00DORGIDENT12345/home";
    const root = { nodeType: 1, querySelectorAll: () => [] };

    assert.equal(findRecordId(root), "");
  `);
});

test("mounted Salesforce workspace tabs use their local Case instead of the active URL", () => {
  loadContentScript(`
    window.top.location.href = "https://example.lightning.force.com/lightning/r/Case/500ACTIVE000002/view";
    const recordNode = (recordId) => ({
      getAttribute: (name) => name === "data-recordid" ? recordId : ""
    });
    const container = (recordId) => ({
      nodeType: 1,
      tagName: "DIV",
      textContent: "",
      getAttribute: () => "",
      matches: (selector) => selector === ".publisherInputContainer",
      closest: (selector) => selector.includes("data-recordid") ? recordNode(recordId) : null,
      querySelector: () => null,
      querySelectorAll: () => []
    });

    const case0001 = container("500MOUNTED00001");
    const case0002 = container("500ACTIVE000002");

    assert.equal(getRecordIdForScope(case0001), "500MOUNTED00001");
    assert.notEqual(getContainerScope(case0001), getContainerScope(case0002));
  `);
});

test("Email iframe scope follows its owning Salesforce workspace Case", () => {
  loadContentScript(`
    window.top.location.href = "https://example.lightning.force.com/lightning/r/Case/500ACTIVE000002/view";
    const owningFrame = {
      nodeType: 1,
      tagName: "IFRAME",
      closest: () => ({
        getAttribute: (name) => name === "data-recordid" ? "500MOUNTED00001" : ""
      }),
      querySelectorAll: () => []
    };
    const emailBody = {
      ownerDocument: { defaultView: { frameElement: owningFrame } }
    };
    tabContextKey = "tab-42";

    assert.equal(
      getEmailDraftScope(emailBody),
      hashKey("tab-42::500MOUNTED00001::email")
    );
  `);
});

test("a reused editor can restore a different ticket key exactly once", async () => {
  await loadContentScript(`
    (async () => {
      const editor = { nodeType: 1, tagName: "DIV", getAttribute: () => "" };
      const writes = [];
      let currentKey = "ticket-0001-key";

      getDraftMetadata = () => ({ storageKey: currentKey, actionType: "post" });
      getDraftValue = async (key) => ({ [key]: { value: key } });
      readElementValue = () => "";
      isElementRenderable = () => true;
      isEmailEditorElement = () => false;
      writeElementValueGuarded = (_element, draft) => writes.push(draft.value);
      trackDraftEditor = () => {};
      showToast = () => {};

      await restoreDraft(editor);
      await restoreDraft(editor);
      currentKey = "ticket-0004-key";
      await restoreDraft(editor);
      await restoreDraft(editor);

      assert.deepEqual(writes, ["ticket-0001-key", "ticket-0004-key"]);
    })()
  `);
});

test("a delayed autosave retains the ticket key captured while typing", () => {
  loadContentScript(`
    const editor = {
      nodeType: 1,
      tagName: "INPUT",
      value: "Ticket 0001 draft",
      getAttribute: () => ""
    };
    let activeKey = "ticket-0001-key";
    getDraftMetadata = () => ({ storageKey: activeKey, actionType: "post" });
    captureDraftSnapshot = () => ({
      value: editor.value,
      html: undefined,
      url: "ticket-0001-url",
      title: "Ticket 0001"
    });

    scheduleSave(editor, "input", true);
    activeKey = "ticket-0004-key";

    const scheduled = saveTimers.get(editor);
    assert.equal(scheduled.meta.storageKey, "ticket-0001-key");
    assert.equal(scheduled.snapshot.value, "Ticket 0001 draft");
    assert.equal(scheduled.snapshot.url, "ticket-0001-url");
  `);
});

test("a DOM scan cannot hide an editor ownership change from a late mutation", () => {
  loadContentScript(`
    const editor = {
      nodeType: 1,
      tagName: "INPUT",
      value: "Ticket 0001 draft",
      getAttribute: () => ""
    };
    let currentMeta = { storageKey: "ticket-0001-key", actionType: "post" };
    getDraftMetadata = () => currentMeta;
    captureDraftSnapshot = () => ({ value: editor.value, url: "ticket-0001", title: "0001" });
    showToast = () => {};

    scheduleSave(editor, "input", true);
    currentMeta = { storageKey: "ticket-0002-key", actionType: "post" };
    // Simulate scanAndRestore discovering the reused node before its old mutation arrives.
    trackedEditors.set(editor, currentMeta);
    scheduleSave(editor, "mutation", false);

    assert.equal(saveTimers.has(editor), false);
    assert.equal(editorDraftOwnership.get(editor), "ticket-0001-key");
  `);
});

test("field key uses intrinsic identity and is frozen against volatile text", () => {
  loadContentScript(`
    function makeField() {
      return {
        nodeType: 1,
        tagName: "DIV",
        id: "",
        dataset: {},
        isContentEditable: true,
        className: "cke_editable",
        textContent: "",
        getAttribute: (name) => (name === "aria-label" ? "Email Body" : ""),
        setAttribute: () => {},
        matches: () => false,
        querySelector: () => null,
        querySelectorAll: () => [],
        closest: () => null,
        ownerDocument: { querySelector: () => null }
      };
    }
    function makeContainer() {
      return {
        nodeType: 1,
        tagName: "DIV",
        dataset: {},
        textContent: "",
        getAttribute: () => "",
        matches: () => false,
        querySelector: () => null,
        querySelectorAll: () => [],
        closest: () => null
      };
    }

    const field = makeField();
    const container = makeContainer();
    const first = getFieldKey(field, container);

    // Mutating volatile signals must not change the cached key.
    container.textContent = "subject description comment note";
    assert.equal(getFieldKey(field, container), first);
    assert.ok(field.dataset.sfdgFieldKey);

    // A separate, identically-described field derives the same key (cross-refresh stability).
    assert.equal(getFieldKey(makeField(), makeContainer()), first);
  `);
});

test("generic draft detection ignores neighboring Case field labels", () => {
  loadContentScript(`
    const container = {
      nodeType: 1,
      tagName: "FORM",
      textContent: "Description Fixed in Release Repeated Issue Case License Requester",
      dataset: {},
      matches: () => false,
      querySelector: () => null,
      querySelectorAll: () => [],
      getAttribute: () => ""
    };

    function makeField(label) {
      return {
        nodeType: 1,
        tagName: "INPUT",
        className: "slds-input",
        getAttribute: (name) => (name === "aria-label" ? label : ""),
        matches: () => false,
        closest: (selector) => selector.includes("[role='dialog']") ? container : null,
        ownerDocument: { querySelector: () => null }
      };
    }

    assert.equal(isDraftCandidate(makeField("Fixed in Release")), false);
    assert.equal(isDraftCandidate(makeField("Repeated Issue Case")), false);
    assert.equal(isDraftCandidate(makeField("License Requester")), false);
    assert.equal(isDraftCandidate(makeField("Description")), true);
  `);
});

test("restore guard prevents a programmatic restore from scheduling a save", () => {
  loadContentScript(`
    getDraftMetadata = () => ({ storageKey: "draft-key", actionType: "activity" });
    captureDraftSnapshot = () => ({ value: "Draft text", url: "test", title: "test" });
    const guarded = { nodeType: 1, tagName: "DIV" };
    restoringNow.add(guarded);
    scheduleSave(guarded);
    assert.equal(saveTimers.has(guarded), false);

    const normal = {
      nodeType: 1,
      tagName: "INPUT",
      value: "Draft text",
      getAttribute: () => ""
    };
    scheduleSave(normal);
    assert.equal(saveTimers.has(normal), true);
  `);
});

test("empty input clears immediately while pre-input events leave a draft alone", () => {
  loadContentScript(`
    const empty = {
      nodeType: 1,
      tagName: "INPUT",
      value: "",
      getAttribute: () => ""
    };
    let clears = 0;
    clearDraftForEmptyElement = () => {
      clears += 1;
    };

    scheduleSave(empty, "beforeinput");
    assert.equal(clears, 0);

    scheduleSave(empty, "input", true);
    assert.equal(clears, 1);
    assert.equal(saveTimers.has(empty), false);
  `);
});

test("submitted editor content cannot schedule a late draft save", () => {
  loadContentScript(`
    const submitted = {
      nodeType: 1,
      tagName: "INPUT",
      value: "Already sent text",
      getAttribute: () => ""
    };
    submittedEditors.add(submitted);

    scheduleSave(submitted, "input");
    assert.equal(saveTimers.has(submitted), false);
  `);
});

test("a draft clear received from another frame cancels its pending autosave", () => {
  loadContentScript(`
    const editor = { nodeType: 1, tagName: "DIV" };
    const key = "sfdg:draft:email";
    trackedEditors.set(editor, { storageKey: key });
    saveTimers.set(editor, 1);

    handleStorageChange({ [key]: { oldValue: { value: "sent" }, newValue: undefined } }, "session");
    assert.equal(saveTimers.has(editor), false);
    assert.equal(clearedDraftKeys.has(key), true);
  `);
});

test("a cleared cross-frame editor cannot recreate sent text with a late mutation", () => {
  loadContentScript(`
    const key = "sfdg:draft:sent-email";
    const editor = {
      nodeType: 1,
      tagName: "INPUT",
      value: "Already sent text",
      getAttribute: () => ""
    };
    trackedEditors.set(editor, { storageKey: key });
    getDraftMetadata = () => ({ storageKey: key, actionType: "email" });
    captureDraftSnapshot = () => ({ value: editor.value, url: "test", title: "test" });
    clearedDraftKeys.add(key);

    scheduleSave(editor, "mutation", false);
    assert.equal(saveTimers.has(editor), false);
    assert.equal(clearedDraftKeys.has(key), true);

    editor.value = "";
    scheduleSave(editor, "mutation", false);
    editor.value = "A genuinely new draft";
    scheduleSave(editor, "input", true);
    assert.equal(clearedDraftKeys.has(key), false);
    assert.equal(saveTimers.has(editor), true);
  `);
});

test("draft storage operations for a key run in save/clear order", async () => {
  await loadContentScript(`
    (async () => {
      const operations = [];
      let releaseFirst;
      const first = queueDraftStorageOperation("draft-key", () => new Promise((resolve) => {
        operations.push("save");
        releaseFirst = resolve;
      }));
      const second = queueDraftStorageOperation("draft-key", () => {
        operations.push("clear");
      });

      await Promise.resolve();
      await Promise.resolve();
      assert.deepEqual(operations, ["save"]);
      releaseFirst();
      await Promise.all([first, second]);
      assert.deepEqual(operations, ["save", "clear"]);
    })()
  `);
});

test("contenteditable restore round-trips without adding line breaks", () => {
  loadContentScript(`
    function makeEditable() {
      const children = [];
      return {
        nodeType: 1,
        tagName: "DIV",
        isContentEditable: true,
        getAttribute: () => "",
        replaceChildren() {
          children.length = 0;
        },
        appendChild(node) {
          children.push(node);
        },
        get innerText() {
          return children.map((node) => (node.tagName === "BR" ? "\\n" : node.text || "")).join("");
        }
      };
    }

    const el = makeEditable();
    writeElementValue(el, "First line\\nSecond line");
    assert.equal(readElementValue(el), "First line\\nSecond line");

    // Re-writing the read-back value is idempotent (no compounding breaks).
    writeElementValue(el, readElementValue(el));
    assert.equal(readElementValue(el), "First line\\nSecond line");
  `);
});

test("restore only fills empty fields so edits and deletions are never undone", () => {
  loadContentScript(`
    assert.equal(shouldRestoreOverCurrentValue(""), true);
    assert.equal(shouldRestoreOverCurrentValue("   "), true);
    assert.equal(shouldRestoreOverCurrentValue("partial draft text"), false);
  `);
});

test("contenteditable restore prefers captured HTML so formatting and breaks survive", () => {
  loadContentScript(`
    const el = {
      nodeType: 1,
      tagName: "DIV",
      isContentEditable: true,
      getAttribute: () => "",
      innerHTML: "",
      ownerDocument: document
    };

    writeElementValue(el, { value: "bold line", html: "<strong>bold</strong><br>line" });
    assert.equal(el.innerHTML, "<strong>bold</strong><br>line");
  `);
});

test("email draft key is canonical and ignores per-load identifiers", () => {
  loadContentScript(`
    function makeEmailBody(volatileTitle, volatileId) {
      return {
        nodeType: 1,
        tagName: "BODY",
        id: volatileId,
        dataset: {},
        isContentEditable: true,
        className: "cke_editable",
        getAttribute: (name) => {
          if (name === "aria-label") return "Email Body";
          if (name === "title") return volatileTitle;
          return "";
        },
        setAttribute: () => {},
        matches: () => false,
        querySelector: () => null,
        querySelectorAll: () => [],
        closest: () => null,
        ownerDocument: { querySelector: () => null }
      };
    }

    const saved = getDraftMetadata(makeEmailBody("cke_1_contents", "cke_1"));
    const reloaded = getDraftMetadata(makeEmailBody("cke_87_contents", "cke_87"));

    assert.ok(saved && reloaded);
    assert.equal(saved.actionType, "email");
    // Same record context, different CKEditor instance identifiers -> identical key.
    assert.equal(saved.storageKey, reloaded.storageKey);
  `);
});

test("Email canonical draft metadata is limited to the editable message body", () => {
  loadContentScript(`
    const emailContainer = {
      nodeType: 1,
      tagName: "FORM",
      dataset: {},
      textContent: "Email To Cc Bcc",
      matches: () => false,
      querySelector: () => null,
      querySelectorAll: () => [],
      getAttribute: () => ""
    };

    function makeField(tagName, label, editable = false) {
      return {
        nodeType: 1,
        tagName,
        dataset: {},
        isContentEditable: editable,
        className: editable ? "cke_editable" : "slds-input",
        getAttribute: (name) => (name === "aria-label" ? label : ""),
        matches: () => false,
        closest: (selector) => selector.includes("[role='dialog']") ? emailContainer : null,
        querySelector: () => null,
        querySelectorAll: () => [],
        ownerDocument: { querySelector: () => null }
      };
    }

    const body = makeField("DIV", "Email Body", true);
    const to = makeField("INPUT", "To");
    const cc = makeField("INPUT", "Cc");

    const bodyMeta = getDraftMetadata(body);
    assert.ok(bodyMeta);
    assert.equal(bodyMeta.fieldKey, hashKey("email-body"));
    assert.equal(getDraftMetadata(to), null);
    assert.equal(getDraftMetadata(cc), null);
  `);
});

test("hidden editors are not treated as renderable, so restore defers until shown", () => {
  loadContentScript(`
    // display:none / detached nodes report no client rects.
    assert.equal(isElementRenderable({ nodeType: 1, getClientRects: () => [] }), false);
    // A laid-out element reports at least one client rect.
    assert.equal(isElementRenderable({ nodeType: 1, getClientRects: () => [{}] }), true);
    // When the API is unavailable (unit environment), assume renderable.
    assert.equal(isElementRenderable({ nodeType: 1 }), true);
  `);
});

test("toast settings normalize unknown choices and invalid colors", () => {
  loadContentScript(`
    const normalized = normalizeSettings({
      protectedActions: ["send"],
      fieldKeywords: ["email"],
      showToasts: true,
      toastPosition: "somewhere",
      toastSize: "huge",
      toastTextColor: "white",
      toastBackgroundColor: "#123abc",
      toastSound: "horn"
    });

    assert.equal(normalized.toastPosition, "lower-right");
    assert.equal(normalized.toastSize, "medium");
    assert.equal(normalized.toastFrequency, "typing-burst");
    assert.equal(normalized.toastTextColor, "#f9fafb");
    assert.equal(normalized.toastBackgroundColor, "#123abc");
    assert.equal(normalized.toastSound, "none");
  `);
});

test("save confirmation frequency controls repeated save toasts", () => {
  loadContentScript(`
    const element = { nodeType: 1, tagName: "DIV" };

    settings.toastFrequency = "typing-burst";
    assert.equal(shouldShowDraftSaveToast(element, "draft-key"), true);
    assert.equal(shouldShowDraftSaveToast(element, "draft-key"), false);
    toastStateByElement.get(element).toastShown = false;

    settings.toastFrequency = "once-per-draft";
    assert.equal(shouldShowDraftSaveToast(element, "another-draft-key"), true);
    assert.equal(shouldShowDraftSaveToast(element, "another-draft-key"), false);

    settings.toastFrequency = "every-save";
    assert.equal(shouldShowDraftSaveToast(element, "draft-key"), true);
    assert.equal(shouldShowDraftSaveToast(element, "draft-key"), true);
  `);
});

test("rich-text viewport reset moves the caret and Email iframe scroll position to the beginning", () => {
  loadContentScript(`
    const range = {
      selectNodeContents: () => {},
      collapse: (atStart) => assert.equal(atStart, true)
    };
    const selection = {
      removeAllRanges: () => {},
      addRange: (value) => assert.equal(value, range)
    };
    const scrollingElement = { scrollTop: 80, scrollLeft: 40 };
    const emailDocument = {
      getSelection: () => selection,
      createRange: () => range,
      scrollingElement,
      documentElement: scrollingElement,
      body: { scrollTop: 60, scrollLeft: 30 }
    };
    const element = {
      ownerDocument: emailDocument,
      scrollTop: 100,
      scrollLeft: 50
    };

    resetRestoredEditorViewport(element);
    assert.equal(element.scrollTop, 0);
    assert.equal(element.scrollLeft, 0);
    assert.equal(scrollingElement.scrollTop, 0);
    assert.equal(scrollingElement.scrollLeft, 0);
    assert.equal(emailDocument.body.scrollTop, 0);
    assert.equal(emailDocument.body.scrollLeft, 0);
  `);
});

test("rich-text viewport reset skips a detached editor range", () => {
  loadContentScript(`
    let addRangeCalls = 0;
    const emailDocument = {
      contains: () => false,
      getSelection: () => ({
        removeAllRanges: () => {},
        addRange: () => {
          addRangeCalls += 1;
        }
      }),
      createRange: () => ({
        selectNodeContents: () => {},
        collapse: () => {}
      }),
      scrollingElement: { scrollTop: 80, scrollLeft: 40 },
      documentElement: { scrollTop: 80, scrollLeft: 40 },
      body: { scrollTop: 60, scrollLeft: 30 }
    };
    const element = {
      nodeType: 1,
      ownerDocument: emailDocument,
      isConnected: false,
      scrollTop: 100,
      scrollLeft: 50
    };

    resetRestoredEditorViewport(element);
    assert.equal(addRangeCalls, 0);
    assert.equal(element.scrollTop, 0);
    assert.equal(element.scrollLeft, 0);
  `);
});

test("Post viewport reset clears only the editor and never writes to the Salesforce page scroller", () => {
  loadContentScript(`
    const pageScroller = { scrollTop: 900, scrollLeft: 20 };
    document.scrollingElement = pageScroller;
    document.documentElement = pageScroller;
    document.body.scrollTop = 800;
    document.body.scrollLeft = 10;
    document.contains = () => true;
    document.getSelection = () => null;
    const element = {
      nodeType: 1,
      ownerDocument: document,
      scrollTop: 60,
      scrollLeft: 30
    };

    resetRestoredEditorViewport(element);
    assert.equal(element.scrollTop, 0);
    assert.equal(element.scrollLeft, 0);
    assert.equal(pageScroller.scrollTop, 900);
    assert.equal(pageScroller.scrollLeft, 20);
    assert.equal(document.body.scrollTop, 800);
    assert.equal(document.body.scrollLeft, 10);
  `);
});

test("background Post viewport reset does not recreate a selection inside the editor", () => {
  loadContentScript(`
    let addRangeCalls = 0;
    const pageScroller = { scrollTop: 900, scrollLeft: 20 };
    document.scrollingElement = pageScroller;
    document.documentElement = pageScroller;
    document.activeElement = document.body;
    document.contains = () => true;
    document.getSelection = () => ({
      removeAllRanges: () => {},
      addRange: () => { addRangeCalls += 1; }
    });
    document.createRange = () => ({
      selectNodeContents: () => {},
      collapse: () => {}
    });
    const element = {
      nodeType: 1,
      ownerDocument: document,
      scrollTop: 60,
      scrollLeft: 30
    };

    resetRestoredEditorViewport(element);
    assert.equal(addRangeCalls, 0);
    assert.equal(element.scrollTop, 0);
    assert.equal(pageScroller.scrollTop, 900);
  `);
});

test("Email block markup becomes one line unit per paragraph", () => {
  loadContentScript(`
    const text = (value) => ({ nodeType: 3, textContent: value });
    const block = (tagName, children) => ({ nodeType: 1, tagName, childNodes: children });
    const one = text("First line");
    const two = text("Second line");
    const blank = block("P", [{ nodeType: 1, tagName: "BR" }]);

    const units = collectEmailLineUnits([
      block("P", [one]),
      blank,
      block("DIV", [two])
    ]);

    assert.deepEqual(units, [[one], [], [two]]);
  `);
});

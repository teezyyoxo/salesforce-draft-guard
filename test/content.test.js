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

  vm.runInNewContext(`${source}\n${extraCode}`, sandbox);
}

test("stable page context ignores volatile params and uses the top URL", () => {
  loadContentScript(`
    window.top.location.href = "https://example.lightning.force.com/lightning/r/Case/500ABCDEF123456/view?nonce=abc&ts=1&c__id=42";
    const key = getStablePageContextKey();
    assert.equal(key, "https://example.lightning.force.com/lightning/r/Case/500ABCDEF123456/view?c__id=42");
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

    const scope = getContainerScope(container);
    trackedEditors.set({ nodeType: 1 }, {
      scope,
      actionType: "email",
      storageKey: "sfdg:draft:test"
    });

    assert.deepEqual(getDraftKeysForContainer(container, "send"), ["sfdg:draft:test"]);
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

test("restore guard prevents a programmatic restore from scheduling a save", () => {
  loadContentScript(`
    const guarded = { nodeType: 1, tagName: "DIV" };
    restoringNow.add(guarded);
    scheduleSave(guarded);
    assert.equal(saveTimers.has(guarded), false);

    const normal = { nodeType: 1, tagName: "DIV" };
    scheduleSave(normal);
    assert.equal(saveTimers.has(normal), true);
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

test("Email viewport reset moves caret and scroll position to the beginning", () => {
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

    resetEmailEditorViewport(element);
    assert.equal(element.scrollTop, 0);
    assert.equal(element.scrollLeft, 0);
    assert.equal(scrollingElement.scrollTop, 0);
    assert.equal(scrollingElement.scrollLeft, 0);
    assert.equal(emailDocument.body.scrollTop, 0);
    assert.equal(emailDocument.body.scrollLeft, 0);
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

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

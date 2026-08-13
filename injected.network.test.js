const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");

function loadNetworkHook() {
  const messages = [];

  class FakeXMLHttpRequest {
    constructor() {
      this.listeners = new Map();
      this.status = 200;
    }

    open(method, url) {
      this.method = method;
      this.url = url;
    }

    send(body) {
      this.body = body;
    }

    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    }

    finish() {
      this.listeners.get("load").call(this);
    }
  }

  const window = {
    location: { origin: "https://example.lightning.force.com" },
    postMessage: (message) => messages.push(message),
    fetch: async () => ({ ok: true, status: 200 })
  };
  vm.runInNewContext(readFileSync("injected.js", "utf8"), {
    URLSearchParams,
    XMLHttpRequest: FakeXMLHttpRequest,
    window
  });

  return { FakeXMLHttpRequest, messages, window };
}

test("Aura action descriptors in XHR bodies are reported without exposing body content", () => {
  const { FakeXMLHttpRequest, messages } = loadNetworkHook();
  const xhr = new FakeXMLHttpRequest();
  xhr.open("POST", "/aura?r=1");
  xhr.send('message={"descriptor":"aura://forceChatter:FeedItemAction.create","draft":"private"}');
  xhr.finish();

  assert.deepEqual(Array.from(messages[0].detail.signals), ["post-submit"]);
  assert.equal("body" in messages[0].detail, false);
  assert.equal(JSON.stringify(messages[0]).includes("private"), false);
});

test("generic Aura quick-action saves emit an activity signal for pending note matching", () => {
  const { FakeXMLHttpRequest, messages } = loadNetworkHook();
  const xhr = new FakeXMLHttpRequest();
  xhr.open("POST", "/aura?r=2");
  xhr.send('message={"descriptor":"RecordGvp.saveQuickActionRecords"}');
  xhr.finish();

  assert.deepEqual(Array.from(messages[0].detail.signals), ["activity-save"]);
});

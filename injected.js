(function injectedDraftGuardNetworkHook() {
  if (window.__SFDG_NETWORK_HOOK_INSTALLED__) {
    return;
  }

  window.__SFDG_NETWORK_HOOK_INSTALLED__ = true;

  const postNetworkResult = (detail) => {
    window.postMessage(
      {
        source: "sfdg-network-hook",
        detail
      },
      window.location.origin
    );
  };

  const requestBodyText = (body) => {
    if (typeof body === "string") {
      return body;
    }
    if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
      return body.toString();
    }
    return "";
  };

  const getRequestSignals = (url, body) => {
    // Aura endpoints frequently keep the action descriptor in the POST body rather than the
    // URL. Inspect only for action identifiers and emit booleans; never send draft content or
    // the request body back into the content script.
    const fingerprint = `${String(url || "")} ${requestBodyText(body)}`.toLowerCase();
    const signals = [];

    if (
      fingerprint.includes("/emailmessages") ||
      fingerprint.includes("/email/simple") ||
      fingerprint.includes("emailquickaction.logsuccessfulsending")
    ) {
      signals.push("email-send");
    }
    if (
      fingerprint.includes("/chatter/feed-elements") ||
      fingerprint.includes("forcechatter-chatter.feeditemaction.create") ||
      fingerprint.includes("feeditemaction.create")
    ) {
      signals.push("post-submit");
    }
    if (
      ["/tasks", "/events", "/notes"].some((fragment) => fingerprint.includes(fragment)) ||
      fingerprint.includes("recordgvp.savequickactionrecords") ||
      fingerprint.includes("savequickactionrecords")
    ) {
      signals.push("activity-save");
    }

    return signals;
  };

  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = async function patchedFetch(input, init) {
      const response = await originalFetch.apply(this, arguments);
      try {
        const method =
          (init && init.method) ||
          (input && typeof input === "object" && "method" in input ? input.method : "GET");
        const url =
          typeof input === "string"
            ? input
            : input && typeof input === "object" && "url" in input
              ? input.url
              : "";
        const signals = getRequestSignals(url, init && init.body);

        if (
          ["POST", "PUT", "PATCH"].includes(String(method).toUpperCase()) &&
          response &&
          response.ok &&
          signals.length
        ) {
          postNetworkResult({
            transport: "fetch",
            method: String(method).toUpperCase(),
            url: String(url),
            signals,
            ok: true,
            status: response.status
          });
        }
      } catch (error) {
        postNetworkResult({
          transport: "fetch",
          ok: false,
          message: error instanceof Error ? error.message : String(error)
        });
      }

      return response;
    };
  }

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function patchedOpen(method, url) {
    this.__sfdgRequest = {
      method: String(method || "GET").toUpperCase(),
      url: String(url || "")
    };
    return originalOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function patchedSend(body) {
    if (this.__sfdgRequest) {
      this.__sfdgRequest.signals = getRequestSignals(this.__sfdgRequest.url, body);
    }
    this.addEventListener("load", function onLoad() {
      const request = this.__sfdgRequest || {};
      if (
        ["POST", "PUT", "PATCH"].includes(request.method) &&
        this.status >= 200 &&
        this.status < 400 &&
        request.signals && request.signals.length
      ) {
        postNetworkResult({
          transport: "xhr",
          method: request.method,
          url: request.url,
          signals: request.signals,
          ok: true,
          status: this.status
        });
      }
    });

    return originalSend.apply(this, arguments);
  };
})();

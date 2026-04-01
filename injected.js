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

  const looksRelevant = (url) => {
    if (!url) {
      return false;
    }

    return [
      "/services/data/",
      "/chatter/",
      "/feed-elements",
      "/emailMessages/",
      "/tasks/",
      "/events/",
      "/notes/"
    ].some((fragment) => url.includes(fragment));
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

        if (
          ["POST", "PUT", "PATCH"].includes(String(method).toUpperCase()) &&
          response &&
          response.ok &&
          looksRelevant(String(url))
        ) {
          postNetworkResult({
            transport: "fetch",
            method: String(method).toUpperCase(),
            url: String(url),
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

  XMLHttpRequest.prototype.send = function patchedSend() {
    this.addEventListener("load", function onLoad() {
      const request = this.__sfdgRequest || {};
      if (
        ["POST", "PUT", "PATCH"].includes(request.method) &&
        this.status >= 200 &&
        this.status < 400 &&
        looksRelevant(request.url)
      ) {
        postNetworkResult({
          transport: "xhr",
          method: request.method,
          url: request.url,
          ok: true,
          status: this.status
        });
      }
    });

    return originalSend.apply(this, arguments);
  };
})();

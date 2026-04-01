const STORAGE_PREFIX = "sfdg:draft:";
const SAVE_DEBOUNCE_MS = 400;
const PENDING_ACTION_TTL_MS = 15000;
const TOAST_TTL_MS = 2200;

const draftCache = new Map();
const pendingActions = new Map();
const saveTimers = new WeakMap();

let observerStarted = false;
let toastNode;

bootstrap();

function bootstrap() {
  injectNetworkHook();
  bindGlobalListeners();
  scanAndRestore(document);
  startObserver();

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      scanAndRestore(document);
    });
  }
}

function injectNetworkHook() {
  const root = document.documentElement;
  if (!root || root.dataset.sfdgInjected === "true") {
    return;
  }

  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("injected.js");
  script.async = false;
  script.dataset.sfdgInjected = "true";
  script.addEventListener("load", () => script.remove(), { once: true });
  script.addEventListener("error", () => script.remove(), { once: true });
  (document.head || root).appendChild(script);
  root.dataset.sfdgInjected = "true";
}

function bindGlobalListeners() {
  document.addEventListener("input", handleInputEvent, true);
  document.addEventListener("change", handleInputEvent, true);
  document.addEventListener("click", handleClickEvent, true);
  window.addEventListener("message", handleWindowMessage);
}

function startObserver() {
  if (observerStarted) {
    return;
  }

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const addedNode of mutation.addedNodes) {
        if (!(addedNode instanceof Element)) {
          continue;
        }

        scanAndRestore(addedNode);
      }
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });

  observerStarted = true;
}

function handleInputEvent(event) {
  const target = getDraftElement(event.target);
  if (!target) {
    return;
  }

  scheduleSave(target);
}

function handleClickEvent(event) {
  const button = event.target instanceof Element ? event.target.closest("button, [role='button'], a") : null;
  if (!button) {
    return;
  }

  const actionLabel = normalizeWhitespace(button.textContent || "");
  if (!/^(send|share|save|post|log a call)$/i.test(actionLabel)) {
    return;
  }

  const container = getContainer(button);
  const scope = getContainerScope(container);
  pendingActions.set(scope, {
    actionLabel,
    startedAt: Date.now()
  });
}

function handleWindowMessage(event) {
  if (event.source !== window || !event.data || event.data.source !== "sfdg-network-hook") {
    return;
  }

  const now = Date.now();
  const matchedScopes = [];

  for (const [scope, pending] of pendingActions.entries()) {
    if (now - pending.startedAt > PENDING_ACTION_TTL_MS) {
      pendingActions.delete(scope);
      continue;
    }

    matchedScopes.push(scope);
  }

  Promise.all(
    matchedScopes.map(async (scope) => {
      await clearScopeDrafts(scope);
      pendingActions.delete(scope);
    })
  ).then(() => {
    if (matchedScopes.length) {
      showToast("Draft cleared after successful Salesforce save.");
    }
  });
}

function scheduleSave(element) {
  const priorTimer = saveTimers.get(element);
  if (priorTimer) {
    clearTimeout(priorTimer);
  }

  const timerId = window.setTimeout(() => {
    persistDraft(element).catch((error) => {
      console.error("Salesforce Draft Guard failed to persist a draft.", error);
    });
  }, SAVE_DEBOUNCE_MS);

  saveTimers.set(element, timerId);
}

async function persistDraft(element) {
  const value = readElementValue(element);
  const meta = getDraftMetadata(element);
  if (!meta) {
    return;
  }

  if (!value.trim()) {
    await chrome.storage.local.remove(meta.storageKey);
    draftCache.delete(meta.storageKey);
    return;
  }

  const draft = {
    value,
    updatedAt: Date.now(),
    url: location.href,
    title: document.title,
    scope: meta.scope
  };

  draftCache.set(meta.storageKey, draft);
  await chrome.storage.local.set({
    [meta.storageKey]: draft
  });
  showToast("Draft saved locally.");
}

function scanAndRestore(root) {
  const candidates = [];
  const queryRoot =
    root instanceof Document || root instanceof DocumentFragment || root instanceof Element ? root : null;

  if (root instanceof Element && isDraftCandidate(root)) {
    candidates.push(root);
  }

  if (queryRoot) {
    candidates.push(...queryRoot.querySelectorAll("textarea, input[type='text'], [contenteditable], [contenteditable='true']"));
  }

  candidates.forEach((element) => {
    restoreDraft(element).catch((error) => {
      console.error("Salesforce Draft Guard failed to restore a draft.", error);
    });
  });
}

async function restoreDraft(element) {
  const meta = getDraftMetadata(element);
  if (!meta || hasUserValue(element)) {
    return;
  }

  let draft = draftCache.get(meta.storageKey);
  if (!draft) {
    const result = await chrome.storage.local.get(meta.storageKey);
    draft = result[meta.storageKey];
    if (draft) {
      draftCache.set(meta.storageKey, draft);
    }
  }

  if (!draft || !draft.value) {
    return;
  }

  writeElementValue(element, draft.value);
  dispatchSyntheticInput(element);
  showToast("Recovered a local draft.");
}

async function clearScopeDrafts(scope) {
  const keys = [];

  draftCache.forEach((draft, storageKey) => {
    if (draft.scope === scope) {
      keys.push(storageKey);
    }
  });

  if (!keys.length) {
    const allDrafts = await chrome.storage.local.get(null);
    Object.entries(allDrafts).forEach(([storageKey, draft]) => {
      if (storageKey.startsWith(STORAGE_PREFIX) && draft && draft.scope === scope) {
        keys.push(storageKey);
      }
    });
  }

  if (!keys.length) {
    return;
  }

  keys.forEach((key) => draftCache.delete(key));
  await chrome.storage.local.remove(keys);
}

function getDraftMetadata(element) {
  if (!isDraftCandidate(element)) {
    return null;
  }

  const container = getContainer(element);
  const scope = getContainerScope(container);
  const fieldKey = getFieldKey(element);

  return {
    scope,
    fieldKey,
    storageKey: `${STORAGE_PREFIX}${scope}:${fieldKey}`
  };
}

function getContainer(element) {
  return (
    element.closest(
      "[role='dialog'], article, section, form, .forceChatterPublisher, .oneRecordActionWrapper, .slds-modal, .ql-container"
    ) || document.body
  );
}

function getContainerScope(container) {
  const pageKey = `${location.origin}${location.pathname}`;
  const heading =
    findText(container, "h1, h2, h3, [role='heading'], .title, .slds-text-heading_small") ||
    container.getAttribute("aria-label") ||
    container.getAttribute("data-aura-class") ||
    "";
  const buttons = Array.from(container.querySelectorAll("button, [role='button']"))
    .map((node) => normalizeWhitespace(node.textContent || ""))
    .filter(Boolean)
    .slice(0, 6)
    .join("|");

  return hashKey(`${pageKey}::${heading}::${buttons}`);
}

function getFieldKey(element) {
  const label = getElementLabel(element);
  const placeholder = element.getAttribute("placeholder") || "";
  const name = element.getAttribute("name") || "";
  const classes = element.className || "";
  const path = getDomPath(element);
  return hashKey(`${label}::${placeholder}::${name}::${classes}::${path}`);
}

function getElementLabel(element) {
  const explicitLabel = element.id
    ? document.querySelector(`label[for="${CSS.escape(element.id)}"]`)
    : null;
  if (explicitLabel) {
    return normalizeWhitespace(explicitLabel.textContent || "");
  }

  const parentLabel = element.closest("label");
  if (parentLabel) {
    return normalizeWhitespace(parentLabel.textContent || "");
  }

  return normalizeWhitespace(
    element.getAttribute("aria-label") ||
      element.getAttribute("title") ||
      element.getAttribute("placeholder") ||
      element.getAttribute("data-placeholder") ||
      ""
  );
}

function getDomPath(element) {
  const segments = [];
  let current = element;

  while (current && current !== document.body && segments.length < 5) {
    const tag = current.tagName.toLowerCase();
    const role = current.getAttribute("role");
    const testId = current.getAttribute("data-id");
    segments.unshift([tag, role, testId].filter(Boolean).join("."));
    current = current.parentElement;
  }

  return segments.join(">");
}

function readElementValue(element) {
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
    return element.value || "";
  }

  if (element instanceof HTMLElement && element.isContentEditable) {
    return element.innerText || "";
  }

  return "";
}

function writeElementValue(element, value) {
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
    element.value = value;
    return;
  }

  if (element instanceof HTMLElement && element.isContentEditable) {
    element.innerText = value;
  }
}

function hasUserValue(element) {
  return Boolean(readElementValue(element).trim());
}

function isDraftCandidate(element) {
  if (!(element instanceof Element)) {
    return false;
  }

  const tagName = element.tagName.toLowerCase();
  const isTextInput =
    tagName === "textarea" ||
    (tagName === "input" && (element.getAttribute("type") || "text").toLowerCase() === "text") ||
    (element instanceof HTMLElement && element.isContentEditable);

  if (!isTextInput) {
    return false;
  }

  const label = `${getElementLabel(element)} ${element.className || ""}`.toLowerCase();
  const containerText = (element.closest("[role='dialog'], article, section, form")?.textContent || "").toLowerCase();

  return /(email|post|call|comment|note|description|body|subject|message)/.test(`${label} ${containerText}`);
}

function getDraftElement(target) {
  if (target instanceof Element && isDraftCandidate(target)) {
    return target;
  }

  if (target instanceof Element) {
    const candidate = target.closest("textarea, input[type='text'], [contenteditable], [contenteditable='true']");
    if (candidate && isDraftCandidate(candidate)) {
      return candidate;
    }
  }

  return null;
}

function dispatchSyntheticInput(element) {
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function findText(root, selector) {
  const match = root.querySelector(selector);
  return match ? normalizeWhitespace(match.textContent || "") : "";
}

function normalizeWhitespace(value) {
  return value.replace(/\s+/g, " ").trim();
}

function hashKey(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

function showToast(message) {
  if (!document.body) {
    return;
  }

  if (!toastNode) {
    toastNode = document.createElement("div");
    toastNode.className = "sfdg-toast";
    document.body.appendChild(toastNode);
  }

  toastNode.textContent = message;
  toastNode.dataset.visible = "true";

  window.clearTimeout(showToast.hideTimerId);
  showToast.hideTimerId = window.setTimeout(() => {
    if (toastNode) {
      toastNode.dataset.visible = "false";
    }
  }, TOAST_TTL_MS);
}

const STORAGE_PREFIX = "sfdg:draft:";
const SAVE_DEBOUNCE_MS = 400;
const PENDING_ACTION_TTL_MS = 15000;
const TOAST_TTL_MS = 2200;
const DEFAULT_SETTINGS = {
  protectedActions: ["send", "share", "save", "post", "log a call"],
  fieldKeywords: ["email", "post", "call", "comment", "note", "description", "body", "subject", "message"],
  showToasts: true
};

const draftCache = new Map();
const pendingActions = [];
const saveTimers = new WeakMap();
const storageArea = chrome.storage.session || chrome.storage.local;
const settingsArea = chrome.storage.sync || chrome.storage.local;

let observerStarted = false;
let toastNode;
let settings = { ...DEFAULT_SETTINGS };

bootstrap();

async function bootstrap() {
  settings = await loadSettings();
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
  chrome.storage.onChanged.addListener(handleStorageChange);
}

function handleStorageChange(changes, areaName) {
  if (areaName !== "sync" && areaName !== "local") {
    return;
  }

  const relevantKeys = ["protectedActions", "fieldKeywords", "showToasts"];
  if (!relevantKeys.some((key) => key in changes)) {
    return;
  }

  loadSettings().then((nextSettings) => {
    settings = nextSettings;
  });
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

  const actionLabel = normalizeWhitespace(button.textContent || "").toLowerCase();
  if (!isSubmitAction(actionLabel)) {
    return;
  }

  const container = getContainer(button);
  const draftKeys = getDraftKeysForContainer(container);
  if (!draftKeys.length) {
    return;
  }

  pendingActions.unshift({
    actionLabel,
    draftKeys,
    startedAt: Date.now()
  });

  prunePendingActions();
}

function handleWindowMessage(event) {
  if (event.source !== window || !event.data || event.data.source !== "sfdg-network-hook") {
    return;
  }

  prunePendingActions();

  const pendingAction = pendingActions.shift();
  if (!pendingAction) {
    return;
  }

  clearDraftKeys(pendingAction.draftKeys)
    .then(() => {
      showToast("Draft cleared after successful Salesforce save.");
    })
    .catch((error) => {
      console.error("Salesforce Draft Guard failed to clear saved drafts.", error);
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
    await removeStorageKeys([meta.storageKey]);
    draftCache.delete(meta.storageKey);
    return;
  }

  const draft = {
    value,
    updatedAt: Date.now(),
    url: location.href,
    title: document.title,
    scope: meta.scope,
    fieldKey: meta.fieldKey,
    actionType: meta.actionType,
    label: meta.label
  };

  draftCache.set(meta.storageKey, draft);
  await storageArea.set({
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
    candidates.push(
      ...queryRoot.querySelectorAll("textarea, input[type='text'], [contenteditable], [contenteditable='true']")
    );
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
    const result = await storageArea.get(meta.storageKey);
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

async function clearDraftKeys(storageKeys) {
  if (!storageKeys.length) {
    return;
  }

  storageKeys.forEach((key) => draftCache.delete(key));
  await removeStorageKeys(storageKeys);
}

function getDraftKeysForContainer(container) {
  return Array.from(container.querySelectorAll("textarea, input[type='text'], [contenteditable], [contenteditable='true']"))
    .filter((element) => isDraftCandidate(element))
    .map((element) => getDraftMetadata(element))
    .filter(Boolean)
    .map((meta) => meta.storageKey);
}

function getDraftMetadata(element) {
  if (!isDraftCandidate(element)) {
    return null;
  }

  const container = getContainer(element);
  const scope = getContainerScope(container);
  const actionType = getContainerActionType(container);
  const label = getElementLabel(element);
  const fieldKey = getFieldKey(element, container);

  return {
    scope,
    fieldKey,
    actionType,
    label,
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
  const recordId =
    findRecordId(container) ||
    findRecordId(document.body) ||
    normalizeWhitespace(location.pathname + location.search);
  const actionType = getContainerActionType(container);
  const heading =
    findText(container, "h1, h2, h3, [role='heading'], .title, .slds-text-heading_small") ||
    container.getAttribute("aria-label") ||
    "";

  return hashKey(`${recordId}::${actionType}::${heading}`);
}

function getFieldKey(element, container) {
  const label = getElementLabel(element);
  const placeholder = normalizeWhitespace(element.getAttribute("placeholder") || "");
  const name = normalizeWhitespace(element.getAttribute("name") || "");
  const title = normalizeWhitespace(element.getAttribute("title") || "");
  const inputRole = inferFieldRole(element, container);
  const fieldPosition = getCandidateIndex(element, container);

  return hashKey(`${inputRole}::${label}::${placeholder}::${name}::${title}::${fieldPosition}`);
}

function getContainerActionType(container) {
  const text = normalizeWhitespace(container.textContent || "").toLowerCase();

  if (text.includes("log a call")) {
    return "log-a-call";
  }
  if (text.includes("email")) {
    return "email";
  }
  if (text.includes("post")) {
    return "post";
  }
  if (text.includes("note")) {
    return "note";
  }

  return "activity";
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

function inferFieldRole(element, container) {
  const semanticText = normalizeWhitespace(
    [
      getElementLabel(element),
      element.getAttribute("name") || "",
      element.getAttribute("placeholder") || "",
      element.getAttribute("title") || "",
      container.textContent || ""
    ].join(" ")
  ).toLowerCase();

  if (semanticText.includes("subject")) {
    return "subject";
  }
  if (semanticText.includes("description")) {
    return "description";
  }
  if (semanticText.includes("comment")) {
    return "comment";
  }
  if (semanticText.includes("message")) {
    return "message";
  }
  if (semanticText.includes("body")) {
    return "body";
  }
  if (semanticText.includes("note")) {
    return "note";
  }

  return "draft";
}

function getCandidateIndex(element, container) {
  const candidates = Array.from(
    container.querySelectorAll("textarea, input[type='text'], [contenteditable], [contenteditable='true']")
  ).filter((candidate) => isDraftCandidate(candidate));
  return String(Math.max(candidates.indexOf(element), 0));
}

function findRecordId(root) {
  if (!(root instanceof Element || root instanceof Document)) {
    return "";
  }

  const urlMatch = location.pathname.match(/\/([a-zA-Z0-9]{15,18})(?:\/|$)/);
  if (urlMatch) {
    return urlMatch[1];
  }

  const recordNode = root.querySelector("[data-recordid], [data-record-id], [data-id]");
  if (!recordNode) {
    return "";
  }

  return normalizeWhitespace(
    recordNode.getAttribute("data-recordid") ||
      recordNode.getAttribute("data-record-id") ||
      recordNode.getAttribute("data-id") ||
      ""
  );
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

  const semanticText = normalizeWhitespace(
    `${getElementLabel(element)} ${element.className || ""} ${
      element.closest("[role='dialog'], article, section, form")?.textContent || ""
    }`
  ).toLowerCase();

  return settings.fieldKeywords.some((keyword) => semanticText.includes(keyword));
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

function isSubmitAction(actionLabel) {
  return settings.protectedActions.includes(actionLabel.toLowerCase());
}

function prunePendingActions() {
  const now = Date.now();
  for (let index = pendingActions.length - 1; index >= 0; index -= 1) {
    if (now - pendingActions[index].startedAt > PENDING_ACTION_TTL_MS) {
      pendingActions.splice(index, 1);
    }
  }
}

async function removeStorageKeys(keys) {
  if (!keys.length) {
    return;
  }

  await storageArea.remove(keys);
}

async function loadSettings() {
  const stored = await settingsArea.get(Object.keys(DEFAULT_SETTINGS));
  return normalizeSettings(stored);
}

function normalizeSettings(stored) {
  return {
    protectedActions: normalizeList(stored.protectedActions, DEFAULT_SETTINGS.protectedActions),
    fieldKeywords: normalizeList(stored.fieldKeywords, DEFAULT_SETTINGS.fieldKeywords),
    showToasts: stored.showToasts !== false
  };
}

function normalizeList(value, fallback) {
  const source = Array.isArray(value) ? value : fallback;
  const normalized = source
    .map((entry) => normalizeWhitespace(String(entry || "").toLowerCase()))
    .filter(Boolean);
  return normalized.length ? Array.from(new Set(normalized)) : [...fallback];
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
  if (!settings.showToasts || !document.body) {
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

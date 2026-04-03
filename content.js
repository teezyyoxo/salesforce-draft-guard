const STORAGE_PREFIX = "sfdg:draft:";
const SAVE_DEBOUNCE_MS = 400;
const PENDING_ACTION_TTL_MS = 15000;
const TOAST_TTL_MS = 2200;
const DRAFT_ELEMENT_SELECTOR = "textarea, input[type='text'], [contenteditable='true'], body[contenteditable='true'], .cke_editable";
const KNOWN_DRAFT_SURFACE_SELECTOR = ".publisherInputContainer, .publisherInputContainer textarea, .publisherInputContainer input[type='text'], .publisherInputContainer [contenteditable], body[role='textbox'][contenteditable='true'], body[aria-label='Email Body'][contenteditable='true'], [role='textbox'][contenteditable='true'][aria-label='Email Body'], .cke_editable, .cke_wysiwyg_frame";
const DEBUG_ENABLED = true;
const DEBUG_PREFIX = "[SFDG]";
const EXTENSION_CONTEXT_INVALIDATED_TEXT = "extension context invalidated";
const DEFAULT_SETTINGS = {
  protectedActions: ["send", "share", "save", "post", "log a call"],
  fieldKeywords: ["email", "post", "call", "comment", "note", "description", "body", "subject", "message"],
  showToasts: true
};

const draftCache = new Map();
const pendingActions = [];
const saveTimers = new WeakMap();
const observedEditors = new WeakSet();
const observedFrames = new WeakSet();
const sessionStorageArea = chrome.storage.session;
const localStorageArea = chrome.storage.local;
const settingsArea = chrome.storage.sync || chrome.storage.local;

let observerStarted = false;
let toastNode;
let settings = { ...DEFAULT_SETTINGS };
let storageUnavailableDueToContext = false;

function debugLog(...args) {
  if (!DEBUG_ENABLED) {
    return;
  }

  console.log(DEBUG_PREFIX, ...args);
}

function debugWarn(...args) {
  if (!DEBUG_ENABLED) {
    return;
  }

  console.warn(DEBUG_PREFIX, ...args);
}

function isExtensionContextInvalidated(error) {
  if (!error) {
    return false;
  }

  const message = normalizeWhitespace(String(error.message || error)).toLowerCase();
  return message.includes(EXTENSION_CONTEXT_INVALIDATED_TEXT);
}

function markStorageUnavailable(error, operation) {
  if (!isExtensionContextInvalidated(error)) {
    return false;
  }

  if (!storageUnavailableDueToContext) {
    debugWarn(`storage access disabled after ${operation}: extension context invalidated`, error);
  }
  storageUnavailableDueToContext = true;
  return true;
}

function isElementNode(value) {
  return Boolean(value) && value.nodeType === 1;
}

function isDocumentNode(value) {
  return Boolean(value) && value.nodeType === 9;
}

function isDocumentFragmentNode(value) {
  return Boolean(value) && value.nodeType === 11;
}

function isQueryableRoot(value) {
  return isElementNode(value) || isDocumentNode(value) || isDocumentFragmentNode(value);
}

function isIframeElement(value) {
  return isElementNode(value) && value.tagName && value.tagName.toLowerCase() === "iframe";
}

function isTextInputElement(value) {
  if (!isElementNode(value)) {
    return false;
  }

  const tagName = value.tagName.toLowerCase();
  return tagName === "textarea" || (tagName === "input" && (value.getAttribute("type") || "text").toLowerCase() === "text");
}

function isEditableElement(value) {
  if (!isElementNode(value)) {
    return false;
  }

  return Boolean(value.isContentEditable) || String(value.getAttribute("contenteditable") || "").toLowerCase() === "true";
}

function isEmailEditorElement(element) {
  if (!isElementNode(element)) {
    return false;
  }

  return (
    element.getAttribute("aria-label") === "Email Body" ||
    element.getAttribute("title") === "Email Body" ||
    element.classList.contains("cke_editable") ||
    Boolean(element.closest(".cke_editor_editor, .content.iframe-parent"))
  );
}

function normalizeDraftEditorElement(element) {
  if (!isElementNode(element) || isIframeElement(element) || element.matches(".cke_wysiwyg_frame")) {
    return null;
  }

  const postContainer = element.closest(".publisherInputContainer");
  if (postContainer) {
    return (
      postContainer.querySelector("[contenteditable='true'][role='textbox'], [contenteditable='true'].ql-editor, [contenteditable='true']") ||
      postContainer.querySelector("textarea, input[type='text']") ||
      null
    );
  }

  if (element.matches("body[contenteditable='true'], .cke_editable")) {
    return element;
  }

  if (element.closest(".cke_contents, .cke_editor_editor")) {
    return element.closest(".cke_editable, body[contenteditable='true'], [contenteditable='true']");
  }

  if (element.matches("textarea, input[type='text'], [contenteditable='true']")) {
    return element;
  }

  return null;
}

function getStablePageContextKey() {
  try {
    const url = new URL(location.href);
    const volatileParamPattern = /nonce|token|confirmation|ltn_|clc|cache|timestamp|ts/i;
    const stableParams = [];

    for (const [key, value] of url.searchParams.entries()) {
      if (!volatileParamPattern.test(key)) {
        stableParams.push([key, value]);
      }
    }

    stableParams.sort((a, b) => a[0].localeCompare(b[0]));
    const search = stableParams.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
    return `${url.origin}${url.pathname}${search ? `?${search}` : ""}`;
  } catch (error) {
    debugWarn("failed to build stable page key", error);
    return `${location.origin}${location.pathname}`;
  }
}

function shouldRestoreOverCurrentValue(currentValue, draftValue) {
  const current = normalizeWhitespace(currentValue || "");
  const draft = normalizeWhitespace(draftValue || "");

  if (!current) {
    return true;
  }

  if (!draft || current === draft) {
    return false;
  }

  // Email editors are commonly pre-populated with signature/quoted content.
  // If the current content appears to be a subset of the saved draft, prefer restoring the draft.
  if (draft.includes(current) && draft.length > current.length) {
    return true;
  }

  return false;
}

function collectDraftEditors(root) {
  const queryRoot =
    isQueryableRoot(root) ? root : null;
  if (!queryRoot) {
    return [];
  }

  const uniqueEditors = new Set();
  const pushCandidate = (candidate) => {
    const normalized = normalizeDraftEditorElement(candidate);
    if (!normalized || !isDraftCandidate(normalized)) {
      return;
    }

    uniqueEditors.add(normalized);
  };

  if (isElementNode(queryRoot)) {
    pushCandidate(queryRoot);
  }

  queryRoot.querySelectorAll(DRAFT_ELEMENT_SELECTOR).forEach((candidate) => {
    pushCandidate(candidate);
  });

  return Array.from(uniqueEditors);
}

bootstrap();

async function bootstrap() {
  settings = await loadSettings();
  debugLog("bootstrap", { href: location.href, settings });
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
  document.addEventListener("beforeinput", handleInputEvent, true);
  document.addEventListener("change", handleInputEvent, true);
  document.addEventListener("keyup", handleInputEvent, true);
  document.addEventListener("paste", handleInputEvent, true);
  document.addEventListener("blur", handleInputEvent, true);
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
        if (!isElementNode(addedNode)) {
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
  if (isEmailEditorElement(event.target)) {
    debugLog("email input event", {
      type: event.type,
      targetTag: event.target.tagName,
      targetClass: event.target.className || "",
      ariaLabel: event.target.getAttribute && event.target.getAttribute("aria-label"),
      title: event.target.getAttribute && event.target.getAttribute("title")
    });
  }

  const target = getDraftElement(event.target);
  if (!target) {
    if (isEmailEditorElement(event.target)) {
      debugWarn("email input not matched to draft element", {
        type: event.type,
        targetTag: event.target.tagName,
        targetClass: event.target.className || ""
      });
    }
    return;
  }

  if (isEmailEditorElement(target)) {
    debugLog("email matched draft element", {
      type: event.type,
      tag: target.tagName,
      className: target.className || "",
      valueLength: readElementValue(target).length
    });
  }

  scheduleSave(target);
}

function handleClickEvent(event) {
  const button = isElementNode(event.target) ? event.target.closest("button, [role='button'], a") : null;
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
  if (isEmailEditorElement(element)) {
    debugLog("persistDraft called for email element", {
      valueLength: value.length,
      hasMeta: Boolean(meta)
    });
  }
  if (!meta) {
    return;
  }

  if (!value.trim()) {
    await removeDraftKeys([meta.storageKey]);
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
  await setDraftValue(meta.storageKey, draft);
  if (isEmailEditorElement(element)) {
    debugLog("email draft saved", {
      storageKey: meta.storageKey,
      scope: meta.scope,
      fieldKey: meta.fieldKey,
      valueLength: value.length
    });
  }
  showToast("Draft saved locally.");
}

function scanAndRestore(root) {
  const queryRoot =
    isQueryableRoot(root) ? root : null;
  const candidates = collectDraftEditors(root);

  if (queryRoot) {
    const emailFrames = queryRoot.querySelectorAll("iframe.cke_wysiwyg_frame[title='Email Body']");
    if (emailFrames.length) {
      debugLog("email iframe(s) discovered", { count: emailFrames.length, href: location.href });
    }
    emailFrames.forEach((frame) => {
      attachEmailFrameObserver(frame);
    });
  }

  candidates.forEach((element) => {
    ensureDraftObserver(element);
    restoreDraft(element).catch((error) => {
      console.error("Salesforce Draft Guard failed to restore a draft.", error);
    });
  });
}

async function restoreDraft(element) {
  const meta = getDraftMetadata(element);
  if (!meta) {
    if (isEmailEditorElement(element)) {
      debugLog("email restore skipped", {
        reason: "missing-metadata"
      });
    }
    return;
  }

  const currentValue = readElementValue(element);

  let draft = draftCache.get(meta.storageKey);
  if (!draft) {
    const result = await getDraftValue(meta.storageKey);
    draft = result[meta.storageKey];
    if (draft) {
      draftCache.set(meta.storageKey, draft);
    }
  }

  if (!draft || !draft.value) {
    if (isEmailEditorElement(element)) {
      debugLog("email restore skipped", {
        reason: "no-saved-draft",
        key: meta.storageKey
      });
    }
    return;
  }

  if (!shouldRestoreOverCurrentValue(currentValue, draft.value)) {
    if (isEmailEditorElement(element)) {
      debugLog("email restore skipped", {
        reason: "current-value-not-eligible",
        currentLength: currentValue.length,
        draftLength: draft.value.length,
        key: meta.storageKey
      });
    }
    return;
  }

  writeElementValue(element, draft.value);
  dispatchSyntheticInput(element);
  if (isEmailEditorElement(element)) {
    debugLog("email draft restored", {
      key: meta.storageKey,
      currentLength: currentValue.length,
      draftLength: draft.value.length
    });
  }
  showToast("Recovered a local draft.");
}

async function clearDraftKeys(storageKeys) {
  if (!storageKeys.length) {
    return;
  }

  storageKeys.forEach((key) => draftCache.delete(key));
  await removeDraftKeys(storageKeys);
}

function getDraftKeysForContainer(container) {
  return collectDraftEditors(container)
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
      "[role='dialog'], article, section, form, .forceChatterPublisher, .oneRecordActionWrapper, .slds-modal, .ql-container, .publisherInputContainer, .cke_contents, .cke_inner"
    ) || document.body
  );
}

function getContainerScope(container) {
  const recordId =
    findRecordId(container) ||
    findRecordId(document.body) ||
    getStablePageContextKey();
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

  if (container.matches(".publisherInputContainer") || container.querySelector(".publisherInputContainer")) {
    return "post";
  }
  if (
    container.matches("body[role='textbox'][contenteditable='true'], body[aria-label='Email Body'][contenteditable='true'], .cke_editable, .cke_wysiwyg_frame") ||
    text.includes("email body")
  ) {
    return "email";
  }
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
  const candidates = collectDraftEditors(container);
  return String(Math.max(candidates.indexOf(element), 0));
}

function findRecordId(root) {
  if (!(isElementNode(root) || isDocumentNode(root))) {
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
  if (isTextInputElement(element)) {
    return element.value || "";
  }

  if (isEditableElement(element)) {
    return element.innerText || "";
  }

  return "";
}

function writeElementValue(element, value) {
  if (isTextInputElement(element)) {
    element.value = value;
    return;
  }

  if (isEditableElement(element)) {
    element.innerText = value;
  }
}

function hasUserValue(element) {
  return Boolean(readElementValue(element).trim());
}

function isDraftCandidate(element) {
  if (!isElementNode(element)) {
    return false;
  }

  const tagName = element.tagName.toLowerCase();
  const isTextInput =
    tagName === "textarea" ||
    (tagName === "input" && (element.getAttribute("type") || "text").toLowerCase() === "text") ||
    isEditableElement(element);

  if (!isTextInput) {
    return false;
  }

  if (matchesKnownDraftSurface(element)) {
    return true;
  }

  const semanticText = normalizeWhitespace(
    `${getElementLabel(element)} ${element.className || ""} ${getContainer(element).textContent || ""}`
  ).toLowerCase();

  return settings.fieldKeywords.some((keyword) => semanticText.includes(keyword));
}

function getDraftElement(target) {
  if (isElementNode(target)) {
    const direct = normalizeDraftEditorElement(target);
    if (direct && isDraftCandidate(direct)) {
      return direct;
    }

    const candidate = target.closest(DRAFT_ELEMENT_SELECTOR);
    const normalized = normalizeDraftEditorElement(candidate);
    if (normalized && isDraftCandidate(normalized)) {
      return normalized;
    }
  }

  return null;
}

function ensureDraftObserver(element) {
  if (!isElementNode(element) || observedEditors.has(element)) {
    return;
  }

  if (normalizeDraftEditorElement(element) !== element) {
    return;
  }

  // CKEditor email bodies can mutate DOM without firing reliable input events.
  if (!isEditableElement(element) && element.tagName.toLowerCase() !== "body") {
    return;
  }

  const observer = new MutationObserver((mutations) => {
    if (!mutations.length) {
      return;
    }

    scheduleSave(element);
  });

  observer.observe(element, {
    childList: true,
    subtree: true,
    characterData: true
  });

  observedEditors.add(element);
}

function attachEmailFrameObserver(frame) {
  if (!isIframeElement(frame) || observedFrames.has(frame)) {
    return;
  }

  debugLog("attachEmailFrameObserver", {
    title: frame.title || "",
    name: frame.name || "",
    src: frame.getAttribute("src") || ""
  });

  const bindFrameEditor = () => {
    let frameDocument;
    try {
      frameDocument = frame.contentDocument;
    } catch (error) {
      debugWarn("could not access Email editor iframe", error);
      return;
    }

    if (!frameDocument || !frameDocument.body) {
      debugWarn("email iframe document/body missing");
      return;
    }

    const editorBody = frameDocument.body;
    if (!editorBody.getAttribute("aria-label")) {
      editorBody.setAttribute("aria-label", "Email Body");
    }
    debugLog("email iframe body found", {
      bodyClass: editorBody.className || "",
      ariaLabel: editorBody.getAttribute("aria-label") || "",
      title: editorBody.getAttribute("title") || ""
    });

    const frameSemantics = normalizeWhitespace(
      `${frame.title || ""} ${frame.name || ""} ${editorBody.getAttribute("aria-label") || ""} ${editorBody.getAttribute("title") || ""}`
    ).toLowerCase();
    const isEmailFrameBody =
      isDraftCandidate(editorBody) ||
      editorBody.classList.contains("cke_editable") ||
      frameSemantics.includes("email body");
    if (!isEmailFrameBody) {
      debugWarn("email iframe body is not draft candidate");
      return;
    }

    debugLog("email iframe body accepted as draft candidate");

    ensureDraftObserver(editorBody);
    frameDocument.addEventListener("input", handleInputEvent, true);
    frameDocument.addEventListener("beforeinput", handleInputEvent, true);
    frameDocument.addEventListener("keyup", handleInputEvent, true);
    frameDocument.addEventListener("paste", handleInputEvent, true);
    frameDocument.addEventListener("blur", handleInputEvent, true);
    restoreDraft(editorBody).catch((error) => {
      console.error("Salesforce Draft Guard failed to restore an Email draft.", error);
    });

    debugLog("email iframe listeners attached");
  };

  frame.addEventListener("load", () => {
    debugLog("email iframe load event");
    bindFrameEditor();
  });
  observedFrames.add(frame);
  bindFrameEditor();
}


function matchesKnownDraftSurface(element) {
  if (element.matches(KNOWN_DRAFT_SURFACE_SELECTOR)) {
    return true;
  }

  if (element.closest(".publisherInputContainer")) {
    return true;
  }

  if (
    element.matches("body[role='textbox'][contenteditable='true'], body[aria-label='Email Body'][contenteditable='true'], .cke_editable, .cke_wysiwyg_frame") ||
    element.getAttribute("aria-label") === "Email Body" ||
    element.getAttribute("title") === "Email Body"
  ) {
    return true;
  }

  return false;
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

async function getDraftValue(key) {
  if (storageUnavailableDueToContext) {
    return {};
  }

  if (sessionStorageArea) {
    try {
      const result = await sessionStorageArea.get(key);
      if (result && key in result) {
        return result;
      }
    } catch (error) {
      if (markStorageUnavailable(error, "session read")) {
        return {};
      }
      console.warn("Salesforce Draft Guard session storage read failed, falling back to local storage.", error);
    }
  }

  try {
    return await localStorageArea.get(key);
  } catch (error) {
    if (markStorageUnavailable(error, "local read")) {
      return {};
    }
    throw error;
  }
}

async function setDraftValue(key, value) {
  if (storageUnavailableDueToContext) {
    return;
  }

  if (sessionStorageArea) {
    try {
      await sessionStorageArea.set({ [key]: value });
      debugLog("setDraftValue wrote to session", { key });
      return;
    } catch (error) {
      if (markStorageUnavailable(error, "session write")) {
        return;
      }
      debugWarn("session storage write failed, falling back to local", error);
    }
  }

  try {
    await localStorageArea.set({ [key]: value });
    debugLog("setDraftValue wrote to local", { key });
  } catch (error) {
    if (markStorageUnavailable(error, "local write")) {
      return;
    }
    throw error;
  }
}

async function removeDraftKeys(keys) {
  if (!keys.length) {
    return;
  }

  if (storageUnavailableDueToContext) {
    return;
  }

  const tasks = [];
  if (sessionStorageArea) {
    tasks.push(
      sessionStorageArea.remove(keys).catch((error) => {
        if (markStorageUnavailable(error, "session remove")) {
          return;
        }
        console.warn("Salesforce Draft Guard session storage clear failed.", error);
      })
    );
  }
  tasks.push(
    localStorageArea.remove(keys).catch((error) => {
      if (markStorageUnavailable(error, "local remove")) {
        return;
      }
      throw error;
    })
  );
  await Promise.all(tasks);
}

async function loadSettings() {
  if (storageUnavailableDueToContext) {
    return normalizeSettings({});
  }

  try {
    const stored = await settingsArea.get(Object.keys(DEFAULT_SETTINGS));
    return normalizeSettings(stored);
  } catch (error) {
    if (markStorageUnavailable(error, "settings read")) {
      return normalizeSettings({});
    }
    throw error;
  }
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

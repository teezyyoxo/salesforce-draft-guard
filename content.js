const STORAGE_PREFIX = "sfdg:draft:";
const SAVE_DELAY_MS = 700;
const TOAST_BURST_RESET_MS = 1500;
const PENDING_ACTION_TTL_MS = 15000;
const TOAST_TTL_MS = 2200;
const DRAFT_ELEMENT_SELECTOR = "textarea, input[type='text'], [contenteditable='true'], body[contenteditable='true'], .cke_editable";
const KNOWN_DRAFT_SURFACE_SELECTOR = ".publisherInputContainer, .publisherInputContainer textarea, .publisherInputContainer input[type='text'], .publisherInputContainer [contenteditable], body[role='textbox'][contenteditable='true'], body[aria-label='Email Body'][contenteditable='true'], [role='textbox'][contenteditable='true'][aria-label='Email Body'], .cke_editable, .cke_wysiwyg_frame";
// Flip to true to surface [SFDG] diagnostics in the DevTools console (draft keys, save/
// restore paths, iframe binding). Off by default to keep the console clean; genuine failures
// are still reported via console.error regardless of this flag.
const DEBUG_ENABLED = false;
const DEBUG_PREFIX = "[SFDG]";
const EXTENSION_CONTEXT_INVALIDATED_TEXT = "extension context invalidated";
const DEFAULT_SETTINGS = {
  protectedActions: ["send", "share", "save", "post", "log a call"],
  fieldKeywords: ["email", "post", "call", "comment", "note", "description", "body", "subject", "message"],
  showToasts: true,
  toastPosition: "lower-right",
  toastSize: "medium",
  toastFrequency: "typing-burst",
  toastTextColor: "#f9fafb",
  toastBackgroundColor: "#111827",
  toastSound: "none"
};
const TOAST_POSITIONS = ["upper-right", "upper-left", "lower-left", "lower-right", "lower-middle", "absolute-middle", "upper-middle"];
const TOAST_SIZES = ["small", "medium", "large", "extra-large"];
const TOAST_FREQUENCIES = ["typing-burst", "once-per-draft", "every-save"];
const TOAST_SOUNDS = ["none", "soft-chime", "click", "success-tone"];

const RESTORE_GUARD_RELEASE_MS = 150;

const draftCache = new Map();
const pendingActions = [];
const trackedEditors = new Map();
const saveTimers = new WeakMap();
const submittedEditors = new WeakSet();
const toastStateByElement = new WeakMap();
const observedEditors = new WeakSet();
const observedFrames = new WeakSet();
const restoringNow = new WeakSet();
const restoredEditors = new WeakSet();
const toastedFieldKeys = new Set();
const clearedDraftKeys = new Set();
const draftGenerations = new Map();
const draftStorageQueues = new Map();
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

function getPageWindow() {
  try {
    if (window.top && window.top.location && !String(window.top.location.href).startsWith("about:")) {
      return window.top;
    }
  } catch (error) {
    debugWarn("top window context unavailable", error);
  }

  return window;
}

function getPageDocument() {
  try {
    const pageWindow = getPageWindow();
    if (pageWindow.document && pageWindow.document.body) {
      return pageWindow.document;
    }
  } catch (error) {
    debugWarn("top document context unavailable", error);
  }

  return document;
}

function getPageLocationHref() {
  try {
    return getPageWindow().location.href;
  } catch (error) {
    debugWarn("top location context unavailable", error);
    return location.href;
  }
}

function getPageTitle() {
  const pageDocument = getPageDocument();
  return pageDocument.title || document.title;
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

function isElementRenderable(element) {
  // Treat an element as restorable only when it is actually laid out. display:none and
  // detached nodes report no client rects; if the API is unavailable (unit tests) assume true.
  if (isElementNode(element) && typeof element.getClientRects === "function") {
    return element.getClientRects().length > 0;
  }
  return true;
}

function isEmailEditorElement(element) {
  if (!isElementNode(element)) {
    return false;
  }

  if (!isEditableElement(element)) {
    return false;
  }

  // Identify only the editable Email body itself. The previous `closest(".cke_editor_editor")`
  // clause matched every descendant of the CKEditor wrapper (toolbar buttons, layout divs),
  // which produced a console warning on input events that legitimately are not draft fields.
  return (
    element.getAttribute("aria-label") === "Email Body" ||
    element.getAttribute("title") === "Email Body" ||
    Boolean(element.classList && element.classList.contains("cke_editable"))
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
    const url = new URL(getPageLocationHref());
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

function shouldRestoreOverCurrentValue(currentValue) {
  // Only restore into a genuinely empty field. The previous "current is a subset of the
  // draft" heuristic caused the editor to re-inject the full draft on every backspace
  // (the field became a prefix of the draft, so it kept snapping back). Combined with the
  // one-restore-per-element guard in restoreDraft, this lets the user freely edit and delete.
  return !normalizeWhitespace(currentValue || "");
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
  document.addEventListener("focusin", handleFocusEvent, true);
  document.addEventListener("click", handleClickEvent, true);
  window.addEventListener("message", handleWindowMessage);
  chrome.storage.onChanged.addListener(handleStorageChange);
}

function handleFocusEvent(event) {
  // Retry restore when the user focuses a draft field. This covers composers that Salesforce
  // hides/shows by toggling visibility (e.g. switching publisher tabs) without a DOM mutation
  // that would otherwise trigger a scan, so a deferred restore still happens once the field is
  // actually shown and interactable.
  const target = getDraftElement(event.target);
  if (!target) {
    return;
  }

  restoreDraft(target).catch((error) => {
    console.error("Salesforce Draft Guard failed to restore a draft on focus.", error);
  });
}

function handleStorageChange(changes, areaName) {
  if (areaName === "session" || areaName === "local") {
    const removedDraftKeys = Object.entries(changes)
      .filter(([key, change]) => key.startsWith(STORAGE_PREFIX) && !change.newValue)
      .map(([key]) => key);
    if (removedDraftKeys.length) {
      // Email bodies run in CKEditor iframes, which have their own content-script instance.
      // A clear initiated by the outer Send button must therefore also cancel any debounce
      // timer in that frame before it can rewrite the just-removed draft.
      markDraftKeysCleared(removedDraftKeys);
    }
  }

  if (areaName !== "sync" && areaName !== "local") {
    return;
  }

  const relevantKeys = [
    "protectedActions",
    "fieldKeywords",
    "showToasts",
    "toastPosition",
    "toastSize",
    "toastFrequency",
    "toastTextColor",
    "toastBackgroundColor",
    "toastSound"
  ];
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
  const target = getDraftElement(event.target);
  if (!target) {
    return;
  }

  scheduleSave(target, event.type);
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
  const draftKeys = getDraftKeysForContainer(container, actionLabel);
  if (!draftKeys.length) {
    return;
  }

  const pendingAction = {
    actionLabel,
    draftKeys,
    editors: getDraftEditorsForContainer(container, actionLabel),
    startedAt: Date.now(),
    expiryTimer: null
  };
  pendingAction.editors.forEach((editor) => submittedEditors.add(editor));
  pendingAction.expiryTimer = window.setTimeout(() => {
    expirePendingAction(pendingAction);
  }, PENDING_ACTION_TTL_MS);
  pendingActions.unshift(pendingAction);

  prunePendingActions();
}

function handleWindowMessage(event) {
  if (event.source !== window || !event.data || event.data.source !== "sfdg-network-hook") {
    return;
  }

  prunePendingActions();

  // A Salesforce record page issues many save-like requests. Only consume a pending composer
  // action when the completed request is compatible with that composer; otherwise an unrelated
  // Details save can clear an Email or Post draft that the user has not submitted.
  const pendingActionIndex = pendingActions.findIndex((pendingAction) =>
    networkResultMatchesPendingAction(event.data.detail, pendingAction)
  );
  if (pendingActionIndex === -1) {
    return;
  }
  const [pendingAction] = pendingActions.splice(pendingActionIndex, 1);
  if (pendingAction.expiryTimer) {
    window.clearTimeout(pendingAction.expiryTimer);
  }

  clearDraftKeys(pendingAction.draftKeys)
    .then(() => {
      showToast("Draft cleared after successful Salesforce save.");
    })
    .catch((error) => {
      console.error("Salesforce Draft Guard failed to clear saved drafts.", error);
    });
}

function scheduleSave(element, eventType = "") {
  // While we are programmatically restoring a draft, the write (and the editor's own
  // re-normalization of it) must not be treated as fresh user input, or it would re-save
  // the restored value and compound line breaks. Both the input listeners and the editor
  // MutationObserver funnel through here, so this single guard covers all save triggers.
  if (restoringNow.has(element)) {
    return;
  }

  // Salesforce can leave the submitted text in an editor briefly while it completes the
  // UI transition. Ignore those late editor events so they cannot recreate a draft that a
  // successful send/post has just cleared. A reused editor becomes eligible again as soon as
  // Salesforce empties it, which lets the next message save normally.
  if (submittedEditors.has(element)) {
    if (hasUserValue(element)) {
      return;
    }
    submittedEditors.delete(element);
  }

  // Clear an intentionally emptied field immediately. Waiting for the regular debounce
  // window left a stale draft available for Salesforce's rerender/focus restore path, which
  // made Backspace/Delete appear to fight the user.
  if (!hasUserValue(element)) {
    // `beforeinput`, `paste`, and `blur` can occur before the editor has applied a user
    // change. Clearing at that point would discard a recoverable draft just as the user
    // focuses it or starts typing, so wait for input/key/mutation events that reflect the
    // editor's actual contents.
    if (["beforeinput", "paste", "blur"].includes(eventType)) {
      return;
    }
    cancelScheduledSave(element);
    clearDraftForEmptyElement(element);
    return;
  }

  const toastState = getToastState(element);
  if (toastState.resetTimer) {
    window.clearTimeout(toastState.resetTimer);
  }
  toastState.resetTimer = window.setTimeout(() => {
    toastState.resetTimer = null;
    toastState.toastShown = false;
  }, TOAST_BURST_RESET_MS);

  // Start the delay on the first typing event rather than restarting it after every
  // keystroke. This makes the first save/toast happen shortly after typing begins while
  // still allowing another save cycle after the prior one completes.
  if (saveTimers.has(element)) {
    return;
  }

  const timerId = window.setTimeout(() => {
    saveTimers.delete(element);
    persistDraft(element).catch((error) => {
      console.error("Salesforce Draft Guard failed to persist a draft.", error);
    });
  }, SAVE_DELAY_MS);

  saveTimers.set(element, timerId);
}

function cancelScheduledSave(element) {
  const timerId = saveTimers.get(element);
  if (timerId) {
    window.clearTimeout(timerId);
  }
  saveTimers.delete(element);
}

function clearDraftForEmptyElement(element) {
  const meta = getDraftMetadata(element);
  if (!meta) {
    return;
  }

  trackDraftEditor(element, meta);
  clearDraftKeys([meta.storageKey]).catch((error) => {
    console.error("Salesforce Draft Guard failed to clear an empty draft.", error);
  });
}

async function persistDraft(element) {
  const value = readElementValue(element);
  const rawHtml = readElementHtml(element);
  const html = isEmailEditorElement(element) && rawHtml
    ? normalizeEmailDraftHtml(rawHtml, element.ownerDocument || document)
    : rawHtml;
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
    await clearDraftKeys([meta.storageKey]);
    return;
  }

  const draft = {
    value,
    html,
    updatedAt: Date.now(),
    url: getPageLocationHref(),
    title: getPageTitle(),
    scope: meta.scope,
    fieldKey: meta.fieldKey,
    actionType: meta.actionType,
    label: meta.label
  };

  draftCache.set(meta.storageKey, draft);
  trackDraftEditor(element, meta);
  const mutationGeneration = getDraftGeneration(meta.storageKey);
  await queueDraftStorageOperation(meta.storageKey, () => setDraftValue(meta.storageKey, draft));
  if (getDraftGeneration(meta.storageKey) === mutationGeneration) {
    clearedDraftKeys.delete(meta.storageKey);
  }
  if (isEmailEditorElement(element)) {
    debugLog("email draft saved", {
      storageKey: meta.storageKey,
      scope: meta.scope,
      fieldKey: meta.fieldKey,
      valueLength: value.length,
      htmlLength: html ? html.length : 0
    });
  }

  if (shouldShowDraftSaveToast(element, meta.storageKey)) {
    showToast("Draft saved locally.");
  }
}

function getToastState(element) {
  let state = toastStateByElement.get(element);
  if (!state) {
    state = {
      resetTimer: null,
      toastShown: false
    };
    toastStateByElement.set(element, state);
  }
  return state;
}

function shouldShowDraftSaveToast(element, storageKey) {
  if (settings.toastFrequency === "every-save") {
    return true;
  }

  if (settings.toastFrequency === "once-per-draft") {
    if (toastedFieldKeys.has(storageKey)) {
      return false;
    }
    toastedFieldKeys.add(storageKey);
    return true;
  }

  const state = getToastState(element);
  if (state.toastShown) {
    return false;
  }
  state.toastShown = true;
  return true;
}

function scanAndRestore(root) {
  const queryRoot =
    isQueryableRoot(root) ? root : null;
  const candidates = collectDraftEditors(root);

  if (queryRoot) {
    if (isIframeElement(queryRoot) && queryRoot.matches("iframe.cke_wysiwyg_frame[title='Email Body']")) {
      attachEmailFrameObserver(queryRoot);
    }

    queryRoot.querySelectorAll("iframe.cke_wysiwyg_frame[title='Email Body']").forEach((frame) => {
      attachEmailFrameObserver(frame);
    });
  }

  candidates.forEach((element) => {
    const meta = getDraftMetadata(element);
    if (meta) {
      trackDraftEditor(element, meta);
    }
    ensureDraftObserver(element);
    restoreDraft(element).catch((error) => {
      console.error("Salesforce Draft Guard failed to restore a draft.", error);
    });
  });
}

async function restoreDraft(element) {
  // Each editor element gets at most one restore attempt in its lifetime. Salesforce
  // re-renders produce brand-new elements (which are not in this set, so they restore),
  // while a persisting element being edited is never re-injected — that is what lets the
  // user delete/backspace freely instead of having the draft snap back.
  if (restoredEditors.has(element)) {
    return;
  }

  const meta = getDraftMetadata(element);
  if (!meta) {
    if (isEmailEditorElement(element)) {
      debugLog("email restore skipped", {
        reason: "missing-metadata"
      });
    }
    return;
  }

  // A clear is authoritative even while Chrome storage finishes removing the old value.
  // Without this tombstone, a freshly rerendered empty composer could read and restore that
  // soon-to-be-removed value in the small gap after the user cleared or submitted it.
  if (clearedDraftKeys.has(meta.storageKey)) {
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
    // No draft yet (storage may still be warming up); leave the element un-marked so a
    // later scan can retry once a draft exists.
    if (isEmailEditorElement(element)) {
      debugLog("email restore skipped", {
        reason: "no-saved-draft",
        key: meta.storageKey
      });
    }
    return;
  }

  if (!shouldRestoreOverCurrentValue(currentValue)) {
    // The field already has content; never overwrite it. Mark handled so we don't keep
    // re-checking and never fight the user's edits.
    restoredEditors.add(element);
    if (isEmailEditorElement(element)) {
      debugLog("email restore skipped", {
        reason: "field-not-empty",
        currentLength: currentValue.length,
        key: meta.storageKey
      });
    }
    return;
  }

  if (!isElementRenderable(element)) {
    // The field is empty and eligible, but not currently shown/interactable (e.g. an inactive
    // publisher tab). Restoring into a hidden editor silently fails, so defer WITHOUT marking;
    // the focus listener and later scans retry once the field is actually visible.
    if (isEmailEditorElement(element)) {
      debugLog("email restore deferred", { reason: "not-rendered", key: meta.storageKey });
    }
    return;
  }

  // Mark handled now so we never re-restore over the user's subsequent edits, even if they
  // later clear the field entirely.
  restoredEditors.add(element);

  writeElementValueGuarded(element, draft);
  trackDraftEditor(element, meta);
  if (isEmailEditorElement(element)) {
    debugLog("email draft restored", {
      key: meta.storageKey,
      currentLength: currentValue.length,
      draftLength: draft.value.length,
      hasHtml: Boolean(draft.html)
    });
  }
  showToast("Recovered a local draft.");
}

async function clearDraftKeys(storageKeys) {
  if (!storageKeys.length) {
    return;
  }

  markDraftKeysCleared(storageKeys);
  await Promise.all(
    storageKeys.map((storageKey) =>
      queueDraftStorageOperation(storageKey, () => removeDraftKeys([storageKey]))
    )
  );
}

function markDraftKeysCleared(storageKeys) {
  storageKeys.forEach((key) => {
    draftCache.delete(key);
    toastedFieldKeys.delete(key);
    clearedDraftKeys.add(key);
    draftGenerations.set(key, getDraftGeneration(key) + 1);
  });
  for (const [element, meta] of trackedEditors.entries()) {
    if (!storageKeys.includes(meta.storageKey)) {
      continue;
    }
    cancelScheduledSave(element);
    const toastState = toastStateByElement.get(element);
    if (toastState) {
      toastState.toastShown = false;
    }
  }
}

function getDraftKeysForContainer(container, actionLabel = "") {
  const scope = getContainerScope(container);
  const actionType = getContainerActionType(container);
  const normalizedAction = normalizeWhitespace(actionLabel).toLowerCase();
  const emailScope = getEmailDraftScope(container);
  const keys = collectDraftEditors(container)
    .map((element) => getDraftMetadata(element))
    .filter((meta) => draftMetadataMatchesAction(meta, scope, actionType, normalizedAction, emailScope))
    .map((meta) => meta.storageKey);

  // The CKEditor Email body is in a separate frame, so the top-page Send button cannot
  // enumerate it directly. Its canonical key is safe to include only for Send.
  if (normalizedAction === "send") {
    keys.push(`${STORAGE_PREFIX}${emailScope}:${hashKey("email-body")}`);
  }
  for (const meta of trackedEditors.values()) {
    if (draftMetadataMatchesAction(meta, scope, actionType, normalizedAction, emailScope)) {
      keys.push(meta.storageKey);
    }
  }

  return Array.from(new Set(keys));
}

function getDraftEditorsForContainer(container, actionLabel = "") {
  const scope = getContainerScope(container);
  const actionType = getContainerActionType(container);
  const normalizedAction = normalizeWhitespace(actionLabel).toLowerCase();
  const emailScope = getEmailDraftScope(container);
  const editors = new Set(
    collectDraftEditors(container).filter((element) => {
      const meta = getDraftMetadata(element);
      return draftMetadataMatchesAction(meta, scope, actionType, normalizedAction, emailScope);
    })
  );

  for (const [element, meta] of trackedEditors.entries()) {
    if (draftMetadataMatchesAction(meta, scope, actionType, normalizedAction, emailScope)) {
      editors.add(element);
    }
  }

  return Array.from(editors);
}

function draftMetadataMatchesAction(meta, scope, actionType, normalizedAction, emailScope) {
  if (!meta) {
    return false;
  }

  if (normalizedAction === "send" && meta.actionType === "email" && meta.scope === emailScope) {
    return true;
  }

  // A generic record Details "Save" is not a composer submission. Limit Save cleanup to
  // activity composers that have an explicit, stable action type; this keeps inactive Email
  // and Post editors out of the pending action even if Salesforce gives their common record
  // ancestor a broad container scope.
  if (normalizedAction === "save" && !["log-a-call", "note"].includes(actionType)) {
    return false;
  }

  return (
    meta.scope === scope &&
    (meta.actionType === actionType ||
      normalizedAction === meta.actionType ||
      (normalizedAction === "send" && meta.actionType === "email"))
  );
}

function networkResultMatchesPendingAction(detail, pendingAction) {
  if (!detail || !pendingAction) {
    return false;
  }

  const url = String(detail.url || "").toLowerCase();
  const actionLabel = normalizeWhitespace(pendingAction.actionLabel || "").toLowerCase();

  if (actionLabel === "send") {
    return url.includes("/emailmessages") || url.includes("/email/simple");
  }

  if (actionLabel === "post" || actionLabel === "share") {
    return url.includes("/chatter/feed-elements");
  }

  if (actionLabel === "log a call" || actionLabel === "save") {
    return ["/tasks", "/events", "/notes"].some((fragment) => url.includes(fragment));
  }

  return false;
}

function trackDraftEditor(element, meta) {
  if (!isElementNode(element) || !meta) {
    return;
  }

  trackedEditors.set(element, meta);
}

function getDraftMetadata(element) {
  if (!isDraftCandidate(element)) {
    return null;
  }

  const container = getContainer(element);
  const actionType = getContainerActionType(container);
  const label = getElementLabel(element);

  let scope;
  let fieldKey;
  if (isEmailEditorElement(element)) {
    // The Salesforce/CKEditor Email body exposes per-load identifiers (instance ids, generated
    // titles/aria-labels) that change on every page load, which broke key matching between save
    // and restore. Derive a canonical key from stable signals only — the record context plus a
    // fixed field id — so the Email draft restores reliably.
    scope = getEmailDraftScope(container);
    fieldKey = hashKey("email-body");
  } else {
    scope = getContainerScope(container);
    fieldKey = getFieldKey(element, container);
  }

  return {
    scope,
    fieldKey,
    actionType,
    label,
    storageKey: `${STORAGE_PREFIX}${scope}:${fieldKey}`
  };
}

function getEmailDraftScope(container) {
  return hashKey(`${getRecordIdForScope(container)}::email`);
}

function getContainer(element) {
  const structural = element.closest(
    "[role='dialog'], article, section, form, .forceChatterPublisher, .oneRecordActionWrapper, .slds-modal, .ql-container, .publisherInputContainer, .cke_contents, .cke_inner"
  );
  if (structural) {
    return structural;
  }

  // The CKEditor Email body lives in its own iframe with no matching ancestor in that
  // document. Use the editor element itself so its draft key stays stable and frame-local
  // instead of collapsing onto the top page body.
  if (isEmailEditorElement(element)) {
    return element;
  }

  return getPageDocument().body || document.body;
}

function getRecordIdForScope(container) {
  // The record id comes from the URL first (stable across reloads) and only falls back to a
  // DOM lookup or the stable page context. It never uses per-load DOM identifiers.
  const pageDocument = getPageDocument();
  return findRecordId(container) || findRecordId(pageDocument.body) || getStablePageContextKey();
}

function getContainerScope(container) {
  if (container.dataset && container.dataset.sfdgScope) {
    return container.dataset.sfdgScope;
  }

  const recordId = getRecordIdForScope(container);
  const actionType = getContainerActionType(container);
  const heading =
    findText(container, "h1, h2, h3, [role='heading'], .title, .slds-text-heading_small") ||
    (container.getAttribute && container.getAttribute("aria-label")) ||
    "";

  const scope = hashKey(`${recordId}::${actionType}::${heading}`);
  if (container.dataset) {
    container.dataset.sfdgScope = scope;
  }
  return scope;
}

function getFieldKey(element, container) {
  if (element.dataset && element.dataset.sfdgFieldKey) {
    return element.dataset.sfdgFieldKey;
  }

  const label = getElementLabel(element);
  const placeholder = normalizeWhitespace(element.getAttribute("placeholder") || "");
  const name = normalizeWhitespace(element.getAttribute("name") || "");
  const title = normalizeWhitespace(element.getAttribute("title") || "");
  const inputRole = inferFieldRole(element, container);
  // DOM position is volatile as Salesforce adds/removes sibling nodes, so only use it to
  // disambiguate fields that expose no intrinsic identity. The key is then frozen on the
  // element so it cannot drift within a session, and the intrinsic signals keep it stable
  // across refreshes.
  const hasIntrinsicIdentity = Boolean(label || placeholder || name || title);
  const fieldPosition = hasIntrinsicIdentity ? "" : getCandidateIndex(element, container);

  const fieldKey = hashKey(`${inputRole}::${label}::${placeholder}::${name}::${title}::${fieldPosition}`);
  if (element.dataset) {
    element.dataset.sfdgFieldKey = fieldKey;
  }
  return fieldKey;
}

function getContainerActionType(container) {
  if (container.dataset && container.dataset.sfdgActionType) {
    return container.dataset.sfdgActionType;
  }

  const actionType = resolveContainerActionType(container);
  if (container.dataset) {
    container.dataset.sfdgActionType = actionType;
  }
  return actionType;
}

function resolveContainerActionType(container) {
  // Prefer stable structural signals over mutable text content so the action type (and
  // therefore the draft scope) does not flip as the user types or Salesforce re-renders.
  const matches = (selector) => Boolean(container.matches && container.matches(selector));
  const has = (selector) => Boolean(container.querySelector && container.querySelector(selector));

  if (matches(".publisherInputContainer") || has(".publisherInputContainer")) {
    return "post";
  }
  if (
    matches("body[role='textbox'][contenteditable='true'], body[aria-label='Email Body'][contenteditable='true'], .cke_editable, .cke_wysiwyg_frame") ||
    has(".cke_editable, .cke_wysiwyg_frame, [aria-label='Email Body'], [title='Email Body']") ||
    (container.getAttribute && container.getAttribute("aria-label") === "Email Body")
  ) {
    return "email";
  }

  // Text-based classification is a last resort only.
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
  const ownerDocument = element.ownerDocument || document;
  const pageDocument = getPageDocument();
  const explicitLabel = element.id
    ? ownerDocument.querySelector(`label[for="${CSS.escape(element.id)}"]`) ||
      pageDocument.querySelector(`label[for="${CSS.escape(element.id)}"]`)
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
      element.getAttribute("data-placeholder") || ""
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

  let pathname = location.pathname;
  try {
    pathname = new URL(getPageLocationHref()).pathname;
  } catch (error) {
    debugWarn("failed to parse page location for record id", error);
  }

  const urlMatch = pathname.match(/\/([a-zA-Z0-9]{15,18})(?:\/|$)/);
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
    return normalizeEditableValue(element.innerText || element.textContent || "");
  }

  return "";
}

function readElementHtml(element) {
  // Capture the editor's own markup for rich surfaces (Post/Email) so bold/italic/links and
  // exact line breaks survive a restore. Plain text inputs have no meaningful HTML.
  if (isEditableElement(element) && typeof element.innerHTML === "string") {
    return element.innerHTML || undefined;
  }

  return undefined;
}

function writeElementValueGuarded(element, draft) {
  // Mark the element as restoring before any DOM mutation so the save triggers fired by the
  // write, the synthetic input, and the editor's own follow-up mutations are all suppressed.
  restoringNow.add(element);

  // Rich contenteditable editors (Quill for Post, CKEditor for Email) ignore a direct
  // innerHTML write — they reconcile against their own model and drop foreign markup, which
  // is why formatting and line breaks were lost. Insert through a synthetic paste so the
  // editor's clipboard pipeline converts the HTML into its model with formatting intact.
  if (isEditableElement(element) && !isTextInputElement(element)) {
    restoreEditableDraft(element, draft);
    return;
  }

  try {
    writeElementValue(element, draft);
    dispatchSyntheticInput(element);
  } catch (error) {
    debugWarn("restore write failed", error);
  }
  releaseRestoreGuard(element);
}

function releaseRestoreGuard(element) {
  // Release after input events and MutationObserver microtasks have settled so a restore
  // never schedules a redundant save. setTimeout (a macrotask) runs after those microtasks.
  window.setTimeout(() => {
    restoringNow.delete(element);
  }, RESTORE_GUARD_RELEASE_MS);
}

function restoreEditableDraft(element, draft) {
  const ownerDocument = element.ownerDocument || document;
  const pasteHandled = insertViaPaste(element, ownerDocument, draft);
  dispatchSyntheticInput(element);

  if (isEmailEditorElement(element)) {
    debugLog("email restore: paste dispatched", { pasteHandled, hasHtml: Boolean(draft && draft.html) });
  }

  // Editors apply pasted content asynchronously, so verify shortly after. Fall back to a
  // direct DOM write only if the field is still empty — restore only targets empty fields,
  // so this can never duplicate content.
  window.setTimeout(() => {
    try {
      const current = readElementValue(element);
      if (!current || !current.trim()) {
        debugLog("restore: paste produced no content, using DOM write fallback", {
          pasteHandled,
          hasHtml: Boolean(draft && typeof draft === "object" && draft.html)
        });
        writeElementValue(element, draft);
        dispatchSyntheticInput(element);
      } else {
        debugLog("restore: paste applied", { length: current.length });
      }
    } catch (error) {
      debugWarn("restore verification failed", error);
    }
    if (isEmailEditorElement(element)) {
      resetEmailEditorViewport(element);
    }
    restoringNow.delete(element);
  }, RESTORE_GUARD_RELEASE_MS);
}

function resetEmailEditorViewport(element) {
  const ownerDocument = element.ownerDocument || document;

  // The synthetic paste leaves CKEditor’s selection at the end of the restored body. When
  // the user focuses the editor, the browser then scrolls that caret into view. Put the caret
  // at the beginning and reset both the iframe body and document scroll positions.
  try {
    const isAttached = element.isConnected !== false &&
      (typeof ownerDocument.contains !== "function" || ownerDocument.contains(element));
    if (isAttached) {
      const selection = typeof ownerDocument.getSelection === "function" ? ownerDocument.getSelection() : null;
      if (selection && typeof ownerDocument.createRange === "function") {
        const range = ownerDocument.createRange();
        range.selectNodeContents(element);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }
  } catch (error) {
    debugWarn("could not reset Email caret position", error);
  }

  element.scrollTop = 0;
  element.scrollLeft = 0;
  const scrollingElement = ownerDocument.scrollingElement || ownerDocument.documentElement;
  if (scrollingElement) {
    scrollingElement.scrollTop = 0;
    scrollingElement.scrollLeft = 0;
  }
  if (ownerDocument.body) {
    ownerDocument.body.scrollTop = 0;
    ownerDocument.body.scrollLeft = 0;
  }
}

function insertViaPaste(element, ownerDocument, draft) {
  const view = ownerDocument.defaultView || window;
  const html = draft && typeof draft === "object" ? draft.html : null;
  const text = getDraftText(draft);

  if (typeof element.focus !== "function" || typeof element.dispatchEvent !== "function") {
    return false;
  }
  if (typeof view.DataTransfer !== "function" || typeof view.ClipboardEvent !== "function") {
    return false;
  }

  try {
    element.focus();
    if (typeof ownerDocument.getSelection === "function" && typeof ownerDocument.createRange === "function") {
      const selection = ownerDocument.getSelection();
      if (selection && typeof selection.removeAllRanges === "function") {
        const range = ownerDocument.createRange();
        range.selectNodeContents(element);
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }

    const dataTransfer = new view.DataTransfer();
    if (text) {
      dataTransfer.setData("text/plain", text);
    }
    if (html) {
      const pasteHtml = isEmailEditorElement(element)
        ? normalizeEmailDraftHtml(html, ownerDocument)
        : sanitizeDraftHtml(html, ownerDocument);
      dataTransfer.setData("text/html", pasteHtml);
    }

    const pasteEvent = new view.ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: dataTransfer
    });
    element.dispatchEvent(pasteEvent);
    return pasteEvent.defaultPrevented === true;
  } catch (error) {
    debugWarn("synthetic paste restore failed", error);
    return false;
  }
}

function getDraftText(draft) {
  if (draft && typeof draft === "object") {
    return String(draft.value || "");
  }
  return String(draft || "");
}

function writeElementValue(element, draft) {
  if (isTextInputElement(element)) {
    element.value = getDraftText(draft);
    return;
  }

  if (isEditableElement(element)) {
    writeContentEditableValue(element, draft);
  }
}

function normalizeEditableValue(value) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[\u200b\u200c\u200d\ufeff]/g, "")
    .replace(/\n+$/g, "");
}

function writeContentEditableValue(element, draft) {
  const ownerDocument = element.ownerDocument || document;
  const html = draft && typeof draft === "object" ? draft.html : null;
  const normalizedText = getDraftText(draft).replace(/\r\n?/g, "\n");

  // When we captured the editor's HTML, restore it so formatting and exact line breaks come
  // back. Setting innerHTML keeps Quill/CKEditor able to re-sync through their own
  // MutationObservers, and the synthetic input dispatched by the caller nudges that sync.
  if (html && typeof element.innerHTML === "string") {
    try {
      element.innerHTML = isEmailEditorElement(element)
        ? normalizeEmailDraftHtml(html, ownerDocument)
        : sanitizeDraftHtml(html, ownerDocument);
      return;
    } catch (error) {
      debugWarn("html restore failed, falling back to plain text", error);
    }
  }

  rebuildContentEditable(element, ownerDocument, normalizedText);
}

function sanitizeDraftHtml(html, ownerDocument) {
  const doc = ownerDocument || document;
  const template = doc.createElement("template");
  template.innerHTML = String(html || "");
  const root = template.content || template;

  if (typeof root.querySelectorAll === "function") {
    root.querySelectorAll("script, style, iframe, object, embed, link, meta, base").forEach((node) => {
      node.remove();
    });
    root.querySelectorAll("*").forEach((node) => {
      Array.from(node.attributes || []).forEach((attr) => {
        const name = attr.name.toLowerCase();
        const value = String(attr.value || "");
        if (name.startsWith("on") || (/^(href|src|xlink:href)$/.test(name) && /^\s*javascript:/i.test(value))) {
          node.removeAttribute(attr.name);
        }
      });
    });
  }

  return template.innerHTML;
}

function normalizeEmailDraftHtml(html, ownerDocument) {
  const sanitizedHtml = sanitizeDraftHtml(html, ownerDocument);
  const template = ownerDocument.createElement("template");
  template.innerHTML = sanitizedHtml;
  const root = template.content || template;
  const rawNodes = Array.from(root.childNodes || []);

  if (!rawNodes.some(isEmailBlockElement)) {
    return template.innerHTML;
  }

  // Pretty-printed whitespace around paragraph nodes is not user content. Leaving it in
  // the line-unit stream would turn indentation/newlines in the saved HTML into extra lines.
  const sourceNodes = rawNodes.filter(
    (node) => node.nodeType !== 3 || Boolean(String(node.textContent || "").trim())
  );

  const lineUnits = collectEmailLineUnits(sourceNodes);
  if (typeof root.replaceChildren !== "function") {
    return template.innerHTML;
  }

  root.replaceChildren();
  lineUnits.forEach((unit, index) => {
    unit.forEach((node) => root.appendChild(node));
    if (index < lineUnits.length - 1) {
      root.appendChild(ownerDocument.createElement("br"));
    }
  });

  return template.innerHTML;
}

function collectEmailLineUnits(nodes) {
  const units = [];
  let inlineNodes = [];

  const flushInlineNodes = () => {
    if (inlineNodes.length) {
      units.push(inlineNodes);
      inlineNodes = [];
    }
  };

  nodes.forEach((node) => {
    if (!isEmailBlockElement(node)) {
      inlineNodes.push(node);
      return;
    }

    flushInlineNodes();
    const childNodes = Array.from(node.childNodes || []);
    const isEmptyBlock = childNodes.every(
      (child) =>
        (child.nodeType === 3 && !String(child.textContent || "").trim()) ||
        (child.nodeType === 1 && child.tagName.toLowerCase() === "br")
    );
    const childUnits = isEmptyBlock ? [] : collectEmailLineUnits(childNodes);
    units.push(...(childUnits.length ? childUnits : [[]]));
  });

  flushInlineNodes();
  return units;
}

function isEmailBlockElement(node) {
  if (!node || node.nodeType !== 1) {
    return false;
  }

  return [
    "ADDRESS",
    "ARTICLE",
    "BLOCKQUOTE",
    "DIV",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "HEADER",
    "P",
    "SECTION"
  ].includes(node.tagName.toUpperCase());
}

function rebuildContentEditable(element, ownerDocument, normalizedValue) {
  element.replaceChildren();

  const lines = normalizedValue.split("\n");
  lines.forEach((line, index) => {
    if (index > 0) {
      element.appendChild(ownerDocument.createElement("br"));
    }
    if (line) {
      element.appendChild(ownerDocument.createTextNode(line));
    }
  });
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

  // The Email composer contains several ordinary text inputs (To, Cc, and Bcc). Its
  // container is classified as `email` from the composer heading, but only the editable
  // Email Body above is a recoverable draft surface.
  if (getContainerActionType(getContainer(element)) === "email") {
    return false;
  }

  // Do not inspect the surrounding form/container here. Salesforce record pages place
  // unrelated fields (for example "Fixed in Release" and "License Requester") beside
  // composer fields, so container text makes every text input look like a draft surface.
  // Generic protection is intentionally limited to the field's own stable attributes.
  const semanticText = normalizeWhitespace(
    [
      getElementLabel(element),
      element.getAttribute("name") || "",
      element.getAttribute("placeholder") || "",
      element.getAttribute("title") || "",
      element.getAttribute("data-placeholder") || ""
    ].join(" ")
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
      const [expiredAction] = pendingActions.splice(index, 1);
      releaseExpiredPendingAction(expiredAction);
    }
  }
}

function expirePendingAction(pendingAction) {
  const index = pendingActions.indexOf(pendingAction);
  if (index === -1) {
    return;
  }

  pendingActions.splice(index, 1);
  releaseExpiredPendingAction(pendingAction);
}

function releaseExpiredPendingAction(pendingAction) {
  if (!pendingAction) {
    return;
  }
  if (pendingAction.expiryTimer) {
    window.clearTimeout(pendingAction.expiryTimer);
  }

  // No successful save was observed. Resume normal draft protection for the existing text
  // so a failed submission never discards the user's work.
  (pendingAction.editors || []).forEach((editor) => {
    submittedEditors.delete(editor);
    if (hasUserValue(editor)) {
      scheduleSave(editor);
    }
  });
}

function getDraftGeneration(storageKey) {
  return draftGenerations.get(storageKey) || 0;
}

function queueDraftStorageOperation(storageKey, operation) {
  const previous = draftStorageQueues.get(storageKey) || Promise.resolve();
  const queued = previous.catch(() => {}).then(operation);
  draftStorageQueues.set(storageKey, queued);

  return queued.finally(() => {
    if (draftStorageQueues.get(storageKey) === queued) {
      draftStorageQueues.delete(storageKey);
    }
  });
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
    showToasts: stored.showToasts !== false,
    toastPosition: normalizeChoice(stored.toastPosition, TOAST_POSITIONS, DEFAULT_SETTINGS.toastPosition),
    toastSize: normalizeChoice(stored.toastSize, TOAST_SIZES, DEFAULT_SETTINGS.toastSize),
    toastFrequency: normalizeChoice(stored.toastFrequency, TOAST_FREQUENCIES, DEFAULT_SETTINGS.toastFrequency),
    toastTextColor: normalizeColor(stored.toastTextColor, DEFAULT_SETTINGS.toastTextColor),
    toastBackgroundColor: normalizeColor(stored.toastBackgroundColor, DEFAULT_SETTINGS.toastBackgroundColor),
    toastSound: normalizeChoice(stored.toastSound, TOAST_SOUNDS, DEFAULT_SETTINGS.toastSound)
  };
}

function normalizeChoice(value, allowedValues, fallback) {
  const normalized = normalizeWhitespace(String(value || "").toLowerCase());
  return allowedValues.includes(normalized) ? normalized : fallback;
}

function normalizeColor(value, fallback) {
  const normalized = normalizeWhitespace(String(value || ""));
  return /^#[0-9a-fA-F]{6}$/.test(normalized) ? normalized : fallback;
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
  toastNode.dataset.position = settings.toastPosition;
  toastNode.dataset.size = settings.toastSize;
  toastNode.style.setProperty("--sfdg-toast-text", settings.toastTextColor);
  toastNode.style.setProperty("--sfdg-toast-background", hexToRgba(settings.toastBackgroundColor, 0.94));
  toastNode.dataset.visible = "true";
  playToastSound(settings.toastSound);

  window.clearTimeout(showToast.hideTimerId);
  showToast.hideTimerId = window.setTimeout(() => {
    if (toastNode) {
      toastNode.dataset.visible = "false";
    }
  }, TOAST_TTL_MS);
}

function hexToRgba(hexColor, alpha) {
  const match = /^#([0-9a-fA-F]{6})$/.exec(hexColor);
  if (!match) {
    return hexColor;
  }

  const value = match[1];
  const red = parseInt(value.slice(0, 2), 16);
  const green = parseInt(value.slice(2, 4), 16);
  const blue = parseInt(value.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function playToastSound(soundName) {
  if (soundName === "none") {
    return;
  }

  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) {
      return;
    }

    const context = new AudioContext();
    if (context.state === "suspended" && typeof context.resume === "function") {
      context.resume().catch(() => {});
    }

    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.035, context.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.35);
    gain.connect(context.destination);

    const tones = getToastTones(soundName);
    tones.forEach((tone) => {
      const oscillator = context.createOscillator();
      oscillator.type = tone.type;
      oscillator.frequency.setValueAtTime(tone.frequency, context.currentTime + tone.start);
      oscillator.connect(gain);
      oscillator.start(context.currentTime + tone.start);
      oscillator.stop(context.currentTime + tone.end);
    });

    window.setTimeout(() => {
      context.close().catch(() => {});
    }, 600);
  } catch (error) {
    debugWarn("toast sound failed", error);
  }
}

function getToastTones(soundName) {
  if (soundName === "click") {
    return [{ frequency: 520, start: 0, end: 0.08, type: "triangle" }];
  }

  if (soundName === "success-tone") {
    return [
      { frequency: 660, start: 0, end: 0.12, type: "sine" },
      { frequency: 880, start: 0.1, end: 0.28, type: "sine" }
    ];
  }

  return [
    { frequency: 440, start: 0, end: 0.14, type: "sine" },
    { frequency: 660, start: 0.12, end: 0.32, type: "sine" }
  ];
}

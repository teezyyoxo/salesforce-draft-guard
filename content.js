const STORAGE_PREFIX = "sfdg:draft:";
const SAVE_DELAY_MS = 700;
const EMAIL_BASELINE_SETTLE_MS = 800;
const EMAIL_RICH_INSERT_TIMEOUT_MS = 120000;
const EMAIL_FRAME_SELECTOR = "iframe.cke_wysiwyg_frame[title='Email Body']";
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
const TAB_CONTEXT_MESSAGE_TYPE = "sfdg:get-tab-context";
const FALLBACK_TAB_CONTEXT_STORAGE_KEY = "sfdg:tab-context";
const MANUAL_CLEAR_SIGNAL_KEY = "sfdg:draft-clear-signal";
const DEFAULT_SETTINGS = {
  protectedActions: ["send", "share", "save", "post", "log a call"],
  fieldKeywords: ["email", "post", "call", "comment", "note", "description", "body", "subject", "message"],
  confirmBeforeRefresh: true,
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
const editorDraftOwnership = new WeakMap();
const saveTimers = new Map();
const submittedEditors = new WeakSet();
const toastStateByElement = new WeakMap();
const observedEditors = new WeakSet();
const observedFrames = new WeakSet();
const restoringNow = new WeakSet();
const restoredDraftKeys = new WeakMap();
const clearedEditorReadyKeys = new WeakMap();
const toastedFieldKeys = new Set();
const clearedDraftKeys = new Set();
const draftGenerations = new Map();
const draftStorageQueues = new Map();
const emailDraftStates = new WeakMap();
const emailRestoreTimers = new WeakMap();
const sessionStorageArea = chrome.storage.session;
const localStorageArea = chrome.storage.local;
const settingsArea = chrome.storage.sync || chrome.storage.local;

let observerStarted = false;
let toastNode;
let settings = { ...DEFAULT_SETTINGS };
let storageUnavailableDueToContext = false;
let tabContextKey = "";

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
  // The parent observes its accessible CKEditor body, including native insert buttons.
  // Only one instance may decide which part of that body belongs to the user.
  if (window.frameElement?.matches(EMAIL_FRAME_SELECTOR)) {
    return;
  }
  [settings, tabContextKey] = await Promise.all([loadSettings(), loadTabContextKey()]);
  updateRefreshConfirmation();
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

function updateRefreshConfirmation() {
  // The top-level handler also covers interaction in embedded editors. Installing it in
  // each frame would allow Salesforce's normal iframe reloads to bring up the prompt.
  if (window !== window.top) {
    return;
  }

  if (settings.confirmBeforeRefresh) {
    window.addEventListener("beforeunload", handleBeforeUnload);
  } else {
    window.removeEventListener("beforeunload", handleBeforeUnload);
  }
}

function handleBeforeUnload(event) {
  event.preventDefault();
  event.returnValue = true;
}

async function loadTabContextKey() {
  if (chrome.runtime && typeof chrome.runtime.sendMessage === "function") {
    try {
      const response = await chrome.runtime.sendMessage({ type: TAB_CONTEXT_MESSAGE_TYPE });
      if (response && response.tabContext) {
        return String(response.tabContext);
      }
    } catch (error) {
      debugWarn("could not obtain Chrome tab identity", error);
    }
  }

  // Runtime messaging is expected in Chrome. Keep a top-level sessionStorage fallback so
  // temporary service-worker unavailability never collapses every tab onto a shared key.
  try {
    const pageWindow = getPageWindow();
    const storage = pageWindow.sessionStorage;
    let fallback = storage && storage.getItem(FALLBACK_TAB_CONTEXT_STORAGE_KEY);
    if (!fallback) {
      fallback = `fallback-${createRandomContextId()}`;
      if (storage) {
        storage.setItem(FALLBACK_TAB_CONTEXT_STORAGE_KEY, fallback);
      }
    }
    return fallback;
  } catch (error) {
    debugWarn("could not persist fallback tab identity", error);
    return `fallback-${createRandomContextId()}`;
  }
}

function createRandomContextId() {
  const cryptoSource = (typeof crypto !== "undefined" && crypto) || (window && window.crypto);
  if (cryptoSource && typeof cryptoSource.randomUUID === "function") {
    return cryptoSource.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function getDraftTabContextKey() {
  return tabContextKey || "unresolved-tab";
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
  document.addEventListener("drop", handleInputEvent, true);
  document.addEventListener("blur", handleInputEvent, true);
  document.addEventListener("focusin", handleFocusEvent, true);
  document.addEventListener("click", handleClickEvent, true);
  document.addEventListener("visibilitychange", handleVisibilityChange);
  window.addEventListener("pagehide", flushPendingDrafts);
  window.addEventListener("message", handleWindowMessage);
  chrome.storage.onChanged.addListener(handleStorageChange);
}

function handleVisibilityChange() {
  // Hidden is dispatched before a tab is discarded or closed, while the document is still
  // usable. Flushing here covers a reload/close that happens before the normal 700 ms typing
  // debounce expires; pagehide below provides a second chance for browser navigation.
  if (document.visibilityState === "hidden") {
    flushPendingDrafts();
  }
}

function flushPendingDrafts() {
  // Salesforce can reset or detach a composer before pagehide. Keep the text and record
  // identity captured at edit time, including for editors inside CKEditor frames.
  for (const editor of saveTimers.keys()) {
    const scheduledSave = cancelScheduledSave(editor);
    if (submittedEditors.has(editor) || clearedDraftKeys.has(scheduledSave.meta.storageKey)) {
      continue;
    }

    persistDraft(editor, scheduledSave.meta, scheduledSave.snapshot).catch((error) => {
      console.error("Salesforce Draft Guard failed to flush a draft before page exit.", error);
    });
  }
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
  if (
    areaName === "local" &&
    changes[MANUAL_CLEAR_SIGNAL_KEY] &&
    changes[MANUAL_CLEAR_SIGNAL_KEY].newValue
  ) {
    handleManualDraftClear(changes[MANUAL_CLEAR_SIGNAL_KEY].newValue);
  }

  if (areaName === "session" || areaName === "local") {
    const removedDraftKeys = Object.entries(changes)
      .filter(([key, change]) =>
        key.startsWith(STORAGE_PREFIX) && !change.newValue && !clearedDraftKeys.has(key)
      )
      .map(([key]) => key);
    if (removedDraftKeys.length) {
      // Email bodies run in CKEditor iframes, which have their own content-script instance.
      // A clear initiated by the outer Send button must therefore also cancel any debounce
      // timer in that frame before it can rewrite the just-removed draft.
      markDraftKeysCleared(removedDraftKeys);
    }
  }

  const settingsAreaName = chrome.storage.sync ? "sync" : "local";
  if (areaName !== settingsAreaName || !Object.keys(DEFAULT_SETTINGS).some((key) => key in changes)) {
    return;
  }

  // The event already carries the new values. Applying them in order avoids a second
  // asynchronous storage read that could reapply an older toggle state.
  const nextSettings = { ...settings };
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (key in changes) {
      nextSettings[key] = changes[key].newValue;
    }
  }
  settings = normalizeSettings(nextSettings);
  updateRefreshConfirmation();
}

function handleManualDraftClear(command) {
  const storageKeys = new Set();

  if (command && command.all) {
    draftCache.forEach((_draft, key) => storageKeys.add(key));
    draftStorageQueues.forEach((_operation, key) => storageKeys.add(key));
    saveTimers.forEach(({ meta }) => storageKeys.add(meta.storageKey));
    trackedEditors.forEach((meta) => storageKeys.add(meta.storageKey));
    pendingActions.forEach((action) => {
      (action.draftKeys || []).forEach((key) => storageKeys.add(key));
    });
  } else if (command && Array.isArray(command.keys)) {
    command.keys
      .filter((key) => typeof key === "string" && key.startsWith(STORAGE_PREFIX))
      .forEach((key) => storageKeys.add(key));
  }

  const keys = Array.from(storageKeys);
  if (!keys.length) {
    return;
  }

  markDraftKeysCleared(keys);

  // A manual clear is different from a successful Send/Share/Save. Existing Salesforce text
  // stays unsaved, but the next genuine edit may begin a fresh autosave immediately; it does
  // not have to wait for Salesforce to empty and recycle the composer first.
  const keySet = new Set(keys);
  trackedEditors.forEach((meta, editor) => {
    if (keySet.has(meta.storageKey)) {
      clearedEditorReadyKeys.set(editor, meta.storageKey);
    }
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
  if (event.isTrusted && event.type === "change" && event.target?.matches?.('input[type="file"]') &&
    Array.from(event.target.files || []).some((file) => file.type.startsWith("image/"))) {
    armEmailRichInsert(event.target, "image");
    return;
  }
  const target = getDraftElement(event.target);
  if (!target) {
    return;
  }

  const eventType = event.type === "keyup" && ["Backspace", "Delete"].includes(event.key)
    ? "delete-key"
    : event.type;
  scheduleSave(target, eventType, event.isTrusted);
}

function handleClickEvent(event) {
  const button = isElementNode(event.target) ? event.target.closest("button, [role='button'], a") : null;
  if (!button) {
    return;
  }

  if (event.isTrusted) {
    const insertType = getRichInsertType(button);
    if (insertType) {
      armEmailRichInsert(button, insertType);
    }
  }
  const actionLabel = getSubmitActionLabel(button);
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
    actionType: getContainerActionType(container),
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

function getRichInsertType(button) {
  const labels = [button.getAttribute("aria-label"), button.getAttribute("title"), button.textContent];
  for (const type of ["image", "link"]) {
    if (button.matches(`.cke_button__${type}, [data-value='${type}']`) || labels.some((label) => {
      const text = normalizeWhitespace(label || "").toLowerCase();
      return [type, `${type}s`, `insert ${type}`, `add ${type}`, `upload ${type}`, `select ${type}`].includes(text) ||
        (type === "image" && text === "insert an image") || (type === "link" && text === "insert a link");
    })) {
      return type;
    }
  }
  return "";
}

function armEmailRichInsert(control, type) {
  const container = control.closest(".cke") || getContainer(control);
  if (!container || container === control.ownerDocument.body || getContainerActionType(container) !== "email") {
    return;
  }
  const editors = new Set(collectDraftEditors(container).filter(isEmailEditorElement));
  for (const frame of container.querySelectorAll(EMAIL_FRAME_SELECTOR)) {
    const body = frame.contentDocument?.body;
    if (isElementRenderable(frame) && isEmailEditorElement(body)) editors.add(body);
  }
  if (editors.size !== 1) return;

  const [editor] = editors;
  const state = initializeEmailDraftState(editor);
  if (state) {
    restoringNow.delete(editor);
    reconcileEmailStateBeforeEdit(editor, state);
    state.richInsert = { type, expiresAt: Date.now() + EMAIL_RICH_INSERT_TIMEOUT_MS };
  }
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

function scheduleSave(element, eventType = "", eventIsTrusted = false) {
  // Ignore the synthetic input and editor mutations from recovery. A trusted input can
  // still save immediately if the user edits while recovery is settling.
  if (restoringNow.has(element) && !eventIsTrusted) {
    return;
  }

  // Salesforce initializes and rerenders the Email composer by mutating the CKEditor body.
  // Those mutations include signatures and the entire quoted conversation, and are not user
  // edits. Only a trusted edit sequence may create an Email draft, and the pre-edit body is
  // retained as an immutable baseline so only the newly authored prefix is persisted.
  if (isEmailEditorElement(element) && !prepareEmailDraftEvent(element, eventType, eventIsTrusted)) {
    return;
  }

  const clearedMeta = clearedDraftKeys.size
    ? trackedEditors.get(element) || getDraftMetadata(element)
    : null;
  if (clearedMeta && clearedDraftKeys.has(clearedMeta.storageKey)) {
    // A successful save/send clear is a tombstone, not merely a cancelled timer. Salesforce
    // and CKEditor can emit late mutations from the submitted editor in another frame. Ignore
    // those until that editor has first reset to empty and then receives a real user edit for
    // the next draft.
    if (!hasUserValue(element)) {
      cancelScheduledSave(element);
      clearedEditorReadyKeys.set(element, clearedMeta.storageKey);
      return;
    }

    const isNewUserEdit = Boolean(eventIsTrusted) && ["input", "change", "paste"].includes(eventType);
    if (isNewUserEdit && clearedEditorReadyKeys.get(element) === clearedMeta.storageKey) {
      clearedDraftKeys.delete(clearedMeta.storageKey);
      clearedEditorReadyKeys.delete(element);
      submittedEditors.delete(element);
    } else {
      cancelScheduledSave(element);
      return;
    }
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
    // Salesforce frequently empties inactive composers when submitting a different one.
    // Require trusted input or a delete key before discarding an empty draft.
    if (!shouldClearDraftForEmptyEvent(eventType, eventIsTrusted)) {
      return;
    }
    cancelScheduledSave(element);
    clearDraftForEmptyElement(element);
    return;
  }

  const currentMeta = getDraftMetadata(element);
  if (!currentMeta) {
    return;
  }

  const previouslyTrackedMeta = trackedEditors.get(element);
  const ownedStorageKey = editorDraftOwnership.get(element);
  if (
    ((ownedStorageKey && ownedStorageKey !== currentMeta.storageKey) ||
      (previouslyTrackedMeta && previouslyTrackedMeta.storageKey !== currentMeta.storageKey)) &&
    !eventIsTrusted
  ) {
    // A route transition can reuse an editor while its old DOM content is still mounted.
    // Never assign that content to the new ticket without a genuine user edit.
    const previousSave = cancelScheduledSave(element);
    if (previousSave && previousSave.meta && previousSave.snapshot) {
      persistDraft(element, previousSave.meta, previousSave.snapshot).catch((error) => {
        console.error("Salesforce Draft Guard failed to persist a draft before record navigation.", error);
      });
    }
    return;
  }
  trackDraftEditor(element, currentMeta);
  editorDraftOwnership.set(element, currentMeta.storageKey);

  const snapshot = captureDraftSnapshot(element);

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
  const scheduledSave = saveTimers.get(element);
  if (scheduledSave) {
    if (scheduledSave.meta && scheduledSave.meta.storageKey === currentMeta.storageKey) {
      scheduledSave.snapshot = snapshot;
      return;
    }
    cancelScheduledSave(element);
    if (scheduledSave.meta && scheduledSave.snapshot) {
      persistDraft(element, scheduledSave.meta, scheduledSave.snapshot).catch((error) => {
        console.error("Salesforce Draft Guard failed to persist a draft before record navigation.", error);
      });
    }
    if (!eventIsTrusted) {
      return;
    }
  }

  const nextScheduledSave = {
    timerId: null,
    meta: currentMeta,
    snapshot
  };
  nextScheduledSave.timerId = window.setTimeout(() => {
    saveTimers.delete(element);
    persistDraft(element, nextScheduledSave.meta, nextScheduledSave.snapshot).catch((error) => {
      console.error("Salesforce Draft Guard failed to persist a draft.", error);
    });
  }, SAVE_DELAY_MS);

  saveTimers.set(element, nextScheduledSave);
}

function shouldClearDraftForEmptyEvent(eventType, eventIsTrusted) {
  return Boolean(eventIsTrusted) && ["input", "delete-key"].includes(eventType);
}

function cancelScheduledSave(element) {
  const scheduledSave = saveTimers.get(element);
  if (scheduledSave) {
    window.clearTimeout(scheduledSave.timerId);
  }
  saveTimers.delete(element);
  return scheduledSave;
}

function clearDraftForEmptyElement(element) {
  const meta = getDraftMetadata(element);
  if (!meta) {
    return;
  }

  trackDraftEditor(element, meta);
  editorDraftOwnership.set(element, meta.storageKey);
  clearDraftKeys([meta.storageKey]).catch((error) => {
    console.error("Salesforce Draft Guard failed to clear an empty draft.", error);
  });
}

function captureDraftSnapshot(element) {
  if (isEmailEditorElement(element)) {
    return captureEmailDraftSnapshot(element);
  }

  const value = readElementValue(element);
  const rawHtml = readElementHtml(element);
  return prepareRichSnapshot(element, {
    value,
    html: rawHtml,
    whiteSpace: rawHtml ? readEditorWhiteSpace(element) : undefined,
    url: getPageLocationHref(),
    title: getPageTitle()
  });
}

function prepareRichSnapshot(element, snapshot) {
  if (snapshot.html) {
    snapshot.baseUrl = element.ownerDocument?.baseURI;
    if (/<img\b[^>]*\ssrc="blob:/i.test(snapshot.html)) {
      snapshot.blobImageSnapshot = SfdgDraftHtml.freezeBlobImages(snapshot.html, element.ownerDocument);
    }
  }
  return snapshot;
}

function initializeEmailDraftState(element, knownRecordId = "") {
  if (!isEmailEditorElement(element)) {
    return null;
  }

  const recordId = knownRecordId || getRecordIdForScope(getContainer(element));
  if (!recordId) {
    return null;
  }

  let state = emailDraftStates.get(element);
  if (state && state.recordId !== recordId) {
    const existingTimer = emailRestoreTimers.get(element);
    if (existingTimer) {
      window.clearTimeout(existingTimer);
      emailRestoreTimers.delete(element);
    }
    state = null;
  }
  if (!state) {
    state = {
      recordId,
      baselineValue: "",
      baselineHtml: "",
      authoredValue: "",
      authoredHtml: "",
      editStarted: false,
      captureSafe: true,
      readyForRestore: false
    };
    emailDraftStates.set(element, state);
    updateEmailBaseline(element, state);
  }
  return state;
}

function updateEmailBaseline(element, state = emailDraftStates.get(element)) {
  if (!state || state.editStarted || restoringNow.has(element)) {
    return;
  }

  state.baselineValue = readElementValue(element);
  state.baselineHtml = readElementHtml(element) || "";
  state.authoredValue = "";
  state.authoredHtml = "";
  state.captureSafe = true;
  state.readyForRestore = false;
  queueEmailRestoreAfterBaselineSettles(element, state);
}

function queueEmailRestoreAfterBaselineSettles(element, state) {
  const existingTimer = emailRestoreTimers.get(element);
  if (existingTimer) {
    window.clearTimeout(existingTimer);
  }

  const timerId = window.setTimeout(() => {
    emailRestoreTimers.delete(element);
    if (state.editStarted || restoringNow.has(element)) {
      return;
    }
    state.readyForRestore = true;
    restoreDraft(element).catch((error) => {
      console.error("Salesforce Draft Guard failed to restore a settled Email draft.", error);
    });
  }, EMAIL_BASELINE_SETTLE_MS);
  emailRestoreTimers.set(element, timerId);
}

function prepareEmailDraftEvent(element, eventType, eventIsTrusted) {
  const state = initializeEmailDraftState(element);
  if (!state) {
    return false;
  }

  if (!eventIsTrusted) {
    const insert = state.richInsert;
    const insertPending = insert && insert.expiresAt > Date.now();
    if (eventType === "rich-insert-mutation" && (insertPending || state.editStarted) && state.captureSafe) {
      const reply = readAuthoredEmail(element, state);
      const hasImage = hasInlineImage(reply.html);
      const hasLink = hasHyperlink(reply.html);
      const matchesInsert = insertPending && (insert.type === "image" ? hasImage && !reply.value?.trim() : hasLink);
      if (reply.value !== null && (matchesInsert || (state.editStarted && (hasImage || hasLink)))) {
        state.richInsert = null;
        state.editStarted = true;
        state.readyForRestore = true;
        return true;
      }
    }
    if (insertPending && !state.editStarted) {
      return false;
    }
    if (!state.editStarted) {
      updateEmailBaseline(element, state);
    } else if (!readElementValue(element).trim() && !(readElementHtml(element) || "").trim()) {
      // Salesforce empties and reuses the CKEditor body after Send. Reset the authored/baseline
      // boundary so the next real reply can be protected as a new draft.
      state.editStarted = false;
      state.authoredValue = "";
      state.authoredHtml = "";
      state.captureSafe = true;
      updateEmailBaseline(element, state);
    } else {
      reconcileEmailFrameworkMutation(element, state);
      refreshPendingEmailSnapshot(element, state);
    }
    return false;
  }

  if (["beforeinput", "paste", "drop"].includes(eventType)) {
    reconcileEmailStateBeforeEdit(element, state);
    state.editStarted = true;
    state.readyForRestore = true;
    return state.captureSafe;
  }

  // A standalone input event gives us no trustworthy pre-edit boundary between authored text
  // and quoted history. Modern CKEditor emits beforeinput/paste first; otherwise skip the save
  // instead of risking persistence of the full conversation.
  if (!state.editStarted) {
    return false;
  }

  return state.captureSafe && ["input", "change", "delete-key"].includes(eventType);
}

function reconcileEmailStateBeforeEdit(element, state) {
  if (!state.editStarted) {
    state.baselineValue = readElementValue(element);
    state.baselineHtml = readElementHtml(element) || "";
    state.authoredValue = "";
    state.authoredHtml = "";
    state.captureSafe = true;
    return;
  }

  const { value, html } = readAuthoredEmail(element, state);
  if (value === null) {
    state.captureSafe = false;
    return;
  }

  state.authoredValue = value;
  state.authoredHtml = html || "";
}

function reconcileEmailFrameworkMutation(element, state) {
  if (!state.captureSafe || restoringNow.has(element)) {
    return;
  }

  const currentValue = readElementValue(element);
  if (!state.baselineValue && currentValue !== state.authoredValue) {
    if (currentValue.startsWith(state.authoredValue)) {
      state.baselineValue = currentValue.slice(state.authoredValue.length);
      const currentHtml = readElementHtml(element) || "";
      state.baselineHtml = state.authoredHtml && currentHtml.startsWith(state.authoredHtml)
        ? currentHtml.slice(state.authoredHtml.length)
        : null;
      return;
    }
    state.captureSafe = false;
    return;
  }

  const { value } = readAuthoredEmail(element, state, currentValue);
  if (value !== null) {
    state.authoredValue = value;
    return;
  }

  // Salesforce can append the quoted chain after the first user event. If the already-captured
  // authored prefix is byte-for-byte intact, adopt only the appended suffix as the baseline.
  if (state.authoredValue && currentValue.startsWith(state.authoredValue)) {
    state.baselineValue = currentValue.slice(state.authoredValue.length);
    const currentHtml = readElementHtml(element) || "";
    if (state.authoredHtml && currentHtml.startsWith(state.authoredHtml)) {
      state.baselineHtml = currentHtml.slice(state.authoredHtml.length);
    } else {
      state.baselineHtml = null;
      state.authoredHtml = "";
    }
    return;
  }

  state.captureSafe = false;
}

function captureEmailDraftSnapshot(element) {
  const state = emailDraftStates.get(element);
  const snapshot = {
    value: "",
    html: undefined,
    url: getPageLocationHref(),
    title: getPageTitle(),
    emailContextKey: "",
    valid: false
  };
  if (!state || !state.editStarted || !state.captureSafe) {
    return snapshot;
  }

  const { value, html, replacesPlaceholder } = readAuthoredEmail(element, state);
  if (value === null) {
    state.captureSafe = false;
    return snapshot;
  }

  state.authoredValue = value;
  state.authoredHtml = html || "";
  snapshot.value = value;
  snapshot.html = html;
  snapshot.whiteSpace = html ? readEditorWhiteSpace(element) : undefined;
  snapshot.replacesEmailPlaceholder = replacesPlaceholder;
  snapshot.emailContextKey = getEmailBaselineContextKey(state);
  snapshot.valid = true;
  return prepareRichSnapshot(element, snapshot);
}

function refreshPendingEmailSnapshot(element, state) {
  if (!state.captureSafe) {
    return;
  }
  const scheduledSave = saveTimers.get(element);
  if (!scheduledSave || !scheduledSave.snapshot) {
    return;
  }
  const snapshot = captureEmailDraftSnapshot(element);
  if (snapshot.valid) {
    scheduledSave.snapshot = snapshot;
  }
}

function getEmailBaselineContextKey(state) {
  if (!state) {
    return "";
  }
  const baseline = normalizeWhitespace(state.baselineValue);
  // An image-only quoted message has no innerText to distinguish it from another reply.
  const context = baseline || (hasInlineImage(state.baselineHtml) ? state.baselineHtml : "");
  return hashKey(`${state.recordId}::${context}`);
}

function deriveAuthoredEmailPrefix(currentContent, baselineContent) {
  const current = String(currentContent || "");
  const baseline = String(baselineContent || "");
  if (!baseline) {
    return current;
  }
  if (!current.endsWith(baseline)) {
    return null;
  }
  return current.slice(0, current.length - baseline.length);
}

function readAuthoredEmail(element, state, currentValue = readElementValue(element)) {
  const currentHtml = readElementHtml(element) || "";
  const { html, replacesPlaceholder } = getEmailHtmlPrefix(currentHtml, state.baselineHtml);
  let value = deriveAuthoredEmailPrefix(currentValue, state.baselineValue);
  if (value === null && html) {
    // Filling an empty CKEditor paragraph can change the surrounding layout-generated
    // newlines in innerText. Relax those only when the quoted HTML matches exactly.
    value = deriveAuthoredEmailPrefix(currentValue, state.baselineValue.trimStart());
  }
  return { value, html, replacesPlaceholder };
}

function getEmailHtmlPrefix(currentHtml, baselineHtml) {
  // An unknown HTML boundary can still have a verified plain-text boundary. Never let the
  // HTML fallback include the signature or quoted message when its suffix is unknown.
  if (baselineHtml === null) {
    return {};
  }

  const prefix = deriveAuthoredEmailPrefix(currentHtml, baselineHtml);
  if (prefix !== null) {
    return { html: prefix || undefined };
  }

  // CKEditor can use a leading empty paragraph as the first editable line of a reply.
  // Match the rest of the original markup exactly if typing replaced that placeholder.
  const placeholderLength = getEmailPlaceholderLength(baselineHtml);
  if (placeholderLength) {
    const html = deriveAuthoredEmailPrefix(currentHtml, baselineHtml.slice(placeholderLength));
    if (html) {
      return { html, replacesPlaceholder: true };
    }
  }

  return {};
}

function getEmailPlaceholderLength(html) {
  const match = html.match(/^\s*(?:<(p|div)\b[^>]*>(?:\s|&nbsp;)*(?:<br\b[^>]*>(?:\s|&nbsp;)*)?<\/\1>|<br\b[^>]*>)/i);
  return match ? match[0].length : 0;
}

async function persistDraft(element, meta, snapshot) {
  const { value, html } = snapshot;
  if (isEmailEditorElement(element)) {
    debugLog("persistDraft called for email element", {
      valueLength: value.length
    });
  }

  if (snapshot.valid === false) {
    debugWarn("email draft save skipped because quoted-content isolation was ambiguous", {
      key: meta.storageKey
    });
    return;
  }

  // The timer may already have fired when another frame clears this key. Re-check the
  // authoritative tombstone here so a late persist cannot recreate a submitted draft.
  if (clearedDraftKeys.has(meta.storageKey)) {
    return;
  }

  if (!hasDraftContent(snapshot)) {
    await clearDraftKeys([meta.storageKey]);
    return;
  }

  const draft = {
    value,
    html,
    baseUrl: snapshot.baseUrl,
    whiteSpace: snapshot.whiteSpace,
    updatedAt: Date.now(),
    url: snapshot.url,
    title: snapshot.title,
    scope: meta.scope,
    fieldKey: meta.fieldKey,
    actionType: meta.actionType,
    label: meta.label,
    recordId: meta.recordId
  };
  if (snapshot.emailContextKey) {
    draft.emailContextKey = snapshot.emailContextKey;
    if (snapshot.replacesEmailPlaceholder) {
      draft.replacesEmailPlaceholder = true;
    }
  }

  const liveMeta = getDraftMetadata(element);
  if (liveMeta && liveMeta.storageKey === meta.storageKey) {
    trackDraftEditor(element, meta);
    editorDraftOwnership.set(element, meta.storageKey);
  }
  const mutationGeneration = getDraftGeneration(meta.storageKey);
  const stored = await queueDraftStorageOperation(meta.storageKey, async () => {
    if (snapshot.blobImageSnapshot) {
      draft.html = await snapshot.blobImageSnapshot;
    }
    if (
      clearedDraftKeys.has(meta.storageKey) ||
      getDraftGeneration(meta.storageKey) !== mutationGeneration ||
      !hasDraftContent(draft)
    ) {
      return;
    }
    const saved = await setDraftValue(meta.storageKey, draft);
    if (saved && getDraftGeneration(meta.storageKey) === mutationGeneration) {
      draftCache.set(meta.storageKey, draft);
      return true;
    }
  });
  if (!stored) return;
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
    if (isIframeElement(queryRoot) && queryRoot.matches(EMAIL_FRAME_SELECTOR)) {
      attachEmailFrameObserver(queryRoot);
    }

    queryRoot.querySelectorAll(EMAIL_FRAME_SELECTOR).forEach((frame) => {
      attachEmailFrameObserver(frame);
    });
  }

  candidates.forEach((element) => {
    const meta = getDraftMetadata(element);
    if (meta) {
      trackDraftEditor(element, meta);
      if (isEmailEditorElement(element)) {
        initializeEmailDraftState(element, meta.recordId);
      }
    }
    ensureDraftObserver(element);
    restoreDraft(element).catch((error) => {
      console.error("Salesforce Draft Guard failed to restore a draft.", error);
    });
  });
}

async function restoreDraft(element) {
  // Each editor element gets at most one restore per tab-and-record-scoped draft key. This
  // prevents repeated injection while editing but still permits a DOM node reused by Lightning
  // on a different record to restore only that tab and record's own draft.
  const meta = getDraftMetadata(element);
  if (!meta) {
    if (isEmailEditorElement(element)) {
      debugLog("email restore skipped", {
        reason: "missing-metadata"
      });
    }
    return;
  }

  const emailState = isEmailEditorElement(element)
    ? initializeEmailDraftState(element, meta.recordId)
    : null;
  if (emailState && (!emailState.readyForRestore || emailState.editStarted)) {
    return;
  }

  // Lightning often reuses the same composer DOM node while navigating between records.
  // Restore at most once per element *and storage key*, not once for the element's lifetime.
  if (restoredDraftKeys.get(element) === meta.storageKey) {
    return;
  }

  // A clear is authoritative even while Chrome storage finishes removing the old value.
  // Without this tombstone, a freshly rerendered empty composer could read and restore that
  // soon-to-be-removed value in the small gap after the user cleared or submitted it.
  if (clearedDraftKeys.has(meta.storageKey)) {
    if (!hasUserValue(element)) {
      clearedEditorReadyKeys.set(element, meta.storageKey);
    }
    return;
  }

  let draft = draftCache.get(meta.storageKey);
  if (!draft) {
    const generation = getDraftGeneration(meta.storageKey);
    trackDraftEditor(element, meta);
    const result = await getDraftValue(meta.storageKey);
    const liveMeta = getDraftMetadata(element);
    if (
      liveMeta?.storageKey !== meta.storageKey ||
      liveMeta.recordId !== meta.recordId ||
      getDraftGeneration(meta.storageKey) !== generation ||
      clearedDraftKeys.has(meta.storageKey) ||
      restoredDraftKeys.get(element) === meta.storageKey
    ) {
      return;
    }

    draft = draftCache.get(meta.storageKey) || result[meta.storageKey];
    if (draft) {
      draftCache.set(meta.storageKey, draft);
    }
  }

  if (
    element.isConnected === false ||
    submittedEditors.has(element) ||
    saveTimers.get(element)?.meta.storageKey === meta.storageKey ||
    (emailState && (
      emailDraftStates.get(element) !== emailState || !emailState.readyForRestore || emailState.editStarted ||
      emailState.richInsert?.expiresAt > Date.now()
    ))
  ) {
    return;
  }

  if (!draft || !hasDraftContent(draft)) {
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

  if (!draft.recordId || draft.recordId !== meta.recordId) {
    // Schema 3 drafts always carry their unhashed Salesforce record owner. Any missing or
    // mismatched owner is legacy/unsafe data and must never be injected into a composer.
    restoredDraftKeys.set(element, meta.storageKey);
    clearDraftKeys([meta.storageKey]).catch((error) => {
      console.error("Salesforce Draft Guard failed to discard an unsafe draft.", error);
    });
    return;
  }

  if (
    emailState &&
    (!draft.emailContextKey || draft.emailContextKey !== getEmailBaselineContextKey(emailState))
  ) {
    // A Case can expose Reply/Reply All composers for different EmailMessage records. The
    // quoted-history fingerprint ensures a draft for one reply target never enters another,
    // even though both composers belong to the same Case.
    return;
  }

  const currentValue = readElementValue(element);
  const restoreComparisonValue = emailState
    ? deriveAuthoredEmailPrefix(currentValue, emailState.baselineValue)
    : currentValue;
  const currentHtml = readElementHtml(element) || "";
  const authoredHtml = emailState ? getEmailHtmlPrefix(currentHtml, emailState.baselineHtml).html : currentHtml;
  if (restoreComparisonValue === null || !shouldRestoreOverCurrentValue(restoreComparisonValue) ||
    hasInlineImage(authoredHtml) || hasHyperlink(authoredHtml)) {
    // The field already has content; never overwrite it. Mark handled so we don't keep
    // re-checking and never fight the user's edits.
    restoredDraftKeys.set(element, meta.storageKey);
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
  restoredDraftKeys.set(element, meta.storageKey);

  if (emailState) {
    emailState.editStarted = true;
    emailState.authoredValue = getDraftText(draft);
    emailState.authoredHtml = draft.html || "";
  }

  writeElementValueGuarded(element, draft);
  trackDraftEditor(element, meta);
  editorDraftOwnership.set(element, meta.storageKey);
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
  const keys = new Set(storageKeys);
  keys.forEach((key) => {
    draftCache.delete(key);
    toastedFieldKeys.delete(key);
    clearedDraftKeys.add(key);
    draftGenerations.set(key, getDraftGeneration(key) + 1);
  });
  for (const [element, { meta }] of saveTimers) {
    if (keys.has(meta.storageKey)) {
      cancelScheduledSave(element);
    }
  }
  for (const [element, meta] of trackedEditors) {
    if (!keys.has(meta.storageKey)) {
      continue;
    }
    clearedEditorReadyKeys.delete(element);
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
  if (normalizedAction === "send" && emailScope) {
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
  const signals = Array.isArray(detail.signals) ? detail.signals : [];
  const actionLabel = normalizeWhitespace(pendingAction.actionLabel || "").toLowerCase();
  const actionType = normalizeWhitespace(pendingAction.actionType || "").toLowerCase();

  if (actionLabel === "send") {
    return (
      signals.includes("email-send") ||
      url.includes("/emailmessages") ||
      url.includes("/email/simple") ||
      url.includes("emailquickaction.logsuccessfulsending")
    );
  }

  if (actionLabel === "post" || actionLabel === "share") {
    return (
      signals.includes("post-submit") ||
      url.includes("/chatter/feed-elements") ||
      url.includes("forcechatter-chatter.feeditemaction.create")
    );
  }

  if (actionLabel === "log a call" || actionLabel === "save") {
    const explicitActivityEndpoint = ["/tasks", "/events", "/notes"].some((fragment) => url.includes(fragment));
    const matchingAuraSave = signals.includes("activity-save") && ["log-a-call", "note"].includes(actionType);
    return explicitActivityEndpoint || matchingAuraSave;
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
  const recordId = getRecordIdForScope(container);
  if (!recordId) {
    debugWarn("draft skipped because its Salesforce record ownership is ambiguous", {
      actionType,
      label
    });
    return null;
  }

  let scope;
  let fieldKey;
  if (isEmailEditorElement(element)) {
    // The Salesforce/CKEditor Email body exposes per-load identifiers (instance ids, generated
    // titles/aria-labels) that change on every page load, which broke key matching between save
    // and restore. Derive a canonical key from stable signals only — the record context plus a
    // fixed field id — so the Email draft restores reliably.
    scope = getEmailDraftScope(container, recordId);
    fieldKey = hashKey("email-body");
  } else {
    scope = getContainerScope(container, recordId);
    fieldKey = getFieldKey(element, container);
  }

  return {
    scope,
    fieldKey,
    actionType,
    label,
    recordId,
    storageKey: `${STORAGE_PREFIX}${scope}:${fieldKey}`
  };
}

function getEmailDraftScope(container, knownRecordId = "") {
  // Resolve the record from the CKEditor iframe's owning record wrapper when possible. This
  // keeps Email aligned with its outer Send action even when several Salesforce console
  // workspace tabs remain mounted and the browser URL represents only the active one.
  const recordId = knownRecordId || getRecordIdForScope(container);
  return recordId ? hashKey(`${getDraftTabContextKey()}::${recordId}::email`) : "";
}

function getContainer(element) {
  const postContainer = element.closest(".publisherInputContainer, .forceChatterPublisher");
  if (postContainer) {
    return postContainer;
  }

  const structural = element.closest(
    "[role='dialog'], article, section, form, .oneRecordActionWrapper, .slds-modal, .ql-container, .cke_contents, .cke_inner"
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
  // Salesforce console workspace tabs can keep several records mounted simultaneously while
  // the URL represents only the active workspace tab. Prefer the composer's nearest explicit
  // record wrapper (or its iframe owner), then cautiously consider the active route.
  const recordContext = getRecordContextElement(container);
  const localRecordId = findClosestRecordId(recordContext);
  if (localRecordId) {
    return localRecordId;
  }

  // The active route is an acceptable fallback only for a currently rendered composer.
  // Hidden console workspaces remain mounted while another Case owns the URL; refusing the
  // fallback there is what prevents an inactive ticket's content from being assigned to the
  // active ticket. Never scan the full page for an arbitrary first record id.
  const routeRecordId = findRecordIdInPageUrl();
  return routeRecordId &&
    isScopeContextActive(recordContext) &&
    !hasConflictingMountedRecordContext(routeRecordId)
    ? routeRecordId
    : "";
}

function getContainerScope(container, knownRecordId = "") {
  const recordId = knownRecordId || getRecordIdForScope(container);
  if (!recordId) {
    return "";
  }
  const actionType = getContainerActionType(container);
  return hashKey(`${getDraftTabContextKey()}::${recordId}::${actionType}`);
}

function findClosestRecordId(root) {
  if (!isElementNode(root)) {
    return "";
  }

  const directId = readRecordIdAttribute(root);
  if (directId) {
    return directId;
  }

  if (typeof root.closest !== "function") {
    return "";
  }
  return readRecordIdAttribute(root.closest("[data-recordid], [data-record-id], [record-id]"));
}

function isScopeContextActive(recordContext) {
  return isElementNode(recordContext) && isElementRenderable(recordContext);
}

function hasConflictingMountedRecordContext(routeRecordId) {
  const pageDocument = getPageDocument();
  const root = pageDocument && pageDocument.body;
  if (!root || typeof root.querySelectorAll !== "function") {
    return false;
  }

  const recordNodes = root.querySelectorAll("[data-recordid], [data-record-id], [record-id]");
  for (const recordNode of recordNodes) {
    const candidate = readRecordIdAttribute(recordNode);
    if (
      candidate &&
      candidate !== routeRecordId &&
      candidate.slice(0, 3) === routeRecordId.slice(0, 3)
    ) {
      return true;
    }
  }
  return false;
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
  return resolveContainerActionType(container);
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

  // Text-based classification is a last resort, but it must never read the entire container:
  // that includes user-authored draft text and can change a draft's action type while typing.
  const semanticText = normalizeWhitespace(
    [
      container.getAttribute && container.getAttribute("aria-label"),
      findText(container, "h1, h2, h3, [role='heading'], .title, .slds-text-heading_small"),
      findText(container, "button, [role='button']")
    ].filter(Boolean).join(" ")
  ).toLowerCase();
  if (semanticText.includes("log a call")) {
    return "log-a-call";
  }
  if (semanticText.includes("email")) {
    return "email";
  }
  if (semanticText.includes("post") || semanticText.includes("share")) {
    return "post";
  }
  if (semanticText.includes("note")) {
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

  return findRecordIdInDom(root) || findRecordIdInPageUrl();
}

function getRecordContextElement(container) {
  if (!container) {
    return container;
  }

  try {
    const ownerDocument = container.ownerDocument;
    const ownerWindow = ownerDocument && ownerDocument.defaultView;
    if (ownerWindow && ownerWindow.frameElement) {
      return ownerWindow.frameElement;
    }
  } catch (error) {
    debugWarn("could not inspect editor frame ownership", error);
  }

  return container;
}

function findRecordIdInPageUrl() {
  let pathname = location.pathname;
  try {
    pathname = new URL(getPageLocationHref()).pathname;
  } catch (error) {
    debugWarn("failed to parse page location for record id", error);
  }

  const urlMatch = pathname.match(/\/lightning\/r\/[^/]+\/([a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?)(?:\/|$)/i);
  return urlMatch ? urlMatch[1] : "";
}

function findRecordIdInDom(root) {
  if (!(isElementNode(root) || isDocumentNode(root))) {
    return "";
  }

  if (isElementNode(root) && typeof root.closest === "function") {
    const ancestor = root.closest("[data-recordid], [data-record-id], [record-id]");
    const ancestorId = readRecordIdAttribute(ancestor);
    if (ancestorId) {
      return ancestorId;
    }
  }

  if (typeof root.querySelectorAll !== "function") {
    return "";
  }

  const recordNodes = root.querySelectorAll("[data-recordid], [data-record-id], [record-id]");
  for (const recordNode of recordNodes) {
    const candidate = readRecordIdAttribute(recordNode);
    if (candidate) {
      return candidate;
    }
  }

  return "";
}

function readRecordIdAttribute(recordNode) {
  if (!recordNode || typeof recordNode.getAttribute !== "function") {
    return "";
  }

  const candidate = normalizeWhitespace(
    recordNode.getAttribute("data-recordid") ||
      recordNode.getAttribute("data-record-id") ||
      recordNode.getAttribute("record-id") ||
      ""
  );
  return /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/.test(candidate) ? candidate : "";
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
  if (typeof element.innerHTML === "string" && isEditableElement(element)) {
    return element.innerHTML || undefined;
  }

  return undefined;
}

function readEditorWhiteSpace(element) {
  return element.ownerDocument?.defaultView?.getComputedStyle(element).whiteSpace;
}

function writeElementValueGuarded(element, draft) {
  // Mark the element as restoring before any DOM mutation so the save triggers fired by the
  // write, the synthetic input, and the editor's own follow-up mutations are all suppressed.
  restoringNow.add(element);

  const richEditor = isEditableElement(element) && !isTextInputElement(element);
  if (richEditor && !draft?.html) {
    restoreEditableDraft(element, draft);
    return;
  }

  try {
    // Native editor markup already represents the saved document. Re-pasting it through
    // clipboard matchers can reinterpret its spacing, list types, and code block structure.
    if (richEditor && isEmailEditorElement(element)) {
      writeEmailDraftBeforeExisting(element, draft);
    } else {
      writeElementValue(element, draft);
    }
    dispatchSyntheticInput(element);
    if (richEditor) {
      resetRestoredEditorViewport(element);
    }
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
  const isEmailEditor = isEmailEditorElement(element);
  const valueBeforeRestore = readElementValue(element);
  const previouslyFocusedElement = ownerDocument.activeElement || null;
  const shouldRestoreFocus = previouslyFocusedElement !== element;
  const previousSelectionRanges = shouldRestoreFocus
    ? captureDocumentSelectionRanges(ownerDocument)
    : [];
  let pasteHandled = false;

  try {
    pasteHandled = insertViaPaste(element, ownerDocument, draft);
    dispatchSyntheticInput(element);
  } finally {
    if (shouldRestoreFocus) {
      restoreFocusAfterDraftRestore(
        element,
        ownerDocument,
        previouslyFocusedElement,
        previousSelectionRanges
      );
    }
  }

  if (isEmailEditor) {
    debugLog("email restore: paste dispatched", { pasteHandled, hasHtml: Boolean(draft && draft.html) });
  }

  // Editors apply pasted content asynchronously, so verify shortly after. Fall back to a
  // direct DOM write only if the field is still empty — restore only targets empty fields,
  // so this can never duplicate content.
  window.setTimeout(() => {
    try {
      const current = readElementValue(element);
      const expectedText = normalizeEditableValue(getDraftText(draft));
      const emailRestoreApplied = isEmailEditor &&
        current !== valueBeforeRestore &&
        normalizeEditableValue(current).startsWith(expectedText);
      if (isEmailEditor ? !emailRestoreApplied : (!current || !current.trim())) {
        debugLog("restore: paste produced no content, using DOM write fallback", {
          pasteHandled,
          hasHtml: Boolean(draft && typeof draft === "object" && draft.html)
        });
        if (isEmailEditor) {
          writeEmailDraftBeforeExisting(element, draft);
        } else {
          writeElementValue(element, draft);
        }
        dispatchSyntheticInput(element);
      } else {
        debugLog("restore: paste applied", { length: current.length });
      }
    } catch (error) {
      debugWarn("restore verification failed", error);
    }
    // Synthetic paste leaves rich-text editors with their caret and local viewport at the
    // end of the restored draft. This affects both CKEditor Email bodies and Salesforce's
    // Chatter/Post editor. On a long record, leaving the Post editor overscrolled can produce
    // a large blank composer until a browser zoom/resize forces Chrome to recompute layout.
    resetRestoredEditorViewport(element);
    restoringNow.delete(element);
  }, RESTORE_GUARD_RELEASE_MS);
}

function resetRestoredEditorViewport(element) {
  const ownerDocument = element.ownerDocument || document;
  const pageDocument = getPageDocument();

  // Put the caret at the beginning before resetting the editor-local scroll offsets. Quill's
  // Post editor and CKEditor both otherwise keep the selection at the end of restored text,
  // which can leave their editable surface displaying an empty overscrolled region.
  try {
    const isAttached = element.isConnected !== false &&
      (typeof ownerDocument.contains !== "function" || ownerDocument.contains(element));
    const editorHasFocus = !("activeElement" in ownerDocument) || ownerDocument.activeElement === element;
    if (isAttached && editorHasFocus) {
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
    debugWarn("could not reset restored editor caret position", error);
  }

  element.scrollTop = 0;
  element.scrollLeft = 0;
  // An Email body has an isolated CKEditor iframe viewport, which is safe to reset. Never
  // write to the top Salesforce document: doing that interferes with Lightning's virtualized
  // long-record scroller and can leave the page beyond rendered content.
  if (ownerDocument !== pageDocument) {
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
}

function captureDocumentSelectionRanges(ownerDocument) {
  try {
    const selection = typeof ownerDocument.getSelection === "function"
      ? ownerDocument.getSelection()
      : null;
    if (!selection || typeof selection.getRangeAt !== "function") {
      return [];
    }

    const ranges = [];
    for (let index = 0; index < selection.rangeCount; index += 1) {
      const range = selection.getRangeAt(index);
      ranges.push(range && typeof range.cloneRange === "function" ? range.cloneRange() : range);
    }
    return ranges.filter(Boolean);
  } catch (error) {
    debugWarn("could not capture selection before draft recovery", error);
    return [];
  }
}

function restoreFocusAfterDraftRestore(
  element,
  ownerDocument,
  previouslyFocusedElement,
  previousSelectionRanges = []
) {
  const body = ownerDocument.body;
  const documentElement = ownerDocument.documentElement;
  const canRestorePreviousFocus =
    previouslyFocusedElement &&
    previouslyFocusedElement !== body &&
    previouslyFocusedElement !== documentElement &&
    previouslyFocusedElement.isConnected !== false &&
    typeof previouslyFocusedElement.focus === "function";

  let previousFocusRestored = false;
  if (canRestorePreviousFocus) {
    try {
      previouslyFocusedElement.focus({ preventScroll: true });
      previousFocusRestored = true;
    } catch (error) {
      debugWarn("could not restore focus after draft recovery", error);
    }
  }
  if (!previousFocusRestored && typeof element.blur === "function") {
    // A background restore commonly begins with BODY focused. Blur the editor after its
    // synthetic paste/input events so later keyboard input cannot drag the page back to the
    // recovered composer or make Lightning retain focus-expanded workspace geometry.
    element.blur();
  }

  try {
    const selection = typeof ownerDocument.getSelection === "function"
      ? ownerDocument.getSelection()
      : null;
    if (selection && typeof selection.removeAllRanges === "function") {
      selection.removeAllRanges();
      if (typeof selection.addRange === "function") {
        previousSelectionRanges.forEach((range) => selection.addRange(range));
      }
    }
  } catch (error) {
    debugWarn("could not restore selection after draft recovery", error);
  }
}

function insertViaPaste(element, ownerDocument, draft) {
  const view = ownerDocument.defaultView || window;
  const text = getDraftText(draft);

  if (typeof element.focus !== "function" || typeof element.dispatchEvent !== "function") {
    return false;
  }
  if (typeof view.DataTransfer !== "function" || typeof view.ClipboardEvent !== "function") {
    return false;
  }

  try {
    try {
      element.focus({ preventScroll: true });
    } catch (error) {
      element.focus();
    }
    if (typeof ownerDocument.getSelection === "function" && typeof ownerDocument.createRange === "function") {
      const selection = ownerDocument.getSelection();
      if (selection && typeof selection.removeAllRanges === "function") {
        const range = ownerDocument.createRange();
        range.selectNodeContents(element);
        if (isEmailEditorElement(element) && readElementValue(element).trim()) {
          range.collapse(true);
        }
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }

    const dataTransfer = new view.DataTransfer();
    if (text) {
      dataTransfer.setData("text/plain", text);
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

function writeEmailDraftBeforeExisting(element, draft) {
  const ownerDocument = element.ownerDocument || document;
  if (draft?.html) {
    const fragment = SfdgDraftHtml.createFragment(draft.html, ownerDocument, { baseUrl: draft.baseUrl });
    if (fragment.hasChildNodes()) {
      if (draft.replacesEmailPlaceholder && getEmailPlaceholderLength(element.innerHTML)) {
        while (element.firstChild?.nodeType === 3 && !element.firstChild.textContent.trim()) {
          element.firstChild.remove();
        }
        element.firstChild?.remove();
      }
      element.prepend(fragment);
      return;
    }
  }

  const existingHtml = typeof element.innerHTML === "string" ? element.innerHTML : "";
  const authoredHtml = escapeDraftTextForHtml(getDraftText(draft));
  const separator = existingHtml && authoredHtml && !/<br\s*\/?>\s*$/i.test(authoredHtml)
    ? "<br>"
    : "";
  element.innerHTML = `${authoredHtml}${separator}${existingHtml}`;
}

function escapeDraftTextForHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replace(/\r\n?|\n/g, "<br>");
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
  if (draft?.html) {
    const fragment = SfdgDraftHtml.createFragment(draft.html, ownerDocument, { baseUrl: draft.baseUrl });
    if (fragment.hasChildNodes()) {
      element.replaceChildren(fragment);
      return;
    }
  }

  rebuildContentEditable(element, ownerDocument, getDraftText(draft).replace(/\r\n?/g, "\n"));
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
  if (readElementValue(element).trim()) return true;
  const html = readElementHtml(element);
  return hasInlineImage(html) || hasHyperlink(html);
}

function hasDraftContent(draft) {
  return Boolean(draft.value?.trim() || hasInlineImage(draft.html) || hasHyperlink(draft.html));
}

function hasInlineImage(html) {
  return /<img\b[^>]*\ssrc="[^"]+"/i.test(html || "");
}

function hasHyperlink(html) {
  return /<a\b[^>]*\shref="[^"]+"/i.test(html || "");
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

    // A rich-text editor can mutate its DOM as Salesforce rerenders, switches publisher
    // tabs, or submits another composer. Do not let those untrusted lifecycle mutations
    // delete an otherwise recoverable draft when the editor is temporarily empty.
    const richInsert = mutations.some((mutation) => mutation.type === "attributes"
      ? mutation.target.matches("img, a")
      : Array.from(mutation.addedNodes).some((node) =>
        node.matches?.("img, a") || node.querySelector?.("img, a")
      ));
    if (richInsert || mutations.some((mutation) => mutation.type !== "attributes")) {
      scheduleSave(element, richInsert ? "rich-insert-mutation" : "mutation", false);
    }
  });

  observer.observe(element, {
    childList: true,
    subtree: true,
    characterData: true,
    attributeFilter: ["src", "href", "width", "height", "alt", "title", "style"]
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
    frameDocument.addEventListener("change", handleInputEvent, true);
    frameDocument.addEventListener("keyup", handleInputEvent, true);
    frameDocument.addEventListener("paste", handleInputEvent, true);
    frameDocument.addEventListener("drop", handleInputEvent, true);
    frameDocument.addEventListener("blur", handleInputEvent, true);
    frameDocument.addEventListener("focusin", handleFocusEvent, true);
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

function getSubmitActionLabel(button) {
  if (!button) {
    return "";
  }

  const candidates = [
    button.textContent,
    button.getAttribute && button.getAttribute("aria-label"),
    button.getAttribute && button.getAttribute("title"),
    button.getAttribute && button.getAttribute("value")
  ];
  const configuredActions = settings.protectedActions
    .map((action) => normalizeWhitespace(action).toLowerCase())
    .sort((a, b) => b.length - a.length);

  for (const candidate of candidates) {
    const normalized = normalizeWhitespace(candidate || "").toLowerCase();
    if (!normalized) {
      continue;
    }
    const match = configuredActions.find(
      (action) => normalized === action || normalized.startsWith(`${action} `) || normalized.endsWith(` ${action}`)
    );
    if (match) {
      return match;
    }
  }

  return "";
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

  let sessionResult;
  if (sessionStorageArea) {
    try {
      sessionResult = await sessionStorageArea.get(key);
    } catch (error) {
      if (markStorageUnavailable(error, "session read")) {
        return {};
      }
      console.warn("Salesforce Draft Guard session storage read failed, falling back to local storage.", error);
    }
  }

  try {
    const localResult = await localStorageArea.get(key);
    // Large inline drafts can fall back to local storage after an earlier save in session.
    if (sessionResult?.[key] && (!localResult?.[key] ||
      (sessionResult[key].updatedAt || 0) > (localResult[key].updatedAt || 0))) {
      return sessionResult;
    }
    return localResult;
  } catch (error) {
    if (markStorageUnavailable(error, "local read")) {
      return {};
    }
    if (sessionResult?.[key]) return sessionResult;
    throw error;
  }
}

async function setDraftValue(key, value) {
  if (storageUnavailableDueToContext) {
    return false;
  }

  if (sessionStorageArea) {
    try {
      await sessionStorageArea.set({ [key]: value });
      debugLog("setDraftValue wrote to session", { key });
      return true;
    } catch (error) {
      if (markStorageUnavailable(error, "session write")) {
        return false;
      }
      debugWarn("session storage write failed, falling back to local", error);
    }
  }

  try {
    await localStorageArea.set({ [key]: value });
    debugLog("setDraftValue wrote to local", { key });
    return true;
  } catch (error) {
    if (markStorageUnavailable(error, "local write")) {
      return false;
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
    confirmBeforeRefresh: stored.confirmBeforeRefresh !== false,
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

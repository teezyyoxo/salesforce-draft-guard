(function exposeDraftStorage(global) {
  const STORAGE_PREFIX = "sfdg:draft:";
  const CLEAR_SIGNAL_KEY = "sfdg:draft-clear-signal";

  function getStorageAreas() {
    return [chrome.storage.session, chrome.storage.local].filter(Boolean);
  }

  async function readDraftStores() {
    return Promise.all(getStorageAreas().map((area) => area.get(null)));
  }

  async function listDrafts() {
    const stores = await readDraftStores();
    const merged = new Map();

    for (const store of stores) {
      for (const [key, storedDraft] of Object.entries(store || {})) {
        if (!key.startsWith(STORAGE_PREFIX)) {
          continue;
        }

        const draft = storedDraft && typeof storedDraft === "object"
          ? storedDraft
          : { value: String(storedDraft || "") };
        const current = merged.get(key);
        if (!current || (draft.updatedAt || 0) >= (current.updatedAt || 0)) {
          merged.set(key, { key, ...draft });
        }
      }
    }

    return Array.from(merged.values()).sort(
      (left, right) => (right.updatedAt || 0) - (left.updatedAt || 0)
    );
  }

  async function clearAllDrafts() {
    const stores = await readDraftStores();
    const keys = Array.from(new Set(
      stores.flatMap((store) => Object.keys(store || {}).filter((key) => key.startsWith(STORAGE_PREFIX)))
    ));

    // Notify every live Salesforce frame before deleting storage. This cancels debounced and
    // in-flight saves that have not reached storage yet, so they cannot recreate the cache.
    await signalDraftClear({ all: true });
    await removeDraftKeys(keys);
    return keys.length;
  }

  async function clearDraftKeys(keys) {
    const draftKeys = Array.from(new Set(keys)).filter((key) => key.startsWith(STORAGE_PREFIX));
    if (!draftKeys.length) {
      return 0;
    }

    await signalDraftClear({ keys: draftKeys });
    await removeDraftKeys(draftKeys);
    return draftKeys.length;
  }

  async function signalDraftClear(command) {
    if (!chrome.storage.local) {
      return;
    }

    await chrome.storage.local.set({
      [CLEAR_SIGNAL_KEY]: {
        ...command,
        nonce: `${Date.now()}-${Math.random()}`
      }
    });
  }

  async function removeDraftKeys(keys) {
    if (!keys.length) {
      return;
    }
    await Promise.all(getStorageAreas().map((area) => area.remove(keys)));
  }

  global.SfdgDraftStorage = {
    clearAllDrafts,
    clearDraftKeys,
    listDrafts
  };
})(globalThis);

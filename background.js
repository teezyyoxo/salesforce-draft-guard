const STORAGE_PREFIX = "sfdg:draft:";
const DRAFT_SCHEMA_STORAGE_KEY = "sfdg:draft-schema";
const CURRENT_DRAFT_SCHEMA = 2;

chrome.runtime.onInstalled.addListener(handleInstalled);
chrome.runtime.onStartup.addListener(handleStartup);
chrome.runtime.onMessage.addListener(handleRuntimeMessage);

function handleRuntimeMessage(message, sender, sendResponse) {
  if (!message || message.type !== "sfdg:get-tab-context") {
    return false;
  }

  const tabId = sender && sender.tab && sender.tab.id;
  sendResponse({ tabContext: Number.isInteger(tabId) ? `tab-${tabId}` : "" });
  return false;
}

async function handleInstalled() {
  await enableSessionAccess();
  await ensureCurrentDraftSchema();
}

async function handleStartup() {
  await enableSessionAccess();
  await ensureCurrentDraftSchema();
}

async function ensureCurrentDraftSchema() {
  try {
    const stored = await chrome.storage.local.get(DRAFT_SCHEMA_STORAGE_KEY);
    if (stored && stored[DRAFT_SCHEMA_STORAGE_KEY] === CURRENT_DRAFT_SCHEMA) {
      return;
    }
    const migrated = await clearLegacyDrafts();
    if (migrated) {
      await chrome.storage.local.set({ [DRAFT_SCHEMA_STORAGE_KEY]: CURRENT_DRAFT_SCHEMA });
    }
  } catch (error) {
    console.error("Salesforce Draft Guard failed to migrate draft storage.", error);
  }
}

async function clearLegacyDrafts() {
  const areas = [chrome.storage.session, chrome.storage.local].filter(Boolean);
  const results = await Promise.all(areas.map(async (area) => {
    try {
      const stored = await area.get(null);
      const draftKeys = Object.keys(stored || {}).filter((key) => key.startsWith(STORAGE_PREFIX));
      if (draftKeys.length) {
        await area.remove(draftKeys);
      }
      return true;
    } catch (error) {
      console.error("Salesforce Draft Guard failed to clear unsafe legacy drafts.", error);
      return false;
    }
  }));
  return results.every(Boolean);
}

async function enableSessionAccess() {
  if (!chrome.storage.session || !chrome.storage.session.setAccessLevel) {
    return;
  }

  try {
    await chrome.storage.session.setAccessLevel({
      accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS"
    });
  } catch (error) {
    console.error("Salesforce Draft Guard failed to enable session storage access.", error);
  }
}

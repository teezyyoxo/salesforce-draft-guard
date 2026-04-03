const STORAGE_PREFIX = "sfdg:draft:";
const sessionStorageArea = chrome.storage.session;
const localStorageArea = chrome.storage.local;

const draftsNode = document.getElementById("drafts");
const summaryNode = document.getElementById("summary");
const refreshButton = document.getElementById("refresh");
const clearAllButton = document.getElementById("clearAll");
const openOptionsButton = document.getElementById("openOptions");

refreshButton.addEventListener("click", renderDrafts);
clearAllButton.addEventListener("click", clearAllDrafts);
openOptionsButton.addEventListener("click", () => chrome.runtime.openOptionsPage());
draftsNode.addEventListener("click", handleDraftAction);

renderDrafts();

async function renderDrafts() {
  const drafts = await loadDrafts();
  summaryNode.textContent = drafts.length
    ? `${drafts.length} saved draft${drafts.length === 1 ? "" : "s"} in extension storage.`
    : "No saved drafts right now.";

  if (!drafts.length) {
    draftsNode.innerHTML = '<div class="empty-state">Your draft store is empty. Once you start typing in a protected Salesforce composer, it will appear here.</div>';
    clearAllButton.disabled = true;
    return;
  }

  clearAllButton.disabled = false;
  draftsNode.innerHTML = drafts
    .map(
      (draft) => `
        <article class="draft-card">
          <div class="draft-meta">
            <span>${escapeHtml(draft.actionType || "activity")}</span>
            <span>${formatTimestamp(draft.updatedAt)}</span>
          </div>
          <h2 class="draft-title">${escapeHtml(draft.label || draft.title || "Untitled Draft")}</h2>
          <p class="draft-preview">${escapeHtml(truncate(draft.value, 220))}</p>
          <div class="draft-actions">
            <span class="summary">${escapeHtml(draft.title || draft.url || "")}</span>
            <button class="clear-button" type="button" data-key="${escapeHtml(draft.key)}">Clear</button>
          </div>
        </article>
      `
    )
    .join("");
}

async function loadDrafts() {
  const stores = await Promise.all([
    readStorageArea(sessionStorageArea),
    readStorageArea(localStorageArea)
  ]);

  const merged = new Map();
  for (const store of stores) {
    for (const [key, draft] of Object.entries(store)) {
      if (!key.startsWith(STORAGE_PREFIX)) {
        continue;
      }

      const current = merged.get(key);
      if (!current || (draft.updatedAt || 0) >= (current.updatedAt || 0)) {
        merged.set(key, { key, ...draft });
      }
    }
  }

  return Array.from(merged.values()).sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0));
}

async function clearAllDrafts() {
  const drafts = await loadDrafts();
  if (!drafts.length) {
    return;
  }

  await removeKeys(drafts.map((draft) => draft.key));
  await renderDrafts();
}

async function handleDraftAction(event) {
  const button = event.target instanceof Element ? event.target.closest("button[data-key]") : null;
  if (!button) {
    return;
  }

  await removeKeys([button.dataset.key]);
  await renderDrafts();
}

async function readStorageArea(area) {
  if (!area) {
    return {};
  }

  try {
    return await area.get(null);
  } catch (error) {
    console.warn("Salesforce Draft Guard popup failed to read a storage area.", error);
    return {};
  }
}

async function removeKeys(keys) {
  const tasks = [];
  if (sessionStorageArea) {
    tasks.push(sessionStorageArea.remove(keys).catch(() => {}));
  }
  if (localStorageArea) {
    tasks.push(localStorageArea.remove(keys).catch(() => {}));
  }
  await Promise.all(tasks);
}

function formatTimestamp(value) {
  if (!value) {
    return "Unknown";
  }

  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function truncate(value, maxLength) {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

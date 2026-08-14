const draftsNode = document.getElementById("drafts");
const summaryNode = document.getElementById("summary");
const statusNode = document.getElementById("status");
const refreshButton = document.getElementById("refresh");
const clearAllButton = document.getElementById("clearAll");
const openOptionsButton = document.getElementById("openOptions");

refreshButton.addEventListener("click", renderDrafts);
clearAllButton.addEventListener("click", clearAllDraftsFromPopup);
openOptionsButton.addEventListener("click", () => chrome.runtime.openOptionsPage());
draftsNode.addEventListener("click", handleDraftAction);

renderDrafts();

async function renderDrafts() {
  const drafts = await SfdgDraftStorage.listDrafts();
  summaryNode.textContent = drafts.length
    ? `${drafts.length} saved draft${drafts.length === 1 ? "" : "s"} in extension storage.`
    : "No saved drafts right now.";

  if (!drafts.length) {
    draftsNode.innerHTML = '<div class="empty-state">Your draft store is empty. Once you start typing in a protected Salesforce composer, it will appear here.</div>';
    return;
  }

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

async function clearAllDraftsFromPopup() {
  clearAllButton.disabled = true;
  try {
    const clearedCount = await SfdgDraftStorage.clearAllDrafts();
    await renderDrafts();
    statusNode.textContent = clearedCount
      ? `Cleared ${clearedCount} saved draft${clearedCount === 1 ? "" : "s"} and the live draft cache.`
      : "The live draft cache is clear.";
  } catch (error) {
    console.error("Salesforce Draft Guard failed to clear all drafts.", error);
    statusNode.textContent = "Drafts could not be cleared. Please try again.";
  } finally {
    clearAllButton.disabled = false;
  }
}

async function handleDraftAction(event) {
  const button = event.target instanceof Element ? event.target.closest("button[data-key]") : null;
  if (!button) {
    return;
  }

  try {
    await SfdgDraftStorage.clearDraftKeys([button.dataset.key]);
    await renderDrafts();
    statusNode.textContent = "Draft cleared.";
  } catch (error) {
    console.error("Salesforce Draft Guard failed to clear a draft.", error);
    statusNode.textContent = "That draft could not be cleared. Please try again.";
  }
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
  value = String(value || "");
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

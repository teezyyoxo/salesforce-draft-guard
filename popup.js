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
          <div class="draft-preview"></div>
          <div class="draft-actions">
            <span class="summary">${escapeHtml(draft.title || draft.url || "")}</span>
            <button class="clear-button" type="button" data-key="${escapeHtml(draft.key)}">Clear</button>
          </div>
        </article>
      `
    )
    .join("");

  draftsNode.querySelectorAll(".draft-preview").forEach((preview, index) => {
    renderDraftPreview(preview, drafts[index]);
  });
}

function renderDraftPreview(preview, draft) {
  if (draft.html) {
    const fragment = SfdgDraftHtml.createFragment(draft.html, document, {
      preview: true,
      baseUrl: draft.baseUrl || draft.url
    });
    if (fragment.hasChildNodes()) {
      formatQuillLists(fragment);
      preview.classList.add("draft-preview-rich");
      if (["pre", "pre-wrap", "pre-line", "break-spaces"].includes(draft.whiteSpace)) {
        preview.style.whiteSpace = draft.whiteSpace;
      }
      preview.append(fragment);
      return;
    }
  }

  preview.textContent = String(draft.value ?? "");
}

function formatQuillLists(fragment) {
  // Quill 2 stores mixed lists in one <ol> and uses each item's data-list and indent
  // to choose its marker. Native list markers need an explicit value at each level.
  for (const list of fragment.querySelectorAll(":is(ol, ul):has(> li:is([data-list], [class*='ql-indent-']))")) {
    const numbers = [(list.start ?? 1) - 1];
    for (const item of list.children) {
      const indent = Number(item.className.match(/(?:^|\s)ql-indent-([1-9])(?:\s|$)/)?.[1] || 0);
      numbers.length = indent + 1;
      if (indent) {
        item.style.marginInlineStart = `${indent * 1.5}em`;
      }
      const listType = item.dataset.list || (list.localName === "ol" ? "ordered" : "bullet");
      if (listType === "ordered") {
        numbers[indent] = (numbers[indent] ?? 0) + 1;
        item.value = numbers[indent];
        item.style.listStyleType = ["decimal", "lower-alpha", "lower-roman"][indent % 3];
      }
    }
  }
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

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

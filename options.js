const DEFAULT_SETTINGS = {
  protectedActions: ["send", "share", "save", "post", "log a call"],
  fieldKeywords: ["email", "post", "call", "comment", "note", "description", "body", "subject", "message"],
  showToasts: true
};

const ACTION_OPTIONS = [
  { value: "send", label: "Send" },
  { value: "share", label: "Share" },
  { value: "save", label: "Save" },
  { value: "post", label: "Post" },
  { value: "log a call", label: "Log a Call" }
];

const settingsArea = chrome.storage.sync || chrome.storage.local;

const actionsNode = document.getElementById("actions");
const keywordsNode = document.getElementById("keywords");
const showToastsNode = document.getElementById("showToasts");
const statusNode = document.getElementById("status");
const saveButton = document.getElementById("save");
const resetButton = document.getElementById("reset");

renderActionOptions();
loadSettings();

saveButton.addEventListener("click", saveSettings);
resetButton.addEventListener("click", resetDefaults);

function renderActionOptions() {
  actionsNode.innerHTML = ACTION_OPTIONS.map(
    (option) => `
      <label class="check-card">
        <input type="checkbox" value="${option.value}" />
        <span>${option.label}</span>
      </label>
    `
  ).join("");
}

async function loadSettings() {
  const stored = await settingsArea.get(Object.keys(DEFAULT_SETTINGS));
  const settings = normalizeSettings(stored);

  for (const checkbox of actionsNode.querySelectorAll("input[type='checkbox']")) {
    checkbox.checked = settings.protectedActions.includes(checkbox.value);
  }

  keywordsNode.value = settings.fieldKeywords.join("\n");
  showToastsNode.checked = settings.showToasts;
}

async function saveSettings() {
  const settings = collectSettings();
  await settingsArea.set(settings);
  flashStatus("Settings saved.");
}

async function resetDefaults() {
  await settingsArea.set(DEFAULT_SETTINGS);
  await loadSettings();
  flashStatus("Defaults restored.");
}

function collectSettings() {
  return {
    protectedActions: Array.from(actionsNode.querySelectorAll("input[type='checkbox']:checked")).map((node) => node.value),
    fieldKeywords: keywordsNode.value
      .split(/\n|,/)
      .map((value) => normalizeWhitespace(value.toLowerCase()))
      .filter(Boolean),
    showToasts: showToastsNode.checked
  };
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

function flashStatus(message) {
  statusNode.textContent = message;
  window.clearTimeout(flashStatus.timerId);
  flashStatus.timerId = window.setTimeout(() => {
    statusNode.textContent = "";
  }, 2200);
}

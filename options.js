const DEFAULT_SETTINGS = {
  protectedActions: ["send", "share", "save", "post", "log a call"],
  fieldKeywords: ["email", "post", "call", "comment", "note", "description", "body", "subject", "message"],
  showToasts: true,
  toastPosition: "lower-right",
  toastSize: "medium",
  toastTextColor: "#f9fafb",
  toastBackgroundColor: "#111827",
  toastSound: "none"
};
const TOAST_POSITIONS = ["upper-right", "upper-left", "lower-left", "lower-right", "lower-middle", "absolute-middle", "upper-middle"];
const TOAST_SIZES = ["small", "medium", "large", "extra-large"];
const TOAST_SOUNDS = ["none", "soft-chime", "click", "success-tone"];

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
const toastPositionNode = document.getElementById("toastPosition");
const toastSizeNode = document.getElementById("toastSize");
const toastSoundNode = document.getElementById("toastSound");
const toastTextColorNode = document.getElementById("toastTextColor");
const toastBackgroundColorNode = document.getElementById("toastBackgroundColor");
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
  toastPositionNode.value = settings.toastPosition;
  toastSizeNode.value = settings.toastSize;
  toastSoundNode.value = settings.toastSound;
  toastTextColorNode.value = settings.toastTextColor;
  toastBackgroundColorNode.value = settings.toastBackgroundColor;
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
    showToasts: showToastsNode.checked,
    toastPosition: toastPositionNode.value,
    toastSize: toastSizeNode.value,
    toastTextColor: toastTextColorNode.value,
    toastBackgroundColor: toastBackgroundColorNode.value,
    toastSound: toastSoundNode.value
  };
}

function normalizeSettings(stored) {
  return {
    protectedActions: normalizeList(stored.protectedActions, DEFAULT_SETTINGS.protectedActions),
    fieldKeywords: normalizeList(stored.fieldKeywords, DEFAULT_SETTINGS.fieldKeywords),
    showToasts: stored.showToasts !== false,
    toastPosition: normalizeChoice(stored.toastPosition, TOAST_POSITIONS, DEFAULT_SETTINGS.toastPosition),
    toastSize: normalizeChoice(stored.toastSize, TOAST_SIZES, DEFAULT_SETTINGS.toastSize),
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

function flashStatus(message) {
  statusNode.textContent = message;
  window.clearTimeout(flashStatus.timerId);
  flashStatus.timerId = window.setTimeout(() => {
    statusNode.textContent = "";
  }, 2200);
}

# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog and this project uses Semantic Versioning.

## [0.2.0] - 2026-04-01

### Added
- Added an extension options page for configuring protected Salesforce actions, protected field keywords, and toast visibility.
- Added an action popup for reviewing saved drafts in the current browser session and clearing individual or all drafts manually.

### Changed
- Updated `content.js` to load settings from extension storage and apply them to draft detection and submit-action clearing.
- Updated `manifest.json` to register the popup and options page.
- Updated `README.md` to document the new configuration and draft inspection features.

## [0.1.1] - 2026-04-01

### Changed
- Hardened draft identity generation in `content.js` so saved drafts are keyed from more stable Salesforce-facing signals such as record id, action type, field semantics, and field position instead of volatile DOM classes and parent paths.
- Updated submit handling so the extension clears only the draft keys captured from the composer the user actually submitted, rather than clearing every pending draft on any successful matching network request.
- Switched draft persistence to `chrome.storage.session` with fallback to `chrome.storage.local` so draft retention better matches short-lived cache/session behavior.
- Updated `README.md` to reflect the current repository path and the revised storage and clear-on-success behavior.

### Verified
- Confirmed `content.js` passes `node --check` after the hardening changes.
- Re-validated `manifest.json` structure during review.

## [0.1.0] - 2026-04-01

### Added
- Created the initial Manifest V3 Chrome extension scaffold for Salesforce draft protection.
- Added `content.js` to watch Salesforce text-entry surfaces, persist drafts locally while editing, restore drafts after rerenders and refreshes, and observe dynamic DOM changes.
- Added `injected.js` to hook `fetch` and `XMLHttpRequest` so successful Salesforce save-like requests can trigger draft cleanup.
- Added `content.css` for lightweight in-page status toasts.
- Added `README.md` with extension loading instructions, Git setup guidance, and next hardening steps.
- Added `.gitignore` for local macOS metadata cleanup.

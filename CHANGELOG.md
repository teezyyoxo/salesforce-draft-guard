# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog and this project uses Semantic Versioning.

## [0.2.3] - 2026-04-29

### Added
- Added dependency-free `node:test` coverage for Email iframe discovery, top-page draft scoping, contenteditable line-break normalization, and Email submit cleanup key collection.

### Fixed
- Fixed Email iframe restore tracking when Salesforce adds the CKEditor iframe itself as the mutation root.
- Made draft metadata prefer the top Salesforce page context when available so parent-page and iframe-script tracking derive matching draft keys.
- Included tracked Email iframe editor keys when clearing drafts after a successful Send action.
- Normalized contenteditable draft reads and writes to reduce extra line breaks after Post composer restore.

### Verified
- Confirmed `content.js` passes `node --check`.
- Confirmed `test/content.test.js` passes with `node --test`.

## [0.2.2] - 2026-04-03

### Changed
- Hardened `content.js` storage access paths to detect and suppress repeated `Extension context invalidated` failures across session/local reads, writes, clears, and settings loads.
- Expanded Salesforce Email iframe binding in `content.js` to treat CKEditor Email Body frames as valid draft editors more consistently and attach restore/listener flow with additional email diagnostics.
- Added explicit email restore outcome logging in `content.js` so Email restore attempts now report `email draft restored` or `email restore skipped` with reason codes.

### Verified
- Confirmed `content.js` passes `node --check` after the 0.2.2 updates.

## [0.2.1] - 2026-04-03

### Added
- Added `background.js` to enable `chrome.storage.session` access for content scripts when Chrome supports session access levels.

### Changed
- Expanded `content.js` draft-surface detection with Salesforce-specific selectors for `publisherInputContainer`, CKEditor editable regions, and `Email Body` textboxes.
- Updated draft read, write, and clear behavior to fall back to `chrome.storage.local` when `chrome.storage.session` is unavailable or rejects from the content script context.
- Updated `popup.js` to read and clear drafts across both session and local extension storage so the popup remains accurate during storage fallback.
- Updated `manifest.json` to register the background service worker used for session-storage access setup.

### Verified
- Confirmed `content.js`, `popup.js`, and `background.js` pass `node --check`.
- Re-validated `manifest.json` structure after the background-worker update.

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

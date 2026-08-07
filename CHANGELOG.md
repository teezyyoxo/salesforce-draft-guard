# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog and this project uses Semantic Versioning.

## [0.5.5] - 2026-08-07

### Fixed
- Fixed draft restoration in Email and Post composers from causing the browser to auto-scroll
  the page toward the bottom of the editor. Restores now focus the target editor with
  `preventScroll` and reset the iframe/document viewport to keep the page position stable.

### Changed
- Bumped the extension version to 0.5.5.

## [0.5.4] - 2026-07-29

### Fixed
- Fixed successful Chatter Share and Email Send actions not clearing their local drafts in
  Salesforce Lightning orgs that submit through Aura rather than REST endpoints. Draft cleanup
  now recognizes the submission-specific `FeedItemAction.create` and
  `EmailQuickAction.logSuccessfulSending` Aura callbacks.
- Kept generic Aura quick-action saves excluded so unrelated Salesforce record saves cannot
  clear an unsent draft.

## [0.5.3] - 2026-07-28

### Fixed
- Fixed sent Post and Email text being restored as a new draft. The page-exit draft flush now
  skips submitted composers and drafts already cleared after a matching successful Salesforce
  submission, including Email bodies managed inside CKEditor frames. Unsent rich-text drafts
  continue to retain their formatting and inline attachments.

### Changed
- Bumped the extension version to 0.5.3.

## [0.5.2] - 2026-07-27

### Fixed
- Fixed submitting a Post being able to discard a simultaneous, unsent Email draft. Salesforce
  can empty or replace inactive composers as part of the Post transition; those lifecycle
  mutations are no longer interpreted as the user deliberately clearing an Email draft.
- Empty-draft cleanup now requires a trusted user `input` event. Successful Post and Email
  submissions continue to clear only the draft belonging to that submitted composer.
- Flush pending editor saves when a Salesforce tab is hidden or unloaded, so a reload or tab
  close does not lose text that is still within the normal typing debounce window.

### Changed
- Bumped the extension version to 0.5.2.

## [0.5.1] - 2026-07-23

### Fixed
- Fixed an unrelated record Details save being able to clear an unsent Email or Post draft.
  Cleanup now includes only drafts belonging to the submitted composer, and requires the
  corresponding Email, Chatter Post, or activity-save response before removing a draft.
- Removed the broad `/connect/records` network match. Salesforce uses that endpoint for
  record-detail work as well as other UI traffic, so it is not evidence that a draft was sent.

### Changed
- Bumped the extension version to 0.5.1.

## [0.5.0] - 2026-07-23

### Fixed
- Fixed Post and Email drafts reappearing after a successful Post or Send. Delayed editor
  saves are cancelled when Salesforce confirms the submission, and late transition events from
  the submitted composer are ignored until it has been cleared for the next message.
- Fixed deleted Post and Email text being restored while the user was still editing. Empty
  editors now remove their stored draft immediately instead of waiting for the autosave delay.
- Serialized draft save and removal operations per draft key, preventing a late save from
  overwriting a newer clear operation.

### Changed
- Bumped the extension version to 0.5.0.

## [0.4.1] - 2026-07-19

Immediate hotfix for drafts being restored into unrelated Salesforce record fields, including
Email drafts leaking into recipient fields.

### Fixed
- Fixed generic draft detection reading the entire surrounding form/container. A nearby field
  such as `Description` could make unrelated fields like `Fixed in Release`, `Repeated Issue
  Case`, or `License Requester` eligible for the same draft scan and restore flow.
- Generic keyword matching now uses only the candidate field's own label and attributes, while
  known Email, Post, and activity composer surfaces remain protected by their structural
  selectors.
- Fixed Email drafts being restored into the `To`, `Cc`, or `Bcc` fields. The canonical
  `email-body` draft key is now reserved for the editable Email Body element; ordinary fields
  in the Email composer are not treated as that draft.
- Fixed the Email caret reset race that could call `Selection.addRange()` after Salesforce had
  detached/replaced the editor, producing `addRange(): The given range isn't in document.`

### Added
- Added regression coverage ensuring unrelated Case fields are not treated as draft surfaces
  merely because a neighboring field contains a configured keyword.
- Added regression coverage for Email recipient-field isolation and detached-editor viewport
  reset handling.

### Changed
- Bumped the extension version to 0.4.1.

### Verified
- Confirmed all JavaScript files pass `node --check` and the full Node test suite passes.

## [0.4.0] - 2026-07-17

### Added
- Added configurable save-confirmation frequency: once per typing burst (default), once per
  draft, or every save.

### Changed
- Save scheduling now starts a short delay from the first typing event, so the initial local
  save and its confirmation toast happen promptly and together.
- Email draft restoration now places the caret and viewport at the beginning of the restored
  body instead of leaving the editor scrolled to the bottom.

### Fixed
- Email paragraph markup is canonicalized before restore so CKEditor does not turn saved block
  wrappers into extra line breaks.

### Verified
- Confirmed all JavaScript files pass `node --check`.
- Confirmed `node --test test/content.test.js` passes with 16 tests.

## [0.3.3] - 2026-06-04

Follow-up to 0.3.2 from live testing. Rich text, line breaks, and bold now restore correctly
in the Post composer. This release fixes a deferred-restore case discovered while switching
publisher tabs.

### Fixed
- Fixed a saved Post draft not restoring when, after a refresh, the Email tab is opened before
  Post. The Post composer is hidden (inactive publisher tab) at that moment, and restoring into
  a hidden editor silently fails — but the element was still marked handled, so it never
  restored when Post was shown again. Restore now defers (without marking) while a field is not
  rendered, and retries when the field is focused or re-scanned once visible.

### Added
- Added a `focusin` listener that retries restore when a draft field gains focus, covering
  composers that Salesforce shows/hides by toggling visibility without a DOM mutation.
- Added `isElementRenderable` (client-rect based) and a regression test for it.

### Verified
- Confirmed `content.js` passes `node --check`.
- Confirmed `test/content.test.js` passes with `node --test` (13 tests).

## [0.3.2] - 2026-06-04

Follow-up to 0.3.1 from live testing: the Post delete bug is confirmed fixed and Post submits
the restored content, but Email drafts were saved yet never restored, and formatting/line
breaks still did not come back in Post.

### Fixed
- Fixed Email drafts saving but never restoring. The Email body (Salesforce/CKEditor) exposes
  per-load identifiers (instance ids, generated `title`/`aria-label`) that changed on every
  page load, so the key computed at save time did not match the key at restore time and the
  lookup silently missed. Email now uses a canonical key derived only from stable signals
  (record context + a fixed field id), so save and restore always agree.
- Reworked rich-text restore to insert through a synthetic `paste` carrying both `text/html`
  and `text/plain`. Quill (Post) and CKEditor (Email) ignore a direct `innerHTML` write and
  reconcile against their own model, which dropped formatting and line breaks; routing through
  the clipboard pipeline lets the editor convert the HTML into its model with formatting and
  breaks intact. A verified direct-DOM write remains as a fallback (only when the field is
  still empty, so it can never duplicate content).

### Added
- Added diagnostics (visible in the console with the `[SFDG]` prefix): the canonical Email
  draft key is logged on save and restore, the captured HTML length is logged on Email save,
  and the restore path (paste applied vs. DOM fallback) is logged.
- Added a regression test asserting the Email key is identical across different CKEditor
  instance identifiers.

### Changed (console hygiene)
- Narrowed `isEmailEditorElement` to the editable Email body itself. Its previous
  `closest(".cke_editor_editor")` clause matched every descendant of the CKEditor wrapper
  (toolbar buttons, layout divs), which logged a `[SFDG] email input not matched to draft
  element` warning on input events that legitimately are not draft fields.
- Removed per-event and per-save debug logging from the input handler, iframe scan, and
  metadata derivation; the remaining diagnostics are low-frequency (bind, save, restore).
- Set `DEBUG_ENABLED` to `false` by default so the console stays clean. Genuine failures are
  still reported via `console.error`. Flip the flag at the top of `content.js` to re-enable
  `[SFDG]` diagnostics when investigating.

### Notes
- Trade-off: all Email composers within the same record context now share one canonical draft
  key. Distinct concurrent Email drafts on the same record would collide; this is preferable to
  the previous total restore failure and can be refined later if needed.

### Verified
- Confirmed `content.js` and `injected.js` pass `node --check`.
- Confirmed `test/content.test.js` passes with `node --test` (12 tests).

## [0.3.1] - 2026-06-04

Follow-up to 0.3.0 fixing a critical restore regression and adding rich-text support, based
on manual testing in a live Salesforce org.

### Fixed
- Fixed a critical regression where, after a draft was restored, the field could only be
  added to — backspace/delete appeared to do nothing. The document observer was re-running
  restore continuously and the "current is a subset of the draft" heuristic re-injected the
  full draft on every deletion. Restore now happens at most once per editor element and only
  into an empty field, so edits and deletions are never undone.
- Fixed lost line breaks on restore (regression from the 0.3.0 `execCommand("insertText")`
  path, which collapsed embedded newlines).

### Added
- Added rich-text draft support (DG-008): saves now capture the editor's HTML in addition to
  plain text, and restores reapply it (sanitized) so bold/italic/links and exact line breaks
  come back. Plain-text fallback is retained for `textarea`/`input` and legacy drafts.
- Added a lightweight HTML sanitizer (`sanitizeDraftHtml`) that strips scripts, frames,
  inline event handlers, and `javascript:` URLs before re-injecting a saved draft.
- Added regression tests for empty-only restore and HTML-preferred restore.

### Changed
- Removed the `execCommand`/synthetic-paste restore path in favor of HTML/text DOM restore
  plus a synthetic input event for framework sync.

### Verified
- Confirmed `content.js` and `injected.js` pass `node --check`.
- Confirmed `test/content.test.js` passes with `node --test` (11 tests).

## [0.3.0] - 2026-06-04

This release targets the two core failures observed in 0.2.4 — drafts that never
restored, and drafts that restored with extra line breaks — for the Chatter Post and
Email composers. Rich-text formatting preservation (DG-008) and the Case Details fields
(DG-004/5/6) remain deferred to the roadmap.

### Fixed
- Fixed unstable draft keys (DG-002 root cause). `getFieldKey` no longer mixes volatile DOM
  position into the key when a field exposes intrinsic identity (label/placeholder/name/
  title), and `getContainerActionType` now classifies Post/Email structurally instead of
  from mutable `textContent`. Keys are frozen on the element/container so they cannot drift
  within a session and match across refreshes — drafts now restore reliably.
- Fixed line-break compounding on restore (DG-007). Restores now route through the editor's
  own input handling (`execCommand("insertText")`, with a synthetic paste and a direct DOM
  rebuild as fallbacks) so Quill/CKEditor keep their model in sync and stop re-normalizing
  the restored markup into extra blank lines.
- Added a restore guard so a programmatic restore (and the editor's follow-up mutations) no
  longer trigger a redundant save through the input listeners or the editor MutationObserver,
  which previously fed the line-break compounding back into storage.
- Routed the CKEditor Email body to a stable, frame-local container so its draft key no
  longer collapses onto the top page body.

### Changed
- Tightened the injected network hook's relevance filter to the specific Post/Email save
  endpoints instead of the broad `/services/data/` base, reducing the chance that an
  unrelated background request clears an unsent draft.
- Throttled the "Draft saved locally" toast to the first save per field per session so it no
  longer flashes on every pause in typing.

### Added
- Added regression tests for draft-key stability under text/DOM mutation, idempotent
  contenteditable round-trips, and the restore guard suppressing redundant saves.

### Verified
- Confirmed `content.js`, `injected.js`, `options.js`, `popup.js`, and `background.js` pass
  `node --check`.
- Confirmed `test/content.test.js` passes with `node --test` (9 tests).

## [0.2.4] - 2026-04-29

### Added
- Added options-page controls for toast position, text size, text color, background color, and optional sound effect.
- Added configurable toast rendering in `content.js` using stored settings, validated defaults, CSS variables, and data attributes.
- Added optional Web Audio toast sounds with `none` as the default.

### Changed
- Updated toast CSS to support upper/lower corner placement, upper/lower middle placement, centered placement, and scaled padding for each size.
- Updated README roadmap status for DG-003.

### Verified
- Confirmed `content.js` and `options.js` pass `node --check`.
- Confirmed `test/content.test.js` passes with `node --test`.

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

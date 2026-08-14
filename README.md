# Salesforce Draft Guard

Chrome extension that protects Salesforce activity drafts from accidental refreshes, field-driven frame reloads, and transient UI resets.

## What it does

- Watches Salesforce text-entry surfaces such as Email, Post, Log a Call, notes, and similar composer fields.
- Saves typed content in extension session storage while the browser session is active.
- Restores the draft when Salesforce rerenders the form, reloads a frame, or the page is refreshed.
- Clears the local draft after a likely successful Salesforce save/send request.

## Current behavior

This first version uses heuristics because Salesforce Lightning markup and request flows vary by org and feature:

- It watches `textarea`, text `input`, and `contenteditable` fields that appear related to messages, posts, calls, notes, or descriptions.
- It derives draft keys from Chrome tab id, the nearest mounted Salesforce record id, structural action type, and stable field semantics. Drafts remain isolated across Cases, browser tabs, and mounted Salesforce console workspace tabs.
- It normalizes Email iframe editors against the top Salesforce page context when that context is accessible, so saved and restored Email body keys stay aligned.
- It marks the active composer as pending-clear when the user clicks `Send`, `Share`, `Save`, `Post`, or `Log a Call`.
- It clears only the draft keys captured from that composer when Salesforce then issues a successful, composer-matching `POST`, `PUT`, or `PATCH` request. Record Details saves do not clear Email or Post drafts.
- It shows configurable toast notifications for save, restore, and clear events, including position, size, save-confirmation frequency, colors, and optional sound.

That is intentionally conservative, but not perfect. Expect some tuning against your specific Salesforce UI.

## Load it in Chrome

1. Open `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select this folder: `/Users/mgray/GitHub/SFsaver`.

## Suggested Git setup

Initialize and connect the repo:

```bash
git init
git checkout -b codex/salesforce-draft-guard
git add .
git commit -m "Initial Salesforce Draft Guard extension"
git remote add origin <your-github-repo-url>
git push -u origin codex/salesforce-draft-guard
```

## Features

- Options page for choosing which Salesforce actions clear drafts, which field keywords should be protected, and how toast notifications appear.
- Popup panel for reviewing saved drafts in the current browser session and clearing one or all drafts manually.
- **Clear Drafts / Cache** controls in both the popup and options page cancel pending autosaves and remove all saved drafts without resetting preferences.

## Local verification

```bash
node --check content.js
node --check injected.js
node --check options.js
node --check popup.js
node --check draft-storage.js
node --check background.js
node --test
```

## Debug logging

`content.js` ships with `DEBUG_ENABLED = false` so the DevTools console stays clean during
normal use (genuine failures are still reported via `console.error`). To investigate draft
save/restore behavior, set `DEBUG_ENABLED = true` at the top of `content.js`, reload the
extension, and watch for `[SFDG]` messages (draft keys, save/restore paths, iframe binding).

## Known Issues & Roadmap

Use this section as a lightweight backlog until we move to GitHub Issues/Projects.

### Priority scale

- P0: Data loss or core flow broken.
- P1: Major UX issue; workaround exists.
- P2: Minor bug, consistency issue, or polish.

### Open issues

| ID | Priority | Area | Status | Observed behavior | Repro notes | Next plan |
| --- | --- | --- | --- | --- | --- | --- |
| DG-001 | P1 | Post restore | Resolved in 0.2.3 (2026-04-29) | Restored drafts in the Post box included extra line breaks that were not in the original draft. | Covered by contenteditable normalization regression test. | Re-verify manually in Salesforce Post composer and watch for rich-text edge cases. |
| DG-002 | P0 | Email restore | Resolved in 0.3.2 (2026-06-04) | Email drafts saved but never restored. Root cause: the CKEditor Email body exposes per-load identifiers (instance ids, generated title/aria-label) that changed every page load, so the save-time key did not match the restore-time key. | Fixed with a canonical Email key (record context + fixed field id); covered by a regression test asserting key identity across CKEditor instance ids. | Re-verify manually in the Salesforce Email tab and confirm Send clears the Email body draft. |
| DG-003 | P1 | Save toast UI | Resolved in 0.2.4 (2026-04-29) | "Draft saved locally" toast placement was inconsistent and styling was fixed. | Added settings controls for toast position, size, colors, and optional sound effect. | Re-verify manually in Salesforce Post and Email composers with several toast positions and sizes. |
| DG-004 | P1 | Case Details drafting | Planned | Add draft save/restore support for `Case Details > Plan of Action > What`. | Validate field detection in Case Details context and capture stable keying signals. | Implement field targeting + restore handling, then add regression coverage for this specific field path. |
| DG-005 | P1 | Case Details drafting | Planned | Add draft save/restore support for `Case Details > Closure Information > Internal Resolution Summary`. | Confirm this field’s DOM lifecycle and whether Salesforce rerenders on status transitions. | Implement field targeting + restore handling, then add regression coverage for this specific field path. |
| DG-006 | P1 | Case Details drafting | Planned | Add draft save/restore support for `Case Details > Closure Information > Resolution Summary`. | Confirm selector stability across Lightning record layouts/org variants. | Implement field targeting + restore handling, then add regression coverage for this specific field path. |
| DG-007 | P1 | Draft restore | Resolved in 0.3.0 (2026-06-04) | Restored drafts had extraneous/compounded line breaks not in the original draft. | Root cause was a feedback loop: a direct DOM rebuild was re-normalized by Quill/CKEditor, then re-saved by the editor observer. Fixed by routing restores through the editor's input handling and adding a restore guard; covered by an idempotent round-trip regression test. | Re-verify manually in the Salesforce Post and Email composers for exact line-break preservation. |
| DG-008 | P1 | Draft restore | In progress (0.3.2, 2026-06-04) | Formatted text (bold, italic) and line breaks did not restore. A direct innerHTML write was dropped by Quill/CKEditor (they reconcile against their own model). | Saves capture sanitized HTML; restore now injects via a synthetic paste (text/html + text/plain) so the editor's clipboard pipeline preserves formatting and breaks, with a verified DOM-write fallback. | Re-verify manually in Post and Email that bold/italic/links and line breaks restore, and that Send/Post submits the restored content. If formatting still drops, capture the `[SFDG]` console logs (restore path + html length). |
| DG-009 | P2 | Toast UI | Planned | Place the save/restore toast closer to the composer — ideally embedded to the left of the "Share"/"Send" button rather than floating at a screen corner. | Toast position is configurable today via the extension's options page (not `chrome://extensions`), but only to fixed screen anchors. | Add an "anchored to composer" toast mode that positions relative to the active composer's action bar. |
| DG-010 | P1 | Draft restore | Open | After a restored draft, backspace/delete appeared to do nothing (could only add text). | Resolved in 0.3.1 by restoring at most once per editor element and only into empty fields; tracked here for manual re-verification. | Re-verify in Post and Email that deleting/backspacing through restored content works normally. |
| DG-011 | P1 | Draft restore | Resolved in 0.3.3 (2026-06-04) | A saved Post draft did not restore if the Email tab was opened before Post after a refresh. | The Post composer is hidden when Email is active; restoring into a hidden editor failed but the element was marked handled. Restore now defers while a field is not rendered and retries on focus/re-scan. | Re-verify: save a Post draft, refresh, open Email, then return to Post and confirm the draft restores. |
| DG-012 | P1 | Email composer | Open (testing) | End-to-end Email box behavior is not yet fully verified in a live org. | Canonical Email key (0.3.2), rich-text restore (0.3.2), and deferred-restore (0.3.3) all land but Email has not had a full manual pass. | Verify: type a formatted, multi-line Email draft, refresh, confirm restore (formatting + breaks), confirm Send clears the draft, and confirm Send submits the restored body (not stale/empty). Capture `[SFDG]` logs if anything fails. |
| DG-013 | P0 | Draft cleanup/isolation | Resolved in 0.6.0 (2026-08-13) | Sent/saved Email, Post, and Note drafts could be recreated by late editor activity; Lightning DOM reuse could also restore a ticket 0001 draft on ticket 0004. | Fixed with Chrome-tab + nearest-record + composer + field identity, authoritative cross-frame clear tombstones, per-scope restore guards, Aura request-body action detection, and a one-time draft-schema purge. Mounted Salesforce console workspace tabs and Email iframes resolve their owning record locally. Settings are preserved. Covered by automated regression tests. | Re-enable only after manually verifying Send/Share/Save cleanup and isolation across Cases, Chrome tabs, and Salesforce workspace tabs in the target org. |
| DG-014 | P1 | Long-ticket layout/focus | Resolved in 0.6.1 (2026-08-13) | Long tickets could gain an extremely tall blank workspace/background region; after scrolling away, any keypress snapped the page back to the restored composer. The 0.6.0 scroller repair did not address the focus/selection trigger. | Synthetic-paste recovery now restores prior focus or blurs the editor, never recreates a background selection, resets only editor-local viewports, and never mutates the top Salesforce document scroller. Covered by focus-release, selection, and viewport-isolation tests. | Re-verify on a long ticket: restore a Post/Email draft, scroll above it, press ordinary keys, and confirm the page neither jumps nor gains blank height without using browser zoom. |

### DG-003 toast display options

- Position: `upper-right`, `upper-left`, `lower-left`, `lower-right` (default), `lower-middle`, `absolute-middle`, or `upper-middle`.
- Text size: Small, Medium (default), Large, or Extra Large.
- Save confirmation frequency: Once per typing burst (default), once per draft, or every save.
- Colors: user-selectable text and background colors.
- Sound effect: None (default), Soft chime, Click, or Success tone.

### Next investigation pass

1. Manually smoke-test DG-002, DG-007, DG-008, and DG-010 in Salesforce against version 0.4.0:
   in the Post and Email composers, type multi-line and formatted (bold/italic) text, refresh
   or re-render, and confirm an exact restore — including formatting and line breaks, with no
   extra blank lines — then confirm you can freely backspace/delete the restored content, and
   that Send/Post clears the draft and submits the restored content (not stale/empty content).
2. Confirm a background Salesforce request (list refresh, navigation) does not clear an unsent
   draft now that the network relevance filter is narrower.
3. Capture any remaining Salesforce-specific CKEditor or Post composer edge cases as fresh roadmap rows.
4. Add coverage for DG-004, DG-005, and DG-006 field detection before implementing Case Details drafting.
5. DG-009: prototype a composer-anchored toast mode positioned near the action bar.

### Definition of done (per issue)

- Repro documented.
- Root cause identified (or enhancement scope documented).
- Automated test added/updated where applicable.
- Fix/enhancement merged.
- README row updated to `Resolved` with date and a short note.

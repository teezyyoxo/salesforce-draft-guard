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
- It derives draft keys from more stable Salesforce signals such as record id, action type, field semantics, and field position.
- It normalizes Email iframe editors against the top Salesforce page context when that context is accessible, so saved and restored Email body keys stay aligned.
- It marks the active composer as pending-clear when the user clicks `Send`, `Share`, `Save`, `Post`, or `Log a Call`.
- It clears only the draft keys captured from that composer when Salesforce then issues a successful related `POST`, `PUT`, or `PATCH` request.
- It shows configurable toast notifications for save, restore, and clear events, including position, size, colors, and optional sound.

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

## Local verification

```bash
node --check content.js
node --check options.js
node --test test/content.test.js
```

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
| DG-002 | P0 | Email restore | Resolved in 0.2.3 (2026-04-29) | Draft keys were created/stored and persisted, but drafts did not restore when clicking the Email tab/button. | Covered by iframe-root discovery and top-page scope regression tests. | Re-verify manually in Salesforce Email tab and confirm Send clears the iframe body draft. |
| DG-003 | P1 | Save toast UI | Resolved in 0.2.4 (2026-04-29) | "Draft saved locally" toast placement was inconsistent and styling was fixed. | Added settings controls for toast position, size, colors, and optional sound effect. | Re-verify manually in Salesforce Post and Email composers with several toast positions and sizes. |
| DG-004 | P1 | Case Details drafting | Planned | Add draft save/restore support for `Case Details > Plan of Action > What`. | Validate field detection in Case Details context and capture stable keying signals. | Implement field targeting + restore handling, then add regression coverage for this specific field path. |
| DG-005 | P1 | Case Details drafting | Planned | Add draft save/restore support for `Case Details > Closure Information > Internal Resolution Summary`. | Confirm this field’s DOM lifecycle and whether Salesforce rerenders on status transitions. | Implement field targeting + restore handling, then add regression coverage for this specific field path. |
| DG-006 | P1 | Case Details drafting | Planned | Add draft save/restore support for `Case Details > Closure Information > Resolution Summary`. | Confirm selector stability across Lightning record layouts/org variants. | Implement field targeting + restore handling, then add regression coverage for this specific field path. |
| DG-007 | P1 | Draft restore | Open | Restored drafts have extraneous/compounded line breaks that were not in the original draft. Restoration should be a carbon copy of the draft. | Observed in Salesforce Post composer. Verify in Email and other composer fields; check if draft-saving logic is out of tune or if restoration normalization is adding extra breaks. | Audit draft-saving and restoration logic for contenteditable and textarea fields; add regression test for exact line-break preservation. |
| DG-008 | P1 | Draft restore | Open | Formatted text (bold, italic, underline, etc.) saved to drafts does not restore with formatting intact. | Observed in Salesforce Post composer. Verify in Email and other rich-text fields since last commit. | Audit save/restore handlers for contenteditable fields to ensure HTML structure and styling attributes are preserved; add coverage for formatted text roundtrips. |

### DG-003 toast display options

- Position: `upper-right`, `upper-left`, `lower-left`, `lower-right` (default), `lower-middle`, `absolute-middle`, or `upper-middle`.
- Text size: Small, Medium (default), Large, or Extra Large.
- Colors: user-selectable text and background colors.
- Sound effect: None (default), Soft chime, Click, or Success tone.

### Next investigation pass

1. Manually smoke-test DG-001 and DG-002 in Salesforce against version 0.2.4.
2. Capture any remaining Salesforce-specific CKEditor or Post composer edge cases as fresh roadmap rows.
3. Validate DG-003 positioning/style behavior across Post and Email composers after loading version 0.2.4.
4. Add coverage for DG-004, DG-005, and DG-006 field detection before implementing Case Details drafting.
5. Investigate DG-007: audit draft-saving and restoration logic for line-break compounding; verify draft-saving logic is capturing content correctly and restoration is not adding extra breaks.
6. Investigate DG-008: audit save/restore handlers for rich-text formatting; ensure HTML/styling attributes are captured and restored; add test coverage for bold, italic, underline, and other formatting roundtrips.

### Definition of done (per issue)

- Repro documented.
- Root cause identified (or enhancement scope documented).
- Automated test added/updated where applicable.
- Fix/enhancement merged.
- README row updated to `Resolved` with date and a short note.

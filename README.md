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

- Options page for choosing which Salesforce actions clear drafts and which field keywords should be protected.
- Popup panel for reviewing saved drafts in the current browser session and clearing one or all drafts manually.

## Local verification

```bash
node --check content.js
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
| DG-003 | P1 | Save toast UI | Open | "Draft saved locally" toast placement is inconsistent: lower-right for Post drafts and closer to center for Email drafts. | Observe toast in both Post and Email save flows; compare anchor/position logic. | Add settings controls for toast position, colors, and text size; standardize renderer so toast placement/style is consistent across Post and Email flows. |
| DG-004 | P1 | Case Details drafting | Planned | Add draft save/restore support for `Case Details > Plan of Action > What`. | Validate field detection in Case Details context and capture stable keying signals. | Implement field targeting + restore handling, then add regression coverage for this specific field path. |
| DG-005 | P1 | Case Details drafting | Planned | Add draft save/restore support for `Case Details > Closure Information > Internal Resolution Summary`. | Confirm this field’s DOM lifecycle and whether Salesforce rerenders on status transitions. | Implement field targeting + restore handling, then add regression coverage for this specific field path. |
| DG-006 | P1 | Case Details drafting | Planned | Add draft save/restore support for `Case Details > Closure Information > Resolution Summary`. | Confirm selector stability across Lightning record layouts/org variants. | Implement field targeting + restore handling, then add regression coverage for this specific field path. |

### Planned enhancement details for DG-003

- Add a settings dropdown for toast position with these values:
  - `upper-right`
  - `upper-left`
  - `lower-left`
  - `lower-right` (default)
  - `lower-middle`
  - `absolute-middle`
  - `upper-middle`
- Add user-selectable text color and background color options.
- Add a text size option (for example: Small, Medium, Large, Extra Large).
- Ensure toast background/padding scales with text size so readability and contrast remain consistent.
- Keep sensible defaults, but allow user customization at any time.

### Next investigation pass

1. Manually smoke-test DG-001 and DG-002 in Salesforce against version 0.2.3.
2. Capture any remaining Salesforce-specific CKEditor or Post composer edge cases as fresh roadmap rows.
3. Implement DG-003 settings and validate positioning/style behavior across Post and Email composers.
4. Add coverage for DG-004, DG-005, and DG-006 field detection before implementing Case Details drafting.

### Definition of done (per issue)

- Repro documented.
- Root cause identified (or enhancement scope documented).
- Automated test added/updated where applicable.
- Fix/enhancement merged.
- README row updated to `Resolved` with date and a short note.

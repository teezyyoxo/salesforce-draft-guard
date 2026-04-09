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

## Known Issues & Roadmap

Use this section as a lightweight backlog until we move to GitHub Issues/Projects.

### Priority scale

- P0: Data loss or core flow broken.
- P1: Major UX issue; workaround exists.
- P2: Minor bug, consistency issue, or polish.

### Open issues

| ID | Priority | Area | Status | Observed behavior | Repro notes | Next plan |
| --- | --- | --- | --- | --- | --- | --- |
| DG-001 | P1 | Post restore | Open | Restored drafts in the Post box include extra line breaks that were not in the original draft. | Seen during restore flow in Post composer. | Compare save vs restore normalization (`\n`, `\r\n`, `<br>`, block tags), then add targeted Post restore-format tests before fix. |
| DG-002 | P0 | Email restore | Open (re-verify) | Draft keys are created/stored and persist, but drafts do not restore when clicking the Email tab/button. | Last verified failing in tests from last week; not recently re-tested. | Reproduce on current build, verify selector/timing/tab-activation behavior for Email composer, then add regression test for Email-tab restore trigger. |
| DG-003 | P1 | Save toast UI | Open | "Draft saved locally" toast placement is inconsistent: lower-right for Post drafts and closer to center for Email drafts. | Observe toast in both Post and Email save flows; compare anchor/position logic. | Add settings controls for toast position, colors, and text size; standardize renderer so toast placement/style is consistent across Post and Email flows. |

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

1. Re-verify DG-002 on the current build and capture exact repro steps.
2. Instrument restore-path logs for Post vs Email to compare detection and timing.
3. Add regression tests for DG-001 and DG-002 before implementing fixes.
4. Implement fixes and validate with a manual Salesforce smoke pass.
5. Implement DG-003 settings and validate positioning/style behavior across Post and Email composers.

### Definition of done (per issue)

- Repro documented.
- Root cause identified (or enhancement scope documented).
- Automated test added/updated where applicable.
- Fix/enhancement merged.
- README row updated to `Resolved` with date and a short note.

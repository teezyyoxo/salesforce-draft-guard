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

## Next hardening steps

- Add an options page so you can customize which actions and fields are protected.
- Add a popup panel to inspect and manually clear stored drafts.
- Capture richer Salesforce-specific selectors after testing in your org.
- Add automated tests for key generation, restore rules, and clear heuristics.

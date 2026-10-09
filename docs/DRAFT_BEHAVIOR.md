# Draft protection behavior


Draft protection uses heuristics because Salesforce Lightning markup and request flows vary by org and feature:

- It watches `textarea`, text `input`, and `contenteditable` fields that appear related to messages, posts, calls, notes, or descriptions.
- It derives draft keys from Chrome tab id, the nearest mounted Salesforce record id, structural action type, and stable field semantics. Drafts remain isolated across Cases, browser tabs, and mounted Salesforce console workspace tabs.
- Every stored draft also carries its verified Salesforce record owner. Restore fails closed when ownership is missing, conflicting, or ambiguous; hidden workspace composers cannot inherit the active ticket URL.
- It normalizes Email iframe editors against the top Salesforce page context when that context is accessible, so saved and restored Email body keys stay aligned.
- For Email replies, it treats Salesforce's prefilled signature and quoted conversation as read-only baseline content and saves only the newly authored reply above it. Framework-inserted Email history never creates a draft by itself, and a baseline fingerprint isolates different Reply actions on the same Case.
- It marks the active composer as pending-clear when the user clicks `Send`, `Share`, `Save`, `Post`, or `Log a Call`.
- It clears only the draft keys captured from that composer when Salesforce then issues a successful, composer-matching `POST`, `PUT`, or `PATCH` request. Record Details saves do not clear Email or Post drafts.
- It shows configurable toast notifications for save, restore, and clear events, including position, size, save-confirmation frequency, colors, and optional sound.

That is intentionally conservative, but not perfect. Expect some tuning against your specific Salesforce UI.


## Debug logging


`content.js` ships with `DEBUG_ENABLED = false` so the DevTools console stays clean during
normal use (genuine failures are still reported via `console.error`). To investigate draft
save/restore behavior, set `DEBUG_ENABLED = true` at the top of `content.js`, reload the
extension, and watch for `[SFDG]` messages (draft keys, save/restore paths, iframe binding).

## Manual verification

On the current build, test formatted multi-line Post and Email drafts, refresh/re-render recovery, backspace/delete, and successful Send/Share cleanup. Verify two Cases open simultaneously in Chrome tabs and mounted Salesforce console workspaces. Email recovery must prepend only the authored reply and preserve the existing signature/quoted history. On long tickets, recovery must not steal focus, jump the page, or introduce blank height.

Keep [Case Details field requests](https://github.com/teezyyoxo/salesforce-draft-guard/issues?q=is%3Aissue%20DG-004%20OR%20DG-005%20OR%20DG-006) separate from verified support. Retest the original reproduction before calling any remaining report fixed.

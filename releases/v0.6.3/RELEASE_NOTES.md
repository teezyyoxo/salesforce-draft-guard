# Salesforce Draft Guard 0.6.3

Protect Salesforce Lightning Email, Post, and other detected activity drafts from refreshes, frame reloads, and transient UI resets. This first packaged release includes the August 2026 isolation hotfix and the October 2026 UI, icon, license, and documentation refresh. The extension version remains **0.6.3**.

## Download

Download **Salesforce-Draft-Guard-v0.6.3.zip** from the release assets. The ZIP contains only the extension runtime and MIT license notice, with `manifest.json` at its root. No build tools, tests, source-control data, screenshots, or development documentation are included.

## Highlights

- Drafts are scoped to their Chrome tab, verified Salesforce record, composer, and field. Recovery rejects missing, mismatched, or ambiguous record ownership.
- Email saves and restores only the authored reply above its prefilled signature and quoted conversation; separate Reply contexts remain isolated.
- Clear Drafts / Cache cancels pending saves and clears extension draft storage while preserving preferences.
- Salesforce-style popup and settings pages use blue accents, system fonts, and System/Light/Dark appearances. System is the default.
- Headers and footers remain visible while the main content scrolls. Protected Actions share one desktop row.
- New draft-and-shield icons, MIT license, setup guidance, and GitHub-linked issue tracking.
- Salesforce toast styles, defaults, and runtime behavior are unchanged by the UI refresh.

## Install and set up

1. Download the release ZIP and extract it into a permanent folder, such as `Salesforce-Draft-Guard`.
2. Open `chrome://extensions` in a current Chrome browser and enable **Developer mode**.
3. Select **Load unpacked**, then choose the extracted folder containing `manifest.json`. Select the folder, not the ZIP.
4. Open Chrome’s Extensions menu and pin **Salesforce Draft Guard** if you want quick access to saved drafts.
5. Refresh open Salesforce tabs so the extension can attach to their composers.
6. Open the toolbar popup, choose **Settings**, and review the default actions and field keywords. Choose an appearance or leave **System** enabled; use **Save Settings** after changing protection or notification preferences.
7. In your org, type a harmless test draft in a supported Post or Email composer, refresh, and return to the same Case/composer in the same Chrome tab to check recovery. Confirm your normal workflow before relying on it. Clear the test draft from the popup when finished.

No Salesforce API login, npm installation, or build step is required. Chrome’s [unpacked-extension instructions](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked) explain the browser installation flow.

## Update an existing installation

Save or copy important unsent text before updating. Replace the old extension files in the **same unpacked folder**, click the extension’s reload button in `chrome://extensions`, and refresh Salesforce tabs. Keeping the same folder avoids accidentally creating a separate unpacked installation with separate settings.

**Migration from versions older than 0.6.3:** the draft-schema upgrade deletes all older stored drafts because their record ownership cannot be verified and they may contain quoted Email history. Protection/notification settings are preserved. Already-current schema-3 reloads do not trigger that purge.

## Known limitations

- [DG-016 / #16](https://github.com/teezyyoxo/salesforce-draft-guard/issues/16): intermittent field/composer container mutation still occurs. No reliable reproduction sequence or confirmed workaround is known; it is not claimed fixed by this release.
- [DG-017 / #17](https://github.com/teezyyoxo/salesforce-draft-guard/issues/17): reported hyperlink modal overlap needs investigation. Original screenshot, reliable reproduction, and extension attribution remain unconfirmed.
- Rich-text recovery, backspace/delete, and end-to-end Email behavior still have outstanding live-org verification reports. Planned Case Details field support is not presented as implemented.
- Protection relies on Salesforce markup/request heuristics. Drafts use session storage when available and are a recovery aid, not a durable backup across browser restarts.

See [all open and closed issues](https://github.com/teezyyoxo/salesforce-draft-guard/issues?q=is%3Aissue) and [the changelog](https://github.com/teezyyoxo/salesforce-draft-guard/blob/main/CHANGELOG.md).

## Validation

All 74 automated regression tests pass. The extracted ZIP was loaded as a real extension in a disposable Chromium browser: service worker, schema initialization, options, popup, shared appearance preference, and all icon assets were verified. Rebuilding the archive produces the same checksum. This does not replace the outstanding live-Salesforce-org verification.

## Package checksum

SHA-256 (`Salesforce-Draft-Guard-v0.6.3.zip`):

```text
4f7c72761fe57087ad9d12824bd25b0988acf934b20865e64db92b651ecfa4c0
```

MIT licensed. Independent project; not affiliated with or endorsed by Salesforce.

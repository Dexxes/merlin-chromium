# Merlin for Chrome

A Chrome (and Edge) extension for saving links and pages to Merlin, a
cross-platform read-it-later app backed by either a Nextcloud instance
([`merlin-nextcloud`](https://github.com/Dexxes/merlin-nextcloud/)) or an independent standalone
server ([`merlin-standalone-server`](https://github.com/Dexxes/merlin-standalone-server)).

Save the page you're viewing, or a link on it, to your Merlin reading list via the
right-click context menu — no separate reader UI, just a fast, one-click save tool.

## Features

- **Save link / save page** from the right-click context menu, with or without tags
- **Save with tags** opens a small dialog: type tags (comma-separated) or pick existing
  ones from the tag tree; typing filters the tree, nested tags keep their parents
- Works against either backend: a Nextcloud instance running the Merlin app, or a
  [`merlin-standalone-server`](https://github.com/Dexxes/merlin-standalone-server)
- **Nextcloud Login Flow v2** support — connect without typing an app password by hand
  (reimplemented identically for the standalone backend)
- Sends the rendered page HTML (up to 10 MB) along with page saves, so paywalled or
  JS-rendered pages don't need a second server-side fetch
- Credentials stay in `storage.local` on this device. Syncing them to your other Chrome
  installs is opt-in and only as AES-GCM ciphertext, keyed by a passphrase that is
  never synced (see below)
- Host access to your Merlin server is requested at runtime, scoped to that one origin —
  no standing `<all_urls>` permission
- Server URLs must use `https://`; plain `http://` is only accepted for `localhost`
- Animated in-page toast reports save progress/success/failure, with a desktop
  notification fallback on pages where extensions cannot run (`chrome://`, the Chrome
  Web Store, the PDF viewer)
- Localized UI (English, German)

## Requirements

- Chrome or Edge 110 or later (Manifest V3; extension API calls keep the service worker
  alive during the login flow)
- A reachable Merlin backend: either a Nextcloud instance with the
  [`merlin-nextcloud`](https://github.com/Dexxes/merlin-nextcloud/) app installed, or a
  [`merlin-standalone-server`](https://github.com/Dexxes/merlin-standalone-server) instance

## Installation

Install from the Chrome Web Store, or load unpacked for development:

1. Open `chrome://extensions` (Edge: `edge://extensions`)
2. Turn on **Developer mode**
3. **Load unpacked** → select this directory

## Setup

Open the extension's settings (toolbar icon), choose your backend type (Nextcloud or
standalone server), enter the server URL, and click **Login**. Chrome asks for
permission to access that one server — this is expected and only needs to be granted
once. **Test connection** checks the stored login against the server.

To use the same login on another computer, set an encryption passphrase under
**Enable encrypted sync**. On the other computer, open the settings and unlock the
synced login with the same passphrase.

## Architecture

| File | Purpose |
|---|---|
| `manifest.json` | Extension manifest (Manifest V3, service worker, optional host permissions) |
| `crypto.js` | AES-GCM/PBKDF2 encryption of the optional synced credential copy |
| `common.js` | Shared helpers: i18n shorthand, credential storage, URL checks, 401 handling |
| `background.js` | Service worker: context menu, save flow, tag resolution, Login Flow polling, in-page toast |
| `options.html` / `options.js` | Settings UI: backend selection, login, connection test, encrypted sync |
| `save-dialog.html` / `save-dialog.js` | Popup dialog for entering/selecting tags before saving |
| `i18n.js` | Localization helper for the extension pages |
| `_locales/` | Translated strings (`en`, `de`) |
| `tools/build-zip.ps1` | Builds the Chrome Web Store `.zip` into `build/` |
| `tests/` | Node tests (service worker in a VM, pages in headless Chromium) |

## Notes

- No persistent content script runs on visited pages — the save toast (`renderFlyout`)
  and the HTML capture (`document.documentElement.outerHTML`) are injected on demand via
  `chrome.scripting.executeScript`, only in direct response to a context-menu click
  (`activeTab`).
- The service worker loads `crypto.js` and `common.js` via `importScripts()`; the pages
  load them via `<script>`. There is no build step.
- Login Flow polling runs in the service worker, because the toolbar popup closes as soon
  as the login tab opens. Its state lives in `storage.local`, and an alarm resumes it if
  Chrome stopped the worker in between.
- Chrome Sync does not end-to-end encrypt `storage.sync` by default, unlike Firefox Sync.
  That is why this extension keeps the app password local and only syncs the
  passphrase-encrypted copy — the main difference from `merlin-firefox`.

## Development

```sh
npm install
npx playwright install chromium
npm test
```

The same tests run in GitHub Actions on every push and pull request
(`.github/workflows/test.yml`). To build the store package:

```powershell
.\tools\build-zip.ps1
```

## Localization

`_locales/<lang>/messages.json` is generated, not edited by hand. The source strings
live in [`merlin-translations`](https://github.com/Dexxes/merlin-translations) under
the `webext.*` namespace of `en.json` / `de.json`. To change a text, edit it there and
regenerate with:

```sh
# with merlin-translations and merlin-chrome checked out side by side
python3 merlin-translations/export.py --platform webext
```

The `_locales` files are shared with the Firefox and Thunderbird extensions, so they
contain some messages this extension does not use.

## Data handling

When you save, the extension sends the URL (and for page saves the rendered HTML, up
to 10 MB) plus your login to the Merlin server you configured. Nothing is sent anywhere
else, and nothing is sent without a context-menu click. If you enable encrypted sync,
an encrypted copy of your login is stored in Chrome Sync; the passphrase never leaves
the device.

## License

AGPL-3.0-or-later — see [LICENCE.md](LICENCE.md).

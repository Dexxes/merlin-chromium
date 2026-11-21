# Changelog

All notable changes to Merlin for Chrome are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning based on
[SemVer](https://semver.org/).

## [1.1.0] - Unreleased

Brings the extension up to the state of `merlin-firefox` 1.3.1 and
`merlin-thunderbird` 1.2.0.

### Added
- Save link / save page **with tags** from the context menu. A small dialog lists
  existing tags as a tree (nested tags of merlin-nextcloud below their parent);
  selecting a sub-tag also selects its parents, deselecting a tag also deselects its
  sub-tags. Typing filters the tree by the tag currently being typed. The dialog opens
  centered over the browser window.
  - Standalone-server saves resolve tag names to IDs via `/api/tags` (creating new tags
    as needed); tags that could not be applied are reported in the toast.
- Clear error message when the Nextcloud backend rejects a domain as unsupported
- Link to the source code on the settings page
- Tests (`npm test`) and a GitHub Actions workflow running them

### Changed
- Settings: the URL field is prefilled with `https://` instead of showing a fixed
  `https://` prefix, so `http://localhost` can be used for local development. A full
  URL pasted into the field replaces the prefix.
- Settings: the backend labels, the login button ("Log in" for the standalone server)
  and the welcome hint follow the selected backend
- Notifications are titled just "Merlin"; the result is in the text. The
  "saving…" notification on pages without a toast is gone.
- **Test connection** only tests the stored URL and login; if another URL was typed in,
  it asks to log in again instead of sending the app password there
- A single HTTP 401 no longer logs you out; credentials are cleared after the second
  consecutive 401
- Page HTML is only sent up to 10 MB; larger pages are saved by URL only
- Extension name is just "Merlin"; texts synced with `merlin-translations`
- Requires Chrome 110 (`minimum_chrome_version`)

### Fixed
- Extension icons now come in the sizes the manifest declares (16, 32, 48, 128 px),
  generated from the Merlin logo
- Saving times out after 60 s (tag requests after 10 s) instead of leaving the loading
  toast up forever
- Login Flow: polling runs every 2 s instead of every 30 s, survives Chrome stopping the
  service worker, and no longer leaves the settings stuck on "complete login" after a
  timeout
- "Logged in as …" is shown even when the login finished while no settings page was
  open
- A new login now also refreshes the encrypted sync copy (it kept the old app
  password before)

### Security
- `http://` server URLs are rejected (except `localhost`)
- Login Flow responses are validated: the poll endpoint must be on the entered server,
  the login page must use `https://`, the returned server URL must be same-origin, and
  the returned credentials must be present
- `runtime.onMessage` only accepts messages from the extension's own pages
- The in-page toast lives in a closed shadow root, so page CSS cannot hide or restyle it
  and page scripts cannot read it
- A synced login is only unlocked if its server URL passes the same `https://` check
  as a login

### Internal
- Shared helpers moved to `common.js`, loaded by the service worker via
  `importScripts()`
- Context-menu items are only created on install/update; they persist across restarts
- `tools/build-zip.ps1` builds the Chrome Web Store package
- Code comments are now consistently in English

## [1.0.0]

Initial release.

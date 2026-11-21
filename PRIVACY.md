# Privacy Policy — Merlin for Chrome and Edge

_Last updated: 2026-11-21_

Merlin for Chrome and Edge ("the extension") saves web pages and links to a Merlin
reading list on a server that **you** run or choose: a Nextcloud instance with the
Merlin app, or a Merlin standalone server. The extension has no server, analytics or
tracking of its own. The developer does not receive, collect or have access to any of
your data.

## What data is processed

The extension only sends data when you click one of its context-menu entries
("Send link to Merlin", "Save page to Merlin", or the "… with tags" variants), and
only to the server URL you entered in its settings.

| Data | When | Sent to |
|---|---|---|
| URL of the link or page | Every save | Your Merlin server |
| Rendered HTML of the current page (up to 10 MB) | "Save page" only | Your Merlin server |
| Tags you enter or select | Saves with tags | Your Merlin server |
| Username and app password | Every request to your server (HTTP Basic Auth over HTTPS) | Your Merlin server |

The extension does not read pages in the background, does not record your browsing
history, and does not send data to any other party. Connections to your server must
use `https://`. Plain `http://` is only allowed for `localhost` during development.

## What data is stored

All of the following is stored by the browser's extension storage on your device:

- **Settings and login:** server URL, backend type, username and the app password your
  server issues during login (Nextcloud Login Flow v2). These are stored in local
  extension storage and never leave the device, except as described under "Optional
  encrypted sync".
- **Temporary state:** the progress of an ongoing login, and the URL of a save while
  the tag dialog is open. This is deleted when the login or save finishes, or when the
  dialog is closed.

Clicking **Disconnect** in the settings deletes the stored login. Uninstalling the
extension deletes all of its stored data.

## Optional encrypted sync

Sync is off by default. If you set an encryption passphrase in the settings, an
encrypted copy of your login is stored in the browser's sync storage (Chrome Sync or
Microsoft Edge sync). It is encrypted with AES-GCM and a key derived from your
passphrase, and you can then use the same login on your other devices. The passphrase
itself is never synced. Without it, the synced copy cannot be read by the sync
provider or anyone else.

## Permissions

- **Context menus:** the save entries in the right-click menu.
- **Active tab / scripting:** after you click a save entry, the extension shows a status
  message in that tab and, for "Save page", reads that page's HTML once.
- **Notifications:** reports the result where the in-page message cannot be shown.
- **Storage:** settings and login as described above.
- **Alarms:** keeps the login process running while you approve it in a new tab.
- **Host access:** requested at runtime for your own server's address only.

## Your Merlin server

What happens to saved articles on your server is governed by whoever operates that
server (usually you), not by this extension.

## Changes

Changes to this policy are published in this file in the
[merlin-chromium](https://github.com/Dexxes/merlin-chromium) repository. Its commit
history shows every earlier version.

## Contact

For questions, open an issue at https://github.com/Dexxes/merlin-chromium/issues.

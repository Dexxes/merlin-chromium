# merlin-chrome – Structure

Chrome Extension (Manifest V3) zum Speichern von Links und Seiten in die Nextcloud-Merlin-App.

## Lokalisierung (DE/EN)
Alle UI-Strings kommen aus `chrome.i18n` (`_locales/<lang>/messages.json`,
`default_locale: "en"`). Die `messages.json` werden zentral generiert aus
`localization/strings/*.json` via `tools/i18n/export.py --platform webext` —
NIE direkt editieren. `manifest.json` nutzt `__MSG_extName__` /
`__MSG_extDescription__` / `__MSG_actionTitle__`; statische HTML-Texte werden
über `data-i18n`-Attribute markiert und von `i18n.js` zur Laufzeit gefüllt;
JS-Strings über `chrome.i18n.getMessage(key, [subs])`.

## Dateien

### manifest.json — Konfiguration
- `manifest_version: 3` (Pflicht für Chrome/Edge)
- `background.service_worker` statt `background.scripts` (MV3-Requirement)
- Kein `browser_specific_settings`-Block (Firefox/Gecko-spezifisch, hier entfernt)
- Permissions: `contextMenus`, `notifications`, `scripting`, `storage`, `activeTab`, `tabs`
- `host_permissions: ["<all_urls>"]` — nötig für Script-Injection und API-Fetch

### background.js — Logik (Service Worker)
Läuft als Chrome MV3 Service Worker (kein DOM-Zugriff, kein `localStorage`, kein `FileReader`).

**Wichtige Funktionen:**
- `getLogoDataUrl()` — lädt das Icon via `fetch` + `arrayBuffer` und kodiert es als base64 Data-URL (kein FileReader, weil SW-inkompatibel)
- `setupContextMenu()` — legt zwei Kontextmenü-Einträge an: "Send link to Merlin" (Links) und "Save page to Merlin" (Seiten/Bilder/Auswahl); verwendet Callback-Form von `chrome.contextMenus.removeAll()`
- Kontextmenü-Handler — liest Credentials aus `chrome.storage.local`, injiziert Flyout, ruft `saveToMerlin()` auf
- `saveToMerlin()` — POST an `{nextcloudUrl}/index.php/apps/merlin/api/v1/add` mit Basic Auth; bei Seitenaufruf wird HTML mitgeschickt; bei 401 werden Credentials gelöscht und `notifyAuthFailed()` (Notification) ausgelöst
- `injectFlyout()` / `renderFlyout()` — injiziert animiertes Toast-Notification in die Seite via `chrome.scripting.executeScript`; Fallback auf `chrome.notifications` für privilegierte Seiten (about:*, PDF-Viewer)
- Migration (`onInstalled`) — zieht evtl. noch vorhandene Credentials einmalig von `chrome.storage.sync` nach `chrome.storage.local` um (Sicherheitsfix: App-Passwort soll nicht mehr über Google-Sync laufen) und räumt `storage.sync` danach auf

**Chrome-spezifische Anpassungen gegenüber Firefox:**
- Alle `browser.*` durch `chrome.*` ersetzt
- `FileReader` (nicht in SW verfügbar) durch `arrayBuffer()`-basiertes Base64-Encoding ersetzt
- `contextMenus.removeAll()` mit Callback statt `.then()`

### options.html — Einstellungs-UI
Öffnet sich als Tab (`open_in_tab: true`). Enthält:
- Nextcloud-URL-Eingabe
- "Login with Nextcloud"-Button (Nextcloud Login Flow v2 / OAuth-ähnlich) — einziger Weg, Credentials zu setzen
- Logout-Button ("Verbindung trennen"), nur aktiv wenn Credentials vorhanden sind
- Link zu Nextcloud Security Settings
- Status-Meldungszeile (success / error / info)

### options.js — Einstellungs-Logik
**Wichtige Funktionen:**
- `loadSettings()` — liest `chrome.storage.local`; steuert Sichtbarkeit des Logout-Buttons
- `startLoginFlow()` / `cancelLoginFlow()` — Nextcloud Login Flow v2: POST zum Initieren, Polling alle 2 s, automatisches Befüllen und Tab-Schließen nach Erfolg; Credentials landen in `chrome.storage.local`
- `logout()` — löscht `nextcloudUrl`/`username`/`appPassword` aus `chrome.storage.local`, setzt UI zurück

**Hinweis:** `localStorage` ist in Extension-Pages (options.html) verfügbar — anders als im Service Worker.

## Chrome-Extension laden (Entwicklung)
1. `chrome://extensions` öffnen
2. "Entwicklermodus" aktivieren
3. "Entpackte Erweiterung laden" → dieses Verzeichnis wählen

## Abgrenzung zu merlin-firefox
| | Firefox | Chrome |
|---|---|---|
| Namespace | `browser.*` | `chrome.*` |
| Background | `background.scripts` | `background.service_worker` |
| Logo-Encoding | `FileReader` | `arrayBuffer()` + `btoa()` |
| Gecko-Settings | `browser_specific_settings` | — (entfernt) |

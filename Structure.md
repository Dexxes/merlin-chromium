# merlin-chrome – Structure

Chrome/Edge-Erweiterung (Manifest V3) zum Speichern von Links und Seiten in Merlin
(Nextcloud-App oder merlin-server). Funktional auf dem Stand von `merlin-firefox`;
Abweichungen nur dort, wo Chrome es verlangt (siehe unten).

## Lokalisierung (DE/EN)
Alle UI-Strings kommen aus `chrome.i18n` (`_locales/<lang>/messages.json`,
`default_locale: "en"`). Die `messages.json` werden aus
[`merlin-translations`](https://github.com/Dexxes/merlin-translations) generiert
(`webext.*`-Namespace, `python3 export.py --platform webext`) — NIE direkt editieren.
`manifest.json` nutzt `__MSG_extName__` / `__MSG_extDescription__` /
`__MSG_actionTitle__`; statische HTML-Texte über `data-i18n`-Attribute (`i18n.js`),
JS-Strings über `t(key, subs)` aus `common.js`.

## Dateien

### manifest.json
- `background.service_worker: background.js` (MV3), `minimum_chrome_version: 110`
- Permissions: `contextMenus`, `notifications`, `scripting`, `storage`, `activeTab`, `alarms`
  — kein `tabs` (activeTab reicht für die Tab-URL beim Kontextmenü-Klick)
- `optional_host_permissions: ["<all_urls>"]` — zur Laufzeit wird nur die Origin des
  konfigurierten Servers angefragt
- Kein `browser_specific_settings` (Gecko-spezifisch)

### crypto.js
AES-GCM mit PBKDF2-Schlüssel aus einer Passphrase. Verschlüsselt die optionale
Sync-Kopie der Zugangsdaten (`credEnc` in `storage.sync`); die Passphrase
(`encPassphrase`) liegt nur in `storage.local`.

### common.js — gemeinsame Helfer (Service Worker + Seiten)
- `t()`, `sleep()`, `isAllowedServerUrl()` (https, http nur für localhost),
  `sameOrigin()`, `originPatternFor()`, `tagsEndpoint()`, `normalizeTagList()`
- `getCredentials()` / `setCredentials()` / `clearCredentials()` — Klartext in
  `storage.local`; `setCredentials()` aktualisiert `credEnc`, wenn Sync aktiv ist
- `recordAuthFailure()` — erst der zweite 401 in Folge löscht die Zugangsdaten
- `showNotification()` — Titel immer „Merlin“

### background.js — Service Worker
Lädt `crypto.js` und `common.js` per `importScripts()`.
- Kontextmenü (4 Einträge: Link/Seite, jeweils mit und ohne Schlagworte), nur in `onInstalled`
- `saveToMerlin()` — POST an `/index.php/apps/merlin/api/v1/add` (Nextcloud, Tags als Namen)
  bzw. `/api/articles` (merlin-server, Tags als IDs über `resolveTagIdsStandalone()`);
  60 s Timeout, HTML bis 10 MB, `unsupported_site`-Fehler
- Schlagwort-Dialog: `_merlinPendingSave_<id>`-Einträge ohne Zugangsdaten, Popup per
  `chrome.windows.create`, zentriert über dem Browserfenster (`centeredPosition()`),
  Aufräumen über `windows.onRemoved`
- Login Flow v2: Polling alle 2 s im Service Worker, Zustand in `_merlinLoginFlow`,
  `chrome.alarms` (30 s) setzt nach Beenden des Workers fort; Ergebnis über
  `_merlinLoginFlowResult` an die Optionsseite
- `renderFlyout()` — Toast in geschlossener Shadow Root; Fallback auf Notification

### options.html / options.js — Einstellungen (auch Toolbar-Popup)
- Backend-Wahl, URL-Feld mit `https://`-Vorbelegung, Login-Button (Login Flow v2)
- Verbindung testen (nur gespeicherte URL), Verbindung trennen
- Link auf die App-Passwort-Einstellungen des Servers
- Verschlüsselter Sync (opt-in): Passphrase setzen/ändern, synchronisierten Login auf
  neuem Gerät entsperren
- Liest ein Login-Ergebnis auch beim Laden, falls der Login ohne offene Seite endete

### save-dialog.html / save-dialog.js — Schlagwort-Dialog
Identisch mit Firefox (nur `chrome.*`): Schlagwort-Baum, Filter beim Tippen,
Eltern/Kind-Auswahlregeln.

### tests/, tools/, .github/
- `npm test` — `tests/background.test.js` (Service Worker in Node-VM mit Fake-`chrome`),
  `tests/pages.test.js` (Seiten in headless Chromium), `tests/static.test.js`
  (Icon-Größen, Übersetzungen, Build-Dateiliste)
- `tools/build-zip.ps1` — Chrome-Web-Store-ZIP nach `build/`
- `.github/workflows/test.yml` — Tests bei Push/PR

## Chrome-Erweiterung laden (Entwicklung)
1. `chrome://extensions` öffnen
2. „Entwicklermodus“ aktivieren
3. „Entpackte Erweiterung laden“ → dieses Verzeichnis wählen

## Abgrenzung zu merlin-firefox
| | Firefox | Chrome |
|---|---|---|
| Namespace | `browser.*` | `chrome.*` |
| Background | `background.scripts` (Event-Page) | `background.service_worker` + `importScripts()` |
| Zugangsdaten | `storage.sync` (Firefox Sync ist E2E-verschlüsselt) | `storage.local`; Sync nur verschlüsselt per Passphrase (opt-in) |
| Logo-Encoding | `FileReader` | `arrayBuffer()` + `btoa()` |
| Dialog-Zentrierung | Bildschirm (`screen`) bzw. Browserfenster | Browserfenster (kein `screen` im Service Worker) |
| Verbindungstest | — | ja (wie Thunderbird) |
| Manifest | `browser_specific_settings`, `data_collection_permissions` | `minimum_chrome_version` |

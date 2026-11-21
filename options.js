'use strict';

// ─── DOM helpers ──────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

// i18n-Kürzel: liest lokalisierte Strings aus _locales/<lang>/messages.json
// (generiert via tools/i18n/export.py). `subs` mappt auf die $1/$2-Platzhalter.
const t = (key, subs) => chrome.i18n.getMessage(key, subs);

// ─── Nextcloud URL — HTTPS erzwungen ────────────────────────────────────────
//
// Das Eingabefeld zeigt nur noch den Host/Pfad an; "https://" steht als
// fixes Präfix davor (siehe options.html, .url-prefix) und ist dem Nutzer so
// sichtbar fest vorgegeben. Falls trotzdem ein Schema mitgetippt oder
// eingefügt wird (z. B. per Copy-Paste einer vollen URL), wird es hier
// abgeschnitten statt zu einem doppelten oder http-Schema zu führen.
function stripProtocol(value) {
  return (value || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

function getFullNextcloudUrl() {
  const cleaned = stripProtocol($('nextcloudUrl').value);
  return cleaned ? `https://${cleaned}` : '';
}

function setNextcloudUrlInput(fullUrl) {
  $('nextcloudUrl').value = stripProtocol(fullUrl);
}

// ─── Runtime host permission for the user's Nextcloud server ─────────────────
//
// host_permissions ist nur noch optional (manifest.json) statt pauschal
// <all_urls> — die Erweiterung fragt stattdessen genau die Origin an, die der
// Nutzer als Nextcloud-Server konfiguriert. Das funktioniert hier, weil der
// Request innerhalb eines Button-Klicks (User-Geste) ausgelöst wird.
function originPatternFor(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/*`;
  } catch {
    return null;
  }
}

async function ensureHostPermission(url) {
  const origin = originPatternFor(url);
  if (!origin) return false;
  if (await chrome.permissions.contains({ origins: [origin] })) return true;
  return chrome.permissions.request({ origins: [origin] });
}

function showCloseButton() {
  const existing = $('closeTabBtn');
  if (existing) { existing.style.display = 'inline-flex'; return; }

  const btn = document.createElement('button');
  btn.id        = 'closeTabBtn';
  btn.className = 'btn btn-close-tab';
  btn.textContent = t('options_closeTab');
  btn.addEventListener('click', () => window.close());
  $('status').appendChild(btn);
}

function showStatus(message, type /* 'success' | 'error' | 'info' */, durationMs = 5000) {
  const wrap = $('status');
  const icon = $('statusIcon');
  const text = $('statusText');

  const icons = { success: '✓', error: '✕', info: '…' };

  icon.textContent = icons[type] ?? '•';
  text.textContent = message;
  wrap.className   = `status visible ${type}`;

  clearTimeout(showStatus._timer);
  if (durationMs > 0) {
    showStatus._timer = setTimeout(() => { wrap.className = 'status'; }, durationMs);
  }
}

// ─── Nextcloud Login Flow v2 ──────────────────────────────────────────────────
//
// The options page handles:
//   1. POST {nextcloudUrl}/index.php/login/v2  →  { login, poll: { token, endpoint } }
//   2. Open the `login` URL in a new tab
//   3. Hand off polling to the background service worker — it survives the
//      toolbar popup closing when the new login tab takes focus, and survives
//      the MV3 service worker itself being terminated (chrome.alarms wakes it
//      back up; see background.js)
//   4. React to the result written to storage by the background script
//
// The button doubles as a cancel button while a flow is in progress.

let _lfActive = false;

function _lfReset() {
  _lfActive = false;
  $('loginFlowBtn').querySelector('span').textContent = t('options_loginButton');
}

function cancelLoginFlow() {
  if (!_lfActive) return;
  _lfReset();
  chrome.runtime.sendMessage({ type: 'merlin:cancelLoginPoll' }).catch(() => {});
  showStatus(t('options_loginCancelled'), 'info');
}

function selectedBackendKind() {
  return document.querySelector('input[name="backendKind"]:checked')?.value || 'nextcloud';
}

async function startLoginFlow() {
  // Toggle: clicking the button again cancels an in-progress flow
  if (_lfActive) { cancelLoginFlow(); return; }

  const url = getFullNextcloudUrl();
  if (!url) {
    showStatus(t('options_enterUrlFirst'), 'error');
    $('nextcloudUrl').focus();
    return;
  }

  const backendKind = selectedBackendKind();

  _lfActive = true;
  $('loginFlowBtn').querySelector('span').textContent = t('options_cancelLogin');
  showStatus(t('options_connecting'), 'info', 0);

  // ── Step 0: request access to this specific server only ────────────────────
  if (!(await ensureHostPermission(url))) {
    _lfReset();
    showStatus(t('options_needsPermission'), 'error');
    return;
  }

  // ── Step 1: initiate ────────────────────────────────────────────────────────
  // merlin-server bildet Nextclouds Login-Flow-v2-JSON identisch nach (siehe
  // merlin-server/src/Controller/LoginFlowController.php) - nur die Start-URL
  // unterscheidet sich, Polling/Parsing bleibt unverändert.
  let loginUrl, pollToken, pollEndpoint;
  try {
    const loginFlowPath = backendKind === 'standalone' ? '/login/v2' : '/index.php/login/v2';
    const r = await fetch(`${url}${loginFlowPath}`, {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    loginUrl     = d.login;
    pollToken    = d.poll.token;
    pollEndpoint = d.poll.endpoint;
  } catch (e) {
    _lfReset();
    showStatus(t('options_cannotReach', [e.message]), 'error');
    return;
  }
  if (!_lfActive) return;

  // ── Step 2: open login tab ───────────────────────────────────────────────────
  let loginTabId = null;
  try {
    const tab = await chrome.tabs.create({ url: loginUrl });
    loginTabId = tab.id;
  } catch (e) {
    _lfReset();
    showStatus(t('options_cannotOpenLogin', [e.message]), 'error');
    return;
  }
  showStatus(t('options_completeLogin'), 'info', 0);

  // ── Step 3: hand polling off to the background service worker ─────────────
  try {
    await chrome.runtime.sendMessage({
      type:         'merlin:startLoginPoll',
      pollEndpoint,
      pollToken,
      serverUrl:    url,
      loginTabId,
      backendKind,
    });
  } catch (e) {
    _lfReset();
    showStatus(t('options_cannotStartPolling', [e.message]), 'error');
  }
}

// ── Step 4: react to background result ────────────────────────────────────────

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes._merlinLoginFlowResult) return;

  const result = changes._merlinLoginFlowResult.newValue;
  if (!result) return;

  // Clean up immediately so stale results don't fire on next open
  chrome.storage.local.remove('_merlinLoginFlowResult').catch(() => {});

  _lfReset();

  if (result.cancelled) return;

  if (result.error) {
    showStatus(result.error, 'error');
    return;
  }

  if (result.success) {
    setNextcloudUrlInput(result.serverUrl);
    showStatus(t('options_loggedInAs', [result.loginName]), 'success', 0);
    showCloseButton();
    updateLogoutButtonState(true);
    updateTestButton(true);
    refreshPassphraseUI();
  }
});

// ─── Load saved settings ──────────────────────────────────────────────────────

async function loadSettings() {
  // storage.local statt storage.sync: Credentials sollen das Gerät nicht verlassen.
  const { nextcloudUrl, username, appPassword, backendKind } =
    await chrome.storage.local.get(['nextcloudUrl', 'username', 'appPassword', 'backendKind']);

  if (nextcloudUrl) setNextcloudUrlInput(nextcloudUrl);
  const radio = document.querySelector(`input[name="backendKind"][value="${backendKind === 'standalone' ? 'standalone' : 'nextcloud'}"]`);
  if (radio) radio.checked = true;

  const connected = !!(nextcloudUrl && username && appPassword);
  updateLogoutButtonState(connected);
  updateTestButton(connected);
  await refreshPassphraseUI();

  // Show welcome hint when the page is opened and no credentials are stored yet
  if (!nextcloudUrl && !username && !appPassword) {
    showStatus(t('options_welcome'), 'info', 0);
  }

  // Restore in-progress UI state if the background is still polling
  const { _merlinLoginFlow } = await chrome.storage.local.get('_merlinLoginFlow');
  if (_merlinLoginFlow?.active) {
    _lfActive = true;
    $('loginFlowBtn').querySelector('span').textContent = t('options_cancelLogin');
    showStatus(t('options_completeLogin'), 'info', 0);
  }
}

// ─── Logout ───────────────────────────────────────────────────────────────────

function updateLogoutButtonState(hasCredentials) {
  $('logoutBtn').disabled = !hasCredentials;
}

// "Test connection" ergibt ohne gespeicherte Credentials keinen Sinn (der Klick
// würde sofort mit "Please log in with Nextcloud first." fehlschlagen) — daher
// bleibt der Button gesperrt, bis ein Login-Versuch erfolgreich war.
function updateTestButton(connected) {
  const btn = $('testBtn');
  if (!btn) return;
  btn.disabled = !connected;
}

async function logout() {
  // Login Flow v2 ist der einzige Weg, Credentials zu setzen — Logout muss
  // daher konsequent storage.local leeren, nicht nur die Formularfelder.
  await chrome.storage.local.remove(['nextcloudUrl', 'username', 'appPassword', 'encPassphrase']);
  // Verschlüsselte Kopie ebenfalls aus storage.sync entfernen — ohne lokale
  // Credentials/Passphrase ist sie ohnehin nur noch Datenmüll.
  try { await chrome.storage.sync.remove('credEnc'); } catch { /* sync evtl. nicht verfügbar */ }
  setNextcloudUrlInput('');
  updateLogoutButtonState(false);
  updateTestButton(false);
  showStatus(t('options_loggedOut'), 'info');
  await refreshPassphraseUI();
}

// ─── Encrypted sync ───────────────────────────────────────────────────────────
//
// storage.sync enthält nur noch `credEnc` (AES-GCM-Chiffretext der drei
// Credential-Felder). Der Schlüssel kommt aus `encPassphrase`, die ausschließlich
// in storage.local liegt — sie wird nie synchronisiert. Ohne sie ist `credEnc`
// für Google wertlos. Sync ist daher bewusst opt-in: ohne gesetzte Passphrase
// bleiben Credentials wie bisher rein lokal (storage.local).

async function refreshPassphraseUI() {
  const { encPassphrase, nextcloudUrl, username, appPassword } =
    await chrome.storage.local.get(['encPassphrase', 'nextcloudUrl', 'username', 'appPassword']);

  let credEnc = null;
  try {
    credEnc = (await chrome.storage.sync.get('credEnc')).credEnc ?? null;
  } catch { /* storage.sync evtl. nicht verfügbar */ }

  const hasLocalCreds = Boolean(nextcloudUrl && username && appPassword);
  const hasPassphrase = Boolean(encPassphrase);

  const section = $('passphraseSection');
  const input   = $('passphraseInput');
  const btn     = $('passphraseBtn');
  const hint    = $('passphraseHint');
  if (!section || !input || !btn || !hint) return;

  input.value = '';

  if (!hasLocalCreds && credEnc) {
    section.style.display = 'block';
    btn.querySelector('span').textContent = t('passphrase_unlockButton');
    hint.textContent = t('passphrase_unlockHint');
    btn.onclick = unlockFromSync;
  } else if (hasLocalCreds && !hasPassphrase) {
    section.style.display = 'block';
    btn.querySelector('span').textContent = t('passphrase_enableButton');
    hint.textContent = t('passphrase_enableHint');
    btn.onclick = setPassphrase;
  } else if (hasLocalCreds && hasPassphrase) {
    section.style.display = 'block';
    input.placeholder = t('passphrase_setPlaceholder');
    btn.querySelector('span').textContent = t('passphrase_changeButton');
    hint.textContent = t('passphrase_activeHint');
    btn.onclick = setPassphrase;
  } else {
    section.style.display = 'none';
  }
}

async function setPassphrase() {
  const passphrase = $('passphraseInput').value;
  if (!passphrase || passphrase.length < 8) {
    showStatus(t('passphrase_tooShort'), 'error');
    return;
  }
  const { nextcloudUrl, username, appPassword, backendKind } =
    await chrome.storage.local.get(['nextcloudUrl', 'username', 'appPassword', 'backendKind']);
  if (!nextcloudUrl || !username || !appPassword) {
    showStatus(t('passphrase_loginFirst'), 'error');
    return;
  }

  try {
    const encBlob = await merlinEncryptCredentials(passphrase, { nextcloudUrl, username, appPassword, backendKind });
    await chrome.storage.local.set({ encPassphrase: passphrase });
    await chrome.storage.sync.set({ credEnc: encBlob });
    showStatus(t('passphrase_enabled'), 'success');
  } catch (e) {
    showStatus(t('passphrase_enableError', [e.message]), 'error');
    return;
  }
  await refreshPassphraseUI();
}

async function unlockFromSync() {
  const passphrase = $('passphraseInput').value;
  if (!passphrase) {
    showStatus(t('passphrase_enterPassphrase'), 'error');
    return;
  }

  let credEnc;
  try {
    credEnc = (await chrome.storage.sync.get('credEnc')).credEnc;
  } catch (e) {
    showStatus(t('passphrase_syncUnavailable', [e.message]), 'error');
    return;
  }
  if (!credEnc) {
    showStatus(t('passphrase_noSyncedLogin'), 'error');
    return;
  }

  try {
    const creds = await merlinDecryptCredentials(passphrase, credEnc);
    if (!(await ensureHostPermission(creds.nextcloudUrl))) {
      showStatus(t('options_needsPermission'), 'error');
      return;
    }
    await chrome.storage.local.set({ ...creds, encPassphrase: passphrase });
    setNextcloudUrlInput(creds.nextcloudUrl);
    const radio = document.querySelector(`input[name="backendKind"][value="${creds.backendKind === 'standalone' ? 'standalone' : 'nextcloud'}"]`);
    if (radio) radio.checked = true;
    showStatus(t('passphrase_unlockedAs', [creds.username]), 'success');
    updateLogoutButtonState(true);
    updateTestButton(true);
  } catch {
    // AES-GCM schlägt bei falschem Schlüssel kontrolliert fehl (Auth-Tag-Mismatch).
    showStatus(t('passphrase_wrongPassphrase'), 'error');
    return;
  }
  await refreshPassphraseUI();
}

// ─── Test connection ──────────────────────────────────────────────────────────

async function testConnection() {
  const url = getFullNextcloudUrl();

  // Credentials liegen hier unverschlüsselt in storage.local (anders als bei
  // Thunderbird mit credEnc) — kommen aber ebenso ausschließlich aus dem
  // Login Flow, nicht aus manuellen Feldern.
  const { username, appPassword, backendKind } =
    await chrome.storage.local.get(['username', 'appPassword', 'backendKind']);

  if (!url || !username || !appPassword) {
    showStatus(t('options_loginFirst'), 'error');
    return;
  }

  const btn = $('testBtn');
  btn.disabled = true;
  btn.querySelector('span').textContent = t('options_testing');
  showStatus(t('options_connectingShort'), 'info', 0);

  try {
    // merlin-server hat keine Pocket-kompatible /api/v1/get - stattdessen
    // ein leichter, bereits authentifizierter GET-Call (gleiche Vereinfachung
    // wie iOS' MerlinAPI.testConnection()/Androids SettingsViewModel.testConnection()).
    const creds = btoa(`${username}:${appPassword}`);
    const resp = backendKind === 'standalone'
      ? await fetch(`${url}/api/articles/counts`, {
          method:  'GET',
          headers: { 'Authorization': `Basic ${creds}` },
          signal:  AbortSignal.timeout(10_000),
        })
      : await fetch(`${url}/index.php/apps/merlin/api/v1/get`, {
          method:  'POST',
          headers: {
            'Authorization': `Basic ${creds}`,
            'Content-Type':  'application/json',
          },
          body:   JSON.stringify({ state: 'all', count: 1 }),
          signal: AbortSignal.timeout(10_000),
        });

    if (resp.ok) {
      showStatus(t('options_testSuccess'), 'success');
    } else if (resp.status === 401) {
      showStatus(t('options_testAuthFailed'), 'error');
    } else if (resp.status === 404) {
      showStatus(t('options_testNotFound'), 'error');
    } else {
      showStatus(t('options_testServerError', [String(resp.status)]), 'error');
    }
  } catch (e) {
    if (e.name === 'TimeoutError') {
      showStatus(t('options_testTimeout'), 'error');
    } else {
      showStatus(t('options_testFailed', [e.message]), 'error');
    }
  } finally {
    btn.disabled = false;
    btn.querySelector('span').textContent = t('options_testButton');
  }
}

// ─── Open Nextcloud security settings ────────────────────────────────────────

function openSecurityPage(e) {
  e.preventDefault();
  const url = getFullNextcloudUrl();
  if (!url) {
    showStatus(t('options_securityEnterUrl'), 'info');
    return;
  }
  // merlin-server verwaltet API-Tokens unter /account statt Nextclouds
  // Sicherheitseinstellungen - Tokens werden dort ohnehin nur für den
  // Login-Flow-Klon gebraucht, ein direkter Link ist trotzdem hilfreich
  // (z.B. um ein Token zu widerrufen).
  const path = selectedBackendKind() === 'standalone' ? '/account' : '/index.php/settings/user/security';
  window.open(`${url}${path}`, '_blank');
}

// ─── Wire everything up ───────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  loadSettings();

  $('loginFlowBtn').addEventListener('click', startLoginFlow);
  $('testBtn').addEventListener('click', testConnection);
  $('logoutBtn').addEventListener('click', logout);
  $('openSecurityLink').addEventListener('click', openSecurityPage);
});

'use strict';

// ─── DOM helpers ──────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

// t, getCredentials, clearCredentials, originPatternFor, sameOrigin,
// serverBase, basicAuthHeader, isAllowedServerUrl and CREDENTIAL_KEYS come
// from common.js; merlinEncryptCredentials/merlinDecryptCredentials from
// crypto.js.

// ─── Server URL field ─────────────────────────────────────────────────────────

// An empty URL field starts with this prefix so the user only has to type
// the host name.
const URL_PREFIX = 'https://';

// Cleans up what the user typed or pasted into the URL field:
// - a URL pasted behind the prefilled "https://" ("https://https://…") keeps
//   only the pasted scheme,
// - the bare prefix counts as empty,
// - a host name without a scheme gets "https://" in front.
function normalizeUrlInput(raw) {
  let v = raw.trim().replace(/^https?:\/\/(?=[a-z][a-z0-9+.-]*:\/\/)/i, '');
  if (/^https?:\/\/$/i.test(v)) return '';
  if (v && !/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) v = URL_PREFIX + v;
  return v;
}

// The URL as typed, normalized, trimmed and without a trailing slash.
function readServerUrl() {
  return serverBase(normalizeUrlInput($('nextcloudUrl').value));
}

// Puts the "https://" prefix into an empty URL field.
function prefillUrlField(url) {
  $('nextcloudUrl').value = url || URL_PREFIX;
}

// A pasted full URL replaces the prefilled prefix instead of being appended.
function onUrlInput(e) {
  const field = e.target;
  const fixed = field.value.replace(/^https?:\/\/(?=[a-z][a-z0-9+.-]*:\/\/)/i, '');
  if (fixed !== field.value) field.value = fixed;
}

// Focusing the field with only the prefix puts the cursor behind it.
function onUrlFocus(e) {
  const field = e.target;
  if (field.value === URL_PREFIX) {
    requestAnimationFrame(() => field.setSelectionRange(URL_PREFIX.length, URL_PREFIX.length));
  }
}

// ─── Runtime host permission for the user's server ───────────────────────────
//
// host_permissions are only optional (manifest.json) instead of a standing
// <all_urls> grant — the extension requests exactly the origin the user
// configures as their server. Without it, fetch() from the extension pages
// and the service worker is subject to CORS. This works here because the
// request is made from within a button click (user gesture).

async function ensureHostPermission(url) {
  const origin = originPatternFor(url);
  if (!origin) return false;
  // No permissions.contains() pre-check: request() resolves immediately
  // without a prompt when the permission is already granted, and every await
  // before it eats into the click's user gesture, which request() needs.
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
//   3. Hand off polling to the service worker — it survives the toolbar popup
//      closing when the new login tab takes focus (see background.js)
//   4. React to the result written to storage by the background script
//
// The button doubles as a cancel button while a flow is in progress.

let _lfActive = false;  // UI-only guard (background tracks the real state)

function selectedBackendKind() {
  return document.querySelector('input[name="backendKind"]:checked')?.value || 'nextcloud';
}

// "Login with Nextcloud" only makes sense for the Nextcloud backend — the
// standalone server has no Nextcloud account behind it, so it gets a neutral label.
function loginButtonLabel() {
  return backendText('options_loginButton', 'options_loginButtonStandalone');
}

// Several hints name the "Login with Nextcloud" button; the standalone
// backend has its own wording with the neutral "Log in" button.
function backendText(nextcloudKey, standaloneKey) {
  return t(selectedBackendKind() === 'standalone' ? standaloneKey : nextcloudKey);
}

function setLoginButtonText(text) {
  $('loginFlowBtn').querySelector('span').textContent = text;
}

function updateLoginButtonLabel() {
  if (_lfActive) return; // don't clobber the "Cancel login…" label mid-flow
  setLoginButtonText(loginButtonLabel());
}

// Marks a login flow as running (button becomes "Cancel login…") or as idle.
function setLoginFlowActive(active) {
  _lfActive = active;
  setLoginButtonText(active ? t('options_cancelLogin') : loginButtonLabel());
}

function _lfReset() {
  setLoginFlowActive(false);
}

function cancelLoginFlow() {
  if (!_lfActive) return;
  _lfReset();
  chrome.runtime.sendMessage({ type: 'merlin:cancelLoginPoll' }).catch(() => {});
  showStatus(t('options_loginCancelled'), 'info');
}

async function startLoginFlow() {
  // Toggle: clicking the button again cancels an in-progress flow
  if (_lfActive) { cancelLoginFlow(); return; }

  const url = readServerUrl();
  if (!url) {
    showStatus(t('options_enterUrlFirst'), 'error');
    $('nextcloudUrl').focus();
    return;
  }

  // Plain http:// only for localhost (local development). The check is
  // synchronous, so it does not break the user gesture.
  if (!isAllowedServerUrl(url)) {
    showStatus(t('options_httpBlocked'), 'error');
    $('nextcloudUrl').focus();
    return;
  }

  const backendKind = selectedBackendKind();

  setLoginFlowActive(true);
  showStatus(backendText('options_connecting', 'options_connectingShort'), 'info', 0);

  // ── Step 0: request access to this specific server only ────────────────────
  if (!(await ensureHostPermission(url))) {
    _lfReset();
    showStatus(t('options_needsPermission'), 'error');
    return;
  }

  // ── Step 1: initiate ────────────────────────────────────────────────────────
  // merlin-server mirrors Nextcloud's Login Flow v2 JSON exactly (see
  // merlin-server/src/Controller/LoginFlowController.php) — only the start
  // URL differs, polling and parsing stay the same.
  let loginUrl, pollToken, pollEndpoint;
  try {
    const loginFlowPath = backendKind === 'standalone' ? '/login/v2' : '/index.php/login/v2';
    const r = await fetch(`${url}${loginFlowPath}`, {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    loginUrl     = d?.login;
    pollToken    = d?.poll?.token;
    pollEndpoint = d?.poll?.endpoint;
  } catch (e) {
    _lfReset();
    showStatus(t('options_cannotReach', [e.message]), 'error');
    return;
  }
  if (!_lfActive) return;

  // Validate the response: the login page must be encrypted (or localhost),
  // and the poll token may only go back to the server the user entered —
  // the poll response carries the new app password.
  if (typeof pollToken !== 'string' || !pollToken
      || !isAllowedServerUrl(loginUrl)
      || !isAllowedServerUrl(pollEndpoint) || !sameOrigin(pollEndpoint, url)) {
    _lfReset();
    showStatus(t('options_loginInvalidResponse'), 'error');
    return;
  }

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

  // ── Step 3: hand polling off to the background script ─────────────────────
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
//
// Usually the toolbar popup that started the login has closed by the time the
// service worker finishes, and the worker reopens the options page only after
// writing the result. So the result is picked up in two ways: live via
// storage.onChanged while a page is open, and on load (loadSettings).

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes._merlinLoginFlowResult) return;
  handleLoginFlowResult(changes._merlinLoginFlowResult.newValue);
});

function handleLoginFlowResult(result) {
  if (!result) return;

  // Clean up immediately so stale results don't fire on next open
  chrome.storage.local.remove('_merlinLoginFlowResult').catch(() => {});

  _lfReset();

  if (result.cancelled) {
    return;
  }

  if (result.error) {
    showStatus(result.error, 'error');
    return;
  }

  if (result.success) {
    prefillUrlField(result.serverUrl);
    showStatus(t('options_loggedInAs', [result.loginName]), 'success', 0);
    showCloseButton();
    updateLogoutButton(true);
    updateTestButton(true);
    refreshPassphraseUI();
  }
}

// ─── Logout ────────────────────────────────────────────────────────────────────
//
// Removes the stored credentials and resets the UI to "not connected". The
// URL stays in the field; only the credentials are deleted.

function updateLogoutButton(connected) {
  const btn = $('logoutBtn');
  if (!btn) return;
  btn.disabled = !connected;
  btn.style.display = connected ? 'inline-flex' : 'none';
}

// "Test connection" makes no sense without stored credentials (the click
// would fail right away with "Please log in first."), so the button stays
// disabled until a login succeeded.
function updateTestButton(connected) {
  const btn = $('testBtn');
  if (!btn) return;
  btn.disabled = !connected;
}

async function logout() {
  await clearCredentials();
  updateLogoutButton(false);
  updateTestButton(false);
  showStatus(t('options_disconnected'), 'info');
  await refreshPassphraseUI();
}

// ─── Load saved settings ──────────────────────────────────────────────────────

async function loadSettings() {
  const { nextcloudUrl, username, appPassword, backendKind } = await getCredentials();

  prefillUrlField(nextcloudUrl);
  const radio = document.querySelector(`input[name="backendKind"][value="${backendKind === 'standalone' ? 'standalone' : 'nextcloud'}"]`);
  if (radio) radio.checked = true;
  updateLoginButtonLabel();
  const connected = Boolean(nextcloudUrl && username && appPassword);
  updateLogoutButton(connected);
  updateTestButton(connected);
  await refreshPassphraseUI();

  // Restore in-progress UI state if the background is still polling
  const { _merlinLoginFlow } = await chrome.storage.local.get('_merlinLoginFlow');
  // An expired flow (e.g. because Chrome stopped the service worker) no
  // longer counts as active; the service worker cleans it up on its next
  // alarm.
  if (_merlinLoginFlow?.active && Date.now() <= (_merlinLoginFlow.deadline ?? 0)) {
    setLoginFlowActive(true);
    showStatus(t('options_completeLogin'), 'info', 0);
    return;
  }

  // A login that finished while no options page was open
  const { _merlinLoginFlowResult } = await chrome.storage.local.get('_merlinLoginFlowResult');
  if (_merlinLoginFlowResult) {
    handleLoginFlowResult(_merlinLoginFlowResult);
    if (!_merlinLoginFlowResult.cancelled) return;
  }

  // Show welcome hint when no URL is stored yet
  if (!nextcloudUrl) {
    showStatus(backendText('options_welcome', 'options_welcomeStandalone'), 'info', 0);
  }
}

// Keeps a visible welcome hint in line with the selected backend, since it
// names that backend's login button.
function refreshWelcomeText() {
  const current = $('statusText').textContent;
  if (current === t('options_welcome') || current === t('options_welcomeStandalone')) {
    $('statusText').textContent = backendText('options_welcome', 'options_welcomeStandalone');
  }
}

// ─── Test connection ──────────────────────────────────────────────────────────

async function testConnection() {
  // Test exactly what the extension will use: the stored URL, backend and
  // credentials (they come from the login flow). The app password must never
  // go to a URL that was only typed into the field afterwards.
  const { nextcloudUrl: url, username, appPassword, backendKind } = await getCredentials();

  if (!url || !username || !appPassword) {
    showStatus(t('options_loginFirst'), 'error');
    return;
  }

  if (readServerUrl() !== url || selectedBackendKind() !== (backendKind === 'standalone' ? 'standalone' : 'nextcloud')) {
    showStatus(t('options_urlChangedLoginAgain'), 'error');
    return;
  }

  if (!isAllowedServerUrl(url)) {
    showStatus(t('options_httpBlocked'), 'error');
    return;
  }

  const btn = $('testBtn');
  btn.disabled = true;
  btn.querySelector('span').textContent = t('options_testing');
  showStatus(t('options_connectingShort'), 'info', 0);

  try {
    // merlin-server has no Pocket-style /api/v1/get — a light authenticated
    // GET is used instead (same simplification as iOS'
    // MerlinAPI.testConnection() and Android's SettingsViewModel.testConnection()).
    const authHeader = basicAuthHeader(username, appPassword);
    const resp = backendKind === 'standalone'
      ? await fetch(`${url}/api/articles/counts`, {
          method:  'GET',
          headers: { 'Authorization': authHeader },
          signal:  AbortSignal.timeout(10_000),
        })
      : await fetch(`${url}/index.php/apps/merlin/api/v1/get`, {
          method:  'POST',
          headers: {
            'Authorization': authHeader,
            'Content-Type':  'application/json',
          },
          body:   JSON.stringify({ state: 'all', count: 1 }),
          signal: AbortSignal.timeout(10_000),
        });

    if (resp.ok) {
      showStatus(t('options_testSuccess'), 'success');
    } else if (resp.status === 401) {
      showStatus(backendText('options_testAuthFailed', 'options_testAuthFailedStandalone'), 'error');
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

// ─── Encrypted sync (opt-in) ──────────────────────────────────────────────────
//
// storage.sync only ever holds `credEnc`, the AES-GCM ciphertext of the
// credentials. Its key comes from `encPassphrase`, which lives in
// storage.local only and is never synced — without it, `credEnc` is worthless
// to the sync servers. Without a passphrase, credentials stay on this device.

function setPassphraseButton(labelKey, hintKey, onClick) {
  $('passphraseBtn').querySelector('span').textContent = t(labelKey);
  $('passphraseHint').textContent = t(hintKey);
  $('passphraseBtn').onclick = onClick;
}

async function refreshPassphraseUI() {
  const { encPassphrase, nextcloudUrl, username, appPassword } =
    await chrome.storage.local.get(['encPassphrase', 'nextcloudUrl', 'username', 'appPassword']);

  let credEnc = null;
  try {
    credEnc = (await chrome.storage.sync.get('credEnc')).credEnc ?? null;
  } catch { /* storage.sync may be unavailable */ }

  const hasLocalCreds = Boolean(nextcloudUrl && username && appPassword);
  const section = $('passphraseSection');
  const input   = $('passphraseInput');
  input.value = '';
  input.placeholder = t('passphrase_placeholder');
  section.style.display = 'block';

  if (!hasLocalCreds && credEnc) {
    setPassphraseButton('passphrase_unlockButton', 'passphrase_unlockHint', unlockFromSync);
  } else if (hasLocalCreds && !encPassphrase) {
    setPassphraseButton('passphrase_enableButton', 'passphrase_enableHint', setPassphrase);
  } else if (hasLocalCreds) {
    input.placeholder = t('passphrase_setPlaceholder');
    setPassphraseButton('passphrase_changeButton', 'passphrase_activeHint', setPassphrase);
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
  const creds = await getCredentials();
  if (!creds.nextcloudUrl || !creds.username || !creds.appPassword) {
    showStatus(t('passphrase_loginFirst'), 'error');
    return;
  }

  try {
    const credEnc = await merlinEncryptCredentials(passphrase, creds);
    await chrome.storage.sync.set({ credEnc });
    await chrome.storage.local.set({ encPassphrase: passphrase });
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

  let creds;
  try {
    creds = await merlinDecryptCredentials(passphrase, credEnc);
  } catch {
    // AES-GCM fails in a controlled way on a wrong key (auth tag mismatch).
    showStatus(t('passphrase_wrongPassphrase'), 'error');
    return;
  }

  // Only take the known fields, and only a URL this extension would accept
  // when logging in.
  const fields = Object.fromEntries(
    CREDENTIAL_KEYS.map(k => [k, creds?.[k]]).filter(([, v]) => typeof v === 'string'),
  );
  if (!fields.nextcloudUrl || !fields.username || !fields.appPassword) {
    showStatus(t('passphrase_wrongPassphrase'), 'error');
    return;
  }
  if (!isAllowedServerUrl(fields.nextcloudUrl)) {
    showStatus(t('options_httpBlocked'), 'error');
    return;
  }
  // Still within the click's user gesture: Chrome keeps it alive for a few
  // seconds, longer than the PBKDF2 key derivation above takes.
  if (!(await ensureHostPermission(fields.nextcloudUrl))) {
    showStatus(t('options_needsPermission'), 'error');
    return;
  }

  await chrome.storage.local.set({ ...fields, encPassphrase: passphrase });
  prefillUrlField(fields.nextcloudUrl);
  const radio = document.querySelector(`input[name="backendKind"][value="${fields.backendKind === 'standalone' ? 'standalone' : 'nextcloud'}"]`);
  if (radio) radio.checked = true;
  updateLoginButtonLabel();
  showStatus(t('passphrase_unlockedAs', [fields.username]), 'success');
  updateLogoutButton(true);
  updateTestButton(true);
  await refreshPassphraseUI();
}

// ─── Open the server's app password settings ─────────────────────────────────

function openSecurityPage(e) {
  e.preventDefault();
  const url = readServerUrl();
  if (!url || !isAllowedServerUrl(url)) {
    showStatus(t('options_securityEnterUrl'), 'info');
    return;
  }
  // merlin-server manages its API tokens under /account instead of
  // Nextcloud's security settings — useful e.g. to revoke a token.
  const path = selectedBackendKind() === 'standalone' ? '/account' : '/index.php/settings/user/security';
  window.open(`${url}${path}`, '_blank', 'noopener');
}

// ─── Wire everything up ───────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  loadSettings();

  $('loginFlowBtn').addEventListener('click', startLoginFlow);
  $('testBtn').addEventListener('click', testConnection);
  $('logoutBtn').addEventListener('click', logout);
  $('openSecurityLink').addEventListener('click', openSecurityPage);
  $('nextcloudUrl').addEventListener('input', onUrlInput);
  $('nextcloudUrl').addEventListener('focus', onUrlFocus);

  document.querySelectorAll('input[name="backendKind"]').forEach(radio => {
    radio.addEventListener('change', () => {
      updateLoginButtonLabel();
      refreshWelcomeText();
    });
  });
});

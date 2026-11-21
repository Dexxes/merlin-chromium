'use strict';

// ─── Shared helpers ───────────────────────────────────────────────────────────
//
// Loaded after crypto.js: by the service worker via importScripts() (see the
// top of background.js) and by options.html / save-dialog.html via <script>.
// Everything here is a plain global so the classic (non-module) scripts can
// use it.

// i18n shorthand: reads localized strings from _locales/<lang>/messages.json
// (generated from merlin-translations via export.py --platform webext).
// `subs` maps onto the $1/$2 placeholders of the message.
const t = (key, subs) => chrome.i18n.getMessage(key, subs);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Server URL checks ────────────────────────────────────────────────────────

function originPatternFor(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/*`;
  } catch {
    return null;
  }
}

function sameOrigin(a, b) {
  try { return new URL(a).origin === new URL(b).origin; } catch { return false; }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// Credentials, URLs and page content must only travel encrypted. Plain
// http:// is accepted solely for loopback addresses (local development),
// where nothing leaves the machine.
function isAllowedServerUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

// ─── Server API helpers ───────────────────────────────────────────────────────

function serverBase(url) {
  return url.replace(/\/+$/, '');
}

function basicAuthHeader(username, appPassword) {
  return `Basic ${btoa(`${username}:${appPassword}`)}`;
}

// The tag list lives under a different prefix per backend: the Nextcloud app
// serves it below /index.php/apps/merlin/api, merlin-server below /api.
function tagsEndpoint(url, backendKind) {
  const prefix = backendKind === 'standalone' ? '/api' : '/index.php/apps/merlin/api';
  return `${serverBase(url)}${prefix}/tags`;
}

// The tag API may answer with a bare array or wrap it in { tags } / { data }.
function normalizeTagList(data) {
  if (Array.isArray(data)) return data;
  return data?.tags ?? data?.data ?? [];
}

// Notifications always carry just "Merlin" as the title; the actual result
// goes into the text, so the title doesn't repeat it.
function showNotification(message) {
  return chrome.notifications.create({
    type:    'basic',
    iconUrl: chrome.runtime.getURL('icons/icon-48.png'),
    title:   t('notification_defaultTitle'),
    message,
  });
}

// ─── Credential storage ───────────────────────────────────────────────────────
//
// Credentials live in storage.local only. Unlike Firefox Sync, Chrome Sync
// offers no end-to-end encryption for storage.sync by default, so the app
// password must not travel through it in plain text. Syncing is opt-in: with
// a passphrase set on the options page (encPassphrase, local only), an
// AES-GCM copy of the credentials goes to storage.sync as `credEnc` (see
// crypto.js). setCredentials() keeps that copy current, e.g. after a new
// login.

const CREDENTIAL_KEYS = ['nextcloudUrl', 'username', 'appPassword', 'backendKind'];

async function getCredentials() {
  return chrome.storage.local.get(CREDENTIAL_KEYS);
}

async function setCredentials(fields) {
  await chrome.storage.local.set(fields);

  const { encPassphrase, ...creds } = await chrome.storage.local.get([...CREDENTIAL_KEYS, 'encPassphrase']);
  if (!encPassphrase || !creds.username || !creds.appPassword) return;
  try {
    await chrome.storage.sync.set({ credEnc: await merlinEncryptCredentials(encPassphrase, creds) });
  } catch { /* storage.sync may be unavailable — the local copy is what counts */ }
}

async function clearCredentials() {
  await chrome.storage.local.remove(['nextcloudUrl', 'username', 'appPassword', 'encPassphrase', '_merlinAuthFailures']);
  // The synced copy holds the same, now dead app password.
  try { await chrome.storage.sync.remove('credEnc'); } catch { /* storage.sync may be unavailable */ }
}

// ─── Auth failure handling ────────────────────────────────────────────────────
//
// A single HTTP 401 can have harmless causes (wrong backend type selected,
// a misconfigured reverse proxy, a short server hiccup). Clearing the
// credentials right away would force a new login for nothing, so they are
// only cleared after two consecutive 401s. Any successful request resets the
// counter.

const AUTH_FAILURE_LIMIT = 2;

// Returns true when the credentials were cleared.
async function recordAuthFailure() {
  const { _merlinAuthFailures = 0 } = await chrome.storage.local.get('_merlinAuthFailures');
  const count = _merlinAuthFailures + 1;
  if (count < AUTH_FAILURE_LIMIT) {
    await chrome.storage.local.set({ _merlinAuthFailures: count });
    return false;
  }
  await clearCredentials();
  await showNotification(t('saveDialog_authFailed'));
  return true;
}

async function resetAuthFailures() {
  await chrome.storage.local.remove('_merlinAuthFailures');
}

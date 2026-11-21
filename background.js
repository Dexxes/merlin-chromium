'use strict';

// A Manifest V3 service worker has exactly one entry file, so the shared
// helpers (t, sleep, credentials, URL checks, auth-failure handling, tag API
// helpers) are pulled in here. crypto.js comes first: setCredentials() in
// common.js keeps the optional encrypted sync copy current.
importScripts('crypto.js', 'common.js');

const MENU_ID_LINK      = 'merlin-send-link';
const MENU_ID_LINK_TAGS = 'merlin-send-link-tags';
const MENU_ID_PAGE      = 'merlin-save-page';
const MENU_ID_PAGE_TAGS = 'merlin-save-page-tags';

// Upper bound for the page HTML sent along with a page save. Larger pages
// (e.g. with embedded data: images) are saved by URL only, and the server
// fetches them itself.
const MAX_HTML_BYTES = 10 * 1024 * 1024;

// Request timeouts. Saving gets more time because it may upload up to
// 10 MB of HTML.
const SAVE_TIMEOUT_MS = 60_000;
const TAGS_TIMEOUT_MS = 10_000;

const PENDING_SAVE_PREFIX = '_merlinPendingSave_';
const LOGIN_POLL_ALARM    = 'merlin-login-poll';
const SAVE_DIALOG_SIZE    = { width: 460, height: 640 };

// ─── Logo as base64 data URL ──────────────────────────────────────────────────
// Pages block chrome-extension:// URLs via CSP, so we convert the icon once to
// an inline data URL and pass it as an argument into the injected function.

let _logoDataUrl = null;

async function getLogoDataUrl() {
  if (_logoDataUrl) return _logoDataUrl;
  try {
    // FileReader is not available in service workers — encode via arrayBuffer.
    const resp   = await fetch(chrome.runtime.getURL('icons/icon-128.png'));
    const bytes  = new Uint8Array(await resp.arrayBuffer());
    const binary = Array.from(bytes, b => String.fromCharCode(b)).join('');
    _logoDataUrl = `data:image/png;base64,${btoa(binary)}`;
  } catch {
    _logoDataUrl = ''; // no logo on error — flyout still works
  }
  return _logoDataUrl;
}

// ─── Migration: storage.sync → storage.local ─────────────────────────────────
//
// Version 1.0 briefly kept the app password in plain text in
// chrome.storage.sync, which Chrome Sync distributes without end-to-end
// encryption. Existing installs move it to storage.local once; afterwards
// storage.sync only ever holds the optional encrypted copy (credEnc).
async function migrateCredentialsToLocal() {
  try {
    const synced = await chrome.storage.sync.get(CREDENTIAL_KEYS);
    const toMigrate = Object.fromEntries(
      Object.entries(synced).filter(([, v]) => v !== undefined),
    );
    if (Object.keys(toMigrate).length === 0) return;
    await chrome.storage.local.set(toMigrate);
    await chrome.storage.sync.remove(CREDENTIAL_KEYS);
  } catch {
    // storage.sync may be unavailable — then there is nothing to migrate
  }
}

chrome.runtime.onInstalled.addListener(migrateCredentialsToLocal);

// ─── Login Flow polling ───────────────────────────────────────────────────────
//
// Polling runs here rather than on the options page: Chrome opens the options
// page from the toolbar as a popup, which closes as soon as the login tab
// takes focus and takes its JS context with it.
//
// The service worker itself may be stopped by Chrome after ~30 s without
// events. While polling, every round calls extension APIs, which keeps it
// alive; should it be stopped anyway, the full flow state lives in
// storage.local (_merlinLoginFlow) and an alarm wakes the worker every 30 s.
// If no poll is running in memory at that point, it resumes from the stored
// state; once the deadline has passed, the flow ends with a timeout message
// instead of hanging silently.

const LOGIN_FLOW_TIMEOUT_MS = 5 * 60 * 1000;
const LOGIN_POLL_INTERVAL_MS = 2000;

let _lfTimer  = null;
let _lfActive = false;

async function startBackgroundLoginPoll({ pollEndpoint, pollToken, serverUrl, loginTabId, backendKind }) {
  _lfStopTimer();

  // The poll token (and the response carrying the app password) may only be
  // exchanged with the server the user entered.
  if (typeof pollToken !== 'string' || !pollToken
      || !sameOrigin(pollEndpoint, serverUrl) || !isAllowedServerUrl(pollEndpoint)) {
    await chrome.storage.local.set({ _merlinLoginFlowResult: { error: t('options_loginInvalidResponse') } });
    return;
  }

  const flow = {
    active: true,
    loginTabId,
    pollEndpoint,
    pollToken,
    serverUrl,
    backendKind,
    deadline: Date.now() + LOGIN_FLOW_TIMEOUT_MS,
  };
  await chrome.storage.local.set({ _merlinLoginFlow: flow });
  await chrome.alarms.create(LOGIN_POLL_ALARM, { periodInMinutes: 0.5 });

  _lfRun(flow, LOGIN_POLL_INTERVAL_MS);
}

function _lfStopTimer() {
  _lfActive = false;
  clearTimeout(_lfTimer);
  _lfTimer = null;
}

function _lfRun(flow, delayMs) {
  _lfActive = true;

  async function poll() {
    if (!_lfActive) return;

    if (Date.now() > flow.deadline) {
      await _lfFinish({ error: t('options_loginTimeout') });
      return;
    }

    try {
      const r = await fetch(flow.pollEndpoint, {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    `token=${encodeURIComponent(flow.pollToken)}`,
        signal:  AbortSignal.timeout(5_000),
      });

      if (r.status === 404) {
        // Not yet authorised — check again shortly
        if (_lfActive) _lfTimer = setTimeout(poll, LOGIN_POLL_INTERVAL_MS);
        return;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);

      const creds = await r.json();
      if (!_lfActive) return;

      await _lfFinish({ creds, serverUrl: flow.serverUrl, backendKind: flow.backendKind });
    } catch {
      // Transient network error — keep retrying
      if (_lfActive) _lfTimer = setTimeout(poll, LOGIN_POLL_INTERVAL_MS);
    }
  }

  _lfTimer = setTimeout(poll, delayMs);
}

// Resumes a stored flow after Chrome stopped the service worker (alarm) or
// the browser restarted (onStartup).
async function resumeBackgroundLoginPoll() {
  if (_lfActive) return;
  const { _merlinLoginFlow: flow } = await chrome.storage.local.get('_merlinLoginFlow');
  if (!flow?.active) {
    await chrome.alarms.clear(LOGIN_POLL_ALARM);
    return;
  }
  if (Date.now() > flow.deadline) {
    await _lfFinish({ error: t('options_loginTimeout') });
    return;
  }
  _lfRun(flow, 0);
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === LOGIN_POLL_ALARM) resumeBackgroundLoginPoll();
});
chrome.runtime.onStartup.addListener(resumeBackgroundLoginPoll);

async function cancelBackgroundLoginPoll() {
  _lfStopTimer();
  await chrome.alarms.clear(LOGIN_POLL_ALARM);
  await chrome.storage.local.remove('_merlinLoginFlow');
  await chrome.storage.local.set({ _merlinLoginFlowResult: { cancelled: true } });
}

async function _lfFinish({ creds, serverUrl, backendKind, error }) {
  _lfStopTimer();
  await chrome.alarms.clear(LOGIN_POLL_ALARM);

  const { _merlinLoginFlow } = await chrome.storage.local.get('_merlinLoginFlow');
  const loginTabId = _merlinLoginFlow?.loginTabId;
  await chrome.storage.local.remove('_merlinLoginFlow');

  if (!error) {
    const valid = creds
      && typeof creds.loginName === 'string' && creds.loginName
      && typeof creds.appPassword === 'string' && creds.appPassword;
    if (!valid) error = t('options_loginInvalidResponse');
  }

  if (error) {
    await chrome.storage.local.set({ _merlinLoginFlowResult: { error } });
    return;
  }

  // The poll response may only replace the server URL if it is same-origin
  // with the URL the user entered — otherwise a compromised server could
  // silently redirect future save traffic (including the newly issued app
  // password) to another origin.
  const finalServerUrl = serverBase(sameOrigin(creds.server, serverUrl) ? creds.server : serverUrl);
  await setCredentials({
    nextcloudUrl: finalServerUrl,
    username:     creds.loginName,
    appPassword:  creds.appPassword,
    backendKind,
  });
  await resetAuthFailures();

  if (loginTabId != null) chrome.tabs.remove(loginTabId).catch(() => {});

  // Notify the options page via storage (in case it is still open)
  await chrome.storage.local.set({
    _merlinLoginFlowResult: {
      success:   true,
      serverUrl: finalServerUrl,
      loginName: creds.loginName,
    },
  });

  // Return to the settings: focuses an open options page or opens a new one —
  // important when the popup already closed while the login tab opened.
  chrome.runtime.openOptionsPage().catch(() => {});
}

// ─── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only accept messages from this extension's own pages (options page, save
  // dialog) — keeps a future content script or another extension from
  // calling startBackgroundLoginPoll() with its own endpoint/server values.
  if (sender.id !== chrome.runtime.id) return;

  if (msg.type === 'merlin:startLoginPoll') {
    startBackgroundLoginPoll(msg);
  } else if (msg.type === 'merlin:cancelLoginPoll') {
    cancelBackgroundLoginPoll();
  } else if (msg.type === 'merlin:saveWithTags') {
    handleSaveWithTags(msg.saveId, msg.tags ?? []);
  } else if (msg.type === 'merlin:cancelSave') {
    takePendingSave(msg.saveId).then(p => {
      if (p?.windowId != null) chrome.windows.remove(p.windowId).catch(() => {});
    });
  } else {
    return;
  }
  // Answered synchronously: the work above runs on, and the pages only need
  // to know the message arrived.
  sendResponse({ ok: true });
});

// ─── Pending saves (tag dialog) ───────────────────────────────────────────────
//
// Each open tag dialog gets its own entry (its own ID instead of one global
// slot), so several open dialogs don't overwrite each other. The entry holds
// no credentials — they are read fresh via getCredentials() when saving.
// Closing the dialog with the window's close button cleans up the entry via
// windows.onRemoved; leftovers from the previous session are removed on
// browser startup.

function pendingSaveKey(saveId) {
  return `${PENDING_SAVE_PREFIX}${saveId}`;
}

async function takePendingSave(saveId) {
  if (typeof saveId !== 'string' || !saveId) return null;
  const key = pendingSaveKey(saveId);
  const { [key]: pending } = await chrome.storage.local.get(key);
  await chrome.storage.local.remove(key);
  return pending ?? null;
}

async function removePendingSaves(filter) {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter(k => k.startsWith(PENDING_SAVE_PREFIX) && filter(all[k]));
  if (keys.length) await chrome.storage.local.remove(keys);
}

chrome.windows.onRemoved.addListener((windowId) => {
  removePendingSaves(p => p?.windowId === windowId).catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  removePendingSaves(() => true).catch(() => {});
});

// ─── Save with tags (called from the save dialog) ─────────────────────────────

async function handleSaveWithTags(saveId, tags) {
  // Take the entry first, then close the window — otherwise windows.onRemoved
  // could clean it up before we read it.
  const pending = await takePendingSave(saveId);
  if (!pending) return;
  if (pending.windowId != null) chrome.windows.remove(pending.windowId).catch(() => {});

  const { url, tabId, isPage } = pending;
  const creds = await getCredentials();
  if (!creds.nextcloudUrl || !creds.username || !creds.appPassword) {
    await injectFlyout(tabId, t('notification_configureCredentials'), 'error');
    return;
  }

  await injectFlyout(tabId, t('flyout_saving'), 'loading');

  // The HTML is only captured now, so it never has to sit in storage.local.
  // The tab still exists: the save dialog is a separate popup window.
  let html = null;
  if (isPage && tabId != null) html = await captureTabHtml(tabId);

  await saveToMerlin({ ...creds, url, tabId, tags, html });
}

// ─── HTML capture for page saves ──────────────────────────────────────────────

async function captureTabHtml(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      // Runs in the page. Pages over the limit return null and are saved by
      // URL only. The UTF-16 length is never larger than the UTF-8 byte
      // size, hence the cheap pre-check.
      func: (maxBytes) => {
        const html = document.documentElement.outerHTML;
        if (html.length > maxBytes) return null;
        return new Blob([html]).size > maxBytes ? null : html;
      },
      args: [MAX_HTML_BYTES],
    });
    return results?.[0]?.result ?? null;
  } catch {
    // Scripting blocked (chrome:// pages, Chrome Web Store, PDF viewer) —
    // save by URL only.
    return null;
  }
}

// ─── Context menu setup ───────────────────────────────────────────────────────
//
// Menu items persist across service worker restarts and browser restarts, so
// they only need to be created on install and update (onInstalled).

function setupContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id:       MENU_ID_LINK,
      title:    t('contextMenu_sendLink'),
      contexts: ['link'],
    });
    chrome.contextMenus.create({
      id:       MENU_ID_LINK_TAGS,
      title:    t('contextMenu_saveLinkWithTags'),
      contexts: ['link'],
    });
    chrome.contextMenus.create({
      id:       MENU_ID_PAGE,
      title:    t('contextMenu_savePage'),
      contexts: ['page', 'selection', 'image'],
    });
    chrome.contextMenus.create({
      id:       MENU_ID_PAGE_TAGS,
      title:    t('contextMenu_savePageWithTags'),
      contexts: ['page', 'selection', 'image'],
    });
  });
}

chrome.runtime.onInstalled.addListener(setupContextMenu);

// ─── Context menu click ───────────────────────────────────────────────────────

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const { menuItemId } = info;
  const isLink   = menuItemId === MENU_ID_LINK || menuItemId === MENU_ID_LINK_TAGS;
  const isPage   = menuItemId === MENU_ID_PAGE || menuItemId === MENU_ID_PAGE_TAGS;
  const withTags = menuItemId === MENU_ID_LINK_TAGS || menuItemId === MENU_ID_PAGE_TAGS;
  if (!isLink && !isPage) return;

  // tab.url is available through activeTab (granted by the context-menu
  // click), so no tabs permission is needed.
  const url   = isLink ? info.linkUrl : tab?.url;
  const tabId = tab?.id;
  if (!url) return;

  const creds = await getCredentials();
  const { nextcloudUrl, username, appPassword } = creds;

  // No credentials yet → show flyout + open settings
  if (!nextcloudUrl || !username || !appPassword) {
    await injectFlyout(tabId, t('notification_configureCredentials'), 'error');
    // Brief pause so the flyout is visible before the new tab opens
    await sleep(700);
    chrome.runtime.openOptionsPage();
    return;
  }

  // Older installs may still have an http:// URL stored.
  if (!isAllowedServerUrl(nextcloudUrl)) {
    await injectFlyout(tabId, t('flyout_httpBlocked'), 'error');
    chrome.runtime.openOptionsPage();
    return;
  }

  // The host permission is optional and limited to the configured server's
  // origin; it is granted on login in the options page. It is not requested
  // here: permissions.request() needs a user gesture, which the awaits above
  // have already used up. So only check it and point the user to the
  // settings if it is missing (e.g. revoked in chrome://extensions).
  const origin = originPatternFor(nextcloudUrl);
  if (origin && !(await chrome.permissions.contains({ origins: [origin] }))) {
    await injectFlyout(tabId, t('notification_needsPermission'), 'error');
    chrome.runtime.openOptionsPage();
    return;
  }

  // ── Direct save (no dialog) ─────────────────────────────────────────────────
  if (!withTags) {
    await injectFlyout(tabId, t('flyout_saving'), 'loading');

    // For page saves, send the rendered HTML so the server can skip its own
    // fetch (paywalled and JS-rendered pages). Link saves are fetched by the
    // server directly.
    const html = isPage ? await captureTabHtml(tabId) : null;
    await saveToMerlin({ ...creds, url, html, tabId, tags: [] });
    return;
  }

  // ── Save with tags — open dialog ────────────────────────────────────────────
  const saveId = crypto.randomUUID();
  const key    = pendingSaveKey(saveId);
  await chrome.storage.local.set({ [key]: { url, tabId, isPage, windowId: null } });

  try {
    const win = await openSaveDialog(saveId, tab?.windowId);
    // Record the window ID so windows.onRemoved can clean up the entry. If
    // the dialog has already saved in the meantime, the entry is gone and is
    // not recreated.
    const { [key]: pending } = await chrome.storage.local.get(key);
    if (pending) await chrome.storage.local.set({ [key]: { ...pending, windowId: win.id } });
  } catch {
    // Fallback: save directly if window creation fails
    await chrome.storage.local.remove(key);
    await injectFlyout(tabId, t('flyout_saving'), 'loading');
    const html = isPage ? await captureTabHtml(tabId) : null;
    await saveToMerlin({ ...creds, url, html, tabId, tags: [] });
  }
});

// ─── Dialog window ────────────────────────────────────────────────────────────

async function openSaveDialog(saveId, browserWindowId) {
  const opts = {
    url:  chrome.runtime.getURL(`save-dialog.html?id=${encodeURIComponent(saveId)}`),
    type: 'popup',
    ...SAVE_DIALOG_SIZE,
  };
  const pos = await centeredPosition(SAVE_DIALOG_SIZE, browserWindowId);
  if (pos) {
    try {
      return await chrome.windows.create({ ...opts, ...pos });
    } catch {
      // Chrome rejects bounds that are less than half on screen (browser
      // window partly off-screen) — then let Chrome place the dialog.
    }
  }
  return chrome.windows.create(opts);
}

// Centers a window of `size` over the browser window the click came from. A
// service worker has no `screen` object, so the browser window is the only
// reference — on a maximized window that is the middle of its screen anyway.
// Returns null (Chrome's default placement) when the window is unknown.
async function centeredPosition(size, windowId) {
  let browserWin = null;
  try {
    browserWin = windowId != null
      ? await chrome.windows.get(windowId)
      : await chrome.windows.getLastFocused();
  } catch { /* ignore */ }

  if (!(browserWin?.width > 0 && browserWin?.height > 0)) return null;
  return {
    left: Math.round(browserWin.left + Math.max(0, (browserWin.width  - size.width)  / 2)),
    top:  Math.round(browserWin.top  + Math.max(0, (browserWin.height - size.height) / 2)),
  };
}

// ─── API call ─────────────────────────────────────────────────────────────────

// merlin-server has no Pocket-style extension API (/api/v1/add) that resolves
// tag names on the server, so tag IDs are resolved (or created) here via
// /api/tags first. Also returns the names that could not be applied, so the
// toast can report them honestly.
async function resolveTagIdsStandalone(nextcloudUrl, authHeader, tagNames) {
  if (!tagNames || tagNames.length === 0) return { ids: [], failed: [] };

  const endpoint = tagsEndpoint(nextcloudUrl, 'standalone');
  const headers  = { 'Authorization': authHeader, 'Content-Type': 'application/json' };

  // Without the existing tag list every tag would be created again as a
  // duplicate — rather apply none and report that.
  let existing;
  try {
    const resp = await fetch(endpoint, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(TAGS_TIMEOUT_MS),
    });
    if (!resp.ok) return { ids: [], failed: [...tagNames] };
    existing = normalizeTagList(await resp.json());
  } catch {
    return { ids: [], failed: [...tagNames] };
  }

  const ids = [];
  const failed = [];
  for (const name of tagNames) {
    const match = existing.find(tag => String(tag.name).toLowerCase() === name.toLowerCase());
    if (match) {
      ids.push(match.id);
      continue;
    }
    try {
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers,
        body:   JSON.stringify({ name }),
        signal: AbortSignal.timeout(TAGS_TIMEOUT_MS),
      });
      if (!resp.ok) { failed.push(name); continue; }
      const created = await resp.json();
      ids.push(created.id);
      existing.push(created);
    } catch {
      failed.push(name);
    }
  }
  return { ids, failed };
}

async function saveToMerlin({ nextcloudUrl, username, appPassword, backendKind, url, html, tabId, tags = [] }) {
  if (!isAllowedServerUrl(nextcloudUrl)) {
    await injectFlyout(tabId, t('flyout_httpBlocked'), 'error');
    return;
  }

  const authHeader = basicAuthHeader(username, appPassword);
  let failedTags = [];

  let apiUrl, body;
  if (backendKind === 'standalone') {
    // merlin-server uses its native /api/articles endpoint, which accepts html
    // exactly like the Nextcloud app's /api/v1/add below.
    apiUrl = `${serverBase(nextcloudUrl)}/api/articles`;
    const { ids: tagIds, failed } = await resolveTagIdsStandalone(nextcloudUrl, authHeader, tags);
    failedTags = failed;
    body = tagIds.length > 0 ? { url, tagIds } : { url };
  } else {
    apiUrl = `${serverBase(nextcloudUrl)}/index.php/apps/merlin/api/v1/add`;
    body = { url };
    if (tags && tags.length > 0) body.tags = tags;
  }
  if (html) body.html = html;

  let response;
  try {
    response = await fetch(apiUrl, {
      method:  'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type':  'application/json',
      },
      body:   JSON.stringify(body),
      signal: AbortSignal.timeout(SAVE_TIMEOUT_MS),
    });
  } catch (networkError) {
    const message = networkError?.name === 'TimeoutError'
      ? t('flyout_timeout')
      : t('flyout_connectionFailed', [networkError.message]);
    await injectFlyout(tabId, message, 'error');
    return;
  }

  if (response.status === 401) {
    const cleared = await recordAuthFailure();
    await injectFlyout(tabId, cleared ? t('flyout_authFailed') : t('flyout_authFailedRetry'), 'error');
    return;
  }
  if (!response.ok) {
    // The Nextcloud backend rejects known unscrapable domains (see
    // content-filters/$unsupported.xml there) synchronously. merlin-server
    // may not know this error shape (yet) — then the generic branch applies.
    let payload = null;
    try { payload = await response.clone().json(); } catch { /* no JSON body */ }
    if (payload && payload.error === 'unsupported_site' && payload.domain) {
      await injectFlyout(tabId, t('flyout_unsupportedSite', [payload.domain]), 'error');
      return;
    }
    await injectFlyout(tabId, t('flyout_serverError', [String(response.status)]), 'error');
    return;
  }

  await resetAuthFailures();

  // Show success immediately — the link has been handed off to the server.
  // Content extraction runs asynchronously; no need to wait for it here.
  let message;
  if (failedTags.length > 0) {
    message = t('flyout_articleAddedTagsFailed', [failedTags.join(', ')]);
  } else if (tags && tags.length > 0) {
    message = t('flyout_articleAddedWithTags', [tags.join(', ')]);
  } else {
    message = t('flyout_addedToReadingList');
  }
  await injectFlyout(tabId, message, 'success');
}

// ─── Flyout injection ─────────────────────────────────────────────────────────
//
// Injects a small toast into the current page via chrome.scripting.
// Falls back to a desktop notification on pages where extensions cannot run
// scripts (chrome://, the Chrome Web Store, the PDF viewer) and on documents
// where the toast cannot be rendered.

async function injectFlyout(tabId, message, state) {
  if (tabId == null) { await fallbackNotify(state, message); return; }

  const logoUrl = await getLogoDataUrl();

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func:   renderFlyout,
      args:   [message, state, logoUrl],
    });
    if (results?.[0]?.result !== true) await fallbackNotify(state, message);
  } catch {
    await fallbackNotify(state, message);
  }
}

// This function runs INSIDE the page context — it must be fully
// self-contained. The toast lives in a closed shadow root so page CSS cannot
// restyle it and page scripts cannot reach into it. Returns true when the
// toast was rendered.
function renderFlyout(message, state, logoUrl) {
  const HOST_ID = '__merlin_ext_flyout_host__';
  const XHTML   = 'http://www.w3.org/1999/xhtml';
  const root    = document.documentElement;
  if (!root) return false;

  const el = (tag) => document.createElementNS(XHTML, tag);

  let host = document.getElementById(HOST_ID);
  // The shadow root reference is stored as an expando on the host. Expandos
  // set from the extension's isolated world are not visible to page scripts.
  let shadow = host?.__merlinShadow;
  if (!host || !shadow) {
    host?.remove();
    // A custom element name keeps generic page selectors like `div { … }` off
    // the host, and !important inline declarations win over any remaining
    // page rules (inline beats stylesheets at equal importance).
    host = el('merlin-toast');
    host.id = HOST_ID;
    host.style.cssText = [
      'all: initial',
      'display: block',
      'position: fixed',
      'top: 24px',
      'right: 24px',
      'z-index: 2147483647',
      'visibility: visible',
      'opacity: 1',
    ].map(rule => `${rule} !important`).join('; ');
    try {
      shadow = host.attachShadow({ mode: 'closed' });
    } catch {
      return false;
    }
    host.__merlinShadow = shadow;

    const style = el('style');
    style.textContent = `
      @keyframes spin { to { transform: rotate(360deg); } }
      @keyframes slide-in { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: translateY(0); } }
      .flyout {
        display: flex; align-items: center; gap: 11px;
        background: #fff; border: 1px solid #e0e4ea; border-radius: 13px;
        box-shadow: 0 6px 24px rgba(0,0,0,0.13);
        padding: 13px 16px; min-width: 230px; max-width: 340px; box-sizing: border-box;
        font: 13px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        animation: slide-in 0.2s ease both;
        transition: opacity 0.25s ease, transform 0.25s ease;
      }
      .flyout.hiding { opacity: 0; transform: translateY(-10px); }
      .logo { flex-shrink: 0; position: relative; width: 50px; height: 50px; }
      .logo img { width: 50px; height: 50px; border-radius: 10px; display: block; }
      .badge {
        position: absolute; bottom: -4px; right: -4px; background: #fff;
        border-radius: 50%; width: 20px; height: 20px;
        display: flex; align-items: center; justify-content: center;
        box-shadow: 0 1px 4px rgba(0,0,0,0.18);
        font-size: 12px; font-weight: 700; line-height: 1;
      }
      .badge.success { color: #256029; }
      .badge.error   { color: #9b1c1c; }
      .spinner {
        width: 12px; height: 12px; box-sizing: border-box;
        border: 2px solid #0082c9; border-top-color: transparent;
        border-radius: 50%; animation: spin 0.75s linear infinite;
      }
      .text { flex: 1; min-width: 0; }
      .label {
        font-weight: 700; color: #0082c9; font-size: 12px;
        letter-spacing: .03em; text-transform: uppercase; margin-bottom: 2px;
      }
      .message { color: #444; overflow: hidden; text-overflow: ellipsis; }
    `;
    shadow.appendChild(style);
    root.appendChild(host);
  }

  // Remove the previous toast (and its auto-hide timer) when updating
  const previous = shadow.querySelector('.flyout');
  if (previous) {
    clearTimeout(previous.__hideTimer);
    previous.remove();
  }

  // Build the content via the DOM API (no innerHTML with dynamic values)
  const flyout = el('div');
  flyout.className = 'flyout';
  flyout.setAttribute('role', 'status');

  const logo = el('div');
  logo.className = 'logo';
  if (logoUrl) {
    const img = el('img');
    img.alt = 'Merlin';
    // A strict img-src CSP on the page can block the data: URL — then just
    // hide the image instead of showing a broken-image icon.
    img.addEventListener('error', () => { img.style.visibility = 'hidden'; });
    img.src = logoUrl;
    logo.appendChild(img);
  }

  const badge = el('div');
  badge.className = `badge ${state}`;
  if (state === 'success') {
    badge.textContent = '✓';
  } else if (state === 'error') {
    badge.textContent = '✕';
  } else {
    const spinner = el('div');
    spinner.className = 'spinner';
    badge.appendChild(spinner);
  }
  logo.appendChild(badge);
  flyout.appendChild(logo);

  const text = el('div');
  text.className = 'text';
  const label = el('div');
  label.className = 'label';
  label.textContent = 'Merlin';
  const msgEl = el('div');
  msgEl.className = 'message';
  msgEl.textContent = message;
  text.append(label, msgEl);
  flyout.appendChild(text);

  shadow.appendChild(flyout);

  // Auto-dismiss after 3.5 s for finished states
  if (state !== 'loading') {
    flyout.__hideTimer = setTimeout(() => {
      flyout.classList.add('hiding');
      setTimeout(() => {
        flyout.remove();
        if (!shadow.querySelector('.flyout')) host.remove();
      }, 280);
    }, 3500);
  }
  return true;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Desktop notification instead of the toast. A "saving…" notification would
// only linger next to the final result, so the loading state is skipped.
function fallbackNotify(state, message) {
  if (state === 'loading') return Promise.resolve();
  return showNotification(message);
}

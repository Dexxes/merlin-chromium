'use strict';

const MENU_ID_LINK = 'merlin-send-link';
const MENU_ID_PAGE = 'merlin-save-page';

// ─── i18n shorthand ───────────────────────────────────────────────────────────
// Liest lokalisierte Strings aus _locales/<lang>/messages.json (generiert aus
// localization/strings/*.json via tools/i18n/export.py). `subs` ist optional
// und wird auf die $1/$2-Platzhalter der jeweiligen Message abgebildet.
const t = (key, subs) => chrome.i18n.getMessage(key, subs);

// ─── Logo as base64 data URL ──────────────────────────────────────────────────
// Pages block moz-extension:// URLs via CSP, so we convert the icon once to
// an inline data URL and pass it as an argument into the injected function.

let _logoDataUrl = null;

async function getLogoDataUrl() {
  if (_logoDataUrl) return _logoDataUrl;
  try {
    // FileReader is not available in Chrome service workers — use arrayBuffer instead.
    const resp   = await fetch(chrome.runtime.getURL('icons/icon-128.png'));
    const buffer = await resp.arrayBuffer();
    const bytes  = new Uint8Array(buffer);
    const binary = Array.from(bytes, b => String.fromCharCode(b)).join('');
    _logoDataUrl = `data:image/png;base64,${btoa(binary)}`;
  } catch {
    _logoDataUrl = ''; // no logo on error — flyout still works
  }
  return _logoDataUrl;
}

// ─── Context menu setup ───────────────────────────────────────────────────────

function setupContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id:       MENU_ID_LINK,
      title:    t('contextMenu_sendLink'),
      contexts: ['link'],
    });
    chrome.contextMenus.create({
      id:       MENU_ID_PAGE,
      title:    t('contextMenu_savePage'),
      contexts: ['page', 'selection', 'image'],
    });
  });
}

chrome.runtime.onInstalled.addListener(setupContextMenu);
chrome.runtime.onStartup.addListener(setupContextMenu);

// ─── Migration: storage.sync → storage.local ─────────────────────────────────
//
// Vor diesem Fix landete das App-Passwort in chrome.storage.sync und wurde von
// Google unverschlüsselt über alle angemeldeten Geräte synchronisiert. Bestandsnutzer
// mit Daten in storage.sync müssen einmalig auf storage.local umgezogen werden,
// danach wird storage.sync für diese Keys nicht mehr angefasst.
chrome.runtime.onInstalled.addListener(async () => {
  const CREDENTIAL_KEYS = ['nextcloudUrl', 'username', 'appPassword'];
  const synced = await chrome.storage.sync.get(CREDENTIAL_KEYS);
  const toMigrate = Object.fromEntries(
    Object.entries(synced).filter(([, v]) => v !== undefined),
  );
  if (Object.keys(toMigrate).length === 0) return;

  await chrome.storage.local.set(toMigrate);
  await chrome.storage.sync.remove(CREDENTIAL_KEYS);
});

// ─── Login Flow polling ───────────────────────────────────────────────────────
//
// Polling läuft hier im Service Worker, nicht in der Options-Seite: Chrome
// öffnet die Options-Seite per Toolbar-Klick als Popup (default_popup); sobald
// der neue Login-Tab den Fokus bekommt, schließt sich das Popup automatisch und
// zerstört seinen JS-Kontext — ein dort laufendes Polling würde damit abreißen.
// Zusätzlich kann Chrome den MV3-Service-Worker nach ~30 s Inaktivität jederzeit
// terminieren; eine setTimeout-Kette würde das nicht überleben. chrome.alarms
// weckt den Service Worker dagegen zuverlässig wieder auf (auch nach Terminierung),
// daher läuft das Polling über einen wiederkehrenden Alarm statt über setTimeout.
// Der Fortschritt liegt in storage.local, damit pollLoginOnce() nach einem
// Wake-up genau da weitermacht, wo der Service Worker vorher stand.

const LOGIN_POLL_ALARM = 'merlin-login-poll';

async function startBackgroundLoginPoll({ pollEndpoint, pollToken, serverUrl, loginTabId, backendKind }) {
  await chrome.storage.local.set({
    _merlinLoginFlow: {
      active:   true,
      loginTabId,
      pollEndpoint,
      pollToken,
      serverUrl,
      backendKind,
      deadline: Date.now() + 5 * 60 * 1000, // 5-Minuten-Timeout
    },
  });
  // periodInMinutes wird von Chrome auf minimal 0.5 (30 s) geklemmt — für einen
  // einmaligen Login-Vorgang ist diese Latenz akzeptabel.
  chrome.alarms.create(LOGIN_POLL_ALARM, { delayInMinutes: 0.5, periodInMinutes: 0.5 });
  await pollLoginOnce(); // erster Versuch sofort, nicht erst beim ersten Alarm-Tick
}

async function cancelBackgroundLoginPoll() {
  chrome.alarms.clear(LOGIN_POLL_ALARM);
  await chrome.storage.local.remove('_merlinLoginFlow');
  await chrome.storage.local.set({ _merlinLoginFlowResult: { cancelled: true } });
}

async function pollLoginOnce() {
  const { _merlinLoginFlow: flow } = await chrome.storage.local.get('_merlinLoginFlow');
  if (!flow?.active) return;

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

    if (r.status === 404) return; // noch nicht autorisiert — nächster Alarm-Tick versucht erneut
    if (!r.ok) throw new Error(`HTTP ${r.status}`);

    const creds = await r.json();
    await _lfFinish({ creds, serverUrl: flow.serverUrl, loginTabId: flow.loginTabId, backendKind: flow.backendKind });
  } catch {
    // Transienter Netzwerkfehler — nächster Alarm-Tick versucht erneut
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === LOGIN_POLL_ALARM) pollLoginOnce();
});

async function _lfFinish({ creds, serverUrl, loginTabId, backendKind, error }) {
  chrome.alarms.clear(LOGIN_POLL_ALARM);
  await chrome.storage.local.remove('_merlinLoginFlow');

  if (error) {
    await chrome.storage.local.set({ _merlinLoginFlowResult: { error } });
    return;
  }

  // storage.local statt storage.sync: das App-Passwort darf nicht über
  // Google-Sync unverschlüsselt auf andere Geräte verteilt werden. Chrome hat —
  // im Unterschied zu Firefox/Thunderbird — keine native Ende-zu-Ende-Verschlüsselung
  // für storage.sync; die optionale Custom-Passphrase-Verschlüsselung (crypto.js,
  // options.js) bleibt deshalb für Chrome bestehen.
  const finalServerUrl = (creds.server || serverUrl).replace(/\/$/, '');
  await chrome.storage.local.set({
    nextcloudUrl: finalServerUrl,
    username:     creds.loginName,
    appPassword:  creds.appPassword,
    backendKind,
  });

  if (loginTabId != null) chrome.tabs.remove(loginTabId).catch(() => {});

  await chrome.storage.local.set({
    _merlinLoginFlowResult: {
      success:   true,
      serverUrl: finalServerUrl,
      loginName: creds.loginName,
    },
  });

  // Automatisch zurück zu den Einstellungen: fokussiert eine bereits offene
  // Options-Seite oder öffnet sie neu — wichtig, falls das Popup beim Öffnen
  // des Login-Tabs bereits geschlossen wurde.
  chrome.runtime.openOptionsPage();
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'merlin:startLoginPoll') {
    startBackgroundLoginPoll(msg);
    return Promise.resolve({ ok: true });
  }
  if (msg.type === 'merlin:cancelLoginPoll') {
    cancelBackgroundLoginPoll();
    return Promise.resolve({ ok: true });
  }
});

// ─── Context menu click ───────────────────────────────────────────────────────

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const isLink = info.menuItemId === MENU_ID_LINK;
  const isPage = info.menuItemId === MENU_ID_PAGE;
  if (!isLink && !isPage) return;

  const url   = isLink ? info.linkUrl : tab?.url;
  const tabId = tab?.id;
  if (!url) return;

  const { nextcloudUrl, username, appPassword, backendKind } = await chrome.storage.local.get([
    'nextcloudUrl', 'username', 'appPassword', 'backendKind',
  ]);

  // No credentials yet → show flyout + open settings
  if (!nextcloudUrl || !username || !appPassword) {
    await injectFlyout(tabId, t('notification_configureCredentials'), 'error');
    // Brief pause so the flyout is visible before the new tab opens
    await sleep(700);
    chrome.runtime.openOptionsPage();
    return;
  }

  // Host permission ist seit dem Permissions-Fix nur noch optional und auf die
  // konkrete Nextcloud-Origin beschränkt (statt <all_urls>) — wird normalerweise
  // schon beim Login in den Optionen erteilt. Hier als Absicherung erneut prüfen,
  // z. B. falls der Nutzer die Berechtigung zwischenzeitlich entzogen hat. Der
  // Klick auf den Kontextmenü-Eintrag ist die User-Geste, die den Request erlaubt.
  const origin = originPatternFor(nextcloudUrl);
  if (origin && !(await chrome.permissions.contains({ origins: [origin] }))) {
    const granted = await chrome.permissions.request({ origins: [origin] }).catch(() => false);
    if (!granted) {
      await injectFlyout(tabId, t('notification_needsPermission'), 'error');
      return;
    }
  }

  // Show loading flyout immediately
  await injectFlyout(tabId, t('flyout_saving'), 'loading');

  // For page saves, capture the current rendered HTML so the server can skip its
  // own HTTP fetch (works for paywalled and JS-rendered pages).
  // For link saves the server fetches the target URL directly — no HTML needed.
  // Both backends accept the html field (merlin-server's /api/articles gained
  // the same extractFromHtml() wiring as Nextcloud's /api/v1/add).
  let html = null;
  if (isPage && tabId != null) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => document.documentElement.outerHTML,
      });
      html = results?.[0]?.result ?? null;
    } catch {
      // Scripting blocked (privileged page, PDF viewer, etc.) — fall back to URL-only.
    }
  }

  await saveToMerlin({ nextcloudUrl, username, appPassword, backendKind, url, html, tabId });
});

// ─── API call ─────────────────────────────────────────────────────────────────

async function saveToMerlin({ nextcloudUrl, username, appPassword, backendKind, url, html, tabId }) {
  // merlin-server hat keine Pocket-kompatible Extension-API (/api/v1/add) -
  // stattdessen wird der native Endpunkt genutzt, den auch die Leseliste
  // (library.php) zum Hinzufügen nutzt.
  const apiUrl = backendKind === 'standalone'
    ? `${nextcloudUrl.replace(/\/$/, '')}/api/articles`
    : `${nextcloudUrl.replace(/\/$/, '')}/index.php/apps/merlin/api/v1/add`;
  const creds  = btoa(`${username}:${appPassword}`);

  const body = html ? { url, html } : { url };

  let response;
  try {
    response = await fetch(apiUrl, {
      method:  'POST',
      headers: {
        'Authorization': `Basic ${creds}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (networkError) {
    await injectFlyout(tabId, t('flyout_connectionFailed', [networkError.message]), 'error');
    return;
  }

  if (response.status === 401) {
    // Credentials sind ungültig/abgelaufen — löschen, damit der Nutzer den
    // Login Flow v2 erneut durchlaufen muss statt mit toten Daten weiterzuarbeiten.
    await chrome.storage.local.remove(['nextcloudUrl', 'username', 'appPassword', 'encPassphrase']);
    // Verschlüsselte Sync-Kopie ebenfalls löschen — das App-Passwort ist tot.
    try { await chrome.storage.sync.remove('credEnc'); } catch { /* sync evtl. nicht verfügbar */ }
    await chrome.notifications.create({
      type:    'basic',
      iconUrl: chrome.runtime.getURL('icons/icon-48.png'),
      title:   t('notification_defaultTitle'),
      message: t('notification_authFailedMessage'),
    });
    await injectFlyout(tabId, t('flyout_authFailed'), 'error');
    return;
  }
  if (!response.ok) {
    await injectFlyout(tabId, t('flyout_serverError', [String(response.status)]), 'error');
    return;
  }

  // Show success immediately — the link has been handed off to the server.
  // Content extraction runs asynchronously; no need to wait for it here.
  await injectFlyout(tabId, t('flyout_addedToReadingList'), 'success');
}

// ─── Flyout injection ─────────────────────────────────────────────────────────
//
// Injects a small toast into the current page via chrome.scripting.
// Falls back to a browser notification on privileged pages (about:*, etc.).

async function injectFlyout(tabId, message, state) {
  if (tabId == null) { await fallbackNotify(state, message); return; }

  const logoUrl = await getLogoDataUrl();

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func:   renderFlyout,
      args:   [message, state, logoUrl],
    });
  } catch {
    // Scripting blocked (privileged page, pdf viewer, etc.)
    await fallbackNotify(state, message);
  }
}

// This function runs INSIDE the page context — must be fully self-contained.
function renderFlyout(message, state, logoUrl) {
  const ID      = '__merlin_ext_flyout__';
  const STYLE_ID = '__merlin_ext_styles__';

  // Inject keyframe animation once
  if (!document.getElementById(STYLE_ID)) {
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = `
      @keyframes __merlin_spin { to { transform: rotate(360deg); } }
      @keyframes __merlin_in   { from { opacity:0; transform:translateY(-10px) } to { opacity:1; transform:translateY(0) } }
    `;
    document.head.appendChild(s);
  }

  let flyout = document.getElementById(ID);
  if (!flyout) {
    flyout = document.createElement('div');
    flyout.id = ID;
    Object.assign(flyout.style, {
      position:      'fixed',
      top:           '24px',
      right:         '24px',
      zIndex:        '2147483647',
      display:       'flex',
      alignItems:    'center',
      gap:           '11px',
      background:    '#fff',
      border:        '1px solid #e0e4ea',
      borderRadius:  '13px',
      boxShadow:     '0 6px 24px rgba(0,0,0,0.13)',
      padding:       '13px 16px',
      minWidth:      '230px',
      maxWidth:      '340px',
      fontFamily:    "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",
      fontSize:      '13px',
      lineHeight:    '1.4',
      animation:     '__merlin_in 0.2s ease both',
      transition:    'opacity 0.25s ease, transform 0.25s ease',
    });
    document.body.appendChild(flyout);
  }

  // Clear auto-hide timer if updating
  clearTimeout(flyout.__hideTimer);

  // Build flyout content via DOM API (avoids unsafe innerHTML with dynamic values)
  flyout.replaceChildren();

  // Left column: logo + state badge
  const logoWrap = Object.assign(document.createElement('div'), {});
  Object.assign(logoWrap.style, { flexShrink:'0', position:'relative', width:'50px', height:'50px' });

  const img = document.createElement('img');
  img.src = logoUrl;
  img.alt = 'Merlin';
  Object.assign(img.style, { width:'50px', height:'50px', borderRadius:'10px', display:'block' });
  logoWrap.appendChild(img);

  const badgeWrap = document.createElement('div');
  Object.assign(badgeWrap.style, {
    position:'absolute', bottom:'-4px', right:'-4px', background:'#fff',
    borderRadius:'50%', width:'20px', height:'20px',
    display:'flex', alignItems:'center', justifyContent:'center',
    boxShadow:'0 1px 4px rgba(0,0,0,0.18)',
  });

  const badgeEl = document.createElement('div');
  if (state === 'success') {
    badgeEl.textContent = '✓';
    Object.assign(badgeEl.style, { color:'#256029', fontSize:'12px', fontWeight:'700', lineHeight:'1' });
  } else if (state === 'error') {
    badgeEl.textContent = '✕';
    Object.assign(badgeEl.style, { color:'#9b1c1c', fontSize:'12px', fontWeight:'700', lineHeight:'1' });
  } else {
    // loading spinner
    Object.assign(badgeEl.style, {
      width:'12px', height:'12px',
      border:'2px solid #0082c9', borderTopColor:'transparent',
      borderRadius:'50%', animation:'__merlin_spin 0.75s linear infinite',
    });
  }
  badgeWrap.appendChild(badgeEl);
  logoWrap.appendChild(badgeWrap);
  flyout.appendChild(logoWrap);

  // Right column: label + message
  const textCol = document.createElement('div');
  Object.assign(textCol.style, { flex:'1', minWidth:'0' });

  const label = document.createElement('div');
  label.textContent = 'Merlin';
  Object.assign(label.style, {
    fontWeight:'700', color:'#0082c9', fontSize:'12px',
    letterSpacing:'.03em', textTransform:'uppercase', marginBottom:'2px',
  });
  textCol.appendChild(label);

  const msgEl = document.createElement('div');
  msgEl.textContent = message;
  Object.assign(msgEl.style, { color:'#444', overflow:'hidden', textOverflow:'ellipsis' });
  textCol.appendChild(msgEl);

  flyout.appendChild(textCol);

  // Auto-dismiss after 3.5 s for finished states
  if (state !== 'loading') {
    flyout.__hideTimer = setTimeout(() => {
      flyout.style.opacity   = '0';
      flyout.style.transform = 'translateY(-10px)';
      setTimeout(() => flyout.remove(), 280);
    }, 3500);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fallbackNotify(state, message) {
  const titles = {
    success: t('notification_savedTitle'),
    error:   t('notification_errorTitle'),
    loading: t('notification_loadingTitle'),
  };
  return chrome.notifications.create({
    type:    'basic',
    iconUrl: chrome.runtime.getURL('icons/icon-48.png'),
    title:   titles[state] ?? t('notification_defaultTitle'),
    message,
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// host_permissions ist nur noch optional (manifest.json) und auf die jeweils
// konfigurierte Nextcloud-Origin beschränkt — diese Helper-Funktion baut das
// Match-Pattern dafür. Duplikat von options.js: separate Skript-Kontexte ohne
// gemeinsames Modul-System, daher keine sinnvolle gemeinsame Datei dafür.
function originPatternFor(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/*`;
  } catch {
    return null;
  }
}

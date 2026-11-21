'use strict';

// Runs the service worker (background.js, which pulls in crypto.js and
// common.js via importScripts) in a Node VM with a fake chrome.* API and
// checks the save and login flows.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { ROOT, readMessages, makeGetMessage } = require('./helpers');

const getMessage = makeGetMessage(readMessages('en'));
const msg = (key, subs) => getMessage(key, subs);

function listener() {
  const fns = [];
  return { addListener: f => fns.push(f), fire: (...args) => Promise.all(fns.map(f => f(...args))) };
}

const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));

function storageArea(store) {
  return {
    get: async (k) => {
      if (k == null) return structuredClone(store);
      const o = {};
      for (const x of [].concat(k)) if (x in store) o[x] = structuredClone(store[x]);
      return o;
    },
    set: async (o) => { Object.assign(store, structuredClone(o)); },
    remove: async (k) => { for (const x of [].concat(k)) delete store[x]; },
  };
}

function loadBackground() {
  const env = {
    store: {}, sync: {}, notes: [], fetches: [], windows: [], alarms: [], menus: [], injected: [],
    fetchImpl: async () => new Response('{}', { status: 201 }),
    // What the injected toast reports back; false simulates a page where it
    // cannot be rendered.
    toastResult: true,
    permissionGranted: true,
  };
  const ev = {
    clicked: listener(), msg: listener(), installed: listener(),
    startup: listener(), alarm: listener(), removed: listener(),
  };
  env.ev = ev;

  const chrome = {
    i18n: { getMessage },
    storage: { local: storageArea(env.store), sync: storageArea(env.sync) },
    runtime: {
      id: 'me', getURL: p => `chrome-extension://x/${p}`,
      onMessage: ev.msg, onInstalled: ev.installed, onStartup: ev.startup,
      openOptionsPage: async () => { env.notes.push(['openOptions']); },
    },
    contextMenus: {
      removeAll: (cb) => { env.menus.length = 0; cb?.(); },
      create: (o) => { env.menus.push(o); },
      onClicked: ev.clicked,
    },
    notifications: { create: async (o) => { env.notes.push([o.title, o.message]); } },
    permissions: { contains: async () => env.permissionGranted },
    scripting: {
      executeScript: async ({ func, args }) => {
        if (func.name === 'renderFlyout') {
          env.injected.push([args[0], args[1]]); // outer-realm array for deepEqual
          return [{ result: env.toastResult }];
        }
        return [{ result: '<html>page</html>' }];
      },
    },
    windows: {
      create: async (o) => { env.windows.push(o); return { id: 77 }; },
      update: async () => {}, remove: async () => {},
      get: async () => ({ left: 100, top: 50, width: 1600, height: 1000 }),
      getLastFocused: async () => ({}), onRemoved: ev.removed,
    },
    tabs: { remove: async () => {} },
    alarms: { create: async (n) => { env.alarms.push(n); }, clear: async () => true, onAlarm: ev.alarm },
  };

  // A service worker has neither `screen` nor FileReader — leave both out so
  // the code cannot rely on them.
  const ctx = {
    chrome, AbortSignal, Response, Blob, TextEncoder, TextDecoder, btoa, atob, URL,
    setTimeout, clearTimeout, console, structuredClone, crypto: globalThis.crypto,
    fetch: (u, o) => {
      if (String(u).startsWith('chrome-extension://')) return Promise.resolve(new Response(new Uint8Array([1, 2, 3])));
      env.fetches.push([u, o]);
      return env.fetchImpl(u, o);
    },
  };
  ctx.globalThis = ctx;
  ctx.self = ctx;
  ctx.importScripts = (...files) => {
    for (const f of files) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  };
  vm.createContext(ctx);
  ctx.importScripts('background.js');

  env.run = code => vm.runInContext(code, ctx);
  env.login = (fields = {}) => env.run(`setCredentials(${JSON.stringify({
    nextcloudUrl: 'https://cloud.example.com', username: 'u', appPassword: 'p', backendKind: 'nextcloud', ...fields,
  })})`);
  env.lastBody = () => JSON.parse(env.fetches.at(-1)[1].body);
  env.lastToast = () => env.injected.at(-1);
  return env;
}

let env;
beforeEach(async () => {
  env = loadBackground();
  await env.login();
});

test('install creates the four context-menu entries', async () => {
  await env.ev.installed.fire({ reason: 'install' });
  assert.deepEqual(env.menus.map(m => m.id), ['merlin-send-link', 'merlin-send-link-tags', 'merlin-save-page', 'merlin-save-page-tags']);
  assert.deepEqual(env.menus.map(m => m.title), [
    msg('contextMenu_sendLink'), msg('contextMenu_saveLinkWithTags'),
    msg('contextMenu_savePage'), msg('contextMenu_savePageWithTags'),
  ]);
});

test('direct link save shows the toast', async () => {
  await env.ev.clicked.fire({ menuItemId: 'merlin-send-link', linkUrl: 'https://ex.org/a' }, { id: 1, url: 'https://ex.org/' });
  assert.equal(env.fetches.at(-1)[0], 'https://cloud.example.com/index.php/apps/merlin/api/v1/add');
  assert.equal(env.fetches.at(-1)[1].headers.Authorization, `Basic ${btoa('u:p')}`);
  assert.deepEqual(env.lastBody(), { url: 'https://ex.org/a' });
  assert.deepEqual(env.injected, [[msg('flyout_saving'), 'loading'], [msg('flyout_addedToReadingList'), 'success']]);
  assert.deepEqual(env.notes, []);
});

test('page save sends the HTML and reports unsupported sites', async () => {
  env.fetchImpl = async () => new Response(JSON.stringify({ error: 'unsupported_site', domain: 'x.com' }), { status: 422 });
  await env.ev.clicked.fire({ menuItemId: 'merlin-save-page' }, { id: 1, url: 'https://x.com/p' });
  assert.equal(env.lastBody().url, 'https://x.com/p');
  assert.equal(env.lastBody().html, '<html>page</html>');
  assert.deepEqual(env.lastToast(), [msg('flyout_unsupportedSite', ['x.com']), 'error']);
});

test('pages without a toast get a notification titled just "Merlin", no loading notification', async () => {
  env.toastResult = false;
  await env.ev.clicked.fire({ menuItemId: 'merlin-send-link', linkUrl: 'https://ex.org/a' }, { id: 1 });
  assert.deepEqual(env.notes, [[msg('notification_defaultTitle'), msg('flyout_addedToReadingList')]]);
  assert.equal(msg('notification_defaultTitle'), 'Merlin');
});

test('only the second 401 in a row clears the credentials', async () => {
  env.fetchImpl = async () => new Response('', { status: 401 });
  const click = () => env.ev.clicked.fire({ menuItemId: 'merlin-send-link', linkUrl: 'https://ex.org/a' }, { id: 1 });
  await click();
  assert.equal(env.store.appPassword, 'p');
  assert.deepEqual(env.lastToast(), [msg('flyout_authFailedRetry'), 'error']);
  await click();
  assert.equal(env.store.appPassword, undefined);
  assert.deepEqual(env.lastToast(), [msg('flyout_authFailed'), 'error']);
  assert.deepEqual(env.notes.at(-1), [msg('notification_defaultTitle'), msg('saveDialog_authFailed')]);
});

test('a successful save resets the 401 counter', async () => {
  let status = 401;
  env.fetchImpl = async () => new Response('{}', { status });
  const click = () => env.ev.clicked.fire({ menuItemId: 'merlin-send-link', linkUrl: 'https://ex.org/a' }, { id: 1 });
  await click();
  status = 201;
  await click();
  status = 401;
  await click();
  assert.equal(env.store.appPassword, 'p');
});

test('timeouts are reported as such', async () => {
  env.fetchImpl = async () => { throw new DOMException('timed out', 'TimeoutError'); };
  await env.ev.clicked.fire({ menuItemId: 'merlin-send-link', linkUrl: 'https://ex.org/a' }, { id: 1 });
  assert.deepEqual(env.lastToast(), [msg('flyout_timeout'), 'error']);
  assert.ok(env.fetches.at(-1)[1].signal instanceof AbortSignal);
});

test('http:// server URLs are refused before any request', async () => {
  await env.login({ nextcloudUrl: 'http://cloud.example.com' });
  await env.ev.clicked.fire({ menuItemId: 'merlin-send-link', linkUrl: 'https://ex.org/a' }, { id: 1 });
  assert.equal(env.fetches.length, 0);
  assert.deepEqual(env.lastToast(), [msg('flyout_httpBlocked'), 'error']);
});

test('missing host permission points to the settings instead of saving', async () => {
  env.permissionGranted = false;
  await env.ev.clicked.fire({ menuItemId: 'merlin-send-link', linkUrl: 'https://ex.org/a' }, { id: 1 });
  assert.equal(env.fetches.length, 0);
  assert.deepEqual(env.lastToast(), [msg('notification_needsPermission'), 'error']);
  assert.deepEqual(env.notes.at(-1), ['openOptions']);
});

test('page with tags: dialog is centered over the browser window and the entry holds no credentials', async () => {
  await env.login({ nextcloudUrl: 'https://srv.example.com', backendKind: 'standalone' });
  env.fetchImpl = async (u, o) => {
    if (u.endsWith('/api/tags') && o.method === 'GET') return new Response(JSON.stringify([{ id: 1, name: 'News' }]));
    if (u.endsWith('/api/tags')) return new Response('', { status: 500 });
    return new Response('{}', { status: 201 });
  };
  await env.ev.clicked.fire({ menuItemId: 'merlin-save-page-tags' }, { id: 4, url: 'https://ex.org/p', windowId: 3 });
  const win = env.windows.at(-1);
  assert.equal(win.type, 'popup');
  assert.match(win.url, /^chrome-extension:\/\/x\/save-dialog\.html\?id=/);
  assert.deepEqual([win.width, win.height, win.left, win.top], [460, 640, 670, 230]);
  const key = Object.keys(env.store).find(k => k.startsWith('_merlinPendingSave_'));
  assert.deepEqual(env.store[key], { url: 'https://ex.org/p', tabId: 4, isPage: true, windowId: 77 });

  await env.ev.msg.fire({ type: 'merlin:saveWithTags', saveId: key.split('_').pop(), tags: ['news', 'Neu'] }, { id: 'me' }, () => {});
  await tick();
  assert.equal(env.fetches.at(-1)[0], 'https://srv.example.com/api/articles');
  assert.deepEqual(env.lastBody(), { url: 'https://ex.org/p', tagIds: [1], html: '<html>page</html>' });
  assert.deepEqual(env.lastToast(), [msg('flyout_articleAddedTagsFailed', ['Neu']), 'success']);
  assert.ok(!(key in env.store));
});

test('dialog bounds Chrome rejects fall back to default placement, not to a save without tags', async () => {
  const create = env.run('chrome.windows.create');
  env.run('chrome.windows').create = async (o) => {
    if ('left' in o) throw new Error('Invalid value for bounds.');
    return create(o);
  };
  await env.ev.clicked.fire({ menuItemId: 'merlin-send-link-tags', linkUrl: 'https://ex.org/a' }, { id: 4, windowId: 3 });
  assert.equal(env.fetches.length, 0);
  const win = env.windows.at(-1);
  assert.deepEqual([win.width, win.height, win.left, win.top], [460, 640, undefined, undefined]);
});

test('Nextcloud: tags are sent by name', async () => {
  await env.ev.clicked.fire({ menuItemId: 'merlin-send-link-tags', linkUrl: 'https://ex.org/a' }, { id: 4, windowId: 3 });
  const key = Object.keys(env.store).find(k => k.startsWith('_merlinPendingSave_'));
  await env.ev.msg.fire({ type: 'merlin:saveWithTags', saveId: key.split('_').pop(), tags: ['Technik', 'Linux'] }, { id: 'me' }, () => {});
  await tick();
  assert.deepEqual(env.lastBody(), { url: 'https://ex.org/a', tags: ['Technik', 'Linux'] });
  assert.deepEqual(env.lastToast(), [msg('flyout_articleAddedWithTags', ['Technik, Linux']), 'success']);
});

test('closing the dialog window removes its pending entry', async () => {
  await env.ev.clicked.fire({ menuItemId: 'merlin-send-link-tags', linkUrl: 'https://ex.org/a' }, { id: 4, windowId: 3 });
  await env.ev.removed.fire(77);
  await tick();
  assert.equal(Object.keys(env.store).filter(k => k.startsWith('_merlinPendingSave_')).length, 0);
});

test('messages are answered synchronously and only from this extension', async () => {
  let answer = null;
  await env.ev.msg.fire({ type: 'merlin:cancelLoginPoll' }, { id: 'me' }, r => { answer = r && { ...r }; });
  assert.deepEqual(answer, { ok: true });

  answer = null;
  await env.ev.msg.fire({ type: 'merlin:startLoginPoll', pollEndpoint: 'https://evil.example/p', pollToken: 't', serverUrl: 'https://evil.example' }, { id: 'other' }, r => { answer = r && { ...r }; });
  assert.equal(answer, null);
  assert.ok(!('_merlinLoginFlow' in env.store));
});

test('login flow rejects a poll endpoint on another origin', async () => {
  await env.run(`startBackgroundLoginPoll({ pollEndpoint: 'https://evil.example/poll', pollToken: 't', serverUrl: 'https://cloud.example.com' })`);
  assert.equal(env.store._merlinLoginFlowResult.error, msg('options_loginInvalidResponse'));
});

test('login flow keeps the entered origin and stores the new credentials', async () => {
  env.fetchImpl = async () => new Response(JSON.stringify({ server: 'https://evil.example', loginName: 'anna', appPassword: 'secret' }));
  await env.run(`startBackgroundLoginPoll({ pollEndpoint: 'https://cloud.example.com/login/v2/poll', pollToken: 't', serverUrl: 'https://cloud.example.com', backendKind: 'nextcloud', loginTabId: 9 })`);
  assert.ok(env.alarms.includes('merlin-login-poll'));
  await tick(2300);
  assert.deepEqual(env.store._merlinLoginFlowResult, { success: true, serverUrl: 'https://cloud.example.com', loginName: 'anna' });
  const creds = await env.run('getCredentials()');
  assert.equal(creds.nextcloudUrl, 'https://cloud.example.com');
  assert.equal(creds.appPassword, 'secret');
  assert.ok(!('_merlinLoginFlow' in env.store));
});

test('a new login refreshes the encrypted sync copy when sync is enabled', async () => {
  const passphrase = 'correct horse battery';
  await env.run(`chrome.storage.local.set({ encPassphrase: ${JSON.stringify(passphrase)} })`);
  await env.login({ appPassword: 'fresh' });
  assert.ok(env.sync.credEnc);
  const synced = await env.run(`merlinDecryptCredentials(${JSON.stringify(passphrase)}, ${JSON.stringify(env.sync.credEnc)})`);
  assert.equal(synced.appPassword, 'fresh');
  assert.ok(!JSON.stringify(env.sync).includes('fresh'));
});

test('without a passphrase nothing is synced', () => {
  assert.deepEqual(env.sync, {});
});

test('an expired stored login flow ends with a timeout after the worker was stopped', async () => {
  env.store._merlinLoginFlow = { active: true, pollEndpoint: 'https://cloud.example.com/p', pollToken: 't', serverUrl: 'https://cloud.example.com', deadline: Date.now() - 1 };
  await env.ev.alarm.fire({ name: 'merlin-login-poll' });
  await tick();
  assert.equal(env.store._merlinLoginFlowResult.error, msg('options_loginTimeout'));
  assert.ok(!('_merlinLoginFlow' in env.store));
});

test('migration moves plain-text credentials out of storage.sync', async () => {
  env.sync.appPassword = 'old';
  env.sync.username = 'legacy';
  env.sync.credEnc = { keep: true };
  await env.ev.installed.fire({ reason: 'update' });
  assert.equal(env.store.appPassword, 'old');
  assert.equal(env.store.username, 'legacy');
  assert.deepEqual(env.sync, { credEnc: { keep: true } });
});

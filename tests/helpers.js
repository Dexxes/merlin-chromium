'use strict';

// Test helpers: a fake chrome.* extension API for the extension pages
// (injected into Chromium via Playwright) and the message lookup that
// chrome.i18n.getMessage performs.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function readMessages(lang) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, '_locales', lang, 'messages.json'), 'utf8'));
}

// chrome.i18n.getMessage with $NAME$ placeholders mapped onto $1/$2 subs.
function makeGetMessage(msgs) {
  return (key, subs) => {
    const m = msgs[key];
    if (!m) return '';
    let s = m.message;
    subs = subs == null ? [] : [].concat(subs);
    for (const [name, p] of Object.entries(m.placeholders || {})) {
      const i = Number(p.content.slice(1)) - 1;
      s = s.replace(new RegExp(`\\$${name}\\$`, 'gi'), subs[i] ?? '');
    }
    return s;
  };
}

// Init script for extension pages. `local` and `sync` seed the two storage
// areas. Records sent messages in window.__sent, permission requests in
// window.__perm and opened windows in window.__opened.
function pageInitScript(lang, { local = {}, sync = {} } = {}) {
  return `
    window.__sent = []; window.__perm = []; window.__opened = [];
    window.open = (...args) => { window.__opened.push(args); return null; };
    const __listeners = [];
    const __area = (name, store) => ({
      __store: store,
      get: async (keys) => {
        if (keys == null) return { ...store };
        const out = {};
        for (const k of [].concat(keys)) if (k in store) out[k] = store[k];
        return out;
      },
      set: async (o) => {
        Object.assign(store, o);
        const changes = {};
        for (const k in o) changes[k] = { newValue: o[k] };
        __listeners.forEach(l => l(changes, name));
      },
      remove: async (keys) => { for (const k of [].concat(keys)) delete store[k]; },
    });
    const __getMessage = (${makeGetMessage.toString()})(${JSON.stringify(readMessages(lang))});
    window.chrome = {
      i18n: { getUILanguage: () => '${lang}', getMessage: __getMessage },
      storage: {
        local: __area('local', ${JSON.stringify(local)}),
        sync: __area('sync', ${JSON.stringify(sync)}),
        onChanged: { addListener: l => __listeners.push(l) },
      },
      runtime: { id: 'me', sendMessage: async (m) => { window.__sent.push(m); return { ok: true }; }, getURL: p => p },
      permissions: { request: async (o) => { window.__perm.push(o); return true; } },
      tabs: { create: async () => ({ id: 5 }) },
      notifications: { create: async () => {} },
    };
  `;
}

function fileUrl(page) {
  return `file://${path.join(ROOT, page)}`;
}

module.exports = { ROOT, readMessages, makeGetMessage, pageInitScript, fileUrl };

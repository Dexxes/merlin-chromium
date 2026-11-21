'use strict';

// Static checks that catch packaging mistakes without running Chrome:
// icon sizes, missing translations, files missing from the store .zip,
// Firefox-only manifest keys.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ROOT, readMessages } = require('./helpers');

const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const manifest = JSON.parse(read('manifest.json'));
const sourceFiles = fs.readdirSync(ROOT).filter(f => /\.(js|html)$/.test(f));

function pngSize(file) {
  const buf = fs.readFileSync(path.join(ROOT, file));
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

// Scripts the service worker pulls in with importScripts().
function workerScripts() {
  const src = read(manifest.background.service_worker);
  const imported = [...src.matchAll(/importScripts\(([^)]*)\)/g)]
    .flatMap(m => [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]));
  return [manifest.background.service_worker, ...imported];
}

test('every manifest icon has the pixel size it is declared with', () => {
  const declared = [
    ...Object.entries(manifest.icons),
    ...Object.entries(manifest.action.default_icon),
  ];
  for (const [size, file] of declared) {
    assert.deepEqual(pngSize(file), [Number(size), Number(size)], file);
  }
});

test('manifest is Chrome MV3 without Firefox-only keys', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(typeof manifest.background.service_worker, 'string');
  assert.equal(manifest.background.scripts, undefined);
  assert.equal(manifest.browser_specific_settings, undefined);
  // No standing host access: the server's origin is requested at runtime.
  assert.equal(manifest.host_permissions, undefined);
  assert.ok(!manifest.permissions.includes('tabs'));
});

test('de and en have the same message names', () => {
  assert.deepEqual(Object.keys(readMessages('de')).sort(), Object.keys(readMessages('en')).sort());
});

test('every message used in code, HTML and manifest exists', () => {
  const used = new Set();
  for (const m of JSON.stringify(manifest).matchAll(/__MSG_(\w+)__/g)) used.add(m[1]);
  for (const f of sourceFiles) {
    const src = read(f);
    for (const m of src.matchAll(/'((?:flyout|notification|options|saveDialog|contextMenu|passphrase)_\w+)'/g)) used.add(m[1]);
    for (const m of src.matchAll(/\bt\('(\w+)'/g)) used.add(m[1]);
    for (const m of src.matchAll(/data-i18n(?:-placeholder|-title)?="(\w+)"/g)) used.add(m[1]);
  }
  assert.ok(used.size > 50, `only ${used.size} keys found — is the pattern still right?`);
  for (const lang of ['de', 'en']) {
    const msgs = readMessages(lang);
    const missing = [...used].filter(k => !msgs[k]);
    assert.deepEqual(missing, [], `missing in ${lang}`);
  }
});

test('the store .zip includes every script the extension loads', () => {
  const build = read('tools/build-zip.ps1');
  const loaded = new Set(workerScripts());
  for (const f of sourceFiles.filter(f => f.endsWith('.html'))) {
    loaded.add(f);
    for (const m of read(f).matchAll(/<script src="([^"]+)"/g)) loaded.add(m[1]);
  }
  for (const f of loaded) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} does not exist`);
    assert.ok(build.includes(`'${f}'`), `${f} missing from tools/build-zip.ps1`);
  }
});

test('no browser.* namespace left over from the Firefox code', () => {
  for (const f of sourceFiles.filter(f => f.endsWith('.js'))) {
    assert.doesNotMatch(read(f), /\bbrowser\.(?:runtime|storage|i18n|tabs|windows|permissions|scripting|notifications|alarms|contextMenus)\b/, f);
  }
});

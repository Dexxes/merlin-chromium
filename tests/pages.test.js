'use strict';

// Loads save-dialog.html and options.html in headless Chromium with a fake
// chrome.* extension API (see helpers.js).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { pageInitScript, fileUrl, readMessages, makeGetMessage } = require('./helpers');

const de = makeGetMessage(readMessages('de'));
const en = makeGetMessage(readMessages('en'));

const CREDS = { nextcloudUrl: 'https://cloud.example.com', username: 'u', appPassword: 'p', backendKind: 'nextcloud' };

let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

async function openPage(lang, stores) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e));
  await page.addInitScript(pageInitScript(lang, stores));
  page.assertNoErrors = () => assert.deepEqual(errors, []);
  return page;
}

const statusIs = (page, text) =>
  page.waitForFunction(t => document.getElementById('statusText').textContent === t, text);

const TAGS = [
  { id: 1, name: 'Technik', parentId: null }, { id: 2, name: 'Linux', parentId: 1 },
  { id: 3, name: 'Kernel', parentId: 2 }, { id: 4, name: 'News', parentId: null },
  { id: 5, name: 'Österreich', parentId: 4 },
];

test('save dialog: tag tree, filter while typing, selection rules', async () => {
  const page = await openPage('de', {
    local: { ...CREDS, _merlinPendingSave_abc: { url: 'https://example.org/article', tabId: 1, isPage: false, windowId: 9 } },
  });
  let auth = null;
  await page.route('https://cloud.example.com/**', r => {
    auth = r.request().headers().authorization;
    r.fulfill({ json: TAGS });
  });
  await page.goto(fileUrl('save-dialog.html') + '?id=abc');
  await page.waitForSelector('.tag-row');

  assert.equal(auth, `Basic ${Buffer.from('u:p').toString('base64')}`);
  assert.equal(await page.textContent('#urlDisplay'), 'https://example.org/article');
  const visible = () => page.$$eval('.tag-row:not([hidden]) .tag-name', els => els.map(e => e.textContent));
  const selected = () => page.$$eval('.tag-row.selected .tag-name', els => els.map(e => e.textContent));
  assert.deepEqual(await visible(), ['News', 'Österreich', 'Technik', 'Linux', 'Kernel']);

  // Only the text after the last comma filters; parents stay as dimmed context.
  await page.fill('#tagsInput', 'neu, kern');
  assert.deepEqual(await visible(), ['Technik', 'Linux', 'Kernel']);
  assert.equal(await page.$$eval('.tag-row.context-only:not([hidden])', e => e.length), 2);
  await page.fill('#tagsInput', 'oster');
  assert.deepEqual(await visible(), ['News', 'Österreich']);
  await page.fill('#tagsInput', 'zzz');
  assert.equal(await page.textContent('.tags-no-match'), de('saveDialog_noMatchingTags'));
  assert.equal(await page.isVisible('.tags-no-match'), true);

  // Picking a filtered tag replaces the typed fragment and selects its parents.
  await page.fill('#tagsInput', 'neu, kern');
  await page.click('.tag-row:has-text("Kernel")');
  assert.equal(await page.inputValue('#tagsInput'), 'neu, ');
  assert.deepEqual(await selected(), ['Technik', 'Linux', 'Kernel']);

  // Deselecting a tag also deselects its sub-tags.
  await page.click('.tag-row:has-text("Linux")');
  assert.deepEqual(await selected(), ['Technik']);

  await page.click('.tag-row:has-text("Kernel")');
  await page.focus('#tagsInput');
  await page.keyboard.press('Enter');
  const sent = await page.evaluate(() => window.__sent);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'merlin:saveWithTags');
  assert.equal(sent[0].saveId, 'abc');
  assert.deepEqual([...sent[0].tags].sort(), ['Kernel', 'Linux', 'Technik', 'neu']);
  page.assertNoErrors();
  await page.close();
});

test('options: URL field prefilled with https://, http refused, login flow starts', async () => {
  const page = await openPage('de');
  let loginUrl = null;
  await page.route('**/login/v2', r => {
    loginUrl = r.request().url();
    r.fulfill({ json: { login: 'https://cloud.example.com/login/v2/flow/x', poll: { token: 'tok', endpoint: 'https://cloud.example.com/login/v2/poll' } } });
  });
  await page.goto(fileUrl('options.html'));
  await page.waitForFunction(() => document.getElementById('nextcloudUrl').value === 'https://');
  assert.equal(await page.textContent('#statusText'), de('options_welcome'));
  assert.equal(await page.title(), de('options_pageTitleExtension'));
  assert.equal(await page.isVisible('#passphraseSection'), false);

  await page.click('#nextcloudUrl');
  await page.waitForTimeout(50);
  assert.equal(await page.$eval('#nextcloudUrl', e => e.selectionStart), 'https://'.length);
  await page.keyboard.insertText('https://cloud.example.com/');
  assert.equal(await page.inputValue('#nextcloudUrl'), 'https://cloud.example.com/');

  await page.fill('#nextcloudUrl', 'http://cloud.example.com');
  await page.click('#loginFlowBtn');
  assert.equal(await page.textContent('#statusText'), de('options_httpBlocked'));

  await page.fill('#nextcloudUrl', 'cloud.example.com/');
  await page.click('#loginFlowBtn');
  await page.waitForFunction(() => window.__sent.length > 0);
  assert.equal(loginUrl, 'https://cloud.example.com/index.php/login/v2');
  const sent = await page.evaluate(() => window.__sent[0]);
  assert.equal(sent.type, 'merlin:startLoginPoll');
  assert.equal(sent.serverUrl, 'https://cloud.example.com');
  assert.deepEqual(await page.evaluate(() => window.__perm[0]), { origins: ['https://cloud.example.com/*'] });
  page.assertNoErrors();
  await page.close();
});

test('options: http://localhost is allowed for local development', async () => {
  const page = await openPage('en');
  let loginUrl = null;
  await page.route('**/login/v2', r => {
    loginUrl = r.request().url();
    r.fulfill({ json: { login: 'http://localhost:8080/login/v2/flow/x', poll: { token: 'tok', endpoint: 'http://localhost:8080/login/v2/poll' } } });
  });
  await page.goto(fileUrl('options.html'));
  await page.waitForFunction(() => document.getElementById('nextcloudUrl').value === 'https://');
  await page.check('#backendKindStandalone');
  await page.fill('#nextcloudUrl', 'http://localhost:8080');
  await page.click('#loginFlowBtn');
  await page.waitForFunction(() => window.__sent.length > 0);
  assert.equal(loginUrl, 'http://localhost:8080/login/v2');
  page.assertNoErrors();
  await page.close();
});

test('options: standalone wording and localized labels', async () => {
  const page = await openPage('en');
  await page.goto(fileUrl('options.html'));
  await page.waitForFunction(() => document.getElementById('nextcloudUrl').value === 'https://');
  await page.check('#backendKindStandalone');
  assert.equal((await page.textContent('#loginFlowBtn span')).trim(), en('options_loginButtonStandalone'));
  assert.equal(await page.textContent('#statusText'), en('options_welcomeStandalone'));
  assert.equal(await page.textContent('[data-i18n="options_backendStandalone"]'), en('options_backendStandalone'));
  assert.equal(await page.textContent('.source-link'), en('options_sourceCodeLink'));
  assert.equal(await page.getAttribute('.source-link', 'href'), 'https://github.com/dexxes/merlin-chrome');
  page.assertNoErrors();
  await page.close();
});

test('options: login response with a poll endpoint on another origin is rejected', async () => {
  const page = await openPage('en');
  await page.route('**/login/v2', r => r.fulfill({ json: { login: 'https://evil.example/x', poll: { token: 't', endpoint: 'https://evil.example/poll' } } }));
  await page.goto(fileUrl('options.html'));
  await page.waitForFunction(() => document.getElementById('nextcloudUrl').value === 'https://');
  await page.fill('#nextcloudUrl', 'https://cloud.example.com');
  await page.click('#loginFlowBtn');
  await statusIs(page, en('options_loginInvalidResponse'));
  assert.equal(await page.evaluate(() => window.__sent.length), 0);
  await page.close();
});

test('options: a login that finished while the page was closed is reported on load', async () => {
  const page = await openPage('en', {
    local: { ...CREDS, _merlinLoginFlowResult: { success: true, serverUrl: 'https://cloud.example.com', loginName: 'anna' } },
  });
  await page.goto(fileUrl('options.html'));
  await statusIs(page, en('options_loggedInAs', ['anna']));
  assert.equal(await page.evaluate(() => '_merlinLoginFlowResult' in chrome.storage.local.__store), false);
  assert.equal(await page.isVisible('#closeTabBtn'), true);
  page.assertNoErrors();
  await page.close();
});

test('options: connection test only uses the stored URL', async () => {
  const page = await openPage('en', { local: CREDS });
  const requests = [];
  await page.route(/^https:\/\//, r => { requests.push(r.request().url()); r.fulfill({ json: {} }); });
  await page.goto(fileUrl('options.html'));
  await page.waitForFunction(() => document.getElementById('nextcloudUrl').value === 'https://cloud.example.com');

  await page.click('#testBtn');
  await statusIs(page, en('options_testSuccess'));
  assert.deepEqual(requests, ['https://cloud.example.com/index.php/apps/merlin/api/v1/get']);

  // Another URL typed in: the app password must not go there.
  await page.fill('#nextcloudUrl', 'https://other.example.com');
  await page.click('#testBtn');
  assert.equal(await page.textContent('#statusText'), en('options_urlChangedLoginAgain'));
  assert.equal(requests.length, 1);
  page.assertNoErrors();
  await page.close();
});

test('options: encrypted sync can be enabled, unlocked on another device, and is removed on disconnect', async () => {
  // Device A: logged in, enables sync with a passphrase.
  const a = await openPage('en', { local: { ...CREDS } });
  await a.goto(fileUrl('options.html'));
  await a.waitForFunction(() => document.getElementById('passphraseSection').style.display === 'block');
  assert.equal((await a.textContent('#passphraseBtn span')).trim(), en('passphrase_enableButton'));
  await a.fill('#passphraseInput', 'short');
  await a.click('#passphraseBtn');
  assert.equal(await a.textContent('#statusText'), en('passphrase_tooShort'));
  await a.fill('#passphraseInput', 'correct horse battery');
  await a.click('#passphraseBtn');
  await statusIs(a, en('passphrase_enabled'));
  const credEnc = await a.evaluate(() => chrome.storage.sync.__store.credEnc);
  assert.ok(credEnc?.ciphertext);
  assert.ok(!JSON.stringify(credEnc).includes('"p"'), 'app password must not be synced in plain text');
  assert.equal((await a.textContent('#passphraseBtn span')).trim(), en('passphrase_changeButton'));

  // Device B: nothing local, only the synced ciphertext.
  const b = await openPage('en', { sync: { credEnc } });
  await b.goto(fileUrl('options.html'));
  await b.waitForFunction(() => document.getElementById('passphraseSection').style.display === 'block');
  assert.equal((await b.textContent('#passphraseBtn span')).trim(), en('passphrase_unlockButton'));
  await b.fill('#passphraseInput', 'wrong passphrase');
  await b.click('#passphraseBtn');
  await statusIs(b, en('passphrase_wrongPassphrase'));
  await b.fill('#passphraseInput', 'correct horse battery');
  await b.click('#passphraseBtn');
  await statusIs(b, en('passphrase_unlockedAs', ['u']));
  assert.equal(await b.inputValue('#nextcloudUrl'), 'https://cloud.example.com');
  const local = await b.evaluate(() => chrome.storage.local.__store);
  assert.equal(local.appPassword, 'p');
  assert.deepEqual(await b.evaluate(() => window.__perm[0]), { origins: ['https://cloud.example.com/*'] });

  // Disconnect clears the local credentials and the synced copy.
  await b.click('#logoutBtn');
  await statusIs(b, en('options_disconnected'));
  assert.equal(await b.evaluate(() => chrome.storage.local.__store.appPassword), undefined);
  assert.equal(await b.evaluate(() => chrome.storage.sync.__store.credEnc), undefined);
  assert.equal(await b.isVisible('#logoutBtn'), false);
  a.assertNoErrors();
  b.assertNoErrors();
  await a.close();
  await b.close();
});

test('options: app password link opens the server settings for the selected backend', async () => {
  const page = await openPage('en', { local: CREDS });
  await page.goto(fileUrl('options.html'));
  await page.waitForFunction(() => document.getElementById('nextcloudUrl').value === 'https://cloud.example.com');
  await page.click('#openSecurityLink');
  await page.check('#backendKindStandalone');
  await page.click('#openSecurityLink');
  const opened = await page.evaluate(() => window.__opened.map(a => a[0]));
  assert.deepEqual(opened, [
    'https://cloud.example.com/index.php/settings/user/security',
    'https://cloud.example.com/account',
  ]);
  page.assertNoErrors();
  await page.close();
});

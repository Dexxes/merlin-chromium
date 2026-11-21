'use strict';

// ─── Merlin Credential Encryption ────────────────────────────────────────────
//
// Goal: storage.sync may only ever hold the app password as ciphertext,
// never as plain text. The AES key is derived via PBKDF2 from a passphrase
// that is NEVER synced — it lives in storage.local on each device only.
// Without it, the ciphertext in storage.sync is worthless to anyone with
// access to the sync servers.
//
// Used by common.js (setCredentials keeps the synced copy current) and by
// options.js (enabling sync, unlocking a synced login on a new device).

const MERLIN_PBKDF2_ITERATIONS = 200000;

function _merlinToBase64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function _merlinFromBase64(b64) {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

async function merlinDeriveKey(passphrase, saltBytes) {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: saltBytes, iterations: MERLIN_PBKDF2_ITERATIONS, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

// credsObj: { nextcloudUrl, username, appPassword, backendKind }
async function merlinEncryptCredentials(passphrase, credsObj) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv   = crypto.getRandomValues(new Uint8Array(12));
  const key  = await merlinDeriveKey(passphrase, salt);
  const plaintext  = new TextEncoder().encode(JSON.stringify(credsObj));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  // Salt and IV are not secret (standard for AES-GCM) and may sit next to
  // the ciphertext in storage.sync.
  return {
    v:          1,
    salt:       _merlinToBase64(salt),
    iv:         _merlinToBase64(iv),
    ciphertext: _merlinToBase64(ciphertext),
  };
}

async function merlinDecryptCredentials(passphrase, encBlob) {
  const salt = _merlinFromBase64(encBlob.salt);
  const iv   = _merlinFromBase64(encBlob.iv);
  const key  = await merlinDeriveKey(passphrase, salt);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    _merlinFromBase64(encBlob.ciphertext),
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}

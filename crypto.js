'use strict';

// ─── Merlin Credential Encryption ────────────────────────────────────────────
//
// Schutzziel: storage.sync darf das Nextcloud-App-Passwort nur noch als
// Chiffretext enthalten, niemals im Klartext. Der AES-Schlüssel wird per
// PBKDF2 aus einer Passphrase abgeleitet, die NIE synchronisiert wird —
// sie lebt ausschließlich in storage.local (pro Gerät). Ohne diese
// Passphrase ist der in storage.sync liegende Chiffretext für einen
// Angreifer auf dem Sync-Server (Mozilla/Google) wertlos.
//
// Nur in options.js verwendet (dort wird ver-/entschlüsselt); background.js
// braucht diese Datei nicht, da es nur storage.local/.sync-Keys löscht.

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

// credsObj: { nextcloudUrl, username, appPassword }
async function merlinEncryptCredentials(passphrase, credsObj) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv   = crypto.getRandomValues(new Uint8Array(12));
  const key  = await merlinDeriveKey(passphrase, salt);
  const plaintext  = new TextEncoder().encode(JSON.stringify(credsObj));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  // salt/iv sind nicht geheim (Standard bei AES-GCM) — dürfen mit dem
  // Chiffretext zusammen in storage.sync liegen.
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

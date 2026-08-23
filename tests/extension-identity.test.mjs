import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import test from 'node:test';
import { VERSION } from '../src/contracts.mjs';
import {
  createIdentityNonce,
  createManagerIdentityProof,
  createPairingApprovalCode,
  createPairingCode,
  generateManagerIdentity,
  MANAGER_SERVICE
} from '../src/lib/manager-identity.mjs';
import {
  parsePairingCode,
  trustedManagerFetch,
  verifyPairingManagerIdentity
} from '../extension/manager-identity.js';
import { runSessionTransfer } from '../extension/session-transfer.js';

const ORIGIN = 'http://127.0.0.1:19946';
const EXTENSION_ID = 'a'.repeat(32);
const EXTENSION_TOKEN = `extension-${'t'.repeat(40)}`;

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function trusted(identity) {
  return {
    algorithm: identity.algorithm,
    publicKey: identity.publicKey,
    fingerprint: identity.fingerprint,
    origin: ORIGIN,
    service: MANAGER_SERVICE,
    version: VERSION,
    host: '127.0.0.1',
    port: 19_946
  };
}

test('extension pairing code carries a full 256-bit Manager fingerprint', () => {
  const identity = generateManagerIdentity();
  const code = createPairingCode(createPairingApprovalCode(), identity.fingerprint);
  assert.match(code, /^ETM1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(parsePairingCode(code), {
    pairingCode: code,
    approvalCode: code.split('.')[1],
    fingerprint: identity.fingerprint
  });
});

test('fake endpoint sees no pairing code before proving the embedded fingerprint', async () => {
  const pinnedIdentity = generateManagerIdentity();
  const attackerIdentity = generateManagerIdentity();
  const pairingCode = createPairingCode(createPairingApprovalCode(), pinnedIdentity.fingerprint);
  const captured = [];
  const fetchImpl = async (url, options) => {
    captured.push({ url: String(url), body: options.body, headers: options.headers });
    const request = JSON.parse(options.body);
    return jsonResponse(createManagerIdentityProof(attackerIdentity, {
      service: MANAGER_SERVICE,
      version: VERSION,
      apiVersion: 1,
      host: '127.0.0.1',
      port: 19_946,
      nonce: request.nonce
    }));
  };

  await assert.rejects(verifyPairingManagerIdentity({
    pairingCode,
    origin: ORIGIN,
    version: VERSION,
    extensionId: EXTENSION_ID,
    fetchImpl,
    cryptoImpl: webcrypto
  }), { code: 'MANAGER_IDENTITY_MISMATCH' });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].url, `${ORIGIN}/v1/identity/challenge`);
  assert.equal(JSON.stringify(captured).includes(pairingCode), false);
});

test('fake endpoint cannot capture extension token or session data with the wrong identity key', async () => {
  const pinnedIdentity = generateManagerIdentity();
  const attackerIdentity = generateManagerIdentity();
  const secretBundle = {
    origin: 'https://example.com',
    cookies: [{ name: 'session', value: 'cookie-secret' }],
    localStorage: [{ name: 'access', value: 'storage-secret' }]
  };
  const captured = [];
  const fetchImpl = async (url, options) => {
    captured.push({
      url: String(url),
      authorization: options.headers.Authorization,
      body: options.body
    });
    const request = JSON.parse(options.body);
    return jsonResponse(createManagerIdentityProof(attackerIdentity, {
      service: MANAGER_SERVICE,
      version: VERSION,
      apiVersion: 1,
      host: '127.0.0.1',
      port: 19_946,
      nonce: request.nonce
    }));
  };

  await assert.rejects(trustedManagerFetch({
    origin: ORIGIN,
    version: VERSION,
    extensionId: EXTENSION_ID,
    trustedIdentity: trusted(pinnedIdentity),
    token: EXTENSION_TOKEN,
    path: '/v1/profiles/profile/session',
    method: 'POST',
    body: secretBundle,
    fetchImpl,
    cryptoImpl: webcrypto
  }), { code: 'MANAGER_IDENTITY_MISMATCH' });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].url, `${ORIGIN}/v1/identity/challenge`);
  assert.equal(captured[0].authorization, undefined);
  assert.equal(JSON.stringify(captured).includes(EXTENSION_TOKEN), false);
  assert.equal(JSON.stringify(captured).includes('cookie-secret'), false);
  assert.equal(JSON.stringify(captured).includes('storage-secret'), false);
});

test('extension rejects a replayed signature before any authenticated request', async () => {
  const pinnedIdentity = generateManagerIdentity();
  const staleNonce = createIdentityNonce();
  const captured = [];
  const fetchImpl = async (url, options) => {
    captured.push({ url: String(url), authorization: options.headers.Authorization, body: options.body });
    return jsonResponse(createManagerIdentityProof(pinnedIdentity, {
      service: MANAGER_SERVICE,
      version: VERSION,
      apiVersion: 1,
      host: '127.0.0.1',
      port: 19_946,
      nonce: staleNonce
    }));
  };

  await assert.rejects(trustedManagerFetch({
    origin: ORIGIN,
    version: VERSION,
    extensionId: EXTENSION_ID,
    trustedIdentity: trusted(pinnedIdentity),
    token: EXTENSION_TOKEN,
    path: '/v1/profiles',
    fetchImpl,
    cryptoImpl: webcrypto
  }), { code: 'MANAGER_IDENTITY_BINDING_MISMATCH' });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].authorization, undefined);
  assert.equal(captured[0].body.includes(staleNonce), false);
});

test('session transfer re-inspects tab and origin before reading or sending data', async () => {
  const base = { tabId: 7, url: new URL('https://example.com/page') };
  for (const changed of [
    { tabId: 8, url: new URL('https://example.com/other') },
    { tabId: 7, url: new URL('https://other.example/page') }
  ]) {
    const calls = [];
    const sites = [base, changed];
    await assert.rejects(runSessionTransfer({
      profileId: 'profile_1',
      extensionId: EXTENSION_ID,
      inspectActiveSite: async () => sites.shift() || changed,
      verifyManagerIdentity: async () => { calls.push('identity'); },
      requestPermission: async () => { calls.push('permission'); return true; },
      removePermission: async () => { calls.push('remove'); return true; },
      readCookies: async () => { calls.push('cookies'); return []; },
      readLocalStorage: async () => { calls.push('storage'); return []; },
      sendSession: async () => { calls.push('send'); return {}; }
    }), { code: 'ACTIVE_SITE_CHANGED' });
    assert.deepEqual(calls, ['identity']);
  }
});

test('identity failure reads no page session data and requests no site permission', async () => {
  const calls = [];
  await assert.rejects(runSessionTransfer({
    profileId: 'profile_1',
    extensionId: EXTENSION_ID,
    inspectActiveSite: async () => ({ tabId: 7, url: new URL('https://example.com/') }),
    verifyManagerIdentity: async () => {
      calls.push('identity');
      throw Object.assign(new Error('fake Manager'), { code: 'MANAGER_IDENTITY_MISMATCH' });
    },
    requestPermission: async () => { calls.push('permission'); return true; },
    removePermission: async () => { calls.push('remove'); return true; },
    readCookies: async () => { calls.push('cookies'); return [{ value: 'secret' }]; },
    readLocalStorage: async () => { calls.push('storage'); return [{ value: 'secret' }]; },
    sendSession: async () => { calls.push('send'); return {}; }
  }), { code: 'MANAGER_IDENTITY_MISMATCH' });
  assert.deepEqual(calls, ['identity']);
});

test('temporary site permission is revoked and sensitive arrays are cleared on success and failure', async () => {
  for (const shouldFail of [false, true]) {
    const calls = [];
    const cookies = [{ name: 'session', value: 'secret' }];
    const localStorage = [{ name: 'access', value: 'secret' }];
    const result = runSessionTransfer({
      profileId: 'profile_1',
      extensionId: EXTENSION_ID,
      inspectActiveSite: async () => ({ tabId: 7, url: new URL('https://example.com/page') }),
      verifyManagerIdentity: async () => { calls.push('identity'); },
      requestPermission: async (origin) => { calls.push(['permission', origin]); return true; },
      removePermission: async (origin) => { calls.push(['remove', origin]); return true; },
      readCookies: async () => cookies,
      readLocalStorage: async () => localStorage,
      sendSession: async () => {
        calls.push('send');
        if (shouldFail) throw new Error('send failed');
        return { status: 'partial' };
      }
    });
    if (shouldFail) await assert.rejects(result, /send failed/);
    else assert.equal((await result).status, 'partial');
    assert.equal(calls.some((entry) => Array.isArray(entry) && entry[0] === 'remove'), true);
    assert.equal(cookies.length, 0);
    assert.equal(localStorage.length, 0);
  }
});

test('temporary site permission removal is attempted when permission is denied', async () => {
  const calls = [];
  await assert.rejects(runSessionTransfer({
    profileId: 'profile_1',
    extensionId: EXTENSION_ID,
    inspectActiveSite: async () => ({ tabId: 7, url: new URL('https://example.com/') }),
    verifyManagerIdentity: async () => {},
    requestPermission: async () => { calls.push('request'); return false; },
    removePermission: async () => { calls.push('remove'); return true; },
    readCookies: async () => { calls.push('cookies'); return []; },
    readLocalStorage: async () => { calls.push('storage'); return []; },
    sendSession: async () => { calls.push('send'); return {}; }
  }), { code: 'SITE_PERMISSION_DENIED' });
  assert.deepEqual(calls, ['request', 'remove']);
});

test('session transfer reports a hard failure when temporary permission remains granted', async () => {
  const calls = [];
  await assert.rejects(runSessionTransfer({
    profileId: 'profile_1',
    extensionId: EXTENSION_ID,
    inspectActiveSite: async () => ({ tabId: 7, url: new URL('https://example.com/') }),
    verifyManagerIdentity: async () => {},
    requestPermission: async () => true,
    removePermission: async () => { calls.push('remove'); return false; },
    containsPermission: async () => { calls.push('contains'); return true; },
    readCookies: async () => [],
    readLocalStorage: async () => [],
    sendSession: async () => ({ status: 'partial' })
  }), { code: 'SITE_PERMISSION_REVOKE_FAILED' });
  assert.deepEqual(calls, ['remove', 'contains']);
});

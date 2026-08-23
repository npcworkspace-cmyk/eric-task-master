import assert from 'node:assert/strict';
import test from 'node:test';
import { runSessionImport } from '../src/runtime/import-session-worker.mjs';

const ORIGIN = 'https://www.example.test';

function cookieFromInput(cookie) {
  const url = cookie.url ? new URL(cookie.url) : null;
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain || url.hostname,
    path: cookie.path || url.pathname || '/',
    expires: cookie.expires ?? -1,
    httpOnly: Boolean(cookie.httpOnly),
    secure: Boolean(cookie.secure),
    sameSite: cookie.sameSite || 'Lax',
    ...(cookie.partitionKey ? { partitionKey: cookie.partitionKey } : {})
  };
}

function createHarness({
  failImportedWrite = false,
  failRollbackWrite = false,
  failFirstVerification = false,
  withPartitionCollision = false
} = {}) {
  const initialCookies = [{
    name: 'old-auth',
    value: 'old-cookie-secret',
    domain: '.example.test',
    path: '/',
    expires: 2_000_000_000,
    httpOnly: true,
    secure: true,
    sameSite: 'Lax'
  }, {
    name: 'old-path',
    value: 'old-path-secret',
    domain: 'www.example.test',
    path: '/private',
    expires: -1,
    httpOnly: false,
    secure: true,
    sameSite: 'Strict'
  }, {
    name: 'sibling-only',
    value: 'sibling-secret',
    domain: 'sibling.example.test',
    path: '/',
    expires: -1,
    httpOnly: false,
    secure: true,
    sameSite: 'Lax'
  }, {
    name: 'foreign',
    value: 'foreign-secret',
    domain: 'other.test',
    path: '/',
    expires: -1,
    httpOnly: false,
    secure: true,
    sameSite: 'Lax'
  }];
  if (withPartitionCollision) {
    initialCookies.push({
      name: 'old-auth',
      value: 'unrelated-partition-secret',
      domain: '.example.test',
      path: '/',
      expires: 2_000_000_000,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      partitionKey: 'https://unrelated.test'
    });
  }
  let cookies = structuredClone(initialCookies);
  const initialLocalStorage = new Map([
    ['old-access', 'old-storage-secret'],
    ['stale-account', 'stale-storage-secret']
  ]);
  let storage = new Map(initialLocalStorage);
  let currentUrl = 'about:blank';
  let addCookiesCalls = 0;
  let storageReads = 0;
  let closed = false;

  const page = {
    async route() {},
    async unroute() {},
    async goto(url) { currentUrl = url; },
    url() { return currentUrl; },
    async evaluate(_callback, entries) {
      if (Array.isArray(entries)) {
        storage = new Map(entries.map((entry) => [entry.name, entry.value]));
        return storage.size;
      }
      storageReads += 1;
      const value = [...storage].map(([name, entryValue]) => ({ name, value: entryValue }));
      if (failFirstVerification && storageReads === 2) {
        return [...value, { name: 'verification-fault', value: 'injected' }];
      }
      return value;
    }
  };
  const context = {
    pages() { return [page]; },
    async cookies() { return structuredClone(cookies); },
    async clearCookies(filter) {
      cookies = cookies.filter((cookie) => !(
        cookie.name === filter.name
        && cookie.domain === filter.domain
        && cookie.path === filter.path
      ));
    },
    async addCookies(nextCookies) {
      addCookiesCalls += 1;
      if (addCookiesCalls === 1 && failImportedWrite) throw new Error('write failed: token=write-secret');
      if (addCookiesCalls > 1 && failRollbackWrite) throw new Error('rollback failed: token=rollback-secret');
      for (const input of nextCookies) {
        const next = cookieFromInput(input);
        cookies = cookies.filter((cookie) => !(
          cookie.name === next.name
          && cookie.domain === next.domain
          && cookie.path === next.path
        ));
        cookies.push(next);
      }
    },
    async close() { closed = true; }
  };

  return {
    context,
    initialCookies,
    initialLocalStorage,
    state() {
      return {
        cookies: structuredClone(cookies),
        localStorage: new Map(storage),
        closed,
        addCookiesCalls
      };
    }
  };
}

function config() {
  return {
    profile: { userDataDir: 'fixture-profile' },
    bundle: {
      origin: ORIGIN,
      cookies: [{
        name: 'new-auth',
        value: 'new-cookie-secret',
        domain: '.example.test',
        path: '/',
        expirationDate: 2_100_000_000,
        httpOnly: true,
        secure: true,
        sameSite: 'lax'
      }, {
        name: 'new-path',
        value: 'new-path-cookie-secret',
        domain: 'www.example.test',
        path: '/private',
        hostOnly: true,
        expirationDate: 2_100_000_000,
        httpOnly: false,
        secure: true,
        sameSite: 'strict'
      }],
      localStorage: [{ name: 'new-access', value: 'new-storage-secret' }],
      source: { extensionId: 'fixture', tabUrl: `${ORIGIN}/account` }
    }
  };
}

function loader(context) {
  return async () => ({
    chromium: {
      async launchPersistentContext(_userDataDir, options) {
        assert.equal(options.headless, true);
        assert.equal(options.serviceWorkers, 'block');
        return context;
      }
    }
  });
}

function scopedCookieNames(cookies) {
  return cookies
    .filter((cookie) => (
      ['www.example.test', '.example.test'].includes(cookie.domain)
      && cookie.partitionKey !== 'https://unrelated.test'
    ))
    .map((cookie) => cookie.name)
    .sort();
}

function sortedCookies(cookies) {
  return structuredClone(cookies).sort((left, right) => (
    `${left.domain}\u0000${left.path}\u0000${left.name}`
      .localeCompare(`${right.domain}\u0000${right.path}\u0000${right.name}`)
  ));
}

test('session import replaces the complete origin state without leaving the old account merged', async () => {
  const harness = createHarness({ withPartitionCollision: true });
  const result = await runSessionImport(config(), { loadPlaywright: loader(harness.context) });
  const state = harness.state();

  assert.equal(result.status, 'partial');
  assert.equal(result.verification, 'storage_replaced_not_login_verified');
  assert.deepEqual(scopedCookieNames(state.cookies), ['new-auth', 'new-path']);
  assert.equal(state.cookies.some((cookie) => cookie.name === 'sibling-only'), true);
  assert.equal(state.cookies.some((cookie) => cookie.name === 'foreign'), true);
  assert.equal(state.cookies.some((cookie) => (
    cookie.name === 'old-auth'
    && cookie.partitionKey === 'https://unrelated.test'
    && cookie.value === 'unrelated-partition-secret'
  )), true);
  assert.deepEqual([...state.localStorage], [['new-access', 'new-storage-secret']]);
  assert.equal(state.closed, true);
  assert.doesNotMatch(JSON.stringify(result), /cookie-secret|storage-secret/);
});

test('a session write failure restores the exact previous cookies and localStorage', async () => {
  const harness = createHarness({ failImportedWrite: true });
  const error = await runSessionImport(config(), { loadPlaywright: loader(harness.context) })
    .then(() => null, (failure) => failure);
  const state = harness.state();

  assert.equal(error.code, 'SESSION_IMPORT_FAILED');
  assert.doesNotMatch(error.message, /write-secret|cookie-secret|storage-secret/);
  assert.deepEqual(sortedCookies(state.cookies), sortedCookies(harness.initialCookies));
  assert.deepEqual([...state.localStorage], [...harness.initialLocalStorage]);
  assert.equal(state.closed, true);
});

test('a verification failure rolls back before returning a hard failure', async () => {
  const harness = createHarness({ failFirstVerification: true });
  const error = await runSessionImport(config(), { loadPlaywright: loader(harness.context) })
    .then(() => null, (failure) => failure);
  const state = harness.state();

  assert.equal(error.code, 'SESSION_IMPORT_VERIFICATION_FAILED');
  assert.deepEqual(sortedCookies(state.cookies), sortedCookies(harness.initialCookies));
  assert.deepEqual([...state.localStorage], [...harness.initialLocalStorage]);
  assert.equal(state.closed, true);
});

test('a rollback write failure is explicit and never reported as import success', async () => {
  const harness = createHarness({ failImportedWrite: true, failRollbackWrite: true });
  const error = await runSessionImport(config(), { loadPlaywright: loader(harness.context) })
    .then(() => null, (failure) => failure);

  assert.equal(error.code, 'SESSION_IMPORT_ROLLBACK_FAILED');
  assert.equal(error.message, 'Session import failed and the previous origin state could not be restored');
  assert.doesNotMatch(error.message, /rollback-secret|cookie-secret|storage-secret/);
  assert.equal(harness.state().closed, true);
});

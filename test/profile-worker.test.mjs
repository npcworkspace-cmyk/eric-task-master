import assert from 'node:assert/strict';
import test from 'node:test';
import { closeProfileBrowserSession, runOpenProfile } from '../src/runtime/profile-worker.mjs';

test('manual Profile launch is always visible and uses its fixed engine', async () => {
  const controller = new AbortController();
  controller.abort();
  let launch;
  const context = {
    pages() { return [{}]; },
    browser() { return null; },
    async close() {}
  };
  await runOpenProfile({
    userDataDir: '/isolated/profile',
    headless: true,
    browserEngine: 'chrome'
  }, {
    signal: controller.signal,
    loadPlaywright: async () => ({
      chromium: {
        async launchPersistentContext(userDataDir, options) {
          launch = { userDataDir, options };
          return context;
        }
      }
    })
  });
  assert.deepEqual(launch, {
    userDataDir: '/isolated/profile',
    options: { channel: 'chrome', headless: false }
  });
});

test('manual Profile never falls back after a Chrome launch failure', async () => {
  let launches = 0;
  await runOpenProfile({
    userDataDir: '/isolated/profile',
    browserEngine: 'chrome'
  }, {
    signal: AbortSignal.abort(),
    loadPlaywright: async () => ({
      chromium: {
        async launchPersistentContext() {
          launches += 1;
          throw new Error('Chrome is unavailable');
        }
      }
    })
  });
  assert.equal(launches, 1);
});

test('profile cleanup falls back to authoritative browser close', async () => {
  let browserCloseCalls = 0;
  const context = {
    browser() {
      return {
        async close() {
          browserCloseCalls += 1;
        }
      };
    },
    async close() {
      throw new Error('context close failed');
    }
  };
  assert.equal(await closeProfileBrowserSession(context, 50), true);
  assert.equal(browserCloseCalls, 1);
});

test('profile cleanup fails closed when context and browser closure are both unconfirmed', async () => {
  const context = {
    browser() {
      return { async close() { throw new Error('browser close failed'); } };
    },
    async close() {
      throw new Error('context close failed');
    }
  };
  assert.equal(await closeProfileBrowserSession(context, 50), false);
});

test('profile cleanup never treats a malformed browser object as closed', async () => {
  const context = {
    browser() { return {}; },
    async close() { throw new Error('context close failed'); }
  };
  assert.equal(await closeProfileBrowserSession(context, 50), false);
});

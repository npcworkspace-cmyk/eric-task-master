import assert from 'node:assert/strict';
import test from 'node:test';
import { closeProfileBrowserSession } from '../src/runtime/profile-worker.mjs';

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

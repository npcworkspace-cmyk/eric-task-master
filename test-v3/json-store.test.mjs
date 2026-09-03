import assert from 'node:assert/strict';
import test from 'node:test';
import { replaceFileWithRetry } from '../src/lib/json-store.mjs';

test('JSON store replacement retries bounded Windows sharing failures', async () => {
  let calls = 0;
  const delays = [];
  await replaceFileWithRetry('source.tmp', 'state.json', {
    attempts: 5,
    baseDelayMs: 2,
    replace: async () => {
      calls += 1;
      if (calls < 4) {
        const error = new Error('temporarily locked');
        error.code = 'EPERM';
        throw error;
      }
    },
    delay: async (milliseconds) => { delays.push(milliseconds); }
  });
  assert.equal(calls, 4);
  assert.deepEqual(delays, [2, 4, 8]);
});

test('JSON store replacement never retries permanent failures', async () => {
  let calls = 0;
  await assert.rejects(
    replaceFileWithRetry('source.tmp', 'state.json', {
      replace: async () => {
        calls += 1;
        const error = new Error('bad path');
        error.code = 'EINVAL';
        throw error;
      },
      delay: async () => { throw new Error('delay should not run'); }
    }),
    { code: 'EINVAL' }
  );
  assert.equal(calls, 1);
});

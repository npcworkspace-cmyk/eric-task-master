import assert from 'node:assert/strict';
import test from 'node:test';
import { removeTestTree } from './test-fs.mjs';

test('test tree cleanup enables bounded native Windows retries', async () => {
  let received;
  await removeTestTree('temporary-root', {
    remove: async (target, options) => { received = { target, options }; }
  });

  assert.equal(received.target, 'temporary-root');
  assert.deepEqual(received.options, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100
  });
});

test('test tree cleanup still exposes a failure after native retries are exhausted', async () => {
  const locked = Object.assign(new Error('directory remains locked'), { code: 'EPERM' });
  await assert.rejects(
    removeTestTree('temporary-root', { remove: async () => { throw locked; } }),
    { code: 'EPERM' }
  );
});

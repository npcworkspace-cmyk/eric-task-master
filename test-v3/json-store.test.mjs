import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { JsonStore, replaceFileWithRetry } from '../src/lib/json-store.mjs';
import { removeTestTree } from './test-fs.mjs';

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

test('JSON store default retry budget survives a multi-second Windows sharing lock', async () => {
  let calls = 0;
  const delays = [];
  await replaceFileWithRetry('source.tmp', 'state.json', {
    replace: async () => {
      calls += 1;
      if (calls <= 12) {
        const error = new Error('virus scanner still holds the destination');
        error.code = 'EPERM';
        throw error;
      }
    },
    delay: async (milliseconds) => { delays.push(milliseconds); }
  });

  assert.equal(calls, 13);
  assert.deepEqual(delays, [25, 50, 100, 200, 250, 250, 250, 250, 250, 250, 250, 250]);
});

test('JSON store refuses to overwrite data replaced by another process', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-json-store-'));
  t.after(() => removeTestTree(root));
  const file = path.join(root, 'state.json');
  const store = new JsonStore(file, { value: 'initial' });
  await store.init();

  const external = { value: 'restored-backup' };
  await writeFile(file, `${JSON.stringify(external, null, 2)}\n`, 'utf8');

  await assert.rejects(store.update((draft) => {
    draft.value = 'stale-manager-write';
  }), { code: 'STATE_STORE_EXTERNALLY_MODIFIED' });
  await assert.rejects(store.replace({ value: 'stale-manager-replace' }), {
    code: 'STATE_STORE_EXTERNALLY_MODIFIED'
  });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), external);
});

test('JSON store exposes an explicit external-change check', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-json-store-check-'));
  t.after(() => removeTestTree(root));
  const file = path.join(root, 'state.json');
  const store = new JsonStore(file, { count: 0 });
  await store.init();
  await store.assertUnchanged();
  await writeFile(file, '{"count":7}\n', 'utf8');
  await assert.rejects(store.assertUnchanged(), { code: 'STATE_STORE_EXTERNALLY_MODIFIED' });
  await writeFile(file, '{"count":0}\n', 'utf8');
  await assert.rejects(store.read(), { code: 'STATE_STORE_EXTERNALLY_MODIFIED' });
  await assert.rejects(store.update((draft) => { draft.count = 9; }), { code: 'STATE_STORE_EXTERNALLY_MODIFIED' });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { count: 0 }, 'conflict remains latched until a new store is opened');
});

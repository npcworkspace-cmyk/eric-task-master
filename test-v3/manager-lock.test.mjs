import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ManagerLock } from '../src/lib/manager-lock.mjs';
import { removeTestTree } from './test-fs.mjs';

async function lockFixture(t, owner) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-manager-lock-'));
  t.after(() => removeTestTree(root));
  const file = path.join(root, '.manager.lock');
  await writeFile(file, `${JSON.stringify(owner)}\n`);
  return file;
}

test('reclaims a legacy lock when its PID was reused after lock creation', async (t) => {
  const now = Date.now();
  const file = await lockFixture(t, {
    pid: process.pid,
    nonce: 'legacy-owner',
    createdAt: new Date(now - 86_400_000).toISOString()
  });
  const lock = new ManagerLock(file, { processStartedAt: async () => now });
  await lock.acquire();
  const owner = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(owner.pid, process.pid);
  assert.notEqual(owner.nonce, 'legacy-owner');
  assert.equal(owner.processStartedAt, now);
  await lock.release();
});

test('reclaims a new lock only when the process identity differs', async (t) => {
  const now = Date.now();
  const file = await lockFixture(t, {
    pid: process.pid,
    nonce: 'reused-owner',
    createdAt: new Date(now).toISOString(),
    processStartedAt: now - 86_400_000
  });
  const lock = new ManagerLock(file, { processStartedAt: async () => now });
  await lock.acquire();
  assert.notEqual(JSON.parse(await readFile(file, 'utf8')).nonce, 'reused-owner');
  await lock.release();
});

test('keeps an active lock and fails closed when process identity is unavailable', async (t) => {
  const now = Date.now();
  const owner = {
    pid: process.pid,
    nonce: 'active-owner',
    createdAt: new Date(now - 10_000).toISOString(),
    processStartedAt: now - 20_000
  };
  const file = await lockFixture(t, owner);
  const active = new ManagerLock(file, { processStartedAt: async () => owner.processStartedAt });
  await assert.rejects(active.acquire(), { code: 'MANAGER_ALREADY_RUNNING' });
  const unavailable = new ManagerLock(file, { processStartedAt: async () => null });
  await assert.rejects(unavailable.acquire(), { code: 'MANAGER_ALREADY_RUNNING' });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), owner);
});

test('Windows process probe recognizes a reused PID in a legacy lock', {
  skip: process.platform !== 'win32'
}, async (t) => {
  const file = await lockFixture(t, {
    pid: process.pid,
    nonce: 'previous-process',
    createdAt: new Date(Date.now() - 86_400_000).toISOString()
  });
  const lock = new ManagerLock(file);
  await lock.acquire();
  const owner = JSON.parse(await readFile(file, 'utf8'));
  assert.notEqual(owner.nonce, 'previous-process');
  assert.ok(Number.isFinite(owner.processStartedAt));
  await lock.release();
});

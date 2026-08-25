import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DashboardSessionStore } from '../src/lib/dashboard-session-store.mjs';

test('Dashboard owner sessions survive restart without persisting bearer tokens', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-dashboard-session-'));
  let now = Date.parse('2026-08-26T00:00:00.000Z');
  const filePath = path.join(root, 'dashboard-sessions.json');
  try {
    const first = new DashboardSessionStore({ filePath, now: () => now });
    await first.init();
    const issued = await first.create({ focusTaskId: 'task-1' });
    assert.equal((await first.authenticate(issued.token)).focusTaskId, 'task-1');

    const source = await readFile(filePath, 'utf8');
    assert.equal(source.includes(issued.token), false);

    now += 60_000;
    const restarted = new DashboardSessionStore({ filePath, now: () => now });
    await restarted.init();
    assert.equal((await restarted.authenticate(issued.token)).id, issued.session.id);
    assert.equal(await restarted.revoke(issued.token), true);
    assert.equal(await restarted.authenticate(issued.token), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Dashboard owner sessions expire and stay bounded', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-dashboard-expiry-'));
  let now = 1_000_000;
  const filePath = path.join(root, 'dashboard-sessions.json');
  try {
    const store = new DashboardSessionStore({ filePath, now: () => now, ttlMs: 100, maxSessions: 2 });
    await store.init();
    const first = await store.create();
    const second = await store.create();
    const third = await store.create();
    assert.equal(await store.authenticate(first.token), null);
    assert.ok(await store.authenticate(second.token));
    assert.ok(await store.authenticate(third.token));
    now += 101;
    assert.equal(await store.authenticate(third.token), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { removeTestTree } from './test-fs.mjs';
import { ProfileStore } from '../src/lib/profile-store.mjs';
import { createProfileRuntime } from '../src/runtime/profile-runtime.mjs';

class CloseFailingWorker extends EventEmitter {
  constructor(pid, alive) {
    super();
    this.pid = pid;
    this.connected = true;
    this.alive = alive;
    alive.add(pid);
  }

  send(message, _handle, _options, callback) {
    callback?.(null);
    if (message.type === 'open') setImmediate(() => this.emit('message', { type: 'ready' }));
    if (message.type === 'close') {
      setImmediate(() => this.emit('message', { type: 'closed', browserClosed: false }));
    }
  }

  terminate() {
    this.alive.delete(this.pid);
    this.connected = false;
    this.exitCode = null;
    this.signalCode = 'SIGKILL';
    this.emit('exit', null, 'SIGKILL');
  }
}

test('manual Profile retains its lease until failed close is contained', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-profile-runtime-'));
  t.after(() => removeTestTree(root));
  const alive = new Set();
  const store = new ProfileStore({
    filePath: path.join(root, 'profiles.json'),
    profilesRoot: path.join(root, 'profiles'),
    processAlive: (pid) => alive.has(pid)
  });
  await store.init();
  const profile = await store.create({ name: 'Owned Chrome' });
  const worker = new CloseFailingWorker(9201, alive);
  let terminationWorks = false;
  const runtime = createProfileRuntime({
    profileStore: store,
    workerFactory: () => worker,
    processAlive: (pid) => alive.has(pid),
    closeTimeoutMs: 20,
    terminateTree: async () => {
      if (!terminationWorks) return false;
      worker.terminate();
      return true;
    }
  });

  await runtime.openProfile(profile.id);
  await assert.rejects(runtime.closeProfile(profile.id), { code: 'PROFILE_PROCESS_STILL_ALIVE' });
  const quarantined = await store.get(profile.id);
  assert.equal(quarantined.state, 'error');
  assert.ok(quarantined.lease);
  assert.equal(alive.has(worker.pid), true);
  await assert.rejects(runtime.openProfile(profile.id), { code: 'PROFILE_PROCESS_STILL_ALIVE' });

  terminationWorks = true;
  assert.deepEqual(await runtime.closeProfile(profile.id), {
    status: 'closed', profileId: profile.id
  });
  const released = await store.get(profile.id);
  assert.equal(released.state, 'idle');
  assert.equal(released.lease, null);
});

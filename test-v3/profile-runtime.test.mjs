import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
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

function startupStore(beforeAcquire = async () => {}) {
  const profile = { id: 'startup-profile', state: 'idle', userDataDir: 'fake-profile', lease: null };
  return {
    recoverExpiredLeases: async () => {},
    get: async () => profile,
    acquireLease: async (_id, lease) => {
      await beforeAcquire();
      profile.lease = { ...lease, generation: 1 };
      return profile;
    },
    confirmLeaseCleanup: async () => true,
    renewLease: async () => true,
    markLeaseError: async () => true,
    releaseLease: async () => { profile.lease = null; return true; }
  };
}

test('Profile observes worker rejection before delayed lease acquisition completes', async (t) => {
  for (const failure of ['error', 'exit']) {
    await t.test(failure, async () => {
      const alive = new Set();
      const worker = new CloseFailingWorker(9301, alive);
      const store = startupStore(async () => {
        if (failure === 'exit') worker.terminate();
        else worker.emit('error', new Error('spawn failed'));
        // Give Node an entire turn to detect any rejected promise with no observer.
        await nextTurn();
      });
      const runtime = createProfileRuntime({
        profileStore: store,
        workerFactory: () => worker,
        processAlive: (pid) => alive.has(pid),
        terminateTree: async () => { if (alive.has(worker.pid)) worker.terminate(); return true; },
        closeTimeoutMs: 20
      });
      await assert.rejects(runtime.openProfile('startup-profile'), { code: 'PROFILE_WORKER_START_FAILED' });
      assert.equal((await store.get()).lease, null);
      assert.equal(runtime.owns('startup-profile'), false);
    });
  }
});

test('Profile runtime preserves worker startup diagnostics through cleanup', async () => {
  const alive = new Set();
  const worker = new CloseFailingWorker(9302, alive);
  const details = { stage: 'launch-chrome', cause: { code: 'TimeoutError', message: 'launch exceeded 60000ms' } };
  const baseSend = worker.send.bind(worker);
  worker.send = (message, handle, options, callback) => {
    if (message.type !== 'open') return baseSend(message, handle, options, callback);
    callback?.(null);
    setImmediate(() => worker.emit('message', {
      type: 'error', error: { code: 'CHROME_LAUNCH_FAILED', message: 'Chrome could not open', details }
    }));
  };
  const store = startupStore();
  const runtime = createProfileRuntime({
    profileStore: store,
    workerFactory: () => worker,
    processAlive: (pid) => alive.has(pid),
    terminateTree: async () => { worker.terminate(); return true; },
    closeTimeoutMs: 20
  });
  await assert.rejects(runtime.openProfile('startup-profile'), (error) => {
    assert.equal(error.code, 'CHROME_LAUNCH_FAILED');
    assert.deepEqual(error.details, details);
    return true;
  });
  assert.equal((await store.get()).lease, null);
});

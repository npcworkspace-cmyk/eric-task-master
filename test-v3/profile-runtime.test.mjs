import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { removeTestTree } from './test-fs.mjs';
import { ProfileStore } from '../src/lib/profile-store.mjs';
import { createProfileRuntime } from '../src/runtime/profile-runtime.mjs';

async function eventually(predicate, label) {
  const deadline = performance.now() + 5_000;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, `Timed out waiting for ${label}`);
    await nextTurn();
  }
}

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
    profileUsageProbe: async () => 'inactive',
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
    markLeaseError: async () => { profile.state = 'error'; return true; },
    releaseLease: async () => { profile.lease = null; profile.state = 'idle'; return true; }
  };
}

test('a stalled Profile close IPC callback cannot hold cleanup forever', { timeout: 5_000 }, async () => {
  // Fake workers have no real IPC handle to keep Node alive while sending.
  const keepAlive = setInterval(() => {}, 5_000);
  const alive = new Set();
  const worker = new CloseFailingWorker(9399, alive);
  const originalSend = worker.send.bind(worker);
  worker.send = (message, ...args) => { if (message.type !== 'close') originalSend(message, ...args); };
  const store = startupStore();
  let terminated = 0;
  const runtime = createProfileRuntime({
    profileStore: store, workerFactory: () => worker,
    processAlive: (pid) => alive.has(pid), profileUsageProbe: async () => 'inactive',
    closeTimeoutMs: 10,
    terminateTree: async () => { terminated += 1; worker.terminate(); return true; }
  });
  try {
    await runtime.openProfile('startup-profile');
    const start = performance.now();
    assert.deepEqual(await runtime.closeProfile('startup-profile'), { status: 'closed', profileId: 'startup-profile' });
    assert.ok(performance.now() - start < 3_000);
    assert.equal(terminated, 1);
    assert.equal((await store.get()).lease, null);
  } finally {
    if (alive.has(worker.pid)) worker.terminate();
    await runtime.closeAll().catch(() => {});
    clearInterval(keepAlive);
  }
});

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
        profileUsageProbe: async () => 'inactive',
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
    profileUsageProbe: async () => 'inactive',
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

test('terminated manual Worker does not release a Profile with a surviving browser', async () => {
  const alive = new Set();
  const worker = new CloseFailingWorker(9303, alive);
  const store = startupStore();
  const runtime = createProfileRuntime({
    profileStore: store,
    workerFactory: () => worker,
    processAlive: (pid) => alive.has(pid),
    profileUsageProbe: async () => 'active',
    terminateTree: async () => { worker.terminate(); return true; },
    closeTimeoutMs: 20
  });
  await runtime.openProfile('startup-profile');
  await assert.rejects(runtime.closeProfile('startup-profile'), { code: 'PROFILE_CLEANUP_UNCONFIRMED' });
  assert.ok((await store.get()).lease, 'surviving Chrome must retain the one-writer fence');
});

for (const trigger of ['watchdog', 'lease-renewal']) {
  test(`${trigger} cleanup failures are contained, retried three times, and can be closed manually`, async (t) => {
    const alive = new Set();
    const worker = new CloseFailingWorker(9401, alive);
    const store = startupStore();
    const profile = await store.get();
    let terminations = 0;
    let terminationWorks = false;
    let cleanupConfirmations = 0;
    let leaseErrors = 0;
    store.renewLease = async () => { throw new Error('lease write failed'); };
    store.confirmLeaseCleanup = async () => { cleanupConfirmations += 1; return true; };
    store.markLeaseError = async () => { leaseErrors += 1; profile.state = 'error'; return true; };
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1_750_000_000_000 });
    const runtime = createProfileRuntime({
      profileStore: store, workerFactory: () => worker,
      processAlive: (pid) => alive.has(pid), profileUsageProbe: async () => 'inactive',
      heartbeatTimeoutMs: 1_000, closeTimeoutMs: 20, cleanupRetryDelayMs: 5_000,
      maximumCleanupAttempts: 3,
      terminateTree: async () => {
        terminations += 1;
        if (!terminationWorks) return false;
        worker.terminate();
        return true;
      }
    });
    t.after(async () => {
      terminationWorks = true;
      await runtime.closeAll();
      t.mock.timers.reset();
    });
    await runtime.openProfile(profile.id);
    if (trigger === 'watchdog') t.mock.timers.tick(1_001);
    else worker.emit('message', { type: 'heartbeat' });
    await eventually(() => leaseErrors === 1, 'first failed cleanup');
    await nextTurn();
    assert.equal(terminations, 1);
    assert.equal(profile.state, 'error');
    assert.equal(runtime.owns(profile.id), true);
    for (let attempt = 2; attempt <= 3; attempt += 1) {
      t.mock.timers.tick(5_000);
      await eventually(() => terminations === attempt, `cleanup attempt ${attempt}`);
      await nextTurn();
      await nextTurn();
    }
    t.mock.timers.tick(60_000);
    worker.emit('message', { type: 'heartbeat' });
    await nextTurn();
    assert.equal(terminations, 3, 'automatic cleanup stops at its bounded attempt count');
    assert.equal(leaseErrors, 1, 'one persistent error mark is reused across cleanup attempts');
    assert.ok(profile.lease);
    await assert.rejects(runtime.openProfile(profile.id), { code: 'PROFILE_PROCESS_STILL_ALIVE' });
    terminationWorks = true;
    assert.deepEqual(await runtime.closeProfile(profile.id), { status: 'closed', profileId: profile.id });
    assert.equal(terminations, 4);
    assert.equal(cleanupConfirmations, 1);
    assert.equal(profile.lease, null);
    assert.equal(profile.state, 'idle');
    assert.equal(runtime.owns(profile.id), false);
  });
}

test('a failed cleanup confirmation can be retried after process exit without losing the owned entry', async () => {
  const alive = new Set();
  const worker = new CloseFailingWorker(9402, alive);
  const store = startupStore();
  let confirmationWorks = false;
  let confirmations = 0;
  let usageProbes = 0;
  let terminations = 0;
  store.confirmLeaseCleanup = async () => {
    confirmations += 1;
    if (!confirmationWorks) throw new Error('temporary state write failure');
    return true;
  };
  const runtime = createProfileRuntime({
    profileStore: store, workerFactory: () => worker,
    processAlive: (pid) => alive.has(pid), closeTimeoutMs: 20,
    profileUsageProbe: async () => { usageProbes += 1; return 'inactive'; },
    terminateTree: async () => { terminations += 1; worker.terminate(); return true; }
  });
  await runtime.openProfile('startup-profile');
  await assert.rejects(runtime.closeProfile('startup-profile'), /temporary state write failure/u);
  assert.equal(runtime.owns('startup-profile'), true);
  assert.equal((await store.get()).state, 'error');
  confirmationWorks = true;
  await runtime.closeProfile('startup-profile');
  assert.equal(runtime.owns('startup-profile'), false);
  assert.equal((await store.get()).lease, null);
  assert.equal(terminations, 1, 'successful process containment is reused');
  assert.equal(usageProbes, 1);
  assert.equal(confirmations, 2, 'one confirmation per close attempt, retrying only after failure');
});

test('normal Profile close confirms cleanup once and performs no extra usage probe or termination', async () => {
  const alive = new Set();
  const worker = new CloseFailingWorker(9403, alive);
  const store = startupStore();
  let confirmations = 0;
  let releases = 0;
  let probes = 0;
  const baseSend = worker.send.bind(worker);
  worker.send = (message, handle, options, callback) => {
    if (message.type === 'close') {
      callback?.(null);
      setImmediate(() => worker.emit('message', { type: 'closed', browserClosed: true, cleanupId: 'closed_once' }));
      return;
    }
    if (message.type === 'closed_ack') {
      callback?.(null);
      setImmediate(() => worker.terminate());
      return;
    }
    baseSend(message, handle, options, callback);
  };
  store.confirmLeaseCleanup = async () => { confirmations += 1; return true; };
  const release = store.releaseLease;
  store.releaseLease = async (...args) => { releases += 1; return release(...args); };
  const runtime = createProfileRuntime({
    profileStore: store, workerFactory: () => worker, processAlive: (pid) => alive.has(pid),
    profileUsageProbe: async () => { probes += 1; return 'inactive'; },
    terminateTree: async () => { throw new Error('normal close must not terminate the process tree'); }
  });
  await runtime.openProfile('startup-profile');
  await runtime.closeProfile('startup-profile');
  assert.equal(confirmations, 1);
  assert.equal(releases, 1);
  assert.equal(probes, 0);
  assert.equal(runtime.owns('startup-profile'), false);
});

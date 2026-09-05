import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { ProfileStore } from '../src/lib/profile-store.mjs';
import { createTaskService } from '../src/runtime/task-service.mjs';
import { runTaskWorker } from '../src/runtime/task-worker.mjs';
import { removeTestTree } from './test-fs.mjs';

async function eventually(predicate, label) {
  const deadline = performance.now() + 5_000;
  while (!await predicate()) {
    assert.ok(performance.now() < deadline, `Timed out waiting for ${label}`);
    await nextTurn();
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return { promise, resolve };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-pending-cleanup-'));
  const key = `worker_cleanup_${path.basename(root).replaceAll('-', '_')}`;
  const track = { runCount: 0, launches: 0, closes: 0, confirmations: 0, pagesRead: 0 };
  globalThis[key] = track;
  const modulePath = path.join(root, 'job.mjs');
  await writeFile(modulePath, `export async function run() { globalThis[${JSON.stringify(key)}].runCount++; return true; }\n`);
  const launch = deferred();
  const context = {
    pages: () => { track.pagesRead++; return []; },
    close: async () => { track.closes++; }
  };
  const messages = [];
  const cleanups = [];
  const controller = new AbortController();
  const config = {
    taskId: 'task_pending_cleanup', modulePath, outputDir: path.join(root, 'output'),
    profile: { userDataDir: path.join(root, 'profile') }
  };
  const options = {
    signal: controller.signal,
    loadPlaywright: async () => ({ chromium: {
      launchPersistentContext: () => { track.launches++; return launch.promise; }
    } }),
    sendMessage: (message) => messages.push(message),
    sendCleanup: async (message) => { cleanups.push(message); return true; },
    onCleanupConfirmed: () => { track.confirmations++; }
  };
  t.after(async () => {
    t.mock.timers.reset();
    controller.abort();
    launch.resolve(context);
    await nextTurn();
    delete globalThis[key];
    await removeTestTree(root);
  });
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  return { root, track, launch, context, messages, cleanups, controller, config, options };
}

test('stopping a pending launch returns immediately and acknowledges its eventual closure exactly once', async (t) => {
  const env = await fixture(t);
  const running = runTaskWorker(env.config, env.options);
  await eventually(() => env.track.launches === 1, 'pending browser launch');
  env.controller.abort();
  const result = await running;
  assert.equal(result.state, 'stopped', 'task stop cannot wait for the unresolved browser launch');
  assert.equal(env.cleanups.length, 0, 'an unresolved launch is not yet a cleanup failure');
  t.mock.timers.tick(1_000);
  env.launch.resolve(env.context);
  await eventually(() => env.track.confirmations === 1, 'acknowledged late context close');
  assert.deepEqual(env.cleanups.map((message) => message.browserClosed), [true]);
  assert.equal(env.track.closes, 1);
  assert.equal(env.track.pagesRead, 0);
  assert.equal(env.track.runCount, 0);
  t.mock.timers.tick(20_000);
  await nextTurn();
  assert.equal(env.cleanups.length, 1);
  assert.equal(env.track.confirmations, 1);
});

test('the pending-launch deadline reports false only at ten seconds, then reports a genuinely closed late handle', async (t) => {
  const env = await fixture(t);
  const running = runTaskWorker(env.config, env.options);
  await eventually(() => env.track.launches === 1, 'pending browser launch');
  env.controller.abort();
  assert.equal((await running).state, 'stopped');
  t.mock.timers.tick(9_999);
  await nextTurn();
  assert.equal(env.cleanups.length, 0);
  t.mock.timers.tick(1);
  await nextTurn();
  assert.deepEqual(env.cleanups.map((message) => message.browserClosed), [false]);
  assert.equal(env.track.confirmations, 0, 'a negative cleanup report must not request Worker exit');
  t.mock.timers.tick(1_000);
  env.launch.resolve(env.context);
  await eventually(() => env.track.confirmations === 1, 'cleanup after the containment deadline');
  assert.deepEqual(env.cleanups.map((message) => message.browserClosed), [false, true]);
  assert.equal(env.track.closes, 1);
  assert.equal(env.track.runCount, 0);
  assert.equal(env.track.pagesRead, 0);
  t.mock.timers.tick(20_000);
  await nextTurn();
  assert.equal(env.cleanups.length, 2);
  assert.equal(env.track.confirmations, 1);
});

test('the ten-second cleanup deadline includes time spent closing a handle received near the deadline', async (t) => {
  const env = await fixture(t);
  const closed = deferred();
  env.context.close = async () => { env.track.closes++; await closed.promise; };
  const running = runTaskWorker(env.config, env.options);
  await eventually(() => env.track.launches === 1, 'pending browser launch');
  env.controller.abort();
  assert.equal((await running).state, 'stopped');
  t.mock.timers.tick(9_000);
  env.launch.resolve(env.context);
  await eventually(() => env.track.closes === 1, 'late context closing');
  t.mock.timers.tick(999);
  await nextTurn();
  assert.equal(env.cleanups.length, 0);
  t.mock.timers.tick(1);
  await nextTurn();
  assert.deepEqual(env.cleanups.map((message) => message.browserClosed), [false], 'a late handle must not extend the total cleanup deadline');
  t.mock.timers.tick(1_000);
  closed.resolve();
  await eventually(() => env.track.confirmations === 1, 'real close acknowledgement after deadline');
  assert.deepEqual(env.cleanups.map((message) => message.browserClosed), [false, true]);
  assert.equal(env.track.closes, 1);
  assert.equal(env.track.runCount, 0);
});

test('cancellation before launching Chrome reports true cleanup without starting or closing a browser', async (t) => {
  const env = await fixture(t);
  env.controller.abort();
  const result = await runTaskWorker(env.config, env.options);
  assert.equal(result.state, 'stopped');
  assert.equal(env.track.launches, 0);
  assert.equal(env.track.closes, 0);
  assert.equal(env.track.runCount, 0);
  assert.deepEqual(env.cleanups.map((message) => message.browserClosed), [true]);
  assert.equal(env.track.confirmations, 1);
});

test('a normal close finishing after its deadline still acknowledges real cleanup without closing twice', async (t) => {
  const env = await fixture(t);
  const closed = deferred();
  env.context.pages = () => [{}];
  env.context.close = async () => { env.track.closes++; await closed.promise; };
  env.launch.resolve(env.context);
  const running = runTaskWorker(env.config, env.options);
  await eventually(() => env.track.closes === 1, 'normal browser close');
  assert.equal(env.track.runCount, 1);
  t.mock.timers.tick(9_999);
  await nextTurn();
  assert.equal(env.cleanups.length, 0);
  t.mock.timers.tick(1);
  assert.equal((await running).state, 'finished');
  assert.deepEqual(env.cleanups.map((message) => message.browserClosed), [false]);
  assert.deepEqual(env.cleanups[0].details, { phase: 'close', reason: 'timeout', elapsedMs: 10_000 });
  assert.equal(env.track.confirmations, 0);
  closed.resolve();
  // Give the already-started close and its acknowledgement time to settle.
  for (let turn = 0; turn < 10; turn++) await nextTurn();
  assert.deepEqual(env.cleanups.map((message) => message.browserClosed), [false, true]);
  assert.equal(env.track.confirmations, 1);
  assert.equal(env.track.closes, 1);
  t.mock.timers.tick(20_000);
  await nextTurn();
  assert.equal(env.cleanups.length, 2);
});

test('a rejected close reports a redacted error immediately and never confirms cleanup', async (t) => {
  const env = await fixture(t);
  env.context.pages = () => [{}];
  env.context.close = () => {
    env.track.closes++;
    throw Object.assign(new Error('close failed: token=fixture-secret'), { code: 'CONNECTION_CLOSED' });
  };
  env.launch.resolve(env.context);
  await runTaskWorker(env.config, env.options);
  assert.deepEqual(env.cleanups.map((message) => message.browserClosed), [false]);
  assert.equal(env.cleanups[0].details.reason, 'error');
  assert.equal(env.cleanups[0].details.error.code, 'CONNECTION_CLOSED');
  assert.equal(JSON.stringify(env.cleanups).includes('fixture-secret'), false);
  assert.equal(env.track.confirmations, 0);
  t.mock.timers.tick(20_000);
  await nextTurn();
  assert.equal(env.cleanups.length, 1);
  assert.equal(env.track.closes, 1);
});

test('a late real close without Manager acknowledgement cannot request Worker exit', async (t) => {
  const env = await fixture(t);
  const closed = deferred();
  env.context.pages = () => [{}];
  env.context.close = () => { env.track.closes++; return closed.promise; };
  env.options.sendCleanup = async (message) => { env.cleanups.push(message); return false; };
  env.launch.resolve(env.context);
  const running = runTaskWorker(env.config, env.options);
  await eventually(() => env.track.closes === 1, 'normal close');
  t.mock.timers.tick(10_000);
  await running;
  closed.resolve();
  await eventually(() => env.cleanups.length === 2, 'late close report');
  assert.deepEqual(env.cleanups.map((message) => message.browserClosed), [false, true]);
  assert.equal(env.track.confirmations, 0);
  assert.equal(env.track.closes, 1);
});

test('cancellation during Playwright loading cannot turn a late load into browser startup', async (t) => {
  const env = await fixture(t);
  const loaded = deferred();
  let loading = false;
  const running = runTaskWorker(env.config, {
    ...env.options,
    loadPlaywright: async () => { loading = true; await loaded.promise; return env.options.loadPlaywright(); }
  });
  await eventually(() => loading, 'Playwright loading');
  env.controller.abort();
  assert.equal((await running).state, 'stopped');
  loaded.resolve();
  await nextTurn();
  await nextTurn();
  assert.equal(env.track.launches, 0);
  assert.deepEqual(env.cleanups.map((message) => message.browserClosed), [true]);
  assert.equal(env.track.confirmations, 1);
});

for (const lateClose of [false, true]) test(lateClose
  ? 'TaskService releases a late normal close without force termination and retains its timeout diagnostic'
  : 'TaskService deletion during launch releases the Profile through the real cleanup acknowledgement without force termination', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-delete-launch-'));
  const alive = new Set();
  const launch = deferred();
  const messages = [];
  let worker;
  let launchCount = 0;
  let closeCount = 0;
  let terminateCount = 0;
  let cleanupConfirmed = 0;
  const closed = deferred();
  const context = {
    pages: () => lateClose ? [{}] : assert.fail('a cancelled launch cannot inspect its pages'),
    close: async () => { closeCount++; if (lateClose) await closed.promise; }
  };
  class WorkerBridge extends EventEmitter {
    constructor() {
      super(); this.pid = 96831; this.connected = true; this.controller = new AbortController();
      this.pendingCleanup = new Map(); alive.add(this.pid);
    }
    send(message, _handle, _options, callback) {
      messages.push(message);
      callback?.(null);
      if (message.type === 'stop') this.controller.abort();
      if (message.type === 'cleanup_ack') this.pendingCleanup.get(message.cleanupId)?.(true);
      if (message.type !== 'start') return;
      this.running = runTaskWorker(message.config, {
        signal: this.controller.signal,
        loadPlaywright: async () => ({ chromium: { launchPersistentContext: () => { launchCount++; return launch.promise; } } }),
        sendMessage: (record) => this.emit('message', record),
        sendCleanup: (record) => new Promise((resolve) => {
          const cleanupId = `bridge_cleanup_${this.pendingCleanup.size}`;
          this.pendingCleanup.set(cleanupId, resolve);
          this.emit('message', { ...record, cleanupId });
        }),
        onCleanupConfirmed: () => {
          cleanupConfirmed++;
          this.connected = false;
          alive.delete(this.pid);
          this.exitCode = 0;
          this.signalCode = null;
          this.emit('exit', 0, null);
        }
      });
    }
  }
  const profileStore = new ProfileStore({
    filePath: path.join(root, 'profiles.json'), profilesRoot: path.join(root, 'profiles'),
    processAlive: (pid) => alive.has(pid)
  });
  await profileStore.init();
  const profile = await profileStore.create({ name: 'Launch deletion' });
  const service = createTaskService({
    stateDir: path.join(root, 'tasks'), profileStore,
    workerFactory: () => (worker = new WorkerBridge()), processAlive: (pid) => alive.has(pid),
    profileUsageProbe: async () => 'inactive',
    terminateTree: async () => { terminateCount++; return false; }
  });
  t.after(async () => {
    t.mock.timers.reset();
    worker?.controller.abort();
    launch.resolve(context);
    closed.resolve();
    await worker?.running;
    await service.close();
    await removeTestTree(root);
  });
  const modulePath = path.join(root, 'job.mjs');
  await writeFile(modulePath, lateClose
    ? 'export async function run() { return { done: true }; }\n'
    : 'export async function run() { throw new Error("task code must never run"); }\n');
  await service.list();
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  const task = await service.create({ modulePath, profileId: profile.id });
  await eventually(() => launchCount === 1, 'bridged browser launch');
  if (lateClose) {
    launch.resolve(context);
    await eventually(() => closeCount === 1, 'normal close started');
    t.mock.timers.tick(10_000);
    assert.equal((await worker.running).state, 'finished');
    await eventually(() => messages.some((message) => message.type === 'stop'), 'containment dispatch');
    closed.resolve();
    await eventually(async () => (await service.get(task.id)).state === 'error', 'late cleanup finalization');
    const final = await service.get(task.id);
    assert.deepEqual(final.result, { done: true });
    assert.equal(final.error.code, 'TASK_BROWSER_CLOSE_FAILED', 'late cleanup must not hide the original deadline failure');
    assert.deepEqual(final.error.details, { phase: 'close', reason: 'timeout', elapsedMs: 10_000 });
    assert.equal(messages.filter((message) => message.type === 'cleanup_ack').length, 2);
    await service.deleteTask(task.id);
  } else {
    const deleted = service.deleteTask(task.id);
    await eventually(() => messages.some((message) => message.type === 'stop'), 'delete stop dispatch');
    assert.equal((await worker.running).state, 'stopped');
    assert.equal(messages.some((message) => message.type === 'cleanup_ack'), false);
    t.mock.timers.tick(1_000);
    launch.resolve(context);
    assert.deepEqual(await deleted, { deleted: true, id: task.id });
    assert.equal(messages.filter((message) => message.type === 'cleanup_ack').length, 1);
  }
  assert.equal(closeCount, 1);
  assert.equal(terminateCount, 0);
  assert.equal(cleanupConfirmed, 1);
  assert.equal((await profileStore.get(profile.id)).lease, null);
  assert.equal((await profileStore.get(profile.id)).state, 'idle');
  assert.equal(alive.size, 0);
  assert.equal((await service.list()).length, 0);
  const saved = JSON.parse(await readFile(path.join(root, 'tasks', 'tasks.json'), 'utf8'));
  assert.equal(saved.tasks.length, 0);
});

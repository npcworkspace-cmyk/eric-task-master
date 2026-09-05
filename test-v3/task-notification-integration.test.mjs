import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { createVerificationNotifier } from '../src/lib/desktop-notifications.mjs';
import { JsonStore } from '../src/lib/json-store.mjs';
import { ProfileStore } from '../src/lib/profile-store.mjs';
import { createTaskService } from '../src/runtime/task-service.mjs';
import { removeTestTree } from './test-fs.mjs';

async function until(check, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for integration state');
}

const flushMicrotasks = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };

class ReminderClock {
  timestamp = Date.now();
  sequence = 0;
  timers = new Map();
  now = () => this.timestamp;
  setTimeout = (callback, delay) => {
    const id = ++this.sequence;
    this.timers.set(id, { at: this.timestamp + delay, callback });
    return id;
  };
  clearTimeout = (id) => this.timers.delete(id);
  async advance(milliseconds) {
    const end = this.timestamp + milliseconds;
    while (true) {
      const next = [...this.timers].filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.timestamp = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
      await flushMicrotasks();
    }
    this.timestamp = end;
    await flushMicrotasks();
  }
}

class ManualWorker extends EventEmitter {
  constructor(pid, alive) {
    super();
    this.pid = pid;
    this.alive = alive;
    this.connected = true;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.messages = [];
    this.config = null;
    this.autoFinishOnStop = true;
    alive.add(pid);
  }

  send(message, _handle, _options, callback) {
    this.messages.push(message);
    if (message.type === 'start') this.config = message.config;
    callback?.(null);
    // Resume is deliberately manual: IPC receipt, acceptance and execution
    // confirmation must remain distinct in the service integration test.
    if (message.type === 'stop' && this.autoFinishOnStop) setImmediate(() => this.finish('stopped'));
  }

  finish(state = 'finished') {
    if (!this.alive.has(this.pid)) return;
    this.emit('message', { type: 'state', state });
    this.emit('message', { type: 'cleanup', browserClosed: true });
    this.alive.delete(this.pid);
    this.connected = false;
    this.exitCode = 0;
    this.signalCode = null;
    this.emit('exit', 0, null);
  }
}

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-notification-integration-'));
  const stateDir = path.join(root, 'tasks');
  const tasksPath = path.join(stateDir, 'tasks.json');
  const alive = new Set();
  const workers = [];
  const notices = [];
  const observations = [];
  const removed = [];
  const writes = [];
  const clock = new ReminderClock();
  const profileStore = new ProfileStore({
    filePath: path.join(root, 'profiles.json'), profilesRoot: path.join(root, 'profiles'),
    processAlive: (pid) => alive.has(pid)
  });
  await profileStore.init();
  const profile = await profileStore.create({ name: 'Isolated test Profile' });
  const nativeFreeNotifier = createVerificationNotifier({
    notify: (payload) => notices.push({ ...payload, at: clock.now() }),
    now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout
  });
  let closed = 0;
  const notifier = {
    observeTask(task) { observations.push(structuredClone(task)); nativeFreeNotifier.observeTask(task); },
    remove(id) { removed.push(id); nativeFreeNotifier.remove(id); },
    close() { closed++; nativeFreeNotifier.close(); }
  };
  const originalReplace = JsonStore.prototype.replace;
  t.mock.method(JsonStore.prototype, 'replace', async function replace(value) {
    if (this.filePath === tasksPath) writes.push(structuredClone(value));
    return originalReplace.call(this, value);
  });
  let nextPid = 97_001;
  const service = createTaskService({
    stateDir, profileStore, verificationNotifier: notifier, now: clock.now,
    workerFactory: () => {
      const worker = new ManualWorker(nextPid++, alive);
      workers.push(worker);
      return worker;
    },
    processAlive: (pid) => alive.has(pid), profileUsageProbe: async () => 'inactive',
    terminateTree: async (pid) => { workers.find((worker) => worker.pid === pid)?.finish('stopped'); return true; },
    stopWaitMs: 200, terminationWaitMs: 200, progressFlushMs: 10_000, ...options
  });
  t.after(async () => { await service.close(); await removeTestTree(root); });
  const modulePath = path.join(root, 'job.mjs');
  await writeFile(modulePath, 'export async function run() { return null; }\n');
  const created = await service.create({ modulePath, profileId: profile.id, label: 'Notification integration' });
  await until(async () => workers[0]?.config && (await service.get(created.id)).state === 'running');
  writes.length = 0;
  const waiting = {
    id: 'wait_notification', kind: 'verification', reason: 'verification',
    startedAt: new Date(clock.now()).toISOString(),
    pauseAt: new Date(clock.now() + 20 * 60_000).toISOString(),
    pauseAfterMs: 20 * 60_000, automaticPaused: false
  };
  return {
    root, clock, service, worker: workers[0], created, waiting, notices, observations, removed, writes,
    closed: () => closed,
    persisted: async () => JSON.parse(await readFile(tasksPath, 'utf8')),
    async enterWaiting() {
      workers[0].emit('message', { type: 'waiting', waiting });
      const current = await service.get(created.id);
      await flushMicrotasks();
      assert.equal(current.state, 'waiting');
      return current;
    }
  };
}

test('service starts reminders on waiting and cancels only after actual resumed, not receipt or ACK', async (t) => {
  const f = await fixture(t);
  await f.enterWaiting();
  assert.equal(f.notices.length, 1);
  assert.equal(f.observations.at(-1).waiting.id, f.waiting.id);
  assert.equal((await f.persisted()).tasks[0].waiting.id, f.waiting.id);

  const resuming = f.service.resume(f.created.id, null, { waitId: f.waiting.id });
  const request = await until(() => f.worker.messages.find(({ type }) => type === 'resume'));
  assert.equal((await f.service.get(f.created.id)).state, 'waiting');
  f.worker.emit('message', { type: 'resume_ack', requestId: request.requestId, accepted: true, waitId: f.waiting.id });
  await f.clock.advance(30_000);
  assert.equal(f.notices.length, 2);
  assert.equal(f.removed.length, 0);
  assert.equal((await f.service.get(f.created.id)).state, 'waiting');

  f.worker.emit('message', { type: 'resumed', waitId: f.waiting.id });
  assert.equal((await resuming).state, 'running');
  assert.equal(f.observations.at(-1).state, 'running');
  assert.equal(f.clock.timers.size, 0);
  await f.clock.advance(60_000);
  assert.equal(f.notices.length, 2);
});

test('automatic verification pause persists, stops reminders and ignores a late screenshot update', async (t) => {
  const f = await fixture(t);
  await f.enterWaiting();
  f.worker.emit('message', { type: 'event', event: {
    type: 'verification.probe', waitId: f.waiting.id, probeId: 'published_probe',
    probe: 1, maximumProbes: 4, screenshot: 'screenshots/first.png', needsAgentDecision: true
  } });
  await f.service.get(f.created.id);
  const pausedAt = new Date(f.clock.now()).toISOString();
  f.worker.emit('message', { type: 'event', event: {
    type: 'verification.paused', waitId: f.waiting.id, pausedAt
  } });
  const paused = await f.service.get(f.created.id);
  assert.equal(paused.state, 'waiting');
  assert.equal(paused.waiting.automaticPaused, true);
  assert.equal(paused.waiting.pausedAt, pausedAt);
  assert.equal(paused.waiting.needsAgentDecision, false);
  assert.equal((await f.persisted()).tasks[0].waiting.automaticPaused, true);
  assert.equal(f.clock.timers.size, 0);
  f.worker.emit('message', { type: 'event', event: {
    type: 'verification.probe', waitId: f.waiting.id, probeId: 'late_probe', probe: 4,
    screenshot: 'screenshots/late.png', needsAgentDecision: true,
    nextProbeAt: new Date(f.clock.now() + 30_000).toISOString()
  } });
  const late = await f.service.get(f.created.id);
  assert.equal(late.waiting.probeId, 'published_probe');
  assert.equal(late.waiting.screenshot, 'screenshots/first.png');
  assert.equal(late.waiting.needsAgentDecision, false);
  assert.equal(late.waiting.nextProbeAt, null);
  await f.clock.advance(60_000);
  assert.equal(f.notices.length, 1);
});

test('stopping a verification task cancels reminders and releases its fake Worker', async (t) => {
  const f = await fixture(t);
  await f.enterWaiting();
  assert.equal((await f.service.stop(f.created.id)).state, 'stopped');
  assert.ok(f.removed.includes(f.created.id));
  assert.equal(f.clock.timers.size, 0);
  await f.clock.advance(60_000);
  assert.equal(f.notices.length, 1);
  assert.equal(f.worker.connected, false);
});

test('deleting a waiting task cancels reminders and ignores later Worker events', async (t) => {
  const f = await fixture(t);
  await f.enterWaiting();
  assert.deepEqual(await f.service.deleteTask(f.created.id), { deleted: true, id: f.created.id });
  assert.ok(f.removed.includes(f.created.id));
  f.worker.emit('message', { type: 'waiting', waiting: { ...f.waiting, id: 'late_wait' } });
  await f.clock.advance(60_000);
  assert.equal(f.clock.timers.size, 0);
  assert.equal(f.notices.length, 1);
  await assert.rejects(f.service.get(f.created.id), (error) => error.code === 'TASK_NOT_FOUND');
});

test('internal cleanup containment cancels reminders as soon as the task enters stopping', async (t) => {
  const f = await fixture(t);
  await f.enterWaiting();
  f.worker.autoFinishOnStop = false;
  try {
    f.worker.emit('message', { type: 'cleanup', browserClosed: false });
    await until(async () => (await f.service.get(f.created.id)).state === 'stopping');
    assert.equal(f.clock.timers.size, 0);
    await f.clock.advance(30_000);
    assert.equal(f.notices.length, 1);
  } finally {
    f.worker.finish('error');
    await until(async () => (await f.service.get(f.created.id)).state === 'error');
  }
});

test('dense progress remains current in memory, coalesces on disk, and heartbeat does not rewrite task history', async (t) => {
  const f = await fixture(t, { progressFlushMs: 100 });
  for (let current = 1; current <= 200; current++) {
    f.worker.emit('message', { type: 'progress', progress: { current, total: 500, message: 'working' } });
  }
  assert.equal((await f.service.get(f.created.id)).progress.current, 200);
  assert.ok(f.writes.length <= 1, 'progress does not persist once per message');
  await until(() => f.writes.length === 1);
  assert.equal(f.writes[0].tasks[0].progress.current, 200);
  assert.equal(f.writes[0].tasks[0].events.filter(({ type }) => type === 'progress').length, 1);
  await f.service.get(f.created.id);
  const beforeHeartbeats = await f.persisted();
  const writesBefore = f.writes.length;
  await f.clock.advance(1_000);
  for (let index = 0; index < 100; index++) f.worker.emit('message', { type: 'heartbeat' });
  const current = await f.service.get(f.created.id);
  assert.equal(current.heartbeatAt, new Date(f.clock.now()).toISOString());
  assert.equal(f.writes.length, writesBefore, 'lease renewal is separate from tasks.json history');
  assert.deepEqual(await f.persisted(), beforeHeartbeats);
});

test('a state transition flushes final coalesced progress before its durable event', async (t) => {
  const f = await fixture(t);
  for (let current = 1; current <= 100; current++) {
    f.worker.emit('message', { type: 'progress', progress: { current, total: 100, message: 'done' } });
  }
  await f.service.get(f.created.id);
  assert.equal(f.writes.length, 0);
  await f.enterWaiting();
  const afterWait = (await f.persisted()).tasks[0];
  assert.equal(afterWait.progress.current, 100);
  const progress = afterWait.events.filter(({ type }) => type === 'progress');
  assert.equal(progress.length, 1);
  assert.equal(progress[0].data.current, 100);
  assert.ok(progress[0].sequence < afterWait.events.find(({ type }) => type === 'task.waiting').sequence);

  f.worker.emit('message', { type: 'progress', progress: { current: 101, total: 101, message: 'final' } });
  f.worker.finish();
  await until(async () => (await f.service.get(f.created.id)).state === 'finished');
  const finished = (await f.persisted()).tasks[0];
  assert.equal(finished.progress.current, 101);
  const finalProgress = finished.events.filter(({ type }) => type === 'progress').at(-1);
  assert.equal(finalProgress.data.current, 101);
  assert.ok(finalProgress.sequence < finished.events.find(({ type }) => type === 'task.finished').sequence);
});

test('the original progress timer does not persist again after a state transition already flushed progress', async (t) => {
  const progressFlushMs = 54_321;
  const f = await fixture(t, { progressFlushMs });
  const originalSetTimeout = globalThis.setTimeout;
  const progressCallbacks = [];
  t.mock.method(globalThis, 'setTimeout', (callback, milliseconds, ...args) => {
    if (milliseconds !== progressFlushMs) return originalSetTimeout(callback, milliseconds, ...args);
    progressCallbacks.push(callback);
    return { unref() {} };
  });

  f.worker.emit('message', { type: 'progress', progress: { current: 10, total: 20, message: 'checkpoint ready' } });
  await f.service.get(f.created.id);
  assert.equal(progressCallbacks.length, 1);
  assert.equal(f.writes.length, 0);
  await f.enterWaiting();
  assert.equal(f.writes.length, 1);
  const afterTransition = await f.persisted();
  assert.equal(afterTransition.tasks[0].progress.current, 10);
  assert.equal(afterTransition.tasks[0].events.filter(({ type }) => type === 'progress').length, 1);

  // Trigger the already-scheduled callback deterministically; no wall-clock
  // delay or native notification is needed to cover the empty flush path.
  progressCallbacks[0]();
  await f.service.get(f.created.id);
  assert.equal(f.writes.length, 1, 'the empty timer must not rewrite tasks.json');
  assert.deepEqual(await f.persisted(), afterTransition);
});

test('service close shuts down the notifier and leaves no scheduled reminder', async (t) => {
  const f = await fixture(t);
  await f.enterWaiting();
  await f.service.close();
  assert.equal(f.closed(), 1);
  assert.equal(f.clock.timers.size, 0);
  await f.clock.advance(60_000);
  assert.equal(f.notices.length, 1);
});

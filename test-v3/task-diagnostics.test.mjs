import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { publicTask } from '../src/contracts.mjs';
import { ProfileStore } from '../src/lib/profile-store.mjs';
import { createTaskService } from '../src/runtime/task-service.mjs';
import { removeTestTree } from './test-fs.mjs';

async function until(check, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for test state');
}

class Worker extends EventEmitter {
  constructor(pid, alive) {
    super();
    Object.assign(this, { pid, alive, connected: true, messages: [] });
    alive.add(pid);
  }

  send(message, _handle, _options, callback) {
    this.messages.push(message);
    callback?.(null);
    if (message.type === 'start') {
      this.config = message.config;
      setImmediate(() => this.emit('message', { type: 'heartbeat' }));
    }
    if (message.type === 'resume') {
      setImmediate(() => {
        this.emit('message', {
          type: 'resume_ack', requestId: message.requestId, accepted: true, waitId: message.waitId
        });
        this.emit('message', { type: 'resumed', waitId: message.waitId });
      });
    }
    if (message.type === 'stop') setImmediate(() => this.exit('stopped'));
  }

  exit(state = 'finished') {
    if (!this.alive.has(this.pid)) return;
    if (state === 'finished') this.emit('message', { type: 'result', result: { ok: true } });
    else this.emit('message', {
      type: 'error', state: 'stopped', error: { code: 'TASK_STOPPED', message: 'stopped' }
    });
    this.emit('message', { type: 'state', state });
    this.emit('message', { type: 'cleanup', browserClosed: true });
    this.connected = false;
    this.alive.delete(this.pid);
    this.exitCode = 0;
    this.signalCode = null;
    this.emit('exit', 0, null);
  }
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-diagnostics-'));
  const alive = new Set();
  const workers = [];
  const profileStore = new ProfileStore({
    filePath: path.join(root, 'profiles.json'),
    profilesRoot: path.join(root, 'profiles'),
    processAlive: (pid) => alive.has(pid)
  });
  await profileStore.init();
  const profile = await profileStore.create({ name: 'Diagnostics' });
  const source = path.join(root, 'job.mjs');
  await writeFile(source, 'export async function run() { return true; }\n');
  const service = createTaskService({
    stateDir: path.join(root, 'tasks'),
    profileStore,
    workerFactory: () => {
      const worker = new Worker(50_000 + workers.length, alive);
      workers.push(worker);
      return worker;
    },
    profileWorkerFactory: () => { throw new Error('No real browser may start in diagnostics tests'); },
    processAlive: (pid) => alive.has(pid),
    terminateTree: async (pid) => {
      workers.find((worker) => worker.pid === pid)?.exit('stopped');
      return !alive.has(pid);
    },
    heartbeatTimeoutMs: 60_000,
    reaperIntervalMs: 60_000
  });
  t.after(async () => {
    await service.close();
    await removeTestTree(root);
  });
  const createTask = async () => {
    const task = await service.create({ modulePath: source, profileId: profile.id });
    const worker = await until(() => workers.find((candidate) => candidate.config?.taskId === task.id));
    return { task, worker };
  };
  return { service, createTask };
}

function baseTask(overrides = {}) {
  return {
    id: `task_${'a'.repeat(32)}`,
    label: 'diagnostic contract',
    profileId: 'profile_fixture',
    state: 'error',
    progress: { current: 1, total: 1, message: 'failed', phase: 'navigate' },
    error: {
      code: 'NAVIGATION_FAILED',
      message: 'Navigation failed',
      details: { stage: 'navigate' },
      nextAction: 'Inspect the failure screenshot',
      cause: { code: 'ECONNRESET', message: 'Connection reset' }
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: '2026-01-01T00:00:01.000Z',
    finishedAt: '2026-01-01T00:00:02.000Z',
    ...overrides
  };
}

test('publicTask exposes only the supported live failure screenshot artifact', () => {
  const visible = publicTask(baseTask({ failureScreenshot: 'failure.png' }));
  assert.equal(visible.failureScreenshot, 'failure.png');
  assert.deepEqual(visible.error, baseTask().error);
  assert.equal(visible.canResume, false);

  assert.equal(publicTask(baseTask()).failureScreenshot, null, 'legacy tasks have no screenshot field');
  for (const failureScreenshot of [
    'other.png', 'screenshots/failure.png', '../failure.png', '/tmp/failure.png',
    'C:\\temp\\failure.png', 'https://example.test/failure.png', 'file:///tmp/failure.png', 42
  ]) {
    assert.equal(publicTask(baseTask({ failureScreenshot })).failureScreenshot, null);
  }
  assert.equal(publicTask(baseTask({
    failureScreenshot: 'failure.png', outputClearedAt: '2026-01-01T00:00:03.000Z'
  })).failureScreenshot, null);

  const waiting = publicTask(baseTask({
    state: 'waiting', waiting: { id: 'wait_fixture', reason: 'agent decision' },
    error: null, failureScreenshot: undefined, finishedAt: null
  }));
  assert.equal(waiting.failureScreenshot, null);
  assert.equal(waiting.canResume, true);
});

test('TaskService returns failure evidence through get, list, and events until output is cleaned', async (t) => {
  const f = await fixture(t);
  const { task, worker } = await f.createTask();
  await writeFile(path.join(worker.config.outputDir, 'failure.png'), 'synthetic screenshot');
  worker.emit('message', {
    type: 'error',
    state: 'error',
    error: {
      code: 'NAVIGATION_FAILED',
      message: 'Navigation failed',
      details: { stage: 'navigate' },
      nextAction: 'Inspect the failure screenshot',
      cause: { code: 'ECONNRESET', message: 'Connection reset' },
      screenshot: 'failure.png'
    }
  });
  await until(async () => (await f.service.get(task.id)).error?.code === 'NAVIGATION_FAILED');
  worker.emit('message', { type: 'state', state: 'error' });
  worker.emit('message', { type: 'cleanup', browserClosed: true });
  await new Promise((resolve) => setImmediate(resolve));
  worker.connected = false;
  worker.alive.delete(worker.pid);
  worker.exitCode = 1;
  worker.signalCode = null;
  worker.emit('exit', 1, null);

  const failed = await until(async () => {
    const value = await f.service.get(task.id);
    return value.state === 'error' ? value : null;
  });
  assert.equal(failed.failureScreenshot, 'failure.png');
  assert.deepEqual(failed.error, {
    code: 'NAVIGATION_FAILED',
    message: 'Navigation failed',
    details: { stage: 'navigate' },
    nextAction: 'Inspect the failure screenshot',
    cause: { code: 'ECONNRESET', message: 'Connection reset' }
  });
  assert.equal((await f.service.list()).find((item) => item.id === task.id)?.failureScreenshot, 'failure.png');
  assert.equal((await f.service.events(task.id)).task.failureScreenshot, 'failure.png');

  const cleanup = await f.service.cleanup({ categories: ['task-output'], preview: false });
  assert.deepEqual(cleanup.failed, []);
  assert.deepEqual(cleanup.skipped, []);
  const cleaned = await f.service.get(task.id);
  assert.ok(Date.parse(cleaned.outputClearedAt));
  assert.equal(cleaned.failureScreenshot, null);
  assert.equal((await f.service.list()).find((item) => item.id === task.id)?.failureScreenshot, null);
  assert.equal((await f.service.events(task.id)).task.failureScreenshot, null);
  assert.equal((await f.service.get(task.id)).error.code, 'NAVIGATION_FAILED');
});

test('failure screenshot contract leaves waiting-task resume semantics unchanged', async (t) => {
  const f = await fixture(t);
  const { task, worker } = await f.createTask();
  worker.emit('message', {
    type: 'waiting', waiting: { id: 'wait_diagnostics', reason: 'agent decision' }
  });
  const waiting = await until(async () => {
    const value = await f.service.get(task.id);
    return value.state === 'waiting' ? value : null;
  });
  assert.equal(waiting.failureScreenshot, null);
  assert.equal(waiting.canResume, true);

  const resumed = await f.service.resume(task.id, { continue: true }, { waitId: 'wait_diagnostics' });
  assert.equal(resumed.state, 'running');
  assert.equal(resumed.canResume, false);
  assert.deepEqual(worker.messages.findLast((message) => message.type === 'resume').value, { continue: true });
  worker.exit();
  await until(async () => (await f.service.get(task.id)).state === 'finished');
});

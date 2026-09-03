import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { ProfileStore } from '../src/lib/profile-store.mjs';
import { createTaskService } from '../src/runtime/task-service.mjs';
import { removeTestTree } from './test-fs.mjs';

async function until(check, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for condition');
}

class FakeWorker extends EventEmitter {
  constructor(pid, alive) {
    super();
    this.pid = pid;
    this.connected = true;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.alive = alive;
    this.config = null;
    this.rejectResume = false;
    alive.add(pid);
  }

  send(message, _handle, _options, callback) {
    if (message.type === 'resume' && this.rejectResume) {
      callback?.(new Error('IPC unavailable'));
      return;
    }
    callback?.(null);
    if (message.type === 'start') {
      this.config = message.config;
      setImmediate(() => {
        this.emit('message', { type: 'heartbeat' });
        this.emit('message', { type: 'progress', progress: { current: 1, total: 1, message: 'done' } });
      });
    }
    if (message.type === 'resume') {
      setImmediate(() => this.emit('message', { type: 'resumed', waitId: 'wait_fake' }));
    }
    if (message.type === 'stop') setImmediate(() => this.finish('stopped'));
  }

  async finish(state = 'finished') {
    if (!this.alive.has(this.pid)) return;
    if (this.config) await writeFile(path.join(this.config.outputDir, 'result.txt'), 'partial-or-complete');
    if (state === 'finished') this.emit('message', { type: 'result', result: { count: 1 } });
    else this.emit('message', { type: 'error', state: 'stopped', error: { code: 'TASK_STOPPED', message: 'stopped' } });
    this.emit('message', { type: 'state', state });
    this.emit('message', { type: 'cleanup', browserClosed: true });
    this.connected = false;
    this.alive.delete(this.pid);
    this.exitCode = 0;
    this.signalCode = null;
    this.emit('exit', 0, null);
  }

  finishWithCleanupAfterExit() {
    this.emit('message', { type: 'result', result: { count: 1 } });
    this.emit('message', { type: 'state', state: 'finished' });
    this.connected = false;
    this.alive.delete(this.pid);
    this.exitCode = 0;
    this.signalCode = null;
    this.emit('exit', 0, null);
    setImmediate(() => this.emit('message', { type: 'cleanup', browserClosed: true }));
  }
}

class CleanupFailingWorker extends FakeWorker {
  send(message, handle, options, callback) {
    if (message.type !== 'stop') return super.send(message, handle, options, callback);
    callback?.(null);
    setImmediate(() => {
      this.emit('message', {
        type: 'error', state: 'stopped', error: { code: 'TASK_STOPPED', message: 'stopped' }
      });
      this.emit('message', { type: 'state', state: 'stopped' });
      this.emit('message', { type: 'cleanup', browserClosed: false });
    });
  }

  failCleanup() {
    this.emit('message', { type: 'state', state: 'finished' });
    this.emit('message', { type: 'cleanup', browserClosed: false });
  }

  terminate() {
    if (!this.alive.has(this.pid)) return;
    this.connected = false;
    this.alive.delete(this.pid);
    this.exitCode = null;
    this.signalCode = 'SIGKILL';
    this.emit('exit', null, 'SIGKILL');
  }
}

test('TaskService queues one writer, preserves partial output, and deletes atomically', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-service-'));
  const alive = new Set();
  const profileStore = new ProfileStore({
    filePath: path.join(root, 'profiles.json'),
    profilesRoot: path.join(root, 'profiles'),
    processAlive: (pid) => alive.has(pid)
  });
  await profileStore.init();
  const profile = await profileStore.create({ name: 'Work' });
  const workers = [];
  let nextPid = 7000;
  const workerFactory = () => {
    const child = new FakeWorker(nextPid++, alive);
    workers.push(child);
    return child;
  };
  const service = createTaskService({
    stateDir: path.join(root, 'tasks'),
    profileStore,
    workerFactory,
    profileWorkerFactory: workerFactory,
    processAlive: (pid) => alive.has(pid),
    terminateTree: async (pid) => {
      alive.delete(pid);
      return true;
    }
  });
  t.after(async () => {
    await service.close();
    await removeTestTree(root);
  });
  const source = path.join(root, 'job.mjs');
  await writeFile(source, 'export async function run() { return { ok: true }; }\n');

  const inputSecret = 'TASK_INPUT_SECRET_4a07cc';
  const stateSecret = 'TASK_STATE_SECRET_780d2b';
  const first = await service.create({
    modulePath: source,
    profileId: profile.id,
    label: 'first',
    input: { apiKey: inputSecret }
  });
  await until(() => workers.length === 1 && workers[0].config);
  assert.deepEqual(workers[0].config.input, { apiKey: inputSecret });
  const leakedSecret = 'reddit_session=do-not-persist-this-cookie';
  workers[0].stdout.write(`${leakedSecret}\n`);
  workers[0].stderr.write(`${leakedSecret}\n`);
  workers[0].emit('message', {
    type: 'progress',
    progress: { current: 1, total: 2, message: `token=${stateSecret}`, phase: `token=${stateSecret}` }
  });
  workers[0].emit('message', {
    type: 'waiting',
    waiting: { id: 'wait_secret', reason: `token=${stateSecret}`, data: { password: stateSecret } }
  });
  await until(async () => (await service.get(first.id)).state === 'waiting');
  const persistedWithSecrets = await readFile(path.join(root, 'tasks', 'tasks.json'), 'utf8');
  assert.equal(persistedWithSecrets.includes(inputSecret), false);
  assert.equal(persistedWithSecrets.includes(stateSecret), false);
  assert.equal(persistedWithSecrets.includes(leakedSecret), false);
  const second = await service.create({ modulePath: source, profileId: profile.id, label: 'second' });
  assert.equal((await service.get(second.id)).state, 'queued');
  assert.equal(workers.length, 1);

  await workers[0].finish();
  await until(async () => (await service.get(first.id)).state === 'finished');
  const firstEventPage = await service.events(first.id, { after: 0, limit: 2 });
  assert.equal(firstEventPage.events.length, 2);
  assert.equal(firstEventPage.nextAfter, firstEventPage.events[1].sequence);
  assert.ok(firstEventPage.nextAfter < firstEventPage.task.eventSequence);
  const secondEventPage = await service.events(first.id, { after: firstEventPage.nextAfter, limit: 20 });
  assert.ok(secondEventPage.events.every((event) => event.sequence > firstEventPage.nextAfter));
  assert.equal(JSON.stringify(await service.get(first.id)).includes(leakedSecret), false);
  assert.equal(JSON.stringify(await service.events(first.id, { after: 0, limit: 100 })).includes(leakedSecret), false);
  await until(() => workers.length === 2 && workers[1].config);
  assert.equal((await service.get(second.id)).state, 'running');
  assert.equal((await profileStore.get(profile.id)).lease.taskId, second.id);

  await workers[1].finish();
  const finished = await until(async () => {
    const value = await service.get(second.id);
    return value.state === 'finished' ? value : null;
  });
  assert.equal(finished.title, 'second');
  assert.deepEqual(finished.result, { count: 1 });
  assert.equal((await profileStore.get(profile.id)).state, 'idle');
  assert.equal((await readFile(path.join(root, 'tasks', 'tasks.json'), 'utf8')).includes(leakedSecret), false);
  const taskRoot = path.join(root, 'tasks', second.id);
  assert.equal(existsSync(path.join(taskRoot, 'task.mjs')), false);
  assert.equal(existsSync(path.join(taskRoot, 'node_modules')), false);
  assert.equal(await readFile(path.join(taskRoot, 'output', 'result.txt'), 'utf8'), 'partial-or-complete');
  await writeFile(path.join(taskRoot, 'output', 'a.txt'), 'a');
  await writeFile(path.join(taskRoot, 'output', 'b.txt'), 'b');
  const firstArtifacts = await service.listArtifacts(second.id, { limit: 2 });
  assert.deepEqual(firstArtifacts.artifacts.map((file) => file.path), ['a.txt', 'b.txt']);
  assert.equal(firstArtifacts.truncated, true);
  assert.equal(firstArtifacts.nextOffset, 2);
  const remainingArtifacts = await service.listArtifacts(second.id, {
    offset: firstArtifacts.nextOffset,
    limit: 2
  });
  assert.deepEqual(remainingArtifacts.artifacts.map((file) => file.path), ['result.txt']);
  assert.equal(remainingArtifacts.truncated, false);
  assert.equal(remainingArtifacts.nextOffset, null);

  assert.deepEqual(await service.deleteTask(second.id), { deleted: true, id: second.id });
  assert.equal(existsSync(taskRoot), false);
  assert.deepEqual(await service.deleteTask(second.id), { deleted: true, id: second.id });

  const third = await service.create({ modulePath: source, profileId: profile.id, label: 'wait-resume' });
  await until(() => workers.length === 3 && workers[2].config);
  workers[2].emit('message', {
    type: 'waiting',
    waiting: { id: 'wait_fake', reason: 'agent decides when to continue' }
  });
  await until(async () => (await service.get(third.id)).state === 'waiting');
  workers[2].rejectResume = true;
  await assert.rejects(service.resume(third.id, { continue: true }), { code: 'TASK_RESUME_FAILED' });
  assert.equal((await service.get(third.id)).state, 'waiting');
  workers[2].rejectResume = false;
  await service.resume(third.id, { continue: true });
  await until(async () => (await service.get(third.id)).state === 'running');
  await assert.rejects(service.resume(third.id, { continue: true }), { code: 'TASK_NOT_WAITING' });
  await workers[2].finish();
  await until(async () => (await service.get(third.id)).state === 'finished');

  const fourth = await service.create({ modulePath: source, profileId: profile.id, label: 'delete-running' });
  await until(() => workers.length === 4 && workers[3].config);
  const fourthRoot = path.join(root, 'tasks', fourth.id);
  assert.deepEqual(await service.deleteTask(fourth.id), { deleted: true, id: fourth.id });
  assert.equal(existsSync(fourthRoot), false);
  assert.equal((await profileStore.get(profile.id)).state, 'idle');

  const fifth = await service.create({ modulePath: source, profileId: profile.id, label: 'cleanup-exit-race' });
  await until(() => workers.length === 5 && workers[4].config);
  workers[4].finishWithCleanupAfterExit();
  await until(async () => (await service.get(fifth.id)).state === 'finished');
  assert.equal((await profileStore.get(profile.id)).state, 'idle');

  const errorSecret = 'ERROR_SECRET_83c7b2';
  const sixth = await service.create({ modulePath: source, profileId: profile.id, label: 'structured-error' });
  await until(() => workers.length === 6 && workers[5].config);
  workers[5].emit('message', {
    type: 'error',
    state: 'error',
    error: {
      code: 'UPSTREAM_REJECTED',
      message: 'Upstream rejected the request',
      details: { stage: 'navigate', apiKey: errorSecret },
      nextAction: `Retry with token=${errorSecret}`,
      cause: { code: 'ECONNRESET', message: 'Connection reset' }
    }
  });
  workers[5].emit('message', { type: 'state', state: 'error' });
  workers[5].emit('message', { type: 'cleanup', browserClosed: true });
  workers[5].connected = false;
  alive.delete(workers[5].pid);
  workers[5].exitCode = 1;
  workers[5].signalCode = null;
  workers[5].emit('exit', 1, null);
  const structuredFailure = await until(async () => {
    const value = await service.get(sixth.id);
    return value.state === 'error' ? value : null;
  });
  assert.deepEqual(structuredFailure.error.details, { stage: 'navigate' });
  assert.equal(structuredFailure.error.nextAction, 'Retry with token=[REDACTED]');
  assert.deepEqual(structuredFailure.error.cause, {
    code: 'ECONNRESET',
    message: 'Connection reset'
  });
  assert.equal((await readFile(path.join(root, 'tasks', 'tasks.json'), 'utf8')).includes(errorSecret), false);

  assert.equal((await service.deleteProfile(profile.id)).deleted, true);
  assert.deepEqual(await service.deleteProfile(profile.id), { deleted: true, id: profile.id });
});

test('TaskService retains lease after browser close and tree termination both fail', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-cleanup-fault-'));
  const alive = new Set();
  const profileStore = new ProfileStore({
    filePath: path.join(root, 'profiles.json'),
    profilesRoot: path.join(root, 'profiles'),
    processAlive: (pid) => alive.has(pid)
  });
  await profileStore.init();
  const profile = await profileStore.create({ name: 'Cleanup fault' });
  const worker = new CleanupFailingWorker(8101, alive);
  let terminationWorks = false;
  const service = createTaskService({
    stateDir: path.join(root, 'tasks'),
    profileStore,
    workerFactory: () => worker,
    processAlive: (pid) => alive.has(pid),
    heartbeatTimeoutMs: 60_000,
    reaperIntervalMs: 20,
    stopWaitMs: 20,
    terminationWaitMs: 20,
    terminateTree: async () => {
      if (!terminationWorks) return false;
      worker.terminate();
      return true;
    }
  });
  t.after(async () => {
    terminationWorks = true;
    worker.terminate();
    await service.close().catch(() => {});
    await removeTestTree(root);
  });
  const source = path.join(root, 'job.mjs');
  await writeFile(source, 'export async function run() { return true; }\n');
  const task = await service.create({ modulePath: source, profileId: profile.id });
  const taskRoot = path.join(root, 'tasks', task.id);
  await until(() => worker.config);
  worker.failCleanup();

  await until(async () => (await service.get(task.id)).error?.code === 'TASK_PROCESS_STILL_ALIVE');
  const quarantined = await profileStore.get(profile.id);
  assert.equal(quarantined.state, 'error');
  assert.ok(quarantined.lease);
  assert.equal(alive.has(worker.pid), true);

  assert.deepEqual(await service.deleteTask(task.id), { deleted: true, id: task.id });
  await assert.rejects(service.get(task.id), { code: 'TASK_NOT_FOUND' });
  assert.equal(existsSync(taskRoot), true, 'output stays until the Worker can no longer write');
  assert.ok((await profileStore.get(profile.id)).lease, 'Profile stays fenced while the Worker is alive');
  const persistedTombstone = JSON.parse(await readFile(path.join(root, 'tasks', 'tasks.json'), 'utf8'));
  assert.deepEqual(persistedTombstone.tasks, []);
  assert.equal(persistedTombstone.tombstones[0].id, task.id);

  terminationWorks = true;
  await until(async () => (await profileStore.get(profile.id)).state === 'idle');
  await until(() => !existsSync(taskRoot));
  assert.equal((await profileStore.get(profile.id)).lease, null);
  await until(async () => (
    JSON.parse(await readFile(path.join(root, 'tasks', 'tasks.json'), 'utf8')).tombstones.length === 0
  ));
});

test('Manager restart never kills a live process found only by persisted PID', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-pid-reuse-'));
  const profileStore = new ProfileStore({
    filePath: path.join(root, 'profiles.json'),
    profilesRoot: path.join(root, 'profiles'),
    processAlive: () => true
  });
  await profileStore.init();
  const taskId = `task_${'a'.repeat(32)}`;
  const profile = await profileStore.create({ name: 'Restarted Profile' });
  await profileStore.acquireLease(profile.id, {
    ownerId: `task:${taskId}`,
    kind: 'task',
    taskId,
    pid: process.pid,
    nonce: 'restart-nonce',
    ttlMs: 45_000
  });
  const tasksRoot = path.join(root, 'tasks');
  await mkdir(tasksRoot, { recursive: true });
  const timestamp = new Date().toISOString();
  await writeFile(path.join(tasksRoot, 'tasks.json'), `${JSON.stringify({
    version: 1,
    tasks: [{
      id: taskId,
      label: 'persisted running task',
      profileId: profile.id,
      profileName: profile.name,
      moduleName: 'old.mjs',
      modulePath: null,
      state: 'running',
      progress: { current: 1, total: 2, message: 'old' },
      events: [],
      eventSequence: 0,
      createdAt: timestamp,
      startedAt: timestamp,
      workerPid: process.pid
    }]
  }, null, 2)}\n`);
  let terminateCalls = 0;
  const service = createTaskService({
    stateDir: tasksRoot,
    profileStore,
    processAlive: () => true,
    terminateTree: async () => { terminateCalls += 1; return true; }
  });
  t.after(async () => {
    await service.close();
    await removeTestTree(root);
  });

  const recovered = await service.get(taskId);
  assert.equal(recovered.state, 'error');
  assert.equal(recovered.error.code, 'MANAGER_RESTARTED');
  assert.equal(terminateCalls, 0);
  const quarantined = await profileStore.get(profile.id);
  assert.equal(quarantined.state, 'error');
  assert.ok(quarantined.lease);
  assert.deepEqual(await service.deleteTask(taskId), { deleted: true, id: taskId });
  await assert.rejects(service.get(taskId), { code: 'TASK_NOT_FOUND' });
  assert.ok((await profileStore.get(profile.id)).lease, 'public deletion must not release an unconfirmed lease');
  assert.equal(terminateCalls, 0);
});

test('Manager restart resumes private tombstone cleanup after a dead lease becomes safe', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-tombstone-restart-'));
  let clock = Date.now();
  const taskId = `task_${'b'.repeat(32)}`;
  const profileStore = new ProfileStore({
    filePath: path.join(root, 'profiles.json'),
    profilesRoot: path.join(root, 'profiles'),
    now: () => clock,
    processAlive: () => false,
    profileUsageProbe: async () => 'inactive'
  });
  await profileStore.init();
  const profile = await profileStore.create({ name: 'Tombstone restart' });
  await profileStore.acquireLease(profile.id, {
    ownerId: `task:${taskId}`,
    kind: 'task',
    taskId,
    pid: 99123,
    nonce: 'restart-tombstone',
    ttlMs: 2_000
  });
  const tasksRoot = path.join(root, 'tasks');
  const taskRoot = path.join(tasksRoot, taskId);
  await mkdir(path.join(taskRoot, 'output'), { recursive: true });
  await writeFile(path.join(taskRoot, 'output', 'partial.json'), '{}');
  await writeFile(path.join(tasksRoot, 'tasks.json'), `${JSON.stringify({
    version: 1,
    tasks: [],
    tombstones: [{ id: taskId, profileId: profile.id, deletedAt: new Date(clock).toISOString() }]
  }, null, 2)}\n`);

  clock += 3_000;
  const service = createTaskService({
    stateDir: tasksRoot,
    profileStore,
    processAlive: () => false,
    reaperIntervalMs: 20
  });
  t.after(async () => {
    await service.close();
    await removeTestTree(root);
  });
  await until(async () => (await profileStore.get(profile.id)).state === 'idle');
  await until(() => !existsSync(taskRoot));
  await until(async () => (
    JSON.parse(await readFile(path.join(tasksRoot, 'tasks.json'), 'utf8')).tombstones.length === 0
  ));
});

test('Profile deletion and task creation are linearized without stranded queued tasks', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-profile-race-'));
  const alive = new Set();
  const profileStore = new ProfileStore({
    filePath: path.join(root, 'profiles.json'),
    profilesRoot: path.join(root, 'profiles'),
    processAlive: (pid) => alive.has(pid)
  });
  await profileStore.init();
  let nextPid = 8300;
  const workers = [];
  const service = createTaskService({
    stateDir: path.join(root, 'tasks'),
    profileStore,
    workerFactory: () => {
      const worker = new FakeWorker(nextPid++, alive);
      workers.push(worker);
      return worker;
    },
    processAlive: (pid) => alive.has(pid),
    terminateTree: async (pid) => { alive.delete(pid); return true; }
  });
  t.after(async () => {
    await service.close().catch(() => {});
    await removeTestTree(root);
  });
  const source = path.join(root, 'job.mjs');
  await writeFile(source, 'export async function run() { return true; }\n');

  for (let index = 0; index < 8; index += 1) {
    const profile = await service.createProfile({ name: `Race ${index}` });
    const [deletion, creation] = await Promise.allSettled([
      service.deleteProfile(profile.id),
      service.create({ modulePath: source, profileId: profile.id, label: `race-${index}` })
    ]);
    if (creation.status === 'fulfilled') {
      const task = await service.get(creation.value.id);
      assert.notEqual(task.state, 'queued');
      assert.ok(['stopped', 'error'].includes(task.state));
    }
    assert.ok(deletion.status === 'fulfilled' || creation.status === 'fulfilled');
  }
});

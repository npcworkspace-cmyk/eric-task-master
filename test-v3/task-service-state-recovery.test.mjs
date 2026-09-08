import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProfileStore } from '../src/lib/profile-store.mjs';
import { createTaskService } from '../src/runtime/task-service.mjs';
import { removeTestTree } from './test-fs.mjs';

async function until(check) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out');
}

class RecoveryWorker extends EventEmitter {
  constructor(pid, alive) {
    super();
    this.pid = pid;
    this.alive = alive;
    this.connected = true;
    this.messages = [];
    alive.add(pid);
  }
  send(message, _handle, _options, callback) {
    this.messages.push(message);
    callback?.(null);
    if (message.type === 'start') this.started = true;
    if (message.type === 'stop') setImmediate(() => {
      this.emit('message', { type: 'cleanup', browserClosed: true, cleanupId: `cleanup-${this.pid}` });
      this.exit();
    });
  }
  exit() {
    if (!this.alive.delete(this.pid)) return;
    this.connected = false;
    this.exitCode = 0;
    this.emit('exit', 0, null);
  }
}

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'etm-state-recovery-'));
  const alive = new Set();
  const workers = [];
  const profileFile = path.join(root, 'profiles.json');
  const taskRoot = path.join(root, 'tasks');
  const taskFile = path.join(taskRoot, 'tasks.json');
  const profiles = new ProfileStore({
    filePath: profileFile, profilesRoot: path.join(root, 'profiles'),
    processAlive: (pid) => alive.has(pid)
  });
  await profiles.init();
  const first = await profiles.create({ name: 'first' });
  const second = await profiles.create({ name: 'second' });
  const service = createTaskService({
    stateDir: taskRoot, profileStore: profiles,
    workerFactory: () => { const worker = new RecoveryWorker(50_000 + workers.length, alive); workers.push(worker); return worker; },
    processAlive: (pid) => alive.has(pid),
    terminateTree: async (pid) => { workers.find((worker) => worker.pid === pid)?.exit(); return true; },
    profileUsageProbe: async () => 'inactive',
    stopWaitMs: 100, terminationWaitMs: 50, progressFlushMs: 10, reaperIntervalMs: 20,
    ...options
  });
  t.after(async () => {
    await service.containForStateRecovery().catch(() => {});
    await service.close({ abandonState: true }).catch(() => {});
    await removeTestTree(root);
  });
  await service.status();
  const source = path.join(root, 'task.mjs');
  await writeFile(source, 'export async function run() {}\n');
  return { service, profiles, first, second, workers, alive, source, profileFile, taskFile };
}

for (const changedStore of ['tasks', 'profiles']) {
  test(`${changedStore} drift fences running and waiting workers without stale cross-store writes`, async (t) => {
    const f = await fixture(t);
    const firstTask = await f.service.create({ modulePath: f.source, profileId: f.first.id });
    const secondTask = await f.service.create({ modulePath: f.source, profileId: f.second.id });
    await until(() => f.workers.length === 2 && f.workers.every((worker) => worker.started));
    f.workers[1].emit('message', { type: 'waiting', waiting: { id: 'wait-1', reason: 'manual' } });
    await until(async () => (await f.service.get(secondTask.id)).state === 'waiting');
    const target = changedStore === 'tasks' ? f.taskFile : f.profileFile;
    const replacement = `${await readFile(target, 'utf8')}\n`;
    await writeFile(target, replacement);
    const expectedTasks = await readFile(f.taskFile, 'utf8');
    const expectedProfiles = await readFile(f.profileFile, 'utf8');
    await assert.rejects(f.service.assertStateUnchanged(), { code: 'STATE_STORE_EXTERNALLY_MODIFIED' });
    // Heartbeats, progress flush, reaper, completion and scheduling previously
    // escaped the API guard and could write the *other* stale state store.
    for (const worker of f.workers) {
      worker.emit('message', { type: 'heartbeat' });
      worker.emit('message', { type: 'progress', progress: { current: 99, total: 100 } });
      worker.emit('message', { type: 'result', result: { late: true } });
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    await assert.rejects(f.service.stop(firstTask.id), { code: 'STATE_STORE_EXTERNALLY_MODIFIED' });
    await assert.rejects(f.service.deleteTask(secondTask.id), { code: 'STATE_STORE_EXTERNALLY_MODIFIED' });
    assert.equal(f.alive.size, 2, 'detecting drift alone must not kill workers');
    assert.deepEqual(await f.service.containForStateRecovery(), { tasks: 2, profiles: 0 });
    assert.equal(f.alive.size, 0);
    assert.ok(f.workers.every((worker) => worker.messages.some((message) => message.type === 'cleanup_ack')));
    assert.equal(await readFile(f.taskFile, 'utf8'), expectedTasks);
    assert.equal(await readFile(f.profileFile, 'utf8'), expectedProfiles);
  });
}

test('background progress detects drift and latches recovery without an unhandled rejection', async (t) => {
  const f = await fixture(t);
  await f.service.create({ modulePath: f.source, profileId: f.first.id });
  await until(() => f.workers[0]?.started);
  await writeFile(f.taskFile, `${await readFile(f.taskFile, 'utf8')}\n`);
  const expectedProfiles = await readFile(f.profileFile, 'utf8');
  f.workers[0].emit('message', { type: 'progress', progress: { current: 1, total: 2 } });
  await new Promise((resolve) => setTimeout(resolve, 80));
  await assert.rejects(f.service.get('unused'), { code: 'STATE_STORE_EXTERNALLY_MODIFIED' });
  assert.equal(await readFile(f.profileFile, 'utf8'), expectedProfiles);
  assert.equal(f.alive.size, 1);
});

test('recovery captures a Worker whose lease acquisition was already in flight', async (t) => {
  const f = await fixture(t);
  let enteredResolve;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const original = f.profiles.acquireLease.bind(f.profiles);
  f.profiles.acquireLease = async (...args) => {
    const lease = await original(...args);
    enteredResolve();
    await gate;
    return lease;
  };
  await f.service.create({ modulePath: f.source, profileId: f.first.id });
  await entered;
  const expectedTasks = await readFile(f.taskFile, 'utf8');
  const expectedProfiles = await readFile(f.profileFile, 'utf8');
  const recovery = f.service.containForStateRecovery();
  setTimeout(release, 10);
  assert.deepEqual(await recovery, { tasks: 1, profiles: 0 });
  assert.equal(f.alive.size, 0);
  assert.equal(f.workers[0].started, undefined, 'a fenced startup must never receive task code');
  assert.equal(await readFile(f.taskFile, 'utf8'), expectedTasks);
  assert.equal(await readFile(f.profileFile, 'utf8'), expectedProfiles);
});

test('recovery fences a pending cross-store write and fails boundedly until it settles', async (t) => {
  const f = await fixture(t, { stopWaitMs: 30 });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let enteredResolve;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  const original = f.profiles.update.bind(f.profiles);
  f.profiles.update = async (...args) => { enteredResolve(); await gate; return original(...args); };
  const update = f.service.updateProfile(f.first.id, { name: 'renamed' });
  void update.catch(() => {});
  await entered;
  const expectedProfiles = await readFile(f.profileFile, 'utf8');
  await writeFile(f.taskFile, `${await readFile(f.taskFile, 'utf8')}\n`);
  await assert.rejects(f.service.assertStateUnchanged(), { code: 'STATE_STORE_EXTERNALLY_MODIFIED' });
  const startedAt = Date.now();
  await assert.rejects(f.service.containForStateRecovery(), { code: 'MANAGER_RECOVERY_CONTAINMENT_FAILED' });
  assert.ok(Date.now() - startedAt < 1_000);
  release();
  await assert.rejects(update, { code: 'STATE_STORE_EXTERNALLY_MODIFIED' });
  assert.equal(await readFile(f.profileFile, 'utf8'), expectedProfiles);
  assert.deepEqual(await f.service.containForStateRecovery(), { tasks: 0, profiles: 0 });
});

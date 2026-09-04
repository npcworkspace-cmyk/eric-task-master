import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import fsPromises, { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProfileStore } from '../src/lib/profile-store.mjs';
import { createTaskService } from '../src/runtime/task-service.mjs';
import { removeTestTree } from './test-fs.mjs';

async function until(check) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for test state');
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Cleanup operation blocked')), 5_000); })
    ]);
  } finally { clearTimeout(timer); }
}

async function put(file, content = 'keep') {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  return file;
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
    if (message.type === 'stop') setImmediate(() => this.finish('stopped'));
  }

  finish(state = 'finished') {
    if (!this.alive.has(this.pid)) return;
    this.emit('message', { type: 'result', result: { processed: 1 } });
    this.emit('message', { type: 'state', state });
    this.emit('message', { type: 'cleanup', browserClosed: true });
    this.connected = false;
    this.alive.delete(this.pid);
    this.exitCode = 0;
    this.signalCode = null;
    this.emit('exit', 0, null);
  }
}

async function fixture(t, { profileUsageProbe = async () => 'inactive', useRootAlias = false } = {}) {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-cleanup-test-'));
  let root = fixtureRoot;
  if (useRootAlias) {
    const realRoot = path.join(fixtureRoot, 'real');
    await mkdir(realRoot);
    root = path.join(fixtureRoot, 'alias');
    await symlink(realRoot, root, process.platform === 'win32' ? 'junction' : 'dir');
  }
  const alive = new Set();
  const workers = [];
  const profileStore = new ProfileStore({
    filePath: path.join(root, 'profiles.json'),
    profilesRoot: path.join(root, 'profiles'),
    processAlive: (pid) => alive.has(pid),
    profileUsageProbe: async () => 'inactive'
  });
  await profileStore.init();
  const profile = await profileStore.create({ name: 'Fixture' });
  const source = await put(path.join(root, 'user-job.mjs'), 'export async function run() { return true; }\n');
  const service = createTaskService({
    stateDir: path.join(root, 'tasks'), profileStore, profileUsageProbe,
    workerFactory: () => {
      const worker = new Worker(40_000 + workers.length, alive);
      workers.push(worker);
      return worker;
    },
    profileWorkerFactory: () => { throw new Error('No real browser may start in cleanup tests'); },
    processAlive: (pid) => alive.has(pid),
    terminateTree: async (pid) => {
      workers.find((worker) => worker.pid === pid)?.finish('stopped');
      return !alive.has(pid);
    },
    heartbeatTimeoutMs: 60_000, reaperIntervalMs: 60_000,
    stopWaitMs: 30, terminationWaitMs: 30
  });
  t.after(async () => {
    await service.close();
    await removeTestTree(fixtureRoot);
  });
  const createTask = async (selectedProfile = profile) => {
    const task = await service.create({ modulePath: source, profileId: selectedProfile.id });
    const worker = await until(() => workers.find((item) => item.config?.taskId === task.id));
    return { task, worker, taskRoot: path.join(root, 'tasks', task.id), outputDir: worker.config.outputDir };
  };
  const finishTask = async (item) => {
    item.worker.finish();
    await until(async () => (await service.get(item.task.id)).state === 'finished');
    return item;
  };
  return { root, alive, workers, profileStore, profile, source, service, createTask, finishTask };
}

test('cleanup defaults to preview and only removes allowlisted caches and disposable task files', async (t) => {
  const f = await fixture(t);
  const item = await f.finishTask(await f.createTask());
  const caches = await Promise.all(['Cache', 'Code Cache', 'GPUCache'].map((name) => (
    put(path.join(f.profile.userDataDir, 'Default', name, 'entry'), name)
  )));
  const keepPaths = [
    ['Default/Network/Cookies', 'synthetic-cookie'], ['Default/Login Data', 'synthetic-login'],
    ['Default/Local Storage/leveldb/session', 'synthetic-storage'],
    ['Default/IndexedDB/session', 'synthetic-idb'], ['Default/Service Worker/CacheStorage/item', 'site-data'],
    ['Default/Preferences', 'preferences'], ['Local State', 'local-state'],
    ['Profile 1/Cache/entry', 'outside-whitelist']
  ];
  const canaries = await Promise.all(keepPaths.map(([relative, content]) => (
    put(path.join(f.profile.userDataDir, relative), content)
  )));
  const resultFile = await put(path.join(item.outputDir, 'partial.json'), 'valuable-result');
  const extraFile = await put(path.join(item.taskRoot, 'notes.mjs'), 'not-a-disposable-module');
  const log = await put(path.join(f.root, 'logs', 'manager-startup-fixture.log'), 'diagnostics');
  const temporary = await put(path.join(item.taskRoot, 'task.mjs'), 'disposable');
  const shared = await put(path.join(f.root, 'shared-runtime', 'package.json'), 'shared-dependency');
  const link = path.join(item.taskRoot, 'node_modules');
  await symlink(path.dirname(shared), link, process.platform === 'win32' ? 'junction' : 'dir');

  const preview = await f.service.cleanup();
  assert.equal(preview.preview, true);
  assert.deepEqual(preview.categories.map((category) => category.id), ['browser-cache', 'temporary-files']);
  assert.ok(preview.bytes > 0 && preview.files >= 5);
  assert.equal(preview.bytes, preview.categories.reduce((sum, category) => sum + category.bytes, 0));
  for (const file of [...caches, temporary, link, ...canaries, resultFile, extraFile, log, f.source, shared]) {
    assert.equal(existsSync(file), true, `preview changed ${file}`);
  }

  const cleaned = await f.service.cleanup({ preview: false });
  assert.deepEqual(cleaned.failed, []);
  for (const file of [...caches, temporary, link]) assert.equal(existsSync(file), false);
  for (let index = 0; index < canaries.length; index += 1) {
    assert.equal(await readFile(canaries[index], 'utf8'), keepPaths[index][1]);
  }
  for (const file of [resultFile, extraFile, log, f.source, shared]) assert.equal(existsSync(file), true);
  assert.equal((await f.service.get(item.task.id)).state, 'finished');
});

test('cleanup rejects unknown categories and ambiguous options without deleting anything', async (t) => {
  const f = await fixture(t);
  const cache = await put(path.join(f.profile.userDataDir, 'Default', 'Cache', 'entry'));
  for (const options of [
    { categories: ['profiles'] }, { categories: ['browser-cache', 'everything'] },
    { categories: 'browser-cache' }, { categories: ['browser-cache', 'browser-cache'] },
    { preview: 'false' }, { force: true }, null
  ]) {
    await assert.rejects(f.service.cleanup(options), { code: 'INVALID_CLEANUP_OPTIONS' });
    assert.equal(existsSync(cache), true);
  }
});

test('unexpected module directories and Profile junctions are preserved while partial cleanup stays reported', async (t) => {
  const f = await fixture(t);
  const item = await f.finishTask(await f.createTask());
  const cacheContent = 'discardable-cache';
  const cache = await put(path.join(f.profile.userDataDir, 'Default', 'Cache', 'entry'), cacheContent);
  const moduleCanary = await put(path.join(item.taskRoot, 'task.mjs', 'keep.txt'), 'not-a-module-file');
  const dependencyCanary = await put(path.join(item.taskRoot, 'node_modules', 'keep.txt'), 'not-a-link');
  const unsafeProfile = await f.profileStore.create({ name: 'Junction canary' });
  const outsideDefault = path.join(f.root, 'outside-default');
  const outsideCanary = await put(path.join(outsideDefault, 'Cache', 'keep.txt'), 'outside-profile');
  await symlink(outsideDefault, path.join(unsafeProfile.userDataDir, 'Default'),
    process.platform === 'win32' ? 'junction' : 'dir');

  const report = await f.service.cleanup({ preview: false });
  assert.equal(existsSync(cache), false);
  assert.equal(report.bytes, Buffer.byteLength(cacheContent));
  assert.equal(report.files, 1);
  assert.equal(await readFile(moduleCanary, 'utf8'), 'not-a-module-file');
  assert.equal(await readFile(dependencyCanary, 'utf8'), 'not-a-link');
  assert.equal(await readFile(outsideCanary, 'utf8'), 'outside-profile');
  assert.ok(report.failed.some((issue) => issue.id === item.task.id &&
    issue.path === 'task.mjs' && issue.reason === 'STAGED_MODULE_NOT_FILE'));
  assert.ok(report.failed.some((issue) => issue.id === item.task.id &&
    issue.path === 'node_modules' && issue.reason === 'INVALID_CLEANUP_PATH'));
  assert.ok(report.failed.some((issue) => issue.id === unsafeProfile.id && issue.reason === 'INVALID_CLEANUP_PATH'));
  assert.equal((await f.service.get(item.task.id)).state, 'finished');
  assert.equal(existsSync(f.source), true);
  assert.equal((await f.service.cleanup({ categories: ['browser-cache'] })).files, 0);
});

test('task output cleanup is opt-in and preserves the terminal task record and user source', async (t) => {
  const f = await fixture(t);
  const item = await f.finishTask(await f.createTask());
  const resultFile = await put(path.join(item.outputDir, 'result.json'), 'result');
  const screenshot = await put(path.join(item.outputDir, 'screenshots', 'verification.png'), 'image');
  const leftover = await put(path.join(item.taskRoot, 'task.mjs'), 'leftover-module');
  const preview = await f.service.cleanup({ categories: ['task-output'] });
  assert.equal(preview.preview, true);
  assert.equal(existsSync(resultFile), true);
  const cleaned = await f.service.cleanup({ categories: ['task-output'], preview: false });
  assert.deepEqual(cleaned.failed, []);
  assert.equal(cleaned.files, 2);
  assert.equal(existsSync(resultFile), false);
  assert.equal(existsSync(screenshot), false);
  assert.equal(existsSync(leftover), true, 'output selection must not expand to temporary-files');
  assert.equal(existsSync(f.source), true);
  const retained = await f.service.get(item.task.id);
  assert.equal(retained.state, 'finished');
  assert.ok(Date.parse(retained.outputClearedAt));
});

test('busy manual Profiles and physically active or unknown Chrome Profiles keep every cache', async (t) => {
  const usage = new Map();
  const probes = [];
  const f = await fixture(t, { profileUsageProbe: async (directory) => {
    probes.push(directory);
    return usage.get(directory) ?? 'inactive';
  } });
  const manual = f.profile;
  const active = await f.profileStore.create({ name: 'Physical active' });
  const unknown = await f.profileStore.create({ name: 'Physical unknown' });
  f.alive.add(90_001);
  await f.profileStore.acquireLease(manual.id, {
    ownerId: 'manual:fixture', kind: 'manual', pid: 90_001, nonce: 'manual-fixture', ttlMs: 60_000
  });
  usage.set(active.userDataDir, 'active');
  usage.set(unknown.userDataDir, 'unknown');
  const cacheFiles = await Promise.all([manual, active, unknown].map((profile) => (
    put(path.join(profile.userDataDir, 'Default', 'Cache', 'entry'))
  )));
  const report = await f.service.cleanup({ categories: ['browser-cache'], preview: false });
  assert.equal(report.files, 0);
  for (const profile of [manual, active, unknown]) {
    assert.ok(report.skipped.some((item) => item.kind === 'profile' && item.id === profile.id && item.reason));
  }
  assert.equal(probes.includes(manual.userDataDir), false, 'leased manual Profile must not even be probed');
  for (const file of cacheFiles) assert.equal(existsSync(file), true);
});

test('queued, verification-waiting, live-Worker and quarantined terminal tasks are never cleaned or stopped', async (t) => {
  const f = await fixture(t);
  const waiting = await f.createTask();
  waiting.worker.emit('message', {
    type: 'waiting', waiting: { id: 'wait_verification_fixture', reason: 'verification', kind: 'verification' }
  });
  await until(async () => (await f.service.get(waiting.task.id)).state === 'waiting');
  const queued = await f.service.create({ modulePath: f.source, profileId: f.profile.id });
  const liveProfile = await f.profileStore.create({ name: 'Still exiting' });
  const live = await f.createTask(liveProfile);
  live.worker.emit('message', { type: 'state', state: 'finished' });
  const quarantinedProfile = await f.profileStore.create({ name: 'Quarantined' });
  const quarantined = await f.finishTask(await f.createTask(quarantinedProfile));
  f.alive.add(90_002);
  const leased = await f.profileStore.acquireLease(quarantinedProfile.id, {
    ownerId: `task:${quarantined.task.id}`, kind: 'task', taskId: quarantined.task.id,
    pid: 90_002, nonce: 'quarantine-fixture', ttlMs: 60_000
  });
  await f.profileStore.markLeaseError(quarantinedProfile.id, leased.lease);
  const ids = [waiting.task.id, queued.id, live.task.id, quarantined.task.id];
  const outputs = await Promise.all(ids.map((id) => put(path.join(f.root, 'tasks', id, 'output', 'keep.txt'))));
  const report = await f.service.cleanup({ categories: ['temporary-files', 'task-output'], preview: false });
  assert.equal(report.files, 0);
  for (const id of ids) assert.ok(report.skipped.some((item) => item.kind === 'task' && item.id === id));
  for (const file of outputs) assert.equal(existsSync(file), true);
  assert.equal((await f.service.get(queued.id)).state, 'queued');
  assert.equal((await f.service.get(waiting.task.id)).state, 'waiting');
  assert.equal((await f.service.get(quarantined.task.id)).state, 'finished');
  assert.equal(f.workers.some((worker) => worker.messages.some((message) => message.type === 'stop')), false);
});

test('execution rechecks Profile state after a successful preview', async (t) => {
  const f = await fixture(t);
  const cache = await put(path.join(f.profile.userDataDir, 'Default', 'Cache', 'entry'));
  assert.equal((await f.service.cleanup({ categories: ['browser-cache'] })).files, 1);
  const running = await f.createTask();
  const report = await f.service.cleanup({ categories: ['browser-cache'], preview: false });
  assert.equal(report.files, 0);
  assert.ok(report.skipped.some((item) => item.id === f.profile.id));
  assert.equal(existsSync(cache), true);
  assert.equal((await f.service.get(running.task.id)).state, 'running');
});

test('Profile cleanup reserves only its Profile while other reads run and task launch queues', async (t) => {
  const entered = deferred();
  const release = deferred();
  const f = await fixture(t, { profileUsageProbe: async () => {
    entered.resolve();
    await release.promise;
    return 'inactive';
  } });
  await put(path.join(f.profile.userDataDir, 'Default', 'Cache', 'entry'));
  const cleaning = f.service.cleanup({ categories: ['browser-cache'], preview: false });
  cleaning.catch(() => {});
  try {
    await bounded(entered.promise);
    await assert.rejects(bounded(f.service.cleanup()), { code: 'CLEANUP_BUSY', statusCode: 409 });
    await assert.rejects(bounded(f.service.openProfile(f.profile.id)), { code: 'PROFILE_OPERATION_ACTIVE' });
    await assert.rejects(bounded(f.service.deleteProfile(f.profile.id)), { code: 'PROFILE_OPERATION_ACTIVE' });
    const queued = await bounded(f.service.create({ modulePath: f.source, profileId: f.profile.id }));
    assert.equal((await bounded(f.service.get(queued.id))).state, 'queued');
    assert.equal(f.workers.length, 0, 'the reserved Profile cannot launch a task');
    release.resolve();
    await cleaning;
    await until(() => f.workers.length === 1 && f.workers[0].config?.taskId === queued.id);
  } finally {
    release.resolve();
    await cleaning;
  }
});

test('task cleanup holds only its task reservation and rejects deletion until disk work finishes', async (t) => {
  const f = await fixture(t, { useRootAlias: true });
  const item = await f.finishTask(await f.createTask());
  await put(path.join(item.outputDir, 'result.txt'));
  const canonicalOutputDir = await realpath(item.outputDir);
  assert.notEqual(path.resolve(item.outputDir), canonicalOutputDir, 'fixture must exercise a filesystem alias');
  const entered = deferred();
  const release = deferred();
  const original = fsPromises.readdir;
  const mock = t.mock.method(fsPromises, 'readdir', async (directory, ...args) => {
    if (await realpath(directory) === canonicalOutputDir) {
      entered.resolve();
      await release.promise;
    }
    return original(directory, ...args);
  });
  syncBuiltinESMExports();
  const cleaning = f.service.cleanup({ categories: ['task-output'], preview: false });
  cleaning.catch(() => {});
  try {
    await bounded(entered.promise);
    await assert.rejects(bounded(f.service.deleteTask(item.task.id)), { code: 'TASK_CLEANUP_ACTIVE', statusCode: 409 });
    assert.equal((await bounded(f.service.get(item.task.id))).state, 'finished', 'disk work must not hold the global serializer');
    release.resolve();
    const report = await cleaning;
    assert.equal(report.files, 1);
    assert.equal((await f.service.get(item.task.id)).state, 'finished');
  } finally {
    release.resolve();
    await cleaning;
    mock.mock.restore();
    syncBuiltinESMExports();
  }
});

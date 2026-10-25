import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { JsonStore } from '../src/lib/json-store.mjs';
import { ProfileStore } from '../src/lib/profile-store.mjs';
import { createTaskService } from '../src/runtime/task-service.mjs';
import { removeTestTree } from './test-fs.mjs';

async function fixture(t, count) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-cleanup-scale-'));
  const stateDir = path.join(root, 'tasks');
  const storePath = path.join(stateDir, 'tasks.json');
  const profileStore = new ProfileStore({
    filePath: path.join(root, 'profiles.json'), profilesRoot: path.join(root, 'profiles'),
    processAlive: () => false, profileUsageProbe: async () => 'inactive'
  });
  await profileStore.init();
  const profile = await profileStore.create({ name: 'Synthetic scale fixture' });
  const timestamp = '2026-10-25T00:00:00.000Z';
  const records = Array.from({ length: count }, (_, index) => ({
    id: `task_${index.toString(16).padStart(32, '0')}`, label: `Synthetic ${index}`,
    profileId: profile.id, profileName: profile.name, state: 'finished',
    events: [], eventSequence: 0, createdAt: timestamp, finishedAt: timestamp,
    result: { retained: index }, progress: { current: index, total: count, message: '' }
  }));
  await mkdir(stateDir);
  await writeFile(storePath, JSON.stringify({ version: 1, tasks: records, tombstones: [] }));
  const service = createTaskService({
    stateDir, profileStore, profileUsageProbe: async () => 'inactive',
    workerFactory: () => { throw new Error('No browser may start in scale fixtures'); },
    profileWorkerFactory: () => { throw new Error('No browser may start in scale fixtures'); },
    processAlive: () => false, reaperIntervalMs: 60_000
  });
  t.after(async () => { await service.close(); await removeTestTree(root); });
  await service.status(); // Initialization writes once, before cleanup measurements.
  const outputFile = async (index, name = 'result.txt') => {
    const file = path.join(stateDir, records[index].id, 'output', name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, 'fixture-output');
    return file;
  };
  return { root, stateDir, storePath, records, service, outputFile };
}

test('2061 historical tasks use bounded batch writes, retain records, and avoid unchanged repeat writes', async (t) => {
  const f = await fixture(t, 2061);
  const files = await Promise.all([0, 1024, 2060].map((index) => f.outputFile(index)));
  const replace = JsonStore.prototype.replace;
  let writes = 0;
  t.mock.method(JsonStore.prototype, 'replace', function (value) {
    if (this.filePath === f.storePath) writes += 1;
    return replace.call(this, value);
  });
  const report = await f.service.cleanup({ categories: ['task-output'], preview: false });
  assert.equal(report.files, 3);
  assert.deepEqual(report.failed, []);
  assert.deepEqual(report.skipped, []);
  assert.equal(writes, Math.ceil(f.records.length / 64), 'persist only once per 64 changes plus the final partial batch');
  for (const file of files) assert.equal(existsSync(file), false);
  let persisted = JSON.parse(await readFile(f.storePath, 'utf8'));
  assert.equal(persisted.tasks.length, f.records.length);
  for (let index = 0; index < f.records.length; index += 1) {
    const task = persisted.tasks[index];
    assert.deepEqual(task.result, { retained: index });
    assert.equal(task.state, 'finished');
    assert.ok(Date.parse(task.outputClearedAt));
    assert.equal(task.events.filter((event) => event.type === 'task.output_cleaned').length, 1);
  }
  const progress = (await f.service.status()).cleanup;
  assert.equal(progress.current, f.records.length);
  assert.equal(progress.total, f.records.length);
  assert.equal(progress.files, 3);

  writes = 0;
  assert.equal((await f.service.cleanup({ categories: ['task-output'], preview: false })).files, 0);
  assert.equal(writes, 0, 'already-cleared output still gets disk checks but no duplicate events or full-table writes');
  const lateFile = await f.outputFile(2060, 'late.txt');
  const late = await f.service.cleanup({ categories: ['task-output'], preview: false });
  assert.equal(late.files, 1, 'a prior cleared marker must not skip a newly arrived file');
  assert.equal(existsSync(lateFile), false);
  assert.equal(writes, 1);
  persisted = JSON.parse(await readFile(f.storePath, 'utf8'));
  assert.equal(persisted.tasks.at(-1).events.length, 2);
  assert.deepEqual(persisted.tasks.at(-1).result, { retained: 2060 });
});

test('partial output failures retain unsafe files, clear stale success markers, and flush the last partial batch', async (t) => {
  const f = await fixture(t, 67);
  await f.service.cleanup({ categories: ['task-output'], preview: false });
  const canaryDir = path.join(f.root, 'outside-output');
  await mkdir(canaryDir);
  const canary = path.join(canaryDir, 'keep.txt');
  await writeFile(canary, 'keep');
  const outputDir = path.join(f.stateDir, f.records[66].id, 'output');
  await mkdir(path.dirname(outputDir), { recursive: true });
  await symlink(canaryDir, outputDir, process.platform === 'win32' ? 'junction' : 'dir');
  const removed = await f.outputFile(0);
  const report = await f.service.cleanup({ categories: ['task-output'], preview: false });
  assert.equal(report.files, 1);
  assert.equal(report.skipped.length, 1);
  assert.equal(report.skipped[0].reason, 'SYMLINK_OR_JUNCTION');
  assert.equal(existsSync(removed), false);
  assert.equal(await readFile(canary, 'utf8'), 'keep');
  const persisted = JSON.parse(await readFile(f.storePath, 'utf8'));
  assert.equal(persisted.tasks[66].outputClearedAt, null, 'a late unsafe output must invalidate an earlier success marker');
  assert.equal(persisted.tasks[66].events.at(-1).data.skipped, 1);
  assert.ok(persisted.tasks[0].outputClearedAt);
  assert.deepEqual(persisted.tasks[66].result, { retained: 66 });
  assert.equal((await f.service.status()).cleanup.skipped, 1);
});

test('an unexpected batch persistence error flushes completed metadata before surfacing the original failure', async (t) => {
  const f = await fixture(t, 67);
  const replace = JsonStore.prototype.replace;
  let attempted = 0;
  t.mock.method(JsonStore.prototype, 'replace', function (value) {
    if (this.filePath === f.storePath && ++attempted === 1) {
      throw Object.assign(new Error('Synthetic write failure'), { code: 'EIO' });
    }
    return replace.call(this, value);
  });
  await assert.rejects(f.service.cleanup({ categories: ['task-output'], preview: false }), { code: 'EIO' });
  assert.equal(attempted, 2, 'completed batch should receive a final flush after a non-fencing error');
  const persisted = JSON.parse(await readFile(f.storePath, 'utf8'));
  assert.equal(persisted.tasks.filter((task) => task.outputClearedAt).length, 64);
  assert.equal(persisted.tasks[64].outputClearedAt, undefined);
  const progress = (await f.service.status()).cleanup;
  assert.equal(progress.state, 'error');
  assert.equal(progress.current, 64);
  assert.equal(progress.total, 67);
  assert.deepEqual(progress.error, { code: 'EIO' });
  assert.ok(Date.parse(progress.finishedAt));
});

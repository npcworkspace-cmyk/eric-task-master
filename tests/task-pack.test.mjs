import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readTaskPack, scaffoldTaskPack } from '../src/lib/task-pack.mjs';
import { TaskTypeRegistry } from '../src/lib/task-type-registry.mjs';

async function registryFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-pack-'));
  const allowed = path.join(root, 'allowed');
  await mkdir(allowed);
  const registry = new TaskTypeRegistry({
    filePath: path.join(root, 'types.json'),
    snapshotRoot: path.join(root, 'snapshots'),
    allowedRoots: [allowed],
    seedTypes: []
  });
  await registry.list();
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, allowed, registry };
}

test('Task Pack scaffold is portable, bounded, and path-safe', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-pack-scaffold-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const destination = path.join(root, 'sample');
  const created = await scaffoldTaskPack(destination, { name: 'sample-pack' });
  assert.equal(created.pack.name, 'sample-pack');
  assert.equal(created.pack.tasks[0].name, 'sample-pack.example');
  assert.equal((await readTaskPack(path.join(destination, 'taskpack.json'))).modules.length, 1);
  assert.match(await readFile(path.join(destination, 'tasks', 'example.mjs'), 'utf8'), /supportsResume/u);

  const outside = path.join(root, 'outside.mjs');
  await writeFile(outside, 'export async function run() {}\n');
  await writeFile(path.join(destination, 'taskpack.json'), JSON.stringify({
    name: 'sample-pack',
    version: '1.0.0',
    tasks: [{ name: 'sample-pack.escape', module: '../outside.mjs' }]
  }));
  await assert.rejects(readTaskPack(destination), { code: 'INVALID_TASK_PACK' });
});

test('Task Pack batch install is all-or-nothing and exposes progressive discovery metadata', async (t) => {
  const { allowed, registry } = await registryFixture(t);
  const source = (version, intent) => [
    'export const meta = {',
    `  version: ${JSON.stringify(version)},`,
    `  intents: [${JSON.stringify(intent)}],`,
    "  tags: ['pack-fixture'], outputs: ['json'],",
    "  risk: 'read', readOnly: true, supportsResume: true,",
    "  inputSchema: { type: 'object', properties: { url: { type: 'string' } } }",
    '};',
    'export async function run() { return { summary: "ok", evidence: [] }; }',
    ''
  ].join('\n');
  const first = path.join(allowed, 'first.mjs');
  const second = path.join(allowed, 'second.mjs');
  await writeFile(first, source('1.0.0', 'collect-one'));
  await writeFile(second, source('1.0.0', 'collect-two'));

  const installed = await registry.installBatch([
    { name: 'pack.first', modulePath: first },
    { name: 'pack.second', modulePath: second }
  ], { pack: { name: 'sample-pack', version: '1.0.0' } });
  assert.equal(installed.length, 2);
  const summaries = await registry.listSummaries();
  assert.equal('inputSchema' in summaries[0], false);
  assert.deepEqual(summaries[0].pack, { name: 'sample-pack', version: '1.0.0' });
  assert.equal(summaries[0].supportsResume, true);
  const described = await registry.describe('pack.first');
  assert.equal(described.inputSchema.properties.url.type, 'string');

  const third = path.join(allowed, 'third.mjs');
  const conflict = path.join(allowed, 'conflict.mjs');
  await writeFile(third, source('1.0.0', 'collect-three'));
  await writeFile(conflict, source('2.0.0', 'collect-two'));
  await assert.rejects(
    registry.installBatch([
      { name: 'pack.third', modulePath: third },
      { name: 'pack.second', modulePath: conflict }
    ], { pack: { name: 'broken-pack', version: '1.0.0' } }),
    { code: 'TASK_TYPE_CONFLICT', statusCode: 409 }
  );
  assert.equal((await registry.list()).some((item) => item.name === 'pack.third'), false);
});

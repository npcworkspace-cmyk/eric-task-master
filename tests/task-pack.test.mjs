import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { preflightTaskPack, readTaskPack, scaffoldTaskPack } from '../src/lib/task-pack.mjs';
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

function packModuleSource(version, intent) {
  return [
    'export const meta = {',
    `  version: ${JSON.stringify(version)}, intents: [${JSON.stringify(intent)}],`,
    "  tags: ['pack-fixture'], outputs: ['json'], risk: 'read', readOnly: true, supportsResume: true",
    '};',
    'export async function run({ journey }) { await journey.open("https://example.test"); return { summary: "ok", evidence: [] }; }',
    ''
  ].join('\n');
}

test('Task Pack scaffold is portable, bounded, and path-safe', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-pack-scaffold-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const destination = path.join(root, 'sample');
  const created = await scaffoldTaskPack(destination, { name: 'sample-pack' });
  assert.equal(created.pack.name, 'sample-pack');
  assert.equal(created.pack.interactionContract, 'full-human-v1');
  assert.deepEqual(created.pack.tasks[0], {
    name: 'sample-pack.single-page.v1',
    module: 'tasks/single-page-v1.mjs'
  });
  assert.equal((await readTaskPack(path.join(destination, 'taskpack.json'))).modules.length, 1);
  assert.match((await preflightTaskPack(destination)).nextAction, /^Install this validated Pack/u);
  assert.match(await readFile(path.join(destination, 'tasks', 'single-page-v1.mjs'), 'utf8'), /supportsResume/u);

  const legacy = path.join(root, 'legacy');
  await mkdir(path.join(legacy, 'tasks'), { recursive: true });
  await writeFile(path.join(legacy, 'tasks', 'collect.mjs'), 'export async function run() {}\n');
  await writeFile(path.join(legacy, 'taskpack.json'), JSON.stringify({
    name: 'legacy-pack',
    version: '1.0.0',
    tasks: [{ name: 'legacy-pack.collect', module: 'tasks/collect.mjs' }]
  }));
  await assert.rejects(readTaskPack(legacy), { code: 'INVALID_TASK_PACK' });

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
    'export async function run({ journey }) { await journey.open("https://example.test"); return { summary: "ok", evidence: [] }; }',
    ''
  ].join('\n');
  const first = path.join(allowed, 'first.mjs');
  const second = path.join(allowed, 'second.mjs');
  await writeFile(first, source('1.0.0', 'collect-one'));
  await writeFile(second, source('1.0.0', 'collect-two'));

  const installed = await registry.installBatch([
    { name: 'pack.first', modulePath: first },
    { name: 'pack.second', modulePath: second }
  ], { pack: { name: 'sample-pack', version: '1.0.0', interactionContract: 'full-human-v1' } });
  assert.equal(installed.length, 2);
  const summaries = await registry.listSummaries();
  assert.equal('inputSchema' in summaries[0], false);
  assert.deepEqual(summaries[0].pack, {
    name: 'sample-pack', version: '1.0.0', lifecycle: 'active',
    discoverable: true, protected: false, transient: false
  });
  assert.equal(summaries[0].interactionContract, 'full-human-v1');
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
    ], { pack: { name: 'broken-pack', version: '1.0.0', interactionContract: 'full-human-v1' } }),
    { code: 'TASK_TYPE_CONFLICT', statusCode: 409 }
  );
  assert.equal((await registry.list()).some((item) => item.name === 'pack.third'), false);
});

test('Task Pack install attaches provenance to an identical standalone type without allowing reassignment', async (t) => {
  const { allowed, registry } = await registryFixture(t);
  const modulePath = path.join(allowed, 'shared.mjs');
  await writeFile(modulePath, [
    "export const meta = { version: '1.0.0', risk: 'read', readOnly: true };",
    "export async function run({ journey }) { await journey.open('https://example.test'); return { summary: 'ok', evidence: [{ kind: 'message', value: 'ok' }] }; }",
    ''
  ].join('\n'));

  const standalone = await registry.install({ name: 'pack.shared', modulePath });
  assert.equal(standalone.pack, undefined);

  const [attached] = await registry.installBatch([
    { name: 'pack.shared', modulePath }
  ], { pack: { name: 'sample-pack', version: '1.0.0', interactionContract: 'full-human-v1' } });
  assert.deepEqual(attached.pack, {
    name: 'sample-pack', version: '1.0.0', lifecycle: 'active',
    discoverable: true, protected: false, transient: false
  });
  assert.deepEqual((await registry.describe('pack.shared')).pack, {
    name: 'sample-pack', version: '1.0.0', lifecycle: 'active',
    discoverable: true, protected: false, transient: false
  });

  await assert.rejects(
    registry.installBatch([
      { name: 'pack.shared', modulePath }
    ], { pack: { name: 'other-pack', version: '1.0.0', interactionContract: 'full-human-v1' } }),
    { code: 'TASK_TYPE_PACK_CONFLICT', statusCode: 409 }
  );
  assert.deepEqual((await registry.describe('pack.shared')).pack, {
    name: 'sample-pack', version: '1.0.0', lifecycle: 'active',
    discoverable: true, protected: false, transient: false
  });
});

test('Task Pack preflight rejects legacy action and direct Page mutation bypasses', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-pack-bypass-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'tasks'), { recursive: true });
  await writeFile(path.join(root, 'taskpack.json'), JSON.stringify({
    name: 'unsafe-pack',
    version: '1.0.0',
    interactionContract: 'full-human-v1',
    tasks: [{ name: 'unsafe-pack.collect.v1', module: 'tasks/collect.mjs' }]
  }));
  await writeFile(path.join(root, 'tasks', 'collect.mjs'), [
    'export async function run({ page, action, journey }) {',
    "  await action.goto('https://example.test');",
    "  await page.goto('https://example.test/next');",
    '  return { summary: journey.contract, evidence: [] };',
    '}',
    ''
  ].join('\n'));

  const result = await preflightTaskPack(root);
  assert.equal(result.ok, false);
  assert.equal(result.checks[0].code, 'TASK_PACK_JOURNEY_BYPASS');
});

test('installing a newer Task Pack version retires the older version and blocks downgrade', async (t) => {
  const { allowed, registry } = await registryFixture(t);
  const oldModule = path.join(allowed, 'old.mjs');
  const nextModule = path.join(allowed, 'next.mjs');
  await writeFile(oldModule, packModuleSource('1.0.0', 'collect-v1'));
  await writeFile(nextModule, packModuleSource('2.0.0', 'collect-v2'));
  await registry.installBatch([{ name: 'news.collect.v1', modulePath: oldModule }], {
    pack: { name: 'news-pack', version: '1.0.0', title: 'News collection', interactionContract: 'full-human-v1' }
  });
  await registry.installBatch([{ name: 'news.collect.v2', modulePath: nextModule }], {
    pack: { name: 'news-pack', version: '2.0.0', title: 'News collection', interactionContract: 'full-human-v1' }
  });
  const managed = await registry.listManagement();
  assert.equal(managed.find((item) => item.name === 'news.collect.v1').lifecycle, 'deprecated');
  assert.equal(managed.find((item) => item.name === 'news.collect.v2').lifecycle, 'active');
  assert.equal(managed.find((item) => item.name === 'news.collect.v2').pack.title, 'News collection');
  await assert.rejects(
    registry.installBatch([{ name: 'news.collect.v1b', modulePath: oldModule }], {
      pack: { name: 'news-pack', version: '1.5.0', interactionContract: 'full-human-v1' }
    }),
    { code: 'TASK_PACK_VERSION_REGRESSION', statusCode: 409 }
  );
});

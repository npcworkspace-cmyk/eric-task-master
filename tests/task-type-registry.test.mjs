import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TaskTypeRegistry } from '../src/lib/task-type-registry.mjs';

async function fixture(t, { inspectionTimeoutMs = 500 } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-task-types-'));
  const allowed = path.join(root, 'allowed');
  const snapshotRoot = path.join(root, 'snapshots');
  const filePath = path.join(root, 'task-types.json');
  await mkdir(allowed);
  const registry = new TaskTypeRegistry({
    filePath,
    snapshotRoot,
    allowedRoots: [allowed],
    seedTypes: [],
    inspectionTimeoutMs
  });
  await registry.list();
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, allowed, snapshotRoot, filePath, registry };
}

async function writeModule(directory, filename, source) {
  const modulePath = path.join(directory, filename);
  await writeFile(modulePath, source, 'utf8');
  return modulePath;
}

test('a short-lived inspector accepts a valid task module and bounded metadata', async (t) => {
  const { allowed, registry } = await fixture(t);
  const modulePath = await writeModule(allowed, 'valid.mjs', [
    'export const meta = {',
    '  title: "Readable task",',
    '  description: "A valid inspector fixture",',
    '  version: "1.2.3",',
    '  readOnly: true,',
    '  inputSchema: { type: "object", additionalProperties: false, properties: { url: { type: "string", minLength: 8 } } }',
    '};',
    'export async function run() { return { summary: "ok", evidence: [] }; }',
    ''
  ].join('\n'));

  const installed = await registry.install({ name: 'valid', modulePath });
  assert.equal(installed.name, 'valid');
  assert.equal(installed.title, 'Readable task');
  assert.equal(installed.version, '1.2.3');
  assert.equal(installed.readOnly, true);
  assert.equal(installed.inputSchema.properties.url.minLength, 8);
  assert.match(installed.sha256, /^[a-f0-9]{64}$/);
});

test('external-cost task metadata is no longer accepted', async (t) => {
  const { allowed, registry } = await fixture(t);
  const modulePath = await writeModule(allowed, 'legacy-paid.mjs', [
    'export const meta = { externalCost: { currency: "USD", maxAmountPerRun: 1 } };',
    'export async function run() { return { summary: "unused", evidence: [] }; }',
    ''
  ].join('\n'));
  await assert.rejects(
    registry.install({ name: 'legacy-paid', modulePath }),
    { code: 'TASK_EXTERNAL_COST_UNSUPPORTED' }
  );
});

test('legacy external-cost registry entries retire without exposing or restoring the removed contract', async (t) => {
  const { allowed, snapshotRoot, filePath, registry } = await fixture(t);
  const modulePath = await writeModule(
    allowed,
    'legacy-paid-record.mjs',
    'export async function run() { return { summary: "unused", evidence: [] }; }\n'
  );
  await registry.install({ name: 'legacy-paid-record', modulePath });
  const persisted = JSON.parse(await readFile(filePath, 'utf8'));
  persisted.types[0].externalCost = { currency: 'USD', maxAmountPerRun: 5 };
  await writeFile(filePath, `${JSON.stringify(persisted)}\n`, 'utf8');

  const reopened = new TaskTypeRegistry({
    filePath,
    snapshotRoot,
    allowedRoots: [allowed],
    seedTypes: []
  });
  assert.deepEqual(await reopened.listSummaries(), []);
  const described = await reopened.describe('legacy-paid-record');
  assert.equal(described.lifecycle, 'deprecated');
  assert.equal(Object.hasOwn(described, 'externalCost'), false);
  await assert.rejects(reopened.resolve('legacy-paid-record'), { code: 'TASK_EXTERNAL_COST_UNSUPPORTED' });
  await assert.rejects(reopened.restore('legacy-paid-record'), { code: 'TASK_EXTERNAL_COST_UNSUPPORTED' });

  const migrated = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(migrated.types[0].legacyPaidRuntime, true);
  assert.equal(migrated.types[0].discoverable, false);
  assert.equal(Object.hasOwn(migrated.types[0], 'externalCost'), false);
});

test('task modules cannot override Profile-owned behavior policy', async (t) => {
  const { allowed, registry } = await fixture(t);
  const modulePath = await writeModule(allowed, 'behavior-owned.mjs', [
    'export const meta = { preferredBehavior: "fast" };',
    'export async function run() { return { summary: "unused", evidence: [] }; }',
    ''
  ].join('\n'));

  await assert.rejects(
    registry.install({ name: 'behavior-owned', modulePath }),
    {
      code: 'TASK_BEHAVIOR_PROFILE_OWNED',
      message: 'Task behavior belongs to the selected Profile; remove meta.preferredBehavior'
    }
  );
});

test('legacy registry records remain readable without exposing preferredBehavior', async (t) => {
  const { allowed, snapshotRoot, filePath, registry } = await fixture(t);
  const modulePath = await writeModule(
    allowed,
    'legacy-behavior.mjs',
    'export async function run() { return { summary: "ok", evidence: [] }; }\n'
  );
  await registry.install({ name: 'legacy-behavior', modulePath });
  const persisted = JSON.parse(await readFile(filePath, 'utf8'));
  persisted.types[0].preferredBehavior = 'fast';
  await writeFile(filePath, `${JSON.stringify(persisted)}\n`, 'utf8');

  const reopened = new TaskTypeRegistry({
    filePath,
    snapshotRoot,
    allowedRoots: [allowed],
    seedTypes: []
  });
  const [listed] = await reopened.list();
  const described = await reopened.describe('legacy-behavior');
  assert.equal(Object.hasOwn(listed, 'preferredBehavior'), false);
  assert.equal(Object.hasOwn(described, 'preferredBehavior'), false);
});

test('top-level process.exit is contained to the inspector process', async (t) => {
  const { allowed, registry } = await fixture(t);
  const exiting = await writeModule(allowed, 'exit.mjs', [
    'process.exit(23);',
    'export async function run() {}',
    ''
  ].join('\n'));

  await assert.rejects(
    registry.install({ name: 'exiting', modulePath: exiting }),
    { code: 'INVALID_TASK_MODULE' }
  );

  const healthy = await writeModule(
    allowed,
    'healthy.mjs',
    'export async function run() { return { summary: "still alive", evidence: [] }; }\n'
  );
  assert.equal((await registry.install({ name: 'healthy', modulePath: healthy })).name, 'healthy');
});

test('top-level module exceptions fail closed inside the inspector', async (t) => {
  const { allowed, registry } = await fixture(t);
  const throwing = await writeModule(allowed, 'throwing.mjs', [
    'throw new Error("top-level fixture failure");',
    'export async function run() {}',
    ''
  ].join('\n'));
  await assert.rejects(
    registry.install({ name: 'throwing', modulePath: throwing }),
    (error) => error?.code === 'INVALID_TASK_MODULE'
      && !error.message.includes('top-level fixture failure')
  );
});

test('top-level await forever times out closed without poisoning later installs', async (t) => {
  const { allowed, registry } = await fixture(t, { inspectionTimeoutMs: 150 });
  const waiting = await writeModule(allowed, 'forever.mjs', [
    'setInterval(() => {}, 1_000);',
    'await new Promise(() => {});',
    'export async function run() {}',
    ''
  ].join('\n'));
  const startedAt = Date.now();
  await assert.rejects(
    registry.install({ name: 'forever', modulePath: waiting }),
    { code: 'TASK_MODULE_INSPECTION_TIMEOUT' }
  );
  assert.ok(Date.now() - startedAt < 2_000);

  const healthy = await writeModule(
    allowed,
    'after-timeout.mjs',
    'export async function run() { return { summary: "ok", evidence: [] }; }\n'
  );
  assert.equal((await registry.install({ name: 'after-timeout', modulePath: healthy })).name, 'after-timeout');
});

test('inspector result size and JSON shape fail closed', async (t) => {
  const { allowed, registry } = await fixture(t);
  const oversized = await writeModule(allowed, 'oversized.mjs', [
    'export const meta = { description: "x".repeat(100 * 1024) };',
    'export async function run() {}',
    ''
  ].join('\n'));
  await assert.rejects(
    registry.install({ name: 'oversized', modulePath: oversized }),
    { code: 'INVALID_TASK_METADATA' }
  );

  const cyclic = await writeModule(allowed, 'cyclic.mjs', [
    'const meta = {};',
    'meta.self = meta;',
    'export { meta };',
    'export async function run() {}',
    ''
  ].join('\n'));
  await assert.rejects(
    registry.install({ name: 'cyclic', modulePath: cyclic }),
    { code: 'INVALID_TASK_METADATA' }
  );
});

test('snapshot is hashed again after inspection before registration', async (t) => {
  const { allowed, registry } = await fixture(t);
  const mutating = await writeModule(allowed, 'mutating.mjs', [
    'import { writeFileSync } from "node:fs";',
    'import { fileURLToPath } from "node:url";',
    'export const meta = { title: "Mutating" };',
    'export async function run() {}',
    'writeFileSync(fileURLToPath(import.meta.url), "export async function run() {}\\n");',
    ''
  ].join('\n'));
  await assert.rejects(
    registry.install({ name: 'mutating', modulePath: mutating }),
    { code: 'TASK_SNAPSHOT_CHANGED' }
  );
});

test('same SHA is idempotent while same-name different content is a 409 conflict', async (t) => {
  const { allowed, registry } = await fixture(t);
  const modulePath = await writeModule(
    allowed,
    'stable.mjs',
    'export const meta = { version: "1" }; export async function run() {}\n'
  );
  const first = await registry.install({ name: 'stable', modulePath });
  const repeated = await registry.install({ name: 'stable', modulePath });
  assert.deepEqual(repeated, first);

  await writeFile(
    modulePath,
    'export const meta = { version: "2" }; export async function run() {}\n',
    'utf8'
  );
  await assert.rejects(
    registry.install({ name: 'stable', modulePath, allowUpdate: true }),
    (error) => error?.code === 'TASK_TYPE_CONFLICT' && error?.statusCode === 409
  );
  await writeFile(modulePath, 'process.exit(31); export async function run() {}\n', 'utf8');
  await assert.rejects(
    registry.install({ name: 'stable', modulePath }),
    (error) => error?.code === 'TASK_TYPE_CONFLICT' && error?.statusCode === 409
  );
  assert.equal((await registry.list())[0].sha256, first.sha256);
});

test('concurrent same-name different installs publish exactly one snapshot record', async (t) => {
  const { allowed, registry } = await fixture(t);
  const firstPath = await writeModule(
    allowed,
    'race-a.mjs',
    'export const meta = { version: "a" }; export async function run() {}\n'
  );
  const secondPath = await writeModule(
    allowed,
    'race-b.mjs',
    'export const meta = { version: "b" }; export async function run() {}\n'
  );
  const outcomes = await Promise.allSettled([
    registry.install({ name: 'raced', modulePath: firstPath }),
    registry.install({ name: 'raced', modulePath: secondPath })
  ]);
  const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
  const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, 'TASK_TYPE_CONFLICT');
  assert.equal(rejected[0].reason.statusCode, 409);
  const listed = await registry.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].sha256, fulfilled[0].value.sha256);
});

test('seed initialization explicitly updates a same-name built-in task', async (t) => {
  const { allowed, snapshotRoot, filePath } = await fixture(t);
  const modulePath = await writeModule(
    allowed,
    'seed.mjs',
    'export const meta = { version: "1" }; export async function run() {}\n'
  );
  const firstRegistry = new TaskTypeRegistry({
    filePath,
    snapshotRoot,
    allowedRoots: [allowed],
    seedTypes: [{ name: 'seed', modulePath }]
  });
  const first = (await firstRegistry.list())[0];

  await writeFile(
    modulePath,
    'export const meta = { version: "2" }; export async function run() {}\n',
    'utf8'
  );
  const updatedRegistry = new TaskTypeRegistry({
    filePath,
    snapshotRoot,
    allowedRoots: [allowed],
    seedTypes: [{ name: 'seed', modulePath }]
  });
  const updated = (await updatedRegistry.list())[0];
  assert.equal(updated.version, '2');
  assert.notEqual(updated.sha256, first.sha256);

  const persisted = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(persisted.types[0].sha256, updated.sha256);
});

test('asset lifecycle exposes notes, discovery, inventory, and safe physical removal', async (t) => {
  const { allowed, snapshotRoot, registry } = await fixture(t);
  const modulePath = await writeModule(
    allowed,
    'asset.mjs',
    'export const meta = { title: "Reusable collector", description: "Collects bounded public data" };\nexport async function run() { return { summary: "ok", evidence: [] }; }\n'
  );
  const installed = await registry.install({
    name: 'asset.collect.v1',
    modulePath,
    transient: true,
    note: 'Created for one campaign'
  });
  let [asset] = await registry.listManagement();
  assert.equal(asset.assetKind, 'standalone');
  assert.equal(asset.discoverable, true);
  assert.equal(asset.transient, true);
  assert.equal(asset.note, 'Created for one campaign');

  await registry.setNoteMany(['asset.collect.v1'], 'Reusable after review');
  await registry.setLifecycleMany(['asset.collect.v1'], 'deprecated');
  assert.equal((await registry.listSummaries()).length, 0);
  asset = (await registry.listManagement())[0];
  assert.equal(asset.note, 'Reusable after review');
  assert.equal(asset.lifecycle, 'deprecated');

  await registry.setLifecycleMany(['asset.collect.v1'], 'active');
  const inventory = await registry.snapshotInventory();
  assert.equal(inventory.length, 1);
  assert.equal(inventory[0].registered, true);
  await registry.removeMany(['asset.collect.v1']);
  assert.equal((await registry.listManagement()).length, 0);
  assert.equal(await lstat(path.join(snapshotRoot, `${installed.name}-${installed.sha256}.mjs`)).catch(() => null), null);
});

test('system seed assets are protected and omitted from ordinary Agent discovery', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-system-assets-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const allowed = path.join(root, 'allowed');
  await mkdir(allowed);
  const modulePath = await writeModule(
    allowed,
    'system.mjs',
    'export async function run() { return { summary: "ok", evidence: [] }; }\n'
  );
  const registry = new TaskTypeRegistry({
    filePath: path.join(root, 'types.json'),
    snapshotRoot: path.join(root, 'snapshots'),
    allowedRoots: [allowed],
    seedTypes: [{ name: 'acceptance-system', modulePath }]
  });
  assert.deepEqual(await registry.listSummaries(), []);
  const [asset] = await registry.listManagement();
  assert.equal(asset.assetKind, 'system');
  assert.equal(asset.protected, true);
  assert.equal(asset.discoverable, false);
  await assert.rejects(registry.removeMany(['acceptance-system']), { code: 'TASK_ASSET_PROTECTED' });
  await assert.rejects(registry.setLifecycleMany(['acceptance-system'], 'deprecated'), { code: 'TASK_ASSET_PROTECTED' });
  assert.equal((await registry.resolve('acceptance-system')).name, 'acceptance-system');
});

test('an explicitly discoverable protected system seed can be found by probe and scale terms', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-discoverable-system-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const allowed = path.join(root, 'allowed');
  await mkdir(allowed);
  const modulePath = await writeModule(allowed, 'surface-probe.mjs', [
    'export const meta = {',
    '  title: "Surface probe", intents: ["preflight", "scale"], tags: ["probe", "surface"]',
    '};',
    'export async function run() { return { summary: "ok", evidence: [{ kind: "message", value: "ok" }] }; }',
    ''
  ].join('\n'));
  const registry = new TaskTypeRegistry({
    filePath: path.join(root, 'types.json'),
    snapshotRoot: path.join(root, 'snapshots'),
    allowedRoots: [allowed],
    seedTypes: [{ name: 'surface-probe', modulePath, discoverable: true }]
  });

  const [summary] = await registry.listSummaries();
  assert.equal(summary.name, 'surface-probe');
  assert.deepEqual(summary.intents, ['preflight', 'scale']);
  const [asset] = await registry.listManagement();
  assert.equal(asset.protected, true);
  assert.equal(asset.discoverable, true);
  await assert.rejects(registry.removeMany(['surface-probe']), { code: 'TASK_ASSET_PROTECTED' });
});

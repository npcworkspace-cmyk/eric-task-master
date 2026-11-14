import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createManager } from '../src/manager.mjs';
import { ProfileStore } from '../src/lib/profile-store.mjs';
import { removeTestTree } from './test-fs.mjs';

const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
function runCli(args, stateDir, port) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args, '--state-dir', stateDir, '--port', String(port), '--json'], { windowsHide: true, env: { ...process.env, NODE_OPTIONS: '', USERPROFILE: path.join(stateDir, 'agent'), HOME: path.join(stateDir, 'agent') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject); child.on('close', (code) => { const source = code ? stderr : stdout; try { resolve({ code, result: JSON.parse(source.trim().split(/\r?\n/u).at(-1)) }); } catch { reject(new Error(source)); } });
  });
}
test('ops CLI uses protected Manager routes; Profile policy persists across restart', async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-ops-cli-'));
  const manager = await createManager({ dataDir: stateDir, port: 0 }); await manager.start();
  t.after(async () => { await manager.stop(); await removeTestTree(stateDir); });
  const profile = await manager.profileStore.create({ name: 'Isolated default' });
  const mode = await runCli(['profiles', 'mode', profile.id, '--mode', 'operations'], stateDir, manager.address.port);
  assert.equal(mode.code, 0); assert.equal(mode.result.profile.modePolicy, 'operations');
  const list = await runCli(['ops', 'list'], stateDir, manager.address.port); assert.equal(list.code, 0); assert.deepEqual(list.result.operations, []);
  const unsupported = await runCli(['ops', 'start', '--input', JSON.stringify({ goal: 'No browser fallback' })], stateDir, manager.address.port);
  assert.equal(unsupported.code, 1); assert.equal(unsupported.result.error.code, 'BROWSER_ADAPTER_UNAVAILABLE');
  const response = await fetch(`${manager.baseUrl}/v1/operations`); assert.equal(response.status, 401);
  await manager.operationsService.store.update((data) => {
    data.operations.push({ id: 'op_compact', taskId: null, goal: 'Compact CLI fixture', status: 'paused', mode: 'operations', manualLock: false,
      authorization: { version: 1, accountId: 'account', resourceIds: ['resource'] }, pending: null, pauseReason: { code: 'TEST_REVIEW' } });
    data.commands.push({ operationId: 'op_compact', commandId: 'current', status: 'confirmed', reply: { status: 'confirmed', result: 'compact' }, createdAt: new Date().toISOString() });
    data.actions.push({ operationId: 'op_compact', actionId: 'unresolved', status: 'unknown', expected: { text: 'pending evidence' } });
  });
  const compact = await runCli(['ops', 'get', 'op_compact', '--command', 'current'], stateDir, manager.address.port);
  assert.equal(compact.code, 0); assert.equal(compact.result.command.reply.result, 'compact'); assert.equal(compact.result.pauseReason.code, 'TEST_REVIEW'); assert.equal(compact.result.unresolvedActions[0].actionId, 'unresolved'); assert.equal(compact.result.actions, undefined);
  await manager.stop();
  const store = new ProfileStore({ filePath: path.join(stateDir, 'profiles.json'), profilesRoot: path.join(stateDir, 'profiles') }); await store.init();
  assert.equal((await store.get(profile.id)).modePolicy, 'operations');
});

test('ops schema is usable offline without creating or contacting a Manager', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-offline-schema-')); t.after(() => removeTestTree(root));
  const absentStateDir = path.join(root, 'must-remain-absent');
  const schema = await runCli(['ops', 'schema'], absentStateDir, 1);
  assert.equal(schema.code, 0); assert.deepEqual(schema.result.executionModes, ['batch', 'operations']); assert.equal(schema.result.selectionPolicy, 'auto');
  for (const name of ['start', 'observe', 'bootstrap', 'batch', 'ack', 'decision', 'reconcile', 'dialogAcknowledgement', 'hostAdapter', 'hostInput', 'hostReceipt']) assert.ok(schema.result.examples[name]);
  assert.ok(schema.result.commandKinds.includes('control'));
  const acknowledgement = schema.result.examples.dialogAcknowledgement;
  assert.equal(acknowledgement.kind, 'control'); assert.equal(acknowledgement.pageId, 'COPY_FRESH_PAGE_ID'); assert.equal(acknowledgement.pageVersion, 'COPY_FRESH_PAGE_VERSION');
  assert.equal(acknowledgement.payload.action, 'acknowledge-dialog'); assert.ok(acknowledgement.payload.reason.trim());
  assert.match(schema.result.examples.dialogAcknowledgementBoundary, /Unknown external effects still require actual same-resource reconciliation/u);
  await assert.rejects(access(absentStateDir), { code: 'ENOENT' });
});
test('legacy Profile records migrate to auto without touching browser contents', async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-mode-migration-')); t.after(() => removeTestTree(stateDir));
  const options = { filePath: path.join(stateDir, 'profiles.json'), profilesRoot: path.join(stateDir, 'profiles') };
  const original = new ProfileStore(options); await original.init(); const profile = await original.create({ name: 'Legacy' });
  const source = JSON.parse(await readFile(options.filePath, 'utf8')); delete source.profiles[0].modePolicy;
  await writeFile(options.filePath, JSON.stringify(source)); await writeFile(path.join(profile.userDataDir, 'Local State'), 'LOGIN_SENTINEL');
  const migrated = new ProfileStore(options); await migrated.init(); assert.equal((await migrated.get(profile.id)).modePolicy, 'auto');
  assert.equal(await readFile(path.join(profile.userDataDir, 'Local State'), 'utf8'), 'LOGIN_SENTINEL');
});

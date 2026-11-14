import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
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
  const effectiveStateDir = manager.stateLocation.stateDirEffective;
  assert.equal(JSON.parse(await readFile(path.join(effectiveStateDir, 'profiles.json'), 'utf8')).profiles.find((item) => item.id === profile.id).modePolicy, 'operations');
  await manager.stop();
  // Manager records canonical physical Profile paths. os.tmpdir() may be a
  // symlink/short-path alias; a raw standalone store has no Manager alias proof.
  const store = new ProfileStore({ filePath: path.join(effectiveStateDir, 'profiles.json'), profilesRoot: path.join(effectiveStateDir, 'profiles') }); await store.init();
  assert.equal((await store.get(profile.id)).modePolicy, 'operations');
});

test('Profile policy and identity survive actual Manager restart through a state-directory alias', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-ops-cli-alias-'));
  const physical = path.join(root, 'physical'); const logical = path.join(root, 'logical');
  await mkdir(physical); await symlink(physical, logical, process.platform === 'win32' ? 'junction' : 'dir');
  let manager;
  t.after(async () => { await manager?.stop(); await removeTestTree(root); });
  manager = await createManager({ dataDir: logical, port: 0 }); await manager.start();
  const effective = manager.stateLocation.stateDirEffective;
  assert.notEqual(effective, logical, 'This regression must exercise a real physical/logical path difference');
  const profile = await manager.profileStore.create({ name: 'Alias policy retained' });
  const changed = await runCli(['profiles', 'mode', profile.id, '--mode', 'operations'], logical, manager.address.port);
  assert.equal(changed.code, 0); assert.equal(changed.result.profile.modePolicy, 'operations');
  await writeFile(path.join(profile.userDataDir, 'Local State'), 'ALIAS_LOGIN_SENTINEL');
  const persisted = JSON.parse(await readFile(path.join(effective, 'profiles.json'), 'utf8')).profiles.find((item) => item.id === profile.id);
  assert.equal(persisted.modePolicy, 'operations'); assert.equal(persisted.userDataDir, path.join(effective, 'profiles', profile.id));
  await manager.stop();
  manager = await createManager({ dataDir: logical, port: 0 }); await manager.start();
  const retained = await manager.profileStore.get(profile.id);
  assert.equal(retained.modePolicy, 'operations'); assert.equal(retained.name, profile.name); assert.equal(retained.userDataDir, persisted.userDataDir);
  assert.equal(await readFile(path.join(retained.userDataDir, 'Local State'), 'utf8'), 'ALIAS_LOGIN_SENTINEL');
  const listed = await runCli(['profiles', 'list'], logical, manager.address.port);
  assert.equal(listed.code, 0); assert.equal(listed.result.profiles.find((item) => item.id === profile.id).modePolicy, 'operations');
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

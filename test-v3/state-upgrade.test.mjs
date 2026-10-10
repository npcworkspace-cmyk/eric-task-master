import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { removeTestTree } from './test-fs.mjs';
import { createManager } from '../src/manager.mjs';
import { managerStateId } from '../src/lib/manager-state.mjs';
import { projectStateEnvironment, readDefaultStateLocation, stateEnvironment } from '../src/lib/state-directory.mjs';
import { assertRetainedProfileView, consolidateLegacySharedState } from '../src/lib/state-upgrade.mjs';

const id = 'profile_' + 'a'.repeat(32);
const secret = { version: 3, managerToken: 'local-owner-test-token-'.repeat(3), stateInstanceId: 'retained-owner-instance-0001' };

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-state-upgrade-'));
  const managers = [];
  t.after(async () => { for (const manager of managers) await manager.stop(); await removeTestTree(root); });
  const environment = stateEnvironment({ platform: 'win32', home: path.join(root, 'home'),
    env: { LOCALAPPDATA: path.join(root, 'local') } });
  const selected = path.join(root, 'local', 'selected-physical');
  const source = environment.legacyRoot;
  await mkdir(selected, { recursive: true });
  await symlink(selected, source, 'junction');
  await writeFile(path.join(selected, 'config.json'), JSON.stringify(secret));
  await mkdir(path.join(selected, 'profiles', id, 'Default', 'Network'), { recursive: true });
  await writeFile(path.join(selected, 'profiles', id, 'Local State'), 'synthetic-local-state');
  await writeFile(path.join(selected, 'profiles', id, 'Default', 'Network', 'Cookies'), 'synthetic-login-canary');
  await writeFile(path.join(selected, 'profiles.json'), JSON.stringify({ version: 1, defaultProfileId: id,
    profiles: [{ id, name: 'Retained owner Profile', state: 'idle', lease: null,
      userDataDir: path.join(source, 'profiles', id) }], deletions: [] }));
  return { root, selected, source, environment, managers, config: { shared: true, environment,
    stateDir: selected, identityDir: source, port: 49147 } };
}

test('explicit Windows Owner upgrade materializes and verifies data without replacing identities or deleting its source', async (t) => {
  const item = await fixture(t);
  await consolidateLegacySharedState(item.config, { profileUsageProbe: async () => 'inactive' });
  assert.equal(item.config.stateDir, item.environment.sharedRoot);
  assert.equal(item.config.identityDir, item.source);
  const target = item.config.stateDir;
  const original = await readFile(path.join(item.selected, 'config.json'), 'utf8');
  assert.deepEqual(JSON.parse(original), secret);
  const copied = JSON.parse(await readFile(path.join(target, 'config.json'), 'utf8'));
  assert.equal(copied.managerToken, secret.managerToken);
  assert.equal(copied.stateInstanceId, secret.stateInstanceId);
  assert.equal(await readFile(path.join(target, 'profiles', id, 'Default', 'Network', 'Cookies'), 'utf8'), 'synthetic-login-canary');
  const location = await readDefaultStateLocation(item.environment);
  assert.equal(location.stateDir, target);
  const manager = await createManager({ dataDir: target, identityDir: item.source, scope: 'shared', port: 0 });
  item.managers.push(manager);
  await manager.start();
  assert.equal(manager.stateLocation.stateId, managerStateId(secret.stateInstanceId, item.source));
  const profile = (await manager.profileStore.list())[0];
  assert.deepEqual([profile.id, profile.name, (await manager.profileStore.getDefault()).id], [id, 'Retained owner Profile', id]);
  // Admission resolves macOS /var aliases and Windows inherited 8.3 paths.
  assert.equal(profile.userDataDir, path.join(await realpath(target), 'profiles', id));
});

test('isolated AppData project upgrades retain their requested key without changing the shared selection', async (t) => {
  const item = await fixture(t);
  item.config.shared = false;
  item.config.projectEnvironment = projectStateEnvironment(item.source, item.environment);
  item.config.port = 0;
  await consolidateLegacySharedState(item.config, { profileUsageProbe: async () => 'inactive' });
  const location = await readDefaultStateLocation(item.config.projectEnvironment);
  assert.equal(location.stateDir, item.config.stateDir);
  assert.equal(location.identityDir, item.source);
  assert.equal(await readDefaultStateLocation(item.environment), null);
  assert.notEqual(location.stateDir, item.environment.sharedRoot);
});

test('upgrade never overwrites an existing shared destination or copies occupied Profiles', async (t) => {
  const item = await fixture(t);
  await mkdir(item.environment.sharedRoot, { recursive: true });
  await writeFile(path.join(item.environment.sharedRoot, 'preserve'), 'unrelated-state');
  await assert.rejects(consolidateLegacySharedState(item.config), { code: 'MANAGER_STATE_UPGRADE_REQUIRED' });
  assert.equal(await readFile(path.join(item.environment.sharedRoot, 'preserve'), 'utf8'), 'unrelated-state');
  const other = await fixture(t);
  await assert.rejects(consolidateLegacySharedState(other.config, { profileUsageProbe: async () => 'active' }),
    { code: 'MANAGER_STATE_UPGRADE_REQUIRED' });
  assert.equal(await readDefaultStateLocation(other.environment), null);
});

test('identical copied credentials are not authority to copy another directory as the selected legacy view', async (t) => {
  const item = await fixture(t);
  const other = path.join(item.root, 'other-view');
  await mkdir(other);
  await writeFile(path.join(other, 'config.json'), JSON.stringify(secret));
  item.config.identityDir = other;
  await assert.rejects(consolidateLegacySharedState(item.config), { code: 'MANAGER_STATE_UPGRADE_REQUIRED' });
  assert.equal(await readDefaultStateLocation(item.environment), null);
});

test('normal state admission refuses rebasing a missing directory or a missing browser file into an empty Profile', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-incomplete-view-'));
  t.after(() => removeTestTree(root));
  const selected = path.join(root, 'selected');
  const alias = path.join(root, 'legacy-view');
  await mkdir(selected);
  await mkdir(path.join(alias, 'profiles', id), { recursive: true });
  await writeFile(path.join(alias, 'profiles', id, 'Local State'), 'retained-login-state');
  const metadata = { version: 1, profiles: [{ id, name: 'Legacy', userDataDir: path.join(alias, 'profiles', id) }] };
  await writeFile(path.join(selected, 'profiles.json'), JSON.stringify(metadata));
  await assert.rejects(assertRetainedProfileView(selected, [alias]), { code: 'MANAGER_STATE_UPGRADE_REQUIRED' });
  await mkdir(path.join(selected, 'profiles', id), { recursive: true });
  await assert.rejects(assertRetainedProfileView(selected, [alias]), { code: 'MANAGER_STATE_UPGRADE_REQUIRED' });
  await assert.rejects(createManager({ dataDir: selected, stateDirAliases: [alias], port: 0 }),
    { code: 'MANAGER_STATE_UPGRADE_REQUIRED' });
  assert.deepEqual(JSON.parse(await readFile(path.join(selected, 'profiles.json'), 'utf8')), metadata);
});

test('ordinary non-Windows or non-AppData state does not invoke the legacy copy path', async (t) => {
  const item = await fixture(t);
  item.config.environment = { ...item.environment, platform: 'linux' };
  await consolidateLegacySharedState(item.config, { profileUsageProbe: () => { throw new Error('unexpected scan'); } });
  assert.equal(item.config.stateDir, item.selected);
  assert.equal(await readDefaultStateLocation(item.environment), null);
});

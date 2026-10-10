import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { removeTestTree } from './test-fs.mjs';
import { managerStateId } from '../src/lib/manager-state.mjs';
import { createManager } from '../src/manager.mjs';
import {
  stateEnvironment, inspectStateDirectory, chooseDefaultState,
  readDefaultStateLocation, rememberDefaultStateLocation, readStateEndpoint, writeStateEndpoint
} from '../src/lib/state-directory.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-state-location-'));
  t.after(() => removeTestTree(root));
  const environment = stateEnvironment({
    platform: 'win32', home: root,
    env: { LOCALAPPDATA: path.join(root, 'Local AppData') }
  });
  return { root, environment };
}

async function state(root, seed) {
  await mkdir(root, { recursive: true });
  const config = { managerToken: seed.repeat(48), stateInstanceId: 'state-instance-' + seed.repeat(24) };
  await writeFile(path.join(root, 'config.json'), JSON.stringify(config));
  return config;
}

test('new Windows shared data and its locator are outside virtualized AppData', () => {
  const home = path.resolve(os.tmpdir(), 'fixture-user');
  const environment = stateEnvironment({ platform: 'win32', home, env: { LOCALAPPDATA: path.join(home, 'AppData', 'Local') } });
  assert.equal(environment.sharedRoot, path.join(home, '.eric-task-master', 'state'));
  assert.equal(environment.locatorFile, path.join(home, '.eric-task-master', 'default-state.json'));
  assert.equal(environment.legacyRoot, path.join(home, 'AppData', 'Local', 'eric-task-master'));
});

test('Manager rejects data beneath a replaceable application or its directory alias before creating it', async (t) => {
  const { root } = await fixture(t);
  const application = path.join(root, 'native application');
  await mkdir(path.join(application, 'app'), { recursive: true });
  await writeFile(path.join(application, 'app/package.json'), JSON.stringify({ name: 'eric-task-master' }));
  const alias = path.join(root, 'application alias');
  await symlink(application, alias, process.platform === 'win32' ? 'junction' : 'dir');
  for (const dataDir of [path.join(application, 'saved data'), path.join(alias, 'saved data')]) {
    await assert.rejects(createManager({ port: 0, dataDir }), { code: 'MANAGER_STATE_IN_APPLICATION' });
    await assert.rejects(access(dataDir), { code: 'ENOENT' });
  }
});

test('state location resolves the configuration file, not just the directory name', async (t) => {
  const { root } = await fixture(t);
  const logical = path.join(root, 'logical');
  const physical = path.join(root, 'physical');
  await state(logical, 'a');
  await state(physical, 'a');
  const inspected = await inspectStateDirectory(logical, {
    resolveFile: async (file) => file === path.join(logical, 'config.json')
      ? path.join(physical, 'config.json') : realpath(file),
    inspectDirectory: async () => stat(physical)
  });
  assert.equal(inspected.stateDir, physical);
  assert.equal(inspected.identityDir, logical);
  assert.notEqual(inspected.stateId, inspected.stateDirectoryId);
});

test('a configuration-only redirect cannot move Profiles into another state project', async (t) => {
  const { root } = await fixture(t);
  const logical = path.join(root, 'logical-config-only');
  const physical = path.join(root, 'separate-project');
  await state(logical, 'a');
  await state(physical, 'a');
  await assert.rejects(inspectStateDirectory(logical, {
    resolveFile: async () => path.join(physical, 'config.json')
  }), { code: 'MANAGER_LOCATION_INVALID' });
});

test('endpoint publication is atomic during repeated concurrent reads', async (t) => {
  const { root } = await fixture(t);
  await writeStateEndpoint(root, { pid: process.pid, baseUrl: 'http://127.0.0.1:23456' });
  await Promise.all([
    (async () => { for (let index = 0; index < 30; index += 1) await writeStateEndpoint(root,
      { pid: process.pid, baseUrl: 'http://127.0.0.1:' + (23456 + index % 2) }); })(),
    (async () => { for (let index = 0; index < 90; index += 1) assert.ok((await readStateEndpoint(root)).port > 0); })()
  ]);
});

test('directory aliases share physical identity but copied state remains isolated', async (t) => {
  const { root } = await fixture(t);
  const target = path.join(root, 'state');
  const alias = path.join(root, 'alias');
  const copied = path.join(root, 'copy');
  await state(target, 'b');
  await state(copied, 'b');
  await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const [original, alternate, copy] = await Promise.all([target, alias, copied].map((dir) => inspectStateDirectory(dir)));
  assert.equal(original.stateDirectoryId, alternate.stateDirectoryId);
  assert.notEqual(original.stateDirectoryId, copy.stateDirectoryId);
});

test('default discovery reuses a legacy packaged Manager without a host-specific PFN', async (t) => {
  const { environment } = await fixture(t);
  await state(environment.legacyRoot, 'c');
  const packageState = path.join(environment.packageRoot, 'Any.Agent_abc123', 'LocalCache', 'Local', 'eric-task-master');
  const packaged = await state(packageState, 'd');
  const chosen = await chooseDefaultState({
    environment,
    manager: { stateId: managerStateId(packaged.stateInstanceId, environment.legacyRoot) }
  });
  assert.equal(chosen.stateDir, await realpath(packageState));
  assert.equal(chosen.identityDir, environment.legacyRoot);
  assert.equal(JSON.stringify(chosen).includes(packaged.managerToken), false);
});

test('cold ambiguous legacy stores never silently select one or create blank data', async (t) => {
  const { environment } = await fixture(t);
  await state(environment.legacyRoot, 'e');
  await state(path.join(environment.packageRoot, 'Other.Agent_xyz', 'LocalCache', 'Local', 'eric-task-master'), 'f');
  await assert.rejects(chooseDefaultState({ environment }), { code: 'MANAGER_STATE_AMBIGUOUS' });
  await assert.rejects(readFile(path.join(environment.sharedRoot, 'config.json')), { code: 'ENOENT' });
});

test('default locator preserves the selected data project across restarts and contains no credentials', async (t) => {
  const { root, environment } = await fixture(t);
  const selected = path.join(root, 'selected project');
  const config = await state(selected, 'g');
  await state(environment.legacyRoot, 'h');
  await Promise.all(Array.from({ length: 8 }, () => rememberDefaultStateLocation({
    stateDir: selected, identityDir: selected, port: 19946
  }, environment)));
  const location = await readDefaultStateLocation(environment);
  const chosen = await chooseDefaultState({ environment });
  assert.equal(location.stateDir, selected);
  assert.equal(chosen.stateDir, await realpath(selected));
  const raw = await readFile(environment.locatorFile, 'utf8');
  assert.equal(raw.includes(config.managerToken), false);
  assert.equal(raw.includes(config.stateInstanceId), false);
  assert.equal(chosen.pinned, true);
});

test('damaged default locator fails closed instead of replacing or ignoring it', async (t) => {
  const { environment } = await fixture(t);
  await mkdir(path.dirname(environment.locatorFile), { recursive: true });
  await writeFile(environment.locatorFile, '{broken');
  await assert.rejects(chooseDefaultState({ environment }), { code: 'MANAGER_LOCATION_INVALID' });
  assert.equal(await readFile(environment.locatorFile, 'utf8'), '{broken');
});

test('a project Manager cannot become the shared default through public health', async (t) => {
  const { root, environment } = await fixture(t);
  const project = path.join(root, 'project');
  const config = await state(project, 'i');
  await assert.rejects(chooseDefaultState({
    environment, manager: {
      scope: 'project', stateDirEffective: project,
      stateDirectoryId: managerStateId(config.stateInstanceId, project)
    }
  }), { code: 'MANAGER_STATE_MISMATCH' });
});

test('project endpoint discovery accepts only a loopback address and never creates state', async (t) => {
  const { root } = await fixture(t);
  const project = path.join(root, 'project');
  assert.equal(await readStateEndpoint(project), null);
  await mkdir(project);
  await writeFile(path.join(project, 'manager.json'), JSON.stringify({ pid: process.pid, baseUrl: 'http://127.0.0.1:23456' }));
  assert.equal((await readStateEndpoint(project)).port, 23456);
  await writeFile(path.join(project, 'manager.json'), JSON.stringify({ pid: process.pid, baseUrl: 'http://evil.example:23456' }));
  await assert.rejects(readStateEndpoint(project), { code: 'MANAGER_LOCATION_INVALID' });
});

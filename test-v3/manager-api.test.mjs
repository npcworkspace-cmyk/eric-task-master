import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { removeTestTree } from './test-fs.mjs';
import { createManager } from '../src/manager.mjs';
import { managerRecoveryProof } from '../src/lib/manager-state.mjs';
import { TaskServiceError } from '../src/runtime/task-service.mjs';

async function json(url, { token, method = 'GET', body } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return { status: response.status, body: await response.json() };
}

test('Manager exposes the minimal v3 loopback API and passes through errors', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-manager-'));
  const task = { id: 'task_1', title: 'demo', state: 'waiting', canResume: true };
  const profile = { id: 'profile_1', name: 'Default', state: 'idle', isDefault: true };
  const resumes = [];
  const service = {
    status: async () => ({ state: 'ready', tasks: { total: 1, running: 1, queued: 0 }, profiles: 1 }),
    list: async () => [task],
    get: async () => task,
    events: async () => ({ task, events: [], truncated: false, nextAfter: 0 }),
    create: async () => task,
    stop: async () => ({ ...task, state: 'stopped' }),
    resume: async (...args) => {
      resumes.push(args);
      return { ...task, state: 'running' };
    },
    deleteTask: async (id) => ({ deleted: true, id }),
    listArtifacts: async () => ({
      artifacts: [], offset: 0, count: 0, truncated: false, nextOffset: null
    }),
    readArtifact: async () => ({ path: 'x', encoding: 'base64', data: '', eof: true }),
    listProfiles: async () => [profile],
    createProfile: async () => profile,
    updateProfile: async () => profile,
    openProfile: async () => ({ status: 'open', profileId: profile.id }),
    closeProfile: async () => ({ status: 'closed', profileId: profile.id }),
    deleteProfile: async () => ({ deleted: true, profile }),
    close: async () => {}
  };
  const manager = await createManager({
    port: 0,
    dataDir: root,
    taskServiceFactory: async () => service,
    profileProcessAlive: () => false
  });
  t.after(async () => {
    await manager.stop();
    await removeTestTree(root);
  });
  await manager.start();
  const base = manager.baseUrl;
  const token = JSON.parse(await readFile(path.join(root, 'config.json'), 'utf8')).managerToken;

  const health = await json(`${base}/v1/health`);
  assert.equal(health.status, 200);
  assert.match(health.body.stateId, /^state_[0-9A-Za-z_-]{24}$/u);
  assert.equal((await json(`${base}/v1/tasks`)).status, 401);
  assert.deepEqual((await json(`${base}/v1/tasks`, { token })).body.tasks, [task]);
  assert.equal((await json(`${base}/v1/tasks`, { token, method: 'POST', body: { modulePath: 'job.mjs' } })).status, 201);
  assert.equal((await json(`${base}/v1/tasks/task_1/events`, { token })).status, 200);
  assert.deepEqual((await json(`${base}/v1/tasks/task_1/artifacts?offset=0&limit=5`, { token })).body, {
    ok: true, artifacts: [], offset: 0, count: 0, truncated: false, nextOffset: null
  });
  assert.equal((await json(`${base}/v1/tasks/task_1/actions`, { token, method: 'POST', body: { action: 'resume' } })).body.task.state, 'running');
  assert.deepEqual(resumes.at(-1), ['task_1', null, {}]);
  assert.equal((await json(`${base}/v1/tasks/task_1/actions`, {
    token, method: 'POST',
    body: { action: 'resume', value: { ready: true }, waitId: 'wait_1', probeId: 'probe_1' }
  })).status, 200);
  assert.deepEqual(resumes.at(-1), [
    'task_1', { ready: true }, { waitId: 'wait_1', probeId: 'probe_1' }
  ]);
  assert.equal((await json(`${base}/v1/tasks/task_1`, { token, method: 'DELETE' })).body.deleted, true);
  assert.deepEqual((await json(`${base}/v1/profiles`, { token })).body.profiles, [profile]);
  assert.equal((await json(`${base}/v1/profiles`, { token, method: 'POST', body: { name: 'Default' } })).status, 201);
  assert.equal((await json(`${base}/v1/profiles/profile_1`, { token, method: 'PATCH', body: { isDefault: true } })).status, 200);
  assert.equal((await json(`${base}/v1/profiles/profile_1/actions`, { token, method: 'POST', body: { action: 'open' } })).body.status, 'open');
  assert.equal((await json(`${base}/v1/profiles/profile_1`, { token, method: 'DELETE' })).body.deleted, true);

  const badAction = await json(`${base}/v1/tasks/task_1/actions`, {
    token, method: 'POST', body: { action: 'invented' }
  });
  assert.equal(badAction.status, 400);
  assert.equal(badAction.body.error.code, 'INVALID_TASK_ACTION');
});

test('Manager hot-reloads token rotation and requires a scoped proof for state recovery', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-manager-state-change-'));
  let listCalls = 0;
  let idleChecks = 0;
  let containmentCalls = 0;
  let busy = true;
  const closeOptions = [];
  const service = {
    list: async () => {
      listCalls += 1;
      return [];
    },
    prepareIdleStop: async () => {
      idleChecks += 1;
      if (busy) throw new TaskServiceError('MANAGER_BUSY', 'Manager still has active work', 409);
    },
    containForStateRecovery: async () => {
      containmentCalls += 1;
      return { tasks: 1, profiles: 1 };
    },
    close: async (options) => { closeOptions.push(options); }
  };
  const manager = await createManager({
    port: 0,
    dataDir: root,
    taskServiceFactory: async () => service,
    profileProcessAlive: () => false
  });
  t.after(async () => {
    await manager.stop().catch(() => {});
    await removeTestTree(root);
  });
  await manager.start();
  const base = manager.baseUrl;
  const configPath = path.join(root, 'config.json');
  const original = JSON.parse(await readFile(configPath, 'utf8'));
  const rotatedToken = 't'.repeat(48);
  await writeFile(configPath, `${JSON.stringify({ ...original, managerToken: rotatedToken }, null, 2)}\n`);
  const afterRotation = await json(`${base}/v1/health`);
  assert.equal(afterRotation.body.stateChanged, false);
  assert.equal((await json(`${base}/v1/tasks`, { token: rotatedToken })).status, 200);
  assert.equal((await json(`${base}/v1/tasks`, { token: original.managerToken })).status, 401);
  assert.equal(listCalls, 1);

  const replacementToken = 'r'.repeat(48);
  await writeFile(configPath, `${JSON.stringify({
    ...original,
    managerToken: replacementToken,
    stateInstanceId: 'replacement-state-instance-0001'
  }, null, 2)}\n`);
  const changedHealth = await json(`${base}/v1/health`);
  assert.equal(changedHealth.body.stateChanged, true);
  assert.match(changedHealth.body.recoveryNonce, /^[0-9A-Za-z_-]{32}$/u);

  const blocked = await json(`${base}/v1/tasks`, { token: replacementToken });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, 'MANAGER_STATE_CHANGED');
  assert.match(blocked.body.nextAction, /manager recover/u);
  assert.equal(listCalls, 1, 'stale service must not execute requests after state replacement');

  const invalidProof = await json(`${base}/v1/manager/recover`, {
    method: 'POST',
    body: { force: false, proof: 'not-valid' }
  });
  assert.equal(invalidProof.status, 401);
  assert.equal(invalidProof.body.error.code, 'RECOVERY_PROOF_REQUIRED');

  const refused = await json(`${base}/v1/manager/recover`, {
    method: 'POST',
    body: {
      force: false,
      proof: managerRecoveryProof(
        replacementToken,
        changedHealth.body.stateId,
        changedHealth.body.recoveryNonce
      )
    }
  });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'MANAGER_BUSY');
  assert.equal(manager.stopped, false);
  assert.deepEqual(closeOptions, []);

  const recovery = await json(`${base}/v1/manager/recover`, {
    method: 'POST',
    body: {
      force: true,
      proof: managerRecoveryProof(
        replacementToken,
        changedHealth.body.stateId,
        changedHealth.body.recoveryNonce,
        { force: true }
      )
    }
  });
  assert.equal(recovery.status, 202);
  assert.deepEqual(recovery.body.contained, { tasks: 1, profiles: 1 });
  const deadline = Date.now() + 2_000;
  while (!manager.stopped && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(manager.stopped, true);
  assert.equal(idleChecks, 1);
  assert.equal(containmentCalls, 1);
  assert.deepEqual(closeOptions, [{ abandonState: true }]);
});

test('Manager tolerates a partial token rewrite and recovers a legacy configuration', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-legacy-recovery-'));
  const manager = await createManager({ port: 0, dataDir: root });
  t.after(async () => { await manager.stop({ abandonState: true }); await removeTestTree(root); });
  await manager.start();
  const base = manager.baseUrl;
  const configPath = path.join(root, 'config.json');
  const original = JSON.parse(await readFile(configPath, 'utf8'));
  const rotated = { ...original, managerToken: 'rotated-token-'.repeat(4) };
  await writeFile(configPath, '{');
  const rewrite = new Promise((resolve, reject) => setTimeout(() => {
    writeFile(configPath, JSON.stringify(rotated)).then(resolve, reject);
  }, 40));
  const stable = await json(`${base}/v1/health`);
  await rewrite;
  assert.equal(stable.body.stateChanged, false);
  assert.equal((await json(`${base}/v1/status`, { token: rotated.managerToken })).status, 200);
  const unnecessaryRecovery = await json(`${base}/v1/manager/recover`, {
    method: 'POST', body: { proof: 'expired-observation' }
  });
  assert.equal(unnecessaryRecovery.body.error.code, 'MANAGER_STATE_CURRENT');

  const legacy = { version: 3, managerToken: 'legacy-token-'.repeat(4) };
  await writeFile(configPath, JSON.stringify(legacy));
  const changed = await json(`${base}/v1/health`);
  assert.equal(changed.body.stateChanged, true);
  const recovered = await json(`${base}/v1/manager/recover`, {
    method: 'POST', body: {
      proof: managerRecoveryProof(legacy.managerToken, changed.body.stateId, changed.body.recoveryNonce)
    }
  });
  assert.equal(recovered.status, 202);
  const deadline = Date.now() + 2_000;
  while (!manager.stopped && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(manager.stopped, true);
  assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), legacy, 'old process must not rewrite the restored config');
});

test('space cleanup is authenticated, defaults to preview, and accepts only fixed categories', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-manager-cleanup-'));
  const manager = await createManager({
    port: 0, dataDir: root, taskServiceOptions: { profileUsageProbe: async () => 'inactive' }
  });
  t.after(async () => { await manager.stop(); await removeTestTree(root); });
  await manager.start();
  const base = manager.baseUrl;
  const token = JSON.parse(await readFile(path.join(root, 'config.json'), 'utf8')).managerToken;
  const profile = await manager.profileStore.create({ name: 'Cleanup fixture' });
  const cache = path.join(profile.userDataDir, 'Default', 'Cache');
  await mkdir(cache, { recursive: true });
  await writeFile(path.join(cache, 'rebuildable'), 'cache');
  await writeFile(path.join(profile.userDataDir, 'Default', 'Cookies'), 'synthetic-login-canary');

  assert.equal((await json(`${base}/v1/cleanup`, { method: 'POST', body: { preview: false } })).status, 401);
  const before = await json(`${base}/v1/cleanup`, { token, method: 'POST', body: {} });
  assert.equal(before.status, 200);
  assert.equal(before.body.preview, true);
  assert.equal(before.body.bytes, 5);
  assert.equal(await readFile(path.join(cache, 'rebuildable'), 'utf8'), 'cache');
  for (const body of [{ path: root }, { categories: ['cookies'], preview: false }, { preview: 'false' }, null]) {
    const invalid = await json(`${base}/v1/cleanup`, { token, method: 'POST', body });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error.code, body === null ? 'INVALID_JSON_BODY' : 'INVALID_CLEANUP_OPTIONS');
  }
  const response = await fetch(`${base}/v1/cleanup`, {
    method: 'POST', headers: { origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ categories: ['browser-cache'], preview: false })
  });
  const after = await response.json();
  assert.equal(response.status, 200);
  assert.equal(after.preview, false);
  assert.equal(after.bytes, 5);
  assert.equal(after.files, 1);
  assert.equal(await readFile(path.join(profile.userDataDir, 'Default', 'Cookies'), 'utf8'), 'synthetic-login-canary');
  assert.equal(JSON.parse(await readFile(path.join(root, 'config.json'), 'utf8')).managerToken, token);
  const journal = (await readFile(path.join(root, 'logs', 'manager-events.jsonl'), 'utf8'))
    .trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(journal.find((event) => event.event === 'space.cleaned').message, 'files=1 bytes=5 skipped=0 failed=0');
});

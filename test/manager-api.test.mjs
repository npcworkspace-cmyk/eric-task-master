import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHmac } from 'node:crypto';
import { createManager } from '../src/manager.mjs';
import { VERSION } from '../src/contracts.mjs';


async function json(response) {
  const body = await response.json();
  return { response, body };
}

function headers(token, origin) {
  return {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    ...(origin ? { origin } : {})
  };
}

async function managerFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'eric-task-master-manager-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dashboardDir = join(root, 'dashboard');
  await mkdir(dashboardDir);
  await writeFile(join(dashboardDir, 'index.html'), '<!doctype html><title>Task Master</title>');

  const tasks = new Map();
  const calls = { open: [], close: [], resumes: [] };
  let taskService;
  const buildTaskService = ({ profileStore }) => taskService = {
    async list() {
      return [...tasks.values()];
    },
    async create(input) {
      const task = {
        id: `task_${tasks.size + 1}`,
        state: 'queued',
        modulePath: 'C:/secret/task.mjs',
        input
      };
      tasks.set(task.id, task);
      return task;
    },
    async get(id) {
      const task = tasks.get(id);
      if (!task) throw Object.assign(new Error('Task not found'), { statusCode: 404, code: 'TASK_NOT_FOUND' });
      return task;
    },
    async cancel(id) {
      const task = await this.get(id);
      task.state = 'cancelled';
      return task;
    },
    async resume(id, body, caller) {
      const task = await this.get(id);
      calls.resumes.push({ id, body, caller });
      task.state = 'queued';
      task.attempt = 2;
      return task;
    },
    async openProfile(id) {
      calls.open.push(id);
      await profileStore.acquireLease(id, `profile-open:${id}`, {
        pid: process.pid,
        ttlMs: 60_000
      });
      return { pid: process.pid };
    },
    async closeProfile(id) {
      calls.close.push(id);
      const profile = await profileStore.get(id);
      if (profile.lease?.ownerId === `profile-open:${id}`) {
        await profileStore.releaseLease(id, `profile-open:${id}`);
      }
    },
    async close() {
      for (const profile of await profileStore.list()) {
        if (profile.lease?.ownerId === `profile-open:${profile.id}`) {
          await profileStore.releaseLease(profile.id, profile.lease.ownerId);
        }
      }
    }
  };
  const manager = await createManager({
    port: 0,
    dataDir: join(root, 'data'),
    dashboardDir,
    taskServiceFactory: buildTaskService
  });
  await manager.start();
  t.after(() => manager.stop());
  return { root, manager, taskService, calls, baseUrl: manager.baseUrl };
}

async function issueAgent(baseUrl, managerToken, clientId) {
  const result = await json(await fetch(`${baseUrl}/v1/agents/issue`, {
    method: 'POST',
    headers: headers(managerToken),
    body: JSON.stringify({ clientId, name: clientId })
  }));
  assert.equal(result.response.status, 201);
  return result.body.agentToken;
}

test('manager serves loopback health/dashboard and persists its token', async (t) => {
  const { manager, baseUrl } = await managerFixture(t);
  const health = await json(await fetch(`${baseUrl}/v1/health`));
  assert.equal(health.response.status, 200);
  assert.equal(health.body.ok, true);
  assert.equal(health.body.version, VERSION);
  assert.equal(health.body.host, '127.0.0.1');

  const dashboard = await fetch(`${baseUrl}/dashboard`);
  assert.equal(dashboard.status, 200);
  assert.match(await dashboard.text(), /Task Master/);
  assert.equal(manager.dashboardUrl, `${baseUrl}/dashboard`);
  assert.equal(manager.dashboardUrl.includes(manager.token), false);

  const storedConfig = JSON.parse(await readFile(join(manager.dataDir, 'config.json'), 'utf8'));
  assert.equal(storedConfig.managerToken, manager.token);
  assert.equal(storedConfig.managerIdentity.algorithm, 'Ed25519');
  assert.equal(health.body.identityFingerprint, storedConfig.managerIdentity.fingerprint);
  assert.equal(JSON.stringify(health.body).includes(storedConfig.managerIdentity.privateKey), false);
  await assert.rejects(
    createManager({ host: '0.0.0.0', dataDir: join(manager.dataDir, 'invalid') }),
    /must bind to 127\.0\.0\.1/
  );
});

test('same-host MCP processes share one stable scoped credential without registry growth', async (t) => {
  const { manager, baseUrl } = await managerFixture(t);
  const clientId = 'codex.shared-host';
  const tokens = await Promise.all(
    Array.from({ length: 24 }, () => issueAgent(baseUrl, manager.token, clientId))
  );
  assert.equal(new Set(tokens).size, 1);
  const reads = await Promise.all(tokens.map((agentToken) => fetch(`${baseUrl}/v1/profiles`, {
    headers: headers(agentToken)
  })));
  assert.equal(reads.every((response) => response.status === 200), true);

  // Exercise substantial credential churn without turning this unit test into
  // a TCP backlog stress test for the single in-process HTTP server.
  for (let offset = 0; offset < 280; offset += 40) {
    await Promise.all(Array.from({ length: Math.min(40, 280 - offset) }, (_, index) => (
      issueAgent(baseUrl, manager.token, `historical-client-${offset + index}`)
    )));
  }
  const source = await readFile(join(manager.dataDir, 'config.json'));
  const config = JSON.parse(source.toString('utf8'));
  assert.equal(source.byteLength < 64 * 1024, true);
  assert.deepEqual(config.agents, []);
  assert.equal(config.agentCredentialVersion, 1);
});

test('Agent credentials cannot occupy an internal principal namespace', async (t) => {
  const { manager, baseUrl } = await managerFixture(t);
  for (const clientId of [
    'manager-admin',
    'dashboard',
    'extension',
    'dashboard:forged',
    'extension:forged',
    'internal:forged',
    'profile-open:forged',
    'session-import:forged',
    'task:forged',
    'taskmaster:forged'
  ]) {
    const rejected = await json(await fetch(`${baseUrl}/v1/agents/issue`, {
      method: 'POST',
      headers: headers(manager.token),
      body: JSON.stringify({ clientId, name: clientId })
    }));
    assert.equal(rejected.response.status, 400, clientId);
    assert.equal(rejected.body.error.code, 'RESERVED_CLIENT_ID', clientId);
  }

  const clientId = 'manager-admin';
  const encoded = Buffer.from(clientId, 'utf8').toString('base64url');
  const signature = createHmac('sha256', manager.token)
    .update(`ETMA1\0${clientId}`, 'utf8')
    .digest('base64url');
  const forgedLegacyToken = `ETMA1.${encoded}.${signature}`;
  const rejectedLegacy = await json(await fetch(`${baseUrl}/v1/profiles`, {
    headers: headers(forgedLegacyToken)
  }));
  assert.equal(rejectedLegacy.response.status, 401);
  assert.equal(rejectedLegacy.body.error.code, 'INVALID_TOKEN');
});

test('manager requires auth and removed extension routes stay unavailable', async (t) => {
  const { baseUrl } = await managerFixture(t);
  const unauthorized = await json(await fetch(`${baseUrl}/v1/profiles`));
  assert.equal(unauthorized.response.status, 401);
  assert.equal(unauthorized.body.error.code, 'AUTH_REQUIRED');

  for (const [method, pathname] of [
    ['POST', '/v1/pair/authorize'],
    ['GET', '/v1/pair/challenge'],
    ['POST', '/v1/pair/extension']
  ]) {
    const removed = await json(await fetch(`${baseUrl}${pathname}`, {
      method,
      headers: method === 'POST' ? { 'content-type': 'application/json' } : {},
      ...(method === 'POST' ? { body: '{}' } : {})
    }));
    assert.equal(removed.response.status, 404, pathname);
    assert.equal(removed.body.error.code, 'NOT_FOUND', pathname);
  }
});

test('profile CRUD, behavior policy, open and close are exposed without leaking paths', async (t) => {
  const { manager, baseUrl, calls } = await managerFixture(t);
  const createResult = await json(await fetch(`${baseUrl}/v1/profiles`, {
    method: 'POST',
    headers: headers(manager.token),
    body: JSON.stringify({ name: 'Daily work', kind: 'ephemeral', defaultBehavior: 'fast' })
  }));
  assert.equal(createResult.response.status, 201);
  assert.equal(createResult.body.profile.userDataDir, undefined);
  assert.equal(createResult.body.profile.lease, undefined);
  const profileId = createResult.body.profile.id;

  const patchResult = await json(await fetch(`${baseUrl}/v1/profiles/${profileId}`, {
    method: 'PATCH',
    headers: headers(manager.token),
    body: JSON.stringify({ defaultBehavior: 'adaptive' })
  }));
  assert.equal(patchResult.response.status, 200);
  assert.equal(patchResult.body.profile.defaultBehavior, 'adaptive');

  const persistentResult = await json(await fetch(`${baseUrl}/v1/profiles`, {
    method: 'POST',
    headers: headers(manager.token),
    body: JSON.stringify({ name: 'Signed-in Chrome' })
  }));
  assert.equal(persistentResult.response.status, 201);
  assert.equal(persistentResult.body.profile.browserEngine, 'chrome');
  assert.equal(persistentResult.body.profile.defaultBehavior, 'human');
  const fixedBehavior = await json(await fetch(
    `${baseUrl}/v1/profiles/${persistentResult.body.profile.id}`,
    {
      method: 'PATCH',
      headers: headers(manager.token),
      body: JSON.stringify({ defaultBehavior: 'human' })
    }
  ));
  assert.equal(fixedBehavior.response.status, 400);
  assert.equal(fixedBehavior.body.error.code, 'PERSISTENT_BEHAVIOR_FIXED');

  const invalidPatch = await json(await fetch(`${baseUrl}/v1/profiles/${profileId}`, {
    method: 'PATCH',
    headers: headers(manager.token),
    body: JSON.stringify({ state: 'open' })
  }));
  assert.equal(invalidPatch.response.status, 400);

  const opened = await json(await fetch(`${baseUrl}/v1/profiles/${profileId}/open`, {
    method: 'POST',
    headers: headers(manager.token),
    body: '{}'
  }));
  assert.equal(opened.response.status, 200);
  assert.equal(opened.body.profile.state, 'open');
  assert.equal(opened.body.profile.lease, undefined);
  assert.deepEqual(calls.open, [profileId]);

  const cannotDelete = await json(await fetch(`${baseUrl}/v1/profiles/${profileId}`, {
    method: 'DELETE',
    headers: headers(manager.token)
  }));
  assert.equal(cannotDelete.response.status, 409);

  const closed = await json(await fetch(`${baseUrl}/v1/profiles/${profileId}/close`, {
    method: 'POST',
    headers: headers(manager.token),
    body: '{}'
  }));
  assert.equal(closed.response.status, 200);
  assert.equal(closed.body.profile.state, 'idle');
  assert.deepEqual(calls.close, [profileId]);

  const removed = await json(await fetch(`${baseUrl}/v1/profiles/${profileId}`, {
    method: 'DELETE',
    headers: headers(manager.token)
  }));
  assert.equal(removed.response.status, 200);
  assert.equal(removed.body.removed.id, profileId);
});

test('Agent-created Profiles are private until their owner explicitly shares them', async (t) => {
  const { manager, baseUrl } = await managerFixture(t);
  const tokenA = await issueAgent(baseUrl, manager.token, 'agent-profile-a');
  const tokenB = await issueAgent(baseUrl, manager.token, 'agent-profile-b');

  const created = await json(await fetch(`${baseUrl}/v1/profiles`, {
    method: 'POST',
    headers: headers(tokenA),
    body: JSON.stringify({ name: 'Agent A private', kind: 'persistent' })
  }));
  assert.equal(created.response.status, 201);
  assert.equal(created.body.profile.access, 'private');
  assert.equal(created.body.profile.createdBy, 'agent-profile-a');
  const profileId = created.body.profile.id;

  const hidden = await json(await fetch(`${baseUrl}/v1/profiles`, { headers: headers(tokenB) }));
  assert.equal(hidden.response.status, 200);
  assert.equal(hidden.body.profiles.some((profile) => profile.id === profileId), false);

  for (const [method, suffix, body] of [
    ['PATCH', '', { name: 'stolen' }],
    ['POST', '/open', undefined]
  ]) {
    const denied = await json(await fetch(`${baseUrl}/v1/profiles/${profileId}${suffix}`, {
      method,
      headers: headers(tokenB),
      ...(body ? { body: JSON.stringify(body) } : {})
    }));
    assert.equal(denied.response.status, 403);
    assert.equal(denied.body.error.code, 'PROFILE_ACCESS_DENIED');
  }

  const shared = await json(await fetch(`${baseUrl}/v1/profiles/${profileId}`, {
    method: 'PATCH',
    headers: headers(tokenA),
    body: JSON.stringify({ access: 'shared' })
  }));
  assert.equal(shared.response.status, 200);
  assert.equal(shared.body.profile.access, 'shared');
  const visible = await json(await fetch(`${baseUrl}/v1/profiles`, { headers: headers(tokenB) }));
  assert.equal(visible.body.profiles.some((profile) => profile.id === profileId), true);

  const stillCannotManage = await json(await fetch(`${baseUrl}/v1/profiles/${profileId}`, {
    method: 'PATCH',
    headers: headers(tokenB),
    body: JSON.stringify({ defaultBehavior: 'human' })
  }));
  assert.equal(stillCannotManage.response.status, 403);
  assert.equal(stillCannotManage.body.error.code, 'PROFILE_ACCESS_DENIED');

  const openedByB = await json(await fetch(`${baseUrl}/v1/profiles/${profileId}/open`, {
    method: 'POST', headers: headers(tokenB), body: '{}'
  }));
  assert.equal(openedByB.response.status, 200);
  const revokeWhileOpen = await json(await fetch(`${baseUrl}/v1/profiles/${profileId}`, {
    method: 'PATCH',
    headers: headers(tokenA),
    body: JSON.stringify({ access: 'private' })
  }));
  assert.equal(revokeWhileOpen.response.status, 409);
  assert.equal(revokeWhileOpen.body.error.code, 'PROFILE_IN_USE');
  const closedByB = await json(await fetch(`${baseUrl}/v1/profiles/${profileId}/close`, {
    method: 'POST', headers: headers(tokenB), body: '{}'
  }));
  assert.equal(closedByB.response.status, 200);
  const privateAgain = await json(await fetch(`${baseUrl}/v1/profiles/${profileId}`, {
    method: 'PATCH',
    headers: headers(tokenA),
    body: JSON.stringify({ access: 'private' })
  }));
  assert.equal(privateAgain.response.status, 200);
  assert.equal(privateAgain.body.profile.access, 'private');
});

test('task routes delegate to taskService and strip private task fields', async (t) => {
  const { manager, baseUrl } = await managerFixture(t);
  const created = await json(await fetch(`${baseUrl}/v1/tasks`, {
    method: 'POST',
    headers: headers(manager.token),
    body: JSON.stringify({ module: 'example', input: { url: 'https://example.com' } })
  }));
  assert.equal(created.response.status, 202);
  assert.equal(created.body.task.state, 'queued');
  assert.equal(created.body.task.modulePath, undefined);
  assert.equal(created.body.task.input, undefined);

  const taskId = created.body.task.id;
  const fetched = await json(await fetch(`${baseUrl}/v1/tasks/${taskId}`, {
    headers: headers(manager.token)
  }));
  assert.equal(fetched.response.status, 200);
  assert.equal(fetched.body.task.id, taskId);

  const resumed = await json(await fetch(`${baseUrl}/v1/tasks/${taskId}/resume`, {
    method: 'POST',
    headers: headers(manager.token),
    body: JSON.stringify({ resumeKey: 'manager-resume-0001' })
  }));
  assert.equal(resumed.response.status, 202);
  assert.equal(resumed.body.task.attempt, 2);
  assert.match(resumed.body.notice, /unknown/i);

  const cancelled = await json(await fetch(`${baseUrl}/v1/tasks/${taskId}/cancel`, {
    method: 'POST',
    headers: headers(manager.token),
    body: '{}'
  }));
  assert.equal(cancelled.response.status, 200);
  assert.equal(cancelled.body.task.state, 'cancelled');
});

test('taskServiceFactory receives the initialized ProfileStore and task state directory', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'eric-task-master-factory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let received;
  const service = { async list() { return []; } };
  const manager = await createManager({
    port: 0,
    dataDir: join(root, 'data'),
    taskServiceFactory(options) {
      received = options;
      return service;
    }
  });
  assert.equal(received.profileStore, manager.profileStore);
  assert.equal(received.stateDir, join(root, 'data', 'tasks'));
  assert.equal(manager.taskService, service);
});

test('Manager enters a visible stopping state and rejects new operations before service cleanup', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'eric-task-master-stopping-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let releaseCleanup;
  const cleanupBarrier = new Promise((resolveCleanup) => { releaseCleanup = resolveCleanup; });
  let closeStarted = false;
  const manager = await createManager({
    port: 0,
    dataDir: join(root, 'data'),
    taskService: {
      async list() { return []; },
      async close() {
        closeStarted = true;
        await cleanupBarrier;
      }
    }
  });
  await manager.start();
  const baseUrl = manager.baseUrl;
  const stopping = manager.stop();
  while (!closeStarted) await new Promise((resolveWait) => setTimeout(resolveWait, 1));

  const health = await json(await fetch(`${baseUrl}/v1/health`));
  assert.equal(health.response.status, 200);
  assert.equal(health.body.state, 'stopping');
  const rejected = await json(await fetch(`${baseUrl}/v1/profiles`, {
    method: 'POST',
    headers: headers(manager.token),
    body: JSON.stringify({ name: 'Must not be created' })
  }));
  assert.equal(rejected.response.status, 503);
  assert.equal(rejected.body.error.code, 'SERVICE_CLOSING');
  assert.deepEqual(await manager.profileStore.list(), []);

  releaseCleanup();
  await stopping;
});

test('authenticated graceful shutdown acknowledges before cleanup and cannot self-deadlock', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'eric-task-master-api-shutdown-'));
  let releaseCleanup;
  const cleanupBarrier = new Promise((resolveCleanup) => { releaseCleanup = resolveCleanup; });
  let closeStarted = false;
  const manager = await createManager({
    port: 0,
    dataDir: join(root, 'data'),
    taskService: {
      async list() { return []; },
      async close() {
        closeStarted = true;
        await cleanupBarrier;
      }
    }
  });
  await manager.start();
  const baseUrl = manager.baseUrl;
  t.after(async () => {
    releaseCleanup();
    await manager.stop().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  const unauthorized = await json(await fetch(`${baseUrl}/v1/manager/shutdown`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}'
  }));
  assert.equal(unauthorized.response.status, 401);
  assert.equal(unauthorized.body.error.code, 'AUTH_REQUIRED');

  const agentToken = await issueAgent(baseUrl, manager.token, 'shutdown-denied-agent');
  const forbidden = await json(await fetch(`${baseUrl}/v1/manager/shutdown`, {
    method: 'POST',
    headers: headers(agentToken),
    body: '{}'
  }));
  assert.equal(forbidden.response.status, 403);
  assert.equal(forbidden.body.error.code, 'ROLE_FORBIDDEN');

  const gracefulStop = manager.shutdownRequested.then(() => manager.stop());
  const accepted = await json(await fetch(`${baseUrl}/v1/manager/shutdown`, {
    method: 'POST',
    headers: headers(manager.token),
    body: '{}'
  }));
  assert.equal(accepted.response.status, 202);
  assert.equal(accepted.body.accepted, true);
  assert.equal(accepted.body.state, 'stopping');
  assert.equal(accepted.body.pid, process.pid);
  assert.match(accepted.body.identityFingerprint, /^[A-Za-z0-9_-]{43}$/);
  assert.match(accepted.body.requestedAt, /^\d{4}-\d{2}-\d{2}T/);

  while (!closeStarted) await new Promise((resolveWait) => setTimeout(resolveWait, 1));
  const health = await json(await fetch(`${baseUrl}/v1/health`));
  assert.equal(health.response.status, 200);
  assert.equal(health.body.state, 'stopping');
  releaseCleanup();
  await gracefulStop;
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createManager } from '../src/manager.mjs';

const EXTENSION_ORIGIN = `chrome-extension://${'a'.repeat(32)}`;

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
  const calls = { open: [], close: [], imports: [] };
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
    async importSession(id, bundle) {
      calls.imports.push({ id, bundle });
      if (bundle.cookies[0]?.value === 'throw-secret') {
        throw Object.assign(new Error(`Import rejected ${bundle.cookies[0].value}`), {
          code: 'SESSION_IMPORT_REJECTED',
          statusCode: 400
        });
      }
      return {
        status: 'partial',
        verification: 'storage_imported_not_login_verified',
        cookieCount: bundle.cookies.length,
        localStorageCount: bundle.localStorage.length
      };
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

async function pair(baseUrl) {
  const challengeResult = await json(await fetch(`${baseUrl}/v1/pair/challenge`, {
    headers: { origin: EXTENSION_ORIGIN }
  }));
  assert.equal(challengeResult.response.status, 200);
  assert.equal(
    challengeResult.response.headers.get('access-control-allow-origin'),
    EXTENSION_ORIGIN
  );
  const pairResult = await json(await fetch(`${baseUrl}/v1/pair/extension`, {
    method: 'POST',
    headers: { origin: EXTENSION_ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ challenge: challengeResult.body.challenge, name: 'Test panel' })
  }));
  assert.equal(pairResult.response.status, 201);
  return pairResult.body.token;
}

test('manager serves loopback health/dashboard and persists its token', async (t) => {
  const { manager, baseUrl } = await managerFixture(t);
  const health = await json(await fetch(`${baseUrl}/v1/health`));
  assert.equal(health.response.status, 200);
  assert.equal(health.body.ok, true);
  assert.equal(health.body.version, '0.0.1');
  assert.equal(health.body.host, '127.0.0.1');

  const dashboard = await fetch(`${baseUrl}/dashboard`);
  assert.equal(dashboard.status, 200);
  assert.match(await dashboard.text(), /Task Master/);
  assert.match(manager.dashboardUrl, /#token=/);

  const storedConfig = JSON.parse(await readFile(join(manager.dataDir, 'config.json'), 'utf8'));
  assert.equal(storedConfig.managerToken, manager.token);
  await assert.rejects(
    createManager({ host: '0.0.0.0', dataDir: join(manager.dataDir, 'invalid') }),
    /must bind to 127\.0\.0\.1/
  );
});

test('manager requires auth and pairs only a Chrome extension origin', async (t) => {
  const { baseUrl } = await managerFixture(t);
  const unauthorized = await json(await fetch(`${baseUrl}/v1/profiles`));
  assert.equal(unauthorized.response.status, 401);
  assert.equal(unauthorized.body.error.code, 'AUTH_REQUIRED');

  const webChallenge = await json(await fetch(`${baseUrl}/v1/pair/challenge`, {
    headers: { origin: 'https://example.com' }
  }));
  assert.equal(webChallenge.response.status, 403);
  assert.equal(webChallenge.response.headers.get('access-control-allow-origin'), null);

  const extensionToken = await pair(baseUrl);
  const bearerWithoutOrigin = await json(await fetch(`${baseUrl}/v1/profiles`, {
    headers: { authorization: `Bearer ${extensionToken}` }
  }));
  assert.equal(bearerWithoutOrigin.response.status, 200);

  const listed = await json(await fetch(`${baseUrl}/v1/profiles`, {
    headers: headers(extensionToken, EXTENSION_ORIGIN)
  }));
  assert.equal(listed.response.status, 200);
  assert.deepEqual(listed.body.profiles, []);
});

test('profile CRUD, behavior policy, open and close are exposed without leaking paths', async (t) => {
  const { manager, baseUrl, calls } = await managerFixture(t);
  const createResult = await json(await fetch(`${baseUrl}/v1/profiles`, {
    method: 'POST',
    headers: headers(manager.token),
    body: JSON.stringify({ name: 'Daily work', defaultBehavior: 'fast' })
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

test('session import is extension-only, origin scoped, and never echoes authentication data', async (t) => {
  const { manager, baseUrl, calls } = await managerFixture(t);
  const profileResult = await json(await fetch(`${baseUrl}/v1/profiles`, {
    method: 'POST',
    headers: headers(manager.token),
    body: JSON.stringify({ name: 'Session target' })
  }));
  const profileId = profileResult.body.profile.id;
  const extensionToken = await pair(baseUrl);
  const bundle = {
    origin: 'https://example.com',
    cookies: [{ name: 'session', value: 'top-secret', domain: '.example.com', path: '/' }],
    localStorage: [{ name: 'access_token', value: 'also-secret' }],
    source: { extensionId: 'untrusted', tabUrl: 'https://example.com/account' }
  };

  const managerAttempt = await json(await fetch(`${baseUrl}/v1/profiles/${profileId}/session`, {
    method: 'POST',
    headers: headers(manager.token),
    body: JSON.stringify(bundle)
  }));
  assert.equal(managerAttempt.response.status, 401);

  const imported = await json(await fetch(`${baseUrl}/v1/profiles/${profileId}/session`, {
    method: 'POST',
    headers: headers(extensionToken, EXTENSION_ORIGIN),
    body: JSON.stringify(bundle)
  }));
  assert.equal(imported.response.status, 200);
  assert.deepEqual(imported.body, {
    profileId,
    status: 'partial',
    verification: 'storage_imported_not_login_verified',
    cookieCount: 1,
    localStorageCount: 1
  });
  assert.equal(JSON.stringify(imported.body).includes('top-secret'), false);
  assert.equal(calls.imports[0].bundle.source.extensionId, 'a'.repeat(32));
  assert.equal(calls.imports[0].bundle.cookies[0].value, 'top-secret');

  const mismatch = await json(await fetch(`${baseUrl}/v1/profiles/${profileId}/session`, {
    method: 'POST',
    headers: headers(extensionToken, EXTENSION_ORIGIN),
    body: JSON.stringify({ ...bundle, source: { tabUrl: 'https://other.example/page' } })
  }));
  assert.equal(mismatch.response.status, 400);
  assert.equal(mismatch.body.error.code, 'SESSION_SOURCE_ORIGIN_MISMATCH');

  const rejected = await json(await fetch(`${baseUrl}/v1/profiles/${profileId}/session`, {
    method: 'POST',
    headers: headers(extensionToken, EXTENSION_ORIGIN),
    body: JSON.stringify({
      ...bundle,
      cookies: [{ ...bundle.cookies[0], value: 'throw-secret' }]
    })
  }));
  assert.equal(rejected.response.status, 400);
  assert.equal(rejected.body.message, 'Session import failed');
  assert.equal(JSON.stringify(rejected.body).includes('throw-secret'), false);
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

  const taskId = created.body.task.id;
  const fetched = await json(await fetch(`${baseUrl}/v1/tasks/${taskId}`, {
    headers: headers(manager.token)
  }));
  assert.equal(fetched.response.status, 200);
  assert.equal(fetched.body.task.id, taskId);

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

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
  const calls = { open: [], close: [], behavior: [], resumes: [], deletes: [], lifecycle: [] };
  let taskService;
  const buildTaskService = ({ profileStore }) => taskService = {
    async list() {
      return [...tasks.values()];
    },
    async create(input, caller) {
      const existing = typeof input.idempotencyKey === 'string'
        ? [...tasks.values()].find((task) => task.input?.idempotencyKey === input.idempotencyKey)
        : null;
      if (existing) return existing;
      const task = {
        id: `task_${tasks.size + 1}`,
        revision: 1,
        state: 'queued',
        modulePath: 'C:/secret/task.mjs',
        input,
        ownerRole: caller.role,
        ownerClientId: caller.clientId,
        ...(caller.agentName ? { ownerAgentName: caller.agentName } : {})
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
    async deleteTask(id, body, caller) {
      const task = await this.get(id);
      calls.deletes.push({ id, body, caller });
      tasks.delete(id);
      return { id, deletedAt: new Date().toISOString() };
    },
    async resume(id, body, caller) {
      const task = await this.get(id);
      calls.resumes.push({ id, body, caller });
      task.state = 'queued';
      task.attempt = 2;
      return task;
    },
    async deprecateTaskType(name, body, caller) {
      calls.lifecycle.push({ action: 'deprecate', name, body, caller });
      return { name, lifecycle: 'deprecated', replacedBy: body.replacedBy ?? null };
    },
    async restoreTaskType(name, caller) {
      calls.lifecycle.push({ action: 'restore', name, caller });
      return { name, lifecycle: 'active', replacedBy: null };
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
    async applyProfileBehavior(id, behavior) {
      calls.behavior.push({ id, behavior });
      return { profileId: id, behavior, activeApplied: 0, taskIds: [] };
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

async function issueAgent(baseUrl, managerToken, clientId, name = clientId) {
  const result = await json(await fetch(`${baseUrl}/v1/agents/issue`, {
    method: 'POST',
    headers: headers(managerToken),
    body: JSON.stringify({ clientId, name })
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
  assert.equal(config.agentCredentialVersion, 2);
});

test('ETMA2 snapshots trusted Agent names while authorization remains client-scoped', async (t) => {
  const { manager, baseUrl } = await managerFixture(t);
  const clientId = 'codex.shared-owner';
  const firstToken = await issueAgent(baseUrl, manager.token, clientId, '第一位 Agent 🤖');
  const secondToken = await issueAgent(baseUrl, manager.token, clientId, 'Second Agent');
  assert.notEqual(firstToken, secondToken);
  assert.match(firstToken, /^ETMA2\./);

  const created = await json(await fetch(`${baseUrl}/v1/tasks`, {
    method: 'POST',
    headers: headers(firstToken),
    body: JSON.stringify({
      profileId: 'profile_fixture',
      taskType: 'fixture',
      idempotencyKey: 'trusted-agent-name'
    })
  }));
  assert.equal(created.response.status, 202);
  assert.deepEqual(created.body.task.agent, {
    clientId,
    name: '第一位 Agent 🤖'
  });

  const readByRenamedAgent = await json(await fetch(`${baseUrl}/v1/tasks/${created.body.task.id}`, {
    headers: headers(secondToken)
  }));
  assert.equal(readByRenamedAgent.response.status, 200);
  assert.deepEqual(readByRenamedAgent.body.task.agent, created.body.task.agent);

  const forged = await json(await fetch(`${baseUrl}/v1/tasks`, {
    method: 'POST',
    headers: headers(secondToken),
    body: JSON.stringify({
      profileId: 'profile_fixture',
      taskType: 'fixture',
      idempotencyKey: 'forged-agent-name',
      ownerAgentName: 'Forged owner'
    })
  }));
  assert.equal(forged.response.status, 400);
  assert.equal(forged.body.error.code, 'INVALID_TASK_CREATE');
});

test('task record deletion is Owner-only and forwards revision-safe intent', async (t) => {
  const { manager, baseUrl, calls } = await managerFixture(t);
  const agentToken = await issueAgent(baseUrl, manager.token, 'codex.delete', 'Codex');
  const created = await json(await fetch(`${baseUrl}/v1/tasks`, {
    method: 'POST',
    headers: headers(agentToken),
    body: JSON.stringify({
      profileId: 'profile_fixture', taskType: 'fixture', taskLabel: '删除契约测试',
      idempotencyKey: 'task-delete-contract'
    })
  }));
  assert.equal(created.response.status, 202);
  const request = {
    commandId: 'delete-contract-1',
    expectedRevision: created.body.task.revision
  };
  const forbidden = await json(await fetch(`${baseUrl}/v1/tasks/${created.body.task.id}`, {
    method: 'DELETE', headers: headers(agentToken), body: JSON.stringify(request)
  }));
  assert.equal(forbidden.response.status, 403);

  const deleted = await json(await fetch(`${baseUrl}/v1/tasks/${created.body.task.id}`, {
    method: 'DELETE', headers: headers(manager.token), body: JSON.stringify(request)
  }));
  assert.equal(deleted.response.status, 200);
  assert.equal(deleted.body.deleted.id, created.body.task.id);
  assert.deepEqual(calls.deletes[0], {
    id: created.body.task.id,
    body: request,
    caller: { role: 'manager-admin', clientId: 'manager-admin' }
  });
});

test('ETMA2 survives Manager restart and fails closed after admin token rotation', async (t) => {
  const { root, manager, baseUrl } = await managerFixture(t);
  const originalAgentToken = await issueAgent(baseUrl, manager.token, 'codex.restart', 'Restart Agent');
  const dataDir = join(root, 'data');
  const dashboardDir = join(root, 'dashboard');
  await manager.stop();

  let replacement = await createManager({ port: 0, dataDir, dashboardDir, taskService: {} });
  await replacement.start();
  let read = await json(await fetch(`${replacement.baseUrl}/v1/profiles`, {
    headers: headers(originalAgentToken)
  }));
  assert.equal(read.response.status, 200);
  await replacement.stop();

  const configPath = join(dataDir, 'config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const rotatedManagerToken = 'rotated-manager-admin-token'.padEnd(48, 'r');
  config.managerToken = rotatedManagerToken;
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

  replacement = await createManager({ port: 0, dataDir, dashboardDir, taskService: {} });
  await replacement.start();
  t.after(() => replacement.stop().catch(() => {}));
  read = await json(await fetch(`${replacement.baseUrl}/v1/profiles`, {
    headers: headers(originalAgentToken)
  }));
  assert.equal(read.response.status, 401);
  assert.equal(read.body.error.code, 'INVALID_TOKEN');
  const rotatedAgentToken = await issueAgent(
    replacement.baseUrl,
    rotatedManagerToken,
    'codex.restart',
    'Restart Agent'
  );
  read = await json(await fetch(`${replacement.baseUrl}/v1/profiles`, {
    headers: headers(rotatedAgentToken)
  }));
  assert.equal(read.response.status, 200);
});

test('Agent issuance rejects controls and non-bounded display names without truncation', async (t) => {
  const { manager, baseUrl } = await managerFixture(t);
  for (const name of ['Agent\nName', 'a'.repeat(81), `${'é'.repeat(79)}🤖`, '   ']) {
    const rejected = await json(await fetch(`${baseUrl}/v1/agents/issue`, {
      method: 'POST',
      headers: headers(manager.token),
      body: JSON.stringify({ clientId: 'codex.invalid-name', name })
    }));
    assert.equal(rejected.response.status, 400, JSON.stringify(name));
    assert.equal(rejected.body.error.code, 'INVALID_AGENT_NAME', JSON.stringify(name));
  }
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
    body: JSON.stringify({ defaultBehavior: 'auto' })
  }));
  assert.equal(patchResult.response.status, 200);
  assert.equal(patchResult.body.profile.defaultBehavior, 'auto');

  const persistentResult = await json(await fetch(`${baseUrl}/v1/profiles`, {
    method: 'POST',
    headers: headers(manager.token),
    body: JSON.stringify({ name: 'Signed-in Chrome' })
  }));
  assert.equal(persistentResult.response.status, 201);
  assert.equal(persistentResult.body.profile.browserEngine, 'chrome');
  assert.equal(persistentResult.body.profile.defaultBehavior, 'human');
  const liveBehavior = await json(await fetch(
    `${baseUrl}/v1/profiles/${persistentResult.body.profile.id}`,
    {
      method: 'PATCH',
      headers: headers(manager.token),
      body: JSON.stringify({ defaultBehavior: 'fast' })
    }
  ));
  assert.equal(liveBehavior.response.status, 200);
  assert.equal(liveBehavior.body.profile.defaultBehavior, 'fast');
  assert.deepEqual(calls.behavior, [
    { id: profileId, behavior: 'auto' },
    { id: persistentResult.body.profile.id, behavior: 'fast' }
  ]);

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

test('Profiles are globally shared and the persistent Owner Console can manage Agents', async (t) => {
  const { manager, baseUrl } = await managerFixture(t);
  const tokenA = await issueAgent(baseUrl, manager.token, 'agent-profile-a');
  const tokenB = await issueAgent(baseUrl, manager.token, 'agent-profile-b');

  const created = await json(await fetch(`${baseUrl}/v1/profiles`, {
    method: 'POST',
    headers: headers(tokenA),
    body: JSON.stringify({ name: 'Global Profile', kind: 'persistent' })
  }));
  assert.equal(created.response.status, 201);
  assert.equal(Object.hasOwn(created.body.profile, 'access'), false);
  assert.equal(Object.hasOwn(created.body.profile, 'createdBy'), false);
  const profileId = created.body.profile.id;

  const visible = await json(await fetch(`${baseUrl}/v1/profiles`, { headers: headers(tokenB) }));
  assert.equal(visible.response.status, 200);
  assert.equal(visible.body.profiles.some((profile) => profile.id === profileId), true);
  const renamed = await json(await fetch(`${baseUrl}/v1/profiles/${profileId}`, {
    method: 'PATCH',
    headers: headers(tokenB),
    body: JSON.stringify({ name: 'Renamed by Agent B' })
  }));
  assert.equal(renamed.response.status, 200);
  assert.equal(renamed.body.profile.name, 'Renamed by Agent B');

  const dashboardAuthorization = await json(await fetch(`${baseUrl}/v1/dashboard/authorize`, {
    method: 'POST', headers: headers(tokenB), body: '{}'
  }));
  assert.equal(dashboardAuthorization.response.status, 201);
  const dashboardSession = await json(await fetch(`${baseUrl}/v1/dashboard/session`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: dashboardAuthorization.body.code })
  }));
  assert.equal(dashboardSession.response.status, 201);
  assert.equal(Object.hasOwn(dashboardSession.body, 'dashboardToken'), false);
  const cookie = dashboardSession.response.headers.get('set-cookie').split(';', 1)[0];

  const deniedWithoutOrigin = await json(await fetch(`${baseUrl}/v1/profiles/${profileId}`, {
    method: 'PATCH',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'CSRF attempt' })
  }));
  assert.equal(deniedWithoutOrigin.response.status, 403);
  assert.equal(deniedWithoutOrigin.body.error.code, 'DASHBOARD_ORIGIN_REQUIRED');

  const summary = await json(await fetch(`${baseUrl}/v1/dashboard/summary`, { headers: { cookie } }));
  assert.equal(summary.response.status, 200);
  assert.equal(summary.body.version, VERSION);
  const agents = await json(await fetch(`${baseUrl}/v1/agents`, { headers: { cookie } }));
  assert.equal(agents.response.status, 200);
  assert.equal(agents.body.agents.some((agent) => agent.agentId === 'agent-profile-b'), true);

  const revoked = await json(await fetch(`${baseUrl}/v1/agents/agent-profile-b/actions`, {
    method: 'POST',
    headers: { cookie, origin: baseUrl, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'revoke', reason: 'Owner test' })
  }));
  assert.equal(revoked.response.status, 200);
  assert.equal(revoked.body.agent.status, 'revoked');
  assert.equal((await fetch(`${baseUrl}/v1/profiles`, { headers: headers(tokenB) })).status, 403);

  const restored = await json(await fetch(`${baseUrl}/v1/agents/agent-profile-b/actions`, {
    method: 'POST',
    headers: { cookie, origin: baseUrl, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'restore' })
  }));
  assert.equal(restored.response.status, 200);
  assert.equal(restored.body.agent.status, 'offline');
  assert.equal((await fetch(`${baseUrl}/v1/profiles`, { headers: headers(tokenB) })).status, 200);
});

test('task type lifecycle routes are admin-only and preserve replacement metadata', async (t) => {
  const { manager, baseUrl, calls } = await managerFixture(t);
  const taskTypeName = 'fixture.read';
  const agentToken = await issueAgent(baseUrl, manager.token, 'lifecycle-agent');

  const forbidden = await json(await fetch(`${baseUrl}/v1/task-types/${taskTypeName}/actions`, {
    method: 'POST',
    headers: headers(agentToken),
    body: JSON.stringify({ action: 'deprecate' })
  }));
  assert.equal(forbidden.response.status, 403);
  assert.equal(forbidden.body.error.code, 'ROLE_FORBIDDEN');

  const deprecated = await json(await fetch(`${baseUrl}/v1/task-types/${taskTypeName}/actions`, {
    method: 'POST',
    headers: headers(manager.token),
    body: JSON.stringify({ action: 'deprecate', replacedBy: 'fixture.read.v2' })
  }));
  assert.equal(deprecated.response.status, 200);
  assert.equal(deprecated.body.taskType.lifecycle, 'deprecated');
  assert.equal(deprecated.body.taskType.replacedBy, 'fixture.read.v2');

  const restored = await json(await fetch(`${baseUrl}/v1/task-types/${taskTypeName}/actions`, {
    method: 'POST',
    headers: headers(manager.token),
    body: JSON.stringify({ action: 'restore' })
  }));
  assert.equal(restored.response.status, 200);
  assert.equal(restored.body.taskType.lifecycle, 'active');
  assert.deepEqual(calls.lifecycle.map(({ action, name }) => ({ action, name })), [
    { action: 'deprecate', name: taskTypeName },
    { action: 'restore', name: taskTypeName }
  ]);
});

test('task routes delegate to taskService and strip private task fields', async (t) => {
  const { manager, baseUrl } = await managerFixture(t);
  const requestBody = {
    profileId: 'profile_fixture',
    taskType: 'example',
    input: { url: 'https://example.com' },
    idempotencyKey: 'manager-task-0001'
  };
  const created = await json(await fetch(`${baseUrl}/v1/tasks`, {
    method: 'POST',
    headers: headers(manager.token),
    body: JSON.stringify(requestBody)
  }));
  assert.equal(created.response.status, 202);
  assert.equal(created.body.taskId, created.body.task.id);
  assert.match(created.body.dashboardUrl, new RegExp(`^${baseUrl.replaceAll('.', '\\.')}/dashboard\\?task=${created.body.task.id}#code=[A-Za-z0-9_-]{32}$`));
  assert.equal(created.body.dashboardUrl.includes(manager.token), false);
  assert.equal(created.body.task.state, 'queued');
  assert.equal(created.body.task.modulePath, undefined);
  assert.equal(created.body.task.input, undefined);

  const retried = await json(await fetch(`${baseUrl}/v1/tasks`, {
    method: 'POST',
    headers: headers(manager.token),
    body: JSON.stringify(requestBody)
  }));
  assert.equal(retried.response.status, 202);
  assert.equal(retried.body.taskId, created.body.taskId);
  assert.notEqual(retried.body.dashboardUrl, created.body.dashboardUrl);

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

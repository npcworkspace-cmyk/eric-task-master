import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { ManagerLock } from '../src/lib/manager-lock.mjs';
import { createManager } from '../src/manager.mjs';
import { VERSION } from '../src/contracts.mjs';


async function call(baseUrl, pathname, { method = 'GET', token, cookie, origin, headers = {}, body } = {}) {
  const response = await fetch(new URL(pathname, baseUrl), {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(token ? { 'x-taskmaster-runtime-version': VERSION } : {}),
      ...(cookie ? { cookie } : {}),
      ...(origin ? { origin } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const payload = await response.json();
  return { status: response.status, payload, headers: response.headers };
}

function cookiePair(response) {
  const setCookie = response.headers.get('set-cookie');
  assert.equal(typeof setCookie, 'string');
  return setCookie.split(';', 1)[0];
}

function serviceFixture() {
  const calls = [];
  const tasks = new Map();
  return {
    calls,
    async listTaskTypes(filters, caller) {
      calls.push(['list-types', caller, filters]);
      return { taskTypes: [{ name: 'fixture', sha256: 'a'.repeat(64) }] };
    },
    async describeTaskType(name) {
      return { id: name, name, inputSchema: { type: 'object' } };
    },
    async listTaskPacks(caller) {
      calls.push(['list-packs', caller]);
      return {
        taskPacks: [{
          id: 'pack:fixture@1.0.0', name: 'fixture', version: '1.0.0', title: 'Fixture',
          lifecycle: 'active', discoverable: true, protected: false, transient: false,
          fileCount: 1, sizeBytes: 128, installedAt: '2026-08-29T00:00:00.000Z',
          usage: { runCount: 1, activeCount: 0 }, taskTypes: [], deletable: true, deleteBlockers: []
        }],
        total: 1
      };
    },
    async installTaskType(input, caller) {
      calls.push(['install-type', input, caller]);
      return { name: input.name, sha256: 'a'.repeat(64) };
    },
    async list(options) {
      calls.push(['list', options]);
      const caller = options.caller;
      return {
        tasks: [...tasks.values()].filter((task) => (
          caller.role === 'manager-admin' ||
          (task.ownerRole === caller.role && task.ownerClientId === caller.clientId)
        )),
        nextCursor: null
      };
    },
    async create(input, caller) {
      calls.push(['create', input, caller]);
      const task = {
        id: `task_${String(tasks.size + 1).padStart(32, '0')}`,
        state: 'queued',
        ownerRole: caller.role,
        ownerClientId: caller.clientId,
        ...(input.externalCostBudget ? { externalCostBudget: input.externalCostBudget } : {}),
        ...(caller.agentName ? { ownerAgentName: caller.agentName } : {})
      };
      tasks.set(task.id, task);
      return task;
    },
    async get(id, caller) {
      calls.push(['get', id, caller]);
      const task = tasks.get(id);
      if (!task || (caller.role !== 'manager-admin' && (
        task.ownerRole !== caller.role || task.ownerClientId !== caller.clientId
      ))) {
        throw Object.assign(new Error('Task not found'), { statusCode: 404, code: 'TASK_NOT_FOUND' });
      }
      return task;
    },
    async cancel(id, caller) {
      calls.push(['cancel', id, caller]);
      return { id, state: 'cancelled' };
    },
    async focusTask(id, caller) {
      calls.push(['focus', id, caller]);
      const task = await this.get(id, caller);
      return { task, focusedAt: '2026-08-29T00:00:02.000Z' };
    },
    async claimUserRequest(id, input, caller) {
      calls.push(['claim-user-request', id, input, caller]);
      return { id, state: 'waiting_user', userRequest: { id: input.requestId, kind: 'human_verification', status: 'claimed' } };
    },
    async listArtifacts(id, caller) {
      calls.push(['list-artifacts', id, caller]);
      return [{
        id: `artifact_${'a'.repeat(32)}`,
        name: 'result.txt',
        mimeType: 'text/plain',
        sizeBytes: 2,
        agentVisible: true
      }];
    },
    async readArtifact(id, artifactId, options, caller) {
      calls.push(['read-artifact', id, artifactId, options, caller]);
      return {
        artifact: {
          id: artifactId,
          name: 'result.txt',
          mimeType: 'text/plain',
          sizeBytes: 2,
          agentVisible: true
        },
        offset: options.offset,
        nextOffset: 2,
        eof: true,
        encoding: 'utf8',
        chunk: 'ok'
      };
    },
    async openProfile() {},
    async closeProfile() {},
    async close() {}
  };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'taskmaster-security-'));
  const managers = [];
  const manage = (manager) => {
    managers.push(manager);
    return manager;
  };
  t.after(async () => {
    for (const manager of [...managers].reverse()) {
      await manager.stop().catch(() => {});
    }
    await rm(root, { recursive: true, force: true });
  });
  const dashboard = path.join(root, 'dashboard');
  await mkdir(dashboard);
  await writeFile(path.join(dashboard, 'index.html'), '<!doctype html><title>fixture</title>');
  const service = serviceFixture();
  const manager = manage(await createManager({
    port: 0,
    dataDir: path.join(root, 'data'),
    dashboardDir: dashboard,
    taskService: service
  }));
  await manager.start();
  return { root, manager, service, manage, baseUrl: manager.baseUrl };
}

test('role matrix keeps Agent tasks scoped while the Owner Console has a global view', async (t) => {
  const { manager, service, baseUrl } = await fixture(t);

  const issued = await call(baseUrl, '/v1/agents/issue', {
    method: 'POST',
    token: manager.token,
    body: { clientId: 'codex.fixture', name: 'Codex fixture' }
  });
  assert.equal(issued.status, 201);
  assert.equal(issued.payload.agent.clientId, 'codex.fixture');
  assert.equal(typeof issued.payload.agentToken, 'string');
  assert.equal('tokenHash' in issued.payload.agent, false);

  const agentTask = await call(baseUrl, '/v1/tasks', {
    method: 'POST',
    token: issued.payload.agentToken,
    body: {
      profileId: 'profile_fixture',
      taskType: 'fixture',
      idempotencyKey: 'fixture:1'
    }
  });
  assert.equal(agentTask.status, 202);
  assert.equal(agentTask.payload.taskId, agentTask.payload.task.id);
  assert.match(agentTask.payload.dashboardUrl, new RegExp(`^${baseUrl.replaceAll('.', '\\.')}/dashboard\\?task=${agentTask.payload.task.id}#code=`));
  assert.equal(agentTask.payload.dashboardUrl.includes(manager.token), false);
  assert.equal(service.calls.find((entry) => entry[0] === 'create')[2].clientId, 'codex.fixture');
  assert.equal(service.calls.find((entry) => entry[0] === 'create')[2].agentName, 'Codex fixture');
  assert.deepEqual(agentTask.payload.task.agent, {
    clientId: 'codex.fixture',
    name: 'Codex fixture'
  });
  assert.equal(JSON.stringify(agentTask.payload.task).includes(issued.payload.agentToken), false);
  assert.equal('agentToken' in agentTask.payload.task, false);

  const dashboardCode = new URLSearchParams(new URL(agentTask.payload.dashboardUrl).hash.slice(1)).get('code');
  const dashboardSession = await call(baseUrl, '/v1/dashboard/session', {
    method: 'POST', origin: baseUrl, body: { code: dashboardCode }
  });
  assert.equal(dashboardSession.status, 201);
  assert.equal('dashboardToken' in dashboardSession.payload, false);
  const ownerCookie = cookiePair(dashboardSession);

  const otherAgent = await call(baseUrl, '/v1/agents/issue', {
    method: 'POST', token: manager.token, body: { clientId: 'other.fixture', name: 'Other fixture' }
  });
  const otherTask = await call(baseUrl, '/v1/tasks', {
    method: 'POST', token: otherAgent.payload.agentToken, body: {
      profileId: 'profile_fixture', taskType: 'fixture', idempotencyKey: 'fixture:2'
    }
  });
  assert.equal(otherTask.status, 202);

  const ownerTasks = await call(baseUrl, '/v1/tasks', { cookie: ownerCookie });
  assert.equal(ownerTasks.status, 200);
  assert.deepEqual(
    ownerTasks.payload.tasks.map((task) => task.id).sort(),
    [agentTask.payload.task.id, otherTask.payload.task.id].sort()
  );
  const delegatedCaller = service.calls.filter((entry) => entry[0] === 'list').at(-1)[1].caller;
  assert.equal(delegatedCaller.role, 'manager-admin');
  assert.equal(delegatedCaller.clientId, 'manager-admin');

  const otherAgentTasks = await call(baseUrl, '/v1/tasks', { token: otherAgent.payload.agentToken });
  assert.deepEqual(otherAgentTasks.payload.tasks.map((task) => task.id), [otherTask.payload.task.id]);
  const otherAgentCannotReadTask = await call(baseUrl, `/v1/tasks/${agentTask.payload.task.id}`, {
    token: otherAgent.payload.agentToken
  });
  assert.equal(otherAgentCannotReadTask.status, 404);
  const forbiddenFocus = await call(baseUrl, '/v1/dashboard/authorize', {
    method: 'POST', token: otherAgent.payload.agentToken, body: { focusTaskId: agentTask.payload.task.id }
  });
  assert.equal(forbiddenFocus.status, 404);

  const listedArtifacts = await call(baseUrl, `/v1/tasks/${agentTask.payload.task.id}/artifacts`, {
    token: issued.payload.agentToken
  });
  assert.equal(listedArtifacts.status, 200);
  const readArtifact = await call(
    baseUrl,
    `/v1/tasks/${agentTask.payload.task.id}/artifacts/${listedArtifacts.payload.artifacts[0].id}?offset=0&maxBytes=16`,
    { token: issued.payload.agentToken }
  );
  assert.equal(readArtifact.status, 200);
  assert.equal(service.calls.find((entry) => entry[0] === 'read-artifact')[4].clientId, 'codex.fixture');

  const sharedProfile = await call(baseUrl, '/v1/profiles', {
    method: 'POST', token: issued.payload.agentToken, body: {
      name: 'Globally shared Profile', kind: 'ephemeral'
    }
  });
  assert.equal(sharedProfile.status, 201);
  const profilesVisibleToOtherAgent = await call(baseUrl, '/v1/profiles', {
    token: otherAgent.payload.agentToken
  });
  assert.equal(profilesVisibleToOtherAgent.status, 200);
  assert.equal(
    profilesVisibleToOtherAgent.payload.profiles.some((profile) => profile.id === sharedProfile.payload.profile.id),
    true
  );
  const agentDelete = await call(baseUrl, `/v1/profiles/${sharedProfile.payload.profile.id}`, {
    method: 'DELETE', token: otherAgent.payload.agentToken
  });
  assert.equal(agentDelete.status, 200);

  for (const pathname of ['/v1/pair/authorize', '/v1/pair/extension']) {
    const removed = await call(baseUrl, pathname, {
      method: 'POST',
      token: manager.token,
      body: {}
    });
    assert.equal(removed.status, 404, pathname);
  }
});

test('2.7 Manager routes expose read-only Pack state, paid budget, and focus while keeping human claim Owner-only', async (t) => {
  const { manager, service, baseUrl } = await fixture(t);
  const issued = await call(baseUrl, '/v1/agents/issue', {
    method: 'POST', token: manager.token, body: { clientId: 'v27.fixture', name: 'V27 fixture' }
  });
  assert.equal(issued.status, 201);
  const agentToken = issued.payload.agentToken;

  const packs = await call(baseUrl, '/v1/task-packs', { token: agentToken });
  assert.equal(packs.status, 200);
  assert.equal(packs.payload.taskPacks[0].name, 'fixture');
  assert.equal(JSON.stringify(packs.payload).includes('modulePath'), false);

  const started = await call(baseUrl, '/v1/tasks', {
    method: 'POST', token: agentToken, body: {
      profileId: 'profile_fixture',
      taskType: 'fixture',
      externalCostBudget: { currency: 'USD', maxAmount: 2.5 },
      idempotencyKey: 'v27:paid:fixture'
    }
  });
  assert.equal(started.status, 202);
  assert.equal('externalCostBudget' in started.payload.task, false);
  assert.equal(JSON.stringify(started.payload.task).includes('maxAmount'), false);
  assert.deepEqual(
    service.calls.find((entry) => entry[0] === 'create')[1].externalCostBudget,
    { currency: 'USD', maxAmount: 2.5 }
  );

  const focused = await call(baseUrl, `/v1/tasks/${started.payload.taskId}/focus`, {
    method: 'POST', token: agentToken, body: {}
  });
  assert.equal(focused.status, 200);
  assert.equal(focused.payload.focusedAt, '2026-08-29T00:00:02.000Z');

  const requestId = 'handoff_0123456789abcdef0123456789abcdef';
  const agentClaim = await call(baseUrl, `/v1/tasks/${started.payload.taskId}/user-request/claim`, {
    method: 'POST', token: agentToken, body: { requestId }
  });
  assert.equal(agentClaim.status, 403);
  assert.equal(agentClaim.payload.error.code, 'ROLE_FORBIDDEN');
  assert.equal(service.calls.some((entry) => entry[0] === 'claim-user-request'), false);

  const ownerClaim = await call(baseUrl, `/v1/tasks/${started.payload.taskId}/user-request/claim`, {
    method: 'POST', token: manager.token, body: { requestId }
  });
  assert.equal(ownerClaim.status, 200);
  assert.equal(ownerClaim.payload.task.userRequest.status, 'claimed');
});

test('Owner Console exchanges one-time codes for persistent same-origin cookie sessions', async (t) => {
  const { root, manager, manage, baseUrl } = await fixture(t);
  assert.equal(manager.dashboardUrl, `${baseUrl}/dashboard`);
  assert.equal(manager.dashboardUrl.includes(manager.token), false);

  const authorization = await call(baseUrl, '/v1/dashboard/authorize', {
    method: 'POST',
    token: manager.token,
    body: {}
  });
  assert.equal(authorization.status, 201);
  assert.match(authorization.payload.code, /^[a-zA-Z0-9_-]{32}$/);

  const session = await call(baseUrl, '/v1/dashboard/session', {
    method: 'POST',
    origin: baseUrl,
    body: { code: authorization.payload.code }
  });
  assert.equal(session.status, 201);
  assert.equal(session.payload.ok, true);
  assert.equal(typeof session.payload.session.id, 'string');
  assert.equal(typeof session.payload.expiresInMs, 'number');
  assert.equal('dashboardToken' in session.payload, false);
  const setCookie = session.headers.get('set-cookie');
  assert.match(setCookie, /^taskmaster_owner=[^;]+;/u);
  assert.match(setCookie, /; HttpOnly(?:;|$)/iu);
  assert.match(setCookie, /; SameSite=Strict(?:;|$)/iu);
  assert.match(setCookie, /; Path=\/(?:;|$)/iu);
  assert.match(setCookie, /; Max-Age=\d+(?:;|$)/iu);
  const ownerCookie = cookiePair(session);

  const reused = await call(baseUrl, '/v1/dashboard/session', {
    method: 'POST',
    origin: baseUrl,
    body: { code: authorization.payload.code }
  });
  assert.equal(reused.status, 401);

  const missingOrigin = await call(baseUrl, '/v1/profiles', {
    method: 'POST',
    cookie: ownerCookie,
    body: { name: 'Blocked cross-site mutation', kind: 'ephemeral' }
  });
  assert.equal(missingOrigin.status, 403);
  assert.equal(missingOrigin.payload.error.code, 'DASHBOARD_ORIGIN_REQUIRED');

  const foreignOrigin = await call(baseUrl, '/v1/profiles', {
    method: 'POST',
    cookie: ownerCookie,
    origin: 'https://attacker.invalid',
    body: { name: 'Blocked foreign-origin mutation', kind: 'ephemeral' }
  });
  assert.equal(foreignOrigin.status, 403);
  assert.equal(foreignOrigin.payload.error.code, 'ORIGIN_NOT_ALLOWED');

  // A 403 is an authorization/CSRF result, not an expired Owner session.
  const afterForbidden = await call(baseUrl, '/v1/dashboard/summary', { cookie: ownerCookie });
  assert.equal(afterForbidden.status, 200);

  const sameOriginMutation = await call(baseUrl, '/v1/profiles', {
    method: 'POST',
    cookie: ownerCookie,
    origin: baseUrl,
    body: { name: 'Owner-created shared Profile', kind: 'ephemeral' }
  });
  assert.equal(sameOriginMutation.status, 201);

  await manager.stop();
  const replacementService = serviceFixture();
  const replacement = manage(await createManager({
    port: 0,
    dataDir: path.join(root, 'data'),
    dashboardDir: path.join(root, 'dashboard'),
    taskService: replacementService
  }));
  await replacement.start();

  const persisted = await call(replacement.baseUrl, '/v1/dashboard/summary', { cookie: ownerCookie });
  assert.equal(persisted.status, 200);

  const logout = await call(replacement.baseUrl, '/v1/dashboard/logout', {
    method: 'POST',
    cookie: ownerCookie,
    origin: replacement.baseUrl
  });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /^taskmaster_owner=;/u);
  assert.match(logout.headers.get('set-cookie'), /; Max-Age=0(?:;|$)/iu);

  const revoked = await call(replacement.baseUrl, '/v1/dashboard/summary', { cookie: ownerCookie });
  assert.equal(revoked.status, 401);
  assert.equal(revoked.payload.error.code, 'AUTH_REQUIRED');

  // A normal batch may start hundreds of tasks before anyone opens a link.
  // Keep at least 257 outstanding one-time approvals alive concurrently.
  const approvalCodes = [];
  for (let index = 0; index < 257; index += 1) {
    const pending = await call(replacement.baseUrl, '/v1/dashboard/authorize', {
      method: 'POST', token: replacement.token, body: {}
    });
    assert.equal(pending.status, 201);
    approvalCodes.push(pending.payload.code);
  }
  for (const code of [approvalCodes[0], approvalCodes.at(-1)]) {
    const redeemed = await call(replacement.baseUrl, '/v1/dashboard/session', {
      method: 'POST', origin: replacement.baseUrl, body: { code }
    });
    assert.equal(redeemed.status, 201);
  }
});

test('a state directory has exactly one live Manager owner', async (t) => {
  const { root, manager, manage } = await fixture(t);
  await assert.rejects(
    createManager({ port: 0, dataDir: path.join(root, 'data'), taskService: serviceFixture() }),
    { code: 'MANAGER_ALREADY_RUNNING' }
  );
  await manager.stop();
  const replacement = manage(await createManager({
    port: 0,
    dataDir: path.join(root, 'data'),
    taskService: serviceFixture()
  }));
  await replacement.start();
  await replacement.stop();
});

test('Manager state ownership is exclusive across processes and stale locks recover', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'taskmaster-process-lock-'));
  const lockPath = path.join(root, '.manager.lock');
  const moduleUrl = pathToFileURL(path.resolve('src/lib/manager-lock.mjs')).href;
  const childScript = [
    `import { ManagerLock } from ${JSON.stringify(moduleUrl)};`,
    `const lock = new ManagerLock(${JSON.stringify(lockPath)});`,
    'await lock.acquire();',
    "process.stdout.write('READY\\n');",
    'setInterval(() => {}, 1_000);'
  ].join('\n');
  const child = spawn(process.execPath, ['--input-type=module', '--eval', childScript], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await rm(root, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('child Manager lock did not become ready')), 5_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdout.once('data', (chunk) => {
      clearTimeout(timer);
      assert.match(String(chunk), /READY/);
      resolve();
    });
  });

  const contender = new ManagerLock(lockPath);
  await assert.rejects(contender.acquire(), { code: 'MANAGER_ALREADY_RUNNING' });
  child.kill();
  await new Promise((resolve) => child.once('exit', resolve));

  const replacement = new ManagerLock(lockPath);
  await replacement.acquire();
  await replacement.release();
});

test('two processes recovering one stale Manager lock never overlap or remove the winner', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'taskmaster-double-recovery-'));
  const lockPath = path.join(root, '.manager.lock');
  const eventsPath = path.join(root, 'events.jsonl');
  await writeFile(lockPath, `${JSON.stringify({
    pid: 2_000_000_000,
    nonce: 'abandoned-owner',
    createdAt: new Date(0).toISOString()
  })}\n`);
  await writeFile(`${lockPath}.recovery`, `${JSON.stringify({
    pid: 2_000_000_000,
    nonce: 'abandoned-recovery-owner',
    createdAt: new Date(0).toISOString()
  })}\n`);
  const moduleUrl = pathToFileURL(path.resolve('src/lib/manager-lock.mjs')).href;
  const childScript = [
    "import { access, appendFile, writeFile } from 'node:fs/promises';",
    `import { ManagerLock } from ${JSON.stringify(moduleUrl)};`,
    `const lockPath = ${JSON.stringify(lockPath)};`,
    `const eventsPath = ${JSON.stringify(eventsPath)};`,
    `const barrierRoot = ${JSON.stringify(root)};`,
    "const owner = process.env.TEST_OWNER;",
    'let barrierEntered = false;',
    'const lock = new ManagerLock(lockPath, { recoveryHook: async () => {',
    '  if (barrierEntered) return;',
    '  barrierEntered = true;',
    "  await writeFile(`${barrierRoot}/ready-${owner}`, 'ready');",
    '  for (;;) {',
    '    const ready = await Promise.all([\'a\', \'b\'].map(async (name) => {',
    '      try { await access(`${barrierRoot}/ready-${name}`); return true; } catch { return false; }',
    '    }));',
    '    if (ready.every(Boolean)) break;',
    '    await new Promise((resolve) => setTimeout(resolve, 5));',
    '  }',
    '} });',
    'for (;;) {',
    '  try { await lock.acquire(); break; }',
    '  catch (error) {',
    "    if (!['MANAGER_LOCK_BUSY', 'MANAGER_ALREADY_RUNNING'].includes(error?.code)) throw error;",
    '    await new Promise((resolve) => setTimeout(resolve, 10));',
    '  }',
    '}',
    "await appendFile(eventsPath, JSON.stringify({ owner, event: 'enter', at: Date.now() }) + '\\n');",
    'await new Promise((resolve) => setTimeout(resolve, 150));',
    "await appendFile(eventsPath, JSON.stringify({ owner, event: 'exit', at: Date.now() }) + '\\n');",
    'await lock.release();'
  ].join('\n');
  const children = ['a', 'b'].map((owner) => spawn(
    process.execPath,
    ['--input-type=module', '--eval', childScript],
    {
      env: { ...process.env, TEST_OWNER: owner },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    }
  ));
  t.after(async () => {
    for (const child of children) if (child.exitCode === null) child.kill();
    await rm(root, { recursive: true, force: true });
  });
  const results = await Promise.all(children.map((child) => new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(stderr || `child exited ${code}`)));
  })));
  assert.equal(results.length, 2);
  const events = (await readFile(eventsPath, 'utf8')).trim().split(/\r?\n/u).map(JSON.parse);
  assert.equal(events.length, 4);
  const intervals = ['a', 'b'].map((owner) => ({
    enter: events.find((event) => event.owner === owner && event.event === 'enter').at,
    exit: events.find((event) => event.owner === owner && event.event === 'exit').at
  })).sort((left, right) => left.enter - right.enter);
  assert.ok(intervals[0].exit <= intervals[1].enter, JSON.stringify(intervals));
  await assert.rejects(readFile(lockPath, 'utf8'), { code: 'ENOENT' });
  await assert.rejects(readFile(`${lockPath}.recovery`, 'utf8'), { code: 'ENOENT' });
});

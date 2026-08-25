import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { ManagerLock } from '../src/lib/manager-lock.mjs';
import { createManager } from '../src/manager.mjs';


async function call(baseUrl, pathname, { method = 'GET', token, origin, headers = {}, body } = {}) {
  const response = await fetch(new URL(pathname, baseUrl), {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(origin ? { origin } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const payload = await response.json();
  return { status: response.status, payload };
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
    async installTaskType(input, caller) {
      calls.push(['install-type', input, caller]);
      return { name: input.name, sha256: 'a'.repeat(64) };
    },
    async list(options) {
      calls.push(['list', options]);
      return { tasks: [...tasks.values()], nextCursor: null };
    },
    async create(input, caller) {
      calls.push(['create', input, caller]);
      const task = { id: `task_${String(tasks.size + 1).padStart(32, '0')}`, state: 'queued' };
      tasks.set(task.id, task);
      return task;
    },
    async get(id, caller) {
      calls.push(['get', id, caller]);
      return tasks.get(id) || { id, state: 'running' };
    },
    async cancel(id, caller) {
      calls.push(['cancel', id, caller]);
      return { id, state: 'cancelled' };
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
  const dashboard = path.join(root, 'dashboard');
  await mkdir(dashboard);
  await writeFile(path.join(dashboard, 'index.html'), '<!doctype html><title>fixture</title>');
  const service = serviceFixture();
  const manager = await createManager({
    port: 0,
    dataDir: path.join(root, 'data'),
    dashboardDir: dashboard,
    taskService: service
  });
  await manager.start();
  t.after(async () => {
    await manager.stop().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  return { root, manager, service, baseUrl: manager.baseUrl };
}

test('role matrix scopes MCP Agent identity and keeps removed extension routes closed', async (t) => {
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
  assert.equal(service.calls.find((entry) => entry[0] === 'create')[2].clientId, 'codex.fixture');

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

  const agentDelete = await call(baseUrl, '/v1/profiles/profile_fixture', {
    method: 'DELETE',
    token: issued.payload.agentToken
  });
  assert.equal(agentDelete.status, 403);

  for (const pathname of ['/v1/pair/authorize', '/v1/pair/extension']) {
    const removed = await call(baseUrl, pathname, {
      method: 'POST',
      token: manager.token,
      body: {}
    });
    assert.equal(removed.status, 404, pathname);
  }
});

test('Dashboard exchanges a one-time code for a scoped in-memory session', async (t) => {
  const { manager, service, baseUrl } = await fixture(t);
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
  assert.equal(typeof session.payload.dashboardToken, 'string');

  const reused = await call(baseUrl, '/v1/dashboard/session', {
    method: 'POST',
    origin: baseUrl,
    body: { code: authorization.payload.code }
  });
  assert.equal(reused.status, 401);

  const listed = await call(baseUrl, '/v1/tasks', { token: session.payload.dashboardToken });
  assert.equal(listed.status, 200);
  assert.equal(service.calls.find((entry) => entry[0] === 'list')[1].caller.role, 'manager-admin');

  const cannotCreate = await call(baseUrl, '/v1/tasks', {
    method: 'POST',
    token: session.payload.dashboardToken,
    body: {
      profileId: 'profile_fixture',
      taskType: 'fixture',
      idempotencyKey: 'dashboard-create-forbidden'
    }
  });
  assert.equal(cannotCreate.status, 403);
});

test('a state directory has exactly one live Manager owner', async (t) => {
  const { root, manager } = await fixture(t);
  await assert.rejects(
    createManager({ port: 0, dataDir: path.join(root, 'data'), taskService: serviceFixture() }),
    { code: 'MANAGER_ALREADY_RUNNING' }
  );
  await manager.stop();
  const replacement = await createManager({
    port: 0,
    dataDir: path.join(root, 'data'),
    taskService: serviceFixture()
  });
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

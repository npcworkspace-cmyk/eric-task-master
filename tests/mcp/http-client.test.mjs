import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { VERSION } from '../../src/contracts.mjs';
import {
  createIdentityNonce,
  createManagerIdentityProof,
  generateManagerIdentity,
  MANAGER_SERVICE
} from '../../src/lib/manager-identity.mjs';
import { assertSafeTaskInput, HttpTaskMasterClient } from '../../src/mcp/taskmaster-client.mjs';

const ADMIN_TOKEN = 'a'.repeat(40);
const AGENT_TOKEN = 'b'.repeat(40);

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

function reply(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': body.length
  });
  response.end(body);
}

async function fixture(t, handler, { pinnedIdentity = generateManagerIdentity(), identityResponder } = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'taskmaster-mcp-'));
  await writeFile(join(stateDir, 'config.json'), JSON.stringify({
    managerToken: ADMIN_TOKEN,
    managerIdentity: pinnedIdentity
  }), { mode: 0o600 });
  let server;
  server = createServer(async (request, response) => {
    if (request.url === '/v1/identity/challenge') {
      const body = await readJson(request);
      if (identityResponder) {
        await identityResponder({ request, response, body, port: server.address().port, pinnedIdentity });
        return;
      }
      reply(response, 200, createManagerIdentityProof(pinnedIdentity, {
        service: MANAGER_SERVICE,
        version: VERSION,
        apiVersion: 1,
        host: '127.0.0.1',
        port: server.address().port,
        nonce: body.nonce
      }));
      return;
    }
    await handler(request, response);
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  t.after(async () => {
    await new Promise((resolveClose) => server.close(resolveClose));
    await rm(stateDir, { recursive: true, force: true });
  });
  return {
    stateDir,
    baseUrl: `http://127.0.0.1:${address.port}`,
    pinnedIdentity
  };
}

test('HTTP client exchanges admin credential once and uses scoped agent token afterward', async (t) => {
  const requests = [];
  const connection = await fixture(t, async (request, response) => {
    const body = await readJson(request);
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body });
    if (request.url === '/v1/agents/issue') {
      reply(response, 200, {
        agentToken: AGENT_TOKEN,
        agent: { clientId: 'codex-fixture', name: 'Codex fixture' }
      });
      return;
    }
    if (request.url === '/v1/health') {
      reply(response, 200, { status: { ok: true, service: 'eric-task-master', version: '0.0.2' } });
      return;
    }
    if (request.url === '/v1/tasks' && request.method === 'POST') {
      reply(response, 202, {
        taskId: 'task_safe',
        dashboardUrl: `http://${request.headers.host}/dashboard?task=task_safe#code=${'c'.repeat(32)}`,
        task: {
          id: 'task_safe',
          profileId: body.profileId,
          taskType: body.taskType,
          state: 'queued'
        }
      });
      return;
    }
    if (request.url === '/v1/tasks/task_safe/resume' && request.method === 'POST') {
      reply(response, 202, {
        task: { id: 'task_safe', state: 'queued', attempt: 2 },
        notice: 'Inspect unknown external action outcomes before retrying.'
      });
      return;
    }
    reply(response, 404, { error: { code: 'NOT_FOUND' } });
  });
  const client = new HttpTaskMasterClient({
    ...connection,
    clientId: 'codex-fixture',
    clientName: 'Codex fixture'
  });

  await client.getStatus();
  await client.getStatus();
  await assert.rejects(client.startTask({
    taskType: 'fixture.read',
    profileId: 'profile_safe',
    input: {},
    behavior: 'fast',
    idempotencyKey: 'request-override-0001'
  }), { code: 'UNKNOWN_ARGUMENT' });
  const started = await client.startTask({
    taskType: 'fixture.read',
    profileId: 'profile_safe',
    input: { url: 'https://example.com/' },
    idempotencyKey: 'request-safe-0001'
  });
  assert.equal(started.taskId, started.task.id);
  assert.match(started.dashboardUrl, /\/dashboard\?task=task_safe#code=/u);
  const resumed = await client.resumeTask({ taskId: started.taskId, resumeKey: 'resume-safe-0001' });
  assert.equal(resumed.task.attempt, 2);
  assert.match(resumed.notice, /unknown external action/i);

  assert.equal(requests.filter((item) => item.url === '/v1/agents/issue').length, 1);
  assert.equal(requests[0].authorization, `Bearer ${ADMIN_TOKEN}`);
  for (const request of requests.slice(1)) assert.equal(request.authorization, `Bearer ${AGENT_TOKEN}`);
  assert.deepEqual(requests[0].body, { clientId: 'codex-fixture', name: 'Codex fixture' });
  assert.deepEqual(Object.keys(requests.at(-2).body).sort(), ['idempotencyKey', 'input', 'profileId', 'taskType']);
  assert.deepEqual(requests.at(-1).body, { resumeKey: 'resume-safe-0001' });
});

test('HTTP client validates scoped Dashboard links and complete task start envelopes', async (t) => {
  const connection = await fixture(t, async (request, response) => {
    const body = await readJson(request);
    if (request.url === '/v1/agents/issue') {
      reply(response, 200, {
        agentToken: AGENT_TOKEN,
        agent: { clientId: body.clientId, name: body.name }
      });
      return;
    }
    const origin = `http://${request.headers.host}`;
    if (request.url === '/v1/dashboard/authorize') {
      const suffix = body.focusTaskId ? `?task=${body.focusTaskId}` : '';
      reply(response, 201, { dashboardUrl: `${origin}/dashboard${suffix}#code=${'d'.repeat(32)}` });
      return;
    }
    if (request.url === '/v1/tasks') {
      const task = { id: 'task_safe', state: 'queued' };
      const links = {
        'wrong-origin': `http://127.0.0.1:9/dashboard?task=task_safe#code=${'e'.repeat(32)}`,
        'wrong-path': `${origin}/other?task=task_safe#code=${'e'.repeat(32)}`,
        'wrong-focus': `${origin}/dashboard?task=task_other#code=${'e'.repeat(32)}`,
        'missing-code': `${origin}/dashboard?task=task_safe`,
        valid: `${origin}/dashboard?task=task_safe#code=${'e'.repeat(32)}`
      };
      reply(response, 202, {
        taskId: body.idempotencyKey === 'mismatched-id' ? 'task_other' : task.id,
        dashboardUrl: links[body.idempotencyKey] || links.valid,
        task
      });
      return;
    }
    reply(response, 404, { error: { code: 'NOT_FOUND' } });
  });
  const client = new HttpTaskMasterClient({ ...connection, clientId: 'dashboard-validation' });

  assert.match((await client.openDashboard()).dashboardUrl, /\/dashboard#code=/u);
  assert.match((await client.openDashboard('task_safe')).dashboardUrl, /\/dashboard\?task=task_safe#code=/u);
  for (const idempotencyKey of ['wrong-origin', 'wrong-path', 'wrong-focus', 'missing-code', 'mismatched-id']) {
    await assert.rejects(client.startTask({
      taskType: 'fixture.read',
      profileId: 'profile_safe',
      input: {},
      idempotencyKey
    }), { code: 'INVALID_MANAGER_RESPONSE' });
  }
});

test('Profile open and close keep operation deadlines beyond the generic MCP request timeout', async (t) => {
  const profile = { id: 'profile_slow', name: 'Slow Profile', state: 'idle', kind: 'persistent' };
  const connection = await fixture(t, async (request, response) => {
    const body = await readJson(request);
    if (request.url === '/v1/agents/issue') {
      reply(response, 200, {
        agentToken: AGENT_TOKEN,
        agent: { clientId: 'slow-profile-fixture', name: 'MCP Agent' }
      });
      return;
    }
    if (
      request.method === 'POST' &&
      ['/v1/profiles/profile_slow/open', '/v1/profiles/profile_slow/close'].includes(request.url)
    ) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
      reply(response, 200, { profile });
      return;
    }
    if (request.method === 'PATCH' && request.url === '/v1/profiles/profile_slow') {
      reply(response, 200, { profile: { ...profile, ...body } });
      return;
    }
    reply(response, 404, { error: { code: 'NOT_FOUND' } });
  });
  const client = new HttpTaskMasterClient({
    ...connection,
    clientId: 'slow-profile-fixture',
    requestTimeoutMs: 100
  });

  assert.equal((await client.openProfile(profile.id)).id, profile.id);
  assert.equal((await client.closeProfile(profile.id)).id, profile.id);
  assert.equal((await client.updateProfile(profile.id, { access: 'shared' })).access, 'shared');
});

test('HTTP client treats authorization denial as a Profile choice error, not a credential retry', async (t) => {
  const connection = await fixture(t, async (request, response) => {
    if (request.url === '/v1/agents/issue') {
      await readJson(request);
      reply(response, 200, {
        agentToken: AGENT_TOKEN,
        agent: { clientId: 'forbidden-profile-fixture', name: 'MCP Agent' }
      });
      return;
    }
    reply(response, 403, {
      error: { code: 'PROFILE_ACCESS_DENIED', message: 'private profile' }
    });
  });
  const client = new HttpTaskMasterClient({ ...connection, clientId: 'forbidden-profile-fixture' });
  await assert.rejects(client.listProfiles(), (error) => {
    assert.equal(error.code, 'PROFILE_ACCESS_DENIED');
    assert.equal(error.statusCode, 403);
    assert.equal(error.retryable, false);
    assert.match(error.nextAction, /Profile owned|share/u);
    return true;
  });
});

test('waitTask does not treat a Manager-restart observation as settled cleanup', async (t) => {
  let taskReads = 0;
  const observedProgress = [];
  const connection = await fixture(t, async (request, response) => {
    if (request.url === '/v1/agents/issue') {
      await readJson(request);
      reply(response, 200, {
        agentToken: AGENT_TOKEN,
        agent: { clientId: 'wait-cleanup-fixture', name: 'MCP Agent' }
      });
      return;
    }
    if (request.method === 'GET' && request.url === '/v1/tasks/task_restart') {
      taskReads += 1;
      reply(response, 200, {
        task: {
          id: 'task_restart',
          state: 'failed',
          progress: { completed: taskReads, total: 2 },
          cleanup: {
            managerRestartObserved: true,
            settled: taskReads >= 2
          }
        }
      });
      return;
    }
    reply(response, 404, { error: { code: 'NOT_FOUND' } });
  });
  const client = new HttpTaskMasterClient({
    ...connection,
    clientId: 'wait-cleanup-fixture'
  });

  const result = await client.waitTask('task_restart', {
    waitMs: 1_500,
    onProgress(progress) {
      observedProgress.push(progress?.completed);
    }
  });

  assert.equal(result.timedOut, false);
  assert.equal(result.task.cleanup.managerRestartObserved, true);
  assert.equal(result.task.cleanup.settled, true);
  assert.equal(taskReads, 2);
  assert.deepEqual(observedProgress, [1, 2]);
});

test('HTTP client rejects module, evaluation, session, and credential inputs before network access', async (t) => {
  let requestCount = 0;
  const connection = await fixture(t, (_request, response) => {
    requestCount += 1;
    reply(response, 500, { error: { code: 'SHOULD_NOT_RUN' } });
  });
  const client = new HttpTaskMasterClient({ ...connection, clientId: 'security-fixture' });

  for (const input of [
    { modulePath: './attack.mjs' },
    { evaluate: 'document.cookie' },
    { cookie: 'secret' },
    { nested: { sessionToken: 'secret' } }
  ]) {
    await assert.rejects(
      client.startTask({
        taskType: 'fixture.read',
        profileId: 'profile_safe',
        input,
        idempotencyKey: 'request-safe-0002'
      }),
      { code: 'FORBIDDEN_TASK_INPUT' }
    );
  }
  assert.equal(requestCount, 0);
  assert.doesNotThrow(() => assertSafeTaskInput({
    tokenBudget: 1_000,
    cookieCount: 20,
    sessionLabel: 'morning-run',
    secretaryName: 'fixture'
  }));
});

test('HTTP client fails closed when scoped agent issuance is unavailable', async (t) => {
  const connection = await fixture(t, (_request, response) => {
    reply(response, 404, { error: { code: 'NOT_FOUND', message: `Bearer ${ADMIN_TOKEN}` } });
  });
  const client = new HttpTaskMasterClient({ ...connection, clientId: 'old-manager-fixture' });
  await assert.rejects(client.getStatus(), (error) => {
    assert.equal(error.code, 'SCOPED_AGENT_API_UNAVAILABLE');
    assert.equal(error.message.includes(ADMIN_TOKEN), false);
    return true;
  });
});

test('HTTP client rejects oversized manager responses', async (t) => {
  const connection = await fixture(t, async (request, response) => {
    if (request.url === '/v1/agents/issue') {
      await readJson(request);
      reply(response, 200, {
        agentToken: AGENT_TOKEN,
        agent: { clientId: 'bounds-fixture', name: 'MCP Agent' }
      });
      return;
    }
    const body = JSON.stringify({ status: { service: 'eric-task-master', padding: 'x'.repeat(1024 * 1024) } });
    response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    response.end(body);
  });
  const client = new HttpTaskMasterClient({ ...connection, clientId: 'bounds-fixture' });
  await assert.rejects(client.getStatus(), { code: 'MANAGER_RESPONSE_TOO_LARGE' });
});

test('MCP sends no admin credential when a fake Manager serves the wrong identity key', async (t) => {
  const captured = [];
  const attackerIdentity = generateManagerIdentity();
  const connection = await fixture(t, async (request, response) => {
    captured.push({
      url: request.url,
      authorization: request.headers.authorization,
      body: await readJson(request)
    });
    reply(response, 500, { error: { code: 'TOKEN_CAPTURED' } });
  }, {
    async identityResponder({ request, response, body, port }) {
      captured.push({
        url: request.url,
        authorization: request.headers.authorization,
        body
      });
      reply(response, 200, createManagerIdentityProof(attackerIdentity, {
        service: MANAGER_SERVICE,
        version: VERSION,
        apiVersion: 1,
        host: '127.0.0.1',
        port,
        nonce: body.nonce
      }));
    }
  });
  const client = new HttpTaskMasterClient({ ...connection, clientId: 'fake-manager-key' });

  await assert.rejects(client.getStatus(), { code: 'MANAGER_IDENTITY_MISMATCH' });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].url, '/v1/identity/challenge');
  assert.equal(captured[0].authorization, undefined);
  assert.equal(JSON.stringify(captured).includes(ADMIN_TOKEN), false);
});

test('MCP rejects a replayed Manager signature before sending the admin credential', async (t) => {
  const captured = [];
  const staleNonce = createIdentityNonce();
  const connection = await fixture(t, async (request, response) => {
    captured.push({ url: request.url, authorization: request.headers.authorization });
    reply(response, 500, { error: { code: 'TOKEN_CAPTURED' } });
  }, {
    async identityResponder({ request, response, body, port, pinnedIdentity }) {
      captured.push({
        url: request.url,
        authorization: request.headers.authorization,
        requestedNonce: body.nonce
      });
      reply(response, 200, createManagerIdentityProof(pinnedIdentity, {
        service: MANAGER_SERVICE,
        version: VERSION,
        apiVersion: 1,
        host: '127.0.0.1',
        port,
        nonce: staleNonce
      }));
    }
  });
  const client = new HttpTaskMasterClient({ ...connection, clientId: 'fake-manager-replay' });

  await assert.rejects(client.getStatus(), { code: 'MANAGER_IDENTITY_BINDING_MISMATCH' });
  assert.equal(captured.length, 1);
  assert.notEqual(captured[0].requestedNonce, staleNonce);
  assert.equal(captured[0].authorization, undefined);
  assert.equal(JSON.stringify(captured).includes(ADMIN_TOKEN), false);
});

test('HTTP client refuses non-loopback manager URLs', () => {
  assert.throws(
    () => new HttpTaskMasterClient({ baseUrl: 'http://example.com:19946', clientId: 'bad-origin' }),
    { code: 'LOOPBACK_REQUIRED' }
  );
});

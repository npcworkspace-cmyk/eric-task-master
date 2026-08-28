import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { VERSION } from '../src/contracts.mjs';
import { issueAgentToken } from '../src/lib/agent-token.mjs';
import {
  createManagerIdentityProof,
  generateManagerIdentity,
  MANAGER_SERVICE
} from '../src/lib/manager-identity.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'src', 'cli.mjs');
const ADMIN_TOKEN = `cli-agent-admin-${'a'.repeat(40)}`;

function reply(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': body.length
  });
  response.end(body);
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

function singleJson(run) {
  assert.equal(run.code, 0, run.stderr || run.stdout);
  const lines = run.stdout.trim().split(/\r?\n/u).filter(Boolean);
  assert.equal(lines.length, 1, run.stdout);
  return JSON.parse(lines[0]);
}

test('non-MCP CLI uses one scoped Agent contract for Dashboard, Profiles, tasks, waits, and artifacts', async (t) => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'taskmaster-cli-agent-'));
  const identity = generateManagerIdentity();
  await writeFile(path.join(stateDir, 'config.json'), JSON.stringify({
    managerToken: ADMIN_TOKEN,
    managerIdentity: identity
  }), { mode: 0o600 });

  const requests = [];
  const agentId = 'workbuddy-fixture';
  const agentName = 'WorkBuddy fixture';
  const agentToken = issueAgentToken(ADMIN_TOKEN, { clientId: agentId, name: agentName }).token;
  const profile = {
    id: 'profile_cli',
    name: 'CLI Profile',
    kind: 'ephemeral',
    browserEngine: 'chromium',
    defaultBehavior: 'auto',
    headless: true,
    state: 'idle'
  };
  const issuedConnections = new Set();
  const waitingTask = {
    id: 'task_cli',
    jobId: 'job_cli',
    revision: 3,
    profileId: profile.id,
    taskType: 'fixture.read',
    state: 'waiting_user',
    health: { status: 'healthy' },
    progress: { current: 1, total: 2, message: 'Need instruction' }
  };
  let server;
  server = createServer(async (request, response) => {
    const body = request.method === 'POST' || request.method === 'PATCH'
      ? await readJson(request)
      : {};
    requests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      connectionId: request.headers['x-taskmaster-connection-id'],
      runtimeVersion: request.headers['x-taskmaster-runtime-version'],
      body
    });
    if (request.url === '/v1/health') {
      reply(response, 200, { ok: true, service: MANAGER_SERVICE, version: VERSION, apiVersion: 1 });
      return;
    }
    if (request.url === '/v1/identity/challenge') {
      reply(response, 200, createManagerIdentityProof(identity, {
        service: MANAGER_SERVICE,
        version: VERSION,
        apiVersion: 1,
        host: '127.0.0.1',
        port: server.address().port,
        nonce: body.nonce
      }));
      return;
    }
    if (request.url === '/v1/agents/issue') {
      assert.equal(request.headers.authorization, `Bearer ${ADMIN_TOKEN}`);
      assert.deepEqual(Object.keys(body).sort(), ['clientId', 'connectionId', 'name']);
      assert.equal(body.clientId, agentId);
      assert.equal(body.name, agentName);
      assert.match(body.connectionId, /^mcp-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
      assert.equal(request.headers['x-taskmaster-connection-id'], body.connectionId);
      assert.equal(issuedConnections.has(body.connectionId), false);
      issuedConnections.add(body.connectionId);
      reply(response, 201, { agentToken, agent: { clientId: agentId, name: agentName } });
      return;
    }
    assert.equal(request.headers.authorization, `Bearer ${agentToken}`);
    assert.equal(request.headers['x-taskmaster-runtime-version'], VERSION);
    assert.equal(issuedConnections.has(request.headers['x-taskmaster-connection-id']), true);
    const origin = `http://${request.headers.host}`;
    if (request.url === '/v1/dashboard/authorize') {
      reply(response, 201, {
        dashboardUrl: `${origin}/dashboard${body.focusTaskId ? `?task=${body.focusTaskId}` : ''}#code=${'d'.repeat(32)}`
      });
      return;
    }
    if (request.url === '/v1/profiles' && request.method === 'GET') {
      reply(response, 200, { profiles: [profile] });
      return;
    }
    if (request.url === '/v1/profiles' && request.method === 'POST') {
      reply(response, 201, { profile: { ...profile, ...body } });
      return;
    }
    if (request.url === `/v1/profiles/${profile.id}` && request.method === 'PATCH') {
      reply(response, 200, { profile: { ...profile, ...body } });
      return;
    }
    if (request.url === `/v1/profiles/${profile.id}/open` || request.url === `/v1/profiles/${profile.id}/close`) {
      reply(response, 200, { profile: { ...profile, state: request.url.endsWith('/open') ? 'open' : 'idle' } });
      return;
    }
    if (request.url === '/v1/task-types') {
      reply(response, 200, { taskTypes: [{ name: 'fixture.read', title: 'Fixture read' }] });
      return;
    }
    if (request.url === '/v1/tasks' && request.method === 'POST') {
      const task = { ...waitingTask, state: 'queued' };
      reply(response, 202, {
        taskId: task.id,
        dashboardUrl: `${origin}/dashboard?task=${task.id}#code=${'s'.repeat(32)}`,
        task
      });
      return;
    }
    if (request.url === `/v1/tasks/${waitingTask.id}`) {
      reply(response, 200, { task: waitingTask });
      return;
    }
    if (request.url === `/v1/tasks/${waitingTask.id}/continue`) {
      reply(response, 202, { task: { ...waitingTask, state: 'running', userRequest: null } });
      return;
    }
    if (request.url === '/v1/agent/inbox/claim') {
      reply(response, 200, {
        commands: [{ commandId: 'command_cli', taskId: waitingTask.id, kind: 'ask', revision: 3 }]
      });
      return;
    }
    if (request.url === `/v1/tasks/${waitingTask.id}/commands/command_cli`) {
      reply(response, 200, {
        task: { ...waitingTask, revision: 4 },
        command: { commandId: 'command_cli', status: body.status, response: body.message }
      });
      return;
    }
    if (request.url === `/v1/tasks/${waitingTask.id}/report`) {
      reply(response, 200, {
        task: { ...waitingTask, revision: 4 },
        report: { reportId: body.reportId, status: body.status, title: body.title, summary: body.summary, sections: body.sections }
      });
      return;
    }
    if (request.url === `/v1/tasks/${waitingTask.id}/cancel`) {
      reply(response, 200, { task: { ...waitingTask, state: 'cancelled' } });
      return;
    }
    if (request.url === `/v1/tasks/${waitingTask.id}/artifacts`) {
      reply(response, 200, { artifacts: [{ id: 'artifact_cli', name: 'result.json', size: 12 }] });
      return;
    }
    if (request.url?.startsWith(`/v1/tasks/${waitingTask.id}/artifacts/artifact_cli?`)) {
      reply(response, 200, { artifactId: 'artifact_cli', offset: 0, nextOffset: 12, eof: true, encoding: 'base64', data: 'eyJvayI6dHJ1ZX0=' });
      return;
    }
    reply(response, 404, { error: { code: 'NOT_FOUND', message: 'Fixture route not found' } });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(stateDir, { recursive: true, force: true });
  });
  const common = [
    '--json', '--port', String(server.address().port), '--state-dir', stateDir,
    '--agent-id', agentId, '--agent-name', agentName
  ];

  const missingIdentity = await runCli([
    'status', '--json', '--port', String(server.address().port), '--state-dir', stateDir
  ]);
  assert.equal(missingIdentity.code, 1);
  assert.equal(JSON.parse(missingIdentity.stderr).error.code, 'AGENT_ID_REQUIRED');
  assert.equal(requests.length, 0);

  const status = singleJson(await runCli(['status', ...common]));
  assert.equal(status.status.service, MANAGER_SERVICE);
  const dashboard = singleJson(await runCli(['dashboard-open', waitingTask.id, ...common]));
  assert.equal(dashboard.ok, true);
  assert.equal(dashboard.taskId, waitingTask.id);
  assert.match(dashboard.dashboardUrl, /\/dashboard\?task=task_cli#code=/u);

  const profiles = singleJson(await runCli(['profiles', 'list', ...common]));
  assert.deepEqual(profiles.profiles, [profile]);
  assert.equal(Object.hasOwn(profiles.profiles[0], 'access'), false);
  assert.equal(Object.hasOwn(profiles.profiles[0], 'createdBy'), false);
  const created = singleJson(await runCli([
    'profiles', 'create', '--name', 'Fresh CLI Profile', '--kind', 'ephemeral', ...common
  ]));
  assert.equal(created.profile.name, 'Fresh CLI Profile');
  const updated = singleJson(await runCli([
    'profiles', 'update', profile.id, '--behavior', 'human', ...common
  ]));
  assert.equal(updated.profile.defaultBehavior, 'human');
  assert.equal(singleJson(await runCli(['profiles', 'open', profile.id, ...common])).profile.state, 'open');
  assert.equal(singleJson(await runCli(['profiles', 'close', profile.id, ...common])).profile.state, 'idle');
  const deleteAttempt = await runCli(['profiles', 'delete', profile.id, ...common]);
  assert.equal(deleteAttempt.code, 1);
  assert.equal(JSON.parse(deleteAttempt.stderr).error.code, 'UNKNOWN_COMMAND');
  assert.equal(requests.some((request) => request.method === 'DELETE'), false);
  assert.equal(singleJson(await runCli(['task-types', 'list', ...common])).taskTypes[0].name, 'fixture.read');

  const started = singleJson(await runCli([
    'task', 'start', '--profile', profile.id, '--type', 'fixture.read',
    '--input', '{"url":"https://example.com/"}', '--request-key', 'cli-start-0001', ...common
  ]));
  assert.equal(started.ok, true);
  assert.equal(started.taskId, waitingTask.id);
  assert.match(started.dashboardUrl, /\/dashboard\?task=task_cli#code=/u);
  const startedRequest = requests.find((request) => request.url === '/v1/tasks' && request.method === 'POST');
  assert.deepEqual(startedRequest.body, {
    profileId: profile.id,
    taskType: 'fixture.read',
    input: { url: 'https://example.com/' },
    idempotencyKey: 'cli-start-0001'
  });

  const prepared = singleJson(await runCli([
    'task', 'prepare-scale', '--profile', profile.id,
    '--url', 'https://example.com/catalog?page=1',
    '--label', 'Probe catalog', '--request-key', 'cli-scale-probe-0001', ...common
  ]));
  assert.equal(prepared.ok, true);
  assert.equal(prepared.event, 'surface-probe-started');
  const preparedRequest = requests.find((request) => (
    request.url === '/v1/tasks' && request.body.taskType === 'surface-probe'
  ));
  assert.deepEqual(preparedRequest.body, {
    profileId: profile.id,
    taskType: 'surface-probe',
    taskLabel: 'Probe catalog',
    input: { url: 'https://example.com/catalog?page=1' },
    idempotencyKey: 'cli-scale-probe-0001'
  });

  const waited = singleJson(await runCli(['task', 'wait', waitingTask.id, '--wait-ms', '30000', ...common]));
  assert.equal(waited.timedOut, false);
  assert.equal(waited.task.state, 'waiting_user');
  assert.equal(singleJson(await runCli(['task', 'status', waitingTask.id, ...common])).task.id, waitingTask.id);
  const inbox = singleJson(await runCli(['task', 'inbox', '--limit', '5', ...common]));
  assert.equal(inbox.commands[0].commandId, 'command_cli');
  const commandResponse = singleJson(await runCli([
    'task', 'command-respond', waitingTask.id, '--command-id', 'command_cli', '--revision', '3',
    '--status', 'applied', '--message', 'Instruction accepted', ...common
  ]));
  assert.equal(commandResponse.command.status, 'applied');
  const report = singleJson(await runCli([
    'task', 'report', waitingTask.id, '--report-id', 'report_cli', '--revision', '3',
    '--status', 'final', '--title', 'CLI report', '--summary', 'Human-readable result',
    '--sections', '[{"heading":"Result","body":"Done"}]', ...common
  ]));
  assert.equal(report.report.status, 'final');
  assert.deepEqual(report.report.sections, [{ heading: 'Result', body: 'Done' }]);
  assert.deepEqual(requests.find((request) => request.url === '/v1/agent/inbox/claim').body, { limit: 5 });
  assert.deepEqual(requests.find((request) => request.url.endsWith('/commands/command_cli')).body, {
    expectedRevision: 3,
    status: 'applied',
    message: 'Instruction accepted'
  });
  assert.deepEqual(requests.find((request) => request.url.endsWith('/report')).body, {
    reportId: 'report_cli',
    expectedRevision: 3,
    status: 'final',
    title: 'CLI report',
    summary: 'Human-readable result',
    sections: [{ heading: 'Result', body: 'Done' }]
  });
  assert.equal(singleJson(await runCli([
    'task', 'continue', waitingTask.id, '--request-id', 'request_cli', '--note', 'Continue', ...common
  ])).task.state, 'running');
  assert.equal(singleJson(await runCli(['task', 'cancel', waitingTask.id, ...common])).task.state, 'cancelled');

  const artifacts = singleJson(await runCli(['artifacts', 'list', waitingTask.id, ...common]));
  assert.equal(artifacts.artifacts[0].id, 'artifact_cli');
  const artifact = singleJson(await runCli([
    'artifacts', 'read', waitingTask.id, '--artifact', 'artifact_cli', ...common
  ]));
  assert.equal(artifact.eof, true);
  assert.equal(artifact.data, 'eyJvayI6dHJ1ZX0=');

  const taskPostsBefore = requests.filter((request) => request.url === '/v1/tasks' && request.method === 'POST').length;
  const forbidden = await runCli([
    'task', 'start', '--profile', profile.id, '--type', 'fixture.read',
    '--input', '{"token":"must-not-cross"}', '--request-key', 'cli-start-0002', ...common
  ]);
  assert.equal(forbidden.code, 1);
  assert.equal(JSON.parse(forbidden.stderr).error.code, 'FORBIDDEN_TASK_INPUT');
  assert.equal(requests.filter((request) => request.url === '/v1/tasks' && request.method === 'POST').length, taskPostsBefore);

  const lowLevel = await runCli([
    'task', 'start', '--profile', profile.id, '--type', 'fixture.read', '--module', 'unsafe.mjs', ...common
  ]);
  assert.equal(lowLevel.code, 1);
  assert.equal(JSON.parse(lowLevel.stderr).error.code, 'REGISTERED_TASK_TYPE_REQUIRED');

  const missingKey = await runCli([
    'task', 'start', '--profile', profile.id, '--type', 'fixture.read', ...common
  ]);
  assert.equal(missingKey.code, 1);
  assert.equal(JSON.parse(missingKey.stderr).error.code, 'REQUEST_KEY_REQUIRED');

  const invalidFollow = await runCli([
    'task', 'follow', waitingTask.id, '--poll-ms', '0', ...common
  ]);
  assert.equal(invalidFollow.code, 1);
  assert.equal(JSON.parse(invalidFollow.stderr).error.code, 'INVALID_POLL_INTERVAL');
});

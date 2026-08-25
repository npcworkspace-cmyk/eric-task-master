import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const FIXTURE = fileURLToPath(new URL('./fixtures/stdio-server.mjs', import.meta.url));

function transport() {
  return new StdioClientTransport({
    command: process.execPath,
    args: [FIXTURE],
    stderr: 'pipe'
  });
}

async function connectedClient(mode) {
  const childTransport = transport();
  const stderr = [];
  childTransport.stderr?.on('data', (chunk) => stderr.push(chunk));
  const client = new Client(
    { name: 'taskmaster-mcp-test', version: '1.0.0' },
    { versionNegotiation: { mode, probe: { timeoutMs: 2_000 } } }
  );
  await client.connect(childTransport);
  return { client, childTransport, stderr };
}

for (const [label, mode] of [
  ['legacy', 'legacy'],
  ['modern', { pin: '2026-07-28' }]
]) {
  test(`stdio serves ${label} MCP clients without protocol noise`, async (t) => {
    const connection = await connectedClient(mode);
    t.after(() => connection.client.close());

    if (label === 'legacy') await connection.client.ping();
    const listed = await connection.client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
      'taskmaster_agent_inbox_claim',
      'taskmaster_artifacts_list',
      'taskmaster_artifacts_read',
      'taskmaster_dashboard_open',
      'taskmaster_profiles_close',
      'taskmaster_profiles_create',
      'taskmaster_profiles_list',
      'taskmaster_profiles_open',
      'taskmaster_profiles_update',
      'taskmaster_status',
      'taskmaster_task_command_respond',
      'taskmaster_task_report_publish',
      'taskmaster_task_types_describe',
      'taskmaster_task_types_list',
      'taskmaster_tasks_cancel',
      'taskmaster_tasks_continue',
      'taskmaster_tasks_get',
      'taskmaster_tasks_list',
      'taskmaster_tasks_resume',
      'taskmaster_tasks_start',
      'taskmaster_tasks_wait'
    ]);
    const start = listed.tools.find((tool) => tool.name === 'taskmaster_tasks_start');
    assert.deepEqual(start.annotations, {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true
    });
    const createProfile = listed.tools.find((tool) => tool.name === 'taskmaster_profiles_create');
    assert.deepEqual(createProfile.annotations, {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    });
    const updateProfile = listed.tools.find((tool) => tool.name === 'taskmaster_profiles_update');
    assert.deepEqual(updateProfile.annotations, {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    });
    const continueTask = listed.tools.find((tool) => tool.name === 'taskmaster_tasks_continue');
    assert.deepEqual(continueTask.annotations, {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true
    });
    assert.ok(start.inputSchema);
    assert.ok(start.outputSchema);
    assert.ok(listed.tools.find((tool) => tool.name === 'taskmaster_agent_inbox_claim')?.inputSchema);
    assert.ok(listed.tools.find((tool) => tool.name === 'taskmaster_task_command_respond')?.inputSchema);
    assert.ok(listed.tools.find((tool) => tool.name === 'taskmaster_task_report_publish')?.inputSchema);

    const result = await connection.client.callTool({ name: 'taskmaster_status', arguments: {} });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.ok, true);
    assert.equal(result.structuredContent.data.status.service, 'eric-task-master');
    assert.equal(JSON.stringify(result).includes('do-not-return'), false);
    assert.equal(connection.stderr.length, 0);
  });
}

test('MCP exposes globally shared Profiles without legacy ownership fields', async (t) => {
  const connection = await connectedClient('legacy');
  t.after(() => connection.client.close());

  const listed = await connection.client.callTool({
    name: 'taskmaster_profiles_list',
    arguments: {}
  });
  assert.equal(Object.hasOwn(listed.structuredContent.data.profiles[0], 'access'), false);
  assert.equal(Object.hasOwn(listed.structuredContent.data.profiles[0], 'createdBy'), false);

  const updated = await connection.client.callTool({
    name: 'taskmaster_profiles_update',
    arguments: { profileId: 'profile_fixture', name: 'Globally shared Profile' }
  });
  assert.equal(updated.isError, undefined);
  assert.equal(updated.structuredContent.data.profile.name, 'Globally shared Profile');
  assert.equal(Object.hasOwn(updated.structuredContent.data.profile, 'access'), false);
  assert.equal(Object.hasOwn(updated.structuredContent.data.profile, 'createdBy'), false);
  assert.equal(updated.structuredContent.data.profile.lastUsedAt, '2026-08-24T00:00:00.000Z');

  const rejected = await connection.client.callTool({
    name: 'taskmaster_profiles_update',
    arguments: { profileId: 'profile_fixture', access: 'shared' }
  });
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /Unrecognized key/u);
});

test('non-idempotent Profile creation accepts nullable timestamps without a false failure or retry', async (t) => {
  const connection = await connectedClient('legacy');
  t.after(() => connection.client.close());

  const result = await connection.client.callTool({
    name: 'taskmaster_profiles_create',
    arguments: { name: 'Nullable timestamps', kind: 'persistent', browserEngine: 'chrome' }
  });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.data.profile.lastUsedAt, null);
  assert.equal(result.structuredContent.data.profile.lastOpenedAt, null);
  assert.equal(Object.hasOwn(result.structuredContent.data.profile, 'createdBy'), false);
  assert.equal(Object.hasOwn(result.structuredContent.data.profile, 'access'), false);
});

test('Owner inbox, command response, and report publication tools expose bounded contracts', async (t) => {
  const connection = await connectedClient('legacy');
  t.after(() => connection.client.close());

  const inbox = await connection.client.callTool({
    name: 'taskmaster_agent_inbox_claim',
    arguments: { limit: 10 }
  });
  assert.equal(inbox.structuredContent.data.total, 1);
  assert.equal(inbox.structuredContent.data.commands[0].taskId, 'task_fixture');
  assert.equal(inbox.structuredContent.data.commands[0].revision, 3);
  assert.equal(inbox.structuredContent.data.commands[0].command.message, 'What should happen next?');
  assert.equal(JSON.stringify(inbox).includes('payloadHash'), false);

  const response = await connection.client.callTool({
    name: 'taskmaster_task_command_respond',
    arguments: {
      taskId: 'task_fixture',
      commandId: 'command_fixture',
      expectedRevision: 3,
      status: 'acknowledged',
      message: 'Acknowledged by fixture Agent.'
    }
  });
  assert.equal(response.structuredContent.data.task.revision, 3);
  assert.equal(response.structuredContent.data.command.status, 'acknowledged');
  assert.equal(response.structuredContent.data.command.response, 'Acknowledged by fixture Agent.');

  const report = await connection.client.callTool({
    name: 'taskmaster_task_report_publish',
    arguments: {
      taskId: 'task_fixture',
      reportId: 'report_fixture',
      expectedRevision: 3,
      status: 'final',
      title: 'Fixture report',
      summary: 'The fixture task completed its evidence review.',
      sections: [{ heading: 'Outcome', body: 'One verified fixture result.' }]
    }
  });
  assert.equal(report.structuredContent.data.task.report.status, 'final');
  assert.equal(report.structuredContent.data.task.report.title, 'Fixture report');
  assert.equal(report.structuredContent.data.task.report.sections[0].heading, 'Outcome');
});

test('stdio wire contains JSON-RPC frames only', async (t) => {
  const child = spawn(process.execPath, [FIXTURE], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'raw-wire-test', version: '1.0.0' }
    }
  })}\n`);
  await new Promise((resolveWait, rejectWait) => {
    const timer = setTimeout(() => rejectWait(new Error('stdio response timeout')), 3_000);
    child.stdout.once('data', () => {
      clearTimeout(timer);
      resolveWait();
    });
  });
  child.stdin.end();
  await once(child, 'exit');

  const lines = Buffer.concat(stdout).toString('utf8').trim().split(/\r?\n/).filter(Boolean);
  assert.ok(lines.length >= 1);
  for (const line of lines) {
    const message = JSON.parse(line);
    assert.equal(message.jsonrpc, '2.0');
  }
  assert.equal(Buffer.concat(stderr).toString('utf8'), '');
});

test('MCP rejects low-level task fields before dispatch and redacts task internals', async (t) => {
  const connection = await connectedClient('legacy');
  t.after(() => connection.client.close());

  const rejected = await connection.client.callTool({
    name: 'taskmaster_tasks_start',
    arguments: {
      taskType: 'fixture.read',
      profileId: 'profile_fixture',
      input: {},
      idempotencyKey: 'fixture-key-0001',
      modulePath: 'C:\\attack.mjs'
    }
  });
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /Unrecognized key/);

  const unsafeInput = await connection.client.callTool({
    name: 'taskmaster_tasks_start',
    arguments: {
      taskType: 'fixture.read',
      profileId: 'profile_fixture',
      input: { nested: { cookie: 'do-not-return' } },
      idempotencyKey: 'fixture-key-0002'
    }
  });
  assert.equal(unsafeInput.isError, true);
  assert.equal(JSON.stringify(unsafeInput).includes('do-not-return'), false);

  const result = await connection.client.callTool({
    name: 'taskmaster_tasks_get',
    arguments: { taskId: 'task_fixture' }
  });
  const serialized = JSON.stringify(result);
  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.data.task.cleanup.settled, false);
  assert.equal(result.structuredContent.data.task.diagnostic.kind, 'screenshot');
  assert.equal(result.structuredContent.data.task.diagnostic.artifactsAvailable, true);
  assert.equal(serialized.includes('modulePath'), false);
  assert.equal(serialized.includes('outputDir'), false);
  assert.equal(serialized.includes('managerToken'), false);
  assert.equal(serialized.includes('do-not-return'), false);
  assert.equal(serialized.includes('?token='), false);
});

test('MCP task start and explicit Dashboard open return clickable scoped links first', async (t) => {
  const connection = await connectedClient('legacy');
  t.after(() => connection.client.close());

  const started = await connection.client.callTool({
    name: 'taskmaster_tasks_start',
    arguments: {
      taskType: 'fixture.read',
      profileId: 'profile_fixture',
      input: {},
      idempotencyKey: 'dashboard-link-fixture'
    }
  });
  assert.equal(started.structuredContent.data.taskId, 'task_fixture');
  assert.equal(started.structuredContent.data.task.id, 'task_fixture');
  assert.match(started.content[0].text, /^\[打开任务面板\]\(http:\/\/127\.0\.0\.1:19946\/dashboard\?task=task_fixture#code=/u);

  const opened = await connection.client.callTool({
    name: 'taskmaster_dashboard_open',
    arguments: { taskId: 'task_fixture' }
  });
  assert.equal(opened.structuredContent.data.taskId, 'task_fixture');
  assert.match(opened.content[0].text, /^\[打开 Task Master 任务面板\]\(http:\/\/127\.0\.0\.1:19946\/dashboard\?task=task_fixture#code=/u);
});

test('artifact tools expose only explicit agent-visible bounded artifacts', async (t) => {
  const connection = await connectedClient('legacy');
  t.after(() => connection.client.close());

  const listed = await connection.client.callTool({
    name: 'taskmaster_artifacts_list',
    arguments: { taskId: 'task_fixture' }
  });
  assert.deepEqual(listed.structuredContent.data.artifacts.map((item) => item.id), ['artifact_visible']);

  const read = await connection.client.callTool({
    name: 'taskmaster_artifacts_read',
    arguments: { taskId: 'task_fixture', artifactId: 'artifact_visible', maxBytes: 16 }
  });
  assert.equal(read.structuredContent.data.chunk, 'fixture');
  assert.ok(Buffer.byteLength(JSON.stringify(read)) < 256 * 1024);
});

test('explicit resume is discoverable as an idempotent open-world operation', async (t) => {
  const connection = await connectedClient('legacy');
  t.after(() => connection.client.close());
  const result = await connection.client.callTool({
    name: 'taskmaster_tasks_resume',
    arguments: { taskId: 'task_fixture', resumeKey: 'resume-key-0001' }
  });
  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.data.task.attempt, 2);
  assert.match(result.structuredContent.data.notice, /unknown external action/i);
});

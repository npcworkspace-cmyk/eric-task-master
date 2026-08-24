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
    assert.equal(listed.tools.length, 16);
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
    const continueTask = listed.tools.find((tool) => tool.name === 'taskmaster_tasks_continue');
    assert.deepEqual(continueTask.annotations, {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true
    });
    assert.ok(start.inputSchema);
    assert.ok(start.outputSchema);

    const result = await connection.client.callTool({ name: 'taskmaster_status', arguments: {} });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.ok, true);
    assert.equal(result.structuredContent.data.status.service, 'eric-task-master');
    assert.equal(JSON.stringify(result).includes('do-not-return'), false);
    assert.equal(connection.stderr.length, 0);
  });
}

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

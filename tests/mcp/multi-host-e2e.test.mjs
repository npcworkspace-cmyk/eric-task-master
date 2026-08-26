import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const execFileAsync = promisify(execFile);
const CLI = path.resolve('src/cli.mjs');
const STDIO = path.resolve('src/mcp/stdio.mjs');
const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled']);

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function toolData(result) {
  assert.equal(result?.isError, undefined, result?.content?.[0]?.text);
  assert.equal(result?.structuredContent?.ok, true);
  return result.structuredContent.data;
}

async function connectBridge({ stateDir, port, clientId, clientName, label }) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [STDIO],
    env: {
      ...process.env,
      ERIC_TASK_MASTER_HOME: stateDir,
      ERIC_TASK_MASTER_PORT: String(port),
      ERIC_TASK_MASTER_CLIENT_ID: clientId,
      ERIC_TASK_MASTER_CLIENT_NAME: clientName
    },
    stderr: 'pipe'
  });
  const client = new Client({ name: `multi-host-e2e-${label}`, version: '1.0.0' });
  await client.connect(transport);
  assert.ok(Number.isInteger(transport.pid));
  return { client, transport, label };
}

async function call(bridge, name, args = {}) {
  return bridge.client.callTool({ name, arguments: args });
}

async function getTask(bridge, taskId) {
  return toolData(await call(bridge, 'taskmaster_tasks_get', { taskId })).task;
}

async function waitForScheduler(bridges, taskIds, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let tasks;
  do {
    const [first, queued, parallel] = await Promise.all([
      getTask(bridges.codex, taskIds.first),
      getTask(bridges.codex, taskIds.queued),
      getTask(bridges.workbuddy, taskIds.parallel)
    ]);
    tasks = { first, queued, parallel };
    if (first.state === 'running' && queued.state === 'queued' && parallel.state === 'running') {
      return tasks;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error(`Scheduler state was not observed: ${JSON.stringify({
    first: tasks?.first?.state,
    queued: tasks?.queued?.state,
    parallel: tasks?.parallel?.state
  })}`);
}

async function waitForTerminal(bridge, taskId, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let task;
  do {
    const waitMs = Math.min(30_000, Math.max(0, deadline - Date.now()));
    task = toolData(await call(bridge, 'taskmaster_tasks_wait', { taskId, waitMs })).task;
    if (TERMINAL_STATES.has(task.state)) return task;
  } while (Date.now() < deadline);
  throw new Error(`Task ${taskId} did not become terminal; last state=${task?.state}`);
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (processAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(processAlive(pid), false, `Process ${pid} did not exit`);
}

async function portOpen(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(250);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function waitForPortClosed(port, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (await portOpen(port)) {
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(await portOpen(port), false, `Port ${port} is still listening`);
}

async function windowsListenerPids(port) {
  const { stdout } = await execFileAsync('netstat.exe', ['-ano', '-p', 'tcp'], {
    windowsHide: true,
    timeout: 15_000
  });
  const expected = `127.0.0.1:${port}`;
  return stdout.split(/\r?\n/u)
    .map((line) => line.trim().split(/\s+/u))
    .filter((parts) => (
      parts.length >= 5 &&
      parts[0] === 'TCP' &&
      parts[1] === expected &&
      parts[3] === 'LISTENING'
    ))
    .map((parts) => Number(parts[4]));
}

test('multiple host STDIO bridges reuse one Manager with scoped durable work', {
  skip: process.env.TASKMASTER_REAL_BROWSER !== '1',
  timeout: 120_000
}, async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'taskmaster-multi-host-e2e-'));
  const profilesRoot = path.join(stateDir, 'profiles');
  const port = await unusedPort();
  const installationId = randomUUID();
  const clientIds = {
    codex: `${installationId}:codex`,
    workbuddy: `${installationId}:workbuddy`,
    hermes: `${installationId}:hermes`
  };
  const bridges = [];
  const bridgePids = new Set();
  let managerPid = null;

  try {
    const [codex, workbuddyOne, workbuddyTwo, hermes] = await Promise.all([
      connectBridge({
        stateDir, port, clientId: clientIds.codex, clientName: 'Codex E2E', label: 'codex'
      }),
      connectBridge({
        stateDir, port, clientId: clientIds.workbuddy, clientName: 'WorkBuddy E2E', label: 'workbuddy-1'
      }),
      connectBridge({
        stateDir, port, clientId: clientIds.workbuddy, clientName: 'WorkBuddy E2E', label: 'workbuddy-2'
      }),
      connectBridge({
        stateDir, port, clientId: clientIds.hermes, clientName: 'Hermes E2E', label: 'hermes'
      })
    ]);
    bridges.push(codex, workbuddyOne, workbuddyTwo, hermes);
    for (const bridge of bridges) bridgePids.add(bridge.transport.pid);
    assert.equal(bridgePids.size, 4);

    await Promise.all(bridges.map(async (bridge) => {
      const tools = await bridge.client.listTools();
      assert.ok(tools.tools.some((tool) => tool.name === 'taskmaster_status'));
      const status = toolData(await call(bridge, 'taskmaster_status')).status;
      assert.equal(status.service, 'eric-task-master');
    }));

    const managerRecord = JSON.parse(await readFile(path.join(stateDir, 'manager.json'), 'utf8'));
    managerPid = managerRecord.pid;
    assert.equal(managerRecord.baseUrl, `http://127.0.0.1:${port}`);
    assert.equal(await portOpen(port), true);
    if (process.platform === 'win32') {
      assert.deepEqual(await windowsListenerPids(port), [managerPid]);
    }

    const registry = JSON.parse(await readFile(path.join(stateDir, 'agents.json'), 'utf8'));
    const workbuddyRecord = registry.agents.find((agent) => agent.clientId === clientIds.workbuddy);
    const codexRecord = registry.agents.find((agent) => agent.clientId === clientIds.codex);
    assert.equal(new Set(Object.values(clientIds)).size, 3);
    assert.ok(Object.values(clientIds).every((clientId) => clientId.startsWith(`${installationId}:`)));
    assert.equal(workbuddyRecord.connections.length, 2);
    assert.equal(new Set(workbuddyRecord.connections.map((connection) => connection.id)).size, 2);
    assert.equal(codexRecord.connections.length, 1);
    const firstCodexConnectionId = codexRecord.connections[0].id;

    const profileInput = {
      kind: 'ephemeral',
      browserEngine: 'chromium',
      defaultBehavior: 'fast',
      headless: true
    };
    const firstProfile = toolData(await call(codex, 'taskmaster_profiles_create', {
      ...profileInput,
      name: 'Multi-host FIFO Profile'
    })).profile;
    const secondProfile = toolData(await call(workbuddyOne, 'taskmaster_profiles_create', {
      ...profileInput,
      name: 'Multi-host parallel Profile'
    })).profile;
    await Promise.all(bridges.map(async (bridge) => {
      const profiles = toolData(await call(bridge, 'taskmaster_profiles_list')).profiles;
      assert.ok(profiles.some((profile) => profile.id === firstProfile.id));
      assert.ok(profiles.some((profile) => profile.id === secondProfile.id));
    }));

    const first = toolData(await call(codex, 'taskmaster_tasks_start', {
      taskType: 'durable-delay',
      profileId: firstProfile.id,
      input: { steps: 24, delayMs: 150 },
      idempotencyKey: 'multi-host-first-0001'
    }));
    const parallel = toolData(await call(workbuddyOne, 'taskmaster_tasks_start', {
      taskType: 'durable-delay',
      profileId: secondProfile.id,
      input: { steps: 24, delayMs: 150 },
      idempotencyKey: 'multi-host-parallel-0001'
    }));
    const queued = toolData(await call(codex, 'taskmaster_tasks_start', {
      taskType: 'durable-delay',
      profileId: firstProfile.id,
      input: { steps: 2, delayMs: 50 },
      idempotencyKey: 'multi-host-queued-0001'
    }));

    assert.equal(toolData(await call(hermes, 'taskmaster_tasks_list', { limit: 20 })).tasks.length, 0);
    assert.equal((await call(hermes, 'taskmaster_tasks_get', { taskId: first.taskId })).isError, true);
    const firstWorkbuddyLedger = toolData(
      await call(workbuddyOne, 'taskmaster_tasks_list', { limit: 20 })
    ).tasks.map((task) => task.id);
    const secondWorkbuddyLedger = toolData(
      await call(workbuddyTwo, 'taskmaster_tasks_list', { limit: 20 })
    ).tasks.map((task) => task.id);
    assert.deepEqual(secondWorkbuddyLedger, firstWorkbuddyLedger);

    const scheduler = await waitForScheduler(
      { codex, workbuddy: workbuddyOne },
      { first: first.taskId, queued: queued.taskId, parallel: parallel.taskId }
    );
    assert.equal(scheduler.queued.queuePosition, 1);

    const config = JSON.parse(await readFile(path.join(stateDir, 'config.json'), 'utf8'));
    const commandResponse = await fetch(
      `http://127.0.0.1:${port}/v1/tasks/${encodeURIComponent(queued.taskId)}/commands`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.managerToken}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          commandId: 'multi-host-owner-ask-0001',
          expectedRevision: scheduler.queued.revision,
          kind: 'ask',
          message: 'Reconnect ownership probe'
        })
      }
    );
    assert.equal(commandResponse.status, 202, await commandResponse.text());
    assert.equal(toolData(
      await call(workbuddyOne, 'taskmaster_agent_inbox_claim', { limit: 20 })
    ).total, 0);
    assert.equal(toolData(
      await call(hermes, 'taskmaster_agent_inbox_claim', { limit: 20 })
    ).total, 0);

    const beforeDisconnect = await getTask(codex, first.taskId);
    assert.equal(beforeDisconnect.state, 'running');
    const firstCodexPid = codex.transport.pid;
    await codex.client.close();
    await waitForProcessExit(firstCodexPid);

    const reconnectedCodex = await connectBridge({
      stateDir,
      port,
      clientId: clientIds.codex,
      clientName: 'Codex E2E',
      label: 'codex-reconnected'
    });
    bridges.push(reconnectedCodex);
    bridgePids.add(reconnectedCodex.transport.pid);
    assert.notEqual(reconnectedCodex.transport.pid, firstCodexPid);

    const recoveredLedger = toolData(
      await call(reconnectedCodex, 'taskmaster_tasks_list', { limit: 20 })
    ).tasks;
    const recoveredFirst = recoveredLedger.find((task) => task.id === first.taskId);
    assert.ok(recoveredFirst);
    assert.ok(recoveredFirst.progress.current >= beforeDisconnect.progress.current);
    assert.ok(recoveredLedger.some((task) => task.id === queued.taskId));
    const recoveredInbox = toolData(
      await call(reconnectedCodex, 'taskmaster_agent_inbox_claim', { limit: 20 })
    );
    assert.equal(recoveredInbox.total, 1);
    assert.equal(recoveredInbox.commands[0].command.commandId, 'multi-host-owner-ask-0001');

    const reconnectedRegistry = JSON.parse(await readFile(path.join(stateDir, 'agents.json'), 'utf8'));
    const reconnectedRecord = reconnectedRegistry.agents.find(
      (agent) => agent.clientId === clientIds.codex
    );
    assert.ok(reconnectedRecord.connections.some(
      (connection) => connection.id !== firstCodexConnectionId
    ));

    const [firstDone, queuedDone, parallelDone] = await Promise.all([
      waitForTerminal(reconnectedCodex, first.taskId),
      waitForTerminal(reconnectedCodex, queued.taskId),
      waitForTerminal(workbuddyTwo, parallel.taskId)
    ]);
    for (const task of [firstDone, queuedDone, parallelDone]) {
      assert.equal(task.state, 'completed');
      assert.equal(task.cleanup.settled, true);
    }
    assert.ok(Date.parse(queuedDone.finishedAt) >= Date.parse(firstDone.finishedAt));

    const ownerArtifacts = toolData(
      await call(reconnectedCodex, 'taskmaster_artifacts_list', { taskId: first.taskId })
    ).artifacts;
    assert.deepEqual(ownerArtifacts.map((artifact) => artifact.name), ['durable-delay.json']);
    assert.equal((await call(hermes, 'taskmaster_artifacts_list', {
      taskId: first.taskId
    })).isError, true);
  } finally {
    await Promise.allSettled(bridges.map((bridge) => bridge.client.close()));
    await Promise.all([...bridgePids].map((pid) => waitForProcessExit(pid)));

    let record = null;
    try {
      record = JSON.parse(await readFile(path.join(stateDir, 'manager.json'), 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (record) {
      managerPid ??= record.pid;
      const { stdout } = await execFileAsync(process.execPath, [
        CLI,
        'manager',
        'stop',
        '--state-dir', stateDir,
        '--port', String(port),
        '--json'
      ], { windowsHide: true, timeout: 30_000 });
      assert.equal(JSON.parse(stdout.trim()).ok, true);
    }

    if (managerPid) await waitForProcessExit(managerPid);
    await waitForPortClosed(port);
    await rm(stateDir, { recursive: true, force: true });
    await assert.rejects(access(stateDir), (error) => error?.code === 'ENOENT');
    await assert.rejects(access(profilesRoot), (error) => error?.code === 'ENOENT');
  }
});

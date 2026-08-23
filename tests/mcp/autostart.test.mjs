import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createDefaultTaskMasterClient } from '../../src/mcp/taskmaster-client.mjs';

const execFileAsync = promisify(execFile);
const CLI = path.resolve('src/cli.mjs');
const STDIO = path.resolve('src/mcp/stdio.mjs');

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

test('independent MCP clients cold-start exactly one durable Manager', async (t) => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'taskmaster-mcp-autostart-'));
  const port = await unusedPort();
  let started = false;
  t.after(async () => {
    if (started) {
      await execFileAsync(process.execPath, [
        CLI,
        'manager',
        'stop',
        '--state-dir', stateDir,
        '--port', String(port),
        '--json'
      ], { windowsHide: true, timeout: 15_000 }).catch(() => {});
    }
    await rm(stateDir, { recursive: true, force: true });
  });

  const clients = Array.from({ length: 4 }, (_, index) => createDefaultTaskMasterClient({
    ERIC_TASK_MASTER_HOME: stateDir,
    ERIC_TASK_MASTER_PORT: String(port),
    ERIC_TASK_MASTER_CLIENT_ID: `autostart.fixture.${index}`,
    ERIC_TASK_MASTER_CLIENT_NAME: `Autostart fixture ${index}`
  }));
  const statuses = await Promise.all(clients.map((client) => client.getStatus()));
  started = true;
  assert.ok(statuses.every((status) => status.service === 'eric-task-master'));
  assert.equal(new Set(statuses.map((status) => status.pid)).size, 1);

  const record = JSON.parse(await readFile(path.join(stateDir, 'manager.json'), 'utf8'));
  assert.equal(record.pid, statuses[0].pid);
  assert.equal(record.baseUrl, `http://127.0.0.1:${port}`);

  const later = createDefaultTaskMasterClient({
    ERIC_TASK_MASTER_HOME: stateDir,
    ERIC_TASK_MASTER_PORT: String(port),
    ERIC_TASK_MASTER_CLIENT_ID: 'autostart.fixture.later'
  });
  assert.equal((await later.getStatus()).pid, record.pid);
});

test('the registered STDIO entrypoint cold-starts Manager before its first tool call', async (t) => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'taskmaster-stdio-autostart-'));
  const port = await unusedPort();
  let managerStarted = false;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [STDIO],
    env: {
      ...process.env,
      ERIC_TASK_MASTER_HOME: stateDir,
      ERIC_TASK_MASTER_PORT: String(port),
      ERIC_TASK_MASTER_CLIENT_ID: 'stdio.autostart.fixture',
      ERIC_TASK_MASTER_CLIENT_NAME: 'STDIO autostart fixture'
    },
    stderr: 'pipe'
  });
  const stderr = [];
  transport.stderr?.on('data', (chunk) => stderr.push(chunk));
  const client = new Client({ name: 'stdio-autostart-test', version: '1.0.0' });
  t.after(async () => {
    await client.close().catch(() => {});
    if (managerStarted) {
      await execFileAsync(process.execPath, [
        CLI,
        'manager',
        'stop',
        '--state-dir', stateDir,
        '--port', String(port),
        '--json'
      ], { windowsHide: true, timeout: 15_000 }).catch(() => {});
    }
    await rm(stateDir, { recursive: true, force: true });
  });

  await client.connect(transport);
  const result = await client.callTool({ name: 'taskmaster_status', arguments: {} });
  managerStarted = true;
  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.data.status.service, 'eric-task-master');
  assert.equal(Buffer.concat(stderr).toString('utf8'), '');
});

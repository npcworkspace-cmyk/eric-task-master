import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createManager } from '../../src/manager.mjs';
import { HttpTaskMasterClient } from '../../src/mcp/taskmaster-client.mjs';

test('HTTP client matches the scoped Manager task and artifact APIs', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'taskmaster-mcp-manager-'));
  const dashboardDir = join(root, 'dashboard');
  await mkdir(dashboardDir);
  await writeFile(join(dashboardDir, 'index.html'), '<!doctype html><title>fixture</title>');
  const calls = [];
  const taskService = {
    async listTaskTypes(filters, caller) {
      calls.push(['types', caller, filters]);
      return { taskTypes: [{ name: 'fixture.read', sha256: 'a'.repeat(64), size: 100 }] };
    },
    async describeTaskType(name) {
      return { id: name, name, inputSchema: { type: 'object' } };
    },
    async list(options) {
      calls.push(['list', options]);
      return { tasks: [], nextCursor: null };
    },
    async create(input, caller) {
      calls.push(['create', input, caller]);
      return {
        id: `task_${'1'.repeat(32)}`,
        profileId: input.profileId,
        taskType: input.taskType,
        state: 'queued'
      };
    },
    async get(id) { return { id, state: 'running' }; },
    async resume(id, body, caller) {
      calls.push(['resume', id, body, caller]);
      return { id, state: 'queued', attempt: 2 };
    },
    async cancel(id) { return { id, state: 'cancelled' }; },
    async listArtifacts(id, caller) {
      calls.push(['artifacts', id, caller]);
      return [];
    },
    async readArtifact() {
      throw Object.assign(new Error('Artifact was not found'), { code: 'ARTIFACT_NOT_FOUND', statusCode: 404 });
    },
    async openProfile() {},
    async closeProfile() {},
    async importSession() {},
    async close() {}
  };
  const manager = await createManager({
    port: 0,
    dataDir: join(root, 'data'),
    dashboardDir,
    taskService
  });
  await manager.start();
  t.after(async () => {
    await manager.stop().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  const client = new HttpTaskMasterClient({
    baseUrl: manager.baseUrl,
    stateDir: manager.dataDir,
    clientId: 'mcp.manager.fixture',
    clientName: 'MCP Manager fixture'
  });
  const status = await client.getStatus();
  assert.equal(status.service, 'eric-task-master');

  const taskTypes = await client.listTaskTypes();
  assert.equal(taskTypes[0].name, 'fixture.read');
  assert.equal(calls.find((entry) => entry[0] === 'types')[1].clientId, 'mcp.manager.fixture');

  const task = await client.startTask({
    profileId: 'profile_fixture',
    taskType: 'fixture.read',
    input: { url: 'https://example.com/' },
    idempotencyKey: 'mcp-manager-fixture-1'
  });
  assert.equal(task.taskType, 'fixture.read');
  assert.equal(calls.find((entry) => entry[0] === 'create')[2].clientId, 'mcp.manager.fixture');

  const resumed = await client.resumeTask({ taskId: task.id, resumeKey: 'resume-manager-1' });
  assert.equal(resumed.task.attempt, 2);
  assert.equal(calls.find((entry) => entry[0] === 'resume')[3].clientId, 'mcp.manager.fixture');
  assert.match(resumed.notice, /unknown/i);

  assert.deepEqual(await client.listArtifacts(task.id), []);
  assert.equal(calls.find((entry) => entry[0] === 'artifacts')[2].clientId, 'mcp.manager.fixture');
});

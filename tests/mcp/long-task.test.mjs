import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createManager } from '../../src/manager.mjs';
import { HttpTaskMasterClient } from '../../src/mcp/taskmaster-client.mjs';
import { createTaskService } from '../../src/runtime/task-service.mjs';

async function waitForTask(client, taskId, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let result;
  do {
    const waitMs = Math.min(30_000, Math.max(0, deadline - Date.now()));
    result = await client.waitTask(taskId, { waitMs });
    if (!result.timedOut) return result;
  } while (Date.now() < deadline);
  return result;
}

test('a real long browser task survives MCP client replacement and exposes bounded artifacts', {
  skip: process.env.TASKMASTER_REAL_BROWSER !== '1'
}, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'taskmaster-mcp-long-task-'));
  const dashboard = path.join(root, 'dashboard');
  await mkdir(dashboard);
  await writeFile(path.join(dashboard, 'index.html'), '<!doctype html><title>fixture</title>');
  const manager = await createManager({
    port: 0,
    dataDir: path.join(root, 'data'),
    dashboardDir: dashboard,
    taskServiceFactory(taskOptions) {
      return createTaskService(taskOptions);
    }
  });
  await manager.start();
  t.after(async () => {
    await manager.stop().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  const options = {
    baseUrl: manager.baseUrl,
    stateDir: manager.dataDir,
    clientId: 'long-task.agent',
    clientName: 'Long task agent'
  };
  const firstClient = new HttpTaskMasterClient(options);
  const profile = await firstClient.createProfile({
    name: 'Long task fixture',
    kind: 'ephemeral',
    defaultBehavior: 'adaptive',
    headless: true
  });
  const started = await firstClient.startTask({
    profileId: profile.id,
    taskType: 'durable-delay',
    input: { steps: 8, delayMs: 100 },
    idempotencyKey: 'long-task-reconnect-0001'
  });

  const replacementClient = new HttpTaskMasterClient(options);
  const waited = await waitForTask(replacementClient, started.taskId);
  assert.equal(waited.timedOut, false);
  assert.equal(waited.task.state, 'completed');
  assert.equal(waited.task.progress.current, 8);
  assert.equal(waited.task.cleanup.settled, true);

  const artifacts = await replacementClient.listArtifacts(started.taskId);
  assert.deepEqual(artifacts.map((artifact) => artifact.name), ['durable-delay.json']);
  const content = await replacementClient.readArtifact({
    taskId: started.taskId,
    artifactId: artifacts[0].id,
    maxBytes: 48 * 1024
  });
  assert.equal(content.encoding, 'utf8');
  assert.equal(content.eof, true);
  assert.equal(JSON.parse(content.chunk).events.length, 8);

  await manager.profileStore.remove(profile.id);
});

test('different Profiles run concurrently while same-Profile work queues safely', {
  skip: process.env.TASKMASTER_REAL_BROWSER !== '1'
}, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'taskmaster-mcp-profile-isolation-'));
  const dashboard = path.join(root, 'dashboard');
  await mkdir(dashboard);
  await writeFile(path.join(dashboard, 'index.html'), '<!doctype html><title>fixture</title>');
  const manager = await createManager({
    port: 0,
    dataDir: path.join(root, 'data'),
    dashboardDir: dashboard,
    taskServiceFactory(taskOptions) {
      return createTaskService(taskOptions);
    }
  });
  await manager.start();
  t.after(async () => {
    await manager.stop().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  const client = new HttpTaskMasterClient({
    baseUrl: manager.baseUrl,
    stateDir: manager.dataDir,
    clientId: 'parallel.agent'
  });
  const [leftProfile, rightProfile] = await Promise.all([
    client.createProfile({
      name: 'Parallel left',
      kind: 'ephemeral',
      browserEngine: 'chromium',
      defaultBehavior: 'adaptive',
      headless: true
    }),
    client.createProfile({
      name: 'Parallel right',
      kind: 'ephemeral',
      browserEngine: 'chromium',
      defaultBehavior: 'adaptive',
      headless: true
    })
  ]);
  const [left, right] = await Promise.all([
    client.startTask({
      profileId: leftProfile.id,
      taskType: 'durable-delay',
      input: { steps: 10, delayMs: 150 },
      idempotencyKey: 'parallel-left-0001'
    }),
    client.startTask({
      profileId: rightProfile.id,
      taskType: 'durable-delay',
      input: { steps: 10, delayMs: 150 },
      idempotencyKey: 'parallel-right-0001'
    })
  ]);
  const collision = await client.startTask({
    profileId: leftProfile.id,
    taskType: 'durable-delay',
    input: { steps: 1, delayMs: 10 },
    idempotencyKey: 'parallel-collision-0001'
  });

  const [leftDone, rightDone, collisionDone] = await Promise.all([
    waitForTask(client, left.taskId),
    waitForTask(client, right.taskId),
    waitForTask(client, collision.taskId)
  ]);
  assert.equal(leftDone.timedOut, false);
  assert.equal(rightDone.timedOut, false);
  assert.equal(collisionDone.timedOut, false);
  assert.equal(leftDone.task.state, 'completed');
  assert.equal(rightDone.task.state, 'completed');
  assert.equal(collisionDone.task.state, 'completed');
  assert.equal(collisionDone.task.cleanup.settled, true);

  await manager.profileStore.remove(leftProfile.id);
  await manager.profileStore.remove(rightProfile.id);
});

test('a real Playwright action failure returns its diagnostic screenshot through artifacts', {
  skip: process.env.TASKMASTER_REAL_BROWSER !== '1'
}, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'taskmaster-mcp-diagnostic-'));
  const dashboard = path.join(root, 'dashboard');
  const modulePath = path.join(root, 'diagnostic-task.mjs');
  await mkdir(dashboard);
  await writeFile(path.join(dashboard, 'index.html'), '<!doctype html><title>fixture</title>');
  await writeFile(modulePath, [
    'export const meta = { name: "diagnostic-fixture", inputSchema: { type: "object", additionalProperties: false } };',
    'export async function run({ action }) {',
    '  await action.click("#element-that-does-not-exist", { timeout: 250 });',
    '  return { summary: "unexpected", evidence: [] };',
    '}',
    ''
  ].join('\n'));
  const manager = await createManager({
    port: 0,
    dataDir: path.join(root, 'data'),
    dashboardDir: dashboard,
    allowedTaskRoots: [path.resolve('.'), root],
    taskServiceFactory(taskOptions) {
      return createTaskService(taskOptions);
    }
  });
  await manager.start();
  t.after(async () => {
    await manager.stop().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  await manager.taskService.installTaskType(
    { name: 'diagnostic-fixture', modulePath },
    { role: 'manager-admin', clientId: 'manager-admin' }
  );
  const client = new HttpTaskMasterClient({
    baseUrl: manager.baseUrl,
    stateDir: manager.dataDir,
    clientId: 'diagnostic.agent'
  });
  const profile = await client.createProfile({
    name: 'Diagnostic Profile',
    kind: 'ephemeral',
    defaultBehavior: 'fast',
    headless: true
  });
  const task = await client.startTask({
    profileId: profile.id,
    taskType: 'diagnostic-fixture',
    input: {},
    idempotencyKey: 'diagnostic-action-failure-0001'
  });
  const terminal = await client.waitTask(task.taskId, { waitMs: 15_000 });
  assert.equal(terminal.task.state, 'failed');
  assert.equal(terminal.task.cleanup.settled, true);
  assert.equal(terminal.task.error.code, 'ACTION_FAILED');
  assert.equal(typeof terminal.task.lastScreenshot?.ref, 'string');
  assert.equal(typeof terminal.task.lastObservation?.ref, 'string');

  const artifacts = await client.listArtifacts(task.taskId);
  assert.deepEqual(new Set(artifacts.map((artifact) => artifact.kind)), new Set([
    'diagnostic-screenshot',
    'diagnostic-observation'
  ]));
  const screenshotArtifact = artifacts.find((artifact) => artifact.kind === 'diagnostic-screenshot');
  assert.equal(screenshotArtifact.mimeType, 'image/jpeg');
  const screenshot = await client.readArtifact({
    taskId: task.taskId,
    artifactId: screenshotArtifact.id,
    maxBytes: 48 * 1024
  });
  assert.equal(screenshot.encoding, 'base64');
  assert.equal(screenshot.eof, true);
  const screenshotBytes = Buffer.from(screenshot.chunk, 'base64');
  assert.ok(screenshotBytes.byteLength > 100);
  assert.ok(screenshotBytes.byteLength <= 48 * 1024);
  assert.deepEqual([...screenshotBytes.subarray(0, 2)], [0xff, 0xd8]);
  await manager.profileStore.remove(profile.id);
});

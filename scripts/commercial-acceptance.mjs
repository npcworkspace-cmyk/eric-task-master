#!/usr/bin/env node
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startManager } from '../src/manager.mjs';
import { HttpTaskMasterClient } from '../src/mcp/taskmaster-client.mjs';
import { createTaskService } from '../src/runtime/task-service.mjs';
import { TERMINAL_TASK_STATES, VERSION } from '../src/contracts.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT_ID = 'commercial.acceptance.agent';
const COMMERCIAL_QUEUE_WAIT_MS = 240_000;
const COMMERCIAL_BROWSER_TASK_TIMEOUT_MS = 180_000;

async function fixtureServer() {
  const html = await readFile(path.join(ROOT, 'test', 'fixtures', 'acceptance.html'));
  const server = createServer((request, response) => {
    if (request.url === '/' || request.url?.startsWith('/?')) {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      response.end(html);
      return;
    }
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('not found');
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
    })
  };
}

async function waitFor(getValue, predicate, timeoutMs = COMMERCIAL_QUEUE_WAIT_MS, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  let value;
  while (Date.now() < deadline) {
    value = await getValue();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const lastState = typeof value?.state === 'string' ? `, lastState=${value.state}` : '';
  const cleanup = value?.cleanup?.settled === true ? ', cleanup=settled' : ', cleanup=unsettled';
  const errorCode = value?.error?.code ? `, error=${value.error.code}` : '';
  throw Object.assign(new Error(
    `Commercial acceptance ${label} timed out after ${timeoutMs}ms${lastState}${cleanup}${errorCode}`
  ), {
    code: 'COMMERCIAL_ACCEPTANCE_TIMEOUT', value
  });
}

async function waitTerminal(client, taskId, timeoutMs = COMMERCIAL_QUEUE_WAIT_MS) {
  return waitFor(
    () => client.getTask(taskId),
    (task) => TERMINAL_TASK_STATES.has(task.state) && task.cleanup?.settled === true,
    timeoutMs,
    `task ${taskId} terminal cleanup`
  );
}

async function readAcceptanceReport(client, taskId) {
  const artifacts = await client.listArtifacts(taskId);
  const reportArtifact = artifacts.find((artifact) => artifact.name === 'acceptance.json');
  if (!reportArtifact) {
    throw Object.assign(new Error(`Acceptance report is missing for ${taskId}`), {
      code: 'COMMERCIAL_ACCEPTANCE_ARTIFACT_MISSING'
    });
  }
  const content = await client.readArtifact({
    taskId,
    artifactId: reportArtifact.id,
    maxBytes: 48 * 1024
  });
  if (content.encoding !== 'utf8' || content.eof !== true || typeof content.chunk !== 'string') {
    throw Object.assign(new Error(`Acceptance report is not one bounded UTF-8 artifact for ${taskId}`), {
      code: 'COMMERCIAL_ACCEPTANCE_ARTIFACT_INVALID'
    });
  }
  return JSON.parse(content.chunk);
}

function assertCheck(checks, name, condition, detail) {
  const passed = Boolean(condition);
  checks.push({ name, passed, ...(detail ? { detail } : {}) });
  if (!passed) {
    throw Object.assign(new Error(`${name}${detail ? `: ${detail}` : ''}`), {
      code: 'COMMERCIAL_ACCEPTANCE_FAILED'
    });
  }
}

async function createRuntime(dataDir) {
  return startManager({
    host: '127.0.0.1',
    port: 0,
    dataDir,
    dashboardDir: path.join(ROOT, 'dashboard'),
    taskServiceFactory(options) {
      return createTaskService({ ...options, maxConcurrentTasks: 3, maxQueuedTasks: 64 });
    }
  });
}

export async function runCommercialAcceptance() {
  const persistentEngine = process.env.TASKMASTER_ACCEPTANCE_PERSISTENT_ENGINE || 'chromium';
  if (!['chrome', 'chromium'].includes(persistentEngine)) {
    throw Object.assign(new Error(
      'TASKMASTER_ACCEPTANCE_PERSISTENT_ENGINE must be chrome or chromium'
    ), { code: 'COMMERCIAL_ACCEPTANCE_ENGINE_INVALID' });
  }
  const root = await mkdtemp(path.join(tmpdir(), 'eric-task-master-commercial-'));
  const dataDir = path.join(root, 'data');
  const checks = [];
  const taskIds = [];
  let manager;
  let client;
  let fixture;
  let persistentProfile;
  try {
    fixture = await fixtureServer();
    manager = await createRuntime(dataDir);
    client = new HttpTaskMasterClient({
      baseUrl: manager.baseUrl,
      stateDir: manager.dataDir,
      clientId: CLIENT_ID,
      clientName: 'Commercial acceptance agent'
    });
    persistentProfile = await client.createProfile({
      name: 'Commercial persistent lifecycle',
      kind: 'persistent',
      browserEngine: persistentEngine,
      headless: true
    });
    assertCheck(
      checks,
      'persistent Profile uses the requested immutable engine',
      persistentProfile.browserEngine === persistentEngine,
      persistentProfile.browserEngine
    );
    const uploadPath = path.join(ROOT, 'test', 'fixtures', 'upload.txt');
    const seeded = await client.startTask({
      profileId: persistentProfile.id,
      taskType: 'acceptance',
      input: { url: fixture.url, uploadPath },
      timeoutMs: COMMERCIAL_BROWSER_TASK_TIMEOUT_MS,
      idempotencyKey: `commercial-persistent-seed-${Date.now()}`
    });
    taskIds.push(seeded.taskId);
    const seededDone = await waitTerminal(client, seeded.taskId);
    assertCheck(
      checks,
      'persistent Profile seed task completes',
      seededDone.state === 'completed',
      JSON.stringify({ state: seededDone.state, error: seededDone.error })
    );
    const seededReport = await readAcceptanceReport(client, seeded.taskId);
    assertCheck(
      checks,
      'persistent Profile writes reusable browser state',
      seededDone.state === 'completed' && seededDone.behavior === 'human' &&
        seededReport.passed === true &&
        seededReport.evidence?.some((item) => item.kind === 'cookie' && item.ok) &&
        seededReport.evidence?.some((item) => item.kind === 'localStorage' && item.ok)
    );

    const openedManualProfile = await client.openProfile(persistentProfile.id);
    assertCheck(
      checks,
      'persistent Profile opens through Playwright without an extension',
      openedManualProfile.state === 'open'
    );
    const closedManualProfile = await client.closeProfile(persistentProfile.id);
    assertCheck(
      checks,
      'persistent Profile close confirms cleanup and releases its lease',
      closedManualProfile.state === 'idle'
    );

    const profiles = await Promise.all(Array.from({ length: 3 }, (_, index) => client.createProfile({
      name: `Commercial ephemeral ${index + 1}`,
      kind: 'ephemeral',
      defaultBehavior: 'auto',
      headless: true
    })));
    assertCheck(checks, 'three isolated ephemeral Profiles', profiles.every((profile) => profile.kind === 'ephemeral'));

    const started = await Promise.all(profiles.flatMap((profile, profileIndex) => (
      Array.from({ length: 4 }, (_, taskIndex) => client.startTask({
        profileId: profile.id,
        taskType: 'durable-delay',
        input: { steps: 3, delayMs: 40 },
        timeoutMs: 30_000,
        idempotencyKey: `commercial-${profileIndex}-${taskIndex}-${Date.now()}`
      }))
    )));
    taskIds.push(...started.map((item) => item.taskId));
    let maxActive = 0;
    let maxQueued = 0;
    const monitor = setInterval(() => {
      void client.getStatus().then((status) => {
        maxActive = Math.max(maxActive, Number(status.counts?.active) || 0);
        maxQueued = Math.max(maxQueued, Number(status.counts?.queued) || 0);
      }).catch(() => {});
    }, 50);
    const completed = await Promise.all(started.map((item) => waitTerminal(client, item.taskId)));
    clearInterval(monitor);
    const finalStatus = await client.getStatus();
    maxActive = Math.max(maxActive, Number(finalStatus.counts?.active) || 0);
    maxQueued = Math.max(maxQueued, Number(finalStatus.counts?.queued) || 0);
    assertCheck(checks, 'queued multi-Profile soak completes', completed.every((task) => task.state === 'completed'));
    assertCheck(checks, 'scheduler concurrency budget', maxActive <= 3, `observed ${maxActive}/3 active`);
    assertCheck(checks, 'same-Profile work entered the queue', maxQueued > 0, `observed queue peak ${maxQueued}`);

    const blocker = await client.startTask({
      profileId: profiles[0].id,
      taskType: 'durable-delay',
      input: { steps: 12, delayMs: 100 },
      timeoutMs: 30_000,
      idempotencyKey: `commercial-cancel-blocker-${Date.now()}`
    });
    const queued = await client.startTask({
      profileId: profiles[0].id,
      taskType: 'durable-delay',
      input: { steps: 1, delayMs: 20 },
      timeoutMs: 30_000,
      idempotencyKey: `commercial-cancel-queued-${Date.now()}`
    });
    taskIds.push(blocker.taskId, queued.taskId);
    await waitFor(
      () => client.getTask(queued.taskId),
      (task) => task.state === 'queued',
      COMMERCIAL_QUEUE_WAIT_MS,
      `task ${queued.taskId} queue entry`
    );
    const cancelled = await client.cancelTask(queued.taskId);
    const cancelledDone = await waitTerminal(client, queued.taskId);
    const blockerDone = await waitTerminal(client, blocker.taskId);
    assertCheck(
      checks,
      'queued cancellation is deterministic',
      cancelled.state === 'cancelled' && cancelledDone.state === 'cancelled' && blockerDone.state === 'completed'
    );

    const timed = await client.startTask({
      profileId: profiles[1].id,
      taskType: 'durable-delay',
      // Keep the task deadline long enough for a cold Chromium start on every
      // supported runner, then exceed it inside the running page so screenshot
      // and semantic timeout diagnostics are meaningfully testable.
      input: { steps: 120, delayMs: 100 },
      timeoutMs: 10_000,
      idempotencyKey: `commercial-timeout-${Date.now()}`
    });
    taskIds.push(timed.taskId);
    const timedDone = await waitTerminal(client, timed.taskId);
    const diagnostics = await client.listArtifacts(timed.taskId);
    assertCheck(
      checks,
      'timeout closes browser and publishes diagnostics',
      timedDone.state === 'failed' &&
        timedDone.error?.code === 'TASK_TIMEOUT' &&
        timedDone.cleanup?.browserClosed === true &&
        diagnostics.some((artifact) => artifact.kind === 'diagnostic-screenshot') &&
        diagnostics.some((artifact) => artifact.kind === 'diagnostic-observation'),
      JSON.stringify({
        state: timedDone.state,
        errorCode: timedDone.error?.code,
        browserClosed: timedDone.cleanup?.browserClosed,
        artifactKinds: diagnostics.map((artifact) => artifact.kind)
      })
    );

    const profileRootsAreEmpty = (await Promise.all(profiles.map(async (profile) => (
      (await readdir(path.join(dataDir, 'profiles', profile.id))).length === 0
    )))).every(Boolean);
    assertCheck(checks, 'ephemeral Profiles persist no browser state', profileRootsAreEmpty);
    const quiescent = await client.getStatus();
    assertCheck(
      checks,
      'runtime returns to quiescent state',
      quiescent.counts?.active === 0 && quiescent.counts?.queued === 0 && quiescent.counts?.stalled === 0
    );

    for (const profile of profiles) await manager.profileStore.remove(profile.id);
    await manager.stop();
    manager = null;

    manager = await createRuntime(dataDir);
    client = new HttpTaskMasterClient({
      baseUrl: manager.baseUrl,
      stateDir: manager.dataDir,
      clientId: CLIENT_ID,
      clientName: 'Commercial acceptance agent after restart'
    });
    const retained = await client.startTask({
      profileId: persistentProfile.id,
      taskType: 'acceptance',
      input: { url: fixture.url, uploadPath, expectExistingState: true },
      timeoutMs: COMMERCIAL_BROWSER_TASK_TIMEOUT_MS,
      idempotencyKey: `commercial-persistent-retained-${Date.now()}`
    });
    taskIds.push(retained.taskId);
    const retainedDone = await waitTerminal(client, retained.taskId);
    assertCheck(
      checks,
      'persistent Profile retained-state task completes',
      retainedDone.state === 'completed',
      JSON.stringify({ state: retainedDone.state, error: retainedDone.error })
    );
    const retainedReport = await readAcceptanceReport(client, retained.taskId);
    assertCheck(
      checks,
      'persistent browser state survives manual open-close and Manager restart',
      retainedDone.state === 'completed' && retainedDone.behavior === 'human' &&
        retainedReport.evidence?.some((item) => item.kind === 'persistent-state-existing' && item.ok)
    );
    const persisted = await client.listTasks({ limit: 100 });
    const persistedIds = new Set(persisted.tasks.map((task) => task.id));
    assertCheck(
      checks,
      'terminal task history survives Manager restart',
      taskIds.every((id) => persistedIds.has(id)) && persisted.tasks.every((task) => task.cleanup?.settled === true)
    );
    await manager.profileStore.remove(persistentProfile.id);
    persistentProfile = null;

    return {
      ok: true,
      version: VERSION,
      passed: checks.length,
      total: checks.length,
      checks,
      workload: {
        taskCount: taskIds.length,
        maxActive,
        maxQueued,
        persistentEngine,
        managerRestarted: true
      },
      checkedAt: new Date().toISOString()
    };
  } finally {
    if (persistentProfile?.id && manager) {
      await client?.closeProfile(persistentProfile.id).catch(() => {});
      await manager.profileStore.remove(persistentProfile.id).catch(() => {});
    }
    await manager?.stop().catch(() => {});
    await fixture?.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runCommercialAcceptance();
    if (process.env.TASKMASTER_COMMERCIAL_REPORT) {
      const reportPath = path.resolve(process.env.TASKMASTER_COMMERCIAL_REPORT);
      await mkdir(path.dirname(reportPath), { recursive: true });
      await writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      version: VERSION,
      error: { code: error.code || 'COMMERCIAL_ACCEPTANCE_FAILED', message: error.message }
    })}\n`);
    process.exitCode = 1;
  }
}

#!/usr/bin/env node
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startManager } from '../src/manager.mjs';
import { HttpTaskMasterClient } from '../src/mcp/taskmaster-client.mjs';
import { createTaskService } from '../src/runtime/task-service.mjs';
import { TERMINAL_TASK_STATES, VERSION } from '../src/contracts.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT_ID = 'commercial.acceptance.agent';

async function waitFor(getValue, predicate, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let value;
  while (Date.now() < deadline) {
    value = await getValue();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw Object.assign(new Error('Commercial acceptance wait timed out'), {
    code: 'COMMERCIAL_ACCEPTANCE_TIMEOUT', value
  });
}

async function waitTerminal(client, taskId, timeoutMs = 60_000) {
  return waitFor(
    () => client.getTask(taskId),
    (task) => TERMINAL_TASK_STATES.has(task.state) && task.cleanup?.settled === true,
    timeoutMs
  );
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
  const root = await mkdtemp(path.join(tmpdir(), 'eric-task-master-commercial-'));
  const dataDir = path.join(root, 'data');
  const checks = [];
  const taskIds = [];
  let manager;
  try {
    manager = await createRuntime(dataDir);
    let client = new HttpTaskMasterClient({
      baseUrl: manager.baseUrl,
      stateDir: manager.dataDir,
      clientId: CLIENT_ID,
      clientName: 'Commercial acceptance agent'
    });
    const profiles = await Promise.all(Array.from({ length: 3 }, (_, index) => client.createProfile({
      name: `Commercial ephemeral ${index + 1}`,
      kind: 'ephemeral',
      defaultBehavior: 'adaptive',
      headless: true
    })));
    assertCheck(checks, 'three isolated ephemeral Profiles', profiles.every((profile) => profile.kind === 'ephemeral'));

    const started = await Promise.all(profiles.flatMap((profile, profileIndex) => (
      Array.from({ length: 4 }, (_, taskIndex) => client.startTask({
        profileId: profile.id,
        taskType: 'durable-delay',
        behavior: 'adaptive',
        input: { steps: 3, delayMs: 40 },
        timeoutMs: 30_000,
        idempotencyKey: `commercial-${profileIndex}-${taskIndex}-${Date.now()}`
      }))
    )));
    taskIds.push(...started.map((task) => task.id));
    let maxActive = 0;
    let maxQueued = 0;
    const monitor = setInterval(() => {
      void client.getStatus().then((status) => {
        maxActive = Math.max(maxActive, Number(status.counts?.active) || 0);
        maxQueued = Math.max(maxQueued, Number(status.counts?.queued) || 0);
      }).catch(() => {});
    }, 50);
    const completed = await Promise.all(started.map((task) => waitTerminal(client, task.id)));
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
    taskIds.push(blocker.id, queued.id);
    await waitFor(() => client.getTask(queued.id), (task) => task.state === 'queued');
    const cancelled = await client.cancelTask(queued.id);
    const cancelledDone = await waitTerminal(client, queued.id);
    const blockerDone = await waitTerminal(client, blocker.id);
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
    taskIds.push(timed.id);
    const timedDone = await waitTerminal(client, timed.id);
    const diagnostics = await client.listArtifacts(timed.id);
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
    const persisted = await client.listTasks({ limit: 100 });
    const persistedIds = new Set(persisted.tasks.map((task) => task.id));
    assertCheck(
      checks,
      'terminal task history survives Manager restart',
      taskIds.every((id) => persistedIds.has(id)) && persisted.tasks.every((task) => task.cleanup?.settled === true)
    );

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
        managerRestarted: true
      },
      checkedAt: new Date().toISOString()
    };
  } finally {
    await manager?.stop().catch(() => {});
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

#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../src/contracts.mjs';
import { validateManagerIdentity } from '../src/lib/manager-identity.mjs';
import { startManager } from '../src/manager.mjs';
import { HttpTaskMasterClient } from '../src/mcp/taskmaster-client.mjs';
import {
  createStateBackup,
  restoreStateBackup,
  verifyStateBackup
} from '../src/operations/state-backup.mjs';
import { createTaskService } from '../src/runtime/task-service.mjs';

const CLIENT_ID = 'backup.restore.drill.agent';
const WAIT_TIMEOUT_MS = 60_000;

async function waitFor(read, predicate, label) {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw Object.assign(new Error(`Backup restore drill timed out waiting for ${label}`), {
    code: 'BACKUP_RESTORE_DRILL_TIMEOUT',
    state: last?.state
  });
}

async function createClient(manager) {
  return new HttpTaskMasterClient({
    baseUrl: manager.baseUrl,
    stateDir: manager.dataDir,
    clientId: CLIENT_ID,
    clientName: 'Backup restore drill agent'
  });
}

async function createRuntime(stateDir) {
  return startManager({
    host: '127.0.0.1',
    port: 0,
    dataDir: stateDir,
    taskServiceFactory(options) {
      return createTaskService({ ...options, maxConcurrentTasks: 1, maxQueuedTasks: 4 });
    }
  });
}

export async function runBackupRestoreDrill() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'eric-task-master-restore-drill-'));
  const stateDir = path.join(root, 'state');
  const backupDir = path.join(root, 'backup');
  let manager;
  let taskId;
  let profileId;
  const checks = [];
  try {
    manager = await createRuntime(stateDir);
    let client = await createClient(manager);
    const profile = await client.createProfile({
      name: 'Restore drill persistent Profile',
      kind: 'persistent',
      browserEngine: 'chromium',
      headless: true
    });
    profileId = profile.id;
    const started = await client.startTask({
      profileId,
      taskType: 'durable-delay',
      taskLabel: 'Backup restore checkpoint drill',
      input: { steps: 20, delayMs: 250 },
      timeoutMs: 30_000,
      idempotencyKey: `restore-drill-${Date.now()}`
    });
    taskId = started.taskId;
    await waitFor(
      () => client.getTask(taskId),
      (task) => task.state === 'running' && Number(task.progress?.current) >= 1,
      'a durable checkpoint'
    );
    await manager.stop();
    manager = null;

    const configBefore = JSON.parse(await readFile(path.join(stateDir, 'config.json'), 'utf8'));
    const identityBefore = validateManagerIdentity(configBefore.managerIdentity);
    const taskBefore = JSON.parse(await readFile(path.join(stateDir, 'tasks', taskId, 'task.json'), 'utf8'));
    const checkpointBefore = JSON.parse(await readFile(path.join(stateDir, 'tasks', taskId, 'checkpoint.json'), 'utf8'));
    assert.equal(taskBefore.state, 'failed');
    assert.equal(taskBefore.cleanup?.settled, true);
    assert.equal(taskBefore.resumeCheckpointValid, true);
    assert.equal(checkpointBefore.taskId, taskId);
    await writeFile(
      path.join(stateDir, 'profiles', profileId, 'restore-drill-marker.json'),
      `${JSON.stringify({ profileId, marker: 'preserve-profile-state' })}\n`,
      { mode: 0o600 }
    );
    checks.push('quiescent resumable checkpoint created');

    const backup = await createStateBackup({ sourceDir: stateDir, backupDir });
    await verifyStateBackup({ backupDir });
    checks.push('backup manifest and every payload hash verified');

    const resolvedRoot = path.resolve(root);
    const resolvedState = path.resolve(stateDir);
    assert.equal(path.dirname(resolvedState), resolvedRoot);
    await rm(resolvedState, { recursive: true, force: false, maxRetries: 5, retryDelay: 50 });
    await restoreStateBackup({ backupDir, destinationDir: stateDir });
    checks.push('isolated source deleted and restored to its original absolute path');

    const configAfter = JSON.parse(await readFile(path.join(stateDir, 'config.json'), 'utf8'));
    const identityAfter = validateManagerIdentity(configAfter.managerIdentity);
    assert.deepEqual(identityAfter, identityBefore);
    const marker = JSON.parse(await readFile(
      path.join(stateDir, 'profiles', profileId, 'restore-drill-marker.json'),
      'utf8'
    ));
    assert.equal(marker.profileId, profileId);
    checks.push('Manager Ed25519 identity and persistent Profile bytes preserved');

    manager = await createRuntime(stateDir);
    client = await createClient(manager);
    const restoredProfile = await manager.profileStore.get(profileId);
    const restoredTask = await manager.taskService.getInternal(taskId);
    assert.equal(restoredProfile.state, 'idle');
    assert.equal(restoredProfile.lease, null);
    assert.equal(restoredTask.state, 'failed');
    assert.equal(restoredTask.resumeCheckpointValid, true);
    assert.equal(restoredTask.checkpoint?.sha256, taskBefore.checkpoint?.sha256);
    checks.push('restored Manager loads the Profile lease and sealed checkpoint');

    await client.resumeTask({ taskId, resumeKey: `restore-resume-${Date.now()}` });
    const completed = await waitFor(
      () => client.getTask(taskId),
      (task) => task.state === 'completed' && task.cleanup?.settled === true,
      'resumed task completion and cleanup'
    );
    assert.equal(completed.state, 'completed');
    checks.push('restored checkpoint resumes through the real Worker and settles cleanup');

    await manager.stop();
    manager = null;
    const result = {
      ok: true,
      version: VERSION,
      schemaVersion: 1,
      backupId: backup.backupId,
      fileCount: backup.fileCount,
      totalBytes: backup.totalBytes,
      checks: checks.map((name) => ({ name, passed: true })),
      passed: checks.length,
      total: checks.length,
      checkedAt: new Date().toISOString()
    };
    return result;
  } finally {
    await manager?.stop().catch(() => {});
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runBackupRestoreDrill();
    const reportPath = process.env.TASKMASTER_BACKUP_RESTORE_REPORT;
    if (reportPath) {
      const resolvedReport = path.resolve(reportPath);
      await mkdir(path.dirname(resolvedReport), { recursive: true, mode: 0o700 });
      await writeFile(resolvedReport, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      version: VERSION,
      error: { code: error.code || 'BACKUP_RESTORE_DRILL_FAILED', message: error.message }
    })}\n`);
    process.exitCode = 1;
  }
}

#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { createOperationsHarness, ROOT, CLI, pause } from '../test-v3/fixtures/fast-operations/harness.mjs';
import { websiteBatch, SIMULATED_SELECTORS as S } from '../src/runtime/operations-workflows.mjs';
import { isProcessAlive, probeChromeProfileUsage, terminateProcessTree } from '../src/lib/process-tree.mjs';

const execFile = promisify(execFileCallback);
const outputDir = path.resolve(process.env.TASKMASTER_RECOVERY_OUTPUT || process.argv[2] || path.join(ROOT, 'outputs', 'fast-recovery'));
const runDir = path.join(outputDir, `run-${Date.now()}-${randomUUID().slice(0, 8)}`);
const stateDir = path.join(runDir, 'isolated-state');
const checks = []; const ownership = []; const crashes = []; const evidence = [];
let harness; let failure; let cleanup; let latestManager;
const samePath = (left, right) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
const within = (root, target) => { const relative = path.relative(root, target); return relative && !relative.startsWith('..') && !path.isAbsolute(relative); };
const record = (name, detail = {}) => { const check = { name, passed: true, at: new Date().toISOString(), ...detail }; checks.push(check); process.stdout.write(`${JSON.stringify({ check: name, passed: true })}\n`); };
async function waitUntil(check, label, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await pause(400); }
  throw new Error(`Timed out waiting for ${label}`);
}
async function managerProof() {
  const manager = await harness.managerMetadata();
  assert.equal(manager.scope, 'project');
  assert.ok(samePath(manager.stateDirEffective, harness.stateDir), 'Manager must prove this exact fresh isolated state');
  assert.ok(Number.isSafeInteger(manager.pid) && manager.pid > 0 && manager.pid !== process.pid);
  const lock = JSON.parse(await readFile(path.join(harness.stateDir, '.manager.lock'), 'utf8'));
  assert.equal(lock.pid, manager.pid);
  latestManager = manager;
  if (!ownership.some((entry) => entry.pid === manager.pid)) ownership.push({ kind: 'manager', pid: manager.pid, stateDir: manager.stateDirEffective, observedAt: new Date().toISOString(), lockNonce: lock.nonce });
  return manager;
}
async function workerProof(operationId) {
  const operation = await harness.cli(['ops', 'get', operationId]);
  const store = JSON.parse(await readFile(path.join(harness.stateDir, 'tasks', 'tasks.json'), 'utf8'));
  const task = store.tasks.find((item) => item.id === operation.taskId);
  assert.ok(task && task.profileId === harness.profile.id && task.builtin === 'fast-operations');
  assert.ok(within(path.join(harness.stateDir, 'tasks'), task.outputDir));
  assert.ok(Number.isSafeInteger(task.workerPid) && task.workerPid > 0 && task.workerPid !== process.pid);
  assert.notEqual(task.workerPid, latestManager.pid);
  const proof = { kind: 'worker', pid: task.workerPid, taskId: task.id, operationId, profileId: task.profileId, outputDir: task.outputDir, observedAt: new Date().toISOString() };
  ownership.push(proof); return proof;
}
async function profileIdle() {
  return waitUntil(async () => {
    const profile = (await harness.cli(['profiles', 'list'])).profiles.find((item) => item.id === harness.profile.id);
    return profile && profile.state === 'idle' && !profile.lease ? profile : false;
  }, 'owned Profile lease quarantine to expire and recover (not bypassed)', 100000);
}
async function snapshot(label, operationId) {
  const operation = await harness.cli(['ops', 'get', operationId]);
  const events = await harness.cli(['ops', 'events', operationId]);
  const fixture = await harness.state();
  const value = { label, at: new Date().toISOString(), operation, events, fixture: { config: fixture.config, effects: fixture.effects } };
  evidence.push(value); return value;
}

await mkdir(runDir, { recursive: true });
try {
  harness = await createOperationsHarness({ outputDir: runDir, label: `recovery-${Date.now()}` });
  await managerProof();
  await harness.cli(['profiles', 'mode', harness.profile.id, '--mode', 'batch']);
  const site = await harness.start('site', { mode: 'operations' });
  assert.equal(site.mode, 'operations');
  assert.equal((await harness.cli(['profiles', 'list'])).profiles.find((profile) => profile.id === harness.profile.id).modePolicy, 'batch');
  assert.equal((await harness.navigate(site.id, `${harness.fixture.origin}/site`)).status, 'confirmed');
  assert.equal((await harness.observe(site.id, { scope: '#domain' })).status, 'confirmed');
  record('prompt operations overrides Profile batch default for this task; same task remains resident after navigation', { operationId: site.id, taskId: site.taskId, profileDefault: 'batch', actualMode: site.mode });

  await harness.control({ disconnectAfterSubmit: true });
  const observation = await harness.observe(site.id);
  const nextValue = `recovered-value-${Date.now()}`;
  const batch = websiteBatch({ decision: { approved: true, id: 'recovery-submit', reason: 'Explicit isolated crash-recovery test decision' }, selectors: S.site,
    record: { accountId: 'account-1', domain: 'example.test', resourceId: 'config-1', before: (await harness.state()).config, rollback: 'Restore the preserved before value' }, nextValue });
  assert.equal((await harness.command(site.id, 'batch', batch, { pageId: observation.pageId, pageVersion: observation.pageVersion })).status, 'unknown');
  const beforeCrash = await snapshot('submit persisted externally but response disconnected', site.id);
  assert.equal(beforeCrash.fixture.config, nextValue);
  const effectsBeforeCrash = beforeCrash.fixture.effects.length;
  const uncertainIds = beforeCrash.operation.actions.filter((action) => ['initiated', 'unknown'].includes(action.status)).map((action) => action.actionId);
  assert.ok(uncertainIds.length > 0);
  const manager = await managerProof(); const worker = await workerProof(site.id);
  // Exact current PID, matching private lock and unique state; never a shared Manager/tree kill.
  process.kill(manager.pid, 'SIGKILL');
  crashes.push({ kind: 'manager', pid: manager.pid, taskId: worker.taskId, at: new Date().toISOString(), method: 'SIGKILL exact verified isolated Manager PID' });
  await waitUntil(() => !isProcessAlive(manager.pid), 'crashed isolated Manager exit', 15000);
  await waitUntil(() => !isProcessAlive(worker.pid), 'worker observes Manager IPC loss and closes its owned browser', 30000);
  const restarted = await harness.cli(['manager', 'start']);
  await managerProof(); assert.notEqual(latestManager.pid, manager.pid); assert.equal(restarted.manager.pid, latestManager.pid);
  const afterRestart = await snapshot('Manager restarted; uncertain actions retained without replay', site.id);
  assert.equal(afterRestart.operation.status, 'reconcile-required'); assert.equal(afterRestart.fixture.effects.length, effectsBeforeCrash);
  const rejected = await harness.cli(['ops', 'command', site.id, '--input', JSON.stringify({ commandId: 'forbidden-replay-after-crash', kind: 'batch', payload: batch })], { expectedFailure: true });
  assert.ok(['OPERATION_NOT_RUNNING', 'RECONCILIATION_REQUIRED'].includes(rejected.error?.code));
  assert.equal((await harness.state()).effects.length, effectsBeforeCrash);
  record('actual Manager crash/restart retains pending safety evidence and blocks mutation replay', { killedPid: manager.pid, restartedPid: latestManager.pid, uncertainActionIds: uncertainIds, externalEffectCount: effectsBeforeCrash });

  await harness.control({ disconnectAfterSubmit: false });
  await profileIdle();
  const readback = await harness.command(site.id, 'reconcile', { url: `${harness.fixture.origin}/site`, actionIds: uncertainIds,
    verify: [{ target: { selector: '#current-value' }, text: nextValue }, { target: { selector: '#saved' }, text: 'saved' }] });
  assert.equal(readback.status, 'confirmed');
  const reconciled = await snapshot('new worker read-only GET reconciliation confirms prior effect', site.id);
  await workerProof(site.id);
  assert.notEqual(reconciled.operation.taskId, site.taskId); assert.equal(reconciled.operation.status, 'running');
  assert.ok(uncertainIds.every((id) => reconciled.operation.actions.find((action) => action.actionId === id)?.status === 'confirmed'));
  assert.equal(reconciled.fixture.effects.length, effectsBeforeCrash);
  record('new Worker reads actual resource after restart and resolves unknown effects without another external submission', { previousTaskId: site.taskId, recoveredTaskId: reconciled.operation.taskId, externalEffectCount: effectsBeforeCrash });
  await harness.stop(site.id); await profileIdle();

  await harness.cli(['profiles', 'mode', harness.profile.id, '--mode', 'auto']);
  const idle = await harness.start('social', { mode: 'auto', skillMode: 'operations', intent: 'finite' });
  assert.equal(idle.mode, 'operations');
  assert.equal((await harness.navigate(idle.id, `${harness.fixture.origin}/social`)).status, 'confirmed');
  const idleWorker = await workerProof(idle.id); const managerBeforeWorkerCrash = await managerProof();
  // Kill only this proven task's process tree, including its isolated Chrome; no global image-name kill.
  assert.equal(await terminateProcessTree(idleWorker.pid, { graceMs: 10000 }), true);
  crashes.push({ kind: 'worker', pid: idleWorker.pid, taskId: idleWorker.taskId, at: new Date().toISOString(), method: 'terminate exact verified isolated Worker process tree' });
  await waitUntil(() => !isProcessAlive(idleWorker.pid), 'crashed Worker exit', 15000);
  await profileIdle();
  assert.equal((await managerProof()).pid, managerBeforeWorkerCrash.pid, 'Worker crash must not restart or kill Manager');
  await harness.cli(['ops', 'resume', idle.id]);
  await harness.waitOperation(idle.id, (operation) => operation.pending === null && operation.task?.state === 'waiting');
  const resumedIdle = await harness.cli(['ops', 'get', idle.id]); assert.notEqual(resumedIdle.taskId, idle.taskId);
  await workerProof(idle.id);
  const fresh = await harness.observe(idle.id); assert.equal(fresh.status, 'confirmed');
  assert.equal((await harness.navigate(idle.id, `${harness.fixture.origin}/social`)).status, 'confirmed');
  await snapshot('idle Worker crash followed by explicit resume and fresh observation', idle.id);
  record('actual Worker crash keeps Manager alive; no-unknown session resumes explicitly with a fresh page observation', { crashedWorkerPid: idleWorker.pid, oldTaskId: idle.taskId, newTaskId: resumedIdle.taskId });
  await harness.stop(idle.id); await profileIdle();

  const finite = await harness.start('social', { mode: 'batch', commandLimit: 1 });
  await workerProof(finite.id);
  const finiteObservation = await harness.observe(finite.id); assert.equal(finiteObservation.status, 'confirmed');
  assert.equal((await harness.cli(['ops', 'get', finite.id])).task.state, 'waiting', 'Read-only observation must not terminate a finite batch before its actual group');
  assert.equal((await harness.navigate(finite.id, `${harness.fixture.origin}/social`)).status, 'confirmed');
  const finished = await harness.waitOperation(finite.id, (operation) => operation.task?.state === 'finished');
  assert.equal(finished.mode, 'batch'); assert.equal(finished.task.result.completedBatches, 1);
  assert.equal((await harness.cli(['profiles', 'list'])).profiles.find((profile) => profile.id === harness.profile.id).modePolicy, 'auto');
  await snapshot('finite batch completed and worker finished', finite.id);
  record('batch stays open through observations then actually finishes after its finite action group; Profile auto is unchanged', { taskId: finite.taskId, finalTaskState: finished.task.state, completedBatches: finished.task.result.completedBatches });
} catch (error) {
  failure = { code: error.code || 'FAST_RECOVERY_ACCEPTANCE_FAILED', message: error.message, stack: error.stack };
} finally {
  if (harness) {
    const result = await harness.finish().catch((error) => ({ ok: false, errors: [{ scope: 'harness-cleanup', message: error.message }] }));
    const profilePath = path.join(harness.stateDir, 'profiles', harness.profile.id);
    const profileUsage = await probeChromeProfileUsage(profilePath).catch(() => 'unknown');
    const processes = ownership.map((entry) => ({ ...entry, aliveAfterCleanup: isProcessAlive(entry.pid) }));
    cleanup = { ...result, profileUsage, processes, sharedManagerTouched: false, statePreserved: true, pathsPreserved: [harness.stateDir, path.join(runDir, 'fixture-state.json')] };
    cleanup.ok = result.ok === true && profileUsage === 'inactive' && processes.every((entry) => !entry.aliveAfterCleanup);
  } else {
    // The freshly generated state directory belongs solely to this script, even if harness startup failed.
    try { await execFile(process.execPath, [CLI, 'manager', 'stop', '--state-dir', stateDir, '--json'], { cwd: ROOT, windowsHide: true, timeout: 45000, env: { ...process.env, ERIC_TASK_MASTER_HOME: stateDir, ERIC_TASK_MASTER_PORT: '', NODE_OPTIONS: '' } }); cleanup = { ok: true, partialStartupStopped: true, sharedManagerTouched: false, statePreserved: true }; }
    catch (error) { cleanup = { ok: false, sharedManagerTouched: false, error: error.message }; }
  }
}
let revision = 'unavailable';
try { revision = (await execFile('git', ['rev-parse', 'HEAD'], { cwd: ROOT, windowsHide: true })).stdout.trim(); } catch { /* Preserve explicit unavailable provenance */ }
const report = { ok: !failure && cleanup?.ok === true, checkedAt: new Date().toISOString(), revision, sourceDirty: true, runDir, stateDir, checks, ownership, crashes, evidence, cleanup,
  boundary: { tested: 'real isolated Task Master CLI/Manager/Worker/Chrome and persistent local HTTP fixture', installedManagerModified: false, realAccountsTouched: false, real24HourSoak: 'separate gate', nativeHostWakeup: 'not claimed' }, ...(failure ? { error: failure } : {}) };
await mkdir(outputDir, { recursive: true });
await writeFile(path.join(outputDir, 'recovery-report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
process.stdout.write(`${JSON.stringify({ ok: report.ok, reportPath: path.join(outputDir, 'recovery-report.json'), checks: checks.length, cleanup: cleanup?.ok, ...(failure ? { error: failure } : {}) })}\n`);
if (!report.ok) process.exitCode = 1;

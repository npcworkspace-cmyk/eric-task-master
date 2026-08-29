import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTaskService } from '../src/runtime/task-service.mjs';

const AGENT_A = Object.freeze({ role: 'agent', clientId: 'agent.durability.a' });
const AGENT_B = Object.freeze({ role: 'agent', clientId: 'agent.durability.b' });
const ADMIN = Object.freeze({ role: 'manager-admin', clientId: 'manager-admin' });
let nextPid = 70_000;

class FakeWorker extends EventEmitter {
  constructor(onSend) {
    super();
    this.pid = nextPid += 1;
    this.connected = true;
    this.exitCode = null;
    this.onSend = onSend;
  }

  send(message, _handle, _options, callback) {
    this.onSend?.(message, this);
    callback?.();
  }

  finish(code = 0, signal = null) {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.connected = false;
    this.emit('exit', code, signal);
  }

  kill(signal = 'SIGTERM') {
    this.finish(0, signal);
    return true;
  }
}

function fakeProfiles(root) {
  const profile = {
    id: 'profile_durable',
    name: 'Durable',
    userDataDir: path.join(root, 'profile'),
    defaultBehavior: 'fast',
    browserEngine: 'chromium',
    headless: true,
    state: 'idle',
    lease: null
  };
  return {
    profile,
    async get(id) {
      if (id !== profile.id) throw new Error('profile not found');
      return structuredClone(profile);
    },
    async acquireLease(id, ownerId, options) {
      if (id !== profile.id) throw new Error('profile not found');
      if (profile.lease && profile.lease.ownerId !== ownerId) throw new Error('profile is leased');
      profile.lease = { ownerId, pid: options.pid };
      profile.state = 'leased';
      return structuredClone(profile);
    },
    async releaseLease(id, ownerId) {
      if (id !== profile.id) throw new Error('profile not found');
      if (profile.lease?.ownerId !== ownerId) return false;
      profile.lease = null;
      profile.state = 'idle';
      return true;
    }
  };
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition not reached');
}

async function installTaskType({ root, stateDir, profiles, moduleSource }) {
  const allowed = path.join(root, 'allowed');
  await mkdir(allowed, { recursive: true });
  const modulePath = path.join(allowed, 'durability.mjs');
  await writeFile(modulePath, moduleSource);
  const bootstrap = createTaskService({
    stateDir,
    profileStore: profiles,
    allowedTaskRoots: [allowed],
    seedTaskTypes: [],
    workerFactory() { throw new Error('bootstrap must not start a worker'); }
  });
  await bootstrap.installTaskType({ name: 'durability', modulePath }, ADMIN);
  await bootstrap.close();
  const registry = JSON.parse(await readFile(path.join(path.dirname(stateDir), 'task-types.json'), 'utf8'));
  const record = registry.types.find((item) => item.name === 'durability');
  return {
    allowed,
    snapshotPath: path.join(path.dirname(stateDir), 'task-types', record.snapshotName),
    sha256: record.sha256
  };
}

test('Manager restart recovers a durable checkpoint without its lost IPC pointer', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-resume-restart-'));
  const stateDir = path.join(root, 'state', 'tasks');
  const profiles = fakeProfiles(root);
  const installed = await installTaskType({
    root,
    stateDir,
    profiles,
    moduleSource: 'export const meta = { supportsResume: true }; export async function run() { return { summary: "unused", evidence: [{ kind: "message", value: "unused" }] }; }\n'
  });
  const id = `task_${'a'.repeat(32)}`;
  const taskRoot = path.join(stateDir, id);
  const outputDir = path.join(taskRoot, 'output');
  const checkpointPath = path.join(taskRoot, 'checkpoint.json');
  const savedAt = '2026-08-24T01:02:03.000Z';
  await mkdir(outputDir, { recursive: true });
  await writeFile(checkpointPath, `${JSON.stringify({ taskId: id, attempt: 1, savedAt, data: { next: 2 } })}\n`);
  await writeFile(path.join(taskRoot, 'task.json'), `${JSON.stringify({
    id,
    profileId: profiles.profile.id,
    taskType: 'durability',
    taskTypeSha256: installed.sha256,
    supportsResume: true,
    modulePath: installed.snapshotPath,
    ownerClientId: AGENT_A.clientId,
    idempotencyKey: 'restart-original-0001',
    requestHash: 'b'.repeat(64),
    behavior: 'fast',
    input: { marker: 'preserved-input' },
    timeoutMs: 12_345,
    attempt: 1,
    history: [{ attempt: 1, resumed: false, startedAt: '2026-08-24T01:00:00.000Z' }],
    state: 'running',
    progress: { current: 1, total: 3, message: 'Before restart' },
    heartbeatAt: '2026-08-24T01:00:01.000Z',
    outputDir,
    // checkpoint.json was committed, but Manager crashed before its IPC pointer
    // could be persisted into task.json.
    checkpoint: null,
    result: null,
    error: null,
    cleanup: { browserClosed: false, leaseReleased: false, workerExited: false, settled: false },
    createdAt: '2026-08-24T01:00:00.000Z',
    updatedAt: '2026-08-24T01:00:01.000Z',
    startedAt: '2026-08-24T01:00:00.000Z',
    finishedAt: null,
    workerPid: 999_999,
    leaseOwner: `task:${id}`,
    leaseHeld: true
  }, null, 2)}\n`);
  profiles.profile.lease = {
    ownerId: `task:${id}`,
    pid: 999_999,
    expiresAt: '2099-01-01T00:00:00.000Z'
  };
  profiles.profile.state = 'leased';

  let starts = 0;
  let interruptedWorkerAlive = true;
  const service = createTaskService({
    stateDir,
    profileStore: profiles,
    allowedTaskRoots: [installed.allowed],
    seedTaskTypes: [],
    processAlive: (pid) => pid === 999_999 && interruptedWorkerAlive,
    workerFactory(_workerPath, kind) {
      assert.equal(kind, 'task');
      return new FakeWorker((message, child) => {
        if (message.type !== 'start') return;
        starts += 1;
        assert.equal(message.config.taskId, id);
        assert.equal(message.config.modulePath, installed.snapshotPath);
        assert.deepEqual(message.config.input, { marker: 'preserved-input' });
        assert.equal(message.config.timeoutMs, 12_345);
        assert.equal(message.config.outputDir, outputDir);
        assert.equal(message.config.checkpointPath, checkpointPath);
        setImmediate(() => void (async () => {
          await writeFile(path.join(outputDir, 'resumed.json'), '{"ok":true}\n');
          child.emit('message', {
            type: 'result',
            result: {
              summary: 'Resumed from checkpoint',
              evidence: [{ kind: 'artifact', file: 'resumed.json', agentVisible: true }]
            }
          });
          child.emit('message', { type: 'state', state: 'completed' });
          child.emit('message', { type: 'cleanup', browserClosed: true });
          child.finish();
        })());
      });
    }
  });
  t.after(async () => {
    await service.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  const interrupted = await service.get(id, AGENT_A);
  assert.equal(interrupted.state, 'failed');
  assert.equal(interrupted.error.code, 'TASK_INTERRUPTED_BY_MANAGER_RESTART');
  assert.equal(interrupted.cleanup.settled, false);
  assert.equal(interrupted.resumeAvailable, false);
  assert.equal(profiles.profile.lease.ownerId, `task:${id}`);
  assert.equal('input' in interrupted, false);
  await assert.rejects(service.resume(id, { resumeKey: 'resume-restart-0001' }, AGENT_B), { code: 'TASK_NOT_FOUND' });

  interruptedWorkerAlive = false;
  await assert.rejects(
    service.resume(id, { resumeKey: 'resume-unconfirmed-0001' }, AGENT_A),
    { code: 'TASK_CLEANUP_NOT_SETTLED' }
  );
  assert.equal(profiles.profile.lease.ownerId, `task:${id}`);
  await writeFile(path.join(taskRoot, 'cleanup-attempt-1.json'), `${JSON.stringify({
    version: 1,
    kind: 'task',
    taskId: id,
    attempt: 1,
    workerPid: 999_999,
    closedAt: new Date().toISOString(),
    checkpoint: {
      attempt: 1,
      savedAt,
      sha256: createHash('sha256').update(await readFile(checkpointPath)).digest('hex'),
      sizeBytes: (await readFile(checkpointPath)).byteLength
    }
  })}\n`);

  const [first, replay] = await Promise.all([
    service.resume(id, { resumeKey: 'resume-restart-0001' }, AGENT_A),
    service.resume(id, { resumeKey: 'resume-restart-0001' }, AGENT_A)
  ]);
  assert.equal(first.id, id);
  assert.equal(replay.id, id);
  assert.equal(first.attempt, 2);
  assert.equal(starts, 1);
  assert.equal(JSON.stringify(replay).includes('resume-restart-0001'), false);
  assert.equal(JSON.stringify(replay).includes('preserved-input'), false);
  assert.equal(JSON.stringify(replay).includes(installed.snapshotPath), false);

  const completed = await waitFor(async () => {
    const task = await service.get(id, AGENT_A);
    return task.state === 'completed' && task.cleanup.settled ? task : null;
  });
  assert.equal(completed.attempt, 2);
  assert.deepEqual(completed.history.map((entry) => [entry.attempt, entry.state]), [
    [1, 'failed'],
    [2, 'completed']
  ]);
  assert.equal(completed.cleanup.browserClosed, true);
  assert.equal(completed.cleanup.leaseReleased, true);
  assert.equal(profiles.profile.lease, null);
  const completedInternal = await service.getInternal(id);
  assert.equal(completedInternal.checkpoint, null);
  assert.equal(completedInternal.checkpointSeal.attempt, 2);
  assert.equal(completedInternal.checkpointSeal.status, 'unavailable');
  assert.equal(typeof completedInternal.checkpointSeal.sealedAt, 'string');
  const artifacts = await service.listArtifacts(id, AGENT_A);
  assert.deepEqual(artifacts.map((item) => item.name), ['resumed.json']);
  await assert.rejects(
    service.resume(id, { resumeKey: 'resume-restart-0002' }, AGENT_A),
    { code: 'TASK_NOT_RESUMABLE' }
  );
  await writeFile(path.join(outputDir, 'resumed.json'), '{"changed":true}\n');
  const duplicateResume = await service.resume(id, { resumeKey: 'resume-restart-0001' }, AGENT_A);
  assert.equal(duplicateResume.state, 'failed');
  assert.equal(duplicateResume.error.code, 'TASK_COMPLETION_INTEGRITY_FAILED');
  assert.equal('result' in duplicateResume, false);
});

test('Manager restart launches a queued resume with the same frozen checkpoint snapshot', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-queued-resume-restart-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, 'state', 'tasks');
  const profiles = fakeProfiles(root);
  const installed = await installTaskType({
    root,
    stateDir,
    profiles,
    moduleSource: 'export const meta = { supportsResume: true }; export async function run() { return { summary: "unused", evidence: [{ kind: "message", value: "unused" }] }; }\n'
  });
  const id = `task_${'c'.repeat(32)}`;
  const taskRoot = path.join(stateDir, id);
  const outputDir = path.join(taskRoot, 'output');
  const checkpointPath = path.join(taskRoot, 'checkpoint.json');
  const frozenPath = path.join(taskRoot, 'resume-input-attempt-2-fixed.json');
  const savedAt = '2026-08-24T02:03:04.000Z';
  const source = Buffer.from(`${JSON.stringify({ taskId: id, attempt: 1, savedAt, data: { next: 9 } })}\n`);
  const resumeInput = {
    path: frozenPath,
    sourceAttempt: 1,
    targetAttempt: 2,
    savedAt,
    sha256: createHash('sha256').update(source).digest('hex'),
    sizeBytes: source.byteLength
  };
  await mkdir(outputDir, { recursive: true });
  await writeFile(checkpointPath, source);
  await writeFile(frozenPath, source);
  await writeFile(path.join(taskRoot, 'task.json'), `${JSON.stringify({
    id,
    profileId: profiles.profile.id,
    taskType: 'durability',
    taskTypeSha256: installed.sha256,
    supportsResume: true,
    modulePath: installed.snapshotPath,
    ownerClientId: AGENT_A.clientId,
    idempotencyKey: 'queued-resume-restart-0001',
    requestHash: 'd'.repeat(64),
    behavior: 'fast',
    input: { marker: 'queued-resume' },
    timeoutMs: 30_000,
    attempt: 2,
    history: [
      { attempt: 1, resumed: false, state: 'failed', startedAt: '2026-08-24T02:00:00.000Z', finishedAt: '2026-08-24T02:01:00.000Z' },
      { attempt: 2, resumed: true, startedAt: '2026-08-24T02:02:00.000Z', checkpointSavedAt: savedAt }
    ],
    state: 'queued',
    progress: { current: 0, total: null, message: 'Resume attempt 2 queued from checkpoint' },
    heartbeatAt: '2026-08-24T02:02:00.000Z',
    outputDir,
    checkpoint: { path: checkpointPath, attempt: 1, savedAt, sha256: resumeInput.sha256, sizeBytes: source.byteLength },
    resumeInput,
    resumeCheckpointValid: true,
    result: null,
    error: null,
    completion: null,
    completionClaimed: false,
    cleanup: { browserClosed: false, leaseReleased: false, workerExited: false, settled: false },
    createdAt: '2026-08-24T02:00:00.000Z',
    updatedAt: '2026-08-24T02:02:00.000Z',
    startedAt: null,
    finishedAt: null,
    workerPid: null,
    leaseOwner: `task:${id}`,
    leaseHeld: false
  }, null, 2)}\n`);
  let observedResumeInput;
  const service = createTaskService({
    stateDir,
    profileStore: profiles,
    allowedTaskRoots: [installed.allowed],
    seedTaskTypes: [],
    workerFactory() {
      return new FakeWorker((message, child) => {
        if (message.type !== 'start') return;
        observedResumeInput = structuredClone(message.config.resumeCheckpoint);
        setImmediate(() => {
          child.emit('message', {
            type: 'result',
            result: { summary: 'Queued resume survived restart', evidence: [{ kind: 'message', value: 'same snapshot' }] }
          });
          child.emit('message', { type: 'state', state: 'completed' });
          child.emit('message', { type: 'cleanup', browserClosed: true });
          child.finish();
        });
      });
    }
  });
  t.after(() => service.close().catch(() => {}));
  const completed = await waitFor(async () => {
    const current = await service.get(id, AGENT_A);
    return current.state === 'completed' && current.cleanup.settled ? current : null;
  });
  assert.equal(completed.attempt, 2);
  assert.deepEqual(observedResumeInput, resumeInput);
  assert.deepEqual(JSON.parse(await readFile(observedResumeInput.path, 'utf8')).data, { next: 9 });
  assert.equal(profiles.profile.lease, null);
});

test('a resumed attempt recovers its newer checkpoint when the checkpoint IPC is lost', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-resume-ipc-loss-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, 'state', 'tasks');
  const allowed = path.join(root, 'allowed');
  await mkdir(allowed);
  const modulePath = path.join(allowed, 'resume-ipc-loss.mjs');
  await writeFile(modulePath, 'export const meta = { supportsResume: true }; export async function run() {}\n');
  const profiles = fakeProfiles(root);
  const service = createTaskService({
    stateDir,
    profileStore: profiles,
    allowedTaskRoots: [allowed],
    seedTaskTypes: [],
    workerFactory() {
      return new FakeWorker((message, child) => {
        if (message.type !== 'start') return;
        setImmediate(() => void (async () => {
          if (message.config.attempt <= 2) {
            const savedAt = new Date().toISOString();
            const encoded = `${JSON.stringify({
              taskId: message.config.taskId,
              attempt: message.config.attempt,
              savedAt,
              data: { cursor: message.config.attempt * 10 }
            })}\n`;
            await writeFile(message.config.checkpointPath, encoded);
            if (message.config.attempt === 1) {
              child.emit('message', {
                type: 'checkpoint',
                path: message.config.checkpointPath,
                attempt: 1,
                savedAt,
                sha256: createHash('sha256').update(encoded).digest('hex'),
                sizeBytes: Buffer.byteLength(encoded)
              });
            }
            child.emit('message', { type: 'error', error: { code: 'RETRY', message: 'retry from checkpoint' } });
          } else {
            assert.equal(message.config.resumeCheckpoint.sourceAttempt, 2);
            assert.deepEqual(JSON.parse(await readFile(message.config.resumeCheckpoint.path, 'utf8')).data, { cursor: 20 });
            child.emit('message', {
              type: 'result',
              result: { summary: 'Recovered newest checkpoint', evidence: [{ kind: 'message', value: 'attempt 3' }] }
            });
            child.emit('message', { type: 'state', state: 'completed' });
          }
          child.emit('message', { type: 'cleanup', browserClosed: true });
          child.finish();
        })());
      });
    }
  });
  t.after(() => service.close().catch(() => {}));
  await service.installTaskType({ name: 'resume-ipc-loss', modulePath }, ADMIN);
  const task = await service.create({
    profileId: profiles.profile.id,
    taskType: 'resume-ipc-loss',
    idempotencyKey: 'resume-ipc-loss-attempt-1'
  }, AGENT_A);
  await waitFor(async () => (await service.get(task.id, AGENT_A)).resumeAvailable === true);
  await service.resume(task.id, { resumeKey: 'resume-ipc-loss-attempt-2' }, AGENT_A);
  const second = await waitFor(async () => {
    const current = await service.get(task.id, AGENT_A);
    return current.state === 'failed' && current.attempt === 2 && current.cleanup.settled ? current : null;
  });
  assert.equal(second.resumeAvailable, true);
  assert.equal((await service.getInternal(task.id)).checkpoint.attempt, 2);
  await service.resume(task.id, { resumeKey: 'resume-ipc-loss-attempt-3' }, AGENT_A);
  const completed = await waitFor(async () => {
    const current = await service.get(task.id, AGENT_A);
    return current.state === 'completed' && current.cleanup.settled ? current : null;
  });
  assert.equal(completed.attempt, 3);
  assert.equal(profiles.profile.lease, null);
});

test('resume fails closed without checkpoint, settled cleanup, or an unchanged module snapshot', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-resume-guards-'));
  const allowed = path.join(root, 'allowed');
  await mkdir(allowed);
  const modulePath = path.join(allowed, 'guards.mjs');
  await writeFile(modulePath, 'export const meta = { supportsResume: true }; export async function run() { return { summary: "ok", evidence: [{ kind: "message", value: "ok" }] }; }\n');
  const profiles = fakeProfiles(root);
  const workers = [];
  const service = createTaskService({
    stateDir: path.join(root, 'state', 'tasks'),
    profileStore: profiles,
    allowedTaskRoots: [allowed],
    seedTaskTypes: [],
    diagnosticGraceMs: 1_000,
    workerFactory() {
      const worker = new FakeWorker((message, child) => {
        if (message.type !== 'start') return;
        const mode = message.config.input.mode;
        setImmediate(() => void (async () => {
          if (mode === 'invalid-orphan-checkpoint') {
            await writeFile(message.config.checkpointPath, '{"savedAt":"not-a-date","data":{}}\n');
          } else if (mode !== 'no-checkpoint') {
            const savedAt = new Date().toISOString();
            const checkpointTarget = mode === 'foreign-pointer'
              ? path.join(root, 'outside-checkpoint.json')
              : message.config.checkpointPath;
            await writeFile(checkpointTarget, `${JSON.stringify({
              taskId: message.config.taskId,
              attempt: message.config.attempt,
              savedAt,
              data: { mode }
            })}\n`);
            child.emit('message', {
              type: 'checkpoint',
              path: checkpointTarget,
              savedAt
            });
          }
          child.emit('message', { type: 'error', error: { code: 'FIXTURE_FAILED', message: 'fixture failure' } });
          if (mode !== 'cleanup-open') {
            child.emit('message', { type: 'cleanup', browserClosed: true });
            child.finish();
          }
        })());
      });
      workers.push(worker);
      return worker;
    }
  });
  t.after(async () => {
    await service.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  await service.installTaskType({ name: 'guards', modulePath }, ADMIN);

  const noCheckpoint = await service.create({
    profileId: profiles.profile.id,
    taskType: 'guards',
    idempotencyKey: 'guard-no-checkpoint',
    input: { mode: 'no-checkpoint' }
  }, AGENT_A);
  await waitFor(async () => (await service.get(noCheckpoint.id, AGENT_A)).cleanup.settled);
  await assert.rejects(
    service.resume(noCheckpoint.id, { resumeKey: 'resume-no-checkpoint' }, AGENT_A),
    { code: 'TASK_CHECKPOINT_REQUIRED' }
  );
  const sealedWithoutCheckpoint = await service.getInternal(noCheckpoint.id);
  assert.equal(sealedWithoutCheckpoint.checkpoint, null);
  assert.equal(sealedWithoutCheckpoint.checkpointSeal.status, 'unavailable');
  await writeFile(path.join(root, 'state', 'tasks', noCheckpoint.id, 'checkpoint.json'), `${JSON.stringify({
    taskId: noCheckpoint.id,
    attempt: sealedWithoutCheckpoint.attempt,
    savedAt: new Date(Date.parse(sealedWithoutCheckpoint.finishedAt) - 1).toISOString(),
    data: { forgedAfterTerminal: true }
  })}\n`);
  await service.get(noCheckpoint.id, AGENT_A);
  assert.equal((await service.getInternal(noCheckpoint.id)).checkpoint, null);
  await assert.rejects(
    service.resume(noCheckpoint.id, { resumeKey: 'resume-forged-no-checkpoint' }, AGENT_A),
    { code: 'TASK_CHECKPOINT_INVALID' }
  );

  const invalidOrphan = await service.create({
    profileId: profiles.profile.id,
    taskType: 'guards',
    idempotencyKey: 'guard-invalid-orphan-checkpoint',
    input: { mode: 'invalid-orphan-checkpoint' }
  }, AGENT_A);
  await waitFor(async () => (await service.get(invalidOrphan.id, AGENT_A)).cleanup.settled);
  await assert.rejects(
    service.resume(invalidOrphan.id, { resumeKey: 'resume-invalid-orphan' }, AGENT_A),
    { code: 'TASK_CHECKPOINT_INVALID' }
  );
  assert.equal((await service.getInternal(invalidOrphan.id)).checkpoint, null);

  const foreignPointer = await service.create({
    profileId: profiles.profile.id,
    taskType: 'guards',
    idempotencyKey: 'guard-foreign-checkpoint-pointer',
    input: { mode: 'foreign-pointer' }
  }, AGENT_A);
  await waitFor(async () => (await service.get(foreignPointer.id, AGENT_A)).cleanup.settled);
  await assert.rejects(
    service.resume(foreignPointer.id, { resumeKey: 'resume-foreign-pointer' }, AGENT_A),
    { code: 'TASK_CHECKPOINT_INVALID' }
  );

  const replacedCheckpoint = await service.create({
    profileId: profiles.profile.id,
    taskType: 'guards',
    idempotencyKey: 'guard-replaced-checkpoint',
    input: { mode: 'replace-checkpoint' }
  }, AGENT_A);
  await waitFor(async () => (await service.get(replacedCheckpoint.id, AGENT_A)).resumeAvailable === true);
  const replacedInternal = await service.getInternal(replacedCheckpoint.id);
  await writeFile(replacedInternal.checkpoint.path, `${JSON.stringify({
    taskId: replacedCheckpoint.id,
    attempt: replacedInternal.attempt,
    // Backdating content must not bypass the immutable terminal seal.
    savedAt: new Date(Date.parse(replacedInternal.finishedAt) - 1).toISOString(),
    data: { mode: 'replacement' }
  })}\n`);
  await assert.rejects(
    service.resume(replacedCheckpoint.id, { resumeKey: 'resume-replaced-checkpoint' }, AGENT_A),
    { code: 'TASK_CHECKPOINT_INVALID' }
  );

  const cleanupOpen = await service.create({
    profileId: profiles.profile.id,
    taskType: 'guards',
    idempotencyKey: 'guard-cleanup-open',
    input: { mode: 'cleanup-open' }
  }, AGENT_A);
  await waitFor(async () => (await service.get(cleanupOpen.id, AGENT_A)).state === 'failed');
  await assert.rejects(
    service.resume(cleanupOpen.id, { resumeKey: 'resume-cleanup-open' }, AGENT_A),
    { code: 'TASK_CLEANUP_NOT_SETTLED' }
  );
  workers.at(-1).emit('message', { type: 'cleanup', browserClosed: true });
  workers.at(-1).finish();
  await waitFor(async () => (await service.get(cleanupOpen.id, AGENT_A)).cleanup.settled);

  const changed = await service.create({
    profileId: profiles.profile.id,
    taskType: 'guards',
    idempotencyKey: 'guard-module-change',
    input: { mode: 'module-change' }
  }, AGENT_A);
  await waitFor(async () => (await service.get(changed.id, AGENT_A)).cleanup.settled);
  const internal = await service.getInternal(changed.id);
  await writeFile(internal.modulePath, 'export async function run() { throw new Error("changed"); }\n');
  await assert.rejects(
    service.resume(changed.id, { resumeKey: 'resume-module-change' }, AGENT_A),
    { code: 'TASK_MODULE_CHANGED' }
  );
});

test('completion gate rejects malformed success and accepts a stable declared artifact', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-completion-gate-'));
  const allowed = path.join(root, 'allowed');
  await mkdir(allowed);
  const modulePath = path.join(allowed, 'gate.mjs');
  await writeFile(modulePath, 'export async function run() { return { summary: "ok", evidence: [] }; }\n');
  const profiles = fakeProfiles(root);
  const service = createTaskService({
    stateDir: path.join(root, 'state', 'tasks'),
    profileStore: profiles,
    allowedTaskRoots: [allowed],
    seedTaskTypes: [],
    workerFactory() {
      return new FakeWorker((message, child) => {
        if (message.type !== 'start') return;
        setTimeout(() => void (async () => {
          const mode = message.config.input.mode;
          if (mode === 'missing-artifact') {
            child.emit('message', {
              type: 'result',
              result: { summary: 'claims a missing artifact', evidence: [{ kind: 'artifact', file: 'missing.json' }] }
            });
          } else if (mode !== 'missing-result') {
            if (mode === 'valid') await writeFile(path.join(message.config.outputDir, 'valid.json'), '{"ok":true}\n');
            child.emit('message', {
              type: 'result',
              result: {
                summary: 'valid result',
                evidence: mode === 'valid' ? [{ kind: 'artifact', file: 'valid.json', agentVisible: true }] : []
              }
            });
          }
          child.emit('message', { type: 'state', state: 'completed' });
          child.emit('message', { type: 'cleanup', browserClosed: mode !== 'browser-open' });
          child.finish();
        })(), 25);
      });
    }
  });
  t.after(async () => {
    await service.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  await service.installTaskType({ name: 'gate', modulePath }, ADMIN);

  async function run(mode) {
    const task = await service.create({
      profileId: profiles.profile.id,
      taskType: 'gate',
      idempotencyKey: `completion-gate-${mode}`,
      input: { mode }
    }, AGENT_A);
    return waitFor(async () => {
      const current = await service.get(task.id, AGENT_A);
      return current.cleanup.settled ? current : null;
    });
  }

  for (const mode of ['missing-result', 'missing-artifact']) {
    const rejected = await run(mode);
    assert.equal(rejected.state, 'failed');
    assert.equal(rejected.error.code, 'TASK_COMPLETION_GATE_FAILED');
    assert.equal(rejected.cleanup.leaseReleased, true);
  }
  const valid = await run('valid');
  assert.equal(valid.state, 'completed');
  assert.equal(valid.cleanup.browserClosed, true);
  assert.equal(valid.cleanup.leaseReleased, true);
  assert.equal(valid.cleanup.workerExited, true);
  assert.equal(valid.cleanup.settled, true);
  assert.equal(profiles.profile.lease, null);
  assert.equal('input' in valid, false);

  async function createValid(key) {
    const body = {
      profileId: profiles.profile.id,
      taskType: 'gate',
      idempotencyKey: key,
      input: { mode: 'valid' }
    };
    const created = await service.create(body, AGENT_A);
    const completed = await waitFor(async () => {
      const current = await service.get(created.id, AGENT_A);
      return current.state === 'completed' && current.cleanup.settled ? current : null;
    });
    return { body, completed };
  }

  const duplicateGate = await createValid('completion-gate-duplicate-replay');
  await writeFile(
    path.join(root, 'state', 'tasks', duplicateGate.completed.id, 'output', 'valid.json'),
    '{"changed":true}\n'
  );
  const duplicateCreate = await service.create(duplicateGate.body, AGENT_A);
  assert.equal(duplicateCreate.state, 'failed');
  assert.equal(duplicateCreate.error.code, 'TASK_COMPLETION_INTEGRITY_FAILED');
  assert.equal('result' in duplicateCreate, false);

  const cancelGate = await createValid('completion-gate-terminal-cancel');
  await writeFile(
    path.join(root, 'state', 'tasks', cancelGate.completed.id, 'output', 'valid.json'),
    '{"changed":true}\n'
  );
  const terminalCancel = await service.cancel(cancelGate.completed.id, AGENT_A);
  assert.equal(terminalCancel.state, 'failed');
  assert.equal(terminalCancel.error.code, 'TASK_COMPLETION_INTEGRITY_FAILED');
  assert.equal('result' in terminalCancel, false);

  const browserOpen = await service.create({
    profileId: profiles.profile.id,
    taskType: 'gate',
    idempotencyKey: 'completion-gate-browser-open',
    input: { mode: 'browser-open' }
  }, AGENT_A);
  const rejectedOpen = await waitFor(async () => {
    const current = await service.get(browserOpen.id, AGENT_A);
    return current.state === 'failed' && current.cleanup.workerExited ? current : null;
  });
  assert.equal(rejectedOpen.state, 'failed');
  assert.equal(rejectedOpen.error.code, 'TASK_COMPLETION_GATE_FAILED');
  assert.equal(rejectedOpen.cleanup.browserClosed, false);
  assert.equal(rejectedOpen.cleanup.leaseReleased, false);
  assert.equal(rejectedOpen.cleanup.settled, false);
  assert.equal(profiles.profile.lease.ownerId, `task:${browserOpen.id}`);
  const internal = await service.getInternal(valid.id);
  assert.deepEqual(internal.input, { mode: 'valid' });
  assert.equal(internal.timeoutMs, null);
  const persisted = JSON.parse(await readFile(path.join(root, 'state', 'tasks', valid.id, 'task.json'), 'utf8'));
  assert.deepEqual(persisted.input, { mode: 'valid' });
  assert.equal(persisted.timeoutMs, null);
  const [verifiedArtifact] = await service.listArtifacts(valid.id, AGENT_A);
  assert.equal(verifiedArtifact.name, 'valid.json');
  await writeFile(path.join(root, 'state', 'tasks', valid.id, 'output', 'valid.json'), '{"changed":true}\n');
  const invalidated = await service.get(valid.id, AGENT_A);
  assert.equal(invalidated.state, 'failed');
  assert.equal(invalidated.error.code, 'TASK_COMPLETION_INTEGRITY_FAILED');
  assert.equal(invalidated.completion.integrity, 'invalid');
  await assert.rejects(
    service.listArtifacts(valid.id, AGENT_A),
    { code: 'ARTIFACT_INTEGRITY_FAILED' }
  );
  await assert.rejects(
    service.readArtifact(valid.id, verifiedArtifact.id, {}, AGENT_A),
    { code: 'ARTIFACT_INTEGRITY_FAILED' }
  );
});

test('real Playwright task resumes from checkpoint and closes both attempt windows', {
  skip: process.env.TASKMASTER_REAL_BROWSER !== '1',
  timeout: 90_000
}, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-real-resume-'));
  const allowed = path.join(root, 'allowed');
  await mkdir(allowed);
  const modulePath = path.join(allowed, 'real-resume.mjs');
  await writeFile(modulePath, [
    "import { writeFile } from 'node:fs/promises';",
    "import path from 'node:path';",
    'export const meta = { supportsResume: true };',
    'export async function run({ page, input, outputDir, action, checkpoint, progress }) {',
    '  const previous = await checkpoint.read();',
    "  await action.goto(input.url, { waitUntil: 'domcontentloaded' });",
    "  await progress({ current: previous ? 2 : 1, total: 2, message: previous ? 'Resumed' : 'Checkpointing' });",
    '  if (!previous) {',
    "    await checkpoint({ stage: 'page-loaded' });",
    "    const error = new Error('intentional first-attempt failure');",
    "    error.code = 'INTENTIONAL_FIRST_ATTEMPT_FAILURE';",
    '    throw error;',
    '  }',
    "  const file = 'real-resume.json';",
    "  await writeFile(path.join(outputDir, file), JSON.stringify({ title: await page.title(), resumed: true }));",
    "  return { summary: 'Real resume completed', evidence: [{ kind: 'artifact', file, agentVisible: true }] };",
    '}',
    ''
  ].join('\n'));
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>Resume Fixture</title><main>ready</main>');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const profiles = fakeProfiles(root);
  const service = createTaskService({
    stateDir: path.join(root, 'state', 'tasks'),
    profileStore: profiles,
    allowedTaskRoots: [allowed],
    seedTaskTypes: []
  });
  t.after(async () => {
    await service.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  await service.installTaskType({ name: 'real-resume', modulePath }, ADMIN);
  const address = server.address();
  const first = await service.create({
    profileId: profiles.profile.id,
    taskType: 'real-resume',
    idempotencyKey: 'real-resume-original',
    input: { url: `http://127.0.0.1:${address.port}/` },
    timeoutMs: 30_000
  }, AGENT_A);
  const failed = await waitFor(async () => {
    const current = await service.get(first.id, AGENT_A);
    return current.state === 'failed' && current.cleanup.settled ? current : null;
  }, 45_000);
  assert.equal(failed.resumeAvailable, true);
  assert.equal(failed.cleanup.browserClosed, true);
  const failedDiagnostics = (await service.listArtifacts(failed.id, AGENT_A))
    .filter((item) => item.kind.startsWith('diagnostic-'));
  assert.ok(failedDiagnostics.length >= 1);
  const resumed = await service.resume(first.id, { resumeKey: 'real-resume-attempt-2' }, AGENT_A);
  assert.equal(resumed.id, first.id);
  const completed = await waitFor(async () => {
    const current = await service.get(first.id, AGENT_A);
    return current.state === 'completed' && current.cleanup.settled ? current : null;
  }, 45_000);
  assert.equal(completed.attempt, 2);
  assert.equal(completed.cleanup.browserClosed, true);
  assert.equal(completed.cleanup.leaseReleased, true);
  assert.equal(profiles.profile.lease, null);
  const artifact = (await service.listArtifacts(completed.id, AGENT_A))
    .find((item) => item.name === 'real-resume.json');
  assert.ok(artifact);
  const retainedDiagnostics = (await service.listArtifacts(completed.id, AGENT_A))
    .filter((item) => item.name.startsWith('attempt-1-'));
  assert.equal(retainedDiagnostics.length, failedDiagnostics.length);
  assert.deepEqual(
    new Set(retainedDiagnostics.map((item) => item.kind)),
    new Set(failedDiagnostics.map((item) => item.kind))
  );
  const content = await service.readArtifact(completed.id, artifact.id, {}, AGENT_A);
  assert.equal(JSON.parse(content.chunk).resumed, true);
});

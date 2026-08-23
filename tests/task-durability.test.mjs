import assert from 'node:assert/strict';
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

test('Manager restart recovery resumes the same task ID once per stable resume key', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-resume-restart-'));
  const stateDir = path.join(root, 'state', 'tasks');
  const profiles = fakeProfiles(root);
  const installed = await installTaskType({
    root,
    stateDir,
    profiles,
    moduleSource: 'export async function run() { return { summary: "unused", evidence: [] }; }\n'
  });
  const id = `task_${'a'.repeat(32)}`;
  const taskRoot = path.join(stateDir, id);
  const outputDir = path.join(taskRoot, 'output');
  const checkpointPath = path.join(taskRoot, 'checkpoint.json');
  const savedAt = '2026-08-24T01:02:03.000Z';
  await mkdir(outputDir, { recursive: true });
  await writeFile(checkpointPath, `${JSON.stringify({ savedAt, data: { next: 2 } })}\n`);
  await writeFile(path.join(taskRoot, 'task.json'), `${JSON.stringify({
    id,
    profileId: profiles.profile.id,
    taskType: 'durability',
    taskTypeSha256: installed.sha256,
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
    checkpoint: { path: checkpointPath, savedAt },
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
  const artifacts = await service.listArtifacts(id, AGENT_A);
  assert.deepEqual(artifacts.map((item) => item.name), ['resumed.json']);
  await assert.rejects(
    service.resume(id, { resumeKey: 'resume-restart-0002' }, AGENT_A),
    { code: 'TASK_NOT_RESUMABLE' }
  );
});

test('resume fails closed without checkpoint, settled cleanup, or an unchanged module snapshot', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-resume-guards-'));
  const allowed = path.join(root, 'allowed');
  await mkdir(allowed);
  const modulePath = path.join(allowed, 'guards.mjs');
  await writeFile(modulePath, 'export async function run() { return { summary: "ok", evidence: [] }; }\n');
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
          if (mode !== 'no-checkpoint') {
            const savedAt = new Date().toISOString();
            await writeFile(message.config.checkpointPath, `${JSON.stringify({ savedAt, data: { mode } })}\n`);
            child.emit('message', { type: 'checkpoint', path: message.config.checkpointPath, savedAt });
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

  for (const mode of ['missing-result', 'missing-artifact', 'browser-open']) {
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
  const internal = await service.getInternal(valid.id);
  assert.deepEqual(internal.input, { mode: 'valid' });
  assert.equal(internal.timeoutMs, null);
  const persisted = JSON.parse(await readFile(path.join(root, 'state', 'tasks', valid.id, 'task.json'), 'utf8'));
  assert.deepEqual(persisted.input, { mode: 'valid' });
  assert.equal(persisted.timeoutMs, null);
  assert.deepEqual((await service.listArtifacts(valid.id, AGENT_A)).map((item) => item.name), ['valid.json']);
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
  const artifact = (await service.listArtifacts(completed.id, AGENT_A))[0];
  const content = await service.readArtifact(completed.id, artifact.id, {}, AGENT_A);
  assert.equal(JSON.parse(content.chunk).resumed, true);
});

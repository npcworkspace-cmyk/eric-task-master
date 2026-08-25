import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createTaskService,
  sendChildMessageConfirmed,
  TASK_SERVICE_DEADLINES
} from '../src/runtime/task-service.mjs';

let nextPid = 40_000;
const ADMIN = Object.freeze({ role: 'manager-admin', clientId: 'manager-admin' });

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

test('critical IPC commands wait for callback confirmation through backpressure', async () => {
  const child = new EventEmitter();
  child.connected = true;
  let callback;
  child.send = (_message, _handle, _options, suppliedCallback) => {
    callback = suppliedCallback;
    return false;
  };
  let settled = false;
  const pending = sendChildMessageConfirmed(child, { type: 'start' }).then((value) => {
    settled = true;
    return value;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  callback();
  assert.equal(await pending, true);

  child.send = (_message, _handle, _options, suppliedCallback) => {
    queueMicrotask(() => suppliedCallback(new Error('channel rejected command')));
  };
  assert.equal(await sendChildMessageConfirmed(child, { type: 'open' }), false);
});

async function writeSessionReceipt(message, child, outcome) {
  await mkdir(path.dirname(message.config.cleanupReceiptPath), { recursive: true });
  await writeFile(message.config.cleanupReceiptPath, `${JSON.stringify({
    version: 1,
    ...message.config.cleanupReceipt,
    workerPid: child.pid,
    outcome,
    closedAt: new Date().toISOString()
  })}\n`);
}

function fakeProfileStore(root) {
  const profile = {
    id: 'profile_test',
    name: 'Test',
    userDataDir: path.join(root, 'profile'),
    defaultBehavior: 'fast',
    browserEngine: 'chromium',
    state: 'idle',
    lease: null
  };
  const events = [];
  return {
    profile,
    events,
    async get(id) {
      if (id !== profile.id) throw new Error('not found');
      return structuredClone(profile);
    },
    async list() {
      return [structuredClone(profile)];
    },
    async acquireLease(id, ownerId, options) {
      if (id !== profile.id) throw new Error('not found');
      if (profile.lease && profile.lease.ownerId !== ownerId) throw new Error('leased');
      profile.lease = {
        ownerId,
        pid: options.pid,
        cleanupRequired: options.cleanupRequired === true || profile.lease?.cleanupRequired === true
      };
      profile.state = ownerId.startsWith('profile-open:') ? 'open' : 'leased';
      events.push(['acquire', ownerId, options.pid, options.cleanupRequired === true]);
      return structuredClone(profile);
    },
    async releaseLease(id, ownerId) {
      if (id !== profile.id) throw new Error('not found');
      if (profile.lease?.ownerId === ownerId) {
        profile.lease = null;
        profile.state = 'idle';
        events.push(['release', ownerId]);
        return true;
      }
      return false;
    },
    async markCleanupUnknown(id, ownerId) {
      if (id !== profile.id) throw new Error('not found');
      if (profile.lease?.ownerId !== ownerId) return false;
      profile.state = 'error';
      profile.lease.cleanupRequired = true;
      events.push(['cleanup-unknown', ownerId]);
      return true;
    }
  };
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition not reached');
}

test('task service isolates work in a child, tracks progress, and releases its lease', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-service-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modulePath = path.join(root, 'task.mjs');
  await writeFile(modulePath, 'export const meta = { supportsResume: true }; export async function run() {}\n');
  const store = fakeProfileStore(root);
  store.profile.kind = 'persistent';
  let workerKind;
  let workerBehavior;
  const service = createTaskService({
    stateDir: path.join(root, 'state'),
    profileStore: store,
    allowedTaskRoots: [root],
    seedTaskTypes: [],
    workerFactory(_workerPath, kind) {
      workerKind = kind;
      return new FakeWorker((message, child) => {
        if (message.type !== 'start') return;
        workerBehavior = message.config.behavior;
        setImmediate(() => {
          child.emit('message', { type: 'heartbeat', at: new Date().toISOString() });
          child.emit('message', { type: 'state', state: 'running' });
          child.emit('message', { type: 'progress', progress: { current: 1, total: 1, message: 'Done' } });
          child.emit('message', { type: 'result', result: { summary: 'Done', evidence: [{ kind: 'message', value: 'fixture verified' }] } });
          child.emit('message', { type: 'state', state: 'completed' });
          child.emit('message', { type: 'cleanup', browserClosed: true });
          child.finish(0);
        });
      });
    }
  });
  await service.installTaskType({ name: 'fixture', modulePath }, ADMIN);

  await assert.rejects(service.create({
    profileId: 'profile_test',
    taskType: 'fixture',
    idempotencyKey: 'task-service-behavior-override',
    input: {},
    behavior: 'fast'
  }, ADMIN), { code: 'INVALID_TASK_CREATE' });

  const created = await service.create({
    profileId: 'profile_test',
    taskType: 'fixture',
    idempotencyKey: 'task-service-isolation',
    input: { secretNotReturned: 'value' }
  }, ADMIN);
  assert.equal(workerKind, 'task');
  assert.equal(workerBehavior, 'human');
  assert.equal(created.behavior, 'human');
  assert.equal(created.history[0].behavior, 'human');
  assert.equal(created.profileId, 'profile_test');
  assert.equal('leaseOwner' in created, false);
  assert.equal('workerPid' in created, false);
  assert.equal('input' in created, false);

  const completed = await waitFor(async () => {
    const current = await service.get(created.id, ADMIN);
    return current.state === 'completed' && current.cleanup.settled ? current : null;
  });
  assert.equal(completed.progress.current, 1);
  assert.equal(completed.cleanup.browserClosed, true);
  assert.equal(completed.cleanup.settled, true);
  assert.equal(store.profile.state, 'idle');
  assert.ok(store.events.some((event) => event[0] === 'release'));
  await service.close();
});

test('task activity is redacted, phase-aware, durable, and independent from progress freshness', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-activity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modulePath = path.join(root, 'task.mjs');
  await writeFile(modulePath, 'export async function run() {}\n');
  const store = fakeProfileStore(root);
  let worker;
  const service = createTaskService({
    stateDir: path.join(root, 'state'),
    profileStore: store,
    allowedTaskRoots: [root],
    seedTaskTypes: [],
    workerFactory() {
      worker = new FakeWorker((message, child) => {
        if (message.type === 'start') {
          setImmediate(() => {
            child.emit('message', { type: 'state', state: 'running' });
            child.emit('message', {
              type: 'progress',
              at: 'https://example.test/?token=worker-controlled',
              progress: { current: 0, total: 10, message: 'Extracting records', phase: 'extracting' }
            });
          });
        }
        if (message.type === 'cancel') {
          setImmediate(() => {
            child.emit('message', { type: 'cleanup', browserClosed: true });
            child.finish(0);
          });
        }
      });
      return worker;
    }
  });
  await service.installTaskType({ name: 'activity-fixture', modulePath }, ADMIN);
  const created = await service.create({
    profileId: 'profile_test', taskType: 'activity-fixture', input: {}, idempotencyKey: 'activity-fixture-0001'
  }, ADMIN);
  const extracting = await waitFor(async () => {
    const task = await service.get(created.id, ADMIN);
    return task.progress?.phase === 'extracting' ? task : null;
  });
  const progressAt = extracting.progressAt;
  assert.deepEqual(extracting.currentActivity.phase, 'running');
  assert.equal(extracting.progress.phase, 'extracting');
  assert.equal(extracting.currentActivity.updatedAt.includes('worker-controlled'), false);
  assert.equal(extracting.heartbeatAt.includes('worker-controlled'), false);

  worker.emit('message', {
    type: 'activity',
    activity: {
      phase: 'working', status: 'unknown', selector: '#password', value: 'do-not-return',
      url: 'https://example.test/?token=do-not-return'
    }
  });
  const unknown = await waitFor(async () => {
    const task = await service.get(created.id, ADMIN);
    return task.currentActivity?.status === 'unknown' ? task : null;
  });
  assert.deepEqual(Object.keys(unknown.currentActivity).sort(), ['phase', 'status', 'updatedAt']);
  assert.equal(JSON.stringify(unknown.currentActivity).includes('do-not-return'), false);
  assert.equal(unknown.progressAt, progressAt);

  await service.cancel(created.id, ADMIN);
  const cancelled = await waitFor(async () => {
    const task = await service.get(created.id, ADMIN);
    return task.state === 'cancelled' && task.cleanup.settled ? task : null;
  });
  assert.equal(cancelled.currentActivity.phase, 'cancelled');
  await service.close();
});

test('task identity snapshots the signed Agent name and legacy tasks fall back to client ID', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-agent-identity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, 'state');
  const modulePath = path.join(root, 'task.mjs');
  await writeFile(modulePath, 'export async function run() {}\n');
  const store = fakeProfileStore(root);
  const agent = Object.freeze({
    role: 'agent',
    clientId: 'codex.identity',
    agentName: '可信 Agent 🤖'
  });
  const createService = () => createTaskService({
    stateDir,
    profileStore: store,
    allowedTaskRoots: [root],
    seedTaskTypes: [],
    workerFactory() {
      return new FakeWorker((message, child) => {
        if (message.type !== 'start') return;
        setImmediate(() => {
          child.emit('message', { type: 'result', result: { summary: 'Done', evidence: [] } });
          child.emit('message', { type: 'state', state: 'completed' });
          child.emit('message', { type: 'cleanup', browserClosed: true });
          child.finish(0);
        });
      });
    }
  });

  let service = createService();
  await service.installTaskType({ name: 'fixture', modulePath }, ADMIN);
  const task = await service.create({
    profileId: 'profile_test',
    taskType: 'fixture',
    idempotencyKey: 'agent-identity-snapshot'
  }, agent);
  assert.deepEqual(task.agent, { clientId: agent.clientId, name: agent.agentName });
  const completed = await waitFor(async () => {
    const current = await service.get(task.id, agent);
    return current.cleanup?.settled ? current : null;
  });
  assert.deepEqual(completed.agent, task.agent);
  assert.deepEqual(
    (await service.get(task.id, { ...agent, agentName: 'Renamed Agent' })).agent,
    task.agent
  );
  assert.equal((await service.getInternal(task.id)).ownerAgentName, agent.agentName);
  await service.close();

  service = createService();
  assert.deepEqual((await service.get(task.id, agent)).agent, task.agent);
  await service.close();

  const taskFile = path.join(stateDir, task.id, 'task.json');
  const legacy = JSON.parse(await readFile(taskFile, 'utf8'));
  delete legacy.ownerAgentName;
  await writeFile(taskFile, `${JSON.stringify(legacy, null, 2)}\n`);

  service = createService();
  const migrated = await service.get(task.id, agent);
  assert.deepEqual(migrated.agent, { clientId: agent.clientId, name: agent.clientId });
  await service.close();
});

test('Profile behavior changes do not break idempotency and queued attempts use launch-time policy', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-profile-policy-idempotency-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modulePath = path.join(root, 'task.mjs');
  await writeFile(modulePath, 'export async function run() {}\n');
  const store = fakeProfileStore(root);
  store.profile.kind = 'ephemeral';
  store.profile.defaultBehavior = 'fast';
  const workers = [];
  const launchBehaviors = [];
  const service = createTaskService({
    stateDir: path.join(root, 'state'),
    profileStore: store,
    allowedTaskRoots: [root],
    seedTaskTypes: [],
    workerFactory() {
      const worker = new FakeWorker((message, child) => {
        if (message.type !== 'start') return;
        launchBehaviors.push(message.config.behavior);
        if (workers.indexOf(child) !== 0) {
          setImmediate(() => {
            child.emit('message', {
              type: 'result',
              result: {
                summary: 'Done',
                evidence: [{ kind: 'message', value: 'launch-time Profile policy verified' }]
              }
            });
            child.emit('message', { type: 'state', state: 'completed' });
            child.emit('message', { type: 'cleanup', browserClosed: true });
            child.finish();
          });
        }
      });
      workers.push(worker);
      return worker;
    }
  });
  await service.installTaskType({ name: 'fixture', modulePath }, ADMIN);

  const blocker = await service.create({
    profileId: 'profile_test',
    taskType: 'fixture',
    idempotencyKey: 'profile-policy-blocker',
    input: {}
  }, ADMIN);
  await waitFor(() => workers.length === 1 && launchBehaviors.length === 1);
  const request = {
    profileId: 'profile_test',
    taskType: 'fixture',
    idempotencyKey: 'profile-policy-idempotency',
    input: { value: 1 }
  };
  const queued = await service.create(request, ADMIN);
  assert.equal(queued.state, 'queued');
  assert.equal(queued.behavior, 'fast');
  assert.equal((await service.getInternal(queued.id)).requestHashVersion, 2);

  store.profile.defaultBehavior = 'human';
  assert.equal((await service.create(request, ADMIN)).id, queued.id);
  await assert.rejects(
    service.create({ ...request, input: { value: 2 } }, ADMIN),
    { code: 'IDEMPOTENCY_CONFLICT' }
  );

  workers[0].emit('message', {
    type: 'result',
    result: {
      summary: 'Blocker done',
      evidence: [{ kind: 'message', value: 'Profile queue released in FIFO order' }]
    }
  });
  workers[0].emit('message', { type: 'state', state: 'completed' });
  workers[0].emit('message', { type: 'cleanup', browserClosed: true });
  workers[0].finish();
  await waitFor(async () => (await service.get(blocker.id, ADMIN)).cleanup.settled === true);
  await waitFor(() => workers.length === 2 && launchBehaviors.length === 2, 3_000);
  const completed = await waitFor(async () => {
    const current = await service.get(queued.id, ADMIN);
    return current.cleanup.settled ? current : null;
  }, 3_000);
  assert.equal(completed.state, 'completed', JSON.stringify(completed.error || {}));
  assert.deepEqual(launchBehaviors, ['fast', 'human']);
  assert.equal(completed.behavior, 'human');
  assert.equal(completed.history[0].behavior, 'human');
  await service.close();
});

test('task finalization drains an in-flight heartbeat renewal before releasing the Profile', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-task-renewal-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modulePath = path.join(root, 'task.mjs');
  await writeFile(modulePath, 'export async function run() {}\n');
  const store = fakeProfileStore(root);
  const acquireLease = store.acquireLease.bind(store);
  let acquireCount = 0;
  let reportRenewalEntered;
  let releaseRenewal;
  const renewalEntered = new Promise((resolve) => { reportRenewalEntered = resolve; });
  const renewalBarrier = new Promise((resolve) => { releaseRenewal = resolve; });
  store.acquireLease = async (...args) => {
    acquireCount += 1;
    if (acquireCount === 2) {
      reportRenewalEntered();
      await renewalBarrier;
    }
    return acquireLease(...args);
  };
  const service = createTaskService({
    stateDir: path.join(root, 'state'),
    profileStore: store,
    allowedTaskRoots: [root],
    seedTaskTypes: [],
    workerFactory() {
      return new FakeWorker((message, child) => {
        if (message.type !== 'start') return;
        setImmediate(() => void (async () => {
          child.emit('message', { type: 'heartbeat', at: new Date().toISOString() });
          await renewalEntered;
          child.emit('message', {
            type: 'result',
            result: { summary: 'Renewal race completed', evidence: [{ kind: 'message', value: 'done' }] }
          });
          child.emit('message', { type: 'state', state: 'completed' });
          child.emit('message', { type: 'cleanup', browserClosed: true });
          child.finish(0);
        })());
      });
    }
  });
  t.after(() => service.close().catch(() => {}));
  await service.installTaskType({ name: 'fixture', modulePath }, ADMIN);
  const task = await service.create({
    profileId: 'profile_test', taskType: 'fixture', idempotencyKey: 'task-renewal-race'
  }, ADMIN);
  await renewalEntered;
  await waitFor(async () => (await service.get(task.id, ADMIN)).state === 'verifying');
  assert.notEqual(store.profile.lease, null);
  releaseRenewal();
  const completed = await waitFor(async () => {
    const current = await service.get(task.id, ADMIN);
    return current.state === 'completed' && current.cleanup.settled ? current : null;
  });
  assert.equal(completed.cleanup.leaseReleased, true);
  assert.equal(store.profile.lease, null);
  assert.equal(store.profile.state, 'idle');
});

test('task worker exit persistence failure is contained and makes shutdown fail closed', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-finalize-persist-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modulePath = path.join(root, 'task.mjs');
  await writeFile(modulePath, 'export async function run() {}\n');
  const store = fakeProfileStore(root);
  let worker;
  let startMessage;
  let reportStarted;
  const started = new Promise((resolve) => { reportStarted = resolve; });
  const stateDir = path.join(root, 'state');
  const service = createTaskService({
    stateDir,
    profileStore: store,
    allowedTaskRoots: [root],
    seedTaskTypes: [],
    workerFactory() {
      worker = new FakeWorker((message) => {
        if (message.type === 'start') {
          startMessage = message;
          reportStarted();
        }
      });
      return worker;
    }
  });
  await service.installTaskType({ name: 'fixture', modulePath }, ADMIN);
  const task = await service.create({
    profileId: 'profile_test', taskType: 'fixture', idempotencyKey: 'finalize-persist-failure'
  }, ADMIN);
  await started;
  const taskRoot = path.join(stateDir, task.id);
  await rm(taskRoot, { recursive: true, force: true });
  await writeFile(taskRoot, 'blocks atomic task persistence');
  worker.emit('message', { type: 'cleanup', browserClosed: true });
  worker.finish(1);
  await new Promise((resolve) => setTimeout(resolve, 100));
  await assert.rejects(service.close(), { code: 'SERVICE_SHUTDOWN_UNCONFIRMED' });
  assert.equal(startMessage.config.taskId, task.id);
});

test('cancellation is terminal and still releases the profile lease', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-cancel-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modulePath = path.join(root, 'task.mjs');
  await writeFile(modulePath, 'export async function run() {}\n');
  const store = fakeProfileStore(root);
  const service = createTaskService({
    stateDir: path.join(root, 'state'),
    profileStore: store,
    allowedTaskRoots: [root],
    seedTaskTypes: [],
    diagnosticGraceMs: 25,
    workerFactory() {
      return new FakeWorker((message, child) => {
        if (message.type === 'start') {
          setImmediate(() => {
            child.emit('message', {
              type: 'result',
              result: { summary: 'Unverified pre-cancel result', evidence: [{ kind: 'message', value: 'must stay private' }] }
            });
            child.emit('message', { type: 'heartbeat', at: new Date().toISOString() });
          });
        }
        if (message.type === 'cancel') {
          setImmediate(() => {
            child.emit('message', { type: 'cleanup', browserClosed: true });
            child.finish(0);
          });
        }
      });
    }
  });
  await service.installTaskType({ name: 'fixture', modulePath }, ADMIN);

  const created = await service.create({
    profileId: 'profile_test',
    taskType: 'fixture',
    idempotencyKey: 'task-service-cancellation'
  }, ADMIN);
  await waitFor(async () => (await service.getInternal(created.id)).result !== null);
  const cancelled = await service.cancel(created.id, ADMIN);
  assert.equal(cancelled.state, 'cancelled');
  assert.equal('result' in cancelled, false);
  const cleaned = await waitFor(async () => {
    const current = await service.get(created.id, ADMIN);
    return current.cleanup.settled ? current : null;
  });
  assert.equal(cleaned.state, 'cancelled');
  assert.equal('result' in cleaned, false);
  assert.equal(cleaned.cleanup.settled, true);
  assert.equal(store.profile.state, 'idle');
  await service.close();
});

test('Manager rejects a worker that shrinks its declared progress total', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-progress-total-manager-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modulePath = path.join(root, 'task.mjs');
  await writeFile(modulePath, 'export async function run() {}\n');
  const store = fakeProfileStore(root);
  const service = createTaskService({
    stateDir: path.join(root, 'state'),
    profileStore: store,
    allowedTaskRoots: [root],
    seedTaskTypes: [],
    workerFactory() {
      return new FakeWorker((message, child) => {
        if (message.type !== 'start') return;
        setImmediate(() => {
          child.emit('message', {
            type: 'progress',
            progress: { current: 5, total: 100, message: 'Bounded work started' }
          });
          child.emit('message', {
            type: 'progress',
            progress: { current: 5, total: 5, message: 'Invalid rebase' }
          });
          child.emit('message', {
            type: 'result',
            result: { summary: 'must not complete', evidence: [{ kind: 'message', value: 'invalid' }] }
          });
          child.emit('message', { type: 'state', state: 'completed' });
          child.emit('message', { type: 'cleanup', browserClosed: true });
          child.finish();
        });
      });
    }
  });
  await service.installTaskType({ name: 'fixture', modulePath }, ADMIN);
  const created = await service.create({
    profileId: 'profile_test', taskType: 'fixture', idempotencyKey: 'manager-progress-total-shrink'
  }, ADMIN);
  const failed = await waitFor(async () => {
    const current = await service.get(created.id, ADMIN);
    return current.cleanup.settled ? current : null;
  });
  assert.equal(failed.state, 'failed');
  assert.equal(failed.error.code, 'TASK_PROGRESS_INVALID');
  assert.equal(failed.progress.current, 5);
  assert.equal(failed.progress.total, 100);
  assert.equal(failed.progress.message, 'Failed');
  await service.close();
});

test('cancelling a queued task wins over an in-flight queue drain', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-cancel-drain-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modulePath = path.join(root, 'task.mjs');
  await writeFile(modulePath, 'export async function run() {}\n');
  const store = fakeProfileStore(root);
  const originalGet = store.get.bind(store);
  let getCalls = 0;
  let releaseDrain;
  let reportDrain;
  const drainEntered = new Promise((resolve) => { reportDrain = resolve; });
  const drainBarrier = new Promise((resolve) => { releaseDrain = resolve; });
  store.get = async (id) => {
    getCalls += 1;
    if (getCalls === 2) {
      reportDrain();
      await drainBarrier;
    }
    return originalGet(id);
  };
  let workerStarts = 0;
  const service = createTaskService({
    stateDir: path.join(root, 'state'),
    profileStore: store,
    allowedTaskRoots: [root],
    seedTaskTypes: [],
    workerFactory() {
      workerStarts += 1;
      return new FakeWorker();
    }
  });
  await service.installTaskType({ name: 'fixture', modulePath }, ADMIN);
  const createPromise = service.create({
    profileId: 'profile_test', taskType: 'fixture', idempotencyKey: 'cancel-drain-race'
  }, ADMIN);
  await drainEntered;
  const [queued] = (await service.list({ caller: ADMIN })).tasks;
  assert.equal(queued.state, 'queued');
  const cancelled = await service.cancel(queued.id, ADMIN);
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.cleanup.settled, true);
  releaseDrain();
  await createPromise;
  await new Promise((resolve) => setTimeout(resolve, 25));
  const terminal = await service.get(queued.id, ADMIN);
  assert.equal(terminal.state, 'cancelled');
  assert.equal(terminal.progress.message, 'Cancelled');
  assert.equal(workerStarts, 0);
  await service.close();
});

test('a failed durable lease release never reports task cleanup as settled', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-release-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modulePath = path.join(root, 'task.mjs');
  await writeFile(modulePath, 'export async function run() {}\n');
  const store = fakeProfileStore(root);
  store.releaseLease = async () => false;
  store.markCleanupUnknown = async () => false;
  const service = createTaskService({
    stateDir: path.join(root, 'state'),
    profileStore: store,
    allowedTaskRoots: [root],
    seedTaskTypes: [],
    workerFactory() {
      const child = new FakeWorker();
      child.send = () => {
        throw new Error('injected task start send failure');
      };
      return child;
    }
  });
  await service.installTaskType({ name: 'fixture', modulePath }, ADMIN);
  const created = await service.create({
    profileId: 'profile_test',
    taskType: 'fixture',
    idempotencyKey: 'release-failure-not-settled'
  }, ADMIN);
  const failed = await waitFor(async () => {
    const task = await service.get(created.id, ADMIN);
    return task.state === 'failed' ? task : null;
  });
  const internal = await service.getInternal(created.id);
  assert.equal(failed.cleanup.leaseReleased, false);
  assert.equal(failed.cleanup.settled, false);
  assert.equal(internal.leaseHeld, true);
  assert.equal(store.profile.lease.ownerId, `task:${created.id}`);
  await assert.rejects(service.close(), { code: 'SERVICE_SHUTDOWN_UNCONFIRMED' });
});

test('task get and list recover a valid cleanup receipt after cleanup IPC is lost', async (t) => {
  for (const readMode of ['get', 'list']) {
    const root = await mkdtemp(path.join(os.tmpdir(), `taskmaster-lost-cleanup-${readMode}-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    const modulePath = path.join(root, 'task.mjs');
    await writeFile(modulePath, 'export async function run() {}\n');
    const store = fakeProfileStore(root);
    const livePids = new Set();
    let receiptPath;
    const service = createTaskService({
      stateDir: path.join(root, 'state'),
      profileStore: store,
      allowedTaskRoots: [root],
      seedTaskTypes: [],
      processAlive: async (pid) => livePids.has(pid),
      workerFactory() {
        const child = new FakeWorker((message) => {
          if (message.type !== 'start') return;
          receiptPath = message.config.cleanupReceiptPath;
          setImmediate(() => void (async () => {
            await mkdir(path.dirname(receiptPath), { recursive: true });
            await writeFile(receiptPath, `${JSON.stringify({
              version: 1,
              kind: 'task',
              taskId: message.config.taskId,
              attempt: message.config.attempt,
              workerPid: child.pid,
              closedAt: new Date().toISOString()
            })}\n`);
            // Deliberately omit the cleanup IPC message. The durable receipt is
            // the only browser-close proof available after this worker exits.
            livePids.delete(child.pid);
            child.finish(0);
          })());
        });
        livePids.add(child.pid);
        return child;
      }
    });
    await service.installTaskType({ name: 'fixture', modulePath }, ADMIN);
    const created = await service.create({
      profileId: 'profile_test',
      taskType: 'fixture',
      idempotencyKey: `lost-cleanup-${readMode}`
    }, ADMIN);

    const settled = await waitFor(async () => {
      if (readMode === 'get') return (await service.get(created.id, ADMIN)).cleanup.settled
        ? service.get(created.id, ADMIN)
        : null;
      const page = await service.list({ caller: ADMIN });
      const current = page.tasks.find((task) => task.id === created.id);
      return current?.cleanup.settled ? current : null;
    }, 2_000);
    assert.equal(settled.cleanup.browserClosed, true);
    assert.equal(settled.cleanup.workerExited, true);
    assert.equal(settled.cleanup.leaseReleased, true);
    assert.notEqual(settled.cleanup.managerRestartObserved, true);
    assert.equal(store.profile.state, 'idle');
    assert.equal(store.profile.lease, null);
    assert.equal(store.events.some((event) => event[0] === 'release'), true);
    await waitFor(async () => {
      try {
        await readFile(receiptPath, 'utf8');
        return false;
      } catch (error) {
        if (error.code === 'ENOENT') return true;
        throw error;
      }
    }, 2_000);
    await service.close();
  }
});

test('a completed task remains completed when only its cleanup IPC is lost', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-complete-lost-cleanup-ipc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modulePath = path.join(root, 'task.mjs');
  await writeFile(modulePath, 'export async function run() {}\n');
  const store = fakeProfileStore(root);
  const service = createTaskService({
    stateDir: path.join(root, 'state'),
    profileStore: store,
    allowedTaskRoots: [root],
    seedTaskTypes: [],
    workerFactory() {
      return new FakeWorker((message, child) => {
        if (message.type !== 'start') return;
        setImmediate(() => void (async () => {
          child.emit('message', {
            type: 'result',
            result: { summary: 'Completed safely', evidence: [{ kind: 'message', value: 'verified' }] }
          });
          child.emit('message', { type: 'state', state: 'completed' });
          await writeFile(message.config.cleanupReceiptPath, `${JSON.stringify({
            version: 1,
            kind: 'task',
            taskId: message.config.taskId,
            attempt: message.config.attempt,
            workerPid: child.pid,
            closedAt: new Date().toISOString()
          })}\n`);
          // Deliberately omit the final cleanup IPC message.
          child.finish();
        })());
      });
    }
  });
  await service.installTaskType({ name: 'fixture', modulePath }, ADMIN);
  const created = await service.create({
    profileId: 'profile_test', taskType: 'fixture', idempotencyKey: 'complete-lost-cleanup-ipc'
  }, ADMIN);
  const completed = await waitFor(async () => {
    const current = await service.get(created.id, ADMIN);
    return current.state === 'completed' && current.cleanup.settled ? current : null;
  });
  assert.equal(completed.state, 'completed');
  assert.equal(completed.progress.message, 'Completed');
  assert.equal(completed.cleanup.browserClosed, true);
  assert.equal(store.profile.lease, null);
  await service.close();
});

test('task reads keep the Profile blocked for invalid or mismatched cleanup receipts', async (t) => {
  for (const receiptMode of ['invalid', 'mismatched']) {
    const root = await mkdtemp(path.join(os.tmpdir(), `taskmaster-bad-cleanup-${receiptMode}-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    const modulePath = path.join(root, 'task.mjs');
    await writeFile(modulePath, 'export async function run() {}\n');
    const store = fakeProfileStore(root);
    const livePids = new Set();
    let receiptPath;
    const service = createTaskService({
      stateDir: path.join(root, 'state'),
      profileStore: store,
      allowedTaskRoots: [root],
      seedTaskTypes: [],
      processAlive: async (pid) => livePids.has(pid),
      workerFactory() {
        const child = new FakeWorker((message) => {
          if (message.type !== 'start') return;
          receiptPath = message.config.cleanupReceiptPath;
          setImmediate(() => void (async () => {
            await mkdir(path.dirname(receiptPath), { recursive: true });
            await writeFile(receiptPath, receiptMode === 'invalid'
              ? '{not-json\n'
              : `${JSON.stringify({
                  version: 1,
                  kind: 'task',
                  taskId: 'task_wrong',
                  attempt: message.config.attempt,
                  workerPid: child.pid,
                  closedAt: new Date().toISOString()
                })}\n`);
            livePids.delete(child.pid);
            child.finish(0);
          })());
        });
        livePids.add(child.pid);
        return child;
      }
    });
    await service.installTaskType({ name: 'fixture', modulePath }, ADMIN);
    const created = await service.create({
      profileId: 'profile_test',
      taskType: 'fixture',
      idempotencyKey: `bad-cleanup-${receiptMode}`
    }, ADMIN);

    const blocked = await waitFor(async () => {
      const page = await service.list({ caller: ADMIN });
      const current = page.tasks.find((task) => task.id === created.id);
      return current?.cleanup.workerExited ? current : null;
    }, 2_000);
    await service.list({ caller: ADMIN });
    assert.equal(blocked.cleanup.settled, false);
    assert.equal(store.profile.state, 'error');
    assert.equal(store.profile.lease.ownerId, `task:${created.id}`);
    assert.equal(store.profile.lease.cleanupRequired, true);
    assert.equal(store.events.some((event) => event[0] === 'release'), false);
    assert.equal(typeof await readFile(receiptPath, 'utf8'), 'string');
    await assert.rejects(service.close(), { code: 'SERVICE_SHUTDOWN_UNCONFIRMED' });
  }
});

test('direct resume recovers lost checkpoint and cleanup IPC before starting the next attempt', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-resume-lost-cleanup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, 'state');
  const modulePath = path.join(root, 'task.mjs');
  await writeFile(modulePath, 'export const meta = { supportsResume: true }; export async function run() {}\n');
  const store = fakeProfileStore(root);
  const livePids = new Set();
  let firstReceiptPath;
  let starts = 0;
  const service = createTaskService({
    stateDir,
    profileStore: store,
    allowedTaskRoots: [root],
    seedTaskTypes: [],
    processAlive: async (pid) => livePids.has(pid),
    workerFactory() {
      const child = new FakeWorker((message) => {
        if (message.type !== 'start') return;
        starts += 1;
        setImmediate(() => void (async () => {
          if (message.config.attempt === 1) {
            const savedAt = new Date().toISOString();
            await writeFile(message.config.checkpointPath, `${JSON.stringify({
              taskId: message.config.taskId,
              attempt: message.config.attempt,
              savedAt,
              data: { nextAttempt: 2 }
            })}\n`);
            child.emit('message', {
              type: 'error',
              error: { code: 'FIXTURE_RETRY', message: 'resume from the checkpoint' }
            });
            firstReceiptPath = message.config.cleanupReceiptPath;
            await writeFile(firstReceiptPath, `${JSON.stringify({
              version: 1,
              kind: 'task',
              taskId: message.config.taskId,
              attempt: message.config.attempt,
              workerPid: child.pid,
              closedAt: new Date().toISOString()
            })}\n`);
            // Both checkpoint and cleanup IPC messages are deliberately lost
            // after their durable files were committed. No get/list call is
            // made before resume below.
            livePids.delete(child.pid);
            child.finish(0);
            return;
          }
          child.emit('message', { type: 'result', result: { summary: 'Resumed', evidence: [{ kind: 'message', value: 'resume verified' }] } });
          child.emit('message', { type: 'state', state: 'completed' });
          child.emit('message', { type: 'cleanup', browserClosed: true });
          livePids.delete(child.pid);
          child.finish(0);
        })());
      });
      livePids.add(child.pid);
      return child;
    }
  });
  await service.installTaskType({ name: 'fixture', modulePath }, ADMIN);
  const created = await service.create({
    profileId: 'profile_test',
    taskType: 'fixture',
    idempotencyKey: 'direct-resume-lost-cleanup'
  }, ADMIN);

  await waitFor(async () => {
    const internal = await service.getInternal(created.id);
    return internal.state === 'failed' && internal.cleanup.workerExited === true;
  }, 2_000);
  assert.equal((await service.getInternal(created.id)).checkpoint, null);

  const resumed = await service.resume(created.id, { resumeKey: 'direct-resume-attempt-2' }, ADMIN);
  assert.equal(resumed.id, created.id);
  assert.equal(resumed.attempt, 2);
  assert.equal(starts, 2);
  const leaseEvents = store.events.filter((event) => ['acquire', 'release'].includes(event[0]));
  assert.deepEqual(leaseEvents.map((event) => event[0]), ['acquire', 'release', 'acquire']);
  await assert.rejects(readFile(firstReceiptPath, 'utf8'), { code: 'ENOENT' });

  const completed = await waitFor(async () => {
    const current = await service.get(created.id, ADMIN);
    return current.state === 'completed' && current.cleanup.settled ? current : null;
  }, 2_000);
  assert.equal(completed.attempt, 2);
  assert.equal(completed.cleanup.leaseReleased, true);
  assert.equal(store.profile.lease, null);
  await service.close();
});

test('the first settled failed-task read publishes a verified resumable checkpoint', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-resume-first-settled-read-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modulePath = path.join(root, 'task.mjs');
  await writeFile(modulePath, 'export const meta = { supportsResume: true }; export async function run() {}\n');
  const store = fakeProfileStore(root);
  const service = createTaskService({
    stateDir: path.join(root, 'state'),
    profileStore: store,
    allowedTaskRoots: [root],
    seedTaskTypes: [],
    workerFactory() {
      return new FakeWorker((message, child) => {
        if (message.type !== 'start') return;
        setImmediate(() => void (async () => {
          const record = {
            taskId: message.config.taskId,
            attempt: message.config.attempt,
            savedAt: new Date().toISOString(),
            data: { next: 20 }
          };
          const encoded = `${JSON.stringify(record)}\n`;
          await writeFile(message.config.checkpointPath, encoded);
          child.emit('message', {
            type: 'checkpoint',
            path: message.config.checkpointPath,
            attempt: message.config.attempt,
            savedAt: record.savedAt,
            sha256: createHash('sha256').update(encoded).digest('hex'),
            sizeBytes: Buffer.byteLength(encoded)
          });
          child.emit('message', {
            type: 'error',
            error: { code: 'FIXTURE_RETRY', message: 'controlled retry' }
          });
          child.emit('message', { type: 'cleanup', browserClosed: true });
          child.finish(0);
        })());
      });
    }
  });
  await service.installTaskType({ name: 'fixture', modulePath }, ADMIN);
  const created = await service.create({
    profileId: 'profile_test',
    taskType: 'fixture',
    idempotencyKey: 'resume-first-settled-read'
  }, ADMIN);

  const failed = await waitFor(async () => {
    const current = await service.get(created.id, ADMIN);
    return current.state === 'failed' && current.cleanup.settled ? current : null;
  });
  assert.equal(failed.resumeAvailable, true);
  assert.equal(typeof failed.checkpoint?.savedAt, 'string');
  await service.close();
});

test('a later failed attempt cannot resume from an older attempt checkpoint', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-resume-generation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modulePath = path.join(root, 'task.mjs');
  await writeFile(modulePath, 'export const meta = { supportsResume: true }; export async function run() {}\n');
  const store = fakeProfileStore(root);
  store.profile.kind = 'ephemeral';
  store.profile.defaultBehavior = 'fast';
  const service = createTaskService({
    stateDir: path.join(root, 'state'),
    profileStore: store,
    allowedTaskRoots: [root],
    seedTaskTypes: [],
    workerFactory() {
      return new FakeWorker((message, child) => {
        if (message.type !== 'start') return;
        setImmediate(() => void (async () => {
          if (message.config.attempt === 1) {
            const record = {
              taskId: message.config.taskId,
              attempt: 1,
              savedAt: new Date().toISOString(),
              data: { next: 2 }
            };
            const encoded = `${JSON.stringify(record)}\n`;
            await writeFile(message.config.checkpointPath, encoded);
            child.emit('message', {
              type: 'checkpoint',
              path: message.config.checkpointPath,
              attempt: 1,
              savedAt: record.savedAt,
              sha256: createHash('sha256').update(encoded).digest('hex'),
              sizeBytes: Buffer.byteLength(encoded)
            });
          }
          child.emit('message', {
            type: 'error',
            error: { code: `ATTEMPT_${message.config.attempt}_FAILED`, message: 'fixture failure' }
          });
          child.emit('message', { type: 'cleanup', browserClosed: true });
          child.finish();
        })());
      });
    }
  });
  await service.installTaskType({ name: 'fixture', modulePath }, ADMIN);
  const created = await service.create({
    profileId: 'profile_test', taskType: 'fixture', idempotencyKey: 'resume-generation-original'
  }, ADMIN);
  await waitFor(async () => (await service.get(created.id, ADMIN)).resumeAvailable === true);
  store.profile.defaultBehavior = 'human';
  const resumed = await service.resume(created.id, { resumeKey: 'resume-generation-attempt-2' }, ADMIN);
  assert.equal(resumed.behavior, 'human');
  assert.equal(resumed.history.find((entry) => entry.attempt === 2)?.behavior, 'human');
  const secondFailure = await waitFor(async () => {
    const current = await service.get(created.id, ADMIN);
    return current.attempt === 2 && current.cleanup.settled ? current : null;
  });
  assert.equal(secondFailure.state, 'failed');
  assert.equal(secondFailure.history.find((entry) => entry.attempt === 1)?.behavior, 'fast');
  assert.equal(secondFailure.history.find((entry) => entry.attempt === 2)?.behavior, 'human');
  assert.equal(secondFailure.resumeAvailable, false);
  await assert.rejects(
    service.resume(created.id, { resumeKey: 'resume-generation-attempt-3' }, ADMIN),
    { code: 'TASK_CHECKPOINT_INVALID' }
  );
  await service.close();
});

test('invalid task worker interface fails before acquiring a Profile lease', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-task-worker-invalid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modulePath = path.join(root, 'task.mjs');
  await writeFile(modulePath, 'export async function run() {}\n');
  const store = fakeProfileStore(root);
  const service = createTaskService({
    stateDir: path.join(root, 'state'),
    profileStore: store,
    allowedTaskRoots: [root],
    seedTaskTypes: [],
    workerFactory() {
      return {};
    }
  });
  await service.installTaskType({ name: 'fixture', modulePath }, ADMIN);

  const failed = await service.create({
    profileId: 'profile_test', taskType: 'fixture', idempotencyKey: 'invalid-task-worker-interface'
  }, ADMIN);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.error.code, 'TASK_WORKER_INVALID');
  assert.equal(failed.cleanup.browserClosed, true);
  assert.equal(failed.cleanup.workerExited, true);
  assert.equal(failed.cleanup.settled, true);
  assert.equal(store.profile.state, 'idle');
  assert.equal(store.profile.lease, null);
  assert.equal(store.events.some((event) => event[0] === 'acquire'), false);
  await service.close();
});

test('task worker listener setup failure kills the idle child without acquiring a Profile lease', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-task-worker-listener-fail-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modulePath = path.join(root, 'task.mjs');
  await writeFile(modulePath, 'export async function run() {}\n');
  const store = fakeProfileStore(root);
  const killSignals = [];
  const service = createTaskService({
    stateDir: path.join(root, 'state'),
    profileStore: store,
    allowedTaskRoots: [root],
    seedTaskTypes: [],
    workerFactory() {
      const child = new FakeWorker();
      child.on = () => {
        throw new Error('injected task listener setup failure');
      };
      const originalKill = child.kill.bind(child);
      child.kill = (signal) => {
        killSignals.push(signal);
        return originalKill(signal);
      };
      return child;
    }
  });
  await service.installTaskType({ name: 'fixture', modulePath }, ADMIN);

  const failed = await service.create({
    profileId: 'profile_test', taskType: 'fixture', idempotencyKey: 'task-listener-setup-failure'
  }, ADMIN);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.error.code, 'TASK_WORKER_SPAWN_FAILED');
  assert.deepEqual(killSignals, ['SIGKILL']);
  assert.equal(failed.cleanup.browserClosed, true);
  assert.equal(failed.cleanup.workerExited, true);
  assert.equal(failed.cleanup.settled, true);
  assert.equal(store.profile.state, 'idle');
  assert.equal(store.profile.lease, null);
  assert.equal(store.events.some((event) => event[0] === 'acquire'), false);
  assert.equal((await service.schedulerStatus()).active, 0);
  await service.close();
});

test('rejected task start command fails explicitly and releases the child-PID Profile lease', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-task-worker-send-fail-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modulePath = path.join(root, 'task.mjs');
  await writeFile(modulePath, 'export async function run() {}\n');
  const store = fakeProfileStore(root);
  const killSignals = [];
  let workerPid;
  const service = createTaskService({
    stateDir: path.join(root, 'state'),
    profileStore: store,
    allowedTaskRoots: [root],
    seedTaskTypes: [],
    workerFactory() {
      const child = new FakeWorker();
      workerPid = child.pid;
      child.send = () => {
        throw new Error('injected task start send failure');
      };
      const originalKill = child.kill.bind(child);
      child.kill = (signal) => {
        killSignals.push(signal);
        return originalKill(signal);
      };
      return child;
    }
  });
  await service.installTaskType({ name: 'fixture', modulePath }, ADMIN);

  const created = await service.create({
    profileId: 'profile_test', taskType: 'fixture', idempotencyKey: 'task-start-send-failure'
  }, ADMIN);
  const failed = await waitFor(async () => {
    const task = await service.get(created.id, ADMIN);
    return task.state === 'failed' && task.cleanup.settled ? task : null;
  });
  assert.equal(failed.error.code, 'TASK_WORKER_START_FAILED');
  assert.deepEqual(killSignals, ['SIGKILL']);
  assert.equal(failed.cleanup.browserClosed, true);
  assert.equal(failed.cleanup.workerExited, true);
  assert.equal(failed.cleanup.leaseReleased, true);
  assert.equal(store.profile.state, 'idle');
  assert.equal(store.profile.lease, null);
  assert.deepEqual(store.events.filter((event) => event[0] === 'acquire').map((event) => [event[2], event[3]]), [
    [workerPid, true]
  ]);
  assert.equal(store.events.some((event) => event[0] === 'release'), true);
  assert.equal((await service.schedulerStatus()).active, 0);
  await service.close();
});

test('terminal worker cleanup may outlive diagnostic grace without being killed', async (t) => {
  assert.equal(TASK_SERVICE_DEADLINES.workerCleanupGraceMs, 30_000);
  assert.equal(TASK_SERVICE_DEADLINES.workerHardKillGraceMs, 5_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-cleanup-grace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modulePath = path.join(root, 'task.mjs');
  await writeFile(modulePath, 'export async function run() {}\n');
  const store = fakeProfileStore(root);
  const killSignals = [];
  const service = createTaskService({
    stateDir: path.join(root, 'state'),
    profileStore: store,
    allowedTaskRoots: [root],
    seedTaskTypes: [],
    diagnosticGraceMs: 15,
    workerCleanupGraceMs: 100,
    workerHardKillGraceMs: 25,
    workerFactory() {
      const worker = new FakeWorker((message, child) => {
        if (message.type !== 'start') return;
        setImmediate(() => {
          child.emit('message', { type: 'result', result: { summary: 'Cleanup completed', evidence: [{ kind: 'message', value: 'cleanup verified' }] } });
          child.emit('message', { type: 'state', state: 'completed' });
          setTimeout(() => {
            child.emit('message', { type: 'cleanup', browserClosed: true });
            child.finish(0);
          }, 50);
        });
      });
      const originalKill = worker.kill.bind(worker);
      worker.kill = (signal) => {
        killSignals.push(signal);
        return originalKill(signal);
      };
      return worker;
    }
  });
  await service.installTaskType({ name: 'fixture', modulePath }, ADMIN);
  const created = await service.create({
    profileId: 'profile_test', taskType: 'fixture', idempotencyKey: 'cleanup-after-diagnostic-grace'
  }, ADMIN);

  const completed = await waitFor(async () => {
    const task = await service.get(created.id, ADMIN);
    return task.state === 'completed' && task.cleanup.settled ? task : null;
  });
  assert.deepEqual(killSignals, []);
  assert.equal(completed.cleanup.browserClosed, true);
  assert.equal(completed.cleanup.leaseReleased, true);
  assert.equal(store.profile.state, 'idle');
  await service.close();
});

test('service close waits for cleanup and hard-kill grace before fail-closed finalization', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-hard-kill-grace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modulePath = path.join(root, 'task.mjs');
  await writeFile(modulePath, 'export async function run() {}\n');
  const store = fakeProfileStore(root);
  const killEvents = [];
  let worker;
  const service = createTaskService({
    stateDir: path.join(root, 'state'),
    profileStore: store,
    allowedTaskRoots: [root],
    seedTaskTypes: [],
    diagnosticGraceMs: 10,
    workerCleanupGraceMs: 60,
    workerHardKillGraceMs: 40,
    workerFactory() {
      worker = new FakeWorker((message, child) => {
        if (message.type === 'start') {
          setImmediate(() => child.emit('message', { type: 'state', state: 'running' }));
        }
      });
      worker.kill = (signal) => {
        killEvents.push({ signal, at: Date.now() });
        if (signal === 'SIGKILL') worker.finish(1, signal);
        return true;
      };
      return worker;
    }
  });
  await service.installTaskType({ name: 'fixture', modulePath }, ADMIN);
  const created = await service.create({
    profileId: 'profile_test', taskType: 'fixture', idempotencyKey: 'service-close-full-budget'
  }, ADMIN);
  await waitFor(() => worker && worker.exitCode === null);

  const closeStartedAt = Date.now();
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    await assert.rejects(service.close(), { code: 'SERVICE_SHUTDOWN_UNCONFIRMED' });
  } finally {
    clearInterval(keepAlive);
  }
  const closeElapsedMs = Date.now() - closeStartedAt;
  assert.deepEqual(killEvents.map((event) => event.signal), ['SIGTERM', 'SIGKILL']);
  assert.ok(killEvents[0].at - closeStartedAt >= 50, JSON.stringify({ closeStartedAt, killEvents }));
  assert.ok(killEvents[1].at - killEvents[0].at >= 30, JSON.stringify(killEvents));
  assert.ok(closeElapsedMs >= 90, `service.close returned after ${closeElapsedMs}ms`);
  const failed = await service.get(created.id, ADMIN);
  assert.equal(failed.cleanup.browserClosed, false);
  assert.equal(failed.cleanup.leaseReleased, false);
  assert.equal(failed.cleanup.workerExited, true);
  assert.equal(failed.cleanup.settled, false);
  assert.notEqual(store.profile.lease, null);
  assert.equal(store.events.some((event) => event[0] === 'release'), false);
});

test('service close rejects every operation that could launch or mutate new work', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-service-closing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modulePath = path.join(root, 'task.mjs');
  await writeFile(modulePath, 'export async function run() {}\n');
  const store = fakeProfileStore(root);
  const service = createTaskService({
    stateDir: path.join(root, 'state'),
    profileStore: store,
    allowedTaskRoots: [root],
    seedTaskTypes: []
  });
  await service.close();

  for (const operation of [
    () => service.installTaskType({ name: 'late', modulePath }, ADMIN),
    () => service.create({
      profileId: 'profile_test', taskType: 'late', idempotencyKey: 'late-create-after-close'
    }, ADMIN),
    () => service.openProfile('profile_test', ADMIN)
  ]) {
    await assert.rejects(operation(), { code: 'SERVICE_CLOSING' });
  }
});

test('waiting_user keeps the same live task and continues only through its matching handoff', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-handoff-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modulePath = path.join(root, 'task.mjs');
  await writeFile(modulePath, 'export async function run() {}\n');
  const store = fakeProfileStore(root);
  const requestId = `handoff_${'a'.repeat(32)}`;
  const service = createTaskService({
    stateDir: path.join(root, 'state'),
    profileStore: store,
    allowedTaskRoots: [root],
    seedTaskTypes: [],
    workerFactory() {
      return new FakeWorker((message, child) => {
        if (message.type === 'start') {
          setImmediate(() => {
            child.emit('message', { type: 'heartbeat', at: new Date().toISOString() });
            child.emit('message', {
              type: 'waiting_user',
              request: {
                id: requestId,
                reason: 'Confirm the live page',
                instructions: 'Inspect diagnostics first',
                requestedAt: new Date().toISOString(),
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
                screenshotAvailable: true
              },
              diagnostics: {
                screenshot: { path: path.join(root, 'waiting-user.jpg'), reason: 'waiting-user' },
                observation: { path: path.join(root, 'waiting-user.json'), reason: 'waiting-user' }
              }
            });
            child.emit('message', { type: 'state', state: 'waiting_user' });
            child.emit('message', {
              type: 'progress',
              at: new Date().toISOString(),
              progress: { current: 1, total: 2, message: 'Waiting for instruction' }
            });
          });
        }
        if (message.type === 'continue') {
          setImmediate(() => {
            child.emit('message', { type: 'state', state: 'running' });
            child.emit('message', {
              type: 'progress',
              at: new Date().toISOString(),
              progress: { current: 2, total: 2, message: 'Instruction verified' }
            });
            child.emit('message', { type: 'result', result: { summary: 'Continued safely', evidence: [{ kind: 'message', value: 'handoff verified' }] } });
            child.emit('message', { type: 'state', state: 'completed' });
            child.emit('message', { type: 'cleanup', browserClosed: true });
            child.finish(0);
          });
        }
      });
    }
  });
  await service.installTaskType({ name: 'fixture', modulePath }, ADMIN);
  const created = await service.create({
    profileId: 'profile_test',
    taskType: 'fixture',
    idempotencyKey: 'task-service-handoff'
  }, ADMIN);
  const waiting = await waitFor(async () => {
    const task = await service.get(created.id, ADMIN);
    return task.state === 'waiting_user' ? task : null;
  });
  assert.equal(waiting.userRequest.id, requestId);
  assert.equal(waiting.userRequest.status, 'pending');
  assert.equal(waiting.health.status, 'waiting_user');
  assert.match(waiting.lastScreenshot.ref, /\/screenshot$/u);
  assert.match(waiting.lastObservation.ref, /\/observation$/u);
  await assert.rejects(
    service.continueTask(created.id, { requestId: `handoff_${'b'.repeat(32)}` }, ADMIN),
    { code: 'USER_HANDOFF_MISMATCH', statusCode: 409 }
  );
  const recovering = await service.continueTask(created.id, { requestId, note: 'Page checked' }, ADMIN);
  assert.notEqual(recovering.state, 'waiting_user');
  const completed = await waitFor(async () => {
    const task = await service.get(created.id, ADMIN);
    return task.cleanup.settled ? task : null;
  });
  assert.equal(completed.state, 'completed');
  assert.equal(completed.id, created.id);
  assert.equal(completed.userRequest.status, 'continued');
  assert.equal(store.profile.state, 'idle');
  await service.close();
});

test('same-Profile tasks queue in FIFO order instead of failing a lease collision', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-queue-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modulePath = path.join(root, 'task.mjs');
  await writeFile(modulePath, 'export async function run() {}\n');
  const store = fakeProfileStore(root);
  const workers = [];
  const service = createTaskService({
    stateDir: path.join(root, 'state'),
    profileStore: store,
    allowedTaskRoots: [root],
    seedTaskTypes: [],
    maxConcurrentTasks: 2,
    workerFactory() {
      const worker = new FakeWorker();
      worker.onSend = (message) => {
        if (message.type === 'start') workers.push({ worker, taskId: message.config.taskId });
      };
      return worker;
    }
  });
  await service.installTaskType({ name: 'fixture', modulePath }, ADMIN);
  const first = await service.create({
    profileId: 'profile_test', taskType: 'fixture', idempotencyKey: 'queue-first'
  }, ADMIN);
  const second = await service.create({
    profileId: 'profile_test', taskType: 'fixture', idempotencyKey: 'queue-second'
  }, ADMIN);
  assert.equal(workers.length, 1);
  assert.equal((await service.get(second.id, ADMIN)).state, 'queued');
  assert.equal((await service.get(second.id, ADMIN)).queuePosition, 1);

  const complete = (entry, summary) => {
    entry.worker.emit('message', { type: 'result', result: { summary, evidence: [{ kind: 'message', value: 'FIFO order verified' }] } });
    entry.worker.emit('message', { type: 'state', state: 'completed' });
    entry.worker.emit('message', { type: 'cleanup', browserClosed: true });
    entry.worker.finish();
  };
  complete(workers[0], 'first complete');
  await waitFor(() => workers.length === 2);
  assert.equal(workers[1].taskId, second.id);
  complete(workers[1], 'second complete');
  const done = await waitFor(async () => {
    const task = await service.get(second.id, ADMIN);
    return task.state === 'completed' && task.cleanup.settled ? task : null;
  });
  assert.equal(done.result.summary, 'second complete');
  assert.equal((await service.schedulerStatus()).queued, 0);
  await service.close();
});

test('queued task fails explicitly when prior Profile cleanup is unconfirmed', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-queue-cleanup-blocked-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modulePath = path.join(root, 'task.mjs');
  await writeFile(modulePath, 'export async function run() {}\n');
  const store = fakeProfileStore(root);
  const acquireLease = store.acquireLease.bind(store);
  store.acquireLease = async (id, ownerId, options) => {
    await acquireLease(id, ownerId, options);
    if (options.cleanupRequired === true && store.profile.lease?.ownerId === ownerId) {
      store.profile.lease.cleanupRequired = true;
    }
    return structuredClone(store.profile);
  };
  store.markCleanupUnknown = async (id, ownerId) => {
    if (id === store.profile.id && store.profile.lease?.ownerId === ownerId) {
      store.profile.state = 'error';
      store.profile.lease.cleanupRequired = true;
      store.events.push(['cleanup-unknown', ownerId]);
    }
  };
  const workers = [];
  const service = createTaskService({
    stateDir: path.join(root, 'state'),
    profileStore: store,
    allowedTaskRoots: [root],
    seedTaskTypes: [],
    maxConcurrentTasks: 2,
    workerCleanupGraceMs: 30,
    workerHardKillGraceMs: 20,
    cleanupReconcileIntervalMs: 10,
    cleanupReconcileGraceMs: 50,
    workerFactory() {
      const worker = new FakeWorker((message, child) => {
        if (message.type !== 'start') return;
        workers.push(child);
        setImmediate(() => {
          child.emit('message', { type: 'result', result: { summary: 'First finished', evidence: [{ kind: 'message', value: 'first task verified' }] } });
          child.emit('message', { type: 'state', state: 'completed' });
        });
      });
      return worker;
    }
  });
  await service.installTaskType({ name: 'fixture', modulePath }, ADMIN);
  const first = await service.create({
    profileId: 'profile_test', taskType: 'fixture', idempotencyKey: 'cleanup-block-first'
  }, ADMIN);
  const second = await service.create({
    profileId: 'profile_test', taskType: 'fixture', idempotencyKey: 'cleanup-block-second'
  }, ADMIN);
  assert.equal((await service.get(second.id, ADMIN)).state, 'queued');

  const blocked = await waitFor(async () => {
    const task = await service.get(second.id, ADMIN);
    return task.state === 'failed' ? task : null;
  });
  assert.equal(workers.length, 1);
  assert.equal(blocked.error.code, 'PROFILE_CLEANUP_UNCONFIRMED');
  assert.equal(blocked.queuePosition, null);
  assert.equal(blocked.queueReason, null);
  assert.deepEqual(blocked.cleanup, {
    browserClosed: true,
    leaseReleased: true,
    workerExited: true,
    settled: true
  });
  const firstInternal = await service.getInternal(first.id);
  const secondInternal = await service.getInternal(second.id);
  assert.notEqual(firstInternal.startedAt, null);
  assert.equal(secondInternal.startedAt, null);
  assert.equal(secondInternal.workerPid, undefined);
  assert.equal(store.profile.state, 'error');
  assert.equal(store.profile.lease.cleanupRequired, true);
  assert.ok(store.events.some((event) => event[0] === 'cleanup-unknown'));
  assert.equal((await service.schedulerStatus()).queued, 0);
  await assert.rejects(service.close(), { code: 'SERVICE_SHUTDOWN_UNCONFIRMED' });
});

test('live-but-stalled tasks trigger diagnostics and fail after the bounded progress deadline', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-stall-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modulePath = path.join(root, 'task.mjs');
  await writeFile(modulePath, 'export async function run() {}\n');
  const store = fakeProfileStore(root);
  const messages = [];
  let heartbeat;
  const service = createTaskService({
    stateDir: path.join(root, 'state'),
    profileStore: store,
    allowedTaskRoots: [root],
    seedTaskTypes: [],
    progressStallMs: 1_000,
    progressFailureMs: 1_500,
    diagnosticGraceMs: 100,
    heartbeatTimeoutMs: 1_000,
    workerFactory() {
      return new FakeWorker((message, child) => {
        messages.push(message.type === 'diagnose' ? `${message.type}:${message.reason}` : message.type);
        if (message.type === 'start') {
          child.emit('message', { type: 'state', state: 'running' });
          heartbeat = setInterval(() => {
            const at = new Date().toISOString();
            child.emit('message', { type: 'heartbeat', at });
            child.emit('message', {
              type: 'progress',
              at,
              progress: { current: 0, total: 10, message: 'Still claiming work without advancing' }
            });
          }, 100);
        }
        if (message.type === 'cancel') {
          clearInterval(heartbeat);
          child.emit('message', { type: 'cleanup', browserClosed: true });
          child.finish();
        }
      });
    }
  });
  t.after(() => clearInterval(heartbeat));
  await service.installTaskType({ name: 'fixture', modulePath }, ADMIN);
  const created = await service.create({
    profileId: 'profile_test', taskType: 'fixture', idempotencyKey: 'stalled-task'
  }, ADMIN);
  const stalled = await waitFor(async () => {
    const task = await service.get(created.id, ADMIN);
    return task.health?.status === 'stalled' ? task : null;
  }, 6_000);
  assert.equal(stalled.health.diagnosticRequested, true);
  assert.ok(messages.includes('diagnose:progress-stalled'));
  const failed = await waitFor(async () => {
    const task = await service.get(created.id, ADMIN);
    return task.cleanup.settled ? task : null;
  }, 4_000);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.error.code, 'TASK_PROGRESS_STALLED');
  assert.equal(failed.cleanup.browserClosed, true);
  await service.close();
});

test('returning from a long cooldown gets a fresh progress window', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-cooldown-progress-reset-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modulePath = path.join(root, 'task.mjs');
  await writeFile(modulePath, 'export async function run() {}\n');
  const store = fakeProfileStore(root);
  const service = createTaskService({
    stateDir: path.join(root, 'state'),
    profileStore: store,
    allowedTaskRoots: [root],
    seedTaskTypes: [],
    progressStallMs: 1_000,
    progressFailureMs: 1_300,
    workerFactory() {
      return new FakeWorker((message, child) => {
        if (message.type !== 'start') return;
        setImmediate(() => child.emit('message', { type: 'state', state: 'cooling_down' }));
        setTimeout(() => {
          child.emit('message', { type: 'state', state: 'running' });
          setTimeout(() => {
            child.emit('message', {
              type: 'progress',
              progress: { current: 1, total: 1, message: 'Recovered after cooldown' }
            });
            child.emit('message', {
              type: 'result',
              result: { summary: 'Cooldown recovery completed', evidence: [{ kind: 'message', value: 'recovered' }] }
            });
            child.emit('message', { type: 'state', state: 'completed' });
            child.emit('message', { type: 'cleanup', browserClosed: true });
            child.finish();
          }, 500);
        }, 1_600);
      });
    }
  });
  await service.installTaskType({ name: 'fixture', modulePath }, ADMIN);
  const created = await service.create({
    profileId: 'profile_test', taskType: 'fixture', idempotencyKey: 'cooldown-progress-reset'
  }, ADMIN);
  const completed = await waitFor(async () => {
    const current = await service.get(created.id, ADMIN);
    return current.cleanup.settled ? current : null;
  }, 4_000);
  assert.equal(completed.state, 'completed');
  assert.equal(completed.progress.message, 'Completed');
  await service.close();
});

test('legacy session-import lease migration requires a valid cleanup receipt', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-import-restart-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = fakeProfileStore(root);
  const stateDir = path.join(root, 'state');
  const ownerId = 'session-import:restart-confirmed';
  const workerPid = 50_501;
  await store.acquireLease('profile_test', ownerId, {
    pid: workerPid,
    ttlMs: 1_000,
    cleanupRequired: true
  });
  const receiptPath = path.join(
    root,
    'cleanup-receipts',
    `session-${createHash('sha256').update(ownerId).digest('hex')}.json`
  );
  await mkdir(path.dirname(receiptPath), { recursive: true });
  await writeFile(receiptPath, `${JSON.stringify({
    version: 1,
    kind: 'session',
    profileId: 'profile_test',
    ownerId,
    workerPid,
    outcome: 'rolled_back',
    closedAt: new Date().toISOString()
  })}\n`);
  const recovered = createTaskService({
    stateDir,
    profileStore: store,
    processAlive: async () => false
  });
  await recovered.list({ caller: ADMIN });
  assert.equal(store.profile.state, 'idle');
  assert.equal(store.profile.lease, null);
  await assert.rejects(readFile(receiptPath, 'utf8'), { code: 'ENOENT' });
  await recovered.close();

  const missingOwnerId = 'session-import:restart-missing-receipt';
  await store.acquireLease('profile_test', missingOwnerId, {
    pid: 50_502,
    ttlMs: 1_000,
    cleanupRequired: true
  });
  const blocked = createTaskService({
    stateDir,
    profileStore: store,
    processAlive: async () => false
  });
  await blocked.list({ caller: ADMIN });
  assert.equal(store.profile.state, 'error');
  assert.equal(store.profile.lease.ownerId, missingOwnerId);
  assert.equal(store.profile.lease.cleanupRequired, true);
  await assert.rejects(
    blocked.openProfile('profile_test', ADMIN),
    { code: 'LEGACY_SESSION_IMPORT_CLEANUP_UNCONFIRMED' }
  );
  await assert.rejects(blocked.close(), { code: 'SERVICE_SHUTDOWN_UNCONFIRMED' });
});

test('a queued task automatically resumes after a late session cleanup receipt', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-late-session-receipt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, 'state');
  const modulePath = path.join(root, 'task.mjs');
  await writeFile(modulePath, 'export async function run() {}\n');
  const store = fakeProfileStore(root);
  const ownerId = 'session-import:late-cleanup';
  const workerPid = 51_001;
  let legacyWorkerAlive = true;
  await store.acquireLease('profile_test', ownerId, {
    pid: workerPid,
    ttlMs: 1_000,
    cleanupRequired: true
  });
  const taskWorkers = [];
  const service = createTaskService({
    stateDir,
    profileStore: store,
    allowedTaskRoots: [root],
    seedTaskTypes: [],
    cleanupReconcileIntervalMs: 10,
    cleanupReconcileGraceMs: 500,
    processAlive: async (pid) => pid === workerPid && legacyWorkerAlive,
    workerFactory(_workerPath, kind) {
      assert.equal(kind, 'task');
      const worker = new FakeWorker((message, child) => {
        if (message.type !== 'start') return;
        taskWorkers.push(child);
        setImmediate(() => void (async () => {
          await mkdir(path.dirname(message.config.cleanupReceiptPath), { recursive: true });
          await writeFile(message.config.cleanupReceiptPath, `${JSON.stringify({
            version: 1,
            kind: 'task',
            taskId: message.config.taskId,
            attempt: message.config.attempt,
            workerPid: child.pid,
            closedAt: new Date().toISOString()
          })}\n`);
          child.emit('message', { type: 'result', result: { summary: 'Recovered', evidence: [{ kind: 'message', value: 'late receipt verified' }] } });
          child.emit('message', { type: 'state', state: 'completed' });
          child.emit('message', { type: 'cleanup', browserClosed: true });
          await new Promise((resolve) => setTimeout(resolve, 20));
          child.finish(0);
        })());
      });
      return worker;
    }
  });
  await service.installTaskType({ name: 'fixture', modulePath }, ADMIN);
  const task = await service.create({
    profileId: 'profile_test',
    taskType: 'fixture',
    idempotencyKey: 'late-session-receipt-task'
  }, ADMIN);
  await waitFor(async () => {
    const current = await service.get(task.id, ADMIN);
    return current.state === 'queued' && current.health?.status === 'queued' &&
      current.queueReason === 'Waiting for Profile to become idle';
  });

  const receiptPath = path.join(
    root,
    'cleanup-receipts',
    `session-${createHash('sha256').update(ownerId).digest('hex')}.json`
  );
  await mkdir(path.dirname(receiptPath), { recursive: true });
  await writeFile(receiptPath, `${JSON.stringify({
    version: 1,
    kind: 'session',
    profileId: 'profile_test',
    ownerId,
    workerPid,
    outcome: 'rolled_back',
    closedAt: new Date().toISOString()
  })}\n`);
  legacyWorkerAlive = false;

  let completed;
  try {
    completed = await waitFor(async () => {
      const current = await service.get(task.id, ADMIN);
      return current.state === 'completed' && current.cleanup.settled ? current : null;
    }, 3_000);
  } catch {
    const current = await service.get(task.id, ADMIN);
    assert.fail(JSON.stringify({ current, profile: store.profile, taskWorkers: taskWorkers.length }));
  }
  assert.equal(completed.result.summary, 'Recovered');
  assert.equal(taskWorkers.length, 1);
  assert.equal(store.profile.state, 'idle');
  assert.equal(store.profile.lease, null);
  await service.close();
});

test('manual profile window holds one lease until it closes', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-profile-open-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = fakeProfileStore(root);
  let openMessage;
  const service = createTaskService({
    stateDir: path.join(root, 'state'),
    profileStore: store,
    workerFactory(_workerPath, kind) {
      assert.equal(kind, 'profile-open');
      return new FakeWorker((message, child) => {
        if (message.type === 'open') {
          openMessage = message;
          setImmediate(() => child.emit('message', { type: 'ready' }));
        }
        if (message.type === 'close') setImmediate(() => void (async () => {
          await mkdir(path.dirname(openMessage.cleanupReceiptPath), { recursive: true });
          await writeFile(openMessage.cleanupReceiptPath, `${JSON.stringify({
            version: 1,
            ...openMessage.cleanupReceipt,
            workerPid: child.pid,
            closedAt: new Date().toISOString()
          })}\n`);
          child.emit('message', { type: 'closed', browserClosed: true, cleanupReceiptWritten: true });
          child.finish(0);
        })());
      });
    }
  });

  const opened = await service.openProfile('profile_test');
  assert.equal(opened.status, 'open');
  assert.equal(store.profile.state, 'open');
  assert.match(store.profile.lease.ownerId, /^profile-open:manager-admin:profile_test:[a-f0-9]{32}$/);
  assert.deepEqual(store.events.filter((event) => event[0] === 'acquire').map((event) => [event[2], event[3]]), [
    [opened.pid, true]
  ]);

  const closed = await service.closeProfile('profile_test');
  assert.equal(closed.status, 'closed');
  assert.equal(store.profile.state, 'idle');
  assert.equal(store.profile.lease, null);
  await service.close();
});

test('natural manual Profile close releases its lease when closed IPC precedes worker exit', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-profile-natural-close-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = fakeProfileStore(root);
  let openMessage;
  let profileWorker;
  const service = createTaskService({
    stateDir: path.join(root, 'state'),
    profileStore: store,
    workerFactory(_workerPath, kind) {
      assert.equal(kind, 'profile-open');
      profileWorker = new FakeWorker((message, child) => {
        if (message.type !== 'open') return;
        openMessage = message;
        setImmediate(() => child.emit('message', { type: 'ready' }));
      });
      return profileWorker;
    }
  });

  await service.openProfile('profile_test');
  await mkdir(path.dirname(openMessage.cleanupReceiptPath), { recursive: true });
  await writeFile(openMessage.cleanupReceiptPath, `${JSON.stringify({
    version: 1,
    ...openMessage.cleanupReceipt,
    workerPid: profileWorker.pid,
    closedAt: new Date().toISOString()
  })}\n`);

  profileWorker.emit('message', {
    type: 'closed',
    browserClosed: true,
    cleanupReceiptWritten: true
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.notEqual(store.profile.lease, null, 'lease must remain fail-closed until the worker exits');

  profileWorker.finish(0);
  await waitFor(() => store.profile.lease === null);
  assert.equal(store.profile.state, 'idle');
  assert.equal(store.events.filter((event) => event[0] === 'release').length, 1);
  await assert.rejects(readFile(openMessage.cleanupReceiptPath), { code: 'ENOENT' });
  await service.close();
});

test('manual Profile close drains an in-flight renewal before releasing its lease', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-profile-renewal-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = fakeProfileStore(root);
  const acquireLease = store.acquireLease.bind(store);
  let acquireCount = 0;
  let reportRenewalEntered;
  let releaseRenewal;
  const renewalEntered = new Promise((resolve) => { reportRenewalEntered = resolve; });
  const renewalBarrier = new Promise((resolve) => { releaseRenewal = resolve; });
  store.acquireLease = async (...args) => {
    acquireCount += 1;
    if (acquireCount === 2) {
      reportRenewalEntered();
      await renewalBarrier;
    }
    return acquireLease(...args);
  };
  let openMessage;
  const service = createTaskService({
    stateDir: path.join(root, 'state'),
    profileStore: store,
    profileLeaseRenewalMs: 10,
    workerFactory() {
      return new FakeWorker((message, child) => {
        if (message.type === 'open') {
          openMessage = message;
          setImmediate(() => child.emit('message', { type: 'ready' }));
        }
        if (message.type === 'close') setImmediate(() => void (async () => {
          await mkdir(path.dirname(openMessage.cleanupReceiptPath), { recursive: true });
          await writeFile(openMessage.cleanupReceiptPath, `${JSON.stringify({
            version: 1,
            ...openMessage.cleanupReceipt,
            workerPid: child.pid,
            closedAt: new Date().toISOString()
          })}\n`);
          child.emit('message', { type: 'closed', browserClosed: true, cleanupReceiptWritten: true });
          child.finish(0);
        })());
      });
    }
  });
  t.after(() => service.close().catch(() => {}));
  await service.openProfile('profile_test');
  await waitFor(() => acquireCount >= 2, 500);
  await renewalEntered;
  let closeSettled = false;
  const closePromise = service.closeProfile('profile_test').then((value) => {
    closeSettled = true;
    return value;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(closeSettled, false);
  assert.notEqual(store.profile.lease, null);
  releaseRenewal();
  assert.equal((await closePromise).status, 'closed');
  assert.equal(store.profile.lease, null);
  assert.equal(store.profile.state, 'idle');
});

test('manual Profile exit reconciles a valid cleanup receipt when the closed IPC message is lost', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-profile-exit-receipt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = fakeProfileStore(root);
  let openMessage;
  let resolveFinished;
  const finished = new Promise((resolve) => { resolveFinished = resolve; });
  const service = createTaskService({
    stateDir: path.join(root, 'state'),
    profileStore: store,
    workerFactory(_workerPath, kind) {
      assert.equal(kind, 'profile-open');
      return new FakeWorker((message, child) => {
        if (message.type !== 'open') return;
        openMessage = message;
        setImmediate(() => child.emit('message', { type: 'ready' }));
        setTimeout(() => void (async () => {
          await mkdir(path.dirname(openMessage.cleanupReceiptPath), { recursive: true });
          await writeFile(openMessage.cleanupReceiptPath, `${JSON.stringify({
            version: 1,
            ...openMessage.cleanupReceipt,
            workerPid: child.pid,
            closedAt: new Date().toISOString()
          })}\n`);
          child.finish(0);
          resolveFinished();
        })(), 25);
      });
    }
  });

  const opened = await service.openProfile('profile_test');
  assert.equal(opened.status, 'open');
  await finished;
  const closed = await service.closeProfile('profile_test');
  assert.equal(closed.status, 'closed');
  assert.equal(store.profile.state, 'idle');
  assert.equal(store.profile.lease, null);
  assert.equal(store.events.filter((event) => event[0] === 'release').length, 1);
  await assert.rejects(readFile(openMessage.cleanupReceiptPath), { code: 'ENOENT' });
  await service.close();
});

test('manual Profile exit with an invalid cleanup receipt remains blocked', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-profile-exit-invalid-receipt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = fakeProfileStore(root);
  let openMessage;
  let resolveFinished;
  const finished = new Promise((resolve) => { resolveFinished = resolve; });
  const service = createTaskService({
    stateDir: path.join(root, 'state'),
    profileStore: store,
    workerFactory(_workerPath, kind) {
      assert.equal(kind, 'profile-open');
      return new FakeWorker((message, child) => {
        if (message.type !== 'open') return;
        openMessage = message;
        setImmediate(() => child.emit('message', { type: 'ready' }));
        setTimeout(() => void (async () => {
          await mkdir(path.dirname(openMessage.cleanupReceiptPath), { recursive: true });
          await writeFile(openMessage.cleanupReceiptPath, `${JSON.stringify({
            version: 1,
            ...openMessage.cleanupReceipt,
            ownerId: 'profile-open:wrong-owner',
            workerPid: child.pid,
            closedAt: new Date().toISOString()
          })}\n`);
          child.finish(0);
          resolveFinished();
        })(), 25);
      });
    }
  });

  await service.openProfile('profile_test');
  await finished;
  await assert.rejects(service.openProfile('profile_test'), {
    code: 'PROFILE_CLEANUP_UNCONFIRMED'
  });
  await assert.rejects(service.closeProfile('profile_test'), { code: 'PROFILE_CLEANUP_UNCONFIRMED' });
  assert.equal(store.profile.state, 'error');
  assert.notEqual(store.profile.lease, null);
  assert.equal(store.events.some((event) => event[0] === 'release'), false);
  await assert.rejects(service.close(), { code: 'SERVICE_SHUTDOWN_UNCONFIRMED' });
});

test('a dead manual Profile without cleanup proof cannot strand queued work as merely busy', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-dead-profile-queue-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modulePath = path.join(root, 'task.mjs');
  await writeFile(modulePath, 'export async function run() {}\n');
  const store = fakeProfileStore(root);
  let profileWorker;
  let taskWorkerStarts = 0;
  const service = createTaskService({
    stateDir: path.join(root, 'state'),
    profileStore: store,
    allowedTaskRoots: [root],
    seedTaskTypes: [],
    cleanupReconcileIntervalMs: 10,
    cleanupReconcileGraceMs: 40,
    processAlive: async () => false,
    workerFactory(_workerPath, kind) {
      if (kind === 'profile-open') {
        profileWorker = new FakeWorker((message, child) => {
          if (message.type === 'open') setImmediate(() => child.emit('message', { type: 'ready' }));
        });
        return profileWorker;
      }
      taskWorkerStarts += 1;
      return new FakeWorker();
    }
  });
  t.after(() => service.close().catch(() => {}));
  await service.installTaskType({ name: 'fixture', modulePath }, ADMIN);
  await service.openProfile('profile_test');
  profileWorker.finish(1);
  const task = await service.create({
    profileId: 'profile_test', taskType: 'fixture', idempotencyKey: 'dead-profile-queue'
  }, ADMIN);
  const failed = await waitFor(async () => {
    const current = await service.get(task.id, ADMIN);
    return current.state === 'failed' ? current : null;
  }, 1_000);
  assert.equal(failed.error.code, 'PROFILE_CLEANUP_UNCONFIRMED');
  assert.equal(taskWorkerStarts, 0);
  assert.equal(store.profile.state, 'error');
});

test('manual Profile worker initialization failure leaves no lease or browser entry', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-profile-open-spawn-fail-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = fakeProfileStore(root);
  const service = createTaskService({
    stateDir: path.join(root, 'state'),
    profileStore: store,
    workerFactory(_workerPath, kind) {
      assert.equal(kind, 'profile-open');
      throw new Error('injected profile worker failure');
    }
  });
  await assert.rejects(service.openProfile('profile_test'), /injected profile worker failure/u);
  assert.equal(store.profile.state, 'idle');
  assert.equal(store.profile.lease, null);
  assert.equal(store.events.some((event) => event[0] === 'acquire'), false);
  await service.close();
});

test('manual Profile listener setup failure kills the idle worker and leaves no lease or browser entry', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-profile-open-listener-fail-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = fakeProfileStore(root);
  const killSignals = [];
  let workerFactoryCalls = 0;
  let openMessage;
  const service = createTaskService({
    stateDir: path.join(root, 'state'),
    profileStore: store,
    workerFactory(_workerPath, kind) {
      assert.equal(kind, 'profile-open');
      workerFactoryCalls += 1;
      if (workerFactoryCalls === 1) {
        const child = new FakeWorker();
        child.once = () => {
          throw new Error('injected listener setup failure');
        };
        child.kill = (signal) => {
          killSignals.push(signal);
          child.connected = false;
          child.exitCode = 0;
          return true;
        };
        return child;
      }
      return new FakeWorker((message, child) => {
        if (message.type === 'open') {
          openMessage = message;
          setImmediate(() => child.emit('message', { type: 'ready' }));
        }
        if (message.type === 'close') setImmediate(() => void (async () => {
          await mkdir(path.dirname(openMessage.cleanupReceiptPath), { recursive: true });
          await writeFile(openMessage.cleanupReceiptPath, `${JSON.stringify({
            version: 1,
            ...openMessage.cleanupReceipt,
            workerPid: child.pid,
            closedAt: new Date().toISOString()
          })}\n`);
          child.emit('message', { type: 'closed', browserClosed: true, cleanupReceiptWritten: true });
          child.finish(0);
        })());
      });
    }
  });

  await assert.rejects(service.openProfile('profile_test'), /injected listener setup failure/u);
  assert.deepEqual(killSignals, ['SIGKILL']);
  assert.equal(store.profile.state, 'idle');
  assert.equal(store.profile.lease, null);
  assert.equal(store.events.some((event) => event[0] === 'acquire'), false);

  const opened = await service.openProfile('profile_test');
  assert.equal(opened.status, 'open');
  assert.equal(workerFactoryCalls, 2);
  await service.closeProfile('profile_test');
  await service.close();
});

test('task history survives Manager restart and interrupted work is fail-closed', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-history-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, 'state');
  const completed = {
    id: 'task_completed',
    profileId: 'profile_test',
    state: 'verifying',
    completionClaimed: true,
    progress: { current: 1, total: 1, message: 'Verifying' },
    health: { status: 'healthy', checkedAt: '2026-01-01T00:00:00.000Z' },
    result: { summary: 'Done', evidence: [{ kind: 'message', value: 'restart verified' }] },
    cleanup: { browserClosed: true, leaseReleased: true, workerExited: true, settled: true },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
    finishedAt: '2026-01-01T00:00:01.000Z',
    leaseHeld: false,
    leaseOwner: 'task:task_completed'
  };
  const interrupted = {
    id: 'task_interrupted',
    profileId: 'profile_test',
    state: 'running',
    progress: { current: 3, total: 10, message: 'Working' },
    result: {
      summary: 'Looks complete but was never verified',
      evidence: [
        { kind: 'message', value: 'all done' },
        { kind: 'artifact', file: 'unverified.txt', agentVisible: true }
      ]
    },
    outputDir: path.join(stateDir, 'task_interrupted', 'output'),
    cleanup: { browserClosed: false, leaseReleased: false, workerExited: false },
    checkpoint: { path: path.join(stateDir, 'task_interrupted', 'checkpoint.json') },
    createdAt: '2026-01-02T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:01.000Z',
    leaseHeld: true,
    leaseOwner: 'task:task_interrupted'
  };
  const previouslyFailed = {
    id: 'task_failed',
    profileId: 'profile_test',
    state: 'failed',
    error: { code: 'ORIGINAL_FAILURE', message: 'preserve me' },
    progress: { current: 2, total: 5, message: 'stale' },
    health: { status: 'healthy', checkedAt: '2026-01-03T00:00:00.000Z' },
    cleanup: { browserClosed: true, leaseReleased: true, workerExited: true, settled: true },
    createdAt: '2026-01-03T00:00:00.000Z',
    updatedAt: '2026-01-03T00:00:01.000Z',
    finishedAt: '2026-01-03T00:00:01.000Z',
    leaseHeld: false,
    leaseOwner: 'task:task_failed'
  };
  const previouslyCancelled = {
    id: 'task_cancelled',
    profileId: 'profile_test',
    state: 'cancelled',
    progress: { current: 1, total: 4, message: 'stale' },
    health: { status: 'healthy', checkedAt: '2026-01-04T00:00:00.000Z' },
    cleanup: { browserClosed: true, leaseReleased: true, workerExited: true, settled: true },
    createdAt: '2026-01-04T00:00:00.000Z',
    updatedAt: '2026-01-04T00:00:01.000Z',
    finishedAt: '2026-01-04T00:00:01.000Z',
    leaseHeld: false,
    leaseOwner: 'task:task_cancelled'
  };
  for (const task of [completed, interrupted, previouslyFailed, previouslyCancelled]) {
    const taskDir = path.join(stateDir, task.id);
    await mkdir(taskDir, { recursive: true });
    if (task.id === 'task_interrupted') {
      await mkdir(task.outputDir, { recursive: true });
      await writeFile(path.join(task.outputDir, 'unverified.txt'), 'UNVERIFIED\n');
    }
    await writeFile(path.join(taskDir, 'task.json'), JSON.stringify(task));
  }

  const service = createTaskService({ stateDir, profileStore: fakeProfileStore(root) });
  const page = await service.list({ caller: ADMIN });
  assert.equal(page.tasks.length, 4);
  const restoredComplete = await service.get('task_completed', ADMIN);
  assert.equal(restoredComplete.state, 'completed');
  assert.equal(restoredComplete.progress.message, 'Completed');
  assert.equal(restoredComplete.health.status, 'completed');
  const recovered = await service.get('task_interrupted', ADMIN);
  assert.equal(recovered.state, 'failed');
  assert.equal(recovered.error.code, 'TASK_INTERRUPTED_BY_MANAGER_RESTART');
  assert.equal('result' in recovered, false);
  assert.equal(recovered.progress.message, 'Failed');
  assert.equal(recovered.health.status, 'failed');
  assert.equal(recovered.cleanup.managerRestartObserved, true);
  assert.equal(recovered.checkpoint.ref, 'taskmaster://tasks/task_interrupted/checkpoint');
  assert.deepEqual(await service.listArtifacts('task_interrupted', ADMIN), []);
  const restoredFailure = await service.get('task_failed', ADMIN);
  assert.equal(restoredFailure.state, 'failed');
  assert.equal(restoredFailure.error.code, 'ORIGINAL_FAILURE');
  assert.equal(restoredFailure.progress.message, 'Failed');
  assert.equal(restoredFailure.health.status, 'failed');
  const restoredCancellation = await service.get('task_cancelled', ADMIN);
  assert.equal(restoredCancellation.state, 'cancelled');
  assert.equal(restoredCancellation.progress.message, 'Cancelled');
  assert.equal(restoredCancellation.health.status, 'cancelled');
  await assert.rejects(service.close(), { code: 'SERVICE_SHUTDOWN_UNCONFIRMED' });
});

test('real Chromium executes the full acceptance task and cleans up', {
  skip: process.env.TASKMASTER_REAL_BROWSER !== '1'
}, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-real-browser-'));
  const fixture = await readFile(path.resolve('test/fixtures/acceptance.html'));
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(fixture);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });

  const store = fakeProfileStore(root);
  store.profile.headless = true;
  const service = createTaskService({ stateDir: path.join(root, 'state'), profileStore: store });
  const address = server.address();
  const created = await service.create({
    profileId: 'profile_test',
    taskType: 'acceptance',
    idempotencyKey: 'legacy-real-browser-acceptance',
    input: {
      url: `http://127.0.0.1:${address.port}/acceptance`,
      uploadPath: path.resolve('test/fixtures/upload.txt')
    },
    timeoutMs: 60_000
  }, ADMIN);
  const terminal = await waitFor(async () => {
    const current = await service.get(created.id, ADMIN);
    return ['completed', 'failed', 'cancelled'].includes(current.state) && current.cleanup.settled
      ? current
      : null;
  }, 60_000);

  assert.equal(terminal.state, 'completed', JSON.stringify(terminal.error));
  assert.match(terminal.result.summary, /acceptance passed/i);
  assert.equal(terminal.cleanup.browserClosed, true);
  const artifacts = await service.listArtifacts(terminal.id, ADMIN);
  const reportArtifact = artifacts.find((artifact) => artifact.name === 'acceptance.json');
  assert.ok(reportArtifact);
  const reportChunk = await service.readArtifact(
    terminal.id,
    reportArtifact.id,
    { offset: 0, maxBytes: 48 * 1024 },
    ADMIN
  );
  assert.equal(reportChunk.encoding, 'utf8');
  assert.equal(reportChunk.eof, true);
  const report = JSON.parse(reportChunk.chunk);
  assert.equal(report.passed, true);
  assert.ok(report.evidence.every((item) => item.ok));
  await service.close();
});

test('a timed-out module cannot outlive its child or keep the Profile leased', {
  skip: process.env.TASKMASTER_REAL_BROWSER !== '1',
  timeout: 60_000
}, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-timeout-boundary-'));
  const modulePath = path.join(root, 'never-settles.mjs');
  await writeFile(modulePath, [
    "import { writeFileSync } from 'node:fs';",
    "import path from 'node:path';",
    'export async function run({ outputDir }) {',
    "  const tickPath = path.join(outputDir, 'ticks.txt');",
    '  let ticks = 1;',
    '  writeFileSync(tickPath, String(ticks));',
    "  setInterval(() => { ticks += 1; writeFileSync(tickPath, String(ticks)); }, 25);",
    '  await new Promise(() => {});',
    '}',
    ''
  ].join('\n'));
  const store = fakeProfileStore(root);
  store.profile.headless = true;
  const service = createTaskService({
    stateDir: path.join(root, 'state'),
    profileStore: store,
    allowedTaskRoots: [root],
    seedTaskTypes: [],
    diagnosticGraceMs: 250
  });
  t.after(async () => {
    await service.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  await service.installTaskType({ name: 'never-settles', modulePath }, ADMIN);
  const created = await service.create({
    profileId: 'profile_test',
    taskType: 'never-settles',
    idempotencyKey: 'timeout-process-boundary',
    timeoutMs: 10_000
  }, ADMIN);
  const terminal = await waitFor(async () => {
    const current = await service.get(created.id, ADMIN);
    return current.cleanup?.settled ? current : null;
  }, 30_000);
  assert.equal(terminal.state, 'failed');
  assert.equal(terminal.error.code, 'TASK_TIMEOUT');
  assert.equal(terminal.cleanup.browserClosed, true);
  assert.equal(terminal.cleanup.workerExited, true);
  assert.equal(store.profile.lease, null);

  const tickPath = path.join(root, 'state', created.id, 'output', 'ticks.txt');
  const atCleanup = Number(await readFile(tickPath, 'utf8'));
  assert.ok(atCleanup > 0);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(Number(await readFile(tickPath, 'utf8')), atCleanup);
});

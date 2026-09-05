import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { JsonStore } from '../src/lib/json-store.mjs';
import { ProfileStore } from '../src/lib/profile-store.mjs';
import { createTaskService } from '../src/runtime/task-service.mjs';
import { removeTestTree } from './test-fs.mjs';

class ContractWorker extends EventEmitter {
  constructor(pid, kind, alive) {
    super();
    this.pid = pid;
    this.kind = kind;
    this.alive = alive;
    this.connected = true;
    this.messages = [];
    this.resumeMode = 'accepted';
    alive.add(pid);
  }

  send(message, _handle, _options, callback) {
    this.messages.push(message);
    if (message.type === 'resume') this.emit('resume-requested');
    if (message.type === 'resume' && this.resumeMode === 'stalled-send') return;
    callback?.(null);
    if (message.type === 'start') this.config = message.config;
    if (message.type === 'open') queueMicrotask(() => this.emit('message', { type: 'ready' }));
    if (message.type === 'stop' || message.type === 'close') {
      queueMicrotask(() => this.finish('stopped'));
    }
    if (message.type !== 'resume' || this.resumeMode === 'missing-ack') return;
    this.emit('message', {
      type: 'resume_ack', requestId: message.requestId, waitId: message.waitId,
      accepted: this.resumeMode !== 'rejected',
      ...(this.resumeMode === 'rejected' ? { reason: 'TASK_PROBE_MISMATCH' } : {})
    });
    if (this.resumeMode === 'rejected' || this.resumeMode === 'ack-only') return;
    this.emit('message', { type: 'resumed', waitId: message.waitId });
    if (this.resumeMode === 'fast-exit') this.finish('finished');
  }

  finish(state = 'finished') {
    if (!this.alive.has(this.pid)) return;
    if (this.kind === 'profile') {
      this.emit('message', { type: 'closed', browserClosed: true });
    } else {
      this.emit('message', { type: 'state', state });
      this.emit('message', { type: 'cleanup', browserClosed: true });
    }
    this.alive.delete(this.pid);
    this.connected = false;
    this.exitCode = 0;
    this.signalCode = null;
    this.emit('exit', 0, null);
  }
}

async function fixture(t, serviceOptions = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-control-contract-'));
  const alive = new Set();
  const workers = [];
  const profileStore = new ProfileStore({
    filePath: path.join(root, 'profiles.json'), profilesRoot: path.join(root, 'profiles'),
    processAlive: (pid) => alive.has(pid)
  });
  await profileStore.init();
  const profile = await profileStore.create({ name: 'Contract' });
  const factory = (_file, kind) => {
    const worker = new ContractWorker(87000 + workers.length, kind, alive);
    workers.push(worker);
    return worker;
  };
  const service = createTaskService({
    stateDir: path.join(root, 'tasks'), profileStore,
    workerFactory: factory, profileWorkerFactory: factory,
    processAlive: (pid) => alive.has(pid), profileUsageProbe: async () => 'inactive',
    terminateTree: async (pid) => { workers.find((worker) => worker.pid === pid)?.finish('stopped'); return true; },
    stopWaitMs: 100, terminationWaitMs: 100, ...serviceOptions
  });
  t.after(async () => {
    await service.close();
    assert.equal(alive.size, 0, 'the isolated fixture must release all fake workers');
    await removeTestTree(root);
  });
  await service.list();
  const source = path.join(root, 'job.mjs');
  await writeFile(source, 'export async function run() { return "original"; }\n');
  return { root, profile, profileStore, service, source, workers, body: { modulePath: source, profileId: profile.id } };
}

async function waitingTask(env) {
  const task = await env.service.create(env.body);
  await env.service.get(task.id);
  const worker = env.workers.at(-1);
  worker.emit('message', { type: 'waiting', waiting: { id: 'wait_contract', reason: 'verification', probeId: 'probe_contract' } });
  assert.equal((await env.service.get(task.id)).state, 'waiting');
  return { task, worker };
}

test('request keys admit one task across concurrent, sequential and completed-task retries', async (t) => {
  const env = await fixture(t);
  const body = { ...env.body, requestKey: 'contract:submission', input: { a: 1, b: 2 } };
  const tasks = await Promise.all(Array.from({ length: 12 }, (_, index) => env.service.create({
    ...body, input: index % 2 ? { b: 2, a: 1 } : { a: 1, b: 2 }
  })));
  assert.equal(new Set(tasks.map((task) => task.id)).size, 1);
  assert.equal((await env.service.create(body)).id, tasks[0].id);
  assert.equal((await env.service.list()).length, 1);
  assert.equal(env.workers.length, 1);
  assert.equal(env.workers[0].messages.filter((message) => message.type === 'start').length, 1);
  env.workers[0].finish();
  assert.equal((await env.service.get(tasks[0].id)).state, 'finished');
  assert.equal((await env.service.create(body)).id, tasks[0].id);
  assert.equal(env.workers.length, 1, 'retrying a completed request must not repeat browser work');
});

test('a reused request key rejects changed input or source without admitting another task', async (t) => {
  const env = await fixture(t);
  const body = { ...env.body, requestKey: 'contract-conflict', input: { page: 1 } };
  await env.service.create(body);
  await assert.rejects(env.service.create({ ...body, input: { page: 2 } }), { code: 'TASK_REQUEST_CONFLICT' });
  await writeFile(env.source, 'export async function run() { return "edited"; }\n');
  await assert.rejects(env.service.create(body), { code: 'TASK_REQUEST_CONFLICT' });
  assert.equal((await env.service.list()).length, 1);
  assert.equal(env.workers.length, 1);
});

test('request fingerprint and staged execution use the same source snapshot when the source changes during submission', async (t) => {
  const env = await fixture(t);
  const original = await readFile(env.source);
  const edited = Buffer.from('export async function run() { return "edited during submission"; }\n');
  const recover = env.profileStore.recoverExpiredLeases.bind(env.profileStore);
  let changed = false;
  t.mock.method(env.profileStore, 'recoverExpiredLeases', async (...args) => {
    if (!changed) {
      changed = true;
      // This service boundary occurs after fingerprinting and before staging.
      await writeFile(env.source, edited);
    }
    return recover(...args);
  });
  const body = { ...env.body, requestKey: 'contract-source-snapshot' };
  const task = await env.service.create(body);
  await env.service.get(task.id);
  assert.equal(changed, true);
  assert.deepEqual(await readFile(env.source), edited);
  assert.deepEqual(await readFile(env.workers[0].config.modulePath), original, 'execution must use the fingerprinted bytes');
  const stored = JSON.parse(await readFile(path.join(env.root, 'tasks', 'tasks.json'), 'utf8')).tasks[0];
  assert.equal(stored.moduleSha256, createHash('sha256').update(original).digest('hex'));
  await assert.rejects(env.service.create(body), { code: 'TASK_REQUEST_CONFLICT' });
  await writeFile(env.source, original);
  assert.equal((await env.service.create(body)).id, task.id);
  assert.equal(env.workers.length, 1);
});

test('rejected and missing resume acknowledgements preserve waiting and release the command for a later retry', async (t) => {
  const env = await fixture(t, { resumeWaitMs: 80 });
  const { task, worker } = await waitingTask(env);
  // Keep real filesystem work outside the synthetic deadline. Hosted runners
  // can take longer than 80ms to persist an otherwise immediate resume.
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  t.after(() => t.mock.timers.reset());
  for (const [mode, code] of [
    ['rejected', 'TASK_PROBE_MISMATCH'], ['missing-ack', 'TASK_RESUME_UNCONFIRMED'],
    ['ack-only', 'TASK_RESUME_UNCONFIRMED'], ['stalled-send', 'TASK_RESUME_FAILED']
  ]) {
    worker.resumeMode = mode;
    const dispatched = new Promise((resolve) => worker.once('resume-requested', resolve));
    const attempt = env.service.resume(task.id, null, { probeId: 'probe_contract' });
    let settled = false;
    void attempt.then(() => { settled = true; }, () => { settled = true; });
    const rejected = assert.rejects(attempt, { code });
    await dispatched;
    await nextTurn(); // Let the delivery/acknowledgement timers arm.
    if (mode !== 'rejected') {
      t.mock.timers.tick(79);
      await nextTurn();
      assert.equal(settled, false, `${mode} must not time out before its deadline`);
      t.mock.timers.tick(1);
    }
    await rejected;
    assert.equal((await env.service.get(task.id)).state, 'waiting');
  }
  worker.resumeMode = 'accepted';
  assert.equal((await env.service.resume(task.id)).state, 'running', 'failed attempts must not leave a pending command lock');
});

test('a resume acknowledgement followed by immediate task exit reports the recorded completion', async (t) => {
  const env = await fixture(t);
  const { task, worker } = await waitingTask(env);
  worker.resumeMode = 'fast-exit';
  const resumed = await env.service.resume(task.id);
  assert.equal(resumed.state, 'finished');
  assert.equal((await env.service.get(task.id)).state, 'finished');
  const eventTypes = (await env.service.events(task.id)).events.map((event) => event.type);
  assert.ok(eventTypes.includes('task.resumed'));
  assert.ok(eventTypes.includes('task.finished'));
});

test('idle maintenance atomically prevents concurrently queued task and Profile admission', async (t) => {
  const env = await fixture(t);
  const outcomes = await Promise.allSettled([
    env.service.prepareIdleStop(),
    env.service.create(env.body),
    env.service.openProfile(env.profile.id),
    env.service.createProfile({ name: 'Must not be admitted' })
  ]);
  assert.equal(outcomes[0].status, 'fulfilled');
  for (const result of outcomes.slice(1)) {
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason.code, 'MANAGER_STOPPING');
  }
  assert.equal(env.workers.length, 0);
  assert.equal((await env.profileStore.list()).length, 1);
});

test('an admitted task prevents competing idle maintenance without interrupting its worker', async (t) => {
  const env = await fixture(t);
  const outcomes = await Promise.allSettled([env.service.create(env.body), env.service.prepareIdleStop()]);
  assert.equal(outcomes[0].status, 'fulfilled');
  assert.equal(outcomes[1].status, 'rejected');
  assert.equal(outcomes[1].reason.code, 'MANAGER_BUSY');
  assert.equal((await env.service.get(outcomes[0].value.id)).state, 'running');
  assert.equal(env.workers[0].messages.some((message) => message.type === 'stop'), false);
});

test('an opening manual Profile prevents competing idle maintenance and remains available', async (t) => {
  const env = await fixture(t);
  const outcomes = await Promise.allSettled([env.service.openProfile(env.profile.id), env.service.prepareIdleStop()]);
  assert.equal(outcomes[0].status, 'fulfilled');
  assert.equal(outcomes[1].status, 'rejected');
  assert.equal(outcomes[1].reason.code, 'MANAGER_BUSY');
  assert.equal((await env.profileStore.get(env.profile.id)).lease.kind, 'manual');
  assert.equal(env.workers[0].messages.some((message) => message.type === 'close'), false);
  assert.equal((await env.service.openProfile(env.profile.id)).status, 'open');
  assert.equal(env.workers.length, 1, 'repeat open returns the existing window');
});

test('the existing reaper completes containment and releases the Profile after a transient state-write outage', async (t) => {
  const env = await fixture(t, { reaperIntervalMs: 10 });
  const task = await env.service.create(env.body);
  await env.service.get(task.id);
  const worker = env.workers[0];
  const replace = JsonStore.prototype.replace;
  let failures = 0;
  t.mock.method(JsonStore.prototype, 'replace', async function (value) {
    if (this.filePath === path.join(env.root, 'tasks', 'tasks.json') && failures < 2) {
      failures += 1;
      // Lose the triggering event write and the first containment write only.
      // All later storage operations work normally.
      throw Object.assign(new Error('transient state-file sharing failure'), { code: 'EPERM' });
    }
    return replace.call(this, value);
  });
  const exited = new Promise((resolve) => worker.once('exit', resolve));
  worker.emit('message', { type: 'event', event: { type: 'contract.trigger' } });
  let timer;
  try {
    await Promise.race([
      exited,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('reaper did not recover containment after writes resumed')), 3_000);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
  const finalTask = await env.service.get(task.id);
  assert.equal(failures, 2);
  assert.ok(['stopped', 'error'].includes(finalTask.state));
  assert.equal(worker.messages.filter((message) => message.type === 'stop').length, 1, 'the recovered path dispatches one stop');
  const released = await env.profileStore.get(env.profile.id);
  assert.equal(released.lease, null);
  assert.equal(released.state, 'idle');
});

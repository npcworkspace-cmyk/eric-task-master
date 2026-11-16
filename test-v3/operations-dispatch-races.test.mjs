import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createOperationsService } from '../src/runtime/operations-service.mjs';
import { removeTestTree } from './test-fs.mjs';

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function bounded(promise) { let timer; try { return await Promise.race([promise, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('dispatch race did not settle')), 1000); })]); } finally { clearTimeout(timer); } }
async function fixture(t) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'etm-dispatch-races-'));
  const tasks = new Map(), sends = [], controls = [], releases = [], pending = new Set();
  let ready, created = 0, resume;
  resume = async (id, envelope, options) => { sends.push({ id, commandId: envelope.commandId, waitId: options.waitId }); tasks.get(id).state = 'running'; };
  const taskService = {
    createOperation: async () => { const task = { id: `task-${++created}`, state: 'waiting', waiting: { id: `wait-${created}`, reason: 'operations-command' } }; tasks.set(task.id, task); return structuredClone(task); },
    get: async id => structuredClone(tasks.get(id)),
    resume: (...args) => resume(...args),
    stop: async id => { tasks.get(id).state = 'stopped'; },
    operationControl: async (id, control) => { controls.push({ id, control }); return true; },
    setOperationReadyHandler: handler => { ready = handler; }, setOperationDurableHandler() {}
  };
  const service = await createOperationsService({ stateDir, taskService, profileStore: { getDefault: async () => ({ id: 'profile-test', modePolicy: 'auto' }) }, tickMs: 60000 });
  t.after(async () => { for (const release of releases) release(); await Promise.allSettled([...pending]); await service.close(); await removeTestTree(stateDir); });
  return { service, tasks, sends, controls, created: () => created, ready: id => ready?.(id), setResume: value => { resume = value; },
    releaseOnCleanup: release => releases.push(release), track: promise => { pending.add(promise); promise.finally(() => pending.delete(promise)).catch(() => {}); return promise; } };
}

test('A result clearing pending does not let B overlap the still-held A resume acknowledgement', async t => {
  const f = await fixture(t), op = await f.service.start({ goal: 'Serialized resume acknowledgements', mode: 'operations' });
  const enteredA = deferred(), releaseA = deferred(), enteredB = deferred();
  f.releaseOnCleanup(releaseA.resolve);
  let activeResume = false;
  f.setResume(async (taskId, envelope, options) => {
    assert.equal(activeResume, false, 'a second resume must not race TaskService pendingResumes cleanup');
    activeResume = true;
    try {
      assert.equal(options.waitId, f.tasks.get(taskId).waiting.id);
      f.sends.push({ commandId: envelope.commandId, waitId: options.waitId });
      f.tasks.get(taskId).state = 'running';
      await f.service.durable(taskId, 'command-result', { commandId: envelope.commandId, status: 'confirmed' });
      if (envelope.commandId === 'A') {
        Object.assign(f.tasks.get(taskId), { state: 'waiting', waiting: { id: 'wait-B', reason: 'operations-command' } });
        enteredA.resolve(); await releaseA.promise;
      } else enteredB.resolve();
    } finally { activeResume = false; }
  });
  const first = f.track(f.service.command(op.id, { commandId: 'A', kind: 'observe' }));
  await bounded(enteredA.promise);
  const second = await f.service.command(op.id, { commandId: 'B', kind: 'observe' });
  assert.equal(second.delivered, false, 'B must use the ordinary queued handoff while A owns the dispatch gate');
  await f.ready(op.taskId);
  assert.deepEqual(f.sends.map(item => item.commandId), ['A']);
  releaseA.resolve(); await first; await bounded(enteredB.promise);
  assert.deepEqual(f.sends.map(item => item.commandId), ['A', 'B']);
  assert.equal((await f.service.get(op.id, { commandId: 'B' })).command.status, 'confirmed');
  assert.equal(f.controls.length, 0, 'resume queue cleanup must not manufacture an unknown result or pause');
});

test('fallback handoff preserves a committed result when its resume acknowledgement is lost', async t => {
  const f = await fixture(t), op = await f.service.start({ goal: 'Fallback terminal truth', mode: 'operations' });
  f.tasks.get(op.taskId).state = 'running';
  const reserved = await f.service.command(op.id, { commandId: 'fallback', kind: 'observe' });
  assert.equal(reserved.delivered, false);
  f.setResume(async (taskId, envelope) => {
    f.sends.push({ commandId: envelope.commandId });
    await f.service.durable(taskId, 'command-result', { commandId: envelope.commandId, status: 'confirmed', text: 'actual committed result' });
    throw Object.assign(new Error('ACK lost after durable result'), { code: 'ACK_LOST' });
  });
  Object.assign(f.tasks.get(op.taskId), { state: 'waiting', waiting: { id: 'fallback-wait', reason: 'operations-command' } });
  await f.ready(op.taskId);
  const current = await f.service.get(op.id, { commandId: 'fallback' });
  assert.equal(current.command.status, 'confirmed');
  assert.equal(current.command.reply.text, 'actual committed result');
  assert.equal(current.status, 'running');
  assert.equal(f.controls.length, 0);
  await f.ready(op.taskId);
  assert.equal(f.sends.length, 1);
});

for (const action of ['stop', 'revoke']) test(`a duplicate old receipt after ${action} cannot recreate a Worker or reopen its Profile`, async t => {
  const f = await fixture(t), op = await f.service.start({ goal: 'Receipt idempotence after stop', mode: 'operations' });
  const body = { commandId: 'receipt-only', kind: 'observe' };
  await f.service.command(op.id, body);
  await f.service.durable(op.taskId, 'command-result', { commandId: body.commandId, status: 'confirmed' });
  await f.service.action(op.id, { action });
  const before = f.created(), sends = f.sends.length;
  const duplicate = await f.service.command(op.id, body);
  assert.equal(duplicate.status, 'confirmed');
  assert.equal(f.created(), before);
  assert.equal(f.sends.length, sends);
  assert.equal((await f.service.get(op.id)).status, action === 'stop' ? 'stopped' : 'revoked');
});

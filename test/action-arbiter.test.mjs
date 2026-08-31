import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import test from 'node:test';

import { createActionArbiter } from '../src/lib/action-arbiter.mjs';
import { createCooperativePauseGate } from '../src/runtime/task-worker.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('action arbiter runs concurrent callers in strict FIFO order with one active action', async () => {
  const arbiter = createActionArbiter();
  const firstMayFinish = deferred();
  const firstStarted = deferred();
  const events = [];
  let active = 0;
  let maximumActive = 0;

  const first = arbiter.run('first', async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    events.push('first:start');
    firstStarted.resolve();
    await firstMayFinish.promise;
    events.push('first:end');
    active -= 1;
  });
  const second = arbiter.run('second', async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    events.push('second:start');
    events.push('second:end');
    active -= 1;
  });

  await firstStarted.promise;
  assert.deepEqual(events, ['first:start']);
  firstMayFinish.resolve();
  await Promise.all([first, second]);

  assert.deepEqual(events, ['first:start', 'first:end', 'second:start', 'second:end']);
  assert.equal(maximumActive, 1);
  assert.deepEqual(arbiter.audit(), {
    issued: 2,
    started: 2,
    completed: 2,
    failed: 0,
    pending: 0,
    active: 0,
    maximumActive: 1,
    maximumQueueDepth: 2,
    accepting: true,
    serialized: true
  });
});

test('action arbiter releases the queue after failure and never starts queued work after abort', async () => {
  const controller = new AbortController();
  const arbiter = createActionArbiter({ signal: controller.signal });
  const releaseFirst = deferred();
  const firstStarted = deferred();
  const events = [];
  const first = arbiter.run('first', async () => {
    events.push('first');
    firstStarted.resolve();
    await releaseFirst.promise;
    throw Object.assign(new Error('first failed'), { code: 'FIRST_FAILED' });
  });
  const second = arbiter.run('second', async () => events.push('second'));
  const firstRejected = assert.rejects(first, { code: 'FIRST_FAILED' });
  const secondRejected = assert.rejects(second, { code: 'TASK_CANCELLED' });
  await firstStarted.promise;
  controller.abort(Object.assign(new Error('cancelled'), { code: 'TASK_CANCELLED' }));
  releaseFirst.resolve();

  await Promise.all([firstRejected, secondRejected]);
  assert.deepEqual(events, ['first']);
  assert.equal(arbiter.audit().maximumActive, 1);
});

test('completion seals the queue, waits admitted work, and rejects late actions', async () => {
  const arbiter = createActionArbiter();
  const release = deferred();
  const started = deferred();
  const action = arbiter.run('admitted', async () => {
    started.resolve();
    await release.promise;
  });
  await started.promise;
  let completionSettled = false;
  const completion = arbiter.beforeCompletion().then(() => { completionSettled = true; });
  await Promise.resolve();
  assert.equal(completionSettled, false);
  await assert.rejects(
    arbiter.run('late', async () => {}),
    { code: 'TASK_ACTION_AFTER_COMPLETION' }
  );
  release.resolve();
  await Promise.all([action, completion]);
  assert.equal(arbiter.audit().accepting, false);
  assert.equal(arbiter.audit().active, 0);
  assert.equal(arbiter.audit().pending, 0);
});

test('seal rejects late actions before the admitted queue is drained', async () => {
  const gate = deferred();
  const arbiter = createActionArbiter();
  const admitted = arbiter.run('admitted', async () => gate.promise);
  arbiter.seal();
  await assert.rejects(
    arbiter.run('late', async () => {}),
    { code: 'TASK_ACTION_AFTER_COMPLETION' }
  );
  gate.resolve('done');
  assert.equal(await admitted, 'done');
  await arbiter.beforeCompletion();
});

test('a reservation admitted before seal executes afterward and remains part of completion drain', async () => {
  const arbiter = createActionArbiter();
  const firstMayFinish = deferred();
  const firstStarted = deferred();
  const events = [];
  const first = arbiter.run('first', async () => {
    events.push('first');
    firstStarted.resolve();
    await firstMayFinish.promise;
  });
  await firstStarted.promise;
  const admitted = arbiter.reserve('admitted-before-seal');
  const second = admitted.execute(async () => events.push('second'));
  arbiter.seal();
  await assert.rejects(
    arbiter.run('late', async () => {}),
    { code: 'TASK_ACTION_AFTER_COMPLETION' }
  );
  let completionSettled = false;
  const completion = arbiter.beforeCompletion().then(() => { completionSettled = true; });
  await Promise.resolve();
  assert.equal(completionSettled, false);
  firstMayFinish.resolve();
  await Promise.all([first, second, completion]);
  assert.deepEqual(events, ['first', 'second']);
  assert.equal(arbiter.audit().issued, 2);
  assert.equal(arbiter.audit().completed, 2);
});

test('cancelling a reserved action releases its FIFO position only after prior work settles', async () => {
  const arbiter = createActionArbiter();
  const releaseFirst = deferred();
  const firstStarted = deferred();
  const first = arbiter.run('first', async () => {
    firstStarted.resolve();
    await releaseFirst.promise;
  });
  await firstStarted.promise;
  const cancelled = arbiter.reserve('cancelled');
  const later = arbiter.reserve('later');
  let laterRan = false;
  const cancellation = cancelled.cancel();
  const laterExecution = later.execute(async () => { laterRan = true; });
  await Promise.resolve();
  assert.equal(laterRan, false);
  releaseFirst.resolve();
  assert.equal(await cancellation, true);
  await Promise.all([first, laterExecution]);
  assert.equal(laterRan, true);
  assert.equal(arbiter.audit().pending, 0);
});

test('nested actions in the same async chain fail fast instead of deadlocking', async () => {
  const arbiter = createActionArbiter();
  await assert.rejects(
    arbiter.run('outer', () => arbiter.run('inner', async () => {})),
    { code: 'TASK_ACTION_REENTRANT' }
  );
  assert.equal(arbiter.audit().active, 0);
  assert.equal(arbiter.audit().pending, 0);
});

test('completion drain is bounded when admitted task code never settles', async () => {
  const arbiter = createActionArbiter();
  const release = deferred();
  const started = deferred();
  const action = arbiter.run('stuck', async () => {
    started.resolve();
    await release.promise;
  });
  await started.promise;
  await assert.rejects(
    arbiter.beforeCompletion({ timeoutMs: 100 }),
    { code: 'TASK_ACTION_QUEUE_UNSETTLED' }
  );
  release.resolve();
  await action;
});

test('pause settles the complete active action and blocks queued actions until resume', async () => {
  const controller = new AbortController();
  const transitions = [];
  const gate = createCooperativePauseGate({
    signal: controller.signal,
    onState: async (state) => transitions.push(state),
    onPaused: async () => transitions.push('diagnostic'),
    onResumeValidate: async () => transitions.push('validated')
  });
  const arbiter = createActionArbiter({ signal: controller.signal });
  const releaseFirst = deferred();
  const firstStarted = deferred();
  const events = [];
  const run = (name, callback) => arbiter.run(name, () => gate.run(callback));

  const first = run('first', async () => {
    events.push('first:start');
    firstStarted.resolve();
    await releaseFirst.promise;
    events.push('first:end');
  });
  const second = run('second', async () => events.push('second'));
  await firstStarted.promise;
  const pause = gate.requestPause('pause-1');
  releaseFirst.resolve();
  await pause;
  await first;
  assert.equal(gate.state, 'paused');
  assert.deepEqual(events, ['first:start', 'first:end']);
  await gate.requestResume('resume-1');
  await second;

  assert.deepEqual(events, ['first:start', 'first:end', 'second']);
  assert.deepEqual(transitions, [
    'pause_requested', 'diagnostic', 'paused', 'recovering', 'validated', 'running'
  ]);
  assert.equal(arbiter.audit().maximumActive, 1);
});

test('pause seal rejects late controls but lets an already-admitted pause resume', async () => {
  const transitions = [];
  const gate = createCooperativePauseGate({
    onState: async (state) => transitions.push(state),
    onPaused: async () => transitions.push('diagnostic'),
    onResumeValidate: async () => transitions.push('validated')
  });

  const admittedPause = gate.requestPause('admitted-pause');
  gate.seal();
  await admittedPause;
  assert.equal(gate.state, 'paused');
  await assert.rejects(
    gate.requestPause('late-pause'),
    { code: 'TASK_CONTROL_AFTER_COMPLETION' }
  );
  await gate.requestResume('resume-admitted');
  assert.equal(gate.state, 'running');
  assert.deepEqual(transitions, [
    'pause_requested', 'diagnostic', 'paused', 'recovering', 'validated', 'running'
  ]);
});

test('cancellation permanently prevents a late active action from publishing paused', async () => {
  const controller = new AbortController();
  const transitions = [];
  const gate = createCooperativePauseGate({
    signal: controller.signal,
    onState: async (state) => transitions.push(state),
    onPaused: async () => transitions.push('diagnostic')
  });
  const releaseAction = await gate.acquire();
  const pause = gate.requestPause('cancelled-pause').then(() => null, (error) => error);
  await Promise.resolve();
  assert.deepEqual(transitions, ['pause_requested']);
  controller.abort(Object.assign(new Error('cancelled'), { code: 'TASK_CANCELLED' }));
  await releaseAction();
  assert.equal((await pause)?.code, 'TASK_CANCELLED');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(transitions, ['pause_requested']);
  assert.equal(gate.state, 'running');
});

test('cancellation during resume validation cannot publish a late running state', async () => {
  const controller = new AbortController();
  const validationStarted = deferred();
  const finishValidation = deferred();
  const transitions = [];
  let resumed = 0;
  const gate = createCooperativePauseGate({
    signal: controller.signal,
    onState: async (state) => transitions.push(state),
    onResumeValidate: async () => {
      validationStarted.resolve();
      await finishValidation.promise;
    },
    onResumed: async () => { resumed += 1; }
  });

  await gate.requestPause('pause-before-cancel');
  const resume = gate.requestResume('resume-before-cancel');
  await validationStarted.promise;
  controller.abort(Object.assign(new Error('cancelled'), { code: 'TASK_CANCELLED' }));
  finishValidation.resolve();

  await assert.rejects(resume, { code: 'TASK_CANCELLED' });
  assert.equal(resumed, 0);
  assert.deepEqual(transitions, ['pause_requested', 'paused', 'recovering']);
  assert.equal(gate.state, 'running');
});

test('pause requested after completion seal cannot publish a paused state', async () => {
  const transitions = [];
  const gate = createCooperativePauseGate({
    onState: async (state) => transitions.push(state),
    onPaused: async () => transitions.push('diagnostic')
  });
  gate.seal();
  await assert.rejects(gate.requestPause('late'), { code: 'TASK_CONTROL_AFTER_COMPLETION' });
  assert.equal(gate.state, 'running');
  assert.deepEqual(transitions, []);
});

test('repeated pause and resume removes settled abort listeners', async () => {
  const controller = new AbortController();
  const gate = createCooperativePauseGate({ signal: controller.signal });
  const baseline = getEventListeners(controller.signal, 'abort').length;
  for (let index = 0; index < 20; index += 1) {
    await gate.requestPause(`pause-${index}`);
    const waiting = gate.waitIfPaused();
    await gate.requestResume(`resume-${index}`);
    await waiting;
  }
  assert.equal(getEventListeners(controller.signal, 'abort').length, baseline);
});

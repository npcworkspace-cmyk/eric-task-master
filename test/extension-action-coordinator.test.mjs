import assert from 'node:assert/strict';
import test from 'node:test';

import { createExtensionActionCoordinator } from '../src/lib/extension-action-coordinator.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function coordinatorHarness() {
  let bridge = null;
  const frame = {};
  const listeners = new Map();
  const page = {
    async evaluate() {},
    mainFrame() { return frame; },
    on(name, callback) { listeners.set(name, callback); },
    off(name) { listeners.delete(name); }
  };
  const context = {
    async exposeBinding(_name, callback) { bridge = callback; },
    async addInitScript() {},
    pages() { return [page]; }
  };
  return {
    context,
    page,
    invoke(payload) {
      if (!bridge) throw new Error('bridge not installed');
      return bridge({}, payload);
    },
    navigate() {
      listeners.get('framenavigated')?.(frame);
    }
  };
}

test('cooperative extension lease and Task Master actions share one FIFO boundary', async () => {
  const harness = coordinatorHarness();
  const coordinator = await createExtensionActionCoordinator({
    context: harness.context,
    page: harness.page,
    enabled: true
  });
  const events = [];

  const extension = await harness.invoke({
    kind: 'request',
    participantId: 'acceptance-extension',
    requestId: 'extension-first',
    operation: 'click',
    durationMs: 1_000
  });
  assert.equal(extension.ok, true);
  const task = coordinator.run('task-click', async () => events.push('task'));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(events, []);
  assert.equal((await harness.invoke({
    kind: 'release',
    participantId: 'acceptance-extension',
    leaseId: extension.leaseId
  })).ok, true);
  await task;

  const releaseTask = deferred();
  const taskStarted = deferred();
  const secondTask = coordinator.run('task-type', async () => {
    events.push('task:start');
    taskStarted.resolve();
    await releaseTask.promise;
    events.push('task:end');
  });
  await taskStarted.promise;
  let extensionGranted = false;
  const waitingExtension = harness.invoke({
    kind: 'request',
    participantId: 'acceptance-extension',
    requestId: 'task-first',
    operation: 'scroll',
    durationMs: 1_000
  }).then((value) => {
    extensionGranted = true;
    return value;
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(extensionGranted, false);
  releaseTask.resolve();
  await secondTask;
  const secondExtension = await waitingExtension;
  assert.equal(secondExtension.ok, true);
  await harness.invoke({
    kind: 'release',
    participantId: 'acceptance-extension',
    leaseId: secondExtension.leaseId
  });

  const audit = coordinator.audit();
  assert.equal(audit.maximumActive, 1);
  assert.equal(audit.serialized, true);
  assert.equal(audit.taskLeases, 2);
  assert.equal(audit.extensionLeases, 2);
  await coordinator.beforeCompletion();
  assert.deepEqual(await harness.invoke({
    kind: 'request',
    participantId: 'acceptance-extension',
    requestId: 'too-late',
    operation: 'click',
    durationMs: 1_000
  }), { ok: false, reason: 'task-finishing' });
  await coordinator.close();
});

test('cooperative request IDs are idempotent and cannot replay after release', async () => {
  const harness = coordinatorHarness();
  const coordinator = await createExtensionActionCoordinator({
    context: harness.context,
    page: harness.page,
    enabled: true
  });
  const request = {
    kind: 'request',
    participantId: 'stable-extension',
    requestId: 'one-action',
    operation: 'input',
    durationMs: 1_000
  };
  const first = await harness.invoke(request);
  const duplicate = await harness.invoke(request);
  assert.equal(first.ok, true);
  assert.deepEqual(duplicate, { ok: false, reason: 'request-duplicate' });
  assert.equal(coordinator.audit().extensionLeases, 1);
  assert.equal(coordinator.audit().duplicateRequests, 1);
  assert.equal((await harness.invoke({
    kind: 'release', participantId: request.participantId, leaseId: first.leaseId
  })).ok, true);
  assert.deepEqual(await harness.invoke(request), { ok: false, reason: 'request-settled' });
  assert.equal(coordinator.audit().extensionLeases, 1);
  assert.equal(coordinator.audit().duplicateRequests, 2);
  await coordinator.close();
});

test('bounded request history rejects capacity instead of forgetting settled IDs', async () => {
  const harness = coordinatorHarness();
  const coordinator = await createExtensionActionCoordinator({
    context: harness.context,
    page: harness.page,
    enabled: true,
    maxRequestRecords: 32
  });
  for (let index = 0; index < 32; index += 1) {
    const lease = await harness.invoke({
      kind: 'request',
      participantId: 'capacity-extension',
      requestId: `request-${index}`,
      operation: 'click',
      durationMs: 1_000
    });
    assert.equal(lease.ok, true);
    assert.equal((await harness.invoke({
      kind: 'release', participantId: 'capacity-extension', leaseId: lease.leaseId
    })).ok, true);
  }
  assert.deepEqual(await harness.invoke({
    kind: 'request',
    participantId: 'capacity-extension',
    requestId: 'request-over-capacity',
    operation: 'click',
    durationMs: 1_000
  }), { ok: false, reason: 'request-capacity' });
  assert.deepEqual(await harness.invoke({
    kind: 'request',
    participantId: 'capacity-extension',
    requestId: 'request-0',
    operation: 'click',
    durationMs: 1_000
  }), { ok: false, reason: 'request-settled' });
  assert.equal(coordinator.audit().extensionLeases, 32);
  assert.equal(coordinator.audit().requestCapacityRejects, 1);
  assert.equal(coordinator.audit().duplicateRequests, 1);
  await coordinator.close();
});

test('extension navigation releases its cooperative lease without waiting for expiry', async () => {
  const harness = coordinatorHarness();
  const coordinator = await createExtensionActionCoordinator({
    context: harness.context,
    page: harness.page,
    enabled: true,
    extensionLeaseMs: 5_000
  });
  const extension = await harness.invoke({
    kind: 'request',
    participantId: 'navigating-extension',
    requestId: 'navigate-once',
    operation: 'navigation',
    durationMs: 5_000
  });
  assert.equal(extension.ok, true);
  let taskStarted = false;
  const task = coordinator.run('task-after-navigation', async () => { taskStarted = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(taskStarted, false);
  harness.navigate();
  await task;
  assert.equal(taskStarted, true);
  assert.equal(coordinator.audit().navigationReleases, 1);
  assert.equal(coordinator.audit().leaseTimeouts, 0);
  await coordinator.close();
});

test('ordinary page-script events are not guessed to be extension actions', async () => {
  const harness = coordinatorHarness();
  const coordinator = await createExtensionActionCoordinator({
    context: harness.context,
    page: harness.page,
    enabled: true
  });
  let taskEffects = 0;
  await coordinator.run('click', async () => {
    taskEffects += 1;
    assert.deepEqual(await harness.invoke({ kind: 'external-event', eventType: 'click' }), {
      ok: false,
      reason: 'unsupported-message'
    });
  });
  assert.equal(taskEffects, 1);
  assert.equal(coordinator.audit().conflicts, 0);
  await coordinator.close();
});

test('an expired extension lease poisons the queue before any waiting Task action can start', async () => {
  const harness = coordinatorHarness();
  const coordinator = await createExtensionActionCoordinator({
    context: harness.context,
    page: harness.page,
    enabled: true,
    extensionLeaseMs: 250,
    taskWaitMs: 1_000
  });
  const extension = await harness.invoke({
    kind: 'request',
    participantId: 'stalled-extension',
    requestId: 'stale-grant',
    operation: 'click',
    durationMs: 250
  });
  assert.equal(extension.ok, true);
  let taskStarted = false;
  const taskOutcome = coordinator.run('must-not-start', async () => {
    taskStarted = true;
  }).then(() => null, (error) => error);
  const taskError = await taskOutcome;
  assert.equal(taskStarted, false);
  assert.equal(taskError?.code, 'BROWSER_ACTION_CONFLICT');
  assert.deepEqual(await harness.invoke({
    kind: 'validate',
    participantId: 'stalled-extension',
    requestId: 'stale-grant',
    leaseId: extension.leaseId
  }), { ok: false });
  await assert.rejects(
    coordinator.run('future-task', async () => {}),
    { code: 'BROWSER_ACTION_CONFLICT' }
  );
  assert.equal(coordinator.audit().leaseTimeouts, 1);
  assert.equal(coordinator.audit().healthy, false);
  assert.equal(coordinator.audit().serialized, true);
  await coordinator.close();
});

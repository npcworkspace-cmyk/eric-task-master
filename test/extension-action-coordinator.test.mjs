import assert from 'node:assert/strict';
import test from 'node:test';

import { createActionArbiter } from '../src/lib/action-arbiter.mjs';
import { createExtensionActionCoordinator } from '../src/lib/extension-action-coordinator.mjs';
import { createCooperativePauseGate } from '../src/runtime/task-worker.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function eventually(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('condition did not become true before the deadline');
}

function checkpointCompletion(coordinator, receipt, suffix = 'a') {
  const context = coordinator.checkpointContext();
  assert.equal(context?.receiptId, receipt.receiptId);
  assert.equal(context?.participantId, receipt.participantId);
  assert.equal(context?.requestId, receipt.requestId);
  assert.equal(context?.operation, receipt.operation);
  return coordinator.checkpointCompleted(receipt.receiptId, {
    attempt: 1,
    savedAt: '2026-08-31T12:00:00.000Z',
    sha256: suffix.repeat(64),
    sizeBytes: 128
  });
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
    },
    closePage() {
      listeners.get('close')?.();
    }
  };
}

function runProductionTask({ coordinator, gate, arbiter }, operation, callback) {
  const reservation = arbiter.reserve(operation);
  return coordinator.run(operation, () => reservation.execute(() => gate.run(callback))).catch(
    async (error) => {
      await reservation.cancel();
      throw error;
    }
  );
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

test('production pause boundary preserves extension-first FIFO arrival against a same-tick Task action', async () => {
  const harness = coordinatorHarness();
  const gate = createCooperativePauseGate();
  const arbiter = createActionArbiter();
  const coordinator = await createExtensionActionCoordinator({
    context: harness.context,
    page: harness.page,
    enabled: true,
    acquireExtensionBoundary: ({ signal } = {}) => gate.acquire({ signal })
  });
  const events = [];
  const extensionRequest = harness.invoke({
    kind: 'request',
    participantId: 'fifo-extension',
    requestId: 'fifo-extension-first',
    operation: 'click',
    durationMs: 1_000
  }).then((result) => {
    events.push('extension-granted');
    return result;
  });
  const task = runProductionTask({ coordinator, gate, arbiter }, 'fifo-task-second', async () => {
    events.push('task-ran');
  });

  const extension = await extensionRequest;
  assert.equal(extension.ok, true);
  assert.deepEqual(events, ['extension-granted']);
  await harness.invoke({
    kind: 'release',
    participantId: 'fifo-extension',
    leaseId: extension.leaseId,
    outcome: { status: 'succeeded', code: 'fifo-released', facts: [] }
  });
  await task;
  assert.deepEqual(events, ['extension-granted', 'task-ran']);
  assert.equal(coordinator.audit().maximumActive, 1);
  await coordinator.close();
});

test('production pause boundary preserves Task-first FIFO arrival against a same-tick extension action', async () => {
  const harness = coordinatorHarness();
  const gate = createCooperativePauseGate();
  const arbiter = createActionArbiter();
  const coordinator = await createExtensionActionCoordinator({
    context: harness.context,
    page: harness.page,
    enabled: true,
    acquireExtensionBoundary: ({ signal } = {}) => gate.acquire({ signal })
  });
  const events = [];
  const releaseTask = deferred();
  const taskStarted = deferred();
  const task = runProductionTask({ coordinator, gate, arbiter }, 'fifo-task-first', async () => {
    events.push('task');
    taskStarted.resolve();
    await releaseTask.promise;
  });
  const extensionRequest = harness.invoke({
    kind: 'request',
    participantId: 'fifo-extension',
    requestId: 'fifo-task-first-extension-second',
    operation: 'click',
    durationMs: 1_000
  }).then((result) => {
    events.push('extension');
    return result;
  });

  await taskStarted.promise;
  assert.deepEqual(events, ['task']);
  releaseTask.resolve();
  await task;
  const extension = await extensionRequest;
  assert.equal(extension.ok, true);
  assert.deepEqual(events, ['task', 'extension']);
  await harness.invoke({
    kind: 'release',
    participantId: 'fifo-extension',
    leaseId: extension.leaseId,
    outcome: { status: 'succeeded', code: 'fifo-released', facts: [] }
  });
  assert.equal(coordinator.audit().maximumActive, 1);
  await coordinator.close();
});

test('production Task and extension admission remains bidirectional FIFO across 200 same-tick rounds', async () => {
  const harness = coordinatorHarness();
  const gate = createCooperativePauseGate();
  const arbiter = createActionArbiter();
  const coordinator = await createExtensionActionCoordinator({
    context: harness.context,
    page: harness.page,
    enabled: true,
    acquireExtensionBoundary: ({ signal } = {}) => gate.acquire({ signal })
  });

  for (let index = 0; index < 200; index += 1) {
    const events = [];
    const runTask = () => runProductionTask(
      { coordinator, gate, arbiter },
      `stress-task-${index}`,
      async () => {
      events.push('T');
      }
    );
    const runExtension = () => harness.invoke({
      kind: 'request',
      participantId: 'fifo-stress-extension',
      requestId: `stress-extension-${index}`,
      operation: 'scroll',
      durationMs: 1_000
    }).then(async (lease) => {
      assert.equal(lease.ok, true);
      events.push('E');
      await harness.invoke({
        kind: 'release',
        participantId: 'fifo-stress-extension',
        leaseId: lease.leaseId,
        outcome: { status: 'succeeded', code: 'stress-released', facts: [] }
      });
    });
    const extensionFirst = index % 2 === 0;
    const first = extensionFirst ? runExtension() : runTask();
    const second = extensionFirst ? runTask() : runExtension();
    await Promise.all([first, second]);
    assert.equal(events.join(''), extensionFirst ? 'ET' : 'TE', `round ${index}`);
  }

  assert.equal(coordinator.audit().maximumActive, 1);
  await coordinator.close();
});

test('production FIFO matches 500 seeded mixed Task and extension admission rounds', async () => {
  let seed = 0x5eed1234;
  const next = () => {
    seed = ((seed * 1_664_525) + 1_013_904_223) >>> 0;
    return seed;
  };

  for (let round = 0; round < 500; round += 1) {
    const harness = coordinatorHarness();
    const gate = createCooperativePauseGate();
    const arbiter = createActionArbiter();
    const coordinator = await createExtensionActionCoordinator({
      context: harness.context,
      page: harness.page,
      enabled: true,
      acquireExtensionBoundary: ({ signal } = {}) => gate.acquire({ signal })
    });
    const count = 2 + (next() % 7);
    const expected = [];
    const observed = [];
    const operations = [];
    for (let index = 0; index < count; index += 1) {
      const label = `${round}:${index}`;
      expected.push(label);
      if ((next() & 1) === 0) {
        operations.push(runProductionTask(
          { coordinator, gate, arbiter },
          `seeded-task-${round}-${index}`,
          async () => { observed.push(label); }
        ));
      } else {
        operations.push(harness.invoke({
          kind: 'request',
          participantId: `seeded-extension-${round}`,
          requestId: `seeded-request-${round}-${index}`,
          operation: 'click',
          durationMs: 1_000
        }).then(async (lease) => {
          assert.equal(lease.ok, true, `round ${round} item ${index}`);
          observed.push(label);
          assert.equal((await harness.invoke({
            kind: 'release',
            participantId: `seeded-extension-${round}`,
            leaseId: lease.leaseId
          })).ok, true);
        }));
      }
    }
    await Promise.all(operations);
    assert.deepEqual(observed, expected, `round ${round}`);
    const audit = coordinator.audit();
    assert.equal(audit.maximumActive, 1, `round ${round}`);
    assert.equal(audit.active, 0, `round ${round}`);
    assert.equal(audit.pending, 0, `round ${round}`);
    await coordinator.close();
  }
});

test('Task FIFO wait does not expire behind a valid long Task action', async () => {
  const harness = coordinatorHarness();
  const gate = createCooperativePauseGate();
  const arbiter = createActionArbiter();
  const coordinator = await createExtensionActionCoordinator({
    context: harness.context,
    page: harness.page,
    enabled: true,
    taskWaitMs: 500,
    acquireExtensionBoundary: ({ signal } = {}) => gate.acquire({ signal })
  });
  const releaseFirst = deferred();
  const firstStarted = deferred();
  const events = [];
  const first = runProductionTask({ coordinator, gate, arbiter }, 'long-first', async () => {
    events.push('first:start');
    firstStarted.resolve();
    await releaseFirst.promise;
    events.push('first:end');
  });
  await firstStarted.promise;
  const second = runProductionTask({ coordinator, gate, arbiter }, 'queued-second', async () => {
    events.push('second');
  });
  await new Promise((resolve) => setTimeout(resolve, 650));
  assert.deepEqual(events, ['first:start']);
  releaseFirst.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['first:start', 'first:end', 'second']);
  assert.equal(coordinator.audit().leaseTimeouts, 0);
  await coordinator.close();
});

test('Task FIFO wait remains admitted across a pause longer than the former wait budget', async () => {
  const harness = coordinatorHarness();
  const gate = createCooperativePauseGate();
  const arbiter = createActionArbiter();
  const coordinator = await createExtensionActionCoordinator({
    context: harness.context,
    page: harness.page,
    enabled: true,
    taskWaitMs: 500,
    acquireExtensionBoundary: ({ signal } = {}) => gate.acquire({ signal })
  });
  await gate.requestPause('long-pause');
  const events = [];
  const first = runProductionTask({ coordinator, gate, arbiter }, 'paused-first', async () => {
    events.push('first');
  });
  const second = runProductionTask({ coordinator, gate, arbiter }, 'paused-second', async () => {
    events.push('second');
  });
  await new Promise((resolve) => setTimeout(resolve, 650));
  assert.deepEqual(events, []);
  await gate.requestResume('resume-long-pause');
  await Promise.all([first, second]);
  assert.deepEqual(events, ['first', 'second']);
  assert.equal(coordinator.audit().leaseTimeouts, 0);
  await coordinator.close();
});

test('a queued extension never pre-acquires the pause boundary ahead of an earlier Task', async () => {
  const harness = coordinatorHarness();
  let coordinator = null;
  const gate = createCooperativePauseGate({
    onPaused: async () => coordinator?.pause(),
    onResumed: async () => coordinator?.resume()
  });
  const arbiter = createActionArbiter();
  coordinator = await createExtensionActionCoordinator({
    context: harness.context,
    page: harness.page,
    enabled: true,
    acquireExtensionBoundary: ({ signal } = {}) => gate.acquire({ signal })
  });
  const events = [];
  const firstStarted = deferred();
  const releaseFirst = deferred();
  const first = runProductionTask({ coordinator, gate, arbiter }, 'pause-first', async () => {
    events.push('task-1:start');
    firstStarted.resolve();
    await releaseFirst.promise;
    events.push('task-1:end');
  });
  await firstStarted.promise;
  const second = runProductionTask({ coordinator, gate, arbiter }, 'pause-second', async () => {
    events.push('task-2');
  });
  const extensionRequest = harness.invoke({
    kind: 'request',
    participantId: 'pause-extension',
    requestId: 'pause-extension-after-task',
    operation: 'click',
    durationMs: 1_000
  }).then((lease) => {
    if (lease.ok) events.push('extension');
    return lease;
  });

  const pause = gate.requestPause('pause-with-queued-extension');
  releaseFirst.resolve();
  await first;
  assert.deepEqual(await pause, { state: 'paused', commandId: 'pause-with-queued-extension' });
  assert.equal(gate.activeActions, 0);
  assert.deepEqual(events, ['task-1:start', 'task-1:end']);

  const resumed = await Promise.race([
    gate.requestResume('resume-with-queued-extension'),
    new Promise((_, reject) => setTimeout(() => reject(new Error('resume deadlocked')), 500))
  ]);
  assert.deepEqual(resumed, { state: 'running', commandId: 'resume-with-queued-extension' });
  await second;
  const extension = await extensionRequest;
  assert.equal(extension.ok, true);
  assert.deepEqual(events, ['task-1:start', 'task-1:end', 'task-2', 'extension']);
  assert.equal((await harness.invoke({
    kind: 'release',
    participantId: 'pause-extension',
    leaseId: extension.leaseId
  })).ok, true);
  assert.equal(coordinator.audit().maximumActive, 1);
  await coordinator.close();
});

test('trusted Task admission does not inherit the external extension queue capacity', async () => {
  const harness = coordinatorHarness();
  const gate = createCooperativePauseGate();
  const arbiter = createActionArbiter();
  const coordinator = await createExtensionActionCoordinator({
    context: harness.context,
    page: harness.page,
    enabled: true,
    acquireExtensionBoundary: ({ signal } = {}) => gate.acquire({ signal })
  });
  const releaseFirst = deferred();
  const events = [];
  const tasks = Array.from({ length: 64 }, (_, index) => runProductionTask(
    { coordinator, gate, arbiter },
    `batch-task-${index}`,
    async () => {
      events.push(index);
      if (index === 0) await releaseFirst.promise;
    }
  ));
  await eventually(() => events.length === 1);
  releaseFirst.resolve();
  await Promise.all(tasks);
  assert.deepEqual(events, Array.from({ length: 64 }, (_, index) => index));
  assert.equal(coordinator.audit().conflicts, 0);
  assert.equal(coordinator.audit().maximumActive, 1);
  await coordinator.close();
});

test('a Task admitted behind an extension before completion seal still runs and gates completion', async () => {
  const harness = coordinatorHarness();
  const gate = createCooperativePauseGate();
  const arbiter = createActionArbiter();
  const coordinator = await createExtensionActionCoordinator({
    context: harness.context,
    page: harness.page,
    enabled: true,
    acquireExtensionBoundary: ({ signal } = {}) => gate.acquire({ signal })
  });
  const extension = await harness.invoke({
    kind: 'request',
    participantId: 'completion-extension',
    requestId: 'holds-before-completion',
    operation: 'click',
    durationMs: 1_000
  });
  assert.equal(extension.ok, true);

  let taskRan = false;
  const reservation = arbiter.reserve('queued-before-completion');
  const task = coordinator.run('queued-before-completion', () => reservation.execute(
    () => gate.run(async () => { taskRan = true; })
  )).catch(async (error) => {
    await reservation.cancel();
    throw error;
  });
  task.catch(() => {});
  arbiter.seal();
  coordinator.seal();
  let completionSettled = false;
  const completion = (async () => {
    await arbiter.beforeCompletion();
    await coordinator.beforeCompletion();
    completionSettled = true;
  })();
  await Promise.resolve();
  assert.equal(completionSettled, false);
  assert.equal(taskRan, false);

  await harness.invoke({
    kind: 'release',
    participantId: 'completion-extension',
    leaseId: extension.leaseId,
    outcome: { status: 'succeeded', code: 'completion-released', facts: [] }
  });
  await Promise.all([task, completion]);
  assert.equal(taskRan, true);
  assert.equal(completionSettled, true);
  assert.equal(arbiter.audit().completed, 1);
  assert.equal(coordinator.audit().maximumActive, 1);
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

test('Task can trigger an expected extension completion and its receipt gates the next FIFO action until verified', async () => {
  const harness = coordinatorHarness();
  const extensionEffects = [];
  let extensionEffectSequence = 0;
  const coordinator = await createExtensionActionCoordinator({
    context: harness.context,
    page: harness.page,
    enabled: true,
    async onExtensionEffect(event) {
      extensionEffects.push({ ...event });
      if (event.state === 'started') extensionEffectSequence += 1;
      return event.sequence ?? extensionEffectSequence;
    }
  });
  const completion = coordinator.expectCompletion({
    participantId: 'workflow-extension',
    requestId: 'collect-1',
    operation: 'collect',
    timeoutMs: 1_000
  });

  let extensionRequest;
  await coordinator.run('trigger-extension', async () => {
    extensionRequest = harness.invoke({
      kind: 'request',
      participantId: 'workflow-extension',
      requestId: 'collect-1',
      operation: 'collect',
      durationMs: 1_000
    });
  });
  const extension = await extensionRequest;
  assert.equal(extension.ok, true);

  let nextTaskStarted = false;
  const nextTask = coordinator.run('after-extension', async () => {
    nextTaskStarted = true;
  });
  let nextExtensionGranted = false;
  const nextExtension = harness.invoke({
    kind: 'request',
    participantId: 'workflow-extension',
    requestId: 'collect-2',
    operation: 'scroll',
    durationMs: 1_000
  }).then((result) => {
    nextExtensionGranted = true;
    return result;
  });
  assert.deepEqual(await harness.invoke({
    kind: 'release',
    participantId: 'wrong-extension',
    leaseId: extension.leaseId,
    outcome: { status: 'succeeded', code: 'wrong-owner', facts: [] }
  }), { ok: false });
  assert.equal(coordinator.audit().active, 1);

  assert.deepEqual(await harness.invoke({
    kind: 'release',
    participantId: 'workflow-extension',
    leaseId: extension.leaseId,
    requestId: 'spoofed-request',
    operation: 'spoofed-operation',
    outcome: {
      status: 'succeeded',
      code: 'records-ready',
      facts: ['count-5', 'page-1']
    }
  }), { ok: true });
  const receipt = await completion;
  assert.equal(receipt.participantId, 'workflow-extension');
  assert.equal(receipt.requestId, 'collect-1');
  assert.equal(receipt.operation, 'collect');
  assert.equal(receipt.source, 'release');
  assert.deepEqual(receipt.outcome, {
    status: 'succeeded',
    code: 'records-ready',
    facts: ['count-5', 'page-1']
  });
  assert.equal(Object.isFrozen(receipt), true);
  assert.equal(Object.isFrozen(receipt.outcome), true);
  assert.equal(Object.isFrozen(receipt.outcome.facts), true);
  await Promise.resolve();
  assert.equal(nextTaskStarted, false);
  assert.equal(nextExtensionGranted, false);
  assert.equal(coordinator.audit().completionGate, 1);
  assert.equal(coordinator.audit().completionEffectPending, 1);

  await assert.rejects(
    coordinator.resolveCompletion('00000000-0000-4000-8000-000000000000', {
      decision: 'verified',
      code: 'wrong-receipt'
    }),
    { code: 'EXTENSION_COMPLETION_RECEIPT_MISMATCH' }
  );
  assert.equal(nextTaskStarted, false);
  assert.equal(nextExtensionGranted, false);
  await assert.rejects(
    coordinator.resolveCompletion(receipt.receiptId, {
      decision: 'verified',
      code: 'checkpoint-missing'
    }),
    { code: 'EXTENSION_COMPLETION_CHECKPOINT_REQUIRED' }
  );
  checkpointCompletion(coordinator, receipt);
  assert.deepEqual(await coordinator.resolveCompletion(receipt.receiptId, {
    decision: 'verified',
    code: 'result-checked'
  }), {
    ok: true,
    receiptId: receipt.receiptId,
    decision: 'verified',
    code: 'result-checked'
  });
  assert.deepEqual(extensionEffects, [
    { state: 'started', operation: 'custom' },
    { state: 'succeeded', operation: 'custom', sequence: 1 }
  ]);
  await nextTask;
  assert.equal(nextTaskStarted, true);
  const followingExtension = await nextExtension;
  assert.equal(followingExtension.ok, true);
  await harness.invoke({
    kind: 'release',
    participantId: 'workflow-extension',
    leaseId: followingExtension.leaseId,
    outcome: { status: 'succeeded', code: 'scrolled', facts: [] }
  });
  assert.equal(coordinator.audit().completionGate, 0);
  assert.equal(coordinator.audit().completionReceipts, 1);
  await coordinator.beforeCompletion();
  await coordinator.close();
});

test('pause freezes an awaiting extension handoff and its timeout until validated resume', async () => {
  const harness = coordinatorHarness();
  const states = [];
  let coordinator = null;
  const gate = createCooperativePauseGate({
    onState: async (state) => states.push(state),
    onPaused: async () => coordinator.pause(),
    onResumed: async () => coordinator.resume()
  });
  coordinator = await createExtensionActionCoordinator({
    context: harness.context,
    page: harness.page,
    enabled: true,
    acquireExtensionBoundary: () => gate.acquire()
  });
  const completion = coordinator.expectCompletion({
    participantId: 'paused-extension',
    requestId: 'paused-request',
    operation: 'click',
    timeoutMs: 20
  });
  await gate.run(() => coordinator.run('trigger-paused-extension', async () => {}));

  assert.deepEqual(await gate.requestPause('pause-awaiting'), {
    state: 'paused',
    commandId: 'pause-awaiting'
  });
  assert.deepEqual(states, ['pause_requested', 'paused']);
  const extensionRequest = harness.invoke({
    kind: 'request',
    participantId: 'paused-extension',
    requestId: 'paused-request',
    operation: 'click',
    durationMs: 1_000
  });
  let extensionSettled = false;
  extensionRequest.then(() => { extensionSettled = true; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(extensionSettled, false);
  assert.equal(coordinator.audit().active, 0);

  await gate.requestResume('resume-awaiting');
  const extension = await extensionRequest;
  assert.equal(extension.ok, true);
  await harness.invoke({
    kind: 'release',
    participantId: 'paused-extension',
    leaseId: extension.leaseId,
    outcome: { status: 'succeeded', code: 'after-resume', facts: [] }
  });
  const receipt = await completion;
  checkpointCompletion(coordinator, receipt, 'f');
  await coordinator.resolveCompletion(receipt.receiptId, {
    decision: 'verified',
    code: 'resume-verified'
  });
  assert.deepEqual(states, ['pause_requested', 'paused', 'recovering', 'running']);
  await coordinator.close();
});

test('pause cannot report paused while an extension lease is active', async () => {
  const harness = coordinatorHarness();
  const states = [];
  let coordinator = null;
  const gate = createCooperativePauseGate({
    onState: async (state) => states.push(state),
    onPaused: async () => coordinator.pause(),
    onResumed: async () => coordinator.resume()
  });
  coordinator = await createExtensionActionCoordinator({
    context: harness.context,
    page: harness.page,
    enabled: true,
    acquireExtensionBoundary: () => gate.acquire()
  });
  const extension = await harness.invoke({
    kind: 'request',
    participantId: 'active-extension',
    requestId: 'active-request',
    operation: 'scroll',
    durationMs: 1_000
  });
  assert.equal(extension.ok, true);

  assert.deepEqual(await gate.requestPause('pause-active'), {
    state: 'pause_requested',
    commandId: 'pause-active'
  });
  assert.deepEqual(states, ['pause_requested']);
  assert.equal(gate.activeActions, 1);
  assert.deepEqual(await harness.invoke({
    kind: 'validate',
    participantId: 'active-extension',
    requestId: 'active-request',
    leaseId: extension.leaseId
  }), { ok: true });

  await harness.invoke({
    kind: 'release',
    participantId: 'active-extension',
    leaseId: extension.leaseId,
    outcome: { status: 'succeeded', code: 'released-before-pause', facts: [] }
  });
  await eventually(() => states.includes('paused'));
  assert.equal(gate.activeActions, 0);
  assert.equal(coordinator.audit().active, 0);
  await gate.requestResume('resume-active');
  assert.deepEqual(states, ['pause_requested', 'paused', 'recovering', 'running']);
  await coordinator.close();
});

test('navigation while the durable extension grant is persisting never creates a fake receipt', async () => {
  const harness = coordinatorHarness();
  const effectWrite = deferred();
  const effectStarted = deferred();
  const coordinator = await createExtensionActionCoordinator({
    context: harness.context,
    page: harness.page,
    enabled: true,
    async onExtensionEffect(event) {
      if (event.state === 'started') {
        effectStarted.resolve();
        await effectWrite.promise;
        return 1;
      }
      return event.sequence;
    }
  });
  const completion = coordinator.expectCompletion({
    participantId: 'persisting-extension',
    requestId: 'persisting-request',
    operation: 'collect',
    timeoutMs: 1_000
  }).then(() => null, (error) => error);
  await coordinator.run('trigger-persisting-extension', async () => {});
  const extensionRequest = harness.invoke({
    kind: 'request',
    participantId: 'persisting-extension',
    requestId: 'persisting-request',
    operation: 'collect',
    durationMs: 1_000
  });
  await effectStarted.promise;
  harness.navigate();
  effectWrite.resolve();

  assert.deepEqual(await extensionRequest, { ok: false, reason: 'unavailable' });
  assert.equal((await completion)?.code, 'BROWSER_ACTION_CONFLICT');
  assert.equal(coordinator.audit().completionReceipts, 0);
  assert.equal(coordinator.audit().completionGate, 0);
  assert.equal(coordinator.audit().healthy, false);
  await coordinator.close();
});

test('close cancels a request still waiting to enter the external pause boundary', async () => {
  const harness = coordinatorHarness();
  const boundary = deferred();
  let releases = 0;
  const coordinator = await createExtensionActionCoordinator({
    context: harness.context,
    page: harness.page,
    enabled: true,
    acquireExtensionBoundary: () => boundary.promise
  });
  const request = harness.invoke({
    kind: 'request',
    participantId: 'closing-extension',
    requestId: 'closing-request',
    operation: 'click',
    durationMs: 1_000
  });
  await eventually(() => coordinator.audit().boundaryAcquisitions === 1);
  await coordinator.close();
  assert.deepEqual(await request, { ok: false, reason: 'cancelled' });
  boundary.resolve(async () => { releases += 1; });
  await eventually(() => releases === 1);
  assert.equal(coordinator.audit().active, 0);
  assert.equal(coordinator.audit().pending, 0);
});

test('completion seal cancels a pre-queue boundary admission and a late boundary cannot grant', async () => {
  const harness = coordinatorHarness();
  const boundary = deferred();
  let releases = 0;
  const coordinator = await createExtensionActionCoordinator({
    context: harness.context,
    page: harness.page,
    enabled: true,
    acquireExtensionBoundary: () => boundary.promise
  });
  const request = harness.invoke({
    kind: 'request',
    participantId: 'sealed-extension',
    requestId: 'sealed-request',
    operation: 'click',
    durationMs: 1_000
  });
  await eventually(() => coordinator.audit().boundaryAcquisitions === 1);

  await coordinator.beforeCompletion();
  assert.deepEqual(await request, { ok: false, reason: 'unavailable' });
  assert.equal(coordinator.audit().extensionLeases, 0);
  assert.equal(coordinator.audit().active, 0);

  boundary.resolve(async () => { releases += 1; });
  await eventually(() => releases === 1);
  assert.equal(coordinator.audit().extensionLeases, 0);
  assert.equal(coordinator.audit().active, 0);
  await coordinator.close();
});

test('every close caller joins the same in-flight boundary release', async () => {
  const harness = coordinatorHarness();
  const controller = new AbortController();
  const releaseStarted = deferred();
  const releaseFinished = deferred();
  const coordinator = await createExtensionActionCoordinator({
    context: harness.context,
    page: harness.page,
    signal: controller.signal,
    enabled: true,
    acquireExtensionBoundary: async () => async () => {
      releaseStarted.resolve();
      await releaseFinished.promise;
    }
  });
  const extension = await harness.invoke({
    kind: 'request',
    participantId: 'closing-active-extension',
    requestId: 'closing-active-request',
    operation: 'scroll',
    durationMs: 1_000
  });
  assert.equal(extension.ok, true);

  controller.abort(Object.assign(new Error('cancel active lease'), { code: 'TASK_CANCELLED' }));
  await releaseStarted.promise;
  let joined = false;
  const joinedClose = coordinator.close().then(() => { joined = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(joined, false);
  releaseFinished.resolve();
  await joinedClose;
  assert.equal(joined, true);
  assert.equal(coordinator.audit().active, 0);
});

test('close drains a queued request release that is registered during shutdown', async () => {
  const harness = coordinatorHarness();
  const acquisitionStarted = deferred();
  const acquisitionFinished = deferred();
  const releaseStarted = deferred();
  const releaseFinished = deferred();
  const coordinator = await createExtensionActionCoordinator({
    context: harness.context,
    page: harness.page,
    enabled: true,
    acquireExtensionBoundary: async () => {
      acquisitionStarted.resolve();
      await acquisitionFinished.promise;
      return async () => {
      releaseStarted.resolve();
      await releaseFinished.promise;
      };
    }
  });
  const request = harness.invoke({
    kind: 'request',
    participantId: 'queued-closing-extension',
    requestId: 'queued-closing-request',
    operation: 'input',
    durationMs: 1_000
  });
  await acquisitionStarted.promise;

  let closed = false;
  const closing = coordinator.close().then(() => { closed = true; });
  assert.deepEqual(await request, { ok: false, reason: 'cancelled' });
  acquisitionFinished.resolve();
  await releaseStarted.promise;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(closed, false);
  releaseFinished.resolve();
  await closing;
  assert.equal(closed, true);
});

test('expectation timeout during durable grant persistence can never publish a late grant', async () => {
  const harness = coordinatorHarness();
  const effectStarted = deferred();
  const effectWrite = deferred();
  const effectEvents = [];
  const coordinator = await createExtensionActionCoordinator({
    context: harness.context,
    page: harness.page,
    enabled: true,
    async onExtensionEffect(event) {
      effectEvents.push(event.state);
      if (event.state === 'started') {
        effectStarted.resolve();
        await effectWrite.promise;
        return 1;
      }
      return event.sequence;
    }
  });
  const completion = coordinator.expectCompletion({
    participantId: 'slow-journal-extension',
    requestId: 'slow-journal-request',
    operation: 'collect',
    timeoutMs: 10
  });
  await coordinator.run('trigger-slow-journal', async () => {});
  const extensionRequest = harness.invoke({
    kind: 'request',
    participantId: 'slow-journal-extension',
    requestId: 'slow-journal-request',
    operation: 'collect',
    durationMs: 1_000
  });
  await effectStarted.promise;
  await assert.rejects(completion, { code: 'EXTENSION_COMPLETION_EXPECTATION_TIMEOUT' });
  effectWrite.resolve();

  assert.deepEqual(await extensionRequest, { ok: false, reason: 'unavailable' });
  assert.deepEqual(effectEvents, ['started']);
  assert.equal(coordinator.audit().active, 0);
  assert.equal(coordinator.audit().completionReceipts, 0);
  assert.equal(coordinator.audit().healthy, false);
  await coordinator.close();
});

test('close promptly cancels a bridge request blocked in durable started persistence', async () => {
  const harness = coordinatorHarness();
  const effectStarted = deferred();
  const effectWrite = deferred();
  const coordinator = await createExtensionActionCoordinator({
    context: harness.context,
    page: harness.page,
    enabled: true,
    async onExtensionEffect(event) {
      if (event.state === 'started') {
        effectStarted.resolve();
        await effectWrite.promise;
        return 1;
      }
      return event.sequence;
    }
  });
  const completion = coordinator.expectCompletion({
    participantId: 'closing-persist-extension',
    requestId: 'closing-persist-request',
    operation: 'collect',
    timeoutMs: 1_000
  }).then(() => null, (error) => error);
  await coordinator.run('trigger-closing-persist', async () => {});
  const request = harness.invoke({
    kind: 'request',
    participantId: 'closing-persist-extension',
    requestId: 'closing-persist-request',
    operation: 'collect',
    durationMs: 1_000
  });
  await effectStarted.promise;

  await coordinator.close();
  assert.deepEqual(await request, { ok: false, reason: 'cancelled' });
  assert.equal((await completion)?.code, 'TASK_CANCELLED');
  assert.equal(coordinator.audit().active, 0);
  effectWrite.resolve();
});

test('close promptly cancels a verified resolution blocked in durable terminal persistence', async () => {
  const harness = coordinatorHarness();
  const terminalStarted = deferred();
  const terminalWrite = deferred();
  const coordinator = await createExtensionActionCoordinator({
    context: harness.context,
    page: harness.page,
    enabled: true,
    async onExtensionEffect(event) {
      if (event.state === 'started') return 1;
      terminalStarted.resolve();
      await terminalWrite.promise;
      return event.sequence;
    }
  });
  const completion = coordinator.expectCompletion({
    participantId: 'closing-terminal-extension',
    requestId: 'closing-terminal-request',
    operation: 'collect',
    timeoutMs: 1_000
  });
  await coordinator.run('trigger-closing-terminal', async () => {});
  const extension = await harness.invoke({
    kind: 'request',
    participantId: 'closing-terminal-extension',
    requestId: 'closing-terminal-request',
    operation: 'collect',
    durationMs: 1_000
  });
  await harness.invoke({
    kind: 'release',
    participantId: 'closing-terminal-extension',
    leaseId: extension.leaseId,
    outcome: { status: 'succeeded', code: 'terminal-ready', facts: [] }
  });
  const receipt = await completion;
  checkpointCompletion(coordinator, receipt, '8');
  const resolution = coordinator.resolveCompletion(receipt.receiptId, {
    decision: 'verified',
    code: 'terminal-verified'
  });
  await terminalStarted.promise;

  await coordinator.close();
  await assert.rejects(resolution, { code: 'TASK_CANCELLED' });
  terminalWrite.resolve();
});

test('cancel during durable verified resolution returns TASK_CANCELLED instead of a null-gate error', async () => {
  const harness = coordinatorHarness();
  const controller = new AbortController();
  const terminalStarted = deferred();
  const releaseTerminal = deferred();
  const coordinator = await createExtensionActionCoordinator({
    context: harness.context,
    page: harness.page,
    signal: controller.signal,
    enabled: true,
    async onExtensionEffect(event) {
      if (event.state === 'started') return 1;
      terminalStarted.resolve();
      await releaseTerminal.promise;
      return event.sequence;
    }
  });
  const completion = coordinator.expectCompletion({
    participantId: 'cancel-resolution-extension',
    requestId: 'cancel-resolution-request',
    operation: 'collect',
    timeoutMs: 1_000
  });
  await coordinator.run('trigger-cancel-resolution', async () => {});
  const extension = await harness.invoke({
    kind: 'request',
    participantId: 'cancel-resolution-extension',
    requestId: 'cancel-resolution-request',
    operation: 'collect',
    durationMs: 1_000
  });
  await harness.invoke({
    kind: 'release',
    participantId: 'cancel-resolution-extension',
    leaseId: extension.leaseId,
    outcome: { status: 'succeeded', code: 'ready', facts: [] }
  });
  const receipt = await completion;
  checkpointCompletion(coordinator, receipt, '9');
  const resolution = coordinator.resolveCompletion(receipt.receiptId, {
    decision: 'verified',
    code: 'verified-before-cancel'
  });
  await terminalStarted.promise;
  controller.abort(Object.assign(new Error('cancelled during resolution'), { code: 'TASK_CANCELLED' }));
  releaseTerminal.resolve();
  await assert.rejects(resolution, { code: 'TASK_CANCELLED' });
  await coordinator.close();
});

test('a mismatch in any completion triple field fails closed before the wrong action is granted', async () => {
  for (const mismatch of [
    { participantId: 'wrong-extension', requestId: 'expected-request', operation: 'click' },
    { participantId: 'expected-extension', requestId: 'wrong-request', operation: 'click' },
    { participantId: 'expected-extension', requestId: 'expected-request', operation: 'scroll' }
  ]) {
    const harness = coordinatorHarness();
    const coordinator = await createExtensionActionCoordinator({
      context: harness.context,
      page: harness.page,
      enabled: true
    });
    const completion = coordinator.expectCompletion({
      participantId: 'expected-extension',
      requestId: 'expected-request',
      operation: 'click',
      timeoutMs: 1_000
    }).then(() => null, (error) => error);
    await coordinator.run('trigger-extension', async () => {});

    assert.deepEqual(await harness.invoke({
      kind: 'request',
      ...mismatch,
      durationMs: 1_000
    }), { ok: false, reason: 'unavailable' });
    assert.equal((await completion)?.code, 'BROWSER_ACTION_CONFLICT');
    assert.equal(coordinator.audit().completionGate, 0);
    assert.equal(coordinator.audit().completionReceipts, 0);
    assert.equal(coordinator.audit().healthy, false);
    let taskStarted = false;
    await assert.rejects(coordinator.run('must-not-continue-after-mismatch', async () => {
      taskStarted = true;
    }), { code: 'BROWSER_ACTION_CONFLICT' });
    assert.equal(taskStarted, false);
    await coordinator.close();
  }
});

test('a missing or invalid extension operation can never default into an expected triple', async () => {
  for (const operation of [undefined, 'invalid operation', 'x'.repeat(81)]) {
    const harness = coordinatorHarness();
    const coordinator = await createExtensionActionCoordinator({
      context: harness.context,
      page: harness.page,
      enabled: true
    });
    const completion = coordinator.expectCompletion({
      participantId: 'strict-extension',
      requestId: 'strict-request',
      operation: 'extension-action',
      timeoutMs: 1_000
    }).then(() => null, (error) => error);
    await coordinator.run('trigger-extension', async () => {});
    assert.deepEqual(await harness.invoke({
      kind: 'request',
      participantId: 'strict-extension',
      requestId: 'strict-request',
      operation,
      durationMs: 1_000
    }), { ok: false, reason: 'invalid-request' });
    assert.equal((await completion)?.code, 'BROWSER_ACTION_CONFLICT');
    assert.equal(coordinator.audit().extensionLeases, 0);
    assert.equal(coordinator.audit().completionReceipts, 0);
    assert.equal(coordinator.audit().healthy, false);
    await coordinator.close();
  }
});

test('request or grant before expectation registration is rejected and cannot become a late receipt', async () => {
  const harness = coordinatorHarness();
  const coordinator = await createExtensionActionCoordinator({
    context: harness.context,
    page: harness.page,
    enabled: true
  });
  const extension = await harness.invoke({
    kind: 'request',
    participantId: 'late-expectation-extension',
    requestId: 'already-active',
    operation: 'click',
    durationMs: 1_000
  });
  assert.equal(extension.ok, true);
  await assert.rejects(coordinator.expectCompletion({
    participantId: 'late-expectation-extension',
    requestId: 'already-active',
    operation: 'click',
    timeoutMs: 1_000
  }), { code: 'BROWSER_ACTION_CONFLICT' });
  assert.deepEqual(await harness.invoke({
    kind: 'release',
    participantId: 'late-expectation-extension',
    leaseId: extension.leaseId,
    outcome: { status: 'succeeded', code: 'too-late', facts: [] }
  }), { ok: true });
  assert.equal(coordinator.audit().completionReceipts, 0);
  assert.equal(coordinator.audit().healthy, false);
  await coordinator.close();
});

test('an expected extension request cannot be granted before the Task trigger settles', async () => {
  const harness = coordinatorHarness();
  const coordinator = await createExtensionActionCoordinator({
    context: harness.context,
    page: harness.page,
    enabled: true
  });
  const completion = coordinator.expectCompletion({
    participantId: 'early-extension',
    requestId: 'early-request',
    operation: 'click',
    timeoutMs: 1_000
  }).then(() => null, (error) => error);
  assert.deepEqual(await harness.invoke({
    kind: 'request',
    participantId: 'early-extension',
    requestId: 'early-request',
    operation: 'click',
    durationMs: 1_000
  }), { ok: false, reason: 'unavailable' });
  assert.equal((await completion)?.code, 'BROWSER_ACTION_CONFLICT');
  assert.equal(coordinator.audit().extensionLeases, 0);
  assert.equal(coordinator.audit().healthy, false);
  await coordinator.close();
});

test('completion timeout starts after the Task trigger and cannot become an unhandled Worker rejection', async () => {
  const slowHarness = coordinatorHarness();
  const slowCoordinator = await createExtensionActionCoordinator({
    context: slowHarness.context,
    page: slowHarness.page,
    enabled: true
  });
  const slowCompletion = slowCoordinator.expectCompletion({
    participantId: 'slow-trigger-extension',
    requestId: 'slow-trigger-request',
    operation: 'click',
    timeoutMs: 20
  });
  await slowCoordinator.run('slow-trigger', async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  const extension = await slowHarness.invoke({
    kind: 'request',
    participantId: 'slow-trigger-extension',
    requestId: 'slow-trigger-request',
    operation: 'click',
    durationMs: 1_000
  });
  assert.equal(extension.ok, true);
  await slowHarness.invoke({
    kind: 'release',
    participantId: 'slow-trigger-extension',
    leaseId: extension.leaseId,
    outcome: { status: 'succeeded', code: 'slow-trigger-finished', facts: [] }
  });
  const receipt = await slowCompletion;
  checkpointCompletion(slowCoordinator, receipt, 'e');
  await slowCoordinator.resolveCompletion(receipt.receiptId, {
    decision: 'verified',
    code: 'slow-trigger-verified'
  });
  await slowCoordinator.close();

  const timeoutHarness = coordinatorHarness();
  const timeoutCoordinator = await createExtensionActionCoordinator({
    context: timeoutHarness.context,
    page: timeoutHarness.page,
    enabled: true
  });
  const lateAwaitedCompletion = timeoutCoordinator.expectCompletion({
    participantId: 'timeout-extension',
    requestId: 'timeout-request',
    operation: 'click',
    timeoutMs: 20
  });
  await timeoutCoordinator.run('trigger-timeout', async () => {});
  await new Promise((resolve) => setTimeout(resolve, 50));
  await assert.rejects(lateAwaitedCompletion, {
    code: 'EXTENSION_COMPLETION_EXPECTATION_TIMEOUT'
  });
  assert.equal(timeoutCoordinator.audit().healthy, false);
  await timeoutCoordinator.close();
});

test('disabled completion APIs remain late-await safe in strict Node Workers', async () => {
  const coordinator = await createExtensionActionCoordinator({ enabled: false });
  const completion = coordinator.expectCompletion({
    participantId: 'disabled-extension',
    requestId: 'disabled-request',
    operation: 'click'
  });
  const resolution = coordinator.resolveCompletion('00000000-0000-4000-8000-000000000000', {
    decision: 'verified',
    code: 'disabled-resolution'
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  await assert.rejects(completion, { code: 'EXTENSION_COMPLETION_UNAVAILABLE' });
  await assert.rejects(resolution, { code: 'EXTENSION_COMPLETION_UNAVAILABLE' });
});

test('expectation timeout rejects already queued Task and extension actions before they can start', async () => {
  const harness = coordinatorHarness();
  const coordinator = await createExtensionActionCoordinator({
    context: harness.context,
    page: harness.page,
    enabled: true
  });
  const completionOutcome = coordinator.expectCompletion({
    participantId: 'expected-extension',
    requestId: 'never-completes',
    operation: 'click',
    timeoutMs: 40
  }).then(() => null, (error) => error);
  await coordinator.run('trigger-extension', async () => {});
  const holder = await harness.invoke({
    kind: 'request',
    participantId: 'expected-extension',
    requestId: 'never-completes',
    operation: 'click',
    durationMs: 1_000
  });
  assert.equal(holder.ok, true);

  let taskStarted = false;
  const queuedTask = coordinator.run('queued-task', async () => {
    taskStarted = true;
  }).then(() => null, (error) => error);
  const queuedExtension = harness.invoke({
    kind: 'request',
    participantId: 'queued-extension',
    requestId: 'queued-1',
    operation: 'input',
    durationMs: 1_000
  });
  const completionError = await completionOutcome;
  assert.equal(completionError?.code, 'EXTENSION_COMPLETION_EXPECTATION_TIMEOUT');
  assert.equal((await queuedTask)?.code, 'BROWSER_ACTION_CONFLICT');
  assert.equal(taskStarted, false);
  assert.deepEqual(await queuedExtension, { ok: false, reason: 'unavailable' });
  assert.equal(coordinator.audit().pending, 0);
  assert.equal(coordinator.audit().healthy, false);

  await harness.invoke({
    kind: 'release',
    participantId: 'expected-extension',
    leaseId: holder.leaseId,
    outcome: { status: 'unknown', code: 'test-cleanup', facts: [] }
  });
  await coordinator.close();
});

test('navigation and page close create bounded unknown receipts that still require resolution', async () => {
  for (const lifecycle of ['navigation', 'page-closed']) {
    const harness = coordinatorHarness();
    const coordinator = await createExtensionActionCoordinator({
      context: harness.context,
      page: harness.page,
      enabled: true
    });
    const completion = coordinator.expectCompletion({
      participantId: 'lifecycle-extension',
      requestId: `${lifecycle}-1`,
      operation: 'navigate',
      timeoutMs: 1_000
    });
    await coordinator.run('trigger-lifecycle-extension', async () => {});
    const extension = await harness.invoke({
      kind: 'request',
      participantId: 'lifecycle-extension',
      requestId: `${lifecycle}-1`,
      operation: 'navigate',
      durationMs: 1_000
    });
    assert.equal(extension.ok, true);
    let taskStarted = false;
    const task = coordinator.run('after-lifecycle-release', async () => {
      taskStarted = true;
    });

    if (lifecycle === 'navigation') harness.navigate();
    else harness.closePage();
    const receipt = await completion;
    assert.equal(receipt.source, lifecycle);
    assert.deepEqual(receipt.outcome, {
      status: 'unknown',
      code: lifecycle,
      facts: []
    });
    await Promise.resolve();
    assert.equal(taskStarted, false);
    await assert.rejects(coordinator.beforeCompletion(), {
      code: 'EXTENSION_COMPLETION_GATE_PENDING'
    });
    checkpointCompletion(coordinator, receipt, lifecycle === 'navigation' ? 'b' : 'c');
    await coordinator.resolveCompletion(receipt.receiptId, {
      decision: 'verified',
      code: 'lifecycle-reviewed'
    });
    await task;
    assert.equal(taskStarted, true);
    await coordinator.close();
  }
});

test('a rejected completion fails closed and no queued or future Task action can run', async () => {
  const harness = coordinatorHarness();
  const coordinator = await createExtensionActionCoordinator({
    context: harness.context,
    page: harness.page,
    enabled: true
  });
  const completion = coordinator.expectCompletion({
    participantId: 'rejectable-extension',
    requestId: 'input-1',
    operation: 'input',
    timeoutMs: 1_000
  });
  await coordinator.run('trigger-rejectable-extension', async () => {});
  const extension = await harness.invoke({
    kind: 'request',
    participantId: 'rejectable-extension',
    requestId: 'input-1',
    operation: 'input',
    durationMs: 1_000
  });
  let queuedTaskStarted = false;
  const queuedTask = coordinator.run('must-stay-closed', async () => {
    queuedTaskStarted = true;
  }).then(() => null, (error) => error);
  await harness.invoke({
    kind: 'release',
    participantId: 'rejectable-extension',
    leaseId: extension.leaseId,
    outcome: { status: 'not_applied', code: 'target-missing', facts: ['visible-page'] }
  });
  const receipt = await completion;

  await assert.rejects(
    coordinator.resolveCompletion(receipt.receiptId, {
      decision: 'rejected',
      code: 'verification-failed'
    }),
    { code: 'BROWSER_ACTION_CONFLICT' }
  );
  const queuedError = await queuedTask;
  assert.equal(queuedTaskStarted, false);
  assert.equal(queuedError?.code, 'BROWSER_ACTION_CONFLICT');
  await assert.rejects(coordinator.run('future-task', async () => {}), {
    code: 'BROWSER_ACTION_CONFLICT'
  });
  await assert.rejects(coordinator.beforeCompletion(), {
    code: 'BROWSER_ACTION_CONFLICT'
  });
  assert.equal(coordinator.audit().healthy, false);
  await coordinator.close();
});

test('beforeCompletion rejects pending expectations and close cancels their waiters', async () => {
  const harness = coordinatorHarness();
  const coordinator = await createExtensionActionCoordinator({
    context: harness.context,
    page: harness.page,
    enabled: true
  });
  const completion = coordinator.expectCompletion({
    participantId: 'waiting-extension',
    requestId: 'waiting-request',
    operation: 'click',
    timeoutMs: 60_000
  }).then(() => null, (error) => error);
  await assert.rejects(coordinator.beforeCompletion(), {
    code: 'EXTENSION_COMPLETION_EXPECTATION_PENDING'
  });
  assert.equal(coordinator.audit().completionExpectations, 1);
  await coordinator.close();
  assert.equal((await completion)?.code, 'TASK_CANCELLED');
  assert.equal(coordinator.audit().completionExpectations, 0);
});

test('completion expectations and receipts are bounded and never retain arbitrary outcome text', async () => {
  const harness = coordinatorHarness();
  const coordinator = await createExtensionActionCoordinator({
    context: harness.context,
    page: harness.page,
    enabled: true
  });
  const firstWaiter = coordinator.expectCompletion({
    participantId: 'bounded-extension',
    requestId: 'request-1',
    operation: 'operation-1',
    timeoutMs: 60_000
  }).then(() => null, (error) => error);
  await assert.rejects(coordinator.expectCompletion({
    participantId: 'bounded-extension',
    requestId: 'request-over-capacity',
    operation: 'over-capacity',
    timeoutMs: 60_000
  }), { code: 'BROWSER_ACTION_CONFLICT' });
  assert.equal((await firstWaiter)?.code, 'BROWSER_ACTION_CONFLICT');
  assert.equal(coordinator.audit().completionExpectations, 0);
  assert.equal(coordinator.audit().healthy, false);
  await coordinator.close();

  const secondHarness = coordinatorHarness();
  const secondCoordinator = await createExtensionActionCoordinator({
    context: secondHarness.context,
    page: secondHarness.page,
    enabled: true
  });
  const completion = secondCoordinator.expectCompletion({
    participantId: 'bounded-extension',
    requestId: 'invalid-outcome',
    operation: 'collect',
    timeoutMs: 1_000
  });
  await secondCoordinator.run('trigger-bounded-extension', async () => {});
  const extension = await secondHarness.invoke({
    kind: 'request',
    participantId: 'bounded-extension',
    requestId: 'invalid-outcome',
    operation: 'collect',
    durationMs: 1_000
  });
  await secondHarness.invoke({
    kind: 'release',
    participantId: 'bounded-extension',
    leaseId: extension.leaseId,
    outcome: {
      status: 'succeeded',
      code: 'secret value with spaces',
      facts: Array.from({ length: 17 }, () => 'secret'),
      freeText: 'arbitrary top secret text'
    }
  });
  const receipt = await completion;
  assert.deepEqual(receipt.outcome, {
    status: 'unknown',
    code: 'outcome-invalid',
    facts: []
  });
  assert.equal(JSON.stringify(receipt).includes('arbitrary top secret text'), false);
  assert.equal(JSON.stringify(receipt).includes('secret value with spaces'), false);
  checkpointCompletion(secondCoordinator, receipt, 'd');
  await secondCoordinator.resolveCompletion(receipt.receiptId, {
    decision: 'verified',
    code: 'invalid-outcome-reviewed'
  });
  await secondCoordinator.close();
});

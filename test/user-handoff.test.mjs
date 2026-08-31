import assert from 'node:assert/strict';
import test from 'node:test';
import { createUserHandoff } from '../src/lib/user-handoff.mjs';

test('user handoff reports one bounded request and resumes only with its matching ID', async () => {
  const states = [];
  const progress = [];
  const published = [];
  let request;
  let publishedDiagnostics;
  let handoff;
  handoff = createUserHandoff({
    capture: async () => 'fixture.png',
    onRequest: async (value, diagnostics) => {
      request = value;
      publishedDiagnostics = diagnostics;
      assert.equal(handoff.pending?.id, value.id);
      published.push('request');
    },
    onState: async (state) => {
      states.push(state);
      published.push(`state:${state}`);
    },
    onProgress: async (message) => {
      progress.push(message);
      published.push('progress');
    }
  });

  const waiting = handoff.request({
    kind: 'human_verification',
    reason: 'Cookie panel requires a choice',
    instructions: 'Inspect the screenshot before continuing.',
    timeoutMs: 5_000
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(request.id, /^handoff_[a-f0-9]{32}$/u);
  assert.equal(request.kind, 'human_verification');
  assert.equal(request.expiresAt, undefined);
  assert.equal(request.screenshotAvailable, true);
  assert.equal(publishedDiagnostics, 'fixture.png');
  assert.equal(await handoff.continue({ requestId: 'handoff_wrong', note: '' }), false);
  assert.equal(await handoff.continue({ requestId: request.id, note: 'Accepted in the live page' }), true);
  assert.equal((await waiting).note, 'Accepted in the live page');
  assert.deepEqual(states, ['waiting_user', 'recovering', 'running']);
  assert.deepEqual(published.slice(0, 3), ['request', 'state:waiting_user', 'progress']);
  assert.match(progress[0], /Waiting/u);
  assert.equal(handoff.pending, null);
  assert.equal(handoff.active, false);
  assert.equal(handoff.seal(), false);
  await assert.rejects(
    handoff.request({ reason: 'Too late', timeoutMs: 5_000 }),
    { code: 'TASK_USER_HANDOFF_AFTER_COMPLETION' }
  );
});

test('user handoff rejects unknown request kinds without publishing a waiter', async () => {
  const handoff = createUserHandoff();
  await assert.rejects(
    handoff.request({ kind: 'captcha_solver', reason: 'Unsupported automation request' }),
    { code: 'INVALID_USER_HANDOFF' }
  );
  assert.equal(handoff.pending, null);
});

test('user handoff aborts without leaving a pending waiter', async () => {
  const controller = new AbortController();
  const handoff = createUserHandoff({ signal: controller.signal });
  const waiting = handoff.request({ reason: 'Need instruction', timeoutMs: 5_000 });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(Object.assign(new Error('cancelled'), { code: 'TASK_CANCELLED' }));
  await assert.rejects(waiting, { code: 'TASK_CANCELLED' });
  assert.equal(handoff.pending, null);
});

test('continuation reporting is joined and cancellation prevents a late running state', async () => {
  const controller = new AbortController();
  const states = [];
  let progressCalls = 0;
  let releaseProgress;
  const progressGate = new Promise((resolve) => { releaseProgress = resolve; });
  const handoff = createUserHandoff({
    signal: controller.signal,
    onRequest: async () => {},
    onState: async (state) => states.push(state),
    onProgress: async () => {
      progressCalls += 1;
      if (progressCalls > 1) await progressGate;
    }
  });
  const waiting = handoff.request({ reason: 'Check the page', timeoutMs: 5_000 });
  while (!handoff.pending) await new Promise((resolve) => setImmediate(resolve));
  const requestId = handoff.pending.id;
  const continuation = handoff.continue({ requestId });
  while (progressCalls < 2) await new Promise((resolve) => setImmediate(resolve));
  const cancellation = Object.assign(new Error('cancelled'), { code: 'TASK_CANCELLED' });
  controller.abort(cancellation);
  releaseProgress();
  await assert.rejects(continuation, { code: 'TASK_CANCELLED' });
  await assert.rejects(waiting, { code: 'TASK_CANCELLED' });
  assert.deepEqual(states, ['waiting_user', 'recovering']);
  assert.equal(handoff.pending, null);
  assert.equal(handoff.active, false);
});

test('handoff admission is synchronous and sealing during capture prevents every publication', async () => {
  let captureCalls = 0;
  const events = [];
  const handoff = createUserHandoff({
    capture: async () => {
      captureCalls += 1;
      return 'late.png';
    },
    onRequest: async () => events.push('request'),
    onState: async (state) => events.push(`state:${state}`),
    onProgress: async () => events.push('progress')
  });

  const pending = handoff.request({ reason: 'Need a human', timeoutMs: 5_000 });
  assert.equal(handoff.preparing, true);
  assert.equal(handoff.active, true);
  assert.equal(handoff.seal(), true);
  await assert.rejects(pending, { code: 'TASK_USER_HANDOFF_AFTER_COMPLETION' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(captureCalls, 0);
  assert.deepEqual(events, []);
  assert.equal(handoff.active, false);
});

test('sealing a handoff while request publication is in flight blocks waiting state and progress', async () => {
  const events = [];
  let releaseRequest;
  const requestGate = new Promise((resolve) => { releaseRequest = resolve; });
  const handoff = createUserHandoff({
    onRequest: async () => {
      events.push('request');
      await requestGate;
    },
    onState: async (state) => events.push(`state:${state}`),
    onProgress: async () => events.push('progress')
  });
  const waiting = handoff.request({ reason: 'Inspect page', timeoutMs: 5_000 });
  while (!handoff.pending || events.length === 0) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(handoff.seal(), true);
  releaseRequest();
  await assert.rejects(waiting, { code: 'TASK_USER_HANDOFF_AFTER_COMPLETION' });
  assert.deepEqual(events, ['request']);
  assert.equal(handoff.active, false);
});

test('handoff rejects a second call while the first is still preparing', async () => {
  let releaseCapture;
  const captureGate = new Promise((resolve) => { releaseCapture = resolve; });
  const handoff = createUserHandoff({ capture: async () => captureGate });
  const first = handoff.request({ reason: 'First request', timeoutMs: 5_000 });
  assert.equal(handoff.preparing, true);
  await assert.rejects(
    handoff.request({ reason: 'Second request', timeoutMs: 5_000 }),
    { code: 'USER_HANDOFF_ALREADY_PENDING' }
  );
  assert.equal(handoff.cancel(), true);
  releaseCapture(null);
  await assert.rejects(first, { code: 'TASK_CANCELLED' });
});

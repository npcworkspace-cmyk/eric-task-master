import assert from 'node:assert/strict';
import test from 'node:test';
import { createUserHandoff } from '../src/lib/user-handoff.mjs';

test('user handoff reports one bounded request and resumes only with its matching ID', async () => {
  const states = [];
  const progress = [];
  const published = [];
  let request;
  let handoff;
  handoff = createUserHandoff({
    capture: async () => 'fixture.png',
    onRequest: async (value) => {
      request = value;
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
    reason: 'Cookie panel requires a choice',
    instructions: 'Inspect the screenshot before continuing.',
    timeoutMs: 5_000
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(request.id, /^handoff_[a-f0-9]{32}$/u);
  assert.equal(request.screenshotAvailable, true);
  assert.equal(await handoff.continue({ requestId: 'handoff_wrong', note: '' }), false);
  assert.equal(await handoff.continue({ requestId: request.id, note: 'Accepted in the live page' }), true);
  assert.equal((await waiting).note, 'Accepted in the live page');
  assert.deepEqual(states, ['waiting_user', 'recovering', 'running']);
  assert.deepEqual(published.slice(0, 3), ['request', 'state:waiting_user', 'progress']);
  assert.match(progress[0], /Waiting/u);
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

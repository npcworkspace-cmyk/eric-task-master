import assert from 'node:assert/strict';
import test from 'node:test';
import { createCooldownHelper, parseRetryAfter, resolveCooldownMs } from '../src/lib/cooldown.mjs';

test('Retry-After seconds and HTTP dates resolve to bounded cooldowns', () => {
  const now = Date.parse('2026-08-24T00:00:00.000Z');
  assert.equal(parseRetryAfter('12', now), 12_000);
  assert.equal(parseRetryAfter('Sun, 24 Aug 2026 00:00:20 GMT', now), 20_000);
  assert.equal(parseRetryAfter('invalid', now), null);
  assert.equal(resolveCooldownMs({ retryAfter: '0', nowMs: now }), 1_000);
  assert.equal(resolveCooldownMs({ retryAfter: '999999', nowMs: now }), 6 * 60 * 60_000);
  assert.equal(resolveCooldownMs({ fallbackMs: 5_000, attempt: 3, random: () => 0 }), 20_000);
  assert.equal(resolveCooldownMs({ fallbackMs: 5_000, attempt: 1, random: () => 1 }), 5_500);
});

test('cooldown reports visible state and honors server timing without replaying work', async () => {
  const events = [];
  const helper = createCooldownHelper({
    now: () => Date.parse('2026-08-24T00:00:00.000Z'),
    random: () => 1,
    onSignal: (kind) => events.push(['signal', kind]),
    onState: async (state) => events.push(['state', state]),
    onProgress: async (progress) => events.push(['progress', progress]),
    sleep: async (milliseconds) => events.push(['sleep', milliseconds])
  });
  const result = await helper({
    response: { async headerValue(name) { return name === 'retry-after' ? '12' : null; } },
    attempt: 4,
    reason: 'Site rate limit'
  });
  assert.equal(result.durationMs, 12_000);
  assert.deepEqual(events.map((event) => event[0]), ['signal', 'state', 'progress', 'sleep', 'state']);
  assert.deepEqual(events.filter((event) => event[0] === 'state').map((event) => event[1]), ['cooling_down', 'running']);
  assert.equal(events.find((event) => event[0] === 'progress')[1].resumeAt, '2026-08-24T00:00:12.000Z');
  assert.equal(helper.active, false);
  assert.equal(helper.seal(), false);
  await assert.rejects(helper({ milliseconds: 1_000 }), { code: 'TASK_COOLDOWN_AFTER_COMPLETION' });
});

test('cooldown cancellation is immediate and does not announce a false resume', async () => {
  const controller = new AbortController();
  const states = [];
  const cooldowns = [];
  const helper = createCooldownHelper({
    signal: controller.signal,
    onState: async (state) => states.push(state),
    onCooldown: async (record) => cooldowns.push(record)
  });
  const cancellation = Object.assign(new Error('cancelled'), { code: 'TASK_CANCELLED' });
  const pending = helper({ milliseconds: 5_000 });
  setTimeout(() => controller.abort(cancellation), 10);
  await assert.rejects(pending, { code: 'TASK_CANCELLED' });
  assert.deepEqual(states, ['cooling_down']);
  assert.deepEqual(cooldowns.map((record) => record.status), ['active', 'interrupted']);
  assert.ok(cooldowns[1].elapsedMs >= 0 && cooldowns[1].elapsedMs < cooldowns[1].durationMs);
});

test('cooldown admission is synchronous, single-instance, and seal blocks late publication', async () => {
  const events = [];
  let releaseHeader;
  const headerGate = new Promise((resolve) => { releaseHeader = resolve; });
  const helper = createCooldownHelper({
    onSignal: (kind) => events.push(['signal', kind]),
    onState: async (state) => events.push(['state', state]),
    onProgress: async (progress) => events.push(['progress', progress]),
    onCooldown: async (record) => events.push(['cooldown', record.status])
  });
  const first = helper({
    response: { headerValue: async () => headerGate },
    milliseconds: 1_000
  });
  assert.equal(helper.preparing, true);
  assert.equal(helper.active, true);
  await assert.rejects(helper({ milliseconds: 1_000 }), { code: 'TASK_COOLDOWN_ALREADY_ACTIVE' });
  assert.equal(helper.seal(), true);
  releaseHeader('1');
  await assert.rejects(first, { code: 'TASK_COOLDOWN_AFTER_COMPLETION' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, []);
  assert.equal(helper.active, false);
  await assert.rejects(helper({ milliseconds: 1_000 }), { code: 'TASK_COOLDOWN_AFTER_COMPLETION' });
});

test('sealing an active cooldown suppresses completed and running publications', async () => {
  const states = [];
  const cooldowns = [];
  let releaseSleep;
  const sleepGate = new Promise((resolve) => { releaseSleep = resolve; });
  const helper = createCooldownHelper({
    onState: async (state) => states.push(state),
    onCooldown: async (record) => cooldowns.push(record.status),
    sleep: async () => sleepGate
  });
  const pending = helper({ milliseconds: 1_000 });
  while (!cooldowns.includes('active')) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(helper.preparing, false);
  assert.equal(helper.active, true);
  assert.equal(helper.seal(), true);
  releaseSleep();
  await assert.rejects(pending, { code: 'TASK_COOLDOWN_AFTER_COMPLETION' });
  assert.deepEqual(states, ['cooling_down']);
  assert.deepEqual(cooldowns, ['active']);
  assert.equal(helper.active, false);
});

test('cancellation during Retry-After discovery emits no cooldown lifecycle state', async () => {
  const controller = new AbortController();
  const events = [];
  let releaseHeader;
  const headerGate = new Promise((resolve) => { releaseHeader = resolve; });
  const helper = createCooldownHelper({
    signal: controller.signal,
    onSignal: (kind) => events.push(['signal', kind]),
    onState: async (state) => events.push(['state', state]),
    onProgress: async (progress) => events.push(['progress', progress]),
    onCooldown: async (record) => events.push(['cooldown', record.status])
  });
  const pending = helper({ response: { headerValue: async () => headerGate } });
  const cancellation = Object.assign(new Error('cancelled'), { code: 'TASK_CANCELLED' });
  controller.abort(cancellation);
  releaseHeader('1');
  await assert.rejects(pending, { code: 'TASK_CANCELLED' });
  assert.deepEqual(events, []);
  assert.equal(helper.active, false);
});

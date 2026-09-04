import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';
import {
  PROFILE_LAUNCH_TIMEOUT_MS, PROFILE_OPEN_TIMEOUT_MS, PROFILE_ACTION_TIMEOUT_MS
} from '../src/contracts.mjs';
import { runProfileWorker } from '../src/runtime/profile-worker.mjs';

test('manual Profile renews startup heartbeat during native Chrome launch', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const messages = [];
  const controller = new AbortController();
  let resolveLaunch;
  let readyOptions;
  let closed = false;
  const launching = new Promise((resolve) => { resolveLaunch = resolve; });
  const running = runProfileWorker({ userDataDir: 'fake-profile' }, {
    openChrome: async () => ({
      ready: (options) => { readyOptions = options; return launching; },
      waitForClose: async (signal) => new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })),
      close: async () => { closed = true; return true; }
    }),
    sendMessage: (message) => messages.push(message),
    sendCleanup: async () => true,
    signal: controller.signal
  });
  assert.equal(messages[0].type, 'heartbeat');
  assert.equal(messages[0].stage, 'launch-native-chrome');
  t.mock.timers.tick(10_000);
  assert.equal(messages.filter((message) => message.type === 'heartbeat').length, 2);

  await nextTurn();
  t.mock.timers.tick(10_000);
  assert.equal(messages.at(-1).stage, 'launch-native-chrome');
  assert.equal(readyOptions.timeoutMs, PROFILE_LAUNCH_TIMEOUT_MS);
  assert.equal(PROFILE_OPEN_TIMEOUT_MS, 75_000);
  assert.equal(PROFILE_ACTION_TIMEOUT_MS, 100_000);

  resolveLaunch();
  await nextTurn();
  assert.equal(messages.at(-1).type, 'ready');
  controller.abort();
  assert.deepEqual(await running, { ok: true });
  assert.equal(closed, true);
  const count = messages.length;
  t.mock.timers.tick(10_000);
  assert.equal(messages.length, count, 'startup heartbeat must stop after cleanup');
});

test('manual Profile reports bounded redacted native Chrome startup cause', async () => {
  const messages = [];
  const cause = Object.assign(new Error(`token=secret-value ${'x'.repeat(3_000)}`), {
    code: `password=hidden-value ${'E'.repeat(200)}`
  });
  const result = await runProfileWorker({ userDataDir: 'fake-profile' }, {
    openChrome: async () => { throw Object.assign(new Error('Native Chrome failed', { cause }), { code: 'CHROME_LAUNCH_FAILED' }); },
    probeProfile: async () => 'inactive',
    sendMessage: (message) => messages.push(message),
    sendCleanup: async () => true
  });
  assert.equal(result.ok, false);
  const error = messages.find((message) => message.type === 'error').error;
  assert.equal(error.code, 'CHROME_LAUNCH_FAILED');
  assert.equal(error.details.stage, 'launch-native-chrome');
  assert.equal(error.details.cause.code.length, 128);
  assert.equal(error.details.cause.message.length, 2_000);
  assert.doesNotMatch(JSON.stringify(error), /secret-value|hidden-value/u);
  assert.match(error.details.cause.message, /\[REDACTED\]/u);
});

test('manual Profile launch failure reports its actual startup stage', async () => {
  const messages = [];
  await runProfileWorker({ userDataDir: 'fake-profile' }, {
    openChrome: async () => { throw new Error('launch failed token=never-log-me'); },
    probeProfile: async () => 'inactive',
    sendMessage: (message) => messages.push(message),
    sendCleanup: async () => true
  });
  const error = messages.find((message) => message.type === 'error').error;
  assert.equal(error.details.stage, 'launch-native-chrome');
  assert.equal(error.message, 'launch failed token=[REDACTED]');
});

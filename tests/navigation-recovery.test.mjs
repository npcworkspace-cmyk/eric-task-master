import assert from 'node:assert/strict';
import test from 'node:test';
import { BehaviorActionError, createActionHelper } from '../src/lib/behavior.mjs';

function response(status) {
  return {
    status: () => status,
    headers: () => ({}),
    headerValue: async () => null
  };
}

function helper(page, cooldowns) {
  let sequence = 0;
  return createActionHelper({
    page,
    mode: 'auto',
    sleep: async () => {},
    random: () => 0,
    onEffect: async (event) => event.state === 'started' ? ++sequence : event.sequence,
    onNavigationCooldown: async (options) => cooldowns.push(options)
  });
}

test('direct GET navigation retries transient connection failures with bounded backoff', async () => {
  let calls = 0;
  const cooldowns = [];
  const page = {
    async goto() {
      calls += 1;
      if (calls < 3) throw Object.assign(new Error('net::ERR_CONNECTION_RESET'), { code: 'ERR_CONNECTION_RESET' });
      return response(200);
    }
  };
  const action = helper(page, cooldowns);
  assert.equal((await action.goto('https://example.test')).status(), 200);
  assert.equal(calls, 3);
  assert.deepEqual(cooldowns.map((item) => item.milliseconds), [1_000, 3_000]);
  assert.equal(action.audit.navigationRetries, 2);
});

test('direct GET navigation honors retryable HTTP responses before returning success', async () => {
  const statuses = [429, 503, 200];
  const cooldowns = [];
  const page = { async goto() { return response(statuses.shift()); } };
  const action = helper(page, cooldowns);
  assert.equal((await action.goto('https://example.test')).status(), 200);
  assert.equal(cooldowns.length, 2);
  assert.deepEqual(cooldowns.map((item) => item.signalKind), ['rate_limit', 'rate_limit']);
  assert.deepEqual(cooldowns.map((item) => item.fallbackMs), [60_000, 60_000]);
});

test('navigation recovery never retries unknown failures or non-navigation actions', async () => {
  let calls = 0;
  const cooldowns = [];
  const page = {
    async goto() {
      calls += 1;
      throw new Error('Certificate authority invalid');
    }
  };
  const action = helper(page, cooldowns);
  await assert.rejects(action.goto('https://example.test'), (error) => (
    error instanceof BehaviorActionError && error.operation === 'goto'
  ));
  assert.equal(calls, 1);
  assert.deepEqual(cooldowns, []);
});

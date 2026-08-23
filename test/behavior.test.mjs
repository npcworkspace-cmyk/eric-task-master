import test from 'node:test';
import assert from 'node:assert/strict';
import { BehaviorActionError, createActionHelper } from '../src/lib/behavior.mjs';

function fixture() {
  const calls = [];
  const locator = {
    async hover() { calls.push(['hover']); },
    async click(options) { calls.push(['click', options]); },
    async fill(value, options) { calls.push(['fill', value, options]); },
    async pressSequentially(value, options) { calls.push(['pressSequentially', value, options]); }
  };
  const page = {
    locator(selector) {
      calls.push(['locator', selector]);
      return locator;
    },
    mouse: {
      async wheel(x, y) { calls.push(['wheel', x, y]); }
    },
    async goto(url, options) {
      calls.push(['goto', url, options]);
      return { ok: true };
    }
  };
  return { calls, locator, page };
}

test('fast mode performs native actions without artificial sleeps', async () => {
  const { calls, page } = fixture();
  const sleeps = [];
  const action = createActionHelper({ page, mode: 'fast', sleep: async (ms) => sleeps.push(ms) });

  await action.goto('https://example.test');
  await action.click('#submit');
  await action.fill('#name', 'Eric');
  await action.scroll({ deltaY: 420 });

  assert.deepEqual(sleeps, []);
  assert.ok(calls.some((item) => item[0] === 'click'));
  assert.ok(calls.some((item) => item[0] === 'fill' && item[1] === 'Eric'));
  assert.deepEqual(calls.find((item) => item[0] === 'wheel'), ['wheel', 0, 420]);
});

test('human mode uses bounded pauses, sequential typing, and segmented scroll', async () => {
  const { calls, page } = fixture();
  const sleeps = [];
  const action = createActionHelper({
    page,
    mode: 'human',
    random: () => 0,
    sleep: async (ms) => sleeps.push(ms)
  });

  await action.type('#name', 'hello');
  await action.scroll({ deltaY: 300, steps: 3 });

  assert.ok(calls.some((item) => item[0] === 'pressSequentially' && item[1] === 'hello'));
  const wheels = calls.filter((item) => item[0] === 'wheel');
  assert.equal(wheels.length, 3);
  assert.equal(wheels.reduce((total, item) => total + item[2], 0), 300);
  assert.ok(sleeps.length >= 4);
  assert.ok(sleeps.every((value) => value >= 25 && value <= 180));
});

test('adaptive mode slows after a signal and does not retry failed actions', async () => {
  const { locator, page } = fixture();
  const sleeps = [];
  const failures = [];
  let clickCount = 0;
  locator.click = async () => {
    clickCount += 1;
    throw new Error('covered by overlay');
  };
  const action = createActionHelper({
    page,
    mode: 'adaptive',
    random: () => 0,
    sleep: async (ms) => sleeps.push(ms),
    onFailure: async (failure) => failures.push(failure.operation)
  });

  action.signal('dynamic');
  assert.equal(action.effectiveMode, 'human');
  await assert.rejects(action.click('#submit'), BehaviorActionError);
  assert.equal(clickCount, 1);
  assert.deepEqual(failures, ['click']);
  assert.ok(sleeps.length > 0);
});

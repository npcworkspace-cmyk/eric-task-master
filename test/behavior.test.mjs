import test from 'node:test';
import assert from 'node:assert/strict';
import { BehaviorActionError, createActionHelper } from '../src/lib/behavior.mjs';

function fixture() {
  const calls = [];
  const locator = {
    async hover() { calls.push(['hover']); },
    async click(options) { calls.push(['click', options]); },
    async fill(value, options) { calls.push(['fill', value, options]); },
    async pressSequentially(value, options) { calls.push(['pressSequentially', value, options]); },
    async scrollIntoViewIfNeeded() { calls.push(['scrollIntoViewIfNeeded']); },
    async boundingBox() { return { x: 100, y: 80, width: 120, height: 40 }; }
  };
  const page = {
    locator(selector) {
      calls.push(['locator', selector]);
      return locator;
    },
    mouse: {
      async move(x, y) { calls.push(['move', x, y]); },
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
  const readingDelay = await action.read({ words: 50 });

  assert.deepEqual(sleeps, []);
  assert.equal(readingDelay, 0);
  assert.ok(calls.some((item) => item[0] === 'click'));
  assert.ok(calls.some((item) => item[0] === 'fill' && item[1] === 'Eric'));
  assert.deepEqual(calls.find((item) => item[0] === 'wheel'), ['wheel', 0, 420]);
  assert.equal(calls.some((item) => item[0] === 'move'), false);
});

test('human mode uses bounded pointer motion, typing rhythm, eased scroll, and reading dwell', async () => {
  const { calls, page } = fixture();
  const sleeps = [];
  const randomValues = [0.1, 0.9, 0.3, 0.7];
  let randomIndex = 0;
  const action = createActionHelper({
    page,
    mode: 'human',
    random: () => randomValues[randomIndex++ % randomValues.length],
    sleep: async (ms) => sleeps.push(ms)
  });

  await action.click('#submit');
  const clickMoves = calls.filter((item) => item[0] === 'move');
  await action.type('#name', 'Hi, x');
  await action.scroll({ deltaY: 300, steps: 5 });
  const readingDelay = await action.read({ words: 20 });

  const moves = calls.filter((item) => item[0] === 'move');
  assert.ok(moves.length >= 8);
  const clickTarget = clickMoves.at(-1);
  assert.ok(clickMoves.slice(0, -1).some((item) =>
    Math.abs(item[1] * clickTarget[2] - item[2] * clickTarget[1]) > 0.01));
  const click = calls.find((item) => item[0] === 'click');
  assert.ok(click[1].position.x > 0 && click[1].position.x < 120);
  assert.ok(click[1].position.y > 0 && click[1].position.y < 40);
  assert.ok(click[1].delay >= 35 && click[1].delay <= 95);

  const keystrokes = calls.filter((item) => item[0] === 'pressSequentially');
  assert.equal(keystrokes.length, 5);
  assert.deepEqual(keystrokes.map((item) => item[1]), ['H', 'i', ',', ' ', 'x']);
  assert.ok(keystrokes.every((item) => item[2].delay >= 25 && item[2].delay <= 85));
  assert.ok(new Set(keystrokes.map((item) => item[2].delay)).size > 1);
  const wheels = calls.filter((item) => item[0] === 'wheel');
  assert.equal(wheels.length, 5);
  assert.equal(wheels.reduce((total, item) => total + item[2], 0), 300);
  assert.ok(new Set(wheels.map((item) => item[2])).size > 1);
  assert.ok(Math.abs(wheels[2][2]) > Math.abs(wheels[0][2]));
  assert.ok(readingDelay >= 2_150 && readingDelay <= 3_900);
  assert.ok(sleeps.includes(readingDelay));
});

test('adaptive mode grades ordinary dynamic signals separately from ambiguous failures', async () => {
  const { locator, page } = fixture();
  const sleeps = [];
  const failures = [];
  const states = [];
  const action = createActionHelper({
    page,
    mode: 'adaptive',
    random: () => 0,
    sleep: async (ms) => sleeps.push(ms),
    onFailure: async (failure) => failures.push(failure.operation),
    onAdaptiveState: (state) => states.push(state)
  });

  action.signal('dynamic');
  assert.equal(action.effectiveMode, 'cautious');
  assert.deepEqual(action.adaptiveState, {
    level: 1,
    label: 'cautious',
    actionsRemaining: 2,
    signal: 'dynamic'
  });
  await action.hover('#submit');
  assert.equal(action.effectiveMode, 'cautious');
  assert.equal(sleeps.every((ms) => ms <= 75), true);
  assert.equal(action.adaptiveState.actionsRemaining, 1);
  await action.hover('#submit');
  assert.equal(action.effectiveMode, 'fast');

  let clickCount = 0;
  locator.click = async () => {
    clickCount += 1;
    throw new Error('covered by overlay');
  };
  await assert.rejects(action.click('#submit'), BehaviorActionError);
  assert.equal(clickCount, 1);
  assert.deepEqual(failures, ['click']);
  assert.equal(action.effectiveMode, 'human');
  assert.equal(action.adaptiveState.label, 'guarded');
  assert.ok(sleeps.length > 0);
  assert.deepEqual(states.map((state) => state.label), ['cautious', 'cautious', 'fast', 'guarded']);
});

test('adaptive rate-limit signals preserve a full guarded action budget', async () => {
  const { page } = fixture();
  page.goto = async () => ({
    status: () => 429,
    headers: () => ({ 'retry-after': '10' })
  });
  const action = createActionHelper({ page, mode: 'adaptive', sleep: async () => {} });

  await action.goto('https://example.test');
  assert.deepEqual(action.adaptiveState, {
    level: 3,
    label: 'cooldown',
    actionsRemaining: 6,
    signal: 'rate_limit'
  });
  assert.equal(action.effectiveMode, 'human');
});

test('an action exception stays pending because the website outcome is unknown', async () => {
  const { locator, page } = fixture();
  const events = [];
  let externalApplied = false;
  locator.click = async () => {
    externalApplied = true;
    throw new Error('navigation timed out after submission');
  };
  const action = createActionHelper({
    page,
    onEffect: async (event) => {
      events.push(event);
      return event.sequence ?? 1;
    }
  });

  await assert.rejects(action.click('#submit'), BehaviorActionError);
  assert.equal(externalApplied, true);
  assert.deepEqual(events.map((event) => event.state), ['started']);
});

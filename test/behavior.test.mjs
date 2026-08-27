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
    keyboard: {
      async press(key) { calls.push(['key', key]); }
    },
    async goto(url, options) {
      calls.push(['goto', url, options]);
      return { ok: true };
    }
  };
  return { calls, locator, page };
}

test('fast, auto, and human use identical visible mechanics while only pacing changes', async () => {
  async function run(mode) {
    const { calls, page } = fixture();
    const sleeps = [];
    const randomValues = [0.1, 0.9, 0.3, 0.7];
    let randomIndex = 0;
    const action = createActionHelper({
      page,
      mode,
      random: () => randomValues[randomIndex++ % randomValues.length],
      sleep: async (ms) => sleeps.push(ms)
    });
    await action.goto('https://example.test');
    await action.click('#submit');
    await action.fill('#name', 'Eric');
    await action.scroll({ deltaY: 420, steps: 5 });
    const readingDelay = await action.read({ words: 50 });
    return { calls, sleeps, readingDelay, audit: action.audit };
  }

  const fast = await run('fast');
  const auto = await run('auto');
  const human = await run('human');
  const topology = (result) => result.calls.map((item) => item[0]);
  const mechanicsAudit = ({ readingDurationMs: _duration, ...audit }) => audit;

  assert.deepEqual(topology(fast), topology(auto));
  assert.deepEqual(topology(fast), topology(human));
  assert.deepEqual(mechanicsAudit(fast.audit), mechanicsAudit(auto.audit));
  assert.deepEqual(mechanicsAudit(fast.audit), mechanicsAudit(human.audit));
  assert.ok(fast.calls.some((item) => item[0] === 'move'));
  assert.equal(fast.calls.filter((item) => item[0] === 'pressSequentially').length, 4);
  assert.equal(fast.calls.filter((item) => item[0] === 'wheel').length, 8);
  assert.ok(fast.readingDelay > 0);
  assert.ok(fast.readingDelay < human.readingDelay);
  assert.equal(fast.sleeps.length, human.sleeps.length);
  assert.ok(fast.sleeps.every((milliseconds, index) => milliseconds <= human.sleeps[index]));
  assert.ok(fast.calls.find((item) => item[0] === 'click')[1].delay < human.calls.find((item) => item[0] === 'click')[1].delay);
});

test('human mode uses bounded pointer motion, typing rhythm, minimum-jerk scroll, and reading dwell', async () => {
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
  assert.ok(click[1].delay >= 45 && click[1].delay <= 120);

  const keystrokes = calls.filter((item) => item[0] === 'pressSequentially');
  assert.equal(keystrokes.length, 5);
  assert.deepEqual(keystrokes.map((item) => item[1]), ['H', 'i', ',', ' ', 'x']);
  assert.ok(keystrokes.every((item) => item[2].delay === 0));
  assert.ok(action.audit.typingCadencePauses >= 4);
  assert.ok(action.audit.keyboardEvents >= 5);
  const wheels = calls.filter((item) => item[0] === 'wheel');
  assert.equal(wheels.length, 8);
  assert.equal(wheels.reduce((total, item) => total + item[2], 0), 300);
  assert.ok(new Set(wheels.map((item) => item[2])).size > 1);
  assert.ok(Math.max(...wheels.map((item) => Math.abs(item[2]))) > Math.abs(wheels[0][2]) * 3);
  assert.ok(Math.max(...wheels.map((item) => Math.abs(item[2]))) > Math.abs(wheels.at(-1)[2]) * 3);
  assert.ok(readingDelay >= 880 && readingDelay <= 2_100);
  assert.ok(sleeps.includes(readingDelay));
  assert.equal(calls.some((item) => item[0] === 'scrollIntoViewIfNeeded'), false);
  assert.ok(action.audit.pointerMoves >= 14);
  assert.equal(action.audit.wheelEvents, 8);
});

test('pointer motion follows a smooth accelerate-cruise-decelerate velocity profile', async () => {
  const { calls, locator, page } = fixture();
  locator.boundingBox = async () => ({ x: 600, y: 300, width: 100, height: 40 });
  const action = createActionHelper({
    page,
    mode: 'human',
    random: () => 0.9,
    sleep: async () => {}
  });

  await action.hover('#nearby');

  const points = calls.filter((item) => item[0] === 'move').map((item) => ({ x: item[1], y: item[2] }));
  const distances = points.slice(1).map((point, index) => Math.hypot(
    point.x - points[index].x,
    point.y - points[index].y
  ));
  const middle = distances.slice(Math.floor(distances.length * 0.3), Math.ceil(distances.length * 0.7));
  assert.ok(points.length >= 12);
  assert.ok(Math.max(...middle) > distances[0] * 2);
  assert.ok(Math.max(...middle) > distances.at(-1) * 2);
  assert.ok(action.audit.pointerPeakStepPx > 0);
  assert.ok(action.audit.pointerDistancePx > 0);
});

test('fast typing still emits keyboard events one character at a time with a non-zero cadence floor', async () => {
  const { calls, page } = fixture();
  const sleeps = [];
  const action = createActionHelper({
    page,
    mode: 'fast',
    random: () => 0,
    sleep: async (milliseconds) => sleeps.push(milliseconds)
  });

  await action.fill('#name', 'abc def');

  const characters = calls.filter((item) => item[0] === 'pressSequentially');
  assert.deepEqual(characters.map((item) => item[1]), Array.from('abc def'));
  assert.ok(characters.every((item) => item[2].delay === 0));
  assert.ok(sleeps.filter((milliseconds) => milliseconds >= 12).length >= 6);
  assert.equal(action.audit.typedCharacters, 7);
  assert.equal(action.audit.keyboardEvents, 7);
  assert.ok(action.audit.typingCadencePauses >= 6);
});

test('page survey makes a bounded rapid pass to the bottom and visibly backtracks', async () => {
  const { calls, page } = fixture();
  let scrollY = 0;
  const maxScroll = 4_200;
  page.viewportSize = () => ({ width: 1_000, height: 700 });
  page.evaluate = async () => ({ scrollY, maxScroll, viewportHeight: 700 });
  page.mouse.wheel = async (x, deltaY) => {
    calls.push(['wheel', x, deltaY]);
    scrollY = Math.max(0, Math.min(maxScroll, scrollY + deltaY));
  };
  const action = createActionHelper({
    page,
    mode: 'human',
    random: () => 0.5,
    sleep: async () => {}
  });

  const result = await action.survey({ maxGestures: 8 });

  const wheels = calls.filter((item) => item[0] === 'wheel');
  assert.equal(result.reachedBottom, true);
  assert.ok(wheels.some((item) => item[2] > 0));
  assert.ok(wheels.some((item) => item[2] < 0));
  assert.ok(scrollY < maxScroll);
  assert.equal(action.audit.pageSurveys, 1);
  assert.equal(action.audit.surveysNeedingScroll, 1);
  assert.ok(action.audit.surveyBacktracks >= 1);
  assert.ok(action.audit.wheelEvents >= action.audit.scrollGestures * 8);
});

test('page survey counts backtracking only after the rendered page actually moves upward', async () => {
  const { page } = fixture();
  let scrollY = 0;
  const maxScroll = 1_400;
  page.viewportSize = () => ({ width: 1_000, height: 700 });
  page.evaluate = async () => ({ scrollY, maxScroll, viewportHeight: 700 });
  page.mouse.wheel = async (_x, deltaY) => {
    if (deltaY > 0) scrollY = Math.min(maxScroll, scrollY + deltaY);
  };
  const action = createActionHelper({
    page,
    mode: 'human',
    random: () => 0.5,
    sleep: async () => {}
  });

  const result = await action.survey({ maxGestures: 2 });

  assert.equal(result.reachedBottom, true);
  assert.equal(result.backtracked, false);
  assert.equal(action.audit.surveyBacktracks, 0);
});

test('human click reaches an offscreen target through bounded wheel gestures instead of instant positioning', async () => {
  const { calls, locator, page } = fixture();
  let y = 2_400;
  locator.boundingBox = async () => ({ x: 100, y, width: 120, height: 40 });
  page.mouse.wheel = async (x, deltaY) => {
    calls.push(['wheel', x, deltaY]);
    y -= deltaY;
  };
  const action = createActionHelper({
    page,
    mode: 'human',
    strictVisibleTraversal: true,
    random: () => 0.5,
    sleep: async () => {}
  });

  await action.click('#submit');

  assert.ok(calls.filter((item) => item[0] === 'wheel').length >= 6);
  assert.ok(y >= 0 && y <= 720);
  assert.equal(calls.some((item) => item[0] === 'scrollIntoViewIfNeeded'), false);
  assert.ok(action.audit.targetTraversals >= 1);
  assert.ok(action.audit.pointerMoves >= 14);
});

test('visible target measurement preserves the caller action timeout', async () => {
  const { locator, page } = fixture();
  const measurements = [];
  locator.boundingBox = async (options) => {
    measurements.push(options);
    return { x: 100, y: 80, width: 120, height: 40 };
  };
  const action = createActionHelper({ page, mode: 'fast', random: () => 0.5, sleep: async () => {} });

  await action.click('#submit', { timeout: 250 });

  assert.deepEqual(measurements, [{ timeout: 250 }, { timeout: 250 }]);
});

test('human select keeps the native popup open, moves relative to the current option, and verifies the result', async () => {
  const { calls, locator, page } = fixture();
  let selectedIndex = 2;
  const values = ['alpha', 'beta', 'gamma'];
  locator.evaluate = async (_callback, requested) => {
    const targetIndex = values.indexOf(String(requested));
    return { currentIndex: selectedIndex, targetIndex, targetValue: values[targetIndex] ?? null };
  };
  locator.inputValue = async () => values[selectedIndex];
  page.keyboard.press = async (key) => {
    calls.push(['key', key]);
    if (key === 'ArrowUp') selectedIndex -= 1;
    if (key === 'ArrowDown') selectedIndex += 1;
  };
  const action = createActionHelper({
    page,
    mode: 'human',
    random: () => 0.5,
    sleep: async () => {}
  });

  const selected = await action.select('#choice', 'alpha');

  assert.equal(selected, 'alpha');
  assert.deepEqual(calls.filter((item) => item[0] === 'key').map((item) => item[1]), [
    'ArrowUp', 'ArrowUp', 'Enter', 'Tab'
  ]);
  assert.equal(action.audit.selectionKeyEvents, 4);
  assert.equal(action.audit.selectionFallbacks, 0);
});

test('human select uses one audited stable fallback only when native keyboard state is unchanged', async () => {
  const { calls, locator, page } = fixture();
  let selectedIndex = 0;
  const values = ['alpha', 'beta', 'gamma'];
  locator.evaluate = async (_callback, requested) => {
    const targetIndex = values.indexOf(String(requested));
    return { currentIndex: selectedIndex, targetIndex, targetValue: values[targetIndex] ?? null };
  };
  locator.inputValue = async () => values[selectedIndex];
  locator.selectOption = async (requested, options) => {
    calls.push(['selectOption', requested, options]);
    selectedIndex = values.indexOf(String(requested));
  };
  const action = createActionHelper({
    page,
    mode: 'human',
    random: () => 0.5,
    sleep: async () => {}
  });

  const selected = await action.select('#choice', 'gamma');

  assert.equal(selected, 'gamma');
  assert.deepEqual(calls.filter((item) => item[0] === 'selectOption'), [
    ['selectOption', 'gamma', {}]
  ]);
  assert.equal(action.audit.selectionKeyEvents, 4);
  assert.equal(action.audit.selectionFallbacks, 1);
});

test('full journey keeps visible human mechanics in fast mode and applies a live switch mid-action', async () => {
  const { calls, page } = fixture();
  let announceFirstSleep;
  const firstSleepStarted = new Promise((resolve) => { announceFirstSleep = resolve; });
  let sleeps = 0;
  const states = [];
  const action = createActionHelper({
    page,
    mode: 'human',
    strictVisibleTraversal: true,
    random: () => 0.5,
    sleep: async () => {
      sleeps += 1;
      if (sleeps === 1) {
        announceFirstSleep();
        return new Promise(() => {});
      }
    },
    onBehaviorState: (state) => states.push(state)
  });

  const clicking = action.click('#submit');
  await firstSleepStarted;
  const applied = action.setMode('fast');
  await clicking;

  assert.equal(applied.configured, 'fast');
  assert.equal(action.mode, 'fast');
  assert.equal(action.effectiveMode, 'fast');
  assert.ok(calls.some((item) => item[0] === 'move'));
  const click = calls.find((item) => item[0] === 'click');
  assert.ok(click[1].position.x > 0 && click[1].position.x < 120);
  assert.ok(click[1].delay >= 8 && click[1].delay <= 22);
  assert.ok(action.audit.visibleTargetAcquisitions >= 1);
  assert.equal(states.at(-1).configured, 'fast');
});

test('a live mode change restarts an in-flight reading dwell under the new pacing', async () => {
  const { page } = fixture();
  const sleeps = [];
  let announceFirstSleep;
  const firstSleepStarted = new Promise((resolve) => { announceFirstSleep = resolve; });
  const action = createActionHelper({
    page,
    mode: 'human',
    random: () => 0.5,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      if (sleeps.length === 1) {
        announceFirstSleep();
        return new Promise(() => {});
      }
    }
  });

  const reading = action.read({ words: 20 });
  await firstSleepStarted;
  action.setMode('fast');
  const appliedDuration = await reading;

  assert.equal(sleeps.length, 2);
  assert.ok(sleeps[1] < sleeps[0]);
  assert.equal(appliedDuration, sleeps[1]);
  assert.equal(action.audit.readingDwells, 1);
  assert.equal(action.audit.readingDurationMs, appliedDuration);
});

test('auto mode grades ordinary dynamic signals separately from ambiguous failures', async () => {
  const { locator, page } = fixture();
  const sleeps = [];
  const failures = [];
  const states = [];
  const action = createActionHelper({
    page,
    mode: 'auto',
    random: () => 0,
    sleep: async (ms) => sleeps.push(ms),
    onFailure: async (failure) => failures.push(failure.operation),
    onAutoState: (state) => states.push(state)
  });

  action.signal('dynamic');
  assert.equal(action.effectiveMode, 'cautious');
  assert.deepEqual(action.autoState, {
    level: 1,
    label: 'cautious',
    actionsRemaining: 2,
    signal: 'dynamic'
  });
  await action.hover('#submit');
  assert.equal(action.effectiveMode, 'cautious');
  assert.equal(sleeps.every((ms) => ms <= 75), true);
  assert.equal(action.autoState.actionsRemaining, 1);
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
  assert.equal(action.autoState.label, 'guarded');
  assert.ok(sleeps.length > 0);
  assert.deepEqual(states.map((state) => state.label), ['cautious', 'cautious', 'fast', 'guarded']);
});

test('auto rate-limit signals preserve a full guarded action budget', async () => {
  const { page } = fixture();
  page.goto = async () => ({
    status: () => 429,
    headers: () => ({ 'retry-after': '10' })
  });
  const action = createActionHelper({ page, mode: 'auto', sleep: async () => {} });

  await action.goto('https://example.test');
  assert.deepEqual(action.autoState, {
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

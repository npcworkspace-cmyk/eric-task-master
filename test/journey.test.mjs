import assert from 'node:assert/strict';
import test from 'node:test';
import { createJourneyHelper } from '../src/lib/journey.mjs';

function fixture() {
  const state = {
    url: 'about:blank',
    title: '',
    heading: '',
    body: '',
    pointerMoves: 0,
    clicks: 0,
    visibleTargetAcquisitions: 0,
    typedCharacters: 0,
    scrollGestures: 0,
    wheelEvents: 0,
    targetTraversals: 0
  };
  const locator = {
    async selectOption() {},
    async setInputFiles() {}
  };
  const page = {
    locator() { return locator; },
    url() { return state.url; },
    async waitForLoadState() {},
    async goBack() {
      state.url = 'https://example.test';
      state.title = 'Page one';
      state.heading = 'First';
      state.body = 'First body';
    },
    async evaluate(callback) {
      if (String(callback).includes('querySelectorAll')) return 24;
      return {
        url: state.url,
        title: state.title,
        heading: state.heading,
        body: state.body
      };
    }
  };
  const action = {
    mode: 'human',
    effectiveMode: 'human',
    adaptiveState: {},
    get audit() {
      return {
        navigations: state.url === 'about:blank' ? 0 : 1,
        clicks: state.clicks,
        pointerMoves: state.pointerMoves,
        pointerCorrections: 0,
        visibleTargetAcquisitions: state.visibleTargetAcquisitions,
        typedCharacters: state.typedCharacters,
        scrollGestures: state.scrollGestures,
        wheelEvents: state.wheelEvents,
        targetTraversals: state.targetTraversals,
        readingDwells: 1,
        readingDurationMs: 1
      };
    },
    async goto(url) {
      state.url = url;
      state.title = 'Page one';
      state.heading = 'First';
      state.body = 'First body';
      return { status: () => 200 };
    },
    async click() {
      state.clicks += 1;
      state.visibleTargetAcquisitions += 1;
      state.pointerMoves += 18;
      state.targetTraversals += 1;
      state.scrollGestures += 2;
      state.wheelEvents += 12;
      state.url = 'https://example.test?page=2';
      state.title = 'Page two';
      state.heading = 'Second';
      state.body = 'Second body';
    },
    async fill(_target, value) { state.typedCharacters += String(value).length; },
    async type(_target, value) { state.typedCharacters += String(value).length; },
    async hover() {},
    async scroll() { state.scrollGestures += 1; state.wheelEvents += 5; },
    async read() { return 100; },
    async run(_name, callback) { return callback(); },
    async wait() {}
  };
  return { action, locator, page, state };
}

test('full-human journey establishes an entry, verifies visible pagination, and reaches 10/10', async () => {
  const { action, locator, page } = fixture();
  const journey = createJourneyHelper({
    page,
    action,
    random: () => 0.5,
    sleep: async () => {}
  });

  await journey.open('https://example.test');
  await journey.nextPage(locator, { timeoutMs: 500 });

  const audit = journey.assertComplete();
  assert.equal(audit.passed, true);
  assert.equal(audit.score, 10);
  assert.equal(audit.counters.entries, 1);
  assert.equal(audit.counters.nextPages, 1);
  assert.equal(audit.counters.verifiedTransitions, 1);
  assert.equal(audit.checks.noBypassViolation, true);
});

test('a caught direct-mutation violation still fails the completion contract', async () => {
  const { action, page } = fixture();
  const journey = createJourneyHelper({ page, action, random: () => 0.5, sleep: async () => {} });
  await journey.open('https://example.test');
  journey.violation({ surface: 'Page', operation: 'goto', code: 'TASK_UI_ACTION_REQUIRES_JOURNEY' });

  assert.throws(() => journey.assertComplete(), { code: 'TASK_INTERACTION_CONTRACT_FAILED' });
  assert.equal(journey.audit().score, 9);
});

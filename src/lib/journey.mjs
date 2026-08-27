import { FULL_HUMAN_INTERACTION_CONTRACT } from './interaction-contract.mjs';
import { unwrapObservationLocator } from './observation-facade.mjs';

const DEFAULT_SETTLE = Object.freeze([220, 620]);
const DEFAULT_READING_WORDS = Object.freeze([12, 42]);

function boundedInteger(value, fallback, minimum, maximum, field) {
  const normalized = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < minimum || normalized > maximum) {
    throw new TypeError(`${field} must be an integer from ${minimum} to ${maximum}`);
  }
  return normalized;
}

function numberBetween(range, random) {
  const [minimum, maximum] = range;
  return Math.round(minimum + (maximum - minimum) * random());
}

function asLocator(page, target) {
  if (typeof target === 'string') return page.locator(target);
  if (target && typeof target === 'object') return unwrapObservationLocator(target);
  throw new TypeError('Journey target must be a selector string or Playwright Locator');
}

async function viewportWordCount(page) {
  return page.evaluate(() => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && box.bottom >= 0 && box.top <= innerHeight && box.right >= 0 && box.left <= innerWidth;
    };
    const text = [...document.querySelectorAll('h1,h2,h3,p,li,article,[role="heading"],[role="article"]')]
      .filter(visible)
      .slice(0, 80)
      .map((element) => element.innerText || element.textContent || '')
      .join(' ')
      .replace(/\s+/gu, ' ')
      .trim();
    return text ? text.split(/\s+/u).length : 0;
  }).catch(() => 0);
}

async function pageFingerprint(page) {
  return page.evaluate(() => ({
    url: location.href,
    title: document.title,
    heading: document.querySelector('h1,h2,[role="heading"]')?.textContent?.trim().slice(0, 300) || '',
    body: document.body?.innerText?.replace(/\s+/gu, ' ').trim().slice(0, 500) || ''
  })).catch(() => ({ url: page.url(), title: '', heading: '', body: '' }));
}

function sameFingerprint(left, right) {
  return left.url === right.url && left.title === right.title && left.heading === right.heading && left.body === right.body;
}

export class JourneyContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'JourneyContractError';
    this.code = code;
  }
}

export function createJourneyHelper({
  page,
  action,
  contract = FULL_HUMAN_INTERACTION_CONTRACT,
  random = Math.random,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  onState = () => {}
} = {}) {
  if (!page || !action) throw new TypeError('page and action are required');
  if (contract !== FULL_HUMAN_INTERACTION_CONTRACT) {
    throw new TypeError(`Unsupported journey contract: ${contract}`);
  }

  const counters = {
    entries: 0,
    visibleClicks: 0,
    nextPages: 0,
    verifiedTransitions: 0,
    textInputs: 0,
    explicitScrolls: 0,
    pageSurveys: 0,
    viewportReads: 0,
    selections: 0,
    uploads: 0
  };
  const violations = [];
  let active = 0;

  function report(phase, operation) {
    try {
      onState({ phase, operation, at: new Date().toISOString() });
    } catch {}
  }

  async function step(operation, callback) {
    active += 1;
    report('started', operation);
    try {
      const result = await callback();
      report('succeeded', operation);
      return result;
    } catch (error) {
      report('failed', operation);
      throw error;
    } finally {
      active -= 1;
    }
  }

  async function settle({ words, maximumWords = DEFAULT_READING_WORDS[1] } = {}) {
    await sleep(numberBetween(DEFAULT_SETTLE, random));
    const observedWords = Number.isFinite(words) ? Number(words) : await viewportWordCount(page);
    const boundedWords = Math.max(
      DEFAULT_READING_WORDS[0],
      Math.min(maximumWords, Math.round(observedWords || DEFAULT_READING_WORDS[0]))
    );
    const duration = await action.read({ words: boundedWords });
    counters.viewportReads += 1;
    return { words: boundedWords, duration };
  }

  async function verifyTransition(before, verify, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let after = await pageFingerprint(page);
    while (sameFingerprint(before, after) && Date.now() < deadline) {
      await sleep(Math.min(250, Math.max(25, deadline - Date.now())));
      after = await pageFingerprint(page);
    }
    if (typeof verify === 'function') {
      const verified = await verify({ before, after, page });
      if (verified !== true) {
        throw new JourneyContractError('JOURNEY_TRANSITION_UNVERIFIED', 'Page transition verification returned false');
      }
    } else if (sameFingerprint(before, after)) {
      throw new JourneyContractError('JOURNEY_TRANSITION_UNVERIFIED', 'Page did not visibly change after the navigation control was clicked');
    }
    counters.verifiedTransitions += 1;
    await settle();
    return after;
  }

  const journey = {
    contract,

    violation(event = {}) {
      violations.push({
        code: String(event.code || 'TASK_UI_ACTION_REQUIRES_JOURNEY').slice(0, 80),
        surface: String(event.surface || 'unknown').slice(0, 40),
        operation: String(event.operation || 'unknown').slice(0, 80)
      });
    },

    async open(url, options = {}) {
      return step('open', async () => {
        const target = new URL(url).href;
        const response = await action.goto(target, options);
        await page.waitForLoadState?.('domcontentloaded', { timeout: Math.min(Number(options.timeout) || 30_000, 30_000) }).catch(() => {});
        counters.entries += 1;
        await settle();
        return response;
      });
    },

    async click(target, options = {}) {
      return step('click-visible', async () => {
        const beforeUrl = page.url();
        const result = await action.click(asLocator(page, target), options);
        counters.visibleClicks += 1;
        if (page.url() !== beforeUrl) await settle();
        return result;
      });
    },

    async navigate(target, options = {}) {
      const timeoutMs = boundedInteger(options.timeoutMs, 15_000, 250, 60_000, 'timeoutMs');
      return step('navigate-visible', async () => {
        const before = await pageFingerprint(page);
        await action.click(asLocator(page, target), options.actionOptions || {});
        counters.visibleClicks += 1;
        return verifyTransition(before, options.verify, timeoutMs);
      });
    },

    async nextPage(target, options = {}) {
      const timeoutMs = boundedInteger(options.timeoutMs, 15_000, 250, 60_000, 'timeoutMs');
      return step('next-page-visible', async () => {
        const before = await pageFingerprint(page);
        await action.click(asLocator(page, target), options.actionOptions || {});
        counters.visibleClicks += 1;
        counters.nextPages += 1;
        return verifyTransition(before, options.verify, timeoutMs);
      });
    },

    async back(options = {}) {
      const timeoutMs = boundedInteger(options.timeoutMs, 15_000, 250, 60_000, 'timeoutMs');
      return step('navigate-back-visible', async () => {
        const before = await pageFingerprint(page);
        await action.run('back', () => page.goBack({ waitUntil: 'domcontentloaded', timeout: timeoutMs }));
        return verifyTransition(before, options.verify, timeoutMs);
      });
    },

    async fill(target, value, options = {}) {
      return step('fill-visible', async () => {
        const result = await action.fill(asLocator(page, target), value, options);
        counters.textInputs += 1;
        return result;
      });
    },

    async type(target, value, options = {}) {
      return step('type-visible', async () => {
        const result = await action.type(asLocator(page, target), value, options);
        counters.textInputs += 1;
        return result;
      });
    },

    async hover(target, options = {}) {
      return step('hover-visible', () => action.hover(asLocator(page, target), options));
    },

    async scroll(input = {}) {
      return step('scroll-visible', async () => {
        const result = await action.scroll(input);
        counters.explicitScrolls += 1;
        if (optionsShouldRead(input)) await settle({ maximumWords: 28 });
        return result;
      });
    },

    async survey(options = {}) {
      return step('survey-visible', async () => {
        const result = await action.survey(options);
        counters.pageSurveys += 1;
        await settle({ maximumWords: 36 });
        return result;
      });
    },

    async read(input = {}) {
      return step('read-viewport', async () => {
        counters.viewportReads += 1;
        return action.read(input);
      });
    },

    async select(target, value, options = {}) {
      return step('select-visible', async () => {
        const locator = asLocator(page, target);
        const result = await action.select(locator, value, options);
        counters.selections += 1;
        return result;
      });
    },

    async upload(target, files, options = {}) {
      return step('upload-visible', async () => {
        const locator = asLocator(page, target);
        await action.hover(locator);
        const result = await action.run('upload', () => locator.setInputFiles(files, options));
        counters.uploads += 1;
        return result;
      });
    },

    async wait(milliseconds) {
      return action.wait(milliseconds);
    },

    audit() {
      const primitive = action.audit || {};
      const checks = {
        entryEstablished: counters.entries > 0,
        viewportObserved: counters.viewportReads >= counters.entries,
        pointerPathUsed: counters.visibleClicks === 0 || Number(primitive.pointerMoves) >= counters.visibleClicks * 10,
        clickMechanicsUsed: counters.visibleClicks === 0 || Number(primitive.clicks) >= counters.visibleClicks,
        typedWithCadence: counters.textInputs === 0 || (
          Number(primitive.typedCharacters) > 0 &&
          Number(primitive.keyboardEvents) >= Number(primitive.typedCharacters) &&
          Number(primitive.typingCadencePauses) >= Number(primitive.typedCharacters) - counters.textInputs
        ),
        visibleTargetsAcquired: Number(primitive.visibleTargetAcquisitions) >= Number(primitive.clicks),
        scrollingIsSegmented: (
          Number(primitive.scrollGestures) === 0 ||
          Number(primitive.wheelEvents) >= Number(primitive.scrollGestures) * 8
        ) && (
          Number(primitive.surveysNeedingScroll || 0) === 0 ||
          Number(primitive.surveyBacktracks || 0) >= Number(primitive.surveysNeedingScroll || 0)
        ),
        transitionsVerified: counters.nextPages === 0 || counters.verifiedTransitions >= counters.nextPages,
        noBypassViolation: violations.length === 0,
        allJourneyStepsSettled: active === 0
      };
      const passed = Object.values(checks).every(Boolean);
      return Object.freeze({
        version: 1,
        contract,
        passed,
        score: passed ? 10 : Object.values(checks).filter(Boolean).length,
        checks,
        counters: { ...counters },
        primitives: { ...primitive },
        violations: violations.map((item) => ({ ...item }))
      });
    },

    assertComplete() {
      const audit = journey.audit();
      if (audit.passed) return audit;
      const failed = Object.entries(audit.checks).filter(([, ok]) => !ok).map(([name]) => name);
      throw new JourneyContractError(
        'TASK_INTERACTION_CONTRACT_FAILED',
        `full-human-v1 interaction contract failed: ${failed.join(', ')}`
      );
    }
  };

  return Object.freeze(journey);
}

function optionsShouldRead(input) {
  return !(input && typeof input === 'object' && input.readAfter === false);
}
